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
	// The hub reports live status only once it reads ConfigHub: argobot is the last step.
	if strings.Index(script, "k apply -f argobot.yaml") < strings.Index(script, "drop_git_sources\n") {
		t.Fatal("argobot must be installed after the hub reads ConfigHub")
	}
	// Two service accounts and no worker: Argo CD pulls with a token of one
	// that can only read, and argobot records live status with a key of the
	// other, which alone holds EditChildren. Each credential is kept while
	// ConfigHub still lists it, and replaced when it does not.
	for _, w := range []string{
		"cub serviceaccount create kx-delivery --allow-exists --quiet",
		"cub serviceaccount create kx-argobot --allow-exists --quiet",
		"--permission View:serviceaccount:kx-delivery --permission ViewChildren:serviceaccount:kx-delivery",
		"--permission View:serviceaccount:kx-argobot --permission ViewChildren:serviceaccount:kx-argobot --permission EditChildren:serviceaccount:kx-argobot",
		`cub serviceaccount token create kx-delivery --description 'Argo CD on Kubara'\''s hub, kx' -o json) || { no_impersonate kx-delivery; exit 1; }`,
		`--from-literal=username=token --from-file=password=<(printf '%s' "$token")`,
		`k annotate --local -f - confighub.com/token-jti="$jti"`,
		`cub serviceaccount token revoke kx-delivery "$old"`,
		"--permission Claim:serviceaccount:kx-argobot",
		`cub serviceaccount key list kx-argobot -o json | jq -e --arg k "$kid" 'any(.[].UserKey; .Kid == $k)'`,
		`cub serviceaccount key add kx-argobot --generate "$key_dir/argobot.jwk"`,
		`cub serviceaccount key delete kx-argobot "$old"`,
		`cub release list --space "$1" --where "Published = true"`,
		`this script needs v0.9.0 or later`,
	} {
		if !strings.Contains(script, w) {
			t.Errorf("handover.sh lacks %q", w)
		}
	}
	// Credential Secrets are written with create or replace: kubectl apply
	// would keep a copy of the token or key in last-applied-configuration.
	for _, w := range []string{
		`k annotate --local -f - confighub.com/token-jti="$jti" -o yaml | write_secret argocd confighub-kx-targets`,
		"--dry-run=client -o yaml | write_secret argobot argobot-secrets",
	} {
		if !strings.Contains(script, w) {
			t.Errorf("handover.sh lacks %q", w)
		}
	}
	for _, l := range strings.Split(script, "\n") {
		if strings.Contains(l, "secret") && strings.Contains(l, "k apply -f -") {
			t.Errorf("handover.sh applies a Secret: %s", l)
		}
	}
	for _, bad := range []string{"confighub.com/live-status", "cub worker", "bot_user", "EditChildren:serviceaccount:kx-delivery"} {
		if strings.Contains(script, bad) {
			t.Errorf("handover.sh still has %q", bad)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(out, "argobot.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	check(t, "argobot.yaml", string(manifest))
}

func TestArgobotHasOnlyWhatItNeeds(t *testing.T) {
	m := argobotManifest("kx-targets")
	for _, w := range []string{
		"image: " + ArgobotImage,
		`resources: ["applications"]`,
		`verbs: ["get", "list", "watch", "patch"]`,
		"name: argobot-secrets",
		"key: CONFIGHUB_AUTH_PRIVATE_KEY",
		"value: kx-targets/argobot",
	} {
		if !strings.Contains(m, w) {
			t.Errorf("argobot.yaml lacks %q", w)
		}
	}
	// Kubara's Argo CD namespace holds repository credentials; argobot must
	// not be able to read them, nor anything outside Applications.
	for _, bad := range []string{`"secrets"`, "- secrets", `"*"`, "ClusterRole", "CONFIGHUB_WORKER", "ARGO_SYNC_MODE", "CONFIGHUB_SUBSCRIPTION_NAME"} {
		if strings.Contains(m, bad) {
			t.Errorf("argobot.yaml grants or holds %q", bad)
		}
	}
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

func TestParseGateway(t *testing.T) {
	for in, want := range map[string]Gateway{
		"":                                 {Host: DefaultGateway},
		"oci.hub.confighub.com":            {Host: "oci.hub.confighub.com"},
		"https://oci.example.com/":         {Host: "oci.example.com"},
		"oci://oci.example.com":            {Host: "oci.example.com"},
		"http://host.docker.internal:5000": {Host: "host.docker.internal:5000", PlainHTTP: true},
		"localhost:5000":                   {Host: "localhost:5000"},
	} {
		got, err := ParseGateway(in)
		if err != nil || got != want {
			t.Errorf("ParseGateway(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"ftp://host", "http://", "http://host/space/x", "host?x=1"} {
		if g, err := ParseGateway(bad); err == nil {
			t.Errorf("ParseGateway(%q) = %+v; want an error", bad, g)
		}
	}
}

func TestWriteHandoverScriptForAPlainHTTPGateway(t *testing.T) {
	p, err := platform.Load("../apply/testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	write := func(o Options) string {
		t.Helper()
		o.Out = t.TempDir()
		o.Render = func(_, _ string) ([]byte, error) { return fixture(t), nil }
		res, err := Write(pl, o)
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(res.Script)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	script := write(Options{Gateway: "http://host.docker.internal:5000", ConfigHubURL: "http://host.docker.internal:9090"})
	for _, w := range []string{
		// Argo CD's repoURLs and the credential name the host; the credential says plain HTTP.
		"#   argocd                   oci://host.docker.internal:5000/space/kx-argo-cd-{{name}}",
		"--from-literal=url=oci://host.docker.internal:5000/space/kx- \\\n  --from-literal=insecureOCIForceHttp=true \\\n",
		"--gateway host.docker.internal:5000 ",
		"case \"$(reads \"$app\")\" in oci://host.docker.internal:5000/*)",
		// argobot reaches ConfigHub at the address the hub knows it by.
		"--from-literal=CONFIGHUB_URL='http://host.docker.internal:9090' \\\n",
	} {
		if !strings.Contains(script, w) {
			t.Errorf("handover.sh lacks %q", w)
		}
	}
	for _, bad := range []string{"oci://http://", "oci.hub.confighub.com", "cub context get"} {
		if strings.Contains(script, bad) {
			t.Errorf("handover.sh has %q", bad)
		}
	}
	// ConfigHub's own gateway serves TLS: no insecure credential, and argobot uses cub's context.
	def := write(Options{})
	if strings.Contains(def, "insecureOCIForceHttp") || !strings.Contains(def, "cub context get -o jq=.coordinate.serverURL") {
		t.Error("the default handover.sh must use TLS and cub's current context")
	}
	if _, err := Write(pl, Options{Out: t.TempDir(), Gateway: "ftp://x", Render: func(_, _ string) ([]byte, error) { return fixture(t), nil }}); err == nil {
		t.Error("handover took an ftp:// gateway")
	}
}
