// Package takeover points a Kubara hub at the releases ConfigHub approves. It
// keeps Kubara's hub, AppProject and ApplicationSets: each ApplicationSet whose
// chart ConfigHub holds reads the cluster's variant release from ConfigHub's
// OCI gateway instead of Git, and Argo CD keeps each Secret's live values.
package takeover

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultGateway is the host ConfigHub serves Space releases from.
const DefaultGateway = "oci.hub.confighub.com"

// ReleaseTag is the tag of a Space's newest release on the gateway.
const ReleaseTag = "latest"

var docSeparator = regexp.MustCompile(`(?m)^---[ \t]*$\n?`)

// Route is one ApplicationSet pointed at ConfigHub.
type Route struct {
	ApplicationSet string
	Chart          string
	RepoURL        string
}

// Routed says what RouteApplicationSets changed and what it left on Git.
type Routed struct {
	Routes   []Route
	OnGit    []string // ApplicationSets whose chart ConfigHub does not hold
	Projects []string // AppProjects given the gateway as a source
}

// SpaceRepo is the gateway repository of a variant Space. {{name}} is the
// cluster name Argo CD's cluster generator fills in, which is the Kubara
// cluster name, so one ApplicationSet reaches each cluster's own variant.
func SpaceRepo(gateway, prefix, chart string) string {
	return fmt.Sprintf("oci://%s/space/%s-%s-{{name}}", gateway, prefix, chart)
}

func projectPattern(gateway, prefix string) string {
	return fmt.Sprintf("oci://%s/space/%s-*", gateway, prefix)
}

// RouteApplicationSets rewrites the ApplicationSets in an argo-cd render. Each
// one whose chart directory is in charts reads from ConfigHub, and ignores the
// data of Secrets, which ConfigHub holds without values. An AppProject that
// lists its sources gains the gateway. Every other document is kept byte for
// byte, and a render already routed comes back unchanged.
func RouteApplicationSets(render []byte, charts map[string]bool, prefix, gateway string) ([]byte, Routed, error) {
	docs := docSeparator.Split(string(render), -1)
	roots := make([]*yaml.Node, len(docs))
	var out Routed
	projects := map[string]bool{}
	changed := make([]bool, len(docs))
	for i, doc := range docs {
		if !strings.Contains(doc, "ApplicationSet") && !strings.Contains(doc, "AppProject") {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(doc), &root); err != nil {
			return nil, out, err
		}
		roots[i] = &root
		top := mapping(&root)
		if top == nil || scalar(top, "kind") != "ApplicationSet" {
			continue
		}
		name := scalar(value(top, "metadata"), "name")
		spec := value(value(value(top, "spec"), "template"), "spec")
		if spec == nil {
			continue
		}
		chart := chartOf(spec, prefix)
		if chart == "" || !charts[chart] {
			if chart != "" {
				out.OnGit = append(out.OnGit, name)
			}
			continue
		}
		repo := SpaceRepo(gateway, prefix, chart)
		out.Routes = append(out.Routes, Route{ApplicationSet: name, Chart: chart, RepoURL: repo})
		if p := scalar(spec, "project"); p != "" {
			projects[p] = true
		}
		if routeSpec(spec, repo) {
			changed[i] = true
		}
	}
	pattern := projectPattern(gateway, prefix)
	for i, root := range roots {
		top := mapping(root)
		if top == nil || scalar(top, "kind") != "AppProject" || !projects[scalar(value(top, "metadata"), "name")] {
			continue
		}
		repos := value(value(top, "spec"), "sourceRepos")
		if repos == nil || repos.Kind != yaml.SequenceNode {
			continue // Argo CD applies the same rule to OCI as to Git.
		}
		allowed := false
		for _, r := range repos.Content {
			if r.Value == "*" || r.Value == pattern {
				allowed = true
			}
		}
		if !allowed {
			repos.Content = append(repos.Content, str(pattern))
			out.Projects = append(out.Projects, scalar(value(top, "metadata"), "name"))
			changed[i] = true
		}
	}
	for i, root := range roots {
		if !changed[i] {
			continue
		}
		var buf bytes.Buffer
		enc := yaml.NewEncoder(&buf)
		enc.SetIndent(2)
		if err := enc.Encode(root); err != nil {
			return nil, out, err
		}
		docs[i] = buf.String()
	}
	sort.Strings(out.OnGit)
	return []byte(strings.Join(docs, "---\n")), out, nil
}

// chartOf is the chart directory an ApplicationSet template renders, from
// Kubara's Git source (platform-components/helm/<chart>) or, once routed,
// from the ConfigHub repository it reads.
func chartOf(spec *yaml.Node, prefix string) string {
	if src := value(spec, "source"); src != nil {
		repo := scalar(src, "repoURL")
		if i := strings.Index(repo, "/space/"); i >= 0 && strings.HasSuffix(repo, "-{{name}}") {
			return strings.TrimPrefix(strings.TrimSuffix(repo[i+len("/space/"):], "-{{name}}"), prefix+"-")
		}
	}
	sources := value(spec, "sources")
	if sources == nil || sources.Kind != yaml.SequenceNode {
		return ""
	}
	for _, s := range sources.Content {
		p := scalar(s, "path")
		if p != "" && strings.Contains(p, "helm/") {
			return path.Base(p)
		}
	}
	return ""
}

// routeSpec points a template spec at repo. It reports whether it changed
// anything, so running it twice changes nothing the second time.
func routeSpec(spec *yaml.Node, repo string) bool {
	if src := value(spec, "source"); src != nil && scalar(src, "repoURL") == repo && value(spec, "sources") == nil && hasSecretIgnore(spec) {
		return false
	}
	var content []*yaml.Node
	for i := 0; i+1 < len(spec.Content); i += 2 {
		if k := spec.Content[i].Value; k == "sources" || k == "source" {
			continue
		}
		content = append(content, spec.Content[i], spec.Content[i+1])
	}
	source := &yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
		str("repoURL"), str(repo),
		str("targetRevision"), str(ReleaseTag),
		str("path"), str("."),
	}}
	content = append(content, str("source"), source)
	spec.Content = content
	if !hasSecretIgnore(spec) {
		entry := &yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
			str("kind"), str("Secret"),
			str("jsonPointers"), {Kind: yaml.SequenceNode, Content: []*yaml.Node{str("/data"), str("/stringData")}},
		}}
		if ignores := value(spec, "ignoreDifferences"); ignores != nil && ignores.Kind == yaml.SequenceNode {
			ignores.Content = append(ignores.Content, entry)
		} else {
			spec.Content = append(spec.Content, str("ignoreDifferences"), &yaml.Node{Kind: yaml.SequenceNode, Content: []*yaml.Node{entry}})
		}
	}
	return true
}

func hasSecretIgnore(spec *yaml.Node) bool {
	ignores := value(spec, "ignoreDifferences")
	if ignores == nil {
		return false
	}
	for _, e := range ignores.Content {
		if scalar(e, "kind") != "Secret" {
			continue
		}
		pointers := map[string]bool{}
		if p := value(e, "jsonPointers"); p != nil {
			for _, x := range p.Content {
				pointers[x.Value] = true
			}
		}
		if pointers["/data"] && pointers["/stringData"] {
			return true
		}
	}
	return false
}

// Only returns the named ApplicationSet from a render, for the one kubectl
// apply that hands the hub to ConfigHub.
func Only(render []byte, applicationSet string) ([]byte, error) {
	for _, doc := range docSeparator.Split(string(render), -1) {
		if !strings.Contains(doc, "ApplicationSet") {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(doc), &root); err != nil {
			return nil, err
		}
		top := mapping(&root)
		if top != nil && scalar(top, "kind") == "ApplicationSet" && scalar(value(top, "metadata"), "name") == applicationSet {
			return []byte(doc), nil
		}
	}
	return nil, fmt.Errorf("the render holds no ApplicationSet %s", applicationSet)
}

func mapping(root *yaml.Node) *yaml.Node {
	if root == nil {
		return nil
	}
	n := root
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		n = n.Content[0]
	}
	if n.Kind != yaml.MappingNode {
		return nil
	}
	return n
}

func value(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func scalar(m *yaml.Node, key string) string {
	if v := value(m, key); v != nil && v.Kind == yaml.ScalarNode {
		return v.Value
	}
	return ""
}

func str(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }
