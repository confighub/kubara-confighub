package plan

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/catalog"
	"github.com/confighub/kubara-confighub/internal/platform"
)

var update = flag.Bool("update", false, "rewrite the golden files under examples/cub-kubara")

const golden = "../../examples/cub-kubara"

func check(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join(golden, name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run go test ./internal/plan -update)", path, err)
	}
	if string(want) != got {
		t.Fatalf("%s differs from the output; rerun with -update after reviewing:\n%s", path, got)
	}
}

// The committed four-cluster reference platform: one hub, three spokes, the
// Kubara 1.1 catalogs.
func TestPlanReferencePlatform(t *testing.T) {
	p, err := platform.Load("../../examples/kubara/current-platform/source/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p.Dir = "examples/kubara/current-platform/source"
	pl, err := Build(p, Options{Prefix: "hx"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pl.Problems) != 0 {
		t.Fatalf("unexpected problems: %v", pl.Problems)
	}
	if got := len(pl.Stages); got != 3 {
		t.Fatalf("stages = %d, want dev, staging, prod", got)
	}
	if pl.Hub != "hx-app-dev" {
		t.Fatalf("hub = %q", pl.Hub)
	}
	check(t, "plan-reference-platform.txt", Render(pl))
}

func TestServicesCatalog3(t *testing.T) {
	boot, general, err := catalog.Pair("3.0.0")
	if err != nil {
		t.Fatal(err)
	}
	w, err := catalog.LoadWorkshop()
	if err != nil {
		t.Fatal(err)
	}
	check(t, "services-3.0.0.txt", RenderServices(boot, general, w))
}

// Kubara released general 5.1.0 with bootstrap 5.0.1; the listing pairs them
// the way 3.0.0 pairs, and shows 5.1.0's new infrastructure category.
func TestServicesCatalog5(t *testing.T) {
	boot, general, err := catalog.Pair("5.1.0")
	if err != nil {
		t.Fatal(err)
	}
	w, err := catalog.LoadWorkshop()
	if err != nil {
		t.Fatal(err)
	}
	check(t, "services-5.1.0.txt", RenderServices(boot, general, w))
}

const catalog5 = `version: v1alpha4
bootstrapCatalog: oci://ghcr.io/kubara-io/catalogs/bootstrap:5.0.1
clusters:
  - name: hub
    stage: dev
    type: hub
    argocd: {selfManaged: enabled}
    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:5.1.0]
    services: {crossplane: {status: enabled}, homer-dashboard: {status: enabled}}
  - name: edge
    stage: prod
    type: spoke
    argocd: {selfManaged: disabled}
    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:5.1.0]
    services: {crossplane: {status: enabled}}
`

// A config on the 5.x catalogs plans the way a 3.0.0 one does.
func TestPlanCatalog5(t *testing.T) {
	pl, err := Build(writeConfig(t, catalog5), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(pl.Problems) != 0 || len(pl.Notes) != 0 {
		t.Fatalf("problems %v, notes %v", pl.Problems, pl.Notes)
	}
	if pl.Bootstrap.Version != "5.0.1" || pl.General.Version != "5.1.0" {
		t.Fatalf("catalogs = bootstrap %s, general %s", pl.Bootstrap.Version, pl.General.Version)
	}
	got := map[string]string{}
	for _, c := range pl.Components {
		var clusters []string
		for _, v := range c.Variants {
			clusters = append(clusters, v.Cluster)
		}
		got[c.Name] = c.Catalog + " " + strings.Join(clusters, ",")
	}
	want := map[string]string{
		"argo-cd":         "bootstrap 5.0.1 hub",
		"bootstrap-crds":  "bootstrap 5.0.1 hub,edge",
		"crossplane":      "general 5.1.0 hub,edge",
		"homer-dashboard": "general 5.1.0 hub",
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s = %q, want %q", name, got[name], w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("components = %v", got)
	}
	for _, c := range pl.Components {
		if c.Name == "crossplane" && (c.Category != "infrastructure" || len(c.Upstream) != 1 || c.Upstream[0].Chart.Version != "2.4.1") {
			t.Errorf("crossplane = %+v", c)
		}
	}
	// A bootstrap catalog the plugin does not carry is noted, not refused.
	pl, err = Build(writeConfig(t, strings.Replace(catalog5, "bootstrap:5.0.1", "bootstrap:5.0.0", 1)), Options{})
	if err != nil || len(pl.Problems) != 0 || !strings.Contains(strings.Join(pl.Notes, ""), "bootstrapCatalog is 5.0.0; the catalog snapshot that pairs with general 5.1.0 is bootstrap 5.0.1") {
		t.Fatalf("err %v, problems %v, notes %v", err, pl.Problems, pl.Notes)
	}
}

func writeConfig(t *testing.T, body string) platform.Platform {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := platform.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

const twoHubs = `version: v1alpha4
bootstrapCatalog: oci://ghcr.io/kubara-io/catalogs/bootstrap:3.0.0
clusters:
  - name: a
    stage: dev
    type: hub
    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:3.0.0]
    services: {traefik: {status: enabled}}
  - name: b
    stage: prod
    type: hub
    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:3.0.0]
    services: {homer-dashboard: {status: enabled}, nope: {status: enabled}}
`

func TestPlanProblems(t *testing.T) {
	pl, err := Build(writeConfig(t, twoHubs), Options{})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(pl.Problems, "\n")
	for _, want := range []string{"one hub per config", "enables nope"} {
		if !strings.Contains(joined, want) {
			t.Errorf("problems do not mention %q:\n%s", want, joined)
		}
	}
}

func TestSpokeCannotRunHubOnlyService(t *testing.T) {
	cfg := strings.Replace(twoHubs, "type: hub\n    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:3.0.0]\n    services: {homer", "type: spoke\n    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:3.0.0]\n    services: {homer", 1)
	pl, err := Build(writeConfig(t, cfg), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(pl.Problems, "\n"), "homer-dashboard runs only on hub") {
		t.Fatalf("expected a cluster-type problem, got %v", pl.Problems)
	}
}

func TestExplicitStageOrder(t *testing.T) {
	got := orderStages([]string{"prod", "canary", "dev"}, []string{"dev", "canary", "prod"})
	if strings.Join(got, ",") != "dev,canary,prod" {
		t.Fatalf("order = %v", got)
	}
	got = orderStages([]string{"prod", "staging", "dev", "edge"}, nil)
	if strings.Join(got, ",") != "dev,staging,prod,edge" {
		t.Fatalf("default order = %v", got)
	}
}

const catalogPerCluster = `version: v1alpha4
bootstrapCatalog: oci://ghcr.io/kubara-io/catalogs/bootstrap:3.0.0
clusters:
  - name: hub
    stage: dev
    type: hub
    argocd: {selfManaged: enabled}
    catalogs: [oci://ghcr.io/kubara-io/catalogs/general:3.0.0]
    services: {traefik: {status: enabled}}
  - name: spoke
    stage: prod
    type: spoke
    argocd: {selfManaged: enabled}
    services: {traefik: {status: enabled}}
`

func TestEveryClusterNeedsItsOwnGeneralCatalog(t *testing.T) {
	pl, err := Build(writeConfig(t, catalogPerCluster), Options{})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(pl.Problems, "\n")
	if !strings.Contains(joined, "cluster spoke reads no Kubara general catalog") {
		t.Fatalf("expected a per-cluster catalog problem, got:\n%s", joined)
	}
}

func TestSpokeWithItsOwnArgoCDIsAProblem(t *testing.T) {
	pl, err := Build(writeConfig(t, catalogPerCluster), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(pl.Problems, "\n"), "spoke spoke has argocd.selfManaged enabled") {
		t.Fatalf("expected a selfManaged problem, got %v", pl.Problems)
	}
}
