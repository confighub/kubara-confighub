// Package cmd is the `cub kubara` command tree.
package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/confighub/kubara-confighub/internal/catalog"
	"github.com/confighub/kubara-confighub/internal/initcfg"
	"github.com/confighub/kubara-confighub/internal/plan"
	"github.com/confighub/kubara-confighub/internal/platform"
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
            a Target per cluster, and the stage order. Offline; changes nothing.

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

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print the plugin version",
		Args:  cobra.NoArgs,
		Run: func(c *cobra.Command, _ []string) {
			fmt.Fprintf(c.OutOrStdout(), "cub kubara %s (commit %s, built %s)\n", version, commit, date)
		},
	}

	root.AddCommand(services, initCmd, planCmd, versionCmd)
	return root
}

type initOptions struct {
	out            string
	catalogVersion string
	services       string
	hub            string
	spokes         []string
	repository     string
	dnsDomain      string
	email          string
}

func (o *initOptions) register(c *cobra.Command) {
	c.Flags().StringVar(&o.out, "out", "", "the directory to write the new platform config into")
	c.Flags().StringVar(&o.catalogVersion, "catalog-version", catalog.DefaultVersion, "the Kubara general catalog version ("+strings.Join(catalog.Known("general"), ", ")+")")
	c.Flags().StringVar(&o.services, "services", "cert-manager,metrics-server,traefik", "the general catalog services to enable, comma-separated")
	c.Flags().StringVar(&o.hub, "hub", "dev:dev", "the hub cluster as <name>[:<stage>]")
	c.Flags().StringArrayVar(&o.spokes, "spoke", nil, "a spoke cluster as <name>[:<stage>]; repeat for more")
	c.Flags().StringVar(&o.repository, "repository", "https://github.com/example/platform.git", "the Git repository Argo CD reads the platform from")
	c.Flags().StringVar(&o.dnsDomain, "dns-domain", "traefik.me", "each cluster's DNS name is <cluster>.<dns-domain>")
	c.Flags().StringVar(&o.email, "email", "platform@example.com", "the ACME contact for cert-manager's issuer")
}

func (o *initOptions) options() (initcfg.Options, error) {
	if o.out == "" {
		return initcfg.Options{}, fmt.Errorf("init needs --out <dir>")
	}
	hub, err := parseCluster(o.hub, "hub")
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
	if err := newRoot().Execute(); err != nil {
		if _, ok := err.(errProblems); !ok {
			fmt.Fprintln(os.Stderr, "error:", err)
		}
		os.Exit(1)
	}
}
