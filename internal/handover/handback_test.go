package handover

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
)

func templateSpec(t *testing.T, o Original) map[string]any {
	t.Helper()
	var spec map[string]any
	if err := json.Unmarshal(o.Spec, &spec); err != nil {
		t.Fatal(err)
	}
	tmpl, _ := spec["template"].(map[string]any)
	ts, _ := tmpl["spec"].(map[string]any)
	if ts == nil {
		t.Fatalf("%s has no template spec: %s", o.Name, o.Spec)
	}
	return ts
}

func TestPlanHandbackRestoresKubarasSources(t *testing.T) {
	r, err := PlanHandback(fixture(t), charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, a := range r.ApplicationSets {
		names = append(names, a.Name)
	}
	// argocd first: once the hub's argocd Application reads Git, Argo CD stops
	// writing the routed ApplicationSets back from ConfigHub's release.
	if strings.Join(names, ",") != "argocd,cert-manager,traefik" {
		t.Fatalf("ApplicationSets = %v", names)
	}
	for _, a := range r.ApplicationSets {
		ts := templateSpec(t, a)
		if _, ok := ts["source"]; ok {
			t.Errorf("%s keeps a single source", a.Name)
		}
		sources, _ := ts["sources"].([]any)
		if len(sources) == 0 || !strings.Contains(string(a.Spec), "https://github.com/example/platform.git") {
			t.Errorf("%s does not read Kubara's Git: %s", a.Name, a.Spec)
		}
		if strings.Contains(string(a.Spec), "oci://") {
			t.Errorf("%s still names the gateway: %s", a.Name, a.Spec)
		}
		// Secrets keep their live values: the rule that leaves Secret data alone stays.
		if !strings.Contains(string(a.Spec), `{"jsonPointers":["/data","/stringData"],"kind":"Secret"}`) {
			t.Errorf("%s loses the rule that keeps Secret values: %s", a.Name, a.Spec)
		}
	}
	if len(r.Projects) != 1 || r.Projects[0].Name != "hx-dev-dev" {
		t.Fatalf("projects = %+v", r.Projects)
	}
	if strings.Contains(string(r.Projects[0].Spec), "sourceRepos") {
		t.Errorf("Kubara's AppProject lists no sources, and handback must not add one: %s", r.Projects[0].Spec)
	}
}

func TestPlanHandbackUndoesWhatHandoverRoutes(t *testing.T) {
	in := fixture(t)
	restore, err := PlanHandback(in, charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	// Handover's routing of the restored specs changes only the source: the
	// rest of each ApplicationSet is Kubara's.
	routed, _, err := RouteApplicationSets(in, charts, "kx", DefaultGateway)
	if err != nil {
		t.Fatal(err)
	}
	// Each restored spec is Kubara's own, with only the Secret rule added.
	original := map[string]map[string]any{}
	for _, doc := range docSeparator.Split(string(in), -1) {
		var obj map[string]any
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			t.Fatal(err)
		}
		if obj["kind"] == "ApplicationSet" {
			original[obj["metadata"].(map[string]any)["name"].(string)] = obj["spec"].(map[string]any)
		}
	}
	for _, a := range restore.ApplicationSets {
		var got map[string]any
		if err := json.Unmarshal(a.Spec, &got); err != nil {
			t.Fatal(err)
		}
		ts := got["template"].(map[string]any)["spec"].(map[string]any)
		ignores := ts["ignoreDifferences"].([]any)
		if len(ignores) == 1 {
			delete(ts, "ignoreDifferences")
		} else {
			ts["ignoreDifferences"] = ignores[:len(ignores)-1]
		}
		want, _ := json.Marshal(original[a.Name])
		have, _ := json.Marshal(got)
		if string(want) != string(have) {
			t.Errorf("%s is not Kubara's spec:\nwant %s\ngot  %s", a.Name, want, have)
		}
	}
	if _, err := PlanHandback(routed, charts, "kx", DefaultGateway); err == nil || !strings.Contains(err.Error(), "already reads ConfigHub") {
		t.Fatalf("a routed render must be refused, err = %v", err)
	}
	for _, a := range restore.ApplicationSets {
		ts := templateSpec(t, a)
		for _, key := range []string{"project", "destination", "syncPolicy"} {
			if ts[key] == nil {
				t.Errorf("%s lost Kubara's %s", a.Name, key)
			}
		}
	}
}

func TestPlanHandbackNeedsArgoCD(t *testing.T) {
	if _, err := PlanHandback(fixture(t), map[string]bool{"traefik": true}, "kx", DefaultGateway); err == nil || !strings.Contains(err.Error(), "argo-cd") {
		t.Fatalf("err = %v", err)
	}
}

func TestInventoryKeepsNamesOnly(t *testing.T) {
	inv, err := Inventory([]byte("apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: n\ndata:\n  password: c2VjcmV0\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: n\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\n"
	if string(inv) != want {
		t.Fatalf("inventory:\n%s", inv)
	}
	gone, err := WouldPrune([]byte(`{"spec":{"destination":{"namespace":"n"}},"status":{"resources":[{"kind":"Secret","namespace":"n","name":"s"},{"group":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"r"},{"kind":"ConfigMap","namespace":"n","name":"extra"}]}}`), inv)
	if err != nil {
		t.Fatal(err)
	}
	if len(gone) != 1 || gone[0].String() != "ConfigMap n/extra" {
		t.Fatalf("would prune %v", gone)
	}
}

func TestWriteHandbackScript(t *testing.T) {
	p, err := platform.Load("../apply/testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	res, err := WriteHandback(pl, HandbackOptions{Out: out, Render: func(_, cluster string) (map[string][]byte, error) {
		r := map[string][]byte{}
		for _, chart := range []string{"bootstrap-crds", "homer-dashboard", "traefik"} {
			r[chart] = []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: " + chart + "\n  namespace: " + chart + "\ndata:\n  cluster: " + cluster + "\n")
		}
		if cluster == "hub" {
			r["argo-cd"] = fixture(t)
		}
		return r, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(res.Script)
	if err != nil {
		t.Fatal(err)
	}
	script := string(b)
	prune := strings.Index(script, "would_prune edge-traefik handback/traefik/edge.yaml")
	restore := strings.Index(script, `restore_appset "$a"`)
	project := strings.Index(script, "patch appproject hx-dev-dev")
	argobot := strings.Index(script, "delete namespace argobot")
	if prune < 0 || restore < prune || project < restore || argobot < project {
		t.Fatalf("handback.sh must check pruning, then restore the ApplicationSets, then the AppProject, then remove argobot:\n%s", script)
	}
	if strings.Contains(script, "cub unit") || strings.Contains(script, "cub release") {
		t.Fatal("handback changes nothing in ConfigHub")
	}
	for _, f := range []string{"handback/applicationset-argocd.json", "handback/appproject-hx-dev-dev.json", "handback/traefik/edge.yaml", "handback/homer-dashboard/hub.yaml"} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if strings.Join(res.Applications, ",") != "hub-traefik,edge-traefik,hub-argocd,hub-homer-dashboard" {
		t.Errorf("applications = %v", res.Applications)
	}
	check(t, "handback.sh", script)
}
