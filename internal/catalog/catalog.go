// Package catalog holds what cub kubara knows offline: the services in each
// Kubara catalog release, and the Helm charts the ConfigHub Workshop Catalog
// has checked. Kubara's catalogs are the source of every component. Workshop
// evidence only annotates a component when the exact chart version matches;
// it never substitutes a different chart.
package catalog

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

//go:embed data/*.json
var dataFS embed.FS

// Catalog is one Kubara catalog release, such as general 3.0.0.
type Catalog struct {
	Name     string    `json:"name"`
	Version  string    `json:"version"`
	Tag      string    `json:"tag"`
	OCI      string    `json:"oci"`
	Source   string    `json:"source"`
	Services []Service `json:"services"`
}

// Service is one Kubara ServiceDefinition and the upstream chart its wrapper
// chart pins.
type Service struct {
	Name           string   `json:"name"`
	Category       string   `json:"category,omitempty"`
	ChartPath      string   `json:"chartPath"`
	Default        string   `json:"default"`
	ClusterTypes   []string `json:"clusterTypes"`
	WrapperVersion string   `json:"wrapperVersion,omitempty"`
	Upstream       []Chart  `json:"upstream,omitempty"`
}

// Chart is an upstream Helm chart a Kubara wrapper chart depends on.
type Chart struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	RawVersion string `json:"rawVersion,omitempty"`
	Repository string `json:"repository"`
}

// Workshop is the Workshop Catalog's checked Helm charts, at one helm-expt commit.
type Workshop struct {
	Source WorkshopSource  `json:"source"`
	Charts []WorkshopChart `json:"charts"`
}

type WorkshopSource struct {
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
	Site       string `json:"site"`
}

type WorkshopChart struct {
	Name       string         `json:"name"`
	Chart      string         `json:"chart"`
	Version    string         `json:"version"`
	Repository string         `json:"repository"`
	Page       string         `json:"page"`
	Bases      []WorkshopBase `json:"bases"`
}

type WorkshopBase struct {
	Name    string `json:"name"`
	Verdict string `json:"verdict"`
	Objects int    `json:"objects"`
	Listing string `json:"listing"`
}

// DefaultVersion is the catalog version cub kubara uses when none is given:
// the default of the Kubara release it targets.
const DefaultVersion = "3.0.0"

var ociRef = regexp.MustCompile(`^oci://ghcr\.io/kubara-io/catalogs/([a-z0-9-]+):v?([0-9A-Za-z.\-]+)$`)

// ParseRef reads a Kubara catalog reference such as
// oci://ghcr.io/kubara-io/catalogs/general:3.0.0.
func ParseRef(ref string) (name, version string, ok bool) {
	m := ociRef.FindStringSubmatch(strings.TrimSpace(ref))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// Ref is the OCI reference Kubara reads for a catalog release.
func Ref(name, version string) string {
	return fmt.Sprintf("oci://ghcr.io/kubara-io/catalogs/%s:%s", name, version)
}

// Load returns an embedded catalog release.
func Load(name, version string) (Catalog, error) {
	var c Catalog
	b, err := dataFS.ReadFile(fmt.Sprintf("data/kubara-%s-%s.json", name, version))
	if err != nil {
		return c, fmt.Errorf("catalog %s %s is not in this version of cub kubara (it knows %s)", name, version, strings.Join(Known(name), ", "))
	}
	return c, json.Unmarshal(b, &c)
}

// Known lists the embedded versions of a catalog.
func Known(name string) []string {
	var out []string
	entries, _ := fs.ReadDir(dataFS, "data")
	for _, e := range entries {
		base := strings.TrimSuffix(e.Name(), ".json")
		if v, ok := strings.CutPrefix(base, "kubara-"+name+"-"); ok {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return versionLess(out[i], out[j]) })
	return out
}

// Pair returns the bootstrap and general catalogs at one version. Kubara
// releases them together, except that a bootstrap release can lag its general
// release by a patch; the newest bootstrap at or below the version is used.
func Pair(version string) (Catalog, Catalog, error) {
	general, err := Load("general", version)
	if err != nil {
		return Catalog{}, Catalog{}, err
	}
	bootVersion := ""
	for _, v := range Known("bootstrap") {
		if sameMajor(v, version) && !versionLess(version, v) {
			bootVersion = v
		}
	}
	if bootVersion == "" {
		return Catalog{}, Catalog{}, fmt.Errorf("no bootstrap catalog pairs with general %s (known: %s)", version, strings.Join(Known("bootstrap"), ", "))
	}
	boot, err := Load("bootstrap", bootVersion)
	return boot, general, err
}

// LoadWorkshop returns the embedded Workshop evidence.
func LoadWorkshop() (Workshop, error) {
	var w Workshop
	b, err := dataFS.ReadFile("data/workshop-helm.json")
	if err != nil {
		return w, err
	}
	return w, json.Unmarshal(b, &w)
}

// Service looks a service up by name.
func (c Catalog) Service(name string) (Service, bool) {
	for _, s := range c.Services {
		if s.Name == name {
			return s, true
		}
	}
	return Service{}, false
}

// Evidence is what the Workshop Catalog says about one upstream chart.
type Evidence struct {
	Status string // checked, other-repository, other-version, unchecked
	Chart  *WorkshopChart
	// Versions the Workshop has checked for the same chart, when not this one.
	OtherVersions []string
}

// Match finds Workshop evidence for an upstream chart. Only the same chart at
// the same version from the same repository counts as checked. The same chart
// and version from another repository is reported, not claimed.
func (w Workshop) Match(c Chart) Evidence {
	var others []string
	var sameVersionOtherRepo *WorkshopChart
	for i := range w.Charts {
		wc := &w.Charts[i]
		if wc.Chart != c.Name {
			continue
		}
		if wc.Version != c.Version {
			if sameRepo(wc.Repository, c.Repository) {
				others = append(others, wc.Version)
			}
			continue
		}
		if sameRepo(wc.Repository, c.Repository) {
			return Evidence{Status: "checked", Chart: wc}
		}
		sameVersionOtherRepo = wc
	}
	if sameVersionOtherRepo != nil {
		return Evidence{Status: "other-repository", Chart: sameVersionOtherRepo}
	}
	if len(others) > 0 {
		sort.Slice(others, func(i, j int) bool { return versionLess(others[i], others[j]) })
		return Evidence{Status: "other-version", OtherVersions: others}
	}
	return Evidence{Status: "unchecked"}
}

func sameRepo(a, b string) bool {
	norm := func(s string) string {
		s = strings.TrimSuffix(strings.TrimSpace(s), "/")
		s = strings.TrimPrefix(s, "oci://")
		s = strings.TrimPrefix(s, "https://")
		return s
	}
	return a != "" && norm(a) == norm(b)
}

func sameMajor(a, b string) bool {
	return strings.SplitN(a, ".", 2)[0] == strings.SplitN(b, ".", 2)[0]
}

func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		var x, y int
		fmt.Sscanf(pa[i], "%d", &x)
		fmt.Sscanf(pb[i], "%d", &y)
		if x != y {
			return x < y
		}
	}
	return len(pa) < len(pb)
}
