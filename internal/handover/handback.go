package handover

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/confighub/kubara-confighub/internal/plan"
)

// ClusterRender renders one cluster of a Kubara platform the way Kubara's hub
// delivers it from Git, and returns each render by chart directory name.
type ClusterRender func(kubaraDir, cluster string) (map[string][]byte, error)

type HandbackOptions struct {
	Out     string
	Gateway string
	Render  ClusterRender
}

// Original is one object handback puts back as Kubara generated it.
type Original struct {
	Kind  string // ApplicationSet or AppProject
	Name  string
	Chart string // the chart an ApplicationSet delivers
	// Spec is the spec handback restores, as JSON. For an ApplicationSet it is
	// Kubara's spec, with the rule that leaves Secret data alone kept, so each
	// Secret keeps its live value.
	Spec json.RawMessage
}

// Restore is what handback puts back on the hub.
type Restore struct {
	// ApplicationSets are the ones handover routed, argo-cd's first: once the
	// hub's argocd Application reads Git, Argo CD stops writing the routed
	// ApplicationSets back from ConfigHub's release.
	ApplicationSets []Original
	// Projects are the AppProjects those ApplicationSets use, with the
	// sources Kubara gave them, so they no longer permit the gateway.
	Projects []Original
}

type HandbackResult struct {
	Script       string
	Restore      Restore
	Applications []string
}

// PlanHandback works out, from the hub's argo-cd render as Kubara generates it,
// which ApplicationSets and AppProjects handover changed and what each was.
// charts are the chart directories ConfigHub holds, as for handover.
func PlanHandback(render []byte, charts map[string]bool, prefix, gateway string) (Restore, error) {
	var out Restore
	_, routed, err := RouteApplicationSets(render, charts, prefix, gateway)
	if err != nil {
		return out, err
	}
	appsets := map[string]string{}
	for _, r := range routed.Routes {
		appsets[r.ApplicationSet] = r.Chart
	}
	projects := map[string]bool{}
	for _, p := range routed.Used {
		projects[p] = true
	}
	for _, doc := range docSeparator.Split(string(render), -1) {
		if !strings.Contains(doc, "ApplicationSet") && !strings.Contains(doc, "AppProject") {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal([]byte(doc), &root); err != nil {
			return out, err
		}
		top := mapping(&root)
		if top == nil {
			continue
		}
		kind, name := scalar(top, "kind"), scalar(value(top, "metadata"), "name")
		spec := value(top, "spec")
		switch {
		case kind == "ApplicationSet" && appsets[name] != "":
			tmpl := value(value(spec, "template"), "spec")
			if src := value(tmpl, "source"); src != nil && strings.Contains(scalar(src, "repoURL"), "/space/") {
				return out, fmt.Errorf("ApplicationSet %s in this render already reads ConfigHub; handback needs the platform as Kubara generates it, from Git", name)
			}
			if !hasSecretIgnore(tmpl) {
				addSecretIgnore(tmpl)
			}
			b, err := specJSON(spec)
			if err != nil {
				return out, fmt.Errorf("ApplicationSet %s: %w", name, err)
			}
			o := Original{Kind: kind, Name: name, Chart: appsets[name], Spec: b}
			if o.Chart == unitArgoCD {
				out.ApplicationSets = append([]Original{o}, out.ApplicationSets...)
			} else {
				out.ApplicationSets = append(out.ApplicationSets, o)
			}
		case kind == "AppProject" && projects[name]:
			b, err := specJSON(spec)
			if err != nil {
				return out, fmt.Errorf("AppProject %s: %w", name, err)
			}
			out.Projects = append(out.Projects, Original{Kind: kind, Name: name, Spec: b})
		}
	}
	if len(out.ApplicationSets) == 0 || out.ApplicationSets[0].Chart != unitArgoCD {
		return out, fmt.Errorf("the hub's argo-cd render has no ApplicationSet for argo-cd itself, so there is no handover to undo")
	}
	return out, nil
}

// Inventory lists the objects a render holds, by kind, name and namespace
// only, for the prune check. It leaves out everything else, Secret values
// included.
func Inventory(render []byte) ([]byte, error) {
	var b strings.Builder
	for _, doc := range docSeparator.Split(string(render), -1) {
		var obj struct {
			APIVersion string `yaml:"apiVersion"`
			Kind       string `yaml:"kind"`
			Metadata   struct {
				Name      string `yaml:"name"`
				Namespace string `yaml:"namespace"`
			} `yaml:"metadata"`
		}
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			return nil, err
		}
		if obj.Kind == "" {
			continue
		}
		fmt.Fprintf(&b, "---\napiVersion: %s\nkind: %s\nmetadata:\n  name: %s\n", obj.APIVersion, obj.Kind, obj.Metadata.Name)
		if obj.Metadata.Namespace != "" {
			fmt.Fprintf(&b, "  namespace: %s\n", obj.Metadata.Namespace)
		}
	}
	return []byte(b.String()), nil
}

func addSecretIgnore(spec *yaml.Node) {
	entry := &yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
		str("kind"), str("Secret"),
		str("jsonPointers"), {Kind: yaml.SequenceNode, Content: []*yaml.Node{str("/data"), str("/stringData")}},
	}}
	if ignores := value(spec, "ignoreDifferences"); ignores != nil && ignores.Kind == yaml.SequenceNode {
		ignores.Content = append(ignores.Content, entry)
		return
	}
	spec.Content = append(spec.Content, str("ignoreDifferences"), &yaml.Node{Kind: yaml.SequenceNode, Content: []*yaml.Node{entry}})
}

func specJSON(spec *yaml.Node) (json.RawMessage, error) {
	if spec == nil {
		return nil, fmt.Errorf("no spec")
	}
	var v any
	if err := spec.Decode(&v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// WriteHandback writes handback.sh, which hands Kubara's hub back to Git after
// handover.sh: each ApplicationSet handover routed reads Kubara's Git sources
// again, its AppProject no longer permits the gateway, and argobot and the
// gateway credential leave the hub. ConfigHub keeps every Space and release.
func WriteHandback(p plan.Plan, opts HandbackOptions) (HandbackResult, error) {
	var res HandbackResult
	if !p.Generated {
		return res, fmt.Errorf("handback needs the platform Kubara generated, the one its Git repository holds; run kubara ... generate --helm in %s first", p.Source)
	}
	if len(p.Problems) > 0 {
		return res, fmt.Errorf("the plan has problems to fix first:\n  - %s", strings.Join(p.Problems, "\n  - "))
	}
	if opts.Gateway == "" {
		opts.Gateway = DefaultGateway
	}
	var hub string
	var clusters []string
	for _, st := range p.Stages {
		for _, cl := range st.Clusters {
			clusters = append(clusters, cl.Name)
			if cl.Type == "hub" {
				hub = cl.Name
			}
		}
	}
	charts := map[string]bool{}
	for _, c := range p.Components {
		if len(c.Variants) > 0 {
			charts[c.ChartPath] = true
		}
	}
	renders := map[string]map[string][]byte{}
	for _, cl := range clusters {
		r, err := opts.Render(p.Source, cl)
		if err != nil {
			return res, err
		}
		renders[cl] = r
	}
	argo, ok := renders[hub][unitArgoCD]
	if !ok {
		return res, fmt.Errorf("rendering produced no argo-cd for the hub %s", hub)
	}
	restore, err := PlanHandback(argo, charts, p.Prefix, opts.Gateway)
	if err != nil {
		return res, err
	}
	res.Restore = restore
	appsetOf := map[string]string{}
	for _, a := range restore.ApplicationSets {
		appsetOf[a.Chart] = a.Name
	}

	dir := filepath.Join(opts.Out, "handback")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, err
	}
	for _, o := range append(append([]Original{}, restore.ApplicationSets...), restore.Projects...) {
		if err := os.WriteFile(filepath.Join(dir, strings.ToLower(o.Kind)+"-"+o.Name+".json"), append(o.Spec, '\n'), 0o644); err != nil {
			return res, err
		}
	}
	type app struct{ name, file string }
	var apps []app
	for _, c := range p.Components {
		as, ok := appsetOf[c.ChartPath]
		if !ok || len(c.Variants) == 0 {
			continue
		}
		for _, v := range c.Variants {
			r, ok := renders[v.Cluster][c.ChartPath]
			if !ok {
				return res, fmt.Errorf("rendering produced no %s for %s", c.Name, v.Cluster)
			}
			inv, err := Inventory(r)
			if err != nil {
				return res, fmt.Errorf("%s on %s: %w", c.Name, v.Cluster, err)
			}
			file := filepath.Join("handback", c.Name, v.Cluster+".yaml")
			if err := os.MkdirAll(filepath.Join(opts.Out, "handback", c.Name), 0o755); err != nil {
				return res, err
			}
			if err := os.WriteFile(filepath.Join(opts.Out, file), inv, 0o644); err != nil {
				return res, err
			}
			apps = append(apps, app{v.Cluster + "-" + as, file})
			res.Applications = append(res.Applications, v.Cluster+"-"+as)
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].name < apps[j].name })

	var appsets, projects, appNames []string
	for _, a := range restore.ApplicationSets {
		appsets = append(appsets, a.Name)
	}
	for _, pr := range restore.Projects {
		projects = append(projects, pr.Name)
	}
	for _, a := range apps {
		appNames = append(appNames, a.name)
	}
	gw := "oci://" + opts.Gateway + "/"

	var s strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&s, format+"\n", args...) }
	fmt.Fprintf(&s, `#!/usr/bin/env bash
# Hand the Kubara hub in %s back to Git. Run it after handover.sh.
# Written by `+"`cub kubara handback`"+`. Read it, then run it:
#
#   HUB_CONTEXT=<kubectl context of Kubara's hub> bash handback.sh
#
# It changes only the hub. Each ApplicationSet below reads Kubara's Git
# sources again, as Kubara generated it:
#
`, p.Source)
	for _, a := range restore.ApplicationSets {
		fmt.Fprintf(&s, "#   %s\n", a.Name)
	}
	fmt.Fprintf(&s, `#
# The AppProject%s %s no longer permit%s the gateway, and argobot and the
# gateway credential leave the hub. Before any change, it checks that Argo CD
# would delete nothing. Secrets keep their live values: each ApplicationSet
# keeps the rule that leaves Secret data alone. ConfigHub keeps every Space and
# release, so handover.sh can hand the hub over again. Git must hold what you
# want Kubara to deliver: a change made in ConfigHub since handover is undone
# unless it is in Git too. All of it is safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${HUB_CONTEXT:+--context "$HUB_CONTEXT"} "$@"; }
step() { printf '\n== %%s\n' "$*"; }
# would_prune <application> <inventory>: fails, naming each object, when the
# Application manages something Kubara's Git render for it does not hold.
would_prune() {
  local app
  app=$(k -n %s get application "$1" -o json 2>/dev/null) || { echo "$1: not on the hub, nothing to prune"; return 0; }
  cub kubara would-prune --application <(printf '%%s' "$app") --release "$2" --name "$1"
}
reads() { k -n %s get application "$1" -o jsonpath='{.spec.sources[*].repoURL}{" "}{.spec.source.repoURL}' 2>/dev/null; }
# restore_appset <name>: the ApplicationSet's spec as Kubara generated it,
# unless it already reads Git and nothing else.
restore_appset() {
  local src
  src=$(k -n %s get applicationset "$1" -o jsonpath='{.spec.template.spec.source.repoURL}')
  [ -z "$src" ] && [ -n "$(k -n %s get applicationset "$1" -o jsonpath='{.spec.template.spec.sources}')" ] && return 0
  k -n %s patch applicationset "$1" --type=json -p "$(jq -c '[{op: "replace", path: "/spec", value: .}]' "handback/applicationset-$1.json")"
}
# A sync Argo CD started from ConfigHub names an OCI source or digest. After
# the switch it can never finish, because Argo CD retries it against Git.
confighub_operation() {
  local op t
  op=$(k -n %s get application "$1" -o jsonpath='{.status.operationState.phase} {.status.operationState.operation.sync.sources[*].repoURL} {.status.operationState.operation.sync.source.repoURL} {.status.operationState.operation.sync.revisions[*]} {.status.operationState.operation.sync.revision}' 2>/dev/null) || return 1
  read -ra op <<<"$op"
  [ "${op[0]:-}" = Running ] || return 1
  for t in "${op[@]:1}"; do
    case "$t" in oci://* | sha256:*) return 0 ;; esac
  done
  return 1
}

`, plural(len(projects)), strings.Join(projects, ", "), singular(len(projects)), argoNamespace, argoNamespace, argoNamespace, argoNamespace, argoNamespace, argoNamespace)

	line(`step "0/4 Check before changing anything"`)
	line(`command -v jq >/dev/null || { echo "handback.sh needs jq"; exit 1; }`)
	line("for a in %s; do", strings.Join(appsets, " "))
	line(`  k -n %s get applicationset "$a" >/dev/null || { echo "the hub has no ApplicationSet $a"; exit 1; }`, argoNamespace)
	line("done")
	line("# Kubara's ApplicationSets prune. Compare what each Application manages today")
	line("# with what Kubara's Git render holds for it, and stop if Argo CD would delete")
	line("# anything.")
	line("blocked=0")
	for _, a := range apps {
		line("would_prune %s %s || blocked=1", a.name, a.file)
	}
	line(`if [ "$blocked" = 1 ] && [ "${ALLOW_PRUNE:-}" != yes ]; then`)
	line(`  echo "Argo CD would delete the objects above. Put them in Git first, or rerun with ALLOW_PRUNE=yes to accept it."; exit 1`)
	line("fi")

	line("")
	line(`step "1/4 Kubara's ApplicationSets read Git again, argocd first"`)
	line("# Until the hub's argocd Application reads Git, Argo CD can write the routed")
	line("# ApplicationSets back from ConfigHub's release, so this repeats until every")
	line("# Application reads Git.")
	line("for _ in $(seq 1 60); do")
	line("  for a in %s; do restore_appset \"$a\"; done", strings.Join(appsets, " "))
	line("  left=0")
	line("  for app in %s; do", strings.Join(appNames, " "))
	line(`    case "$(reads "$app")" in *%s*) left=1; continue ;; esac`, gw)
	line(`    if confighub_operation "$app"; then`)
	line(`      echo "$app: stopping a sync Argo CD started from ConfigHub"`)
	line(`      k -n %s patch application "$app" --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}' >/dev/null`, argoNamespace)
	line("      left=1")
	line("    fi")
	line("  done")
	line(`  [ "$left" = 0 ] && break`)
	line("  sleep 5")
	line("done")
	line("for app in %s; do", strings.Join(appNames, " "))
	line(`  echo "$app reads $(reads "$app")"`)
	line("done")
	line(`[ "$left" = 0 ] || { echo "Some Applications still read ConfigHub. Re-run this script once the hub is idle."; exit 1; }`)

	line("")
	line(`step "2/4 The AppProject%s permit%s Kubara's sources only"`, plural(len(projects)), singular(len(projects)))
	for _, pr := range projects {
		line(`if k -n %s get appproject %s -o jsonpath='{.spec.sourceRepos}' | grep -q %s; then`, argoNamespace, pr, q(gw))
		line(`  k -n %s patch appproject %s --type=json -p "$(jq -c '[{op: "replace", path: "/spec", value: .}]' handback/appproject-%s.json)"`, argoNamespace, pr, pr)
		line("fi")
	}

	line("")
	line(`step "3/4 argobot and the gateway credential leave the hub"`)
	line("# argobot reports only Applications that read ConfigHub, so it has nothing left")
	line("# to report. Each variant Space keeps the last status it wrote.")
	line("k delete namespace %s --ignore-not-found", argobotNamespace)
	line("k -n %s delete role,rolebinding argobot --ignore-not-found", argoNamespace)
	line("k -n %s delete secret confighub-%s-targets --ignore-not-found", argoNamespace, p.Prefix)

	line("")
	line(`step "4/4 Argo CD syncs every Application from Git"`)
	line("# A sync from Git names commits, not OCI digests.")
	line("from_git() {")
	line(`  k -n %s get application "$1" -o json | jq -e '.status.sync.status == "Synced" and ([.status.sync.revision // empty, (.status.sync.revisions // [])[]] | length > 0 and all(startswith("sha256:") | not))' >/dev/null`, argoNamespace)
	line("}")
	line("for _ in $(seq 1 60); do")
	line("  left=0")
	line("  for app in %s; do", strings.Join(appNames, " "))
	line(`    from_git "$app" || left=1`)
	line("  done")
	line(`  [ "$left" = 0 ] && break`)
	line("  sleep 5")
	line("done")
	line("k -n %s get applications %s -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revisions[1]'", argoNamespace, strings.Join(appNames, " "))
	line(`[ "$left" = 0 ] || { echo "Some Applications have not synced from Git yet. Look at them with: kubectl -n %s describe application <name>"; exit 1; }`, argoNamespace)
	line("")
	line("echo")
	line(`echo "Done. Kubara's hub delivers from Git again. ConfigHub keeps every Space and"`)
	line(`echo "release; to hand the hub over again, run handover.sh."`)

	script := filepath.Join(opts.Out, "handback.sh")
	if err := os.WriteFile(script, []byte(s.String()), 0o755); err != nil {
		return res, err
	}
	res.Script = script
	return res, nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func singular(n int) string {
	if n == 1 {
		return "s"
	}
	return ""
}
