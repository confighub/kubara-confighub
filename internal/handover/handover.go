package handover

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/confighub/kubara-confighub/internal/plan"
)

const (
	unitArgoCD    = "argo-cd"
	workerSlug    = "server-worker"
	workflowSlug  = "rollout"
	argoNamespace = "argocd"
	// MinimumArgoCD is the first Argo CD release that reads plain manifests
	// from an OCI repository.
	MinimumArgoCD = "v3.1.0"
)

// HubRender renders the hub's argo-cd chart, whose ApplicationSets handover
// reads to learn which chart each one delivers.
type HubRender func(kubaraDir, cluster string) ([]byte, error)

type Options struct {
	Out     string
	Gateway string
	Render  HubRender
}

type Result struct {
	Script     string
	Routes     []Route
	WithKubara []string // components no ApplicationSet delivers, which stay with Kubara's bootstrap
	OnGit      []string // ApplicationSets for charts ConfigHub does not hold
	Projects   []string
}

// Write works out what handover changes and writes handover.sh, which runs
// after apply.sh.
func Write(p plan.Plan, opts Options) (Result, error) {
	var res Result
	if !p.Generated {
		return res, fmt.Errorf("handover needs a platform Kubara has generated; run kubara ... generate --helm in %s first", p.Source)
	}
	if len(p.Problems) > 0 {
		return res, fmt.Errorf("the plan has problems to fix first:\n  - %s", strings.Join(p.Problems, "\n  - "))
	}
	if opts.Gateway == "" {
		opts.Gateway = DefaultGateway
	}
	var hub string
	for _, st := range p.Stages {
		for _, cl := range st.Clusters {
			if cl.Type == "hub" {
				hub = cl.Name
			}
		}
	}
	var argo *plan.Component
	charts := map[string]bool{}
	byChart := map[string]plan.Component{}
	for i, c := range p.Components {
		if len(c.Variants) == 0 {
			continue
		}
		charts[c.ChartPath] = true
		byChart[c.ChartPath] = c
		if c.ChartPath == unitArgoCD {
			argo = &p.Components[i]
		}
	}
	if argo == nil {
		return res, fmt.Errorf("the plan holds no argo-cd component; handover points Kubara's hub Argo CD at ConfigHub, so the hub must run it")
	}
	render, err := opts.Render(p.Source, hub)
	if err != nil {
		return res, err
	}
	_, routed, err := RouteApplicationSets(render, charts, p.Prefix, opts.Gateway)
	if err != nil {
		return res, err
	}
	res.Routes, res.OnGit, res.Projects = routed.Routes, routed.OnGit, routed.Projects
	routedChart := map[string]Route{}
	for _, r := range routed.Routes {
		routedChart[r.Chart] = r
	}
	if _, ok := routedChart[unitArgoCD]; !ok {
		return res, fmt.Errorf("the hub's argo-cd render has no ApplicationSet for argo-cd itself, so the hub cannot be handed to ConfigHub")
	}
	// argo-cd goes last: the hub switches only once every release it will read exists.
	var comps []plan.Component
	for _, c := range p.Components {
		if len(c.Variants) == 0 {
			continue
		}
		if _, ok := routedChart[c.ChartPath]; !ok {
			res.WithKubara = append(res.WithKubara, c.Name)
			continue
		}
		if c.ChartPath != unitArgoCD {
			comps = append(comps, c)
		}
	}
	comps = append(comps, *argo)
	var chartList []string
	for _, c := range comps {
		chartList = append(chartList, c.ChartPath)
	}
	sort.Strings(chartList)

	if err := os.MkdirAll(filepath.Join(opts.Out, unitArgoCD), 0o755); err != nil {
		return res, err
	}
	if err := os.WriteFile(filepath.Join(opts.Out, "worker.json"), []byte(workerJSON), 0o644); err != nil {
		return res, err
	}
	if err := os.WriteFile(filepath.Join(opts.Out, "argobot.yaml"), []byte(argobotManifest()), 0o644); err != nil {
		return res, err
	}
	stageOf := map[string]string{}
	var clusters []string
	for _, st := range p.Stages {
		for _, cl := range st.Clusters {
			stageOf[cl.Name] = st.Name
			clusters = append(clusters, cl.Name)
		}
	}
	targets := p.Prefix + "-targets"
	argoBase := p.Prefix + "-" + unitArgoCD + "-base"
	hubArgo := p.Prefix + "-" + unitArgoCD + "-" + hub

	var s strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&s, format+"\n", args...) }
	s.WriteString(header(p, opts.Gateway, res))

	line(`step "0/6 Check before changing anything"`)
	line(`cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }`)
	var spaces []string
	for _, c := range comps {
		spaces = append(spaces, c.Base)
		for _, v := range c.Variants {
			spaces = append(spaces, v.Space)
		}
	}
	line("for space in %s; do", strings.Join(spaces, " "))
	line(`  cub space get "$space" --quiet >/dev/null 2>&1 || { echo "$space is missing: run apply.sh first"; exit 1; }`)
	line("done")
	line(`image=$(k -n %s get deployment -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].spec.template.spec.containers[0].image}')`, argoNamespace)
	line(`version=${image##*:}`)
	line(`if [ "$(printf '%%s\n' %s "$version" | sort -V | head -1)" != %s ]; then`, MinimumArgoCD, MinimumArgoCD)
	line(`  echo "the hub runs Argo CD $version; reading releases from ConfigHub's gateway needs %s or later"; exit 1`, MinimumArgoCD)
	line("fi")

	line("")
	line(`step "1/6 One Target per cluster, in %s"`, targets)
	line("cub space create %s --allow-exists --quiet", targets)
	line("cub worker create --space %s %s --filename worker.json --allow-exists --quiet", targets, workerSlug)
	for _, cl := range clusters {
		line("cub target create %s '{}' %s --space %s --provider OCI --toolchain Any --allow-exists --quiet", cl, workerSlug, targets)
	}

	line("")
	line(`step "2/6 Each variant releases to its own cluster's Target"`)
	for _, c := range comps {
		for _, v := range c.Variants {
			line("cub unit set-target --space %s %s %s/%s --quiet", v.Space, c.Name, targets, v.Cluster)
			line("cub space update %s --release-target %s/%s --quiet", v.Space, targets, v.Cluster)
		}
	}

	line("")
	line(`step "3/6 Kubara's ApplicationSets read ConfigHub: a change to the argo-cd base"`)
	line("cub unit data --space %s %s -O %s/current.yaml", argoBase, unitArgoCD, unitArgoCD)
	line("cub kubara route-appsets %s/current.yaml --prefix %s --gateway %s --charts %s > %s/routed.yaml", unitArgoCD, p.Prefix, opts.Gateway, strings.Join(chartList, ","), unitArgoCD)
	line("if cmp -s %s/current.yaml %s/routed.yaml; then", unitArgoCD, unitArgoCD)
	line("  echo 'the argo-cd base already points its ApplicationSets at ConfigHub'")
	line("else")
	line("  cub unit update --space %s %s %s/routed.yaml --change-desc %s --quiet", argoBase, unitArgoCD, unitArgoCD, q("Point Kubara's ApplicationSets at each cluster's approved release in ConfigHub, keeping live Secret values"))
	line("fi")

	line("")
	line(`step "4/6 Release each variant, stage by stage: promote, approve, publish"`)
	for _, c := range comps {
		var names []string
		for _, v := range c.Variants {
			names = append(names, v.Space)
		}
		// A component whose variants are all released is done: a change since
		// then is the platform's own, and may be part way through its stages.
		// argo-cd is the exception, because step 3 changes its base. Its change
		// order is named after the base's revision, so a re-run releases a
		// routing change it has not released yet.
		in := ""
		if c.ChartPath != unitArgoCD {
			in = "  "
			line("if released %s; then", strings.Join(names, " "))
			line("  echo %s", q(c.Name+": every variant has a release; later changes go through your own change orders"))
			line("else")
		}
		sum := sha256.Sum256([]byte("handover|" + c.Base + "|" + strings.Join(names, ",")))
		line(in+"order=handover-%x-r$(cub unit get --space %s %s -o jq=.Unit.HeadRevisionNum)", sum[:4], c.Base, c.Name)
		ref := c.Base + `/"$order"`
		line(in+`cub changeorder create --space %s "$order" --change-workflow %s/%s --description %s --allow-exists --quiet`, c.Base, c.Base, workflowSlug, q("Release "+strings.Join(names, ", ")+" for handover"))
		line(in+"if rolled_out %s; then", ref)
		line(in+"  echo %s", q(c.Name+": every variant is released"))
		line(in + "else")
		for _, st := range p.Stages {
			var inStage []string
			for _, v := range c.Variants {
				if stageOf[v.Cluster] == st.Name {
					inStage = append(inStage, v.Space)
				}
			}
			if len(inStage) == 0 {
				continue
			}
			line(in+"  cub variant promote --change-order %s --target-stage %s --quiet", ref, st.Name)
			line(in+"  cub variant approve --change-order %s --stage %s --quiet", ref, st.Name)
			for _, sp := range inStage {
				line(in+"  publish %s %s", sp, ref)
			}
		}
		line(in + "fi")
		if c.ChartPath != unitArgoCD {
			line("fi")
		}
	}

	line("")
	line(`step "5/6 Hand the hub to ConfigHub (your hub cluster)"`)
	line("# Kubara's ApplicationSets prune. Before any Application switches, compare")
	line("# what each one manages today with the release it will read, and stop if")
	line("# Argo CD would delete anything.")
	line("blocked=0")
	for _, c := range comps {
		r := routedChart[c.ChartPath]
		for _, v := range c.Variants {
			line("would_prune %s-%s %s %s || blocked=1", v.Cluster, r.ApplicationSet, v.Space, c.Name)
		}
	}
	line(`if [ "$blocked" = 1 ] && [ "${ALLOW_PRUNE:-}" != yes ]; then`)
	line(`  echo "Argo CD would delete the objects above. Fix the release, or rerun with ALLOW_PRUNE=yes to accept it."; exit 1`)
	line("fi")
	line("# Argo CD reads the gateway as the Targets' server worker: a credential that")
	line("# can pull only those Targets' releases. The ID and secret go from cub into")
	line("# the Secret through file descriptors, never to disk or the command line.")
	worker := fmt.Sprintf("cub worker get --space %s %s", targets, workerSlug)
	secret := "confighub-" + targets
	line(`k -n %s create secret generic %s \`, argoNamespace, secret)
	line(`  --from-literal=type=oci --from-literal=url=oci://%s/space/%s- \`, opts.Gateway, p.Prefix)
	line(`  --from-file=username=<(%s -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \`, worker)
	line(`  --from-file=password=<(%s --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \`, worker)
	line(`  --dry-run=client -o yaml | k label --local -f - argocd.argoproj.io/secret-type=repo-creds -o yaml | k apply -f -`)
	// The argo-cd ApplicationSet comes first: once the hub's argo-cd Application
	// reads its release, that release carries every other routed one.
	appsets := []string{routedChart[unitArgoCD].ApplicationSet}
	var apps []string
	for _, c := range comps {
		r := routedChart[c.ChartPath]
		if r.ApplicationSet != appsets[0] {
			appsets = append(appsets, r.ApplicationSet)
		}
		for _, v := range c.Variants {
			apps = append(apps, v.Cluster+"-"+r.ApplicationSet)
		}
	}
	line("# The change Kubara's Git does not make: each routed ApplicationSet reads")
	line("# ConfigHub, and its AppProject, applied first, permits it; Argo CD cannot")
	line("# sync the release that permits the gateway until the gateway is permitted.")
	line("# Server-side apply keeps fields other managers own, and Kubara's")
	line("# bootstrap owns each ApplicationSet's Git sources, which Argo CD reads before")
	line("# source. So each routed ApplicationSet also loses its sources.")
	line("drop_git_sources() {")
	line("  local a")
	line(`  for a in %s; do`, strings.Join(appsets, " "))
	line(`    [ -z "$(k -n %s get applicationset "$a" -o jsonpath='{.spec.template.spec.sources}')" ] ||`, argoNamespace)
	line(`      k -n %s patch applicationset "$a" --type=json -p '[{"op":"remove","path":"/spec/template/spec/sources"}]'`, argoNamespace)
	line("  done")
	line("}")
	line("cub unit data --space %s %s -O %s/released.yaml", hubArgo, unitArgoCD, unitArgoCD)
	line("cub kubara route-appsets %s/released.yaml --only %s | k apply --server-side --force-conflicts -f -", unitArgoCD, strings.Join(append(append([]string{}, routed.Used...), appsets...), ","))
	line("drop_git_sources")
	line("# An operation Argo CD started from Git names Git's sources. After the switch")
	line("# it can never finish, because Argo CD retries it against the ConfigHub source.")
	line("# The script stops it, as argocd app terminate-op does, and the automated sync")
	line("# starts again from ConfigHub. A Git sync that finishes first can write the Git")
	line("# sources back, so they are dropped again until every Application reads ConfigHub.")
	line("reads() { k -n %s get application \"$1\" -o jsonpath='{.spec.sources[*].repoURL}{.spec.source.repoURL}' 2>/dev/null; }", argoNamespace)
	line("# A sync names its sources, or at least its revisions: a Git sync has commit")
	line("# SHAs, and a sync of a ConfigHub release has an OCI digest.")
	line("git_operation() {")
	line("  local op t")
	line(`  op=$(k -n %s get application "$1" -o jsonpath='{.status.operationState.phase} {.status.operationState.operation.sync.sources[*].repoURL} {.status.operationState.operation.sync.source.repoURL} {.status.operationState.syncResult.sources[*].repoURL} {.status.operationState.syncResult.source.repoURL} {.status.operationState.operation.sync.revisions[*]} {.status.operationState.operation.sync.revision} {.status.operationState.syncResult.revisions[*]} {.status.operationState.syncResult.revision}' 2>/dev/null) || return 1`, argoNamespace)
	line(`  read -ra op <<<"$op"`)
	line(`  [ "${op[0]:-}" = Running ] || return 1`)
	line(`  for t in "${op[@]:1}"; do`)
	line(`    case "$t" in oci://* | sha256:*) ;; *) return 0 ;; esac`)
	line("  done")
	line("  return 1")
	line("}")
	line("for _ in $(seq 1 60); do")
	line("  drop_git_sources")
	line("  left=0")
	line("  for app in %s; do", strings.Join(apps, " "))
	line(`    case "$(reads "$app")" in oci://%s/*) ;; *) left=1; continue ;; esac`, opts.Gateway)
	line(`    if git_operation "$app"; then`)
	line(`      echo "$app: stopping a sync Argo CD started from Git"`)
	line(`      k -n %s patch application "$app" --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}' >/dev/null`, argoNamespace)
	line("      left=1")
	line("    fi")
	line("  done")
	line(`  [ "$left" = 0 ] && break`)
	line("  sleep 5")
	line("done")
	line("for app in %s; do", strings.Join(apps, " "))
	line(`  echo "$app reads $(reads "$app")"`)
	line("done")
	line(`[ "$left" = 0 ] || { echo "Some Applications do not read ConfigHub yet. Re-run this script once the hub is idle."; exit 1; }`)

	var variantSpaces []string
	for _, c := range comps {
		for _, v := range c.Variants {
			variantSpaces = append(variantSpaces, v.Space)
		}
	}
	line("")
	line(`step "6/6 argobot reports each Application's live status to its variant Space"`)
	line("# argobot runs as the Targets' server worker, the identity Argo CD already pulls")
	line("# releases with: it can read and annotate only the Spaces those Targets release.")
	line("# No personal token goes into the cluster. Its ID and secret go from cub into")
	line("# the Secret through file descriptors, as above.")
	line(`k create namespace %s --dry-run=client -o yaml | k apply -f - >/dev/null`, argobotNamespace)
	line(`k -n %s create secret generic %s \`, argobotNamespace, argobotSecret)
	line(`  --from-file=CONFIGHUB_URL=<(cub context get -o jq=.coordinate.serverURL | tr -d '\n') \`)
	line(`  --from-file=CONFIGHUB_WORKER_ID=<(%s -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \`, worker)
	line(`  --from-file=CONFIGHUB_WORKER_SECRET=<(%s --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \`, worker)
	line(`  --dry-run=client -o yaml | k apply -f -`)
	line("since=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)")
	line("k apply -f argobot.yaml")
	line("k -n %s rollout restart deployment/argobot >/dev/null", argobotNamespace)
	line(`k -n %s rollout status deployment/argobot --timeout=180s`, argobotNamespace)
	line("# argobot writes a Space's status when it starts, and again whenever the")
	line("# Application changes. Wait until each variant Space has one from this start;")
	line("# a Space keeps the last status an earlier argobot wrote.")
	line(`status() { cub space get "$1" -o 'jq=.Space.Annotations["%s"] // "{}" | fromjson | select((.observedAt // "") >= "'"$since"'") | tojson'; }`, LiveStatus)
	line("for _ in $(seq 1 60); do")
	line("  missing=0")
	line("  for space in %s; do", strings.Join(variantSpaces, " "))
	line(`    [ -n "$(status "$space")" ] || missing=1`)
	line("  done")
	line(`  [ "$missing" = 0 ] && break`)
	line("  sleep 5")
	line("done")
	line("for space in %s; do", strings.Join(variantSpaces, " "))
	line(`  s=$(status "$space")`)
	line(`  if [ -n "$s" ]; then`)
	line(`    printf '%%s: %%s\n' "$space" "$(jq -r '"\(.app) \(.syncStatus) \(.healthStatus) at \(.revision[0:19])"' <<<"$s")"`)
	line("  else")
	line(`    echo "$space: no live status yet"`)
	line("  fi")
	line("done")
	line(`[ "$missing" = 0 ] || { echo "argobot has not reported every Application. Look at: kubectl -n %s logs deployment/argobot"; exit 1; }`, argobotNamespace)
	line("")
	line("echo")
	line(`echo "Done. Kubara's hub now reads each cluster's approved release from ConfigHub,"`)
	line(`echo "and argobot writes each Application's sync and health to its variant Space."`)
	line(`echo "Watch it with: kubectl get applications -n %s"`, argoNamespace)
	line(`echo "A manual sync must keep RespectIgnoreDifferences, as Kubara's sync options do;"`)
	line(`echo "without it, Argo CD empties the values of the Secrets ConfigHub holds without values."`)

	script := filepath.Join(opts.Out, "handover.sh")
	if err := os.WriteFile(script, []byte(s.String()), 0o755); err != nil {
		return res, err
	}
	res.Script = script
	return res, nil
}

func header(p plan.Plan, gateway string, res Result) string {
	var b strings.Builder
	fmt.Fprintf(&b, `#!/usr/bin/env bash
# Hand the Kubara hub in %s to ConfigHub. Run it after apply.sh.
# Written by `+"`cub kubara handover`"+`. Read it, then run it:
#
#   HUB_CONTEXT=<kubectl context of Kubara's hub> bash handover.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# Kubara's hub, AppProject and ApplicationSets stay. Each ApplicationSet below
# reads the cluster's approved release from %s instead of Git:
#
`, p.Source, gateway)
	for _, r := range res.Routes {
		fmt.Fprintf(&b, "#   %-24s %s\n", r.ApplicationSet, r.RepoURL)
	}
	if len(res.WithKubara) > 0 {
		fmt.Fprintf(&b, "#\n# No ApplicationSet delivers %s; Kubara's bootstrap keeps it.\n", strings.Join(res.WithKubara, ", "))
	}
	b.WriteString(`#
# Steps 0 to 4 change only ConfigHub. Step 5 changes the hub, after checking
# that Argo CD would delete nothing: a credential for the gateway, the
# AppProject so it permits the gateway, and each routed ApplicationSet, which
# loses its Git sources. Secrets keep their live values: ConfigHub holds their keys,
# and each ApplicationSet tells Argo CD to leave their data alone. Step 6
# installs argobot (argobot.yaml) on the hub, which writes each Application's
# sync and health to its variant Space as ` + LiveStatus + `. All of it is
# safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${HUB_CONTEXT:+--context "$HUB_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# A finished change order is skipped, so a re-run releases only what is new.
rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }
# released <space>...: each Space has a published release. Once it has, later
# changes go through the platform's own change orders, not this script.
released() {
  local s
  for s in "$@"; do
    [ "$(cub release list --space "$s" -o 'jq=[.[]|select(.Release.Published)]|length')" -gt 0 ] || return 1
  done
}
publish() {
  local out
  out=$(cub release publish "$1" --revision "ChangeOrder:$2" --quiet 2>&1) && return 0
  case "$out" in *"no changes were made since :latest bundle"*) echo "$1 already released" ;; *) echo "$out" >&2; return 1 ;; esac
}
# would_prune <application> <space> <unit>: fails, naming each object, when
# the Application manages something the release it will read does not hold.
would_prune() {
  local app
  app=$(k -n argocd get application "$1" -o json 2>/dev/null) || { echo "$1: not on the hub, nothing to prune"; return 0; }
  cub kubara would-prune --application <(printf '%s' "$app") --release <(cub unit data --space "$2" "$3") --name "$1"
}

`)
	return b.String()
}

const workerJSON = `{
  "Slug": "server-worker",
  "OrgRole": "none",
  "ProvidedInfo": {
    "IsServerWorker": true,
    "BridgeWorkerInfo": {
      "SupportedConfigTypes": [
        {
          "ProviderType": "OCI",
          "ToolchainType": "Any"
        }
      ]
    }
  }
}
`

func q(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
