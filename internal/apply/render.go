package apply

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/platform"
)

// App is one service as Kubara's hub ApplicationSets deliver it: the chart
// directory, and the release name and namespace its Application uses.
type App struct {
	Name      string `yaml:"name"`
	Path      string `yaml:"path"`
	Namespace string `yaml:"namespace"`
	// Sources set, the service does not render from its wrapper chart, and
	// cub kubara cannot reproduce it.
	Sources []any `yaml:"sources"`
}

// ReleaseNamespace is the namespace Kubara's ApplicationSet deploys to.
func (a App) ReleaseNamespace() string {
	if a.Namespace != "" {
		return a.Namespace
	}
	return a.Name
}

const bootstrapCRDs = "bootstrap-crds"

// KubaraRenderer renders one cluster the way Kubara delivers it. Each service
// the cluster enables renders from its wrapper chart with the release name,
// namespace and values files its ApplicationSet uses. bootstrap-crds renders
// as the CRDs kubara bootstrap applies, and nothing else. APIs whose CRDs
// bootstrap-crds provides are declared to the charts that check for them,
// as a cluster where those CRDs exist would.
func KubaraRenderer(kubaraDir, cluster, dir string) (map[string]string, error) {
	if _, err := exec.LookPath("helm"); err != nil {
		return nil, fmt.Errorf("rendering needs helm on your PATH: cub kubara renders Kubara's wrapper charts with it")
	}
	p, err := platform.Load(kubaraDir)
	if err != nil {
		return nil, err
	}
	var cl *platform.Cluster
	for i := range p.Config.Clusters {
		if p.Config.Clusters[i].Name == cluster {
			cl = &p.Config.Clusters[i]
		}
	}
	if cl == nil {
		return nil, fmt.Errorf("config.yaml has no cluster %s", cluster)
	}
	apps, err := KubaraApps(p.Dir)
	if err != nil {
		return nil, err
	}
	byPath := map[string]App{}
	for _, a := range apps {
		byPath[a.Path] = a
	}
	charts := filepath.Join(p.Dir, "platform-components", "helm")
	configs := filepath.Join(p.Dir, "platform-configs", cluster, "helm")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	out := map[string]string{}
	provided := map[string]bool{}

	// bootstrap-crds first: its CRDs are on every cluster before Argo CD runs.
	if _, err := os.Stat(filepath.Join(charts, bootstrapCRDs, "Chart.yaml")); err == nil {
		docs, err := helmTemplate(bootstrapCRDs, filepath.Join(charts, bootstrapCRDs), "kube-system", valuesFiles(filepath.Join(configs, bootstrapCRDs)), nil)
		if err != nil {
			return nil, err
		}
		var crds []string
		for _, d := range docs {
			if kindOf(d) == "CustomResourceDefinition" {
				crds = append(crds, d)
				for _, api := range crdAPIs(d) {
					provided[api] = true
				}
			}
		}
		path := filepath.Join(dir, bootstrapCRDs+".yaml")
		if err := os.WriteFile(path, []byte(strings.Join(crds, "---\n")), 0o644); err != nil {
			return nil, err
		}
		out[bootstrapCRDs] = path
	}

	var services []string
	if cl.Type == "hub" {
		services = append(services, "argo-cd")
	}
	services = append(services, cl.Enabled()...)
	for _, chart := range services {
		app, ok := byPath[chart]
		if !ok {
			app, ok = appByName(apps, chart)
		}
		if !ok {
			return nil, fmt.Errorf("Kubara's hub ApplicationSets name no service for chart %s", chart)
		}
		if len(app.Sources) > 0 {
			return nil, fmt.Errorf("service %s sets its own sources, so cub kubara cannot render it the way Kubara delivers it", app.Name)
		}
		dirPath := filepath.Join(charts, app.Path)
		if _, err := os.Stat(filepath.Join(dirPath, "Chart.yaml")); err != nil {
			return nil, fmt.Errorf("Kubara generated no chart for %s under platform-components/helm", app.Path)
		}
		docs, err := helmTemplate(app.Name, dirPath, app.ReleaseNamespace(), valuesFiles(filepath.Join(configs, app.Path)), sortedKeys(provided))
		if err != nil {
			return nil, err
		}
		path := filepath.Join(dir, app.Path+".yaml")
		if err := os.WriteFile(path, []byte(strings.Join(docs, "---\n")), 0o644); err != nil {
			return nil, err
		}
		out[app.Path] = path
		for _, d := range docs {
			if kindOf(d) == "CustomResourceDefinition" {
				for _, api := range crdAPIs(d) {
					provided[api] = true
				}
			}
		}
	}
	return out, nil
}

// KubaraApps reads the services Kubara's hub ApplicationSets deliver, from the
// argo-cd values of the hub, merged in the order Argo CD reads them.
func KubaraApps(kubaraDir string) ([]App, error) {
	configs := filepath.Join(kubaraDir, "platform-configs")
	entries, err := os.ReadDir(configs)
	if err != nil {
		return nil, fmt.Errorf("no platform-configs: run kubara generate --helm first")
	}
	for _, e := range entries {
		argo := filepath.Join(configs, e.Name(), "helm", "argo-cd")
		files := append([]string{filepath.Join(kubaraDir, "platform-components", "helm", "argo-cd", "values.yaml")}, valuesFiles(argo)...)
		merged := map[string]any{}
		for _, f := range files {
			b, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			var v map[string]any
			if err := yaml.Unmarshal(b, &v); err != nil {
				return nil, fmt.Errorf("%s: %w", f, err)
			}
			merge(merged, v)
		}
		bv, _ := merged["bootstrapValues"].(map[string]any)
		sets, _ := bv["applicationSets"].(map[string]any)
		if len(sets) == 0 {
			continue
		}
		var apps []App
		for _, setName := range sortedMapKeys(sets) {
			set, _ := sets[setName].(map[string]any)
			list, _ := set["apps"].(map[string]any)
			for _, key := range sortedMapKeys(list) {
				b, _ := yaml.Marshal(list[key])
				var a App
				if err := yaml.Unmarshal(b, &a); err != nil {
					return nil, err
				}
				if a.Name == "" || a.Path == "" {
					continue
				}
				apps = append(apps, a)
			}
		}
		return apps, nil
	}
	return nil, fmt.Errorf("no cluster's argo-cd values name Kubara's ApplicationSets; is this a platform Kubara generated?")
}

// valuesFiles lists a cluster's values for one chart in the order Kubara's
// ApplicationSet passes them: values.generated.yaml, additional-values.yaml,
// then values-*.yaml. The chart's own values.yaml applies first, as always.
func valuesFiles(dir string) []string {
	var files []string
	for _, name := range []string{"values.generated.yaml", "additional-values.yaml"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			files = append(files, filepath.Join(dir, name))
		}
	}
	extra, _ := filepath.Glob(filepath.Join(dir, "values-*.yaml"))
	sort.Strings(extra)
	return append(files, extra...)
}

func helmTemplate(release, chartDir, namespace string, values, apis []string) ([]string, error) {
	if b, err := os.ReadFile(filepath.Join(chartDir, "Chart.yaml")); err == nil && bytes.Contains(b, []byte("dependencies:")) {
		if _, err := os.Stat(filepath.Join(chartDir, "charts")); err != nil {
			if out, err := exec.Command("helm", "dependency", "build", chartDir).CombinedOutput(); err != nil {
				if out2, err2 := exec.Command("helm", "dependency", "update", chartDir).CombinedOutput(); err2 != nil {
					return nil, fmt.Errorf("helm dependency build %s: %s\n%s", chartDir, lastLine(string(out)), lastLine(string(out2)))
				}
			}
		}
	}
	args := []string{"template", release, chartDir, "--namespace", namespace, "--include-crds"}
	for _, a := range apis {
		args = append(args, "--api-versions", a)
	}
	for _, f := range values {
		args = append(args, "-f", f)
	}
	cmd := exec.Command("helm", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("helm template %s: %s", release, lastLine(stderr.String()))
	}
	var docs []string
	for _, d := range docSeparator.Split(stdout.String(), -1) {
		if kindOf(d) != "" {
			docs = append(docs, strings.TrimLeft(d, "\n"))
		}
	}
	return docs, nil
}

func kindOf(doc string) string {
	var head struct {
		Kind string `yaml:"kind"`
	}
	if yaml.Unmarshal([]byte(doc), &head) != nil {
		return ""
	}
	return head.Kind
}

// crdAPIs lists group/version and group/version/Kind for every served
// version of a CRD, the forms helm --api-versions accepts.
func crdAPIs(doc string) []string {
	var crd struct {
		Spec struct {
			Group string `yaml:"group"`
			Names struct {
				Kind string `yaml:"kind"`
			} `yaml:"names"`
			Versions []struct {
				Name   string `yaml:"name"`
				Served *bool  `yaml:"served"`
			} `yaml:"versions"`
		} `yaml:"spec"`
	}
	if yaml.Unmarshal([]byte(doc), &crd) != nil || crd.Spec.Group == "" {
		return nil
	}
	var out []string
	for _, v := range crd.Spec.Versions {
		if v.Served != nil && !*v.Served {
			continue
		}
		gv := crd.Spec.Group + "/" + v.Name
		out = append(out, gv, gv+"/"+crd.Spec.Names.Kind)
	}
	return out
}

func appByName(apps []App, name string) (App, bool) {
	for _, a := range apps {
		if a.Name == name {
			return a, true
		}
	}
	return App{}, false
}

func merge(dst, src map[string]any) {
	for k, v := range src {
		if sm, ok := v.(map[string]any); ok {
			if dm, ok := dst[k].(map[string]any); ok {
				merge(dm, sm)
				continue
			}
		}
		dst[k] = v
	}
}

func sortedKeys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedMapKeys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
