package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runRoot(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRoot()
	var out strings.Builder
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

// A second --hub used to replace the first without a word.
func TestInitRefusesASecondHub(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "platform")
	_, err := runRoot(t, "init", "--out", dir, "--hub", "a:dev", "--hub", "b:prod", "--services", "cert-manager")
	if err == nil {
		t.Fatal("init accepted two --hub flags")
	}
	for _, want := range []string{"one --hub", "a:dev, b:prod", "--spoke"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("init wrote %s before refusing", dir)
	}
}

func TestInitTakesOneHubAndWritesGitIgnore(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "platform")
	out, err := runRoot(t, "init", "--out", dir, "--hub", "a:dev", "--spoke", "b:prod", "--services", "cert-manager")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "wrote "+filepath.Join(dir, ".gitignore")) {
		t.Errorf("init does not say it wrote .gitignore:\n%s", out)
	}
}
