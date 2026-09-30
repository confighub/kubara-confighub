// Package cmd is the `cub kubara` command tree.
package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"github.com/confighub/kubara-confighub/internal/apply"
	"github.com/confighub/kubara-confighub/internal/catalog"
	"github.com/confighub/kubara-confighub/internal/check"
	"github.com/confighub/kubara-confighub/internal/handover"
	"github.com/confighub/kubara-confighub/internal/initcfg"
	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
	"github.com/confighub/kubara-confighub/internal/render"
)

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// Version is the plugin's version, set at release build time.
func Version() string { return version }

// errProblems makes a command exit non-zero after it has printed its output.
type errProblems struct{}

func (errProblems) Error() string { return "the plan has problems to fix first" }

func split(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func parseCluster(s, defaultType string) (initcfg.ClusterSpec, error) {
	name, stage, _ := strings.Cut(s, ":")
	if name == "" {
		return initcfg.ClusterSpec{}, fmt.Errorf("cluster %q needs a name", s)
	}
	if stage == "" {
		stage = "dev"
	}
	return initcfg.ClusterSpec{Name: name, Stage: stage, Type: defaultType}, nil
}

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:   "kubara",
		Short: "Run a Kubara platform through ConfigHub",
		Long: `Run a Kubara platform through ConfigHub. Kubara keeps generating the platform
from its own catalogs; ConfigHub adds retained versions, approvals, and exact
releases, and the ConfigHub Workshop Catalog adds evidence about each chart.

  services  lists what a Kubara catalog release offers, with Workshop evidence
            for each chart. Offline.
  init      writes a new Kubara config.yaml for the services and clusters you
            name, and a record of the chart versions and evidence. Offline.
  plan      reads a Kubara config.yaml or a generated platform and shows what
            ConfigHub would hold: a base per component, a variant per cluster,
            and the stage order. Offline; changes nothing.
  apply     renders each cluster of a generated platform and writes the plan
            as files and one script of cub steps, apply.sh, for you to read
            and run. It runs nothing itself.
  render    renders each service for each cluster of a generated platform,
            the way Kubara's ApplicationSets deliver it, and writes the
            objects and a manifest, render.json. Offline.
  handover  writes handover.sh, which runs after apply.sh: each cluster gets a
            Target and a first approved release, Kubara's hub reads those
            releases from ConfigHub instead of Git, and argobot reports each
            one's live status back to ConfigHub.
  check     checks that each cluster runs the release its stage approved.
  handback  writes handback.sh, which hands Kubara's hub back to Git.

Guide: https://github.com/confighub/kubara-confighub/blob/main/docs/user/cub-kubara.md`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	var catalogVersion string
	services := &cobra.Command{
		Use:   "services",
		Short: "List a Kubara catalog release's services, with Workshop evidence",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			boot, general, err := catalog.Pair(catalogVersion)
			if err != nil {
				return err
			}
			w, err := catalog.LoadWorkshop()
			if err != nil {
				return err
			}
			fmt.Fprint(c.OutOrStdout(), plan.RenderServices(boot, general, w))
			return nil
		},
	}
	services.Flags().StringVar(&catalogVersion, "catalog-version", catalog.DefaultVersion, "the Kubara general catalog version ("+strings.Join(catalog.Known("general"), ", ")+")")

	var io initOptions
	initCmd := &cobra.Command{
		Use:   "init --out <dir> --services a,b,c",
		Short: "Write a new Kubara config.yaml and a record of what was chosen",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			opts, err := io.options()
			if err != nil {
				return err
			}
			res, err := initcfg.Write(opts)
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			for _, f := range res.Files {
				fmt.Fprintf(w, "wrote %s\n", f)
			}
			for _, s := range res.Skipped {
				fmt.Fprintf(w, "left out %s\n", s)
			}
			fmt.Fprintln(w, res.GitIgnore)
			fmt.Fprintf(w, "\nNext\n  cp %s/.env.example %s/.env   # then fill in the values it asks for\n", opts.Out, opts.Out)
			fmt.Fprintf(w, "  kubara --work-dir %s --config-file config.yaml --env-file .env generate --helm\n", opts.Out)
			fmt.Fprintf(w, "  cub kubara plan %s\n", opts.Out)
			return nil
		},
	}
	io.register(initCmd)

	var po plan.Options
	var stages string
	planCmd := &cobra.Command{
		Use:   "plan <kubara-dir | config.yaml>",
		Short: "Show what ConfigHub would hold for a Kubara platform; changes nothing",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := platform.Load(args[0])
			if err != nil {
				return err
			}
			po.Stages = split(stages)
			pl, err := plan.Build(p, po)
			if err != nil {
				return err
			}
			fmt.Fprint(c.OutOrStdout(), plan.Render(pl))
			if len(pl.Problems) > 0 {
				return errProblems{}
			}
			return nil
		},
	}
	planCmd.Flags().StringVar(&po.Prefix, "prefix", "kubara", "prefix for everything the plan would create in ConfigHub")
	planCmd.Flags().StringVar(&stages, "stages", "", "the stage order, comma-separated; by default dev, staging, prod, then any others")

	var ao plan.Options
	var aStages, aOut string
	var allowAuthors bool
	var capsFlags []string
	applyCmd := &cobra.Command{
		Use:   "apply <kubara-dir> --out <dir>",
		Short: "Write a generated Kubara platform as renders and one script of cub steps",
		Long: `Render each cluster of a platform Kubara has generated, the way Kubara's hub
delivers it: each service's chart with the release name, namespace and values
files its ApplicationSet uses. Then write:

  apply.sh                     the cub steps; read it, then run it
  plan.txt                     the plan it carries out
  <component>/base.yaml        the render of the cluster a change reaches first
  <component>/<cluster>.yaml   another cluster's render, where it differs
  <component>/change-workflow.yaml
                               the stage order, with an approval before each release

apply.sh creates a component, a base Space and a rollout workflow per Kubara
component, then a variant Space per cluster holding that cluster's render.
It creates no Targets and releases nothing: Kubara's hub, AppProject and
ApplicationSets keep delivering from Git until handover.

Run it again after Kubara generates something new, such as a new catalog
version. Each base whose render changed takes the difference as one change, a
three-way merge that keeps changes made in ConfigHub since, in a change order
on its rollout workflow for you to promote, approve and release.`,
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := platform.Load(args[0])
			if err != nil {
				return err
			}
			ao.Stages = split(aStages)
			pl, err := plan.Build(p, ao)
			if err != nil {
				return err
			}
			caps, err := readCapabilities(capsFlags)
			if err != nil {
				return err
			}
			res, err := apply.Write(pl, apply.Options{Out: aOut, AllowAuthors: allowAuthors, Render: apply.NewKubaraRenderer(caps)})
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			fmt.Fprintf(w, "Wrote %s: %d components, %d variants.\n", res.Script, res.Components, res.Variants)
			for _, st := range pl.Stages {
				for _, cl := range st.Clusters {
					if cp, ok := caps[cl.Name]; ok {
						fmt.Fprintf(w, "Rendered %s with its own capabilities, from context %s: Kubernetes %s, %d APIs.\n", cl.Name, cp.Source, cp.KubeVersion, len(cp.APIs))
					} else {
						fmt.Fprintf(w, "Rendered %s with Helm's default capabilities and the CRDs bootstrap-crds provides; pass --capabilities %s=<kubectl context> to render it as Argo CD will.\n", cl.Name, cl.Name)
					}
				}
			}
			if len(res.Secrets) > 0 {
				fmt.Fprintf(w, "These Secrets go to ConfigHub with their keys and without their values:\n")
				for _, name := range res.Secrets {
					fmt.Fprintf(w, "  %s\n", name)
				}
			}
			for _, v := range res.Unchanged {
				fmt.Fprintf(w, "  %s renders the same as its base, so it records no change\n", v)
			}
			fmt.Fprintf(w, "\nNext\n  less %s        # read what it will do\n  bash %s\n", res.Script, res.Script)
			return nil
		},
	}
	applyCmd.Flags().StringVar(&aOut, "out", "", "directory to write the renders, workflows and apply.sh (required)")
	applyCmd.Flags().StringVar(&ao.Prefix, "prefix", "kubara", "prefix for everything apply.sh creates in ConfigHub")
	applyCmd.Flags().StringVar(&aStages, "stages", "", "the stage order, comma-separated; by default dev, staging, prod, then any others")
	applyCmd.Flags().StringArrayVar(&capsFlags, "capabilities", nil, "render a cluster with its own Kubernetes version and APIs, read from a kubectl context: <cluster>=<context> (repeatable)")
	applyCmd.Flags().BoolVar(&allowAuthors, "allow-authors", true, "let whoever promotes a change also approve it; set false once a second person approves")
	_ = applyCmd.MarkFlagRequired("out")

	var rOut string
	var rClusters []string
	var rJSON, rKeepSecrets bool
	renderCmd := &cobra.Command{
		Use:   "render <kubara-dir> --out <dir>",
		Short: "Render each service for each cluster the way Kubara delivers it, with a manifest; offline",
		Long: `Render a platform Kubara has generated, the way Kubara's hub delivers it.
For each cluster in config.yaml, each service it runs renders from its wrapper
chart with the release name, namespace and values files its ApplicationSet
uses. bootstrap-crds renders as the CRDs kubara bootstrap applies. It uses the
same renderer as apply, and needs helm on your PATH.

It writes:

  <out>/<cluster>/<service>/objects.yaml   the objects, as Kubara delivers them
  <out>/render.json                         what was rendered, and how

render.json lists each cluster with its type, stage and enabled services, and
each service with its chart and version, upstream charts, values files, the
--api-versions passed to helm, its object count and a sha256 of its file. It
also lists each object more than one service renders, and which one owns it.

Secrets keep their keys and lose their values, unless --keep-secret-values.
It contacts no cluster and no ConfigHub server. Helm fetches each chart's
dependencies into a copy of the charts, so the work directory stays as it
was, and they are cached for the next render. Running it again into the same
--out replaces the earlier render.`,
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			var clusters []string
			for _, cl := range rClusters {
				clusters = append(clusters, split(cl)...)
			}
			m, err := render.Write(render.Options{WorkDir: args[0], Out: rOut, Clusters: clusters, KeepSecretValues: rKeepSecrets, Generator: "cub kubara render " + version})
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			if rJSON {
				b, err := render.Marshal(m)
				if err != nil {
					return err
				}
				_, err = w.Write(b)
				return err
			}
			printRender(w, m, rOut)
			return nil
		},
	}
	renderCmd.Flags().StringVar(&rOut, "out", "", "directory to write the objects and render.json (required)")
	renderCmd.Flags().StringArrayVar(&rClusters, "cluster", nil, "render only this cluster from config.yaml (repeatable, or comma-separated)")
	renderCmd.Flags().BoolVar(&rJSON, "json", false, "print render.json to stdout instead of a summary")
	renderCmd.Flags().BoolVar(&rKeepSecrets, "keep-secret-values", false, "write each Secret with its values; they can be credentials a chart generates")
	_ = renderCmd.MarkFlagRequired("out")

	var to plan.Options
	var tStages, tOut, gateway string
	var tCaps []string
	handoverCmd := &cobra.Command{
		Use:   "handover <kubara-dir> --out <dir>",
		Short: "Write the steps that point Kubara's hub at ConfigHub's approved releases",
		Long: `Write handover.sh, the steps that follow apply.sh. It gives each cluster a
Target, releases every variant through its rollout workflow, and points each of
Kubara's ApplicationSets at the cluster's approved release in ConfigHub instead
of Git. Kubara's hub, AppProject and ApplicationSets stay.

Before the hub switches, handover.sh compares what each Application manages
with the release it will read, and stops if Argo CD would delete anything.
Secrets keep their live values: ConfigHub holds their keys, and each
ApplicationSet tells Argo CD to leave their data alone.

Last, it installs argobot on the hub. argobot writes each Application's sync
and health to its variant Space as confighub.com/live-status, which ConfigHub's
Healthy gate reads. It runs as the Targets' server worker, not as you.

Use the same --prefix and --stages as apply.`,
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := platform.Load(args[0])
			if err != nil {
				return err
			}
			to.Stages = split(tStages)
			pl, err := plan.Build(p, to)
			if err != nil {
				return err
			}
			caps, err := readCapabilities(tCaps)
			if err != nil {
				return err
			}
			res, err := handover.Write(pl, handover.Options{Out: tOut, Gateway: gateway, Render: hubArgoRender(caps)})
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			fmt.Fprintf(w, "Wrote %s. These ApplicationSets will read ConfigHub instead of Git:\n", res.Script)
			for _, r := range res.Routes {
				fmt.Fprintf(w, "  %-24s %s\n", r.ApplicationSet, r.RepoURL)
			}
			if len(res.WithKubara) > 0 {
				fmt.Fprintf(w, "No ApplicationSet delivers %s, so Kubara's bootstrap keeps it.\n", strings.Join(res.WithKubara, ", "))
			}
			if len(res.OnGit) > 0 {
				fmt.Fprintf(w, "Left on Git, for services this platform does not enable: %s\n", strings.Join(res.OnGit, ", "))
			}
			fmt.Fprintf(w, "Then it installs argobot %s on the hub, which writes each variant Space's live status.\n", strings.TrimPrefix(handover.ArgobotImage, "ghcr.io/confighub/argobot:"))
			fmt.Fprintf(w, "\nNext, after apply.sh\n  less %s\n  HUB_CONTEXT=<kubectl context of Kubara's hub> bash %s\n", res.Script, res.Script)
			return nil
		},
	}
	handoverCmd.Flags().StringVar(&tOut, "out", "", "directory to write handover.sh (required); the apply --out directory is a good choice")
	handoverCmd.Flags().StringVar(&to.Prefix, "prefix", "kubara", "the prefix apply used")
	handoverCmd.Flags().StringVar(&tStages, "stages", "", "the stage order apply used")
	handoverCmd.Flags().StringVar(&gateway, "gateway", handover.DefaultGateway, "host ConfigHub serves releases from")
	handoverCmd.Flags().StringArrayVar(&tCaps, "capabilities", nil, "render the hub with its own Kubernetes version and APIs, read from a kubectl context: <hub>=<context>")
	_ = handoverCmd.MarkFlagRequired("out")

	var bo plan.Options
	var bStages, bOut, bGateway string
	var bCaps []string
	handbackCmd := &cobra.Command{
		Use:   "handback <kubara-dir> --out <dir>",
		Short: "Write the steps that hand Kubara's hub back to Git",
		Long: `Write handback.sh, which undoes handover on the hub. Each ApplicationSet
handover pointed at ConfigHub reads Kubara's Git sources again, as Kubara
generated it. Each AppProject it changed permits only Kubara's sources again.
argobot and the gateway credential leave the hub.

Before any change, handback.sh compares what each Application manages with
Kubara's Git render for it, and stops if Argo CD would delete anything. Secrets
keep their live values: each ApplicationSet keeps the rule that leaves Secret
data alone.

It changes nothing in ConfigHub. Every Space and release stays, so handover.sh
can hand the hub over again. Git must hold what you want Kubara to deliver: a
change made in ConfigHub since handover is undone unless it is in Git too.

Give it the platform directory Kubara's Git holds. Use the same --prefix and
--stages as apply.`,
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := platform.Load(args[0])
			if err != nil {
				return err
			}
			bo.Stages = split(bStages)
			pl, err := plan.Build(p, bo)
			if err != nil {
				return err
			}
			caps, err := readCapabilities(bCaps)
			if err != nil {
				return err
			}
			res, err := handover.WriteHandback(pl, handover.HandbackOptions{Out: bOut, Gateway: bGateway, Render: clusterRender(caps)})
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			fmt.Fprintf(w, "Wrote %s. These ApplicationSets will read Kubara's Git again:\n", res.Script)
			for _, a := range res.Restore.ApplicationSets {
				fmt.Fprintf(w, "  %s\n", a.Name)
			}
			var projects []string
			for _, pr := range res.Restore.Projects {
				projects = append(projects, pr.Name)
			}
			if len(projects) > 0 {
				fmt.Fprintf(w, "The AppProject %s will permit Kubara's sources only.\n", strings.Join(projects, ", "))
			}
			fmt.Fprintf(w, "It first checks that none of these would prune anything: %s\n", strings.Join(res.Applications, ", "))
			fmt.Fprintf(w, "\nNext\n  less %s\n  HUB_CONTEXT=<kubectl context of Kubara's hub> bash %s\n", res.Script, res.Script)
			return nil
		},
	}
	handbackCmd.Flags().StringVar(&bOut, "out", "", "directory to write handback.sh (required); the handover --out directory is a good choice")
	handbackCmd.Flags().StringVar(&bo.Prefix, "prefix", "kubara", "the prefix apply used")
	handbackCmd.Flags().StringVar(&bStages, "stages", "", "the stage order apply used")
	handbackCmd.Flags().StringVar(&bGateway, "gateway", handover.DefaultGateway, "host ConfigHub serves releases from")
	handbackCmd.Flags().StringArrayVar(&bCaps, "capabilities", nil, "render a cluster with its own Kubernetes version and APIs, read from a kubectl context: <cluster>=<context> (repeatable)")
	_ = handbackCmd.MarkFlagRequired("out")

	var rPrefix, rGateway, rCharts, rOnly string
	routeCmd := &cobra.Command{
		Use:    "route-appsets <argo-cd render>",
		Short:  "Point the ApplicationSets in an argo-cd render at ConfigHub (used by handover.sh)",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			b, err := os.ReadFile(args[0])
			if err != nil {
				return err
			}
			if rOnly != "" {
				doc, err := handover.Only(b, rOnly)
				if err != nil {
					return err
				}
				_, err = c.OutOrStdout().Write(doc)
				return err
			}
			charts := map[string]bool{}
			for _, ch := range split(rCharts) {
				charts[ch] = true
			}
			out, _, err := handover.RouteApplicationSets(b, charts, rPrefix, rGateway)
			if err != nil {
				return err
			}
			_, err = c.OutOrStdout().Write(out)
			return err
		},
	}
	routeCmd.Flags().StringVar(&rPrefix, "prefix", "kubara", "the prefix apply used")
	routeCmd.Flags().StringVar(&rGateway, "gateway", handover.DefaultGateway, "host ConfigHub serves releases from")
	routeCmd.Flags().StringVar(&rCharts, "charts", "", "chart directories ConfigHub holds, comma-separated")
	routeCmd.Flags().StringVar(&rOnly, "only", "", "print only this ApplicationSet, unchanged")

	var pApp, pRelease, pName string
	pruneCmd := &cobra.Command{
		Use:    "would-prune --application <file> --release <file>",
		Short:  "List what an Application would prune on reading a release (used by handover.sh)",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			app, err := os.ReadFile(pApp)
			if err != nil {
				return err
			}
			rel, err := os.ReadFile(pRelease)
			if err != nil {
				return err
			}
			gone, err := handover.WouldPrune(app, rel)
			if err != nil {
				return err
			}
			w := c.OutOrStdout()
			if len(gone) == 0 {
				fmt.Fprintf(w, "%s: prunes nothing\n", pName)
				return nil
			}
			fmt.Fprintf(w, "%s would delete %d object(s) its release does not hold:\n", pName, len(gone))
			for _, r := range gone {
				fmt.Fprintf(w, "  %s\n", r)
			}
			return errProblems{}
		},
	}
	pruneCmd.Flags().StringVar(&pApp, "application", "", "the Application, as kubectl get application -o json")
	pruneCmd.Flags().StringVar(&pRelease, "release", "", "the release, as cub unit data")
	pruneCmd.Flags().StringVar(&pName, "name", "the Application", "the Application's name, for the report")

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the plugin version",
		Args:  cobra.NoArgs,
		Run: func(c *cobra.Command, _ []string) {
			fmt.Fprintf(c.OutOrStdout(), "cub kubara %s (commit %s, built %s)\n", version, commit, date)
		},
	}

	var ko plan.Options
	var kStages string
	var co check.Options
	checkCmd := &cobra.Command{
		Use:   "check <kubara-dir>",
		Short: "Check that each cluster runs the release ConfigHub approved, and optionally record the verdict",
		Long: `Check Kubara's hub after handover. For each variant, it checks that one
Application reads the variant's release from ConfigHub and no Git source, that
Argo CD has synced the latest published release, that the Application is
Healthy, that Argo CD would delete nothing, and that a sync leaves live Secret
values alone.

Health is part of the verdict. Degraded or Missing is a failure that names the
Application. Progressing, or any other health that is not Healthy yet, is
"not yet": check exits non-zero and records nothing, so run it again later.

With --record, each verdict is recorded in the variant's Space as an
attestation of --type on the released revisions: a Pass, or a rejection that
names what is wrong. A "not yet" records nothing.

Use the same --prefix and --stages as apply. It changes nothing on the hub.

  cub kubara check my-platform --hub-context <hub context> --record`,
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := platform.Load(args[0])
			if err != nil {
				return err
			}
			ko.Stages = split(kStages)
			pl, err := plan.Build(p, ko)
			if err != nil {
				return err
			}
			results, err := check.Check(pl, runCommand, co)
			w := c.OutOrStdout()
			printCheck(w, results)
			if err != nil {
				return err
			}
			return checkVerdict(results)
		},
	}
	checkCmd.Flags().StringVar(&ko.Prefix, "prefix", "kubara", "the prefix apply used")
	checkCmd.Flags().StringVar(&kStages, "stages", "", "the stage order apply used")
	checkCmd.Flags().StringVar(&co.HubContext, "hub-context", "", "kubectl context of Kubara's hub; the current context when empty")
	checkCmd.Flags().StringVar(&co.Gateway, "gateway", handover.DefaultGateway, "host ConfigHub serves releases from")
	checkCmd.Flags().BoolVar(&co.Record, "record", false, "record each verdict in ConfigHub as an attestation")
	checkCmd.Flags().StringVar(&co.Type, "type", check.DefaultType, "the attestation type --record uses")

	root.AddCommand(services, initCmd, planCmd, applyCmd, renderCmd, handoverCmd, checkCmd, handbackCmd, routeCmd, pruneCmd, versionCmd)
	return root
}

type initOptions struct {
	out            string
	catalogVersion string
	services       string
	hubs           []string
	spokes         []string
	repository     string
	dnsDomain      string
	email          string
}

// hubArgoRender renders the hub's argo-cd chart the way Kubara's hub delivers
// it, with the hub's own capabilities when a context is given, and discards
// everything else it rendered.
func hubArgoRender(caps map[string]apply.Capabilities) handover.HubRender {
	return func(kubaraDir, cluster string) ([]byte, error) {
		tmp, err := os.MkdirTemp("", "cub-kubara-hub-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		renders, err := apply.NewKubaraRenderer(caps)(kubaraDir, cluster, tmp)
		if err != nil {
			return nil, err
		}
		path, ok := renders["argo-cd"]
		if !ok {
			return nil, fmt.Errorf("rendering produced no argo-cd for the hub %s", cluster)
		}
		return os.ReadFile(path)
	}
}

// clusterRender renders every chart of one cluster the way Kubara's hub
// delivers it from Git, with the cluster's own capabilities when a context is
// given.
func clusterRender(caps map[string]apply.Capabilities) handover.ClusterRender {
	return func(kubaraDir, cluster string) (map[string][]byte, error) {
		tmp, err := os.MkdirTemp("", "cub-kubara-git-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		renders, err := apply.NewKubaraRenderer(caps)(kubaraDir, cluster, tmp)
		if err != nil {
			return nil, err
		}
		out := map[string][]byte{}
		for chart, path := range renders {
			b, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			out[chart] = b
		}
		return out, nil
	}
}

// readCapabilities reads each --capabilities <cluster>=<kubectl context> pair.
func readCapabilities(pairs []string) (map[string]apply.Capabilities, error) {
	caps := map[string]apply.Capabilities{}
	for _, pair := range pairs {
		cluster, ctx, ok := strings.Cut(pair, "=")
		if !ok || cluster == "" || ctx == "" {
			return nil, fmt.Errorf("--capabilities takes <cluster>=<kubectl context>, not %q", pair)
		}
		c, err := apply.ReadCapabilities(ctx)
		if err != nil {
			return nil, err
		}
		caps[cluster] = c
	}
	return caps, nil
}

func (o *initOptions) register(c *cobra.Command) {
	c.Flags().StringVar(&o.out, "out", "", "the directory to write the new platform config into")
	c.Flags().StringVar(&o.catalogVersion, "catalog-version", catalog.DefaultVersion, "the Kubara general catalog version ("+strings.Join(catalog.Known("general"), ", ")+")")
	c.Flags().StringVar(&o.services, "services", "cert-manager,metrics-server,traefik", "the general catalog services to enable, comma-separated")
	c.Flags().StringArrayVar(&o.hubs, "hub", []string{"dev:dev"}, "the hub cluster as <name>[:<stage>]; a Kubara config has exactly one")
	c.Flags().StringArrayVar(&o.spokes, "spoke", nil, "a spoke cluster as <name>[:<stage>]; repeat for more")
	c.Flags().StringVar(&o.repository, "repository", "https://github.com/example/platform.git", "the Git repository Argo CD reads the platform from")
	c.Flags().StringVar(&o.dnsDomain, "dns-domain", "traefik.me", "each cluster's DNS name is <cluster>.<dns-domain>")
	c.Flags().StringVar(&o.email, "email", "platform@example.com", "the ACME contact for cert-manager's issuer")
}

func (o *initOptions) options() (initcfg.Options, error) {
	if o.out == "" {
		return initcfg.Options{}, fmt.Errorf("init needs --out <dir>")
	}
	// A Kubara config has exactly one hub. The flag is repeatable only so that
	// a second --hub is refused, not silently put in place of the first.
	if len(o.hubs) != 1 {
		return initcfg.Options{}, fmt.Errorf("init takes one --hub, and was given %d: %s. A Kubara config has exactly one hub; name each other cluster with --spoke", len(o.hubs), strings.Join(o.hubs, ", "))
	}
	hub, err := parseCluster(o.hubs[0], "hub")
	if err != nil {
		return initcfg.Options{}, err
	}
	clusters := []initcfg.ClusterSpec{hub}
	for _, s := range o.spokes {
		spoke, err := parseCluster(s, "spoke")
		if err != nil {
			return initcfg.Options{}, err
		}
		clusters = append(clusters, spoke)
	}
	return initcfg.Options{
		Out: o.out, CatalogVersion: o.catalogVersion, Services: split(o.services), Clusters: clusters,
		Repository: o.repository, DNSDomain: o.dnsDomain, Email: o.email, PluginVersion: version,
	}, nil
}

// Execute runs the command tree and exits non-zero on failure.
func Execute() {
	err := newRoot().Execute()
	// Renders read the charts from a copy, so that helm leaves the work
	// directory alone; remove the copies before exiting.
	apply.CleanupCharts()
	if err != nil {
		if _, ok := err.(errProblems); !ok {
			fmt.Fprintln(os.Stderr, "error:", err)
		}
		os.Exit(1)
	}
}

// runCommand runs a command and returns its standard output, with its
// standard error in the error when it fails.
func runCommand(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}
