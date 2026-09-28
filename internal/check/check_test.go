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
		!strings.Contains(recorded[0], "argocd.argoproj.io/revision=sha256:b2") {
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
  "operationState":{"phase":"Running","operation":{"sync":{"sources":[{"repoURL":"http://git.example/platform.git"}]}}},`, 1)
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
