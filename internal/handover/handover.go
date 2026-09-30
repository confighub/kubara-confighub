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
	// ApproveStages are the stages handover.sh may approve as the person who
	// runs it. nil means every stage. In any other stage it promotes the
	// release and stops before publishing it, for someone else to approve.
	ApproveStages []string
}

type Result struct {
	Script     string
	Routes     []Route
	WithKubara []string // components no ApplicationSet delivers, which stay with Kubara's bootstrap
	OnGit      []string // ApplicationSets for charts ConfigHub does not hold
	Projects   []string
	Approves   []string // the stages handover.sh approves as the person who runs it
	Waits      []string // the stages where it stops for someone else's approval
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
	may, err := approvals(p, opts.ApproveStages)
	if err != nil {
		return res, err
	}
	for _, st := range p.Stages {
		if may[st.Name] {
			res.Approves = append(res.Approves, st.Name)
		} else {
			res.Waits = append(res.Waits, st.Name)
		}
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
		line(in+"order=$(handover_order %s %s handover-%x)", c.Base, c.Name, sum[:4])
		ref := c.Base + `/"$order"`
		line(in+`cub changeorder create --space %s "$order" --change-workflow %s/%s --description %s --allow-exists --quiet`, c.Base, c.Base, workflowSlug, q("Release "+strings.Join(names, ", ")+" for handover"))
		line(in+"if rolled_out %s; then", ref)
		line(in+"  echo %s", q(c.Name+": every variant is released"))
		line(in + "else")
		line(in + "  held=")
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
			who := "someone-else"
			if may[st.Name] {
				who = "me"
			}
			line(in+"  release_stage %s %s %s %s", ref, st.Name, who, strings.Join(inStage, " "))
		}
		line(in + "fi")
		if c.ChartPath != unitArgoCD {
			line("fi")
		}
	}
	line(`if [ -n "$waiting" ]; then`)
	line(`  echo`)
	line(`  echo "handover.sh stopped before it changed the hub. Kubara's hub still delivers from Git."`)
	line(`  echo "These releases wait for an approval from someone other than the person running"`)
	line(`  echo "this script. Once they have run each of these commands:"`)
	line(`  printf '%%s' "$waiting"`)
	line(`  echo "run handover.sh again. It resumes the same change orders, publishes what was"`)
	line(`  echo "approved, and then hands the hub over."`)
	line(`  exit 2`)
	line("fi")

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
	b.WriteString("#\n# Step 4 releases each variant, stage by stage.\n")
	if len(res.Approves) > 0 {
		fmt.Fprintf(&b, "# It approves each release as the person who runs it in: %s.\n", strings.Join(res.Approves, ", "))
	}
	if len(res.Waits) > 0 {
		fmt.Fprintf(&b, "# It approves nothing in: %s (--approve-stages).\n", strings.Join(res.Waits, ", "))
	}
	b.WriteString(`# Where a release still needs an approval, because this script may not give
# it or the workflow does not count it (apply --allow-authors=false), step 4
# promotes it, prints the cub variant approve command for someone else to
# run, and the script exits 2 before it changes the hub. Run it again once
# they have: it resumes the same change orders.
`)
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
# A change order every variant has released is skipped, so a re-run releases
# only what is new.
rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.State)" = Released ]; }
# handover_order <base> <unit> <prefix>: the change order that releases the
# base's variants. One this script started and has not finished is resumed, so
# what someone approved is what gets published. Otherwise a new one is named
# after the base's head revision.
handover_order() {
  local pending
  pending=$(cub changeorder list --space "$1" --where "Slug LIKE '$3-r%'" \
    -o 'jq=[.[] | select(.ChangeOrder.State != "Released" and (.ChangeOrder.AbortedReason // "") == "")] | sort_by(.ChangeOrder.CreatedAt) | last | .ChangeOrder.Slug // ""')
  if [ -n "$pending" ]; then echo "$pending"; else echo "$3-r$(cub unit get --space "$1" "$2" -o jq=.Unit.HeadRevisionNum)"; fi
}
# has <Resolved|Released> <change order> <space>...: each Space has taken the
# change order (Resolved), or released it (Released).
has() {
  local ids s
  ids=" $(cub changeorder get --space "${2%/*}" "${2#*/}" -o "jq=.ChangeOrder.$1SpaceIDs // [] | join(\" \")") "
  shift 2
  for s in "$@"; do
    case "$ids" in *" $(cub space get "$s" -o jq=.Space.SpaceID) "*) ;; *) return 1 ;; esac
  done
}
# release_stage <change order> <stage> <me|someone-else> <space>...: promote the
# change order into the stage, approve it there if this script may, and publish
# each Space. When the stage still needs an approval, from someone else or
# because the workflow does not count yours, it notes the command to run and
# leaves this component's later stages alone.
waiting=
held=
release_stage() {
  local ref=$1 stage=$2 who=$3 s out
  shift 3
  [ -z "$held" ] || return 0
  if has Released "$ref" "$@"; then echo "$ref: $stage has released it"; return 0; fi
  # A stage that has taken the change order is not promoted again: once the
  # last stage has it, ConfigHub refuses another promotion. Nor is it
  # approved again.
  if ! has Resolved "$ref" "$@"; then
    cub variant promote --change-order "$ref" --target-stage "$stage" --quiet
    if [ "$who" = me ]; then cub variant approve --change-order "$ref" --stage "$stage" --quiet; fi
  fi
  for s in "$@"; do
    if ! out=$(publish "$s" "$ref" 2>&1); then
      case "$out" in
        *"requires approval"*)
          echo "$s waits for an approval in $stage"
          held=$ref
          waiting="$waiting  cub variant approve --change-order $ref --stage $stage
"
          return 0 ;;
        *) echo "$out" >&2; return 1 ;;
      esac
    fi
    [ -z "$out" ] || echo "$out"
  done
}
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

// approvals says which stages handover.sh may approve as the person who runs
// it: every stage when none are named, or exactly the ones named.
func approvals(p plan.Plan, named []string) (map[string]bool, error) {
	may := map[string]bool{}
	var all []string
	for _, st := range p.Stages {
		all = append(all, st.Name)
		may[st.Name] = named == nil
	}
	for _, n := range named {
		if _, ok := may[n]; !ok {
			return nil, fmt.Errorf("--approve-stages names %s, which is not a stage of this platform; its stages are %s", n, strings.Join(all, ", "))
		}
		may[n] = true
	}
	return may, nil
}
