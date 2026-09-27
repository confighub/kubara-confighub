package plan

import (
	"fmt"
	"sort"
	"strings"

	"github.com/confighub/kubara-confighub/internal/catalog"
)

// RenderServices lists what a Kubara catalog release offers, with the
// Workshop Catalog's evidence for each upstream chart.
func RenderServices(boot, general catalog.Catalog, w catalog.Workshop) string {
	var b strings.Builder
	p := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	p("Kubara catalogs  %s, %s", boot.OCI, general.OCI)
	p("")
	p("Always installed, from the bootstrap catalog")
	for _, s := range boot.Services {
		writeService(&b, s, w)
	}
	p("")
	byCategory := map[string][]catalog.Service{}
	for _, s := range general.Services {
		cat := s.Category
		if cat == "" {
			cat = "other"
		}
		byCategory[cat] = append(byCategory[cat], s)
	}
	var cats []string
	for c := range byCategory {
		cats = append(cats, c)
	}
	sort.Strings(cats)
	p("Services you choose, from the general catalog")
	for _, c := range cats {
		p("  %s", c)
		for _, s := range byCategory[c] {
			writeService(&b, s, w)
		}
	}
	p("")
	p("\"checked\" means the Workshop Catalog has this exact chart version; open its page for what it installs and what it needs.")
	p("Kubara's catalogs stay the source of every service. Workshop Catalog at %s.", short(w.Source.Commit))
	return b.String()
}

func writeService(b *strings.Builder, s catalog.Service, w catalog.Workshop) {
	def := ""
	if s.Default == "enabled" {
		def = "  (on by default)"
	}
	types := strings.Join(s.ClusterTypes, ", ")
	fmt.Fprintf(b, "    %-26s %s clusters%s\n", s.Name, types, def)
	if len(s.Upstream) == 0 {
		fmt.Fprintf(b, "    %-26s   Kubara's own chart; no upstream chart to check\n", "")
	}
	for _, u := range s.Upstream {
		ev := w.Match(u)
		note := evidenceShort(ev, u)
		fmt.Fprintf(b, "    %-26s   %s %s  %s\n", "", u.Name, u.Version, note)
	}
}

func evidenceShort(e catalog.Evidence, u catalog.Chart) string {
	switch e.Status {
	case "checked":
		return "checked: " + e.Chart.Page
	case "other-version":
		return "Workshop has " + strings.Join(e.OtherVersions, ", ")
	case "other-repository":
		return "Workshop has this version from another repository"
	default:
		return "unchecked"
	}
}
