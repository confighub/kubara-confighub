package handover

import (
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
)

var update = flag.Bool("update", false, "rewrite the golden files under examples/cub-kubara")

const golden = "../../examples/cub-kubara/apply-two-clusters"

func fixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/argo-cd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var charts = map[string]bool{"argo-cd": true, "cert-manager": true, "traefik": true}

func TestRouteKeepsKubarasShapeAndPointsAtConfigHub(t *testing.T) {
	in := fixture(t)
	out, routed, err := RouteApplicationSets(in, charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range routed.Routes {
		got[r.ApplicationSet] = r.RepoURL
	}
	want := map[string]string{
		"argocd":       "oci://oci.hub.confighub.com/space/kx-argo-cd-{{name}}",
		"cert-manager": "oci://oci.hub.confighub.com/space/kx-cert-manager-{{name}}",
		"traefik":      "oci://oci.hub.confighub.com/space/kx-traefik-{{name}}",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("route %s = %q, want %q", k, got[k], v)
		}
	}
	if len(routed.Routes) != 3 || len(routed.OnGit) != 14 {
		t.Fatalf("routes=%d onGit=%d %v", len(routed.Routes), len(routed.OnGit), routed.OnGit)
	}
	two, err := Only(out, "argocd,traefik,hx-dev-dev")
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(two), "kind: ApplicationSet"); n != 2 || !strings.HasPrefix(string(two), "apiVersion: argoproj.io/v1alpha1\nkind: AppProject") {
		t.Errorf("Only(argocd,traefik,hx-dev-dev) gave %d ApplicationSets, or not the AppProject first:\n%s", n, two)
	}
	if _, err := Only(out, "traefik,nope"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("Only with a missing name: err = %v", err)
	}
	doc, err := Only(out, "traefik")
	if err != nil {
		t.Fatal(err)
	}
	s := string(doc)
	for _, w := range []string{
		"repoURL: oci://oci.hub.confighub.com/space/kx-traefik-{{name}}",
		"targetRevision: latest",
		"- /data\n",
		"- /stringData\n",
		"preserveResourcesOnDeletion: false", // Kubara's settings stay
		"prune: true",
		"- RespectIgnoreDifferences=true",
		"name: '{{name}}'",
	} {
		if !strings.Contains(s, w) {
			t.Errorf("routed traefik lacks %q:\n%s", w, s)
		}
	}
	if strings.Contains(s, "sources:") || strings.Contains(s, "github.com/example/platform") {
		t.Fatalf("routed traefik still reads Git:\n%s", s)
	}
}

// Every document that is not a routed ApplicationSet, or the AppProject they
// use, keeps its exact bytes, including argocd-cm, whose block scalars a YAML
// round trip rewrites.
func TestRouteChangesNothingElse(t *testing.T) {
	in := fixture(t)
	out, routed, err := RouteApplicationSets(in, charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(routed.Used, ",") != "hx-dev-dev" || strings.Join(routed.Projects, ",") != "hx-dev-dev" {
		t.Fatalf("used=%v projects=%v", routed.Used, routed.Projects)
	}
	// Kubara's AppProject lists no sources: its Git is a project-scoped
	// repository. It gains a list holding only the gateway.
	project, err := Only(out, "hx-dev-dev")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(project), "sourceRepos:\n    - oci://oci.hub.confighub.com/space/kx-*\n") {
		t.Errorf("the AppProject does not permit the gateway:\n%s", project)
	}
	inDocs, outDocs := docSeparator.Split(string(in), -1), docSeparator.Split(string(out), -1)
	if len(inDocs) != len(outDocs) {
		t.Fatalf("documents %d -> %d", len(inDocs), len(outDocs))
	}
	routedName := regexp.MustCompile(`(?m)^kind: (ApplicationSet\nmetadata:\n  name: (argocd|cert-manager|traefik)|AppProject\nmetadata:\n  name: hx-dev-dev)\n`)
	for i := range inDocs {
		if routedName.MatchString(inDocs[i]) {
			continue
		}
		if inDocs[i] != outDocs[i] {
			t.Fatalf("document %d changed:\n%s", i, outDocs[i][:200])
		}
	}
}

func TestRouteTwiceChangesNothing(t *testing.T) {
	once, _, err := RouteApplicationSets(fixture(t), charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	twice, routed, err := RouteApplicationSets(once, charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	if string(once) != string(twice) {
		t.Fatal("a second route changed the render")
	}
	if len(routed.Routes) != 3 {
		t.Fatalf("an already routed render should still report its routes: %v", routed.Routes)
	}
}

func TestProjectThatListsSourcesGainsTheGateway(t *testing.T) {
	in := `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform
spec:
  sourceRepos:
    - https://github.com/example/platform.git
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: traefik
spec:
  template:
    spec:
      project: platform
      sources:
        - repoURL: https://github.com/example/platform.git
          path: platform-components/helm/traefik
`
	out, routed, err := RouteApplicationSets([]byte(in), charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(routed.Projects, ",") != "platform" || !strings.Contains(string(out), "- oci://oci.hub.confighub.com/space/kx-*") {
		t.Fatalf("projects=%v\n%s", routed.Projects, out)
	}
}

func TestWouldPrune(t *testing.T) {
	app := `{"spec":{"destination":{"namespace":"traefik"}},"status":{"resources":[
	  {"group":"apps","kind":"Deployment","namespace":"traefik","name":"traefik"},
	  {"kind":"Secret","namespace":"traefik","name":"traefik-admin"},
	  {"group":"apiextensions.k8s.io","kind":"CustomResourceDefinition","name":"ingressroutes.traefik.io"},
	  {"kind":"ConfigMap","namespace":"traefik","name":"gone"}]}}`
	release := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: traefik
---
apiVersion: v1
kind: Secret
metadata:
  name: traefik-admin
  namespace: traefik
data:
  password: ""
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ingressroutes.traefik.io
`
	gone, err := WouldPrune([]byte(app), []byte(release))
	if err != nil {
		t.Fatal(err)
	}
	if len(gone) != 1 || gone[0].String() != "ConfigMap traefik/gone" {
		t.Fatalf("would prune %v", gone)
	}
}

func TestWriteHandoverScript(t *testing.T) {
	p, err := platform.Load("../apply/testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	res, err := Write(pl, Options{Out: out, Render: func(_, cluster string) ([]byte, error) {
		if cluster != "hub" {
			t.Fatalf("rendered %s; handover reads only the hub's argo-cd", cluster)
		}
		return fixture(t), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.WithKubara, ",") != "bootstrap-crds" {
		t.Fatalf("with Kubara = %v", res.WithKubara)
	}
	b, err := os.ReadFile(res.Script)
	if err != nil {
		t.Fatal(err)
	}
	script := string(b)
	// argo-cd is released last, so the hub switches only once every release it reads exists.
	if strings.LastIndex(script, "publish kx-traefik-edge") > strings.Index(script, "publish kx-argo-cd-hub") {
		t.Fatal("argo-cd must be released after every other component")
	}
	if strings.Contains(script, "kx-bootstrap-crds") {
		t.Fatal("no ApplicationSet delivers bootstrap-crds, so handover must leave it alone")
	}
	check(t, "handover.sh", script)
}

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
		t.Fatalf("%s: %v (run go test ./internal/handover -update)", path, err)
	}
	if string(want) != got {
		t.Fatalf("%s differs from the output; rerun with -update after reviewing:\n%s", path, got)
	}
}
