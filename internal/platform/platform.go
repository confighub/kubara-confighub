// Package platform reads a Kubara platform: its config.yaml, and, when Kubara
// has generated it, the exact chart versions it wrote.
package platform

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/catalog"
)

// Config is the part of Kubara's config.yaml (v1alpha4) that cub kubara reads.
type Config struct {
	Version          string    `yaml:"version"`
	BootstrapCatalog string    `yaml:"bootstrapCatalog"`
	Clusters         []Cluster `yaml:"clusters"`
}

type Cluster struct {
	Name     string                   `yaml:"name"`
	Stage    string                   `yaml:"stage"`
	Type     string                   `yaml:"type"`
	DNSName  string                   `yaml:"dnsName"`
	Catalogs []string                 `yaml:"catalogs"`
	Services map[string]ServiceConfig `yaml:"services"`
}

type ServiceConfig struct {
	Status string `yaml:"status"`
}

// Enabled lists the services a cluster turns on, sorted.
func (c Cluster) Enabled() []string {
	var out []string
	for name, svc := range c.Services {
		if svc.Status == "enabled" {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// Platform is a config plus what Kubara generated from it, when present.
type Platform struct {
	Dir    string
	Config Config
	// Generated maps a chart directory under platform-components/helm to the
	// upstream charts its Chart.yaml pins, when Kubara has generated the platform.
	Generated map[string][]catalog.Chart
}

// Load reads a Kubara work directory or a config.yaml.
func Load(path string) (Platform, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Platform{}, err
	}
	p := Platform{Dir: path}
	configPath := path
	if info.IsDir() {
		configPath = filepath.Join(path, "config.yaml")
	} else {
		p.Dir = filepath.Dir(path)
	}
	b, err := os.ReadFile(configPath)
	if err != nil {
		return p, fmt.Errorf("no Kubara config: %w", err)
	}
	if err := yaml.Unmarshal(b, &p.Config); err != nil {
		return p, fmt.Errorf("%s: %w", configPath, err)
	}
	if len(p.Config.Clusters) == 0 {
		return p, fmt.Errorf("%s names no clusters; is it a Kubara config.yaml?", configPath)
	}
	p.Generated = readGenerated(filepath.Join(p.Dir, "platform-components", "helm"))
	return p, nil
}

func readGenerated(dir string) map[string][]catalog.Chart {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := map[string][]catalog.Chart{}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "template-library" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name(), "Chart.yaml"))
		if err != nil {
			continue
		}
		var chart struct {
			Dependencies []struct {
				Name       string `yaml:"name"`
				Version    string `yaml:"version"`
				Repository string `yaml:"repository"`
			} `yaml:"dependencies"`
		}
		if yaml.Unmarshal(b, &chart) != nil {
			continue
		}
		var deps []catalog.Chart
		for _, d := range chart.Dependencies {
			if d.Name == "template-library" || strings.HasPrefix(d.Repository, "file://") {
				continue
			}
			deps = append(deps, catalog.Chart{Name: d.Name, Version: strings.TrimPrefix(d.Version, "v"), RawVersion: d.Version, Repository: d.Repository})
		}
		out[e.Name()] = deps
	}
	return out
}

// CatalogVersion is the general catalog version the config reads, and whether
// every cluster agrees on it.
func (c Config) CatalogVersion() (string, []string) {
	var problems []string
	seen := map[string]bool{}
	for _, cl := range c.Clusters {
		for _, ref := range cl.Catalogs {
			name, version, ok := catalog.ParseRef(ref)
			if !ok {
				problems = append(problems, fmt.Sprintf("cluster %s reads a catalog cub kubara does not recognise: %s", cl.Name, ref))
				continue
			}
			if name == "general" {
				seen[version] = true
			}
		}
	}
	var versions []string
	for v := range seen {
		versions = append(versions, v)
	}
	sort.Strings(versions)
	switch len(versions) {
	case 0:
		return "", append(problems, "no cluster reads Kubara's general catalog")
	case 1:
		return versions[0], problems
	default:
		return versions[len(versions)-1], append(problems, fmt.Sprintf("clusters read different general catalog versions (%s); plan uses %s", strings.Join(versions, ", "), versions[len(versions)-1]))
	}
}
