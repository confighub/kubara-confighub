package check

import (
	"fmt"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/plan"
)

var lab = plan.Plan{Prefix: "lab", Components: []plan.Component{
	{Name: "metrics-server", ChartPath: "metrics-server", Variants: []plan.Variant{
		{Cluster: "lab-hub", Space: "lab-metrics-server-lab-hub"},
		{Cluster: "lab-spoke", Space: "lab-metrics-server-lab-spoke"},
	}},
	{Name: "bootstrap-crds", ChartPath: "bootstrap-crds", Variants: []plan.Variant{
		{Cluster: "lab-hub", Space: "lab-bootstrap-crds-lab-hub"},
	}},
}}

// app is an Application as Argo CD reports it after handover, in good order.
func app(name, space, revision string) string {
	return fmt.Sprintf(`{"metadata":{"name":%q},
 "spec":{"source":{"repoURL":"oci://oci.hub.confighub.com/space/%s","targetRevision":"latest","path":"."},
  "ignoreDifferences":[{"kind":"Secret","jsonPointers":["/data","/stringData"]}],
  "syncPolicy":{"syncOptions":["ServerSideApply=true","RespectIgnoreDifferences=true"]}},
 "status":{"sync":{"status":"Synced","revision":%q},"health":{"status":"Healthy"},
  "resources":[{"kind":"Job","namespace":"argocd","name":"dex-restarter","requiresPruning":true,"hook":true}]}}`, name, space, revision)
}

const appset = `{"items":[{"spec":{"template":{"spec":{"source":{"repoURL":"oci://oci.hub.confighub.com/space/lab-metrics-server-{{name}}"}}}}}]}`

func releases(digests ...string) string {
	var rs []string
	for i, d := range digests {
		rs = append(rs, fmt.Sprintf(`{"Release":{"ReleaseNum":%d,"ManifestDigest":%q,"Published":true}}`, i+1, d))
	}
	return "[" + strings.Join(rs, ",") + "]"
}

type fake struct {
	apps     []string
	releases map[string]string
	calls    []string
}

func (f *fake) run(name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	switch {
	case strings.Contains(call, "get applicationsets "):
		return []byte(appset), nil
	case strings.Contains(call, "get applications "):
		return []byte(`{"items":[` + strings.Join(f.apps, ",") + `]}`), nil
	case strings.HasPrefix(call, "cub release list"):
		return []byte(f.releases[args[3]]), nil
	case strings.HasPrefix(call, "cub attestation create"):
		return []byte("Recorded pass LiveCheck attestation 0f0e0d0c-0b0a-4908-8706-050403020100 in x"), nil
	}
	return nil, fmt.Errorf("unexpected %s", call)
}

func TestCheckPassesAHandedOverHub(t *testing.T) {
	f := &fake{
		apps: []string{app("lab-hub-metrics-server", "lab-metrics-server-lab-hub", "sha256:b2"), app("lab-spoke-metrics-server", "lab-metrics-server-lab-spoke", "sha256:a1")},
		releases: map[string]string{
			"lab-metrics-server-lab-hub":   releases("sha256:a1", "sha256:b2"),
			"lab-metrics-server-lab-spoke": releases("sha256:a1"),
		},
	}
	results, err := Check(lab, f.run, Options{HubContext: "kind-hub", Record: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("results = %d", len(results))
	}
	hub, spoke, crds := results[0], results[1], results[2]
	if !hub.Passed() || hub.Release != 2 || hub.Application != "lab-hub-metrics-server" || hub.Recorded == "" {
		t.Errorf("hub = %+v", hub)
	}
	if !spoke.Passed() || spoke.Release != 1 {
		t.Errorf("spoke = %+v", spoke)
	}
	if crds.Skipped == "" {
		t.Errorf("bootstrap-crds has no ApplicationSet, so it is skipped: %+v", crds)
	}
	var recorded []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "kubectl") && !strings.HasPrefix(c, "kubectl --context kind-hub ") {
			t.Errorf("kubectl without the hub context: %s", c)
		}
		if strings.HasPrefix(c, "cub attestation create") {
			recorded = append(recorded, c)
		}
	}
	if len(recorded) != 2 || strings.Contains(recorded[0], "--reject") ||
		!strings.Contains(recorded[0], "--revision LastReleasedRevisionNum") ||
		!strings.Contains(recorded[0], "--type LiveCheck") ||
		!strings.Contains(recorded[0], "argocd.argoproj.io/revision=sha256:b2") ||
		!strings.Contains(recorded[0], "argocd.argoproj.io/health=Healthy") ||
		!strings.Contains(recorded[0], "synced, healthy,") {
		t.Errorf("recorded:\n%s", strings.Join(recorded, "\n"))
	}
}

func TestCheckNamesEachProblem(t *testing.T) {
	stale := app("lab-hub-metrics-server", "lab-metrics-server-lab-hub", "sha256:a1")
	stale = strings.Replace(stale, `"requiresPruning":true,"hook":true`, `"requiresPruning":true,"hook":false`, 1)
	stale = strings.Replace(stale, `"RespectIgnoreDifferences=true"`, `"Validate=true"`, 1)
	stale = strings.Replace(stale, `"spec":{"source"`, `"spec":{"sources":[{"repoURL":"http://git.example/platform.git"}],"source"`, 1)
	stale = strings.Replace(stale, `"status":"Synced"`, `"status":"OutOfSync"`, 1)
	stale = strings.Replace(stale, `"health":{"status":"Healthy"},`, `"health":{"status":"Healthy"},
  "operationState":{"phase":"Running","operation":{"sync":{}},"syncResult":{"revisions":["96826f05d3af330414f5049b63d3c6fed98f6717"]}},`, 1)
	f := &fake{
		apps: []string{stale},
		releases: map[string]string{
			"lab-metrics-server-lab-hub": releases("sha256:a1", "sha256:b2"),
		},
	}
	results, err := Check(lab, f.run, Options{Record: true})
	if err != nil {
		t.Fatal(err)
	}
	hub, spoke := results[0], results[1]
	all := strings.Join(hub.Problems, "\n")
	for _, want := range []string{
		"still lists Git sources",
		"sync status is OutOfSync",
		"a sync Argo CD started from Git is still running",
		"Argo CD would delete Job/argocd/dex-restarter",
		"overwrite live Secret values",
		"Argo CD runs sha256:a1, and the latest release, 2, is sha256:b2",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("problems lack %q:\n%s", want, all)
		}
	}
	if spoke.Passed() || !strings.Contains(strings.Join(spoke.Problems, ""), "no Application reads oci://oci.hub.confighub.com/space/lab-metrics-server-lab-spoke") {
		t.Errorf("spoke = %+v", spoke)
	}
	rejected := false
	for _, c := range f.calls {
		if strings.HasPrefix(c, "cub attestation create --space lab-metrics-server-lab-hub") {
			rejected = strings.Contains(c, "--reject")
		}
		if strings.HasPrefix(c, "cub attestation create --space lab-metrics-server-lab-spoke") {
			t.Errorf("a variant with no release has nothing to attest to: %s", c)
		}
	}
	if !rejected {
		t.Errorf("a failed check records a rejection:\n%s", strings.Join(f.calls, "\n"))
	}
}

func TestFromGit(t *testing.T) {
	for _, c := range []struct {
		rec  syncRecord
		want bool
	}{
		{syncRecord{}, false},
		{syncRecord{Revision: "sha256:0541963d7e2e"}, false},
		{syncRecord{Revisions: []string{"96826f05d3af330414f5049b63d3c6fed98f6717"}}, true},
		{syncRecord{Sources: []struct {
			RepoURL string `json:"repoURL"`
		}{{RepoURL: "oci://oci.hub.confighub.com/space/kubara-argo-cd-hub"}}}, false},
		{syncRecord{Sources: []struct {
			RepoURL string `json:"repoURL"`
		}{{RepoURL: "http://git.example/platform.git"}}}, true},
	} {
		if got := c.rec.fromGit(); got != c.want {
			t.Errorf("fromGit(%+v) = %v, want %v", c.rec, got, c.want)
		}
	}
}

func TestCheckWantsARelease(t *testing.T) {
	f := &fake{
		apps:     []string{app("lab-hub-metrics-server", "lab-metrics-server-lab-hub", "sha256:a1")},
		releases: map[string]string{"lab-metrics-server-lab-hub": "[]"},
	}
	results, err := Check(lab, f.run, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(results[0].Problems, ""), "published no release") {
		t.Errorf("hub = %+v", results[0])
	}
}

// health sets the health Argo CD reports for an Application.
func health(app, status string) string {
	return strings.Replace(app, `"health":{"status":"Healthy"}`, `"health":{"status":"`+status+`"}`, 1)
}

func attestations(f *fake) map[string]string {
	out := map[string]string{}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "cub attestation create --space ") {
			out[strings.Fields(c)[4]] = c
		}
	}
	return out
}

// A Degraded or Missing Application is a failure that names it, and --record
// writes a rejection, never a Pass (issue #25: cert-manager on the kind lab).
func TestCheckRejectsAnUnhealthyApplication(t *testing.T) {
	for _, status := range []string{"Degraded", "Missing"} {
		f := &fake{
			apps: []string{
				health(app("hub-cert-manager", "lab-metrics-server-lab-hub", "sha256:a1"), status),
				app("spoke-metrics-server", "lab-metrics-server-lab-spoke", "sha256:a1"),
			},
			releases: map[string]string{
				"lab-metrics-server-lab-hub":   releases("sha256:a1"),
				"lab-metrics-server-lab-spoke": releases("sha256:a1"),
			},
		}
		results, err := Check(lab, f.run, Options{Record: true})
		if err != nil {
			t.Fatal(err)
		}
		hub := results[0]
		want := "Argo CD reports hub-cert-manager as " + status
		if hub.Passed() || hub.NotYet() || strings.Join(hub.Problems, "; ") != want {
			t.Errorf("%s: hub = %+v, want the one problem %q", status, hub, want)
		}
		if !results[1].Passed() {
			t.Errorf("%s: a Healthy spoke still passes: %+v", status, results[1])
		}
		got := attestations(f)
		rej := got["lab-metrics-server-lab-hub"]
		if !strings.Contains(rej, "--reject") || !strings.Contains(rej, want) || !strings.Contains(rej, "argocd.argoproj.io/health="+status) {
			t.Errorf("%s: the hub records a rejection naming the app: %s", status, rej)
		}
		if strings.Contains(got["lab-metrics-server-lab-spoke"], "--reject") {
			t.Errorf("%s: the spoke records a Pass: %s", status, got["lab-metrics-server-lab-spoke"])
		}
	}
}

// Progressing is "not yet": neither a Pass nor a rejection, and nothing is
// recorded. It may still become Healthy.
func TestCheckWaitsForAProgressingApplication(t *testing.T) {
	for _, status := range []string{"Progressing", "Suspended", "Unknown", ""} {
		f := &fake{
			apps:     []string{health(app("hub-traefik", "lab-metrics-server-lab-hub", "sha256:a1"), status)},
			releases: map[string]string{"lab-metrics-server-lab-hub": releases("sha256:a1")},
		}
		results, err := Check(lab, f.run, Options{Record: true})
		if err != nil {
			t.Fatal(err)
		}
		hub := results[0]
		if hub.Passed() || !hub.NotYet() || len(hub.Problems) != 0 || !strings.Contains(hub.Waiting, "hub-traefik") {
			t.Errorf("%q: hub = %+v", status, hub)
		}
		if rec, ok := attestations(f)["lab-metrics-server-lab-hub"]; ok {
			t.Errorf("%q: a variant that is not Healthy yet records nothing: %s", status, rec)
		}
	}
}

// A Progressing Application with something else wrong is a failure, and its
// rejection says what Argo CD reports about its health too.
func TestCheckFailsAProgressingApplicationWithAProblem(t *testing.T) {
	f := &fake{
		apps:     []string{health(app("hub-traefik", "lab-metrics-server-lab-hub", "sha256:a1"), "Progressing")},
		releases: map[string]string{"lab-metrics-server-lab-hub": releases("sha256:a1", "sha256:b2")},
	}
	results, err := Check(lab, f.run, Options{Record: true})
	if err != nil {
		t.Fatal(err)
	}
	hub := results[0]
	if hub.Passed() || hub.NotYet() || len(hub.Problems) != 1 {
		t.Fatalf("hub = %+v", hub)
	}
	rej := attestations(f)["lab-metrics-server-lab-hub"]
	if !strings.Contains(rej, "--reject") || !strings.Contains(rej, "the latest release, 2") || !strings.Contains(rej, "hub-traefik as Progressing") {
		t.Errorf("rejection = %s", rej)
	}
}
