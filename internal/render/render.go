// Package render writes a generated Kubara platform as Kubara delivers it:
// each service, for each cluster that runs it, rendered the way Kubara's hub
// ApplicationSets deliver it, and a manifest, render.json, that says what was
// rendered and how. It uses the same renderer as apply. It contacts no cluster
// and no ConfigHub server.
//
// The layout under the output directory:
//
//	render.json                         the manifest (Manifest)
//	<cluster>/<service>/objects.yaml    the objects, as one multi-document YAML file
package render

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/apply"
	"github.com/confighub/kubara-confighub/internal/platform"
)

// APIVersion and Kind name the manifest's format. A change that could break
// a reader gets a new APIVersion.
const (
	APIVersion   = "kubara.confighub.com/v1alpha1"
	Kind         = "KubaraRender"
	ManifestFile = "render.json"
	ObjectsFile  = "objects.yaml"
)

// Manifest is render.json: every cluster rendered, and every service on it.
type Manifest struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	// Generator is the command and version that wrote it.
	Generator string `json:"generator"`
	Source    Source `json:"source"`
	// SecretValues is "emptied" when each Secret keeps its keys and loses its
	// values, and "kept" with --keep-secret-values.
	SecretValues string    `json:"secretValues"`
	Clusters     []Cluster `json:"clusters"`
}

// Source is the Kubara work directory that was rendered.
type Source struct {
	WorkDir          string `json:"workDir"`          // as given on the command line
	ConfigSHA256     string `json:"configSha256"`     // of config.yaml, as sha256:<hex>
	BootstrapCatalog string `json:"bootstrapCatalog"` // config.yaml's bootstrapCatalog
}

// Cluster is one cluster from config.yaml and what it runs.
type Cluster struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // hub or spoke
	Stage string `json:"stage"`
	// Catalogs are the catalogs config.yaml has the cluster read.
	Catalogs []string `json:"catalogs"`
	// Enabled are the services config.yaml enables on the cluster, sorted.
	Enabled []string `json:"enabled"`
	// Services are rendered in this order: bootstrap-crds, then argo-cd on the
	// hub, then each enabled service. A chart is told of the APIs whose CRDs
	// the services before it provide.
	Services []Service `json:"services"`
	// Shared lists each object more than one service renders, and which one
	// owns it.
	Shared []Shared `json:"shared"`
}

// Service is one service rendered for one cluster.
type Service struct {
	Name      string `json:"name"`      // the chart directory under platform-components/helm
	Release   string `json:"release"`   // the release name its Application uses
	Namespace string `json:"namespace"` // the release namespace
	// Delivery is "applicationset" for a service Kubara's hub delivers, and
	// "bootstrap" for bootstrap-crds, which kubara bootstrap applies as CRDs only.
	Delivery string     `json:"delivery"`
	Chart    Chart      `json:"chart"`
	Upstream []Upstream `json:"upstream"`
	// ValuesFiles are passed to helm in this order, after the chart's own
	// values.yaml, relative to the work directory.
	ValuesFiles []string `json:"valuesFiles"`
	// APIVersions are passed to helm as --api-versions.
	APIVersions []string `json:"apiVersions"`
	// File holds the objects, relative to the output directory.
	File    string `json:"file"`
	Objects int    `json:"objects"`
	// LeftOut counts objects the chart renders that kubara bootstrap does not
	// apply; only bootstrap-crds leaves any out.
	LeftOut int `json:"leftOut"`
	// SHA256 is the digest of File's bytes, as sha256:<hex>.
	SHA256 string `json:"sha256"`
	// Secrets names each Secret written with its keys and without its values.
	Secrets []string `json:"secrets"`
}

// Chart is the wrapper chart Kubara generated for a service.
type Chart struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Path    string `json:"path"` // relative to the work directory
}

// Upstream is a chart the wrapper chart depends on, as its Chart.yaml pins it.
type Upstream struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	Repository string `json:"repository"`
}

// Shared is an object more than one service on a cluster renders. Kubara
// delivers some CRDs twice: kubara bootstrap applies them from bootstrap-crds,
// and a chart renders them again. bootstrap-crds owns those. Owner is empty
// when no rule decides, as when two ApplicationSet services render the same
// object.
type Shared struct {
	// Object is apiVersion|kind|namespace|name, as the rendered document says.
	Object   string   `json:"object"`
	Services []string `json:"services"` // in render order
	Owner    string   `json:"owner"`
}

// Options says what to render and where.
type Options struct {
	WorkDir          string
	Out              string
	Clusters         []string // empty renders every cluster in config.yaml
	KeepSecretValues bool
	Generator        string
}

// Write renders the platform into opts.Out and writes render.json. When it
// fails part way, it removes what it wrote, so no render.json describes a
// partial render.
func Write(opts Options) (m Manifest, err error) {
	m = Manifest{APIVersion: APIVersion, Kind: Kind, Generator: opts.Generator, SecretValues: "emptied"}
	if opts.KeepSecretValues {
		m.SecretValues = "kept"
	}
	p, err := platform.Load(opts.WorkDir)
	if err != nil {
		return m, err
	}
	if _, err := os.Stat(filepath.Join(p.Dir, "platform-components", "helm")); err != nil {
		return m, fmt.Errorf("%s has no platform-components/helm; run kubara ... generate --helm first", opts.WorkDir)
	}
	cfg, err := os.ReadFile(filepath.Join(p.Dir, "config.yaml"))
	if err != nil {
		return m, err
	}
	m.Source = Source{WorkDir: opts.WorkDir, ConfigSHA256: digest(cfg), BootstrapCatalog: p.Config.BootstrapCatalog}

	clusters, err := selectClusters(p.Config.Clusters, opts.Clusters)
	if err != nil {
		return m, err
	}
	if err := clearOut(opts.Out); err != nil {
		return m, err
	}
	defer func() {
		if err != nil {
			for _, cl := range clusters {
				os.RemoveAll(filepath.Join(opts.Out, cl.Name))
			}
		}
	}()
	for _, cl := range clusters {
		c := Cluster{Name: cl.Name, Type: cl.Type, Stage: cl.Stage, Catalogs: nonNil(cl.Catalogs), Enabled: nonNil(cl.Enabled())}
		renders, err := apply.RenderCluster(p.Dir, cl.Name, apply.Capabilities{})
		if err != nil {
			return m, fmt.Errorf("cluster %s: %w", cl.Name, err)
		}
		owners := map[string][]string{}
		var order []string
		for _, r := range renders {
			svc, ids, err := write(p, opts, cl.Name, r)
			if err != nil {
				return m, err
			}
			c.Services = append(c.Services, svc)
			for _, id := range ids {
				if len(owners[id]) == 0 {
					order = append(order, id)
				}
				if !contains(owners[id], svc.Name) {
					owners[id] = append(owners[id], svc.Name)
				}
			}
		}
		c.Shared = []Shared{}
		for _, id := range order {
			if svcs := owners[id]; len(svcs) > 1 {
				owner := ""
				if contains(svcs, "bootstrap-crds") {
					owner = "bootstrap-crds"
				}
				c.Shared = append(c.Shared, Shared{Object: id, Services: svcs, Owner: owner})
			}
		}
		m.Clusters = append(m.Clusters, c)
	}
	b, err := Marshal(m)
	if err != nil {
		return m, err
	}
	return m, os.WriteFile(filepath.Join(opts.Out, ManifestFile), b, 0o644)
}

// Marshal is render.json's exact bytes.
func Marshal(m Manifest) ([]byte, error) {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// write writes one service's objects and describes them, returning the
// identity of each object.
func write(p platform.Platform, opts Options, cluster string, r apply.ServiceRender) (Service, []string, error) {
	svc := Service{Name: r.Chart, Release: r.Release, Namespace: r.Namespace, Delivery: "applicationset",
		Upstream: []Upstream{}, ValuesFiles: []string{}, APIVersions: nonNil(r.APIVersions),
		Objects: len(r.Docs), LeftOut: r.LeftOut, Secrets: []string{}}
	if r.ByBootstrap {
		svc.Delivery = "bootstrap"
	}
	chartDir := filepath.Join(p.Dir, "platform-components", "helm", r.Chart)
	svc.Chart = Chart{Path: rel(p.Dir, chartDir)}
	if b, err := os.ReadFile(filepath.Join(chartDir, "Chart.yaml")); err == nil {
		var c struct {
			Name    string `yaml:"name"`
			Version string `yaml:"version"`
		}
		if yaml.Unmarshal(b, &c) == nil {
			svc.Chart.Name, svc.Chart.Version = c.Name, c.Version
		}
	}
	for _, u := range p.Generated[r.Chart] {
		v := u.RawVersion
		if v == "" {
			v = u.Version
		}
		svc.Upstream = append(svc.Upstream, Upstream{Name: u.Name, Version: v, Repository: u.Repository})
	}
	for _, f := range r.ValuesFiles {
		svc.ValuesFiles = append(svc.ValuesFiles, rel(p.Dir, f))
	}
	var ids []string
	for _, d := range r.Docs {
		if id := identity(d); id != "" {
			ids = append(ids, id)
		}
	}
	body := []byte(strings.Join(r.Docs, "---\n"))
	if !opts.KeepSecretValues {
		var names []string
		var err error
		body, names, err = apply.WithoutSecretValues(body)
		if err != nil {
			return svc, nil, fmt.Errorf("%s on %s: %w", r.Chart, cluster, err)
		}
		svc.Secrets = nonNil(names)
	}
	svc.File = cluster + "/" + r.Chart + "/" + ObjectsFile
	path := filepath.Join(opts.Out, cluster, r.Chart, ObjectsFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return svc, nil, err
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return svc, nil, err
	}
	svc.SHA256 = digest(body)
	return svc, ids, nil
}

// identity is apiVersion|kind|namespace|name, the key cub-workshop's stacks use.
func identity(doc string) string {
	var o struct {
		APIVersion string `yaml:"apiVersion"`
		Kind       string `yaml:"kind"`
		Metadata   struct {
			Name      string `yaml:"name"`
			Namespace string `yaml:"namespace"`
		} `yaml:"metadata"`
	}
	if yaml.Unmarshal([]byte(doc), &o) != nil || o.Kind == "" || o.Metadata.Name == "" {
		return ""
	}
	return strings.Join([]string{o.APIVersion, o.Kind, o.Metadata.Namespace, o.Metadata.Name}, "|")
}

func selectClusters(all []platform.Cluster, names []string) ([]platform.Cluster, error) {
	if len(names) == 0 {
		return all, nil
	}
	var known []string
	byName := map[string]platform.Cluster{}
	for _, cl := range all {
		known = append(known, cl.Name)
		byName[cl.Name] = cl
	}
	var out []platform.Cluster
	for _, n := range names {
		cl, ok := byName[n]
		if !ok {
			return nil, fmt.Errorf("config.yaml has no cluster %s; it names %s", n, strings.Join(known, ", "))
		}
		out = append(out, cl)
	}
	return out, nil
}

// clearOut makes the output directory ready. It creates it, or replaces an
// earlier render there, and refuses a directory that holds anything else.
func clearOut(out string) error {
	entries, err := os.ReadDir(out)
	if errors.Is(err, os.ErrNotExist) {
		return os.MkdirAll(out, 0o755)
	}
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(out, ManifestFile))
	if err != nil {
		return fmt.Errorf("%s is not empty and holds no earlier render; choose a new directory", out)
	}
	var old Manifest
	if err := json.Unmarshal(b, &old); err != nil || old.Kind != Kind {
		return fmt.Errorf("%s holds a %s that cub kubara render did not write; choose a new directory", out, ManifestFile)
	}
	for _, cl := range old.Clusters {
		if cl.Name == "" || strings.ContainsAny(cl.Name, `/\`) || cl.Name == "." || cl.Name == ".." {
			continue
		}
		if err := os.RemoveAll(filepath.Join(out, cl.Name)); err != nil {
			return err
		}
	}
	return os.Remove(filepath.Join(out, ManifestFile))
}

func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func rel(base, path string) string {
	if r, err := filepath.Rel(base, path); err == nil {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
