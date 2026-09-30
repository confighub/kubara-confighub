// Package initcfg writes a new Kubara platform config: Kubara's own
// config.yaml, an .env.example holding no secret, a record of which catalogs
// and chart versions were chosen and what the Workshop Catalog says about
// each, and a .gitignore that keeps .env and fetched charts out of Git. It
// generates nothing; Kubara does that.
package initcfg

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/catalog"
)

type ClusterSpec struct {
	Name  string
	Stage string
	Type  string // hub or spoke
}

type Options struct {
	Out            string
	CatalogVersion string
	Services       []string
	Clusters       []ClusterSpec
	Repository     string
	DNSDomain      string
	Email          string
	PluginVersion  string
}

type Result struct {
	Files     []string
	Skipped   []string // services a cluster type cannot run, by cluster
	GitIgnore string   // what init did to .gitignore, in a sentence
}

// GitIgnoreLines are the lines init makes sure .gitignore holds. .env holds
// the Argo CD password and a Git token. Helm writes the other three when it
// fetches a wrapper chart's dependencies. Kubara's own init --prep ignores
// all four.
var GitIgnoreLines = []string{".env", "**/charts/", "**/Chart.lock", "**/*.tgz"}

type config struct {
	Version          string    `yaml:"version"`
	BootstrapCatalog string    `yaml:"bootstrapCatalog"`
	Clusters         []cluster `yaml:"clusters"`
}

type cluster struct {
	Name             string             `yaml:"name"`
	Stage            string             `yaml:"stage"`
	Type             string             `yaml:"type"`
	DNSName          string             `yaml:"dnsName"`
	SSOOrg           string             `yaml:"ssoOrg"`
	SSOTeam          string             `yaml:"ssoTeam"`
	IngressClassName string             `yaml:"ingressClassName"`
	ArgoCD           argocd             `yaml:"argocd"`
	Catalogs         []string           `yaml:"catalogs"`
	Services         map[string]service `yaml:"services"`
}

type argocd struct {
	SelfManaged string `yaml:"selfManaged"`
	Repo        struct {
		HTTPS struct {
			Configs    gitRef `yaml:"configs"`
			Components gitRef `yaml:"components"`
		} `yaml:"https"`
	} `yaml:"repo"`
}

type gitRef struct {
	URL            string `yaml:"url"`
	TargetRevision string `yaml:"targetRevision"`
}

type service struct {
	Status string         `yaml:"status"`
	Config map[string]any `yaml:"config,omitempty"`
}

// Write creates the files. It refuses to overwrite an existing config.yaml.
func Write(opts Options) (Result, error) {
	var res Result
	boot, general, err := catalog.Pair(opts.CatalogVersion)
	if err != nil {
		return res, err
	}
	workshop, err := catalog.LoadWorkshop()
	if err != nil {
		return res, err
	}
	if len(opts.Clusters) == 0 {
		return res, fmt.Errorf("name at least one cluster")
	}
	hubs := 0
	for _, c := range opts.Clusters {
		if c.Type == "hub" {
			hubs++
		}
	}
	if hubs != 1 {
		return res, fmt.Errorf("a Kubara config has exactly one hub; this has %d", hubs)
	}
	chosen := map[string]bool{}
	for _, name := range opts.Services {
		if _, ok := general.Service(name); !ok {
			var names []string
			for _, s := range general.Services {
				names = append(names, s.Name)
			}
			return res, fmt.Errorf("general catalog %s has no service %q; it has %s", general.Version, name, strings.Join(names, ", "))
		}
		chosen[name] = true
	}
	if err := os.MkdirAll(opts.Out, 0o755); err != nil {
		return res, err
	}
	configPath := filepath.Join(opts.Out, "config.yaml")
	if _, err := os.Stat(configPath); err == nil {
		return res, fmt.Errorf("%s already exists; cub kubara init writes a new platform and does not overwrite one", configPath)
	}

	cfg := config{Version: "v1alpha4", BootstrapCatalog: boot.OCI}
	for _, spec := range opts.Clusters {
		cl := cluster{
			Name: spec.Name, Stage: spec.Stage, Type: spec.Type,
			DNSName: spec.Name + "." + opts.DNSDomain, SSOOrg: "none", SSOTeam: "none", IngressClassName: "traefik",
			Catalogs: []string{general.OCI},
			Services: map[string]service{},
		}
		// Kubara's hub-and-spoke: the hub's Argo CD manages itself and delivers
		// to the spokes, so a spoke runs no Argo CD of its own.
		cl.ArgoCD.SelfManaged = "disabled"
		if spec.Type == "hub" {
			cl.ArgoCD.SelfManaged = "enabled"
		}
		cl.ArgoCD.Repo.HTTPS.Configs = gitRef{URL: opts.Repository, TargetRevision: "main"}
		cl.ArgoCD.Repo.HTTPS.Components = gitRef{URL: opts.Repository, TargetRevision: "main"}
		for _, svc := range general.Services {
			status := "disabled"
			if chosen[svc.Name] {
				if typeAllowed(svc, spec.Type) {
					status = "enabled"
				} else {
					res.Skipped = append(res.Skipped, fmt.Sprintf("%s on %s (a %s; it runs only on %s)", svc.Name, spec.Name, spec.Type, strings.Join(svc.ClusterTypes, " or ")))
				}
			}
			s := service{Status: status}
			if svc.Name == "cert-manager" && status == "enabled" {
				s.Config = map[string]any{"clusterIssuer": map[string]any{
					"email":  opts.Email,
					"name":   "letsencrypt-staging",
					"server": "https://acme-staging-v02.api.letsencrypt.org/directory",
				}}
			}
			cl.Services[svc.Name] = s
		}
		cfg.Clusters = append(cfg.Clusters, cl)
	}
	if err := writeYAML(configPath, cfg); err != nil {
		return res, err
	}
	res.Files = append(res.Files, configPath)

	hub := opts.Clusters[0]
	for _, c := range opts.Clusters {
		if c.Type == "hub" {
			hub = c
		}
	}
	env := strings.Join([]string{
		"PROJECT_NAME=" + hub.Name,
		"PROJECT_STAGE=" + hub.Stage,
		"ARGOCD_WIZARD_ACCOUNT_PASSWORD=replace-before-use",
		"ARGOCD_GIT_HTTPS_URL=" + opts.Repository,
		"ARGOCD_GIT_USERNAME=",
		"ARGOCD_GIT_PAT_OR_PASSWORD=",
		"ARGOCD_HELM_REPO_USERNAME=",
		"ARGOCD_HELM_REPO_PASSWORD=",
		"ARGOCD_HELM_REPO_URL=",
		"DOCKERCONFIG_BASE64=",
	}, "\n") + "\n"
	envPath := filepath.Join(opts.Out, ".env.example")
	if err := os.WriteFile(envPath, []byte(env), 0o644); err != nil {
		return res, err
	}
	res.Files = append(res.Files, envPath)

	intentPath := filepath.Join(opts.Out, "confighub-intent.yaml")
	if err := writeYAML(intentPath, intent(opts, boot, general, workshop, chosen)); err != nil {
		return res, err
	}
	res.Files = append(res.Files, intentPath)

	if res.GitIgnore, err = writeGitIgnore(filepath.Join(opts.Out, ".gitignore")); err != nil {
		return res, err
	}
	return res, nil
}

// writeGitIgnore writes .gitignore, or adds the lines it lacks to an existing
// one. It never removes or changes a line.
func writeGitIgnore(path string) (string, error) {
	old, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		body := "# Written by cub kubara init. .env holds the Argo CD password and a Git token.\n" +
			"# Helm writes the rest when it fetches a chart's dependencies.\n" +
			strings.Join(GitIgnoreLines, "\n") + "\n"
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			return "", err
		}
		return fmt.Sprintf("wrote %s, which keeps %s out of Git", path, strings.Join(GitIgnoreLines, ", ")), nil
	}
	if err != nil {
		return "", err
	}
	have := map[string]bool{}
	for _, l := range strings.Split(string(old), "\n") {
		have[strings.TrimSpace(l)] = true
	}
	var missing []string
	for _, l := range GitIgnoreLines {
		if !have[l] {
			missing = append(missing, l)
		}
	}
	if len(missing) == 0 {
		return fmt.Sprintf("left %s as it was; it already keeps %s out of Git", path, strings.Join(GitIgnoreLines, ", ")), nil
	}
	body := string(old)
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	body += "# Added by cub kubara init\n" + strings.Join(missing, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("added %s to %s", strings.Join(missing, ", "), path), nil
}

type intentDoc struct {
	APIVersion string     `yaml:"apiVersion"`
	Kind       string     `yaml:"kind"`
	Spec       intentSpec `yaml:"spec"`
}

type intentSpec struct {
	WrittenBy string          `yaml:"writtenBy"`
	Catalogs  []string        `yaml:"catalogs"`
	Workshop  string          `yaml:"workshopCatalog"`
	Clusters  []intentCluster `yaml:"clusters"`
	Services  []intentService `yaml:"services"`
	Boundary  string          `yaml:"boundary"`
}

type intentCluster struct {
	Name  string `yaml:"name"`
	Stage string `yaml:"stage"`
	Type  string `yaml:"type"`
}

type intentService struct {
	Name   string        `yaml:"name"`
	Charts []intentChart `yaml:"charts"`
}

type intentChart struct {
	Chart      string `yaml:"chart"`
	Version    string `yaml:"version"`
	Repository string `yaml:"repository"`
	Workshop   string `yaml:"workshop"`
	Page       string `yaml:"page,omitempty"`
}

func intent(opts Options, boot, general catalog.Catalog, w catalog.Workshop, chosen map[string]bool) intentDoc {
	doc := intentDoc{APIVersion: "workshop.confighub.com/v1alpha1", Kind: "KubaraPlatformIntent"}
	doc.Spec.WrittenBy = "cub kubara init " + opts.PluginVersion
	doc.Spec.Catalogs = []string{boot.OCI, general.OCI}
	doc.Spec.Workshop = w.Source.Repository + "@" + w.Source.Commit
	for _, c := range opts.Clusters {
		doc.Spec.Clusters = append(doc.Spec.Clusters, intentCluster{Name: c.Name, Stage: c.Stage, Type: c.Type})
	}
	names := make([]string, 0, len(chosen))
	for n := range chosen {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, s := range boot.Services {
		names = append([]string{s.Name}, names...)
	}
	for _, n := range names {
		svc, ok := general.Service(n)
		if !ok {
			svc, _ = boot.Service(n)
		}
		is := intentService{Name: n}
		for _, u := range svc.Upstream {
			ev := w.Match(u)
			ic := intentChart{Chart: u.Name, Version: u.Version, Repository: u.Repository, Workshop: ev.Status}
			if ev.Status == "checked" {
				ic.Page = ev.Chart.Page
			}
			is.Charts = append(is.Charts, ic)
		}
		doc.Spec.Services = append(doc.Spec.Services, is)
	}
	doc.Spec.Boundary = "A record of what was chosen. It does not claim that Kubara has generated or anything has been deployed. Kubara's catalogs are the source of every chart; Workshop evidence annotates a chart only at the exact version."
	return doc
}

func typeAllowed(svc catalog.Service, t string) bool {
	if len(svc.ClusterTypes) == 0 {
		return true
	}
	for _, x := range svc.ClusterTypes {
		if x == t {
			return true
		}
	}
	return false
}

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append([]byte("---\n"), b...), 0o644)
}
