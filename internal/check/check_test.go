package check

import (
	"fmt"
	"reflect"
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

func releases(digests ...string) []HubRelease {
	var rs []HubRelease
	for i, d := range digests {
		rs = append(rs, HubRelease{Num: i + 1, ManifestDigest: d, Published: true})
	}
	return rs
}

// fake is Kubara's hub, read with kubectl, and ConfigHub, asked as a Hub.
type fake struct {
	apps     []string
	releases map[string][]HubRelease
	calls    []string
	attested []Attestation
}

func (f *fake) run(name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	switch {
	case strings.Contains(call, "get applicationsets "):
		return []byte(appset), nil
	case strings.Contains(call, "get applications "):
		return []byte(`{"items":[` + strings.Join(f.apps, ",") + `]}`), nil
	}
	// check asks ConfigHub through the Hub, and runs nothing but kubectl.
	return nil, fmt.Errorf("unexpected %s", call)
}

func (f *fake) Releases(space string) ([]HubRelease, error) {
	return f.releases[space], nil
}

func (f *fake) Attest(a Attestation) (string, error) {
	f.attested = append(f.attested, a)
	return "0f0e0d0c-0b0a-4908-8706-050403020100", nil
}

func TestCheckPassesAHandedOverHub(t *testing.T) {
	f := &fake{
		apps: []string{app("lab-hub-metrics-server", "lab-metrics-server-lab-hub", "sha256:b2"), app("lab-spoke-metrics-server", "lab-metrics-server-lab-spoke", "sha256:a1")},
		releases: map[string][]HubRelease{
			"lab-metrics-server-lab-hub":   releases("sha256:a1", "sha256:b2"),
			"lab-metrics-server-lab-spoke": releases("sha256:a1"),
		},
	}
	results, err := Check(lab, f.run, f, Options{HubContext: "kind-hub", Record: true})
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
	for _, c := range f.calls {
		if !strings.HasPrefix(c, "kubectl --context kind-hub ") {
			t.Errorf("check runs only kubectl, with the hub context: %s", c)
		}
	}
	if len(f.attested) != 2 {
		t.Fatalf("recorded: %+v", f.attested)
	}
	got := f.attested[0]
	want := Attestation{
		Space: "lab-metrics-server-lab-hub", Type: "LiveCheck", Revision: "LastReleasedRevisionNum",
		Claims: map[string]string{
			"argocd.argoproj.io/application": "lab-hub-metrics-server",
			"argocd.argoproj.io/revision":    "sha256:b2",
			"argocd.argoproj.io/health":      "Healthy",
		},
		Note: "cub kubara check: lab-hub-metrics-server reads and runs release 2, synced, healthy, prunes nothing, keeps Secret values",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recorded:\n%+v\nwant:\n%+v", got, want)
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
		releases: map[string][]HubRelease{
			"lab-metrics-server-lab-hub": releases("sha256:a1", "sha256:b2"),
		},
	}
	results, err := Check(lab, f.run, f, Options{Record: true})
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
	got := attestations(f)
	if a, ok := got["lab-metrics-server-lab-spoke"]; ok {
		t.Errorf("a variant with no release has nothing to attest to: %+v", a)
	}
	if !got["lab-metrics-server-lab-hub"].Reject {
		t.Errorf("a failed check records a rejection: %+v", f.attested)
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
		releases: map[string][]HubRelease{"lab-metrics-server-lab-hub": nil},
	}
	results, err := Check(lab, f.run, f, Options{})
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

func attestations(f *fake) map[string]Attestation {
	out := map[string]Attestation{}
	for _, a := range f.attested {
		out[a.Space] = a
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
			releases: map[string][]HubRelease{
				"lab-metrics-server-lab-hub":   releases("sha256:a1"),
				"lab-metrics-server-lab-spoke": releases("sha256:a1"),
			},
		}
		results, err := Check(lab, f.run, f, Options{Record: true})
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
		if !rej.Reject || rej.Note != "cub kubara check: "+want || rej.Claims["argocd.argoproj.io/health"] != status {
			t.Errorf("%s: the hub records a rejection naming the app: %+v", status, rej)
		}
		if ok := got["lab-metrics-server-lab-spoke"]; ok.Reject || ok.Space == "" {
			t.Errorf("%s: the spoke records a Pass: %+v", status, ok)
		}
	}
}

// Progressing is "not yet": neither a Pass nor a rejection, and nothing is
// recorded. It may still become Healthy.
func TestCheckWaitsForAProgressingApplication(t *testing.T) {
	for _, status := range []string{"Progressing", "Suspended", "Unknown", ""} {
		f := &fake{
			apps:     []string{health(app("hub-traefik", "lab-metrics-server-lab-hub", "sha256:a1"), status)},
			releases: map[string][]HubRelease{"lab-metrics-server-lab-hub": releases("sha256:a1")},
		}
		results, err := Check(lab, f.run, f, Options{Record: true})
		if err != nil {
			t.Fatal(err)
		}
		hub := results[0]
		if hub.Passed() || !hub.NotYet() || len(hub.Problems) != 0 || !strings.Contains(hub.Waiting, "hub-traefik") {
			t.Errorf("%q: hub = %+v", status, hub)
		}
		if rec, ok := attestations(f)["lab-metrics-server-lab-hub"]; ok {
			t.Errorf("%q: a variant that is not Healthy yet records nothing: %+v", status, rec)
		}
	}
}

// A Progressing Application with something else wrong is a failure, and its
// rejection says what Argo CD reports about its health too.
func TestCheckFailsAProgressingApplicationWithAProblem(t *testing.T) {
	f := &fake{
		apps:     []string{health(app("hub-traefik", "lab-metrics-server-lab-hub", "sha256:a1"), "Progressing")},
		releases: map[string][]HubRelease{"lab-metrics-server-lab-hub": releases("sha256:a1", "sha256:b2")},
	}
	results, err := Check(lab, f.run, f, Options{Record: true})
	if err != nil {
		t.Fatal(err)
	}
	hub := results[0]
	if hub.Passed() || hub.NotYet() || len(hub.Problems) != 1 {
		t.Fatalf("hub = %+v", hub)
	}
	rej := attestations(f)["lab-metrics-server-lab-hub"]
	if !rej.Reject || !strings.Contains(rej.Note, "the latest release, 2") || !strings.Contains(rej.Note, "hub-traefik as Progressing") {
		t.Errorf("rejection = %+v", rej)
	}
	if rej.Claims["argocd.argoproj.io/health"] != "Progressing" {
		t.Errorf("the rejection claims the health Argo CD reports: %+v", rej.Claims)
	}
}
