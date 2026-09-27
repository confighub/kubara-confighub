package catalog

import "testing"

func TestParseRef(t *testing.T) {
	name, version, ok := ParseRef("oci://ghcr.io/kubara-io/catalogs/general:3.0.0")
	if !ok || name != "general" || version != "3.0.0" {
		t.Fatalf("got %q %q %v", name, version, ok)
	}
	if _, _, ok := ParseRef("oci://example.com/other:1"); ok {
		t.Fatal("a non-Kubara reference parsed")
	}
}

func TestPairUsesTheNewestBootstrapAtOrBelow(t *testing.T) {
	boot, general, err := Pair("5.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if general.Version != "5.1.0" || boot.Version != "5.0.1" {
		t.Fatalf("pair = bootstrap %s, general %s", boot.Version, general.Version)
	}
	if _, _, err := Pair("9.9.9"); err == nil {
		t.Fatal("an unknown catalog version paired")
	}
}

func TestMatchOnlyClaimsTheExactVersionFromTheSameRepository(t *testing.T) {
	w := Workshop{Charts: []WorkshopChart{
		{Chart: "traefik", Version: "41.0.2", Repository: "oci://ghcr.io/traefik/helm"},
		{Chart: "web", Version: "1.0.0", Repository: "https://charts.example.com"},
	}}
	cases := []struct {
		chart Chart
		want  string
	}{
		{Chart{Name: "traefik", Version: "41.0.2", Repository: "oci://ghcr.io/traefik/helm"}, "checked"},
		{Chart{Name: "traefik", Version: "41.4.0", Repository: "oci://ghcr.io/traefik/helm/"}, "other-version"},
		{Chart{Name: "web", Version: "1.0.0", Repository: "https://mirror.example.com"}, "other-repository"},
		{Chart{Name: "absent", Version: "1.0.0", Repository: "https://x"}, "unchecked"},
	}
	for _, c := range cases {
		if got := w.Match(c.chart).Status; got != c.want {
			t.Errorf("%s@%s from %s: %s, want %s", c.chart.Name, c.chart.Version, c.chart.Repository, got, c.want)
		}
	}
}

func TestEmbeddedSnapshotsLoad(t *testing.T) {
	for _, v := range []string{"1.1.0", "3.0.0", "5.1.0"} {
		if _, _, err := Pair(v); err != nil {
			t.Errorf("%s: %v", v, err)
		}
	}
	w, err := LoadWorkshop()
	if err != nil || len(w.Charts) == 0 || w.Source.Commit == "" {
		t.Fatalf("workshop evidence: %d charts, commit %q, err %v", len(w.Charts), w.Source.Commit, err)
	}
}
