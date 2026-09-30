package apply

import (
	"bytes"
	"encoding/json"
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

// Capabilities are what Argo CD renders a chart with on a live cluster: the
// server's Kubernetes version and every API it serves. Without them a render
// uses Helm's defaults plus the APIs whose CRDs bootstrap-crds provides.
type Capabilities struct {
	Source      string // the kubectl context they were read from
	KubeVersion string
	APIs        []string
}

// ReadCapabilities asks a cluster for its version and the APIs it serves, as
// group/version and group/version/Kind, the forms helm --api-versions takes.
func ReadCapabilities(context string) (Capabilities, error) {
	c := Capabilities{Source: context}
	out, err := exec.Command("kubectl", "--context", context, "version", "-o", "json").Output()
	if err != nil {
		return c, fmt.Errorf("kubectl --context %s version: %w", context, err)
	}
	var v struct {
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	if err := json.Unmarshal(out, &v); err != nil || v.ServerVersion.GitVersion == "" {
		return c, fmt.Errorf("kubectl --context %s version reported no server version", context)
	}
	c.KubeVersion = v.ServerVersion.GitVersion
	out, err = exec.Command("kubectl", "--context", context, "api-resources", "--no-headers").Output()
	if err != nil {
		return c, fmt.Errorf("kubectl --context %s api-resources: %w", context, err)
	}
	c.APIs = parseAPIResources(string(out))
	return c, nil
}

// parseAPIResources reads kubectl api-resources output, whose last three
// columns are APIVERSION, NAMESPACED and KIND.
func parseAPIResources(out string) []string {
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		gv, kind := f[len(f)-3], f[len(f)-1]
		seen[gv] = true
		seen[gv+"/"+kind] = true
	}
	return sortedKeys(seen)
}

// NewKubaraRenderer renders like KubaraRenderer, with each named cluster's
// own capabilities.
func NewKubaraRenderer(caps map[string]Capabilities) Renderer {
	return func(kubaraDir, cluster, dir string) (map[string]string, error) {
		return renderKubara(kubaraDir, cluster, dir, caps[cluster])
	}
}

// KubaraRenderer renders one cluster the way Kubara delivers it. Each service
// the cluster enables renders from its wrapper chart with the release name,
// namespace and values files its ApplicationSet uses. bootstrap-crds renders
// as the CRDs kubara bootstrap applies, and nothing else. APIs whose CRDs
// bootstrap-crds provides are declared to the charts that check for them,
// as a cluster where those CRDs exist would.
func KubaraRenderer(kubaraDir, cluster, dir string) (map[string]string, error) {
	return renderKubara(kubaraDir, cluster, dir, Capabilities{})
}

// ServiceRender is one service rendered for one cluster the way Kubara
// delivers it, with everything the render used.
type ServiceRender struct {
	Chart     string // the chart directory under platform-components/helm
	Release   string // the release name its Application uses
	Namespace string
	// ByBootstrap is true for bootstrap-crds, which kubara bootstrap applies
	// as CRDs only; every other service is delivered by an ApplicationSet.
	ByBootstrap bool
	ValuesFiles []string // passed to helm in this order, after the chart's own values.yaml
	APIVersions []string // passed to helm as --api-versions
	KubeVersion string   // passed to helm as --kube-version; empty is helm's default
	Docs        []string // the rendered objects, one YAML document each
	LeftOut     int      // objects the chart renders that kubara bootstrap does not apply
}

func renderKubara(kubaraDir, cluster, dir string, caps Capabilities) (map[string]string, error) {
	renders, err := RenderCluster(kubaraDir, cluster, caps)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, r := range renders {
		path := filepath.Join(dir, r.Chart+".yaml")
		if err := os.WriteFile(path, []byte(strings.Join(r.Docs, "---\n")), 0o644); err != nil {
			return nil, err
		}
		out[r.Chart] = path
	}
	return out, nil
}

// RenderCluster renders every service one cluster runs, the way Kubara
// delivers it: bootstrap-crds first, as the CRDs kubara bootstrap applies,
// then Argo CD on the hub, then each service config.yaml enables. Each renders
// from its wrapper chart with the release name, namespace and values files its
// ApplicationSet uses. Without capabilities, a chart is told of the APIs whose
// CRDs the services before it provide, as a cluster where they exist would.
func RenderCluster(kubaraDir, cluster string, caps Capabilities) ([]ServiceRender, error) {
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
	var out []ServiceRender
	provided := map[string]bool{}

	// bootstrap-crds first: its CRDs are on every cluster before Argo CD runs.
	if _, err := os.Stat(filepath.Join(charts, bootstrapCRDs, "Chart.yaml")); err == nil {
		r := ServiceRender{Chart: bootstrapCRDs, Release: bootstrapCRDs, Namespace: "kube-system", ByBootstrap: true,
			ValuesFiles: valuesFiles(filepath.Join(configs, bootstrapCRDs)), APIVersions: caps.APIs, KubeVersion: caps.KubeVersion}
		docs, err := helmTemplate(r.Release, filepath.Join(charts, bootstrapCRDs), r.Namespace, r.ValuesFiles, r.APIVersions, r.KubeVersion)
		if err != nil {
			return nil, err
		}
		for _, d := range docs {
			if kindOf(d) != "CustomResourceDefinition" {
				r.LeftOut++
				continue
			}
			r.Docs = append(r.Docs, d)
			for _, api := range crdAPIs(d) {
				provided[api] = true
			}
		}
		out = append(out, r)
	}

	var services []string
	if cl.Type == "hub" {
		services = append(services, "argo-cd")
	}
	for _, name := range cl.Enabled() {
		if name != "argo-cd" && name != bootstrapCRDs {
			services = append(services, name)
		}
	}
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
		apis := caps.APIs
		if len(apis) == 0 {
			apis = sortedKeys(provided)
		}
		r := ServiceRender{Chart: app.Path, Release: app.Name, Namespace: app.ReleaseNamespace(),
			ValuesFiles: valuesFiles(filepath.Join(configs, app.Path)), APIVersions: apis, KubeVersion: caps.KubeVersion}
		r.Docs, err = helmTemplate(r.Release, dirPath, r.Namespace, r.ValuesFiles, r.APIVersions, r.KubeVersion)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
		for _, d := range r.Docs {
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
// configured hub's argo-cd values, merged in the order Argo CD reads them.
func KubaraApps(kubaraDir string) ([]App, error) {
	p, err := platform.Load(kubaraDir)
	if err != nil {
		return nil, err
	}
	hub := ""
	for _, cl := range p.Config.Clusters {
		if cl.Type == "hub" {
			hub = cl.Name
		}
	}
	if hub == "" {
		return nil, fmt.Errorf("config.yaml names no hub, whose Argo CD delivers every service")
	}
	argo := filepath.Join(p.Dir, "platform-configs", hub, "helm", "argo-cd")
	files := append([]string{filepath.Join(p.Dir, "platform-components", "helm", "argo-cd", "values.yaml")}, valuesFiles(argo)...)
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
		return nil, fmt.Errorf("the hub %s's argo-cd values name no ApplicationSets; is this a platform Kubara generated?", hub)
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

func helmTemplate(release, chartDir, namespace string, values, apis []string, kubeVersion string) ([]string, error) {
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
	if kubeVersion != "" {
		args = append(args, "--kube-version", kubeVersion)
	}
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
	// Each document ends in exactly one newline. Helm releases differ in the
	// blank lines they leave between documents, and a render must not.
	var docs []string
	for _, d := range docSeparator.Split(stdout.String(), -1) {
		if kindOf(d) != "" {
			docs = append(docs, strings.TrimRight(strings.TrimLeft(d, "\n"), "\n")+"\n")
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
