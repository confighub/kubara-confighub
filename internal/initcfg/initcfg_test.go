package initcfg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/confighub/kubara-confighub/internal/platform"
)

func opts(out string) Options {
	return Options{
		Out: out, CatalogVersion: "3.0.0",
		Services:   []string{"cert-manager", "traefik", "homer-dashboard"},
		Clusters:   []ClusterSpec{{Name: "hub-dev", Stage: "dev", Type: "hub"}, {Name: "edge-prod", Stage: "prod", Type: "spoke"}},
		Repository: "https://github.com/example/platform.git", DNSDomain: "traefik.me", Email: "platform@example.com", PluginVersion: "test",
	}
}

func TestWriteProducesAConfigPlanCanRead(t *testing.T) {
	dir := t.TempDir()
	res, err := Write(opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 3 {
		t.Fatalf("files = %v", res.Files)
	}
	if len(res.Skipped) != 1 || !strings.Contains(res.Skipped[0], "homer-dashboard on edge-prod") {
		t.Fatalf("skipped = %v", res.Skipped)
	}
	p, err := platform.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if p.Config.Version != "v1alpha4" || !strings.HasSuffix(p.Config.BootstrapCatalog, "bootstrap:3.0.0") {
		t.Fatalf("config header = %q %q", p.Config.Version, p.Config.BootstrapCatalog)
	}
	if got := strings.Join(p.Config.Clusters[1].Enabled(), ","); got != "cert-manager,traefik" {
		t.Fatalf("spoke services = %s", got)
	}
	env, _ := os.ReadFile(filepath.Join(dir, ".env.example"))
	if !strings.Contains(string(env), "ARGOCD_WIZARD_ACCOUNT_PASSWORD=replace-before-use") {
		t.Fatalf(".env.example should hold placeholders only:\n%s", env)
	}
}

func TestWriteRefusesToOverwrite(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(opts(dir)); err == nil || !strings.Contains(err.Error(), "does not overwrite") {
		t.Fatalf("err = %v", err)
	}
}

func TestWriteNeedsExactlyOneHub(t *testing.T) {
	o := opts(t.TempDir())
	o.Clusters[1].Type = "hub"
	if _, err := Write(o); err == nil || !strings.Contains(err.Error(), "exactly one hub") {
		t.Fatalf("err = %v", err)
	}
}

func TestWriteRejectsAnUnknownService(t *testing.T) {
	o := opts(t.TempDir())
	o.Services = []string{"not-a-service"}
	if _, err := Write(o); err == nil || !strings.Contains(err.Error(), "has no service") {
		t.Fatalf("err = %v", err)
	}
}
