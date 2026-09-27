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
