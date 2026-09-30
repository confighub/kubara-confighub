package cmd

import (
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/check"
)

func TestCheckOutputAndExit(t *testing.T) {
	results := []check.Result{
		{Space: "k-metrics-server-hub", Application: "hub-metrics-server", Release: 2, Health: "Healthy", Recorded: "id-1"},
		{Space: "k-traefik-hub", Application: "hub-traefik", Release: 1, Health: "Progressing", Waiting: "Argo CD reports hub-traefik as Progressing"},
		{Space: "k-cert-manager-hub", Application: "hub-cert-manager", Release: 1, Health: "Degraded", Problems: []string{"Argo CD reports hub-cert-manager as Degraded"}, Recorded: "id-2"},
		{Space: "k-bootstrap-crds-hub", Skipped: "no ApplicationSet delivers it; Kubara's bootstrap keeps it"},
	}
	var b strings.Builder
	printCheck(&b, results)
	want := `k-metrics-server-hub: hub-metrics-server runs release 2, synced, healthy, prunes nothing, keeps Secret values; recorded a Pass (id-1)
k-traefik-hub: NOT YET: hub-traefik runs release 1, synced, prunes nothing, keeps Secret values; Argo CD reports hub-traefik as Progressing, not Healthy yet
k-cert-manager-hub: FAIL: Argo CD reports hub-cert-manager as Degraded; recorded a rejection (id-2)
k-bootstrap-crds-hub: skipped, no ApplicationSet delivers it; Kubara's bootstrap keeps it
`
	if b.String() != want {
		t.Errorf("output:\n%s\nwant:\n%s", b.String(), want)
	}
	err := checkVerdict(results)
	if err == nil || !strings.Contains(err.Error(), "1 of 4 variants do not run") || !strings.Contains(err.Error(), "1 of 4 variants are not Healthy yet") {
		t.Errorf("verdict = %v", err)
	}
	if err := checkVerdict(results[1:2]); err == nil {
		t.Error("a variant that is not Healthy yet exits non-zero")
	}
	if err := checkVerdict([]check.Result{results[0], results[3]}); err != nil {
		t.Errorf("a Pass and a skip exit zero: %v", err)
	}
}
