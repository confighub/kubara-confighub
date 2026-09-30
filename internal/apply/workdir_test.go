package apply

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The tests keep fetched dependencies in a cache of their own, and read no
// Helm repositories of yours.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "cub-kubara-test-")
	if err != nil {
		panic(err)
	}
	DepsCache = filepath.Join(tmp, "deps")
	os.Setenv("HELM_REPOSITORY_CONFIG", filepath.Join(tmp, "repositories.yaml"))
	os.Setenv("HELM_REPOSITORY_CACHE", filepath.Join(tmp, "repository-cache"))
	code := m.Run()
	CleanupCharts()
	os.RemoveAll(tmp)
	os.Exit(code)
}

// platformWithDependency copies the kubara-render fixture and gives its web
// chart a dependency on a chart beside it, file://../lib, which helm fetches
// offline into web/charts/ with a Chart.lock.
func platformWithDependency(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "platform")
	if _, err := copyTree("testdata/kubara-render", dir); err != nil {
		t.Fatal(err)
	}
	helm := filepath.Join(dir, "platform-components", "helm")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(helm, "lib", "Chart.yaml"), "apiVersion: v2\nname: lib\nversion: 0.1.0\n")
	write(filepath.Join(helm, "lib", "templates", "cm.yaml"), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-lib\n")
	write(filepath.Join(helm, "web", "Chart.yaml"), "apiVersion: v2\nname: web\nversion: 0.1.0\ndependencies:\n  - name: lib\n    version: 0.1.0\n    repository: file://../lib\n")
	return dir
}

func files(t *testing.T, dir string) string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		out = append(out, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}

// Helm fetches a chart's dependencies into the chart's own directory. The work
// directory is the platform's Git repository, so a render reads a copy and
// leaves the work directory as it found it.
func TestRenderLeavesTheWorkDirectoryAlone(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is not installed")
	}
	dir := platformWithDependency(t)
	before := files(t, dir)
	for i := 0; i < 2; i++ { // the second render reads the same copy
		renders, err := RenderCluster(dir, "hub", Capabilities{})
		if err != nil {
			t.Fatal(err)
		}
		var web string
		for _, r := range renders {
			if r.Chart == "web" {
				web = strings.Join(r.Docs, "---\n")
			}
		}
		if !strings.Contains(web, "name: from-lib") {
			t.Fatalf("web lacks its dependency's object:\n%s", web)
		}
		if after := files(t, dir); after != before {
			t.Fatalf("render %d changed the work directory:\nbefore:\n%s\nafter:\n%s", i+1, before, after)
		}
	}
}

// Helm's cause is on its Error: line; its last line only says to use --debug.
func TestRenderPassesHelmsErrorThrough(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is not installed")
	}
	dir := platformWithDependency(t)
	fail := filepath.Join(dir, "platform-components", "helm", "web", "templates", "fail.yaml")
	if err := os.WriteFile(fail, []byte(`{{ fail "ERROR: webhook provider needs an image repository and a tag" }}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := RenderCluster(dir, "hub", Capabilities{})
	if err == nil {
		t.Fatal("the render succeeded")
	}
	msg := err.Error()
	for _, want := range []string{
		"ERROR: webhook provider needs an image repository and a tag",
		"chart:  " + filepath.Join(dir, "platform-components", "helm", "web"),
		"values: " + filepath.Join(dir, "platform-configs", "hub", "helm", "web", "values.generated.yaml"),
		filepath.Join(dir, "platform-configs", "hub", "helm", "web", "values-zz.yaml"),
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the error lacks %q:\n%s", want, msg)
		}
	}
	if !strings.HasPrefix(msg, "helm template webapp: execution error at (web/templates/fail.yaml") {
		t.Errorf("the error does not start with helm's cause:\n%s", msg)
	}
	if strings.Contains(msg, "cub-kubara-charts-") || strings.Contains(msg, "--debug") {
		t.Errorf("the error names the copy, or helm's --debug hint:\n%s", msg)
	}
}

func TestHelmErrorWithoutAnErrorLine(t *testing.T) {
	err := helmError("x", "charts/x", nil, "walk.go:75: found symbolic link\nsomething broke", nil)
	want := "helm template x: something broke\n  chart:  charts/x\n  values: none but the chart's own values.yaml\n  helm also printed:\n    walk.go:75: found symbolic link"
	if err.Error() != want {
		t.Errorf("got:\n%s\nwant:\n%s", err, want)
	}
}

// A later process takes a chart's dependencies from DepsCache, and a change to
// any chart fetches them afresh.
func TestDependenciesAreCachedByTheChartsContent(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm is not installed")
	}
	saved := DepsCache
	DepsCache = t.TempDir()
	t.Cleanup(func() { DepsCache = saved })
	dir := platformWithDependency(t)
	web := func() string {
		t.Helper()
		CleanupCharts() // as a new process would start
		renders, err := RenderCluster(dir, "hub", Capabilities{})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range renders {
			if r.Chart == "web" {
				return strings.Join(r.Docs, "---\n")
			}
		}
		return ""
	}
	if !strings.Contains(web(), "name: from-lib") {
		t.Fatal("web lacks its dependency")
	}
	cached, _ := filepath.Glob(filepath.Join(DepsCache, "*", "web", "charts", "lib-0.1.0.tgz"))
	if len(cached) != 1 {
		t.Fatalf("DepsCache holds %v", cached)
	}
	if !strings.Contains(web(), "name: from-lib") {
		t.Fatal("web lacks its dependency on a render from the cache")
	}
	cm := filepath.Join(dir, "platform-components", "helm", "lib", "templates", "cm.yaml")
	if err := os.WriteFile(cm, []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-lib-changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(web(), "name: from-lib-changed") {
		t.Fatal("a changed dependency did not reach the render")
	}
}
