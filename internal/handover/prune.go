package handover

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Resource names one object the way Argo CD's Application status does.
type Resource struct {
	Group     string `json:"group"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

func (r Resource) String() string {
	kind := r.Kind
	if r.Group != "" {
		kind += "." + r.Group
	}
	if r.Namespace == "" {
		return kind + " " + r.Name
	}
	return kind + " " + r.Namespace + "/" + r.Name
}

// WouldPrune lists the objects an Application manages today that the release
// it is about to read does not hold. Kubara's ApplicationSets prune, so Argo
// CD would delete each of them once the Application reads the release.
// application is `kubectl get application -o json`; release is the variant's
// configuration as ConfigHub holds it.
func WouldPrune(application, release []byte) ([]Resource, error) {
	var app struct {
		Spec struct {
			Destination struct {
				Namespace string `json:"namespace"`
			} `json:"destination"`
		} `json:"spec"`
		Status struct {
			Resources []Resource `json:"resources"`
		} `json:"status"`
	}
	if err := json.Unmarshal(application, &app); err != nil {
		return nil, fmt.Errorf("reading the Application: %w", err)
	}
	held := map[Resource]bool{}
	for _, doc := range docSeparator.Split(string(release), -1) {
		var obj struct {
			APIVersion string `yaml:"apiVersion"`
			Kind       string `yaml:"kind"`
			Metadata   struct {
				Name      string `yaml:"name"`
				Namespace string `yaml:"namespace"`
			} `yaml:"metadata"`
		}
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			return nil, fmt.Errorf("reading the release: %w", err)
		}
		if obj.Kind == "" {
			continue
		}
		group := ""
		if g, _, ok := strings.Cut(obj.APIVersion, "/"); ok {
			group = g
		}
		r := Resource{Group: group, Kind: obj.Kind, Namespace: obj.Metadata.Namespace, Name: obj.Metadata.Name}
		held[r] = true
		if r.Namespace == "" {
			// Argo CD puts a namespaced object without one in the destination
			// namespace; a cluster-scoped one stays without.
			r.Namespace = app.Spec.Destination.Namespace
			held[r] = true
		}
	}
	var out []Resource
	for _, r := range app.Status.Resources {
		if !held[r] {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out, nil
}
