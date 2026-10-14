package handover

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
)

func writeScript(t *testing.T, approve []string) (Result, string) {
	t.Helper()
	p, err := platform.Load("../apply/testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	res, err := Write(pl, Options{Out: t.TempDir(), ApproveStages: approve, Render: func(_, _ string) ([]byte, error) { return fixture(t), nil }})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(res.Script)
	if err != nil {
		t.Fatal(err)
	}
	return res, string(b)
}

// With --approve-stages dev, handover.sh approves dev as the person who runs
// it, and leaves prod's approval to someone else.
func TestApproveStagesLeavesTheOthersToSomeoneElse(t *testing.T) {
	res, script := writeScript(t, []string{"dev"})
	if strings.Join(res.Approves, ",") != "dev" || strings.Join(res.Waits, ",") != "prod" {
		t.Fatalf("approves %v, waits %v", res.Approves, res.Waits)
	}
	for _, want := range []string{
		"# It approves each release as the person who runs it in: dev.\n",
		"# It approves nothing in: prod (--approve-stages).\n",
		`release_stage kx-traefik-base/"$order" dev me kx-traefik-hub` + "\n",
		`release_stage kx-traefik-base/"$order" prod someone-else kx-traefik-edge` + "\n",
		"  exit 2\n",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("handover.sh lacks %q", want)
		}
	}
	// The script stops before step 5, which changes the hub.
	if strings.Index(script, "  exit 2\n") > strings.Index(script, `step "5/6`) {
		t.Error("handover.sh must stop for an approval before it changes the hub")
	}
	if out, err := exec.Command("bash", "-n", res.Script).CombinedOutput(); err != nil {
		t.Fatalf("bash -n: %v\n%s", err, out)
	}

	res, _ = writeScript(t, []string{})
	if len(res.Approves) != 0 || strings.Join(res.Waits, ",") != "dev,prod" {
		t.Errorf("--approve-stages none: approves %v, waits %v", res.Approves, res.Waits)
	}
}

func TestApproveStagesMustBeStagesOfThePlatform(t *testing.T) {
	p, err := platform.Load("../apply/testdata/platform")
	if err != nil {
		t.Fatal(err)
	}
	pl, err := plan.Build(p, plan.Options{Prefix: "kx"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = Write(pl, Options{Out: t.TempDir(), ApproveStages: []string{"dev", "staging"}, Render: func(_, _ string) ([]byte, error) { return fixture(t), nil }})
	if err == nil || !strings.Contains(err.Error(), "--approve-stages names staging, which is not a stage of this platform; its stages are dev, prod") {
		t.Fatalf("err = %v", err)
	}
}

// fakeCub stands in for cub: prod's release needs an approval until
// approved-prod exists, each Space in released-ids has released the change
// order, and each Space in published has published a release. It logs each call.
const fakeCub = `#!/usr/bin/env bash
dir=$(dirname "$0")
echo "cub $*" >> "$dir/calls"
case "$*" in
  "changeorder get --space base o1 -o jq=.ChangeOrder.ReleasedSpaceIDs // [] | join(\" \")") cat "$dir/released-ids" 2>/dev/null | tr "\\n" " " ;;
  "changeorder get --space base o1 -o jq=.ChangeOrder.ResolvedSpaceIDs // [] | join(\" \")") cat "$dir/resolved-ids" 2>/dev/null | tr "\\n" " " ;;
  "variant promote"*"--target-stage dev"*) echo "id-hub" >> "$dir/resolved-ids" ;;
  "variant promote"*"--target-stage prod"*)
    if grep -q id-edge "$dir/resolved-ids" 2>/dev/null; then echo "change order has completed ChangeWorkflow, so there is nothing left to promote"; exit 1; fi
    echo "id-edge" >> "$dir/resolved-ids" ;;
  "space get "*) echo "id-$3" ;;
  "release list --space "*) grep -c "^$4\$" "$dir/published" 2>/dev/null || true ;;
  "release publish hub --quiet" | "release publish edge --quiet") echo "$3" >> "$dir/published" ;;
  "variant approve"*"--stage prod"*) touch "$dir/approved-prod" ;;
  "release publish edge "*)
    if [ ! -f "$dir/approved-prod" ]; then
      echo "Failed: HTTP 422: unable to publish a release of change order 'o1' in stage 'prod': requires approval: 1 Approval attestation(s) from eligible attesters; cm revision 3 has 0 of 1"
      exit 1
    fi
    echo "id-edge" >> "$dir/released-ids"; echo edge >> "$dir/published" ;;
  "release publish hub "*) echo "id-hub" >> "$dir/released-ids"; echo hub >> "$dir/published" ;;
esac
exit 0
`

// Run release_stage, from the script's own header, against a fake cub: the
// first run releases dev, stops at prod and names the command; after someone
// else approves prod, a second run resumes without approving anything again.
func TestReleaseStageStopsAndResumes(t *testing.T) {
	helpers, dir := fakeHelpers(t)
	driver := helpers + `
held=
release_stage base/o1 dev me hub
release_stage base/o1 prod someone-else edge
printf '%s' "$waiting"
`
	run := func() string {
		t.Helper()
		cmd := exec.Command("bash", "-c", driver)
		cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		return string(out)
	}
	calls := func() string {
		b, _ := os.ReadFile(filepath.Join(dir, "calls"))
		os.Remove(filepath.Join(dir, "calls"))
		return string(b)
	}

	out := run()
	if !strings.Contains(out, "edge waits for an approval in prod\n  cub variant approve --change-order base/o1 --stage prod\n") {
		t.Errorf("first run output:\n%s", out)
	}
	c := calls()
	if !strings.Contains(c, "cub variant approve --change-order base/o1 --stage dev --quiet") || strings.Contains(c, "--stage prod") {
		t.Errorf("the script must approve dev, and never prod:\n%s", c)
	}

	// Someone else approves prod.
	if err := os.WriteFile(filepath.Join(dir, "approved-prod"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	out = run()
	if !strings.Contains(out, "base/o1: dev has released it") || strings.Contains(out, "waits") {
		t.Errorf("resumed run output:\n%s", out)
	}
	c = calls()
	if strings.Contains(c, "variant approve") || strings.Contains(c, "variant promote") || !strings.Contains(c, "cub release publish edge --revision ChangeOrder:base/o1") {
		t.Errorf("the resumed run must promote and approve nothing, and publish prod:\n%s", c)
	}
}

// fakeHelpers is the script's own helpers, with a fake cub first on PATH.
func fakeHelpers(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is not installed")
	}
	_, script := writeScript(t, []string{"dev"})
	start := strings.Index(script, "set -euo pipefail\n")
	end := strings.Index(script, "# would_prune ")
	if start < 0 || end < 0 {
		t.Fatal("the script's helpers moved")
	}
	helpers := strings.Replace(script[start:end], "cd \"$(dirname \"$0\")\"\n", "", 1)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cub"), []byte(fakeCub), 0o755); err != nil {
		t.Fatal(err)
	}
	return helpers, dir
}

// A change order that carries no change for a variant, because the variant
// already holds every revision of its base, counts the variant as released
// though it has never published a release. release_stage publishes the
// variant's first release where it may approve, and leaves it to someone else
// elsewhere.
func TestReleaseStagePublishesAFirstReleaseTheChangeOrderCarriesNothingFor(t *testing.T) {
	helpers, dir := fakeHelpers(t)
	if err := os.WriteFile(filepath.Join(dir, "released-ids"), []byte("id-hub\nid-edge\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", "-c", helpers+`
held=
release_stage base/o1 dev me hub
release_stage base/o1 prod someone-else edge
printf '%s' "$waiting"
`)
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(string(out), "hub: base/o1 carries no change for it; publishing its first release") ||
		!strings.Contains(string(out), "edge waits for its first release in prod\n  cub release publish edge\n") {
		t.Errorf("output:\n%s", out)
	}
	calls, _ := os.ReadFile(filepath.Join(dir, "calls"))
	if !strings.Contains(string(calls), "cub release publish hub --quiet") || strings.Contains(string(calls), "release publish edge") ||
		strings.Contains(string(calls), "variant promote") || strings.Contains(string(calls), "variant approve") {
		t.Errorf("it must publish hub's first release and nothing else:\n%s", calls)
	}
}

// fakeCubRefusedByChangeOrder stands in for ConfigHub v0.9.2 and later where a
// release by the change order is refused because no revision carries it, and
// the change order does not yet read Released for the Space. Every unit of the
// base was passed over as AlreadyTaken.
const fakeCubRefusedByChangeOrder = `#!/usr/bin/env bash
dir=$(dirname "$0")
echo "cub $*" >> "$dir/calls"
case "$*" in
  "changeorder get --space base o1 -o jq=.ChangeOrder.ReleasedSpaceIDs // [] | join(\" \")") echo "" ;;
  "changeorder get --space base o1 -o jq=.ChangeOrder.ResolvedSpaceIDs // [] | join(\" \")") echo "id-edge" ;;
  "changeorder get --space base o1 -o jq=(.ChangeOrder.SkippedUnits"*) echo "\"u1=AlreadyTaken\"" ;;
  "unit list --space base "*) echo "\"u1\"" ;;
  "space get "*) echo "id-$3" ;;
  "release list --space "*) echo 0 ;;
  "release publish edge --revision "*)
    echo "Failed: HTTP 422: unable to publish a release of change order 'o1' in stage 'prod': requires approval, but no Revision was found to evaluate it on"
    exit 1 ;;
  "release publish edge --quiet") echo edge >> "$dir/published" ;;
esac
exit 0
`

// When a release by the change order is refused because it carries nothing, the
// variant is released as it stands only in a stage this script may approve;
// in another it is left, with the command, for someone else.
func TestPublishTakenLeavesAnotherStageToSomeoneElse(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is not installed")
	}
	_, script := writeScript(t, []string{"dev"})
	start := strings.Index(script, "set -euo pipefail\n")
	end := strings.Index(script, "# would_prune ")
	helpers := strings.Replace(script[start:end], "cd \"$(dirname \"$0\")\"\n", "", 1)
	for _, c := range []struct{ who, want string }{
		{"someone-else", "edge waits for its first release in prod\n  cub release publish edge\n"},
		{"me", "edge: the change order carried nothing new for it, so it is released as it stands"},
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "cub"), []byte(fakeCubRefusedByChangeOrder), 0o755); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("bash", "-c", helpers+"\nheld=\nrelease_stage base/o1 prod "+c.who+" edge\nprintf '%s' \"$waiting\"\n")
		cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", c.who, err, out)
		}
		if !strings.Contains(string(out), c.want) {
			t.Errorf("%s: output:\n%s", c.who, out)
		}
		_, published := os.Stat(filepath.Join(dir, "published"))
		if (published == nil) != (c.who == "me") {
			t.Errorf("%s: published=%v", c.who, published == nil)
		}
	}
}
