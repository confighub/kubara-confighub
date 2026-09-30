package cmd

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/confighub/kubara-confighub/internal/check"
)

// printCheck prints one line per variant: a Pass, "not yet", FAIL or skipped,
// and what was recorded.
func printCheck(w io.Writer, results []check.Result) {
	for _, r := range results {
		switch {
		case r.Skipped != "":
			fmt.Fprintf(w, "%s: skipped, %s\n", r.Space, r.Skipped)
			continue
		case r.Passed():
			fmt.Fprintf(w, "%s: %s runs release %d, synced, healthy, prunes nothing, keeps Secret values", r.Space, r.Application, r.Release)
		case r.NotYet():
			fmt.Fprintf(w, "%s: NOT YET: %s runs release %d, synced, prunes nothing, keeps Secret values; %s, not Healthy yet", r.Space, r.Application, r.Release, r.Waiting)
		default:
			fmt.Fprintf(w, "%s: FAIL: %s", r.Space, strings.Join(r.Problems, "; "))
			if r.Waiting != "" {
				fmt.Fprintf(w, "; %s", r.Waiting)
			}
		}
		switch {
		case r.Recorded != "" && r.Passed():
			fmt.Fprintf(w, "; recorded a Pass (%s)", r.Recorded)
		case r.Recorded != "":
			fmt.Fprintf(w, "; recorded a rejection (%s)", r.Recorded)
		}
		fmt.Fprintln(w)
	}
}

// checkVerdict is check's exit status: an error when any variant failed or
// is not Healthy yet.
func checkVerdict(results []check.Result) error {
	failed, waiting := 0, 0
	for _, r := range results {
		switch {
		case r.NotYet():
			waiting++
		case r.Skipped == "" && !r.Passed():
			failed++
		}
	}
	var parts []string
	if failed > 0 {
		parts = append(parts, fmt.Sprintf("%d of %d variants do not run their approved release as they should", failed, len(results)))
	}
	if waiting > 0 {
		parts = append(parts, fmt.Sprintf("%d of %d variants are not Healthy yet; run check again once they are", waiting, len(results)))
	}
	if len(parts) == 0 {
		return nil
	}
	return errors.New(strings.Join(parts, ", and "))
}
