package apply

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The fixture is a platform shaped like Kubara's output: a hub whose argo-cd
// values name the services its ApplicationSets deliver, a service whose
// release name differs from its chart directory, and a bootstrap-crds chart
// that holds a CRD and an object kubara bootstrap does not apply.
func TestKubaraRendererRendersTheWayKubaraDelivers(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is not installed")
	}
	out := t.TempDir()
	renders, err := KubaraRenderer("testdata/kubara-render", "hub", out)
	if err != nil {
		t.Fatal(err)
	}
	read := func(chart string) string {
		t.Helper()
		b, err := os.ReadFile(renders[chart])
		if err != nil {
			t.Fatalf("%s: %v", chart, err)
		}
		return string(b)
	}
	web := read("web")
	for _, want := range []string{
		"name: webapp-settings", // the ApplicationSet's release name, not the chart directory
		"namespace: webapp",     // the namespace defaults to the service name
		`replicas: "2"`,         // values.generated.yaml over the chart's values
		"level: last",           // values-*.yaml applies last
		"kind: Widget",          // the CRD bootstrap-crds provides is declared to the chart
	} {
		if !strings.Contains(web, want) {
			t.Errorf("web render lacks %q:\n%s", want, web)
		}
	}
	crds := read("bootstrap-crds")
	if !strings.Contains(crds, "widgets.example.com") || strings.Contains(crds, "not-applied-by-kubara-bootstrap") {
		t.Errorf("bootstrap-crds should hold its CRDs and nothing else:\n%s", crds)
	}
	if !strings.Contains(read("argo-cd"), "name: argocd-cm") {
		t.Errorf("the hub's argo-cd renders with release name argocd")
	}
}

func TestKubaraAppsReadsTheHubApplicationSets(t *testing.T) {
	apps, err := KubaraApps("testdata/kubara-render")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range apps {
		got[a.Path] = a.Name + "@" + a.ReleaseNamespace()
	}
	if got["web"] != "webapp@webapp" || got["argo-cd"] != "argocd@argocd" {
		t.Fatalf("apps = %v", got)
	}
}
