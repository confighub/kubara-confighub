// Package plan works out what ConfigHub would hold for a Kubara platform,
// offline: a base per component, a variant per cluster it runs on, and the
// stage order a change follows. It changes nothing.
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
	Prefix        string
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
	Components []string
}

type Component struct {
	Name      string
	ChartPath string // the chart directory Kubara generates under platform-components/helm
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
	n := 0
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
	out := Plan{Source: p.Dir, Generated: len(p.Generated) > 0, ConfigVersion: p.Config.Version, Prefix: opts.Prefix}
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
	for _, cl := range p.Config.Clusters {
		sm := cl.ArgoCD.SelfManaged
		if cl.Type == "spoke" && sm == "enabled" {
			out.Problems = append(out.Problems, fmt.Sprintf("spoke %s has argocd.selfManaged enabled; in Kubara's hub-and-spoke the hub's Argo CD delivers to spokes, so set it to disabled", cl.Name))
		}
		if cl.Type == "hub" && sm == "disabled" {
			out.Problems = append(out.Problems, fmt.Sprintf("hub %s has argocd.selfManaged disabled; the hub runs the Argo CD that delivers to the spokes", cl.Name))
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
			c = &Component{Name: svc.Name, ChartPath: svc.ChartPath, Catalog: cat.Name + " " + cat.Version, Category: svc.Category, Base: fmt.Sprintf("%s-%s-base", opts.Prefix, svc.Name)}
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
		c.Variants = append(c.Variants, Variant{Cluster: cluster.Name, Space: fmt.Sprintf("%s-%s-%s", opts.Prefix, svc.Name, cluster.Name)})
	}
	stageClusters := map[string][]ClusterPlan{}
	var seenStages []string
	for _, cl := range p.Config.Clusters {
		cp := ClusterPlan{Name: cl.Name, Type: cl.Type}
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
	if err := checkStages(opts.Stages, seenStages, stageClusters); err != nil {
		return out, err
	}
	for _, name := range orderStages(seenStages, opts.Stages) {
		out.Stages = append(out.Stages, Stage{Name: name, Clusters: stageClusters[name]})
	}
	// Variants follow the stage order, so a component's first variant is the
	// cluster a change reaches first, and its render is the base.
	rank := map[string]int{}
	for _, st := range out.Stages {
		for _, cl := range st.Clusters {
			rank[cl.Name] = len(rank)
		}
	}
	for _, name := range order {
		c := *byName[name]
		sort.SliceStable(c.Variants, func(i, j int) bool { return rank[c.Variants[i].Cluster] < rank[c.Variants[j].Cluster] })
		out.Components = append(out.Components, c)
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

// checkStages refuses a --stages that does not name each stage config.yaml
// uses exactly once. A stage it left out used to go last, after prod, so a
// forgotten stage took a change after prod. Every command that takes --stages
// builds its plan here, so each of them refuses it.
func checkStages(explicit, seen []string, clusters map[string][]ClusterPlan) error {
	if len(explicit) == 0 {
		return nil
	}
	var problems []string
	counted := map[string]int{}
	for _, s := range explicit {
		counted[s]++
		if counted[s] == 2 {
			problems = append(problems, fmt.Sprintf("names %s twice", s))
		}
		if _, ok := clusters[s]; !ok && counted[s] == 1 {
			problems = append(problems, fmt.Sprintf("names %s, which no cluster in config.yaml has", s))
		}
	}
	for _, s := range seen {
		if counted[s] == 0 {
			var names []string
			for _, cl := range clusters[s] {
				names = append(names, cl.Name)
			}
			problems = append(problems, fmt.Sprintf("leaves out %s, the stage of %s", s, strings.Join(names, ", ")))
		}
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("--stages %s %s.\n"+
		"Name each stage config.yaml uses once, in the order a change reaches them, such as --stages %s, or leave --stages out for that default order",
		strings.Join(explicit, ","), strings.Join(problems, "; "), strings.Join(orderStages(seen, nil), ","))
}

// orderStages puts the stages config.yaml uses in the order a change reaches
// them: as --stages names them, which checkStages has held to naming each one
// once, or else dev, staging, prod, then the rest.
func orderStages(seen, explicit []string) []string {
	if len(explicit) > 0 {
		return append([]string(nil), explicit...)
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
