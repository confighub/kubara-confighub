package render

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/confighub/kubara-confighub/internal/apply"
)

// The tests keep fetched chart dependencies in a cache of their own, and
// remove the chart copies renders make.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "cub-kubara-test-")
	if err != nil {
		panic(err)
	}
	apply.DepsCache = filepath.Join(tmp, "deps")
	code := m.Run()
	apply.CleanupCharts()
	os.RemoveAll(tmp)
	os.Exit(code)
}
