package render

import (
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden render under examples/cub-kubara/render-two-clusters")

const golden = "../../examples/cub-kubara/render-two-clusters"

// The fixture is a platform shaped like Kubara's output: a hub and a spoke
// that both enable web, and a service config.yaml leaves disabled. The hub's
// argo-cd values name the services its ApplicationSets deliver; web's release
// name differs from its chart directory, and web pins an upstream chart. A
// stale directory from a renamed hub names other ApplicationSets. bootstrap-crds
// holds a CRD and an object kubara bootstrap does not apply, and web renders
// the same CRD again, and a Secret.
const fixture = "testdata/platform"

func needHelm(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is not installed")
	}
}

func TestRenderMatchesTheGolden(t *testing.T) {
	needHelm(t)
	out := t.TempDir()
	if _, err := Write(Options{WorkDir: fixture, Out: out, Generator: "cub kubara render test"}); err != nil {
		t.Fatal(err)
	}
	got := tree(t, out)
	if *update {
		if err := os.RemoveAll(golden); err != nil {
			t.Fatal(err)
		}
		for name, body := range got {
			path := filepath.Join(golden, name)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	want := tree(t, golden)
	for name, body := range got {
		if want[name] != body {
			t.Errorf("%s differs from %s; rerun go test ./internal/render -update after reviewing:\n%s", name, golden, body)
		}
	}
	for name := range want {
		if _, ok := got[name]; !ok {
			t.Errorf("the render has no %s", name)
		}
	}
}

func TestRenderIsTheWayKubaraDelivers(t *testing.T) {
	needHelm(t)
	out := t.TempDir()
	m, err := Write(Options{WorkDir: fixture, Out: out})
	if err != nil {
		t.Fatal(err)
	}
	if m.APIVersion != APIVersion || m.Kind != Kind || m.SecretValues != "emptied" || !strings.HasPrefix(m.Source.ConfigSHA256, "sha256:") {
		t.Fatalf("manifest head = %+v", m)
	}
	if len(m.Clusters) != 2 || m.Clusters[0].Name != "hub" || m.Clusters[1].Name != "spoke" {
		t.Fatalf("clusters = %+v", m.Clusters)
	}
	hub, spoke := m.Clusters[0], m.Clusters[1]
	if strings.Join(names(hub.Services), ",") != "bootstrap-crds,argo-cd,web" || strings.Join(names(spoke.Services), ",") != "bootstrap-crds,web" {
		t.Fatalf("services: hub %v, spoke %v; only a hub runs Argo CD, and a disabled service renders nowhere", names(hub.Services), names(spoke.Services))
	}
	if strings.Join(hub.Enabled, ",") != "web" || hub.Type != "hub" || hub.Stage != "dev" || spoke.Stage != "prod" {
		t.Fatalf("hub = %+v, spoke = %+v", hub, spoke)
	}
	crds, web := hub.Services[0], hub.Services[2]
	if crds.Delivery != "bootstrap" || crds.Objects != 1 || crds.LeftOut != 1 || crds.Namespace != "kube-system" {
		t.Errorf("bootstrap-crds = %+v", crds)
	}
	if web.Delivery != "applicationset" || web.Release != "webapp" || web.Namespace != "webapp" {
		t.Errorf("web = %+v", web)
	}
	if strings.Join(web.ValuesFiles, ",") != "platform-configs/hub/helm/web/values.generated.yaml,platform-configs/hub/helm/web/additional-values.yaml,platform-configs/hub/helm/web/values-zz.yaml" {
		t.Errorf("values files = %v", web.ValuesFiles)
	}
	if strings.Join(web.APIVersions, ",") != "example.com/v1,example.com/v1/Widget" {
		t.Errorf("api versions = %v", web.APIVersions)
	}
	if web.Chart != (Chart{Name: "web", Version: "0.3.1", Path: "platform-components/helm/web"}) ||
		len(web.Upstream) != 1 || web.Upstream[0] != (Upstream{Name: "greeter", Version: "1.2.3", Repository: "https://charts.example.com"}) {
		t.Errorf("chart = %+v, upstream = %+v", web.Chart, web.Upstream)
	}
	if strings.Join(web.Secrets, ";") != "Secret webapp/webapp-admin (1 value)" {
		t.Errorf("secrets = %v", web.Secrets)
	}
	body := read(t, filepath.Join(out, web.File))
	for _, want := range []string{
		"name: webapp-settings", // the ApplicationSet's release name, not the chart directory
		"namespace: webapp",     // the namespace defaults to the service name
		`replicas: "2"`,         // values.generated.yaml over the chart's values
		"level: last",           // values-*.yaml applies last
		"kind: Widget",          // the CRD bootstrap-crds provides is declared to the chart
		"name: webapp-greeting", // the upstream chart renders too
		`password: ""`,          // a Secret keeps its keys and not its values
	} {
		if !strings.Contains(body, want) {
			t.Errorf("web render lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "generated-at-render-time") || strings.Contains(body, "stale") {
		t.Errorf("web render holds a Secret value or a stale hub's ApplicationSet:\n%s", body)
	}
	if spokeWeb := read(t, filepath.Join(out, spoke.Services[1].File)); !strings.Contains(spokeWeb, `replicas: "5"`) || !strings.Contains(spokeWeb, "level: spoke") {
		t.Errorf("the spoke renders with its own values:\n%s", spokeWeb)
	}
	if len(hub.Shared) != 1 || hub.Shared[0].Object != "apiextensions.k8s.io/v1|CustomResourceDefinition||widgets.example.com" ||
		strings.Join(hub.Shared[0].Services, ",") != "bootstrap-crds,web" || hub.Shared[0].Owner != "bootstrap-crds" {
		t.Errorf("shared = %+v", hub.Shared)
	}
	if web.SHA256 != digest([]byte(body)) {
		t.Errorf("sha256 %s is not the file's digest", web.SHA256)
	}
	var onDisk Manifest
	if err := json.Unmarshal([]byte(read(t, filepath.Join(out, ManifestFile))), &onDisk); err != nil || onDisk.Clusters[0].Services[2].SHA256 != web.SHA256 {
		t.Errorf("render.json on disk differs from the manifest returned: %v", err)
	}
}

func TestRenderIsStable(t *testing.T) {
	needHelm(t)
	a, b := t.TempDir(), t.TempDir()
	for _, out := range []string{a, b} {
		if _, err := Write(Options{WorkDir: fixture, Out: out}); err != nil {
			t.Fatal(err)
		}
	}
	if ta, tb := tree(t, a), tree(t, b); !equal(ta, tb) {
		t.Fatal("two renders of the same platform differ")
	}
}

func TestRenderKeepsSecretValuesWhenAsked(t *testing.T) {
	needHelm(t)
	out := t.TempDir()
	m, err := Write(Options{WorkDir: fixture, Out: out, KeepSecretValues: true, Clusters: []string{"spoke"}})
	if err != nil {
		t.Fatal(err)
	}
	if m.SecretValues != "kept" || len(m.Clusters) != 1 || m.Clusters[0].Name != "spoke" {
		t.Fatalf("manifest = %+v", m)
	}
	web := m.Clusters[0].Services[1]
	if len(web.Secrets) != 0 || !strings.Contains(read(t, filepath.Join(out, web.File)), "generated-at-render-time") {
		t.Errorf("--keep-secret-values keeps the value: %+v", web)
	}
}

func TestRenderReplacesAnEarlierRenderOnly(t *testing.T) {
	needHelm(t)
	out := t.TempDir()
	if _, err := Write(Options{WorkDir: fixture, Out: out}); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(Options{WorkDir: fixture, Out: out, Clusters: []string{"spoke"}}); err != nil {
		t.Fatalf("rendering again into an earlier render: %v", err)
	}
	if _, err := os.Stat(filepath.Join(out, "hub")); !os.IsNotExist(err) {
		t.Errorf("the earlier render's hub is left behind: %v", err)
	}
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "notes.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(Options{WorkDir: fixture, Out: other}); err == nil || !strings.Contains(err.Error(), "holds no earlier render") {
		t.Errorf("a directory holding something else is refused: %v", err)
	}
	if _, err := Write(Options{WorkDir: fixture, Out: t.TempDir(), Clusters: []string{"edge"}}); err == nil || !strings.Contains(err.Error(), "no cluster edge; it names hub, spoke") {
		t.Errorf("an unknown cluster is refused: %v", err)
	}
}

func TestRenderNeedsAGeneratedPlatform(t *testing.T) {
	dir := t.TempDir()
	cfg, err := os.ReadFile(filepath.Join(fixture, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(Options{WorkDir: dir, Out: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "generate --helm") {
		t.Fatalf("err = %v", err)
	}
}

func TestIdentity(t *testing.T) {
	for doc, want := range map[string]string{
		"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: n\n":   "v1|ConfigMap|n|a",
		"# Source: x\napiVersion: apps/v1\nkind: Deployment\nmetadata: {name: d}\n": "apps/v1|Deployment||d",
		"kind: ConfigMap\n": "",
	} {
		if got := identity(doc); got != want {
			t.Errorf("identity(%q) = %q, want %q", doc, got, want)
		}
	}
}

func names(svcs []Service) []string {
	var out []string
	for _, s := range svcs {
		out = append(out, s.Name)
	}
	return out
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// tree reads every file under dir, by slash-separated relative path.
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		out[filepath.ToSlash(rel)] = read(t, path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func equal(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	var keys []string
	for k := range a {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if a[k] != b[k] {
			return false
		}
	}
	return true
}
