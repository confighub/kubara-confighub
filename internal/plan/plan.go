// Package plan works out what ConfigHub would hold for a Kubara platform,
// offline: a base per component, a variant per cluster it runs on, a Target per
// cluster, and the stage order a change follows. It changes nothing.
package plan

import (
	"fmt"
	"sort"
	"strings"

	"github.com/confighub/kubara-confighub/internal/catalog"
	"github.com/confighub/kubara-confighub/internal/platform"
)

type Options struct {
	Prefix string
	Stages []string
}

type Plan struct {
	Source        string
	Generated     bool
	ConfigVersion string
	Bootstrap     catalog.Catalog
	General       catalog.Catalog
	Workshop      catalog.WorkshopSource
	Stages        []Stage
	Hub           string
	Components    []Component
	Control       string
	Problems      []string
	Notes         []string
}

type Stage struct {
	Name     string
	Clusters []ClusterPlan
}

type ClusterPlan struct {
	Name       string
	Type       string
	Space      string
	Target     string
	Components []string
}

type Component struct {
	Name      string
	Catalog   string
	Category  string
	Upstream  []UpstreamPlan
	Base      string
	Variants  []Variant
	FromChart bool // versions read from what Kubara generated
}

type UpstreamPlan struct {
	Chart    catalog.Chart
	Evidence catalog.Evidence
}

type Variant struct {
	Cluster string
	Space   string
	Target  string
}

// Summary counts Workshop evidence across every upstream chart in the plan.
type Summary struct {
	Charts, Checked, OtherVersion, OtherRepository, Unchecked int
}

func (p Plan) Summary() Summary {
	var s Summary
	for _, c := range p.Components {
		for _, u := range c.Upstream {
			s.Charts++
			switch u.Evidence.Status {
			case "checked":
				s.Checked++
			case "other-version":
				s.OtherVersion++
			case "other-repository":
				s.OtherRepository++
			default:
				s.Unchecked++
			}
		}
	}
	return s
}

// SpaceCount is how many ConfigHub Spaces the plan would create.
func (p Plan) SpaceCount() int {
	n := 1
	for _, st := range p.Stages {
		n += len(st.Clusters)
	}
	for _, c := range p.Components {
		n += 1 + len(c.Variants)
	}
	return n
}

var stageOrder = []string{"dev", "development", "test", "qa", "staging", "stage", "preprod", "pre-prod", "prod", "production"}

// Build turns a Kubara platform into a plan.
func Build(p platform.Platform, opts Options) (Plan, error) {
	if opts.Prefix == "" {
		opts.Prefix = "kubara"
	}
	out := Plan{Source: p.Dir, Generated: len(p.Generated) > 0, ConfigVersion: p.Config.Version, Control: opts.Prefix + "-platform"}
	if p.Config.Version != "v1alpha4" {
		out.Problems = append(out.Problems, fmt.Sprintf("config version is %q; cub kubara reads Kubara's v1alpha4 config", p.Config.Version))
	}
	version, problems := p.Config.CatalogVersion()
	out.Problems = append(out.Problems, problems...)
	if version == "" {
		version = catalog.DefaultVersion
	}
	boot, general, err := catalog.Pair(version)
	if err != nil {
		return out, err
	}
	out.Bootstrap, out.General = boot, general
	if name, bv, ok := catalog.ParseRef(p.Config.BootstrapCatalog); !ok || name != "bootstrap" {
		out.Problems = append(out.Problems, "bootstrapCatalog is not set to a Kubara bootstrap catalog; Kubara's 3.0 catalogs need it set explicitly")
	} else if bv != boot.Version {
		out.Notes = append(out.Notes, fmt.Sprintf("bootstrapCatalog is %s; the catalog snapshot that pairs with general %s is bootstrap %s", bv, general.Version, boot.Version))
	}
	workshop, err := catalog.LoadWorkshop()
	if err != nil {
		return out, err
	}
	out.Workshop = workshop.Source

	hubs := 0
	for _, cl := range p.Config.Clusters {
		if cl.Type == "hub" {
			hubs++
			out.Hub = cl.Name
		}
	}
	if hubs == 0 {
		out.Problems = append(out.Problems, "no cluster has type hub; Kubara needs one hub")
	} else if hubs > 1 {
		out.Problems = append(out.Problems, fmt.Sprintf("%d clusters have type hub; Kubara now allows one hub per config file (kubara-io/kubara#650)", hubs))
	}

	// Components: the bootstrap catalog's services run on every cluster; the
	// general catalog's run where a cluster enables them.
	byName := map[string]*Component{}
	var order []string
	add := func(cat catalog.Catalog, svc catalog.Service, cluster platform.Cluster) {
		c, ok := byName[svc.Name]
		if !ok {
			c = &Component{Name: svc.Name, Catalog: cat.Name + " " + cat.Version, Category: svc.Category, Base: fmt.Sprintf("%s-%s-base", opts.Prefix, svc.Name)}
			upstream := svc.Upstream
			if gen, ok := p.Generated[svc.ChartPath]; ok && len(gen) > 0 {
				upstream, c.FromChart = gen, true
			}
			for _, u := range upstream {
				c.Upstream = append(c.Upstream, UpstreamPlan{Chart: u, Evidence: workshop.Match(u)})
			}
			byName[svc.Name] = c
			order = append(order, svc.Name)
		}
		c.Variants = append(c.Variants, Variant{Cluster: cluster.Name, Space: fmt.Sprintf("%s-%s-%s", opts.Prefix, svc.Name, cluster.Name), Target: cluster.Name + "/" + cluster.Name})
	}
	stageClusters := map[string][]ClusterPlan{}
	var seenStages []string
	for _, cl := range p.Config.Clusters {
		cp := ClusterPlan{Name: cl.Name, Type: cl.Type, Space: cl.Name, Target: cl.Name + "/" + cl.Name}
		for _, svc := range boot.Services {
			if allowed(svc, cl.Type) {
				add(boot, svc, cl)
				cp.Components = append(cp.Components, svc.Name)
			}
		}
		for _, name := range cl.Enabled() {
			svc, ok := general.Service(name)
			if !ok {
				out.Problems = append(out.Problems, fmt.Sprintf("cluster %s enables %s, which general catalog %s does not define", cl.Name, name, general.Version))
				continue
			}
			if !allowed(svc, cl.Type) {
				out.Problems = append(out.Problems, fmt.Sprintf("cluster %s is a %s, and %s runs only on %s clusters", cl.Name, cl.Type, name, strings.Join(svc.ClusterTypes, " or ")))
				continue
			}
			add(general, svc, cl)
			cp.Components = append(cp.Components, name)
		}
		stage := cl.Stage
		if stage == "" {
			stage = "fleet"
		}
		if _, ok := stageClusters[stage]; !ok {
			seenStages = append(seenStages, stage)
		}
		stageClusters[stage] = append(stageClusters[stage], cp)
	}
	for _, name := range orderStages(seenStages, opts.Stages) {
		out.Stages = append(out.Stages, Stage{Name: name, Clusters: stageClusters[name]})
	}
	for _, s := range opts.Stages {
		if _, ok := stageClusters[s]; !ok {
			out.Problems = append(out.Problems, fmt.Sprintf("--stages names %s, and no cluster has that stage", s))
		}
	}
	for _, name := range order {
		out.Components = append(out.Components, *byName[name])
	}
	return out, nil
}

func allowed(svc catalog.Service, clusterType string) bool {
	if len(svc.ClusterTypes) == 0 {
		return true
	}
	for _, t := range svc.ClusterTypes {
		if t == clusterType {
			return true
		}
	}
	return false
}

func orderStages(seen, explicit []string) []string {
	if len(explicit) > 0 {
		var out []string
		for _, s := range explicit {
			for _, x := range seen {
				if x == s {
					out = append(out, s)
				}
			}
		}
		for _, x := range seen {
			if !contains(out, x) {
				out = append(out, x)
			}
		}
		return out
	}
	rank := func(s string) int {
		for i, x := range stageOrder {
			if strings.EqualFold(x, s) {
				return i
			}
		}
		return len(stageOrder)
	}
	out := append([]string(nil), seen...)
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
