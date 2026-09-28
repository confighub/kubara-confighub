package apply

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
)

var update = flag.Bool("update", false, "rewrite the golden files under examples/cub-kubara")

const golden = "../../examples/cub-kubara/apply-two-clusters"

// fakeRender stands in for KubaraRenderer: bootstrap-crds renders the
// same on every cluster, and every other chart renders with the cluster's name.
func fakeRender(_, cluster, dir string) (map[string]string, error) {
	out := map[string]string{}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	for _, chart := range []string{"argo-cd", "bootstrap-crds", "homer-dashboard", "traefik"} {
		body := "kind: ConfigMap\nmetadata:\n  name: " + chart + "\ndata:\n  cluster: " + cluster + "\n"
		if chart == "bootstrap-crds" {
			body = "kind: CustomResourceDefinition\nmetadata:\n  name: example.kubara.io\n"
		}
		if chart == "argo-cd" {
			body += "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: grafana\n  namespace: monitoring\ndata:\n  admin-password: " + cluster + "-random\n  admin-user: YWRtaW4=\n"
		}
		path := filepath.Join(dir, chart+".yaml")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			return nil, err
		}
		out[chart] = path
	}
	return out, nil
}

func build(t *testing.T) plan.Plan {
	t.Helper()
	p, err := platform.Load("testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pl.Problems) > 0 {
		t.Fatalf("fixture has problems: %v", pl.Problems)
	}
	return pl
}

func TestWriteTwoClusters(t *testing.T) {
	out := t.TempDir()
	res, err := Write(build(t), Options{Out: out, AllowAuthors: true, Render: fakeRender})
	if err != nil {
		t.Fatal(err)
	}
	// argo-cd and homer-dashboard on the hub; bootstrap-crds and traefik on both.
	if res.Components != 4 || res.Variants != 6 {
		t.Fatalf("components=%d variants=%d", res.Components, res.Variants)
	}
	if strings.Join(res.Unchanged, ",") != "kx-bootstrap-crds-edge" {
		t.Fatalf("unchanged = %v", res.Unchanged)
	}
	if strings.Join(res.Secrets, ";") != "argo-cd: Secret monitoring/grafana (2 values)" {
		t.Fatalf("secrets = %v", res.Secrets)
	}
	argo, _ := os.ReadFile(filepath.Join(out, "argo-cd", "base.yaml"))
	if strings.Contains(string(argo), "hub-random") || !strings.Contains(string(argo), "admin-password: \"\"") {
		t.Fatalf("a Secret's values must not reach ConfigHub:\n%s", argo)
	}
	base, _ := os.ReadFile(filepath.Join(out, "traefik", "base.yaml"))
	if !strings.Contains(string(base), "cluster: hub") {
		t.Fatalf("the base should be the dev cluster's render, the stage a change reaches first:\n%s", base)
	}
	if _, err := os.Stat(filepath.Join(out, "traefik", "edge.yaml")); err != nil {
		t.Fatalf("edge renders differently, so it needs its own file: %v", err)
	}
	for _, name := range []string{"apply.sh", "traefik/change-workflow.yaml", "argo-cd/change-workflow.yaml"} {
		b, err := os.ReadFile(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		check(t, name, string(b))
	}
}

func TestWorkflowWaitsForTheStageBefore(t *testing.T) {
	got := workflowYAML([]string{"dev", "prod"}, false)
	for _, want := range []string{"AllowAuthors: false", "- Name: prod\n    WhereSpace: \"Labels.Stage = 'prod'\"\n    Prerequisites:\n      - Released", "ReleasePrerequisites:\n      - approval"} {
		if !strings.Contains(got, want) {
			t.Fatalf("workflow lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(strings.SplitN(got, "- Name: prod", 2)[0], "Released") {
		t.Fatalf("the first stage waits for nothing before it:\n%s", got)
	}
}

func TestWriteRefusesAConfigOnlyPlatform(t *testing.T) {
	pl := build(t)
	pl.Generated = false
	if _, err := Write(pl, Options{Out: t.TempDir(), Render: fakeRender}); err == nil || !strings.Contains(err.Error(), "generate --helm") {
		t.Fatalf("err = %v", err)
	}
}

func TestWriteRefusesAPlanWithProblems(t *testing.T) {
	pl := build(t)
	pl.Problems = []string{"two hubs"}
	if _, err := Write(pl, Options{Out: t.TempDir(), Render: fakeRender}); err == nil || !strings.Contains(err.Error(), "two hubs") {
		t.Fatalf("err = %v", err)
	}
}

func check(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join(golden, name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run go test ./internal/apply -update)", path, err)
	}
	if string(want) != got {
		t.Fatalf("%s differs from the output; rerun with -update after reviewing:\n%s", path, got)
	}
}

func TestWithoutSecretValuesKeepsOtherDocuments(t *testing.T) {
	in := "kind: ConfigMap\nmetadata:\n  name: a\ndata:\n  k: v   # kept as written\n---\nkind: Deployment\nspec:\n  template:\n    metadata:\n      annotations:\n        checksum/secret: 4b5d58b90a76e2b2b9aff3cd5c750e7ee445c2c311c3be93e539df852a3eec7d\n---\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  token: abc\n---\nkind: Secret\nmetadata:\n  name: empty\n"
	out, names, err := withoutSecretValues([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.HasPrefix(got, "kind: ConfigMap\nmetadata:\n  name: a\ndata:\n  k: v   # kept as written\n---\n") {
		t.Fatalf("a document without a Secret changed:\n%s", got)
	}
	if !strings.Contains(got, "        checksum/secret: \"\"\n") {
		t.Fatalf("the checksum of the emptied values survived:\n%s", got)
	}
	if strings.Contains(got, "abc") || !strings.Contains(got, "token: \"\"") {
		t.Fatalf("the token survived:\n%s", got)
	}
	if strings.Join(names, ";") != "Secret s (1 value)" {
		t.Fatalf("names = %v", names)
	}
}

func TestWithoutSecretValuesReadsEveryStyle(t *testing.T) {
	in := "kind: \"Secret\"\nmetadata:\n  name: quoted\ndata:\n  a: c2VjcmV0\n---\n{kind: !!str Secret, metadata: {name: flow}, stringData: {b: secret}}\n---\nkind: List\nitems:\n  - kind: Secret\n    metadata:\n      name: listed\n    data:\n      c: c2VjcmV0\n"
	out, names, err := withoutSecretValues([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "c2VjcmV0") || strings.Contains(string(out), ": secret") {
		t.Fatalf("a Secret value survived:\n%s", out)
	}
	if strings.Join(names, ";") != "Secret quoted (1 value);Secret flow (1 value);Secret listed (1 value)" {
		t.Fatalf("names = %v", names)
	}
}

func TestApprovalPatchCarriesAllowAuthors(t *testing.T) {
	for _, allow := range []bool{true, false} {
		want := `"AllowAuthors":` + map[bool]string{true: "true", false: "false"}[allow]
		if got := approvalJSON(allow); !strings.Contains(got, want) || !strings.Contains(got, `"Name":"approval"`) {
			t.Fatalf("approvalJSON(%v) = %s", allow, got)
		}
	}
	if got := stagesJSON([]string{"dev", "prod"}); got != `{"Stages":[{"Name":"dev","WhereSpace":"Labels.Stage = 'dev'","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = 'prod'","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}` {
		t.Fatalf("stagesJSON = %s", got)
	}
}
