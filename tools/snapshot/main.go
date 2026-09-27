// Command snapshot refreshes the data cub kubara embeds, so the plugin answers
// offline:
//
//	go run ./tools/snapshot -helm-expt ../helm-expt
//
// It records, for each Kubara catalog release named in -tags, every service
// definition and the upstream chart its wrapper chart pins, read from
// github.com/kubara-io/catalogs at that tag. It also records the Helm charts
// the ConfigHub Workshop Catalog has checked, read from a helm-expt checkout,
// with the commit they came from. Run it when Kubara or the Workshop releases,
// review the diff, and commit it.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/catalog"
)

const catalogsRepo = "kubara-io/catalogs"

func main() {
	tags := flag.String("tags", "bootstrap-1.1.0,general-1.1.0,bootstrap-v3.0.0,general-v3.0.0,bootstrap-v5.0.1,general-v5.1.0", "catalog release tags to snapshot")
	helmExpt := flag.String("helm-expt", "", "path to a checkout of github.com/confighub/helm-expt")
	out := flag.String("out", "internal/catalog/data", "where to write the snapshot")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail(err)
	}
	for _, tag := range strings.Split(*tags, ",") {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		snap, err := snapshotCatalog(tag)
		if err != nil {
			fail(fmt.Errorf("%s: %w", tag, err))
		}
		writeJSON(filepath.Join(*out, fmt.Sprintf("kubara-%s-%s.json", snap.Name, snap.Version)), snap)
		fmt.Printf("%s: %d services\n", tag, len(snap.Services))
	}
	if *helmExpt != "" {
		ev, err := snapshotWorkshop(*helmExpt)
		if err != nil {
			fail(err)
		}
		writeJSON(filepath.Join(*out, "workshop-helm.json"), ev)
		fmt.Printf("workshop: %d checked Helm chart versions at %s\n", len(ev.Charts), ev.Source.Commit[:9])
	}
}

func snapshotCatalog(tag string) (catalog.Catalog, error) {
	name, _, ok := strings.Cut(tag, "-")
	if !ok {
		return catalog.Catalog{}, fmt.Errorf("tag %q is not <catalog>-<version>", tag)
	}
	var tree struct {
		Tree []struct{ Path, Type string } `json:"tree"`
	}
	if err := getJSON(fmt.Sprintf("https://api.github.com/repos/%s/git/trees/%s?recursive=1", catalogsRepo, tag), &tree); err != nil {
		return catalog.Catalog{}, err
	}
	var meta struct {
		Spec struct{ Version string } `yaml:"spec"`
	}
	if err := getYAML(raw(tag, name+"/Catalog.yaml"), &meta); err != nil {
		return catalog.Catalog{}, err
	}
	c := catalog.Catalog{
		Name:    name,
		Version: meta.Spec.Version,
		Tag:     tag,
		OCI:     fmt.Sprintf("oci://ghcr.io/kubara-io/catalogs/%s:%s", name, meta.Spec.Version),
		Source:  fmt.Sprintf("https://github.com/%s/tree/%s/%s", catalogsRepo, tag, name),
	}
	prefix := name + "/services/"
	for _, entry := range tree.Tree {
		if entry.Type != "blob" || !strings.HasPrefix(entry.Path, prefix) || !strings.HasSuffix(entry.Path, ".yaml") {
			continue
		}
		var def struct {
			Metadata struct {
				Name        string            `yaml:"name"`
				Annotations map[string]string `yaml:"annotations"`
			} `yaml:"metadata"`
			Spec struct {
				ChartPath    string   `yaml:"chartPath"`
				Status       string   `yaml:"status"`
				ClusterTypes []string `yaml:"clusterTypes"`
			} `yaml:"spec"`
		}
		if err := getYAML(raw(tag, entry.Path), &def); err != nil {
			return c, fmt.Errorf("%s: %w", entry.Path, err)
		}
		svc := catalog.Service{
			Name:         def.Metadata.Name,
			Category:     def.Metadata.Annotations["kubara.io/category"],
			ChartPath:    def.Spec.ChartPath,
			Default:      def.Spec.Status,
			ClusterTypes: def.Spec.ClusterTypes,
		}
		var chart struct {
			Version      string `yaml:"version"`
			Dependencies []struct {
				Name       string `yaml:"name"`
				Version    string `yaml:"version"`
				Repository string `yaml:"repository"`
			} `yaml:"dependencies"`
		}
		chartFile := name + "/platform-components/helm/" + svc.ChartPath + "/Chart.yaml"
		if err := getYAML(raw(tag, chartFile), &chart); err == nil {
			svc.WrapperVersion = chart.Version
			for _, dep := range chart.Dependencies {
				if dep.Name == "template-library" || strings.HasPrefix(dep.Repository, "file://") {
					continue
				}
				svc.Upstream = append(svc.Upstream, catalog.Chart{Name: dep.Name, Version: strings.TrimPrefix(dep.Version, "v"), RawVersion: dep.Version, Repository: dep.Repository})
			}
		}
		c.Services = append(c.Services, svc)
	}
	sort.Slice(c.Services, func(i, j int) bool { return c.Services[i].Name < c.Services[j].Name })
	return c, nil
}

func snapshotWorkshop(root string) (catalog.Workshop, error) {
	commit, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err != nil {
		return catalog.Workshop{}, fmt.Errorf("helm-expt: %w", err)
	}
	var index struct {
		Listings []struct {
			ID                string `json:"id"`
			Name              string `json:"name"`
			Format            string `json:"format"`
			Version           string `json:"version"`
			Base              string `json:"base"`
			ObjectCount       int    `json:"objectCount"`
			FlatteningVerdict string `json:"flatteningVerdict"`
		} `json:"listings"`
	}
	data, err := os.ReadFile(filepath.Join(root, "site/listings/index.json"))
	if err != nil {
		return catalog.Workshop{}, err
	}
	if err := json.Unmarshal(data, &index); err != nil {
		return catalog.Workshop{}, err
	}
	ev := catalog.Workshop{Source: catalog.WorkshopSource{
		Repository: "https://github.com/confighub/helm-expt",
		Commit:     strings.TrimSpace(string(commit)),
		Site:       "https://confighub.github.io/helm-expt/site/",
	}}
	byKey := map[string]*catalog.WorkshopChart{}
	for _, l := range index.Listings {
		if l.Format != "helm" {
			continue
		}
		key := l.Name + "@" + l.Version
		wc, ok := byKey[key]
		if !ok {
			var lock struct {
				Spec struct {
					RepositoryURL string `yaml:"repositoryURL"`
					Chart         string `yaml:"chart"`
				} `yaml:"spec"`
			}
			lockPath := filepath.Join(root, "recipes", l.Name, l.Version, "source-lock.yaml")
			if b, err := os.ReadFile(lockPath); err == nil {
				_ = yaml.Unmarshal(b, &lock)
			}
			chartName := lock.Spec.Chart
			if chartName == "" {
				chartName = l.Name[strings.LastIndex(l.Name, "/")+1:]
			}
			wc = &catalog.WorkshopChart{
				Name:       l.Name,
				Chart:      chartName,
				Version:    strings.TrimPrefix(l.Version, "v"),
				Repository: lock.Spec.RepositoryURL,
				Page:       fmt.Sprintf("%scharts/%s.html", ev.Source.Site, strings.NewReplacer("/", "-", ".", "-").Replace(l.Name+"-"+l.Version)),
			}
			byKey[key] = wc
		}
		wc.Bases = append(wc.Bases, catalog.WorkshopBase{Name: l.Base, Verdict: l.FlatteningVerdict, Objects: l.ObjectCount, Listing: ev.Source.Site + "listings/" + l.ID + ".json"})
	}
	for _, wc := range byKey {
		sort.Slice(wc.Bases, func(i, j int) bool { return wc.Bases[i].Name < wc.Bases[j].Name })
		ev.Charts = append(ev.Charts, *wc)
	}
	sort.Slice(ev.Charts, func(i, j int) bool {
		if ev.Charts[i].Name != ev.Charts[j].Name {
			return ev.Charts[i].Name < ev.Charts[j].Name
		}
		return ev.Charts[i].Version < ev.Charts[j].Version
	})
	return ev, nil
}

func raw(tag, path string) string {
	return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s", catalogsRepo, tag, path)
}

var client = &http.Client{Timeout: 60 * time.Second}

func get(url string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if token := os.Getenv("GITHUB_TOKEN"); token != "" && strings.Contains(url, "api.github.com") {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func getJSON(url string, v any) error {
	b, err := get(url)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func getYAML(url string, v any) error {
	b, err := get(url)
	if err != nil {
		return err
	}
	return yaml.Unmarshal(b, v)
}

func writeJSON(path string, v any) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "snapshot:", err)
	os.Exit(1)
}
