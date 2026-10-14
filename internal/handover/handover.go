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
	Gateway string // --gateway: a host, or an http:// URL for a plain-HTTP registry
	Render  HubRender
	// ConfigHubURL is the address argobot reaches ConfigHub at from the hub.
	// Empty means the server of cub's current context, which is right unless
	// the hub reaches ConfigHub by another name, as a kind cluster reaches a
	// ConfigHub on your own machine.
	ConfigHubURL string
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
	gw, err := ParseGateway(opts.Gateway)
	if err != nil {
		return res, err
	}
	opts.Gateway = gw.Host
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
	if err := os.WriteFile(filepath.Join(opts.Out, "argobot.yaml"), []byte(argobotManifest(p.Prefix+"-targets")), 0o644); err != nil {
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
	s.WriteString(header(p, gw, res))

	line(`step "0/6 Check before changing anything"`)
	line(`cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }`)
	line(`for tool in jq openssl; do command -v "$tool" >/dev/null || { echo "this script needs $tool"; exit 1; }; done`)
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
	line("# Service accounts, which the Targets grant and argobot runs as, came with")
	line("# cub and ConfigHub %s.", MinimumCub)
	line("# A build that names no version is let through.")
	line("# awk reads all of what cub prints: ending early would end cub with a broken")
	line("# pipe, which pipefail reports as a failure. The first version is cub's own.")
	line(`cub_version=$(cub version 2>/dev/null | awk '$1 == "Version:" && $2 ~ /^v[0-9]/ && !seen {print $2; seen = 1}')`)
	line(`if [ -n "$cub_version" ] && [ "$(printf '%%s\n' %s "$cub_version" | sort -V | head -1)" != %s ]; then`, MinimumCub, MinimumCub)
	line(`  echo "cub is $cub_version; this script needs %s or later, and ConfigHub %s or later: run cub upgrade"; exit 1`, MinimumCub, MinimumCub)
	line("fi")
	line(`image=$(k -n %s get deployment -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].spec.template.spec.containers[0].image}')`, argoNamespace)
	line(`version=${image##*:}`)
	line(`if [ "$(printf '%%s\n' %s "$version" | sort -V | head -1)" != %s ]; then`, MinimumArgoCD, MinimumArgoCD)
	line(`  echo "the hub runs Argo CD $version; reading releases from ConfigHub's gateway needs %s or later"; exit 1`, MinimumArgoCD)
	line("fi")

	line("")
	line(`step "1/6 One Target per cluster, in %s"`, targets)
	line("cub space create %s --allow-exists --quiet", targets)
	pull, bot := pullAccount(p.Prefix), botAccount(p.Prefix)
	line("# Two service accounts, neither with a role in the organization:")
	line("# - %s, which Argo CD pulls the gateway with: View finds each Target,", pull)
	line("#   ViewChildren pulls the releases published for it;")
	line("# - %s, which argobot runs as: the same, and EditChildren, which is what", bot)
	line("#   lets it record a release's live status.")
	line("# Two, so that the token in Argo CD's repository Secret cannot write live status.")
	line("cub serviceaccount create %s --allow-exists --quiet", pull)
	line("cub serviceaccount create %s --allow-exists --quiet", bot)
	for _, cl := range clusters {
		line("cub target create %s --space %s --allow-exists --quiet", cl, targets)
	}
	line("# The grants, as an update, so a Target an earlier run made gets them too.")
	line("for t in %s; do", strings.Join(clusters, " "))
	line(`  cub target update "$t" --space %[1]s --permission View:serviceaccount:%[2]s --permission ViewChildren:serviceaccount:%[2]s \`, targets, pull)
	line(`    --permission View:serviceaccount:%[1]s --permission ViewChildren:serviceaccount:%[1]s --permission EditChildren:serviceaccount:%[1]s --quiet`, bot)
	line("done")

	line("")
	line(`step "2/6 Each variant releases to its own cluster's Target"`)
	for _, c := range comps {
		for _, v := range c.Variants {
			line("cub unit set-target --space %s %s %s/%s --quiet", v.Space, c.Name, targets, v.Cluster)
			line(`cub space update %s --release-target %s/%s --quiet`, v.Space, targets, v.Cluster)
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
		// From ConfigHub v0.9.2 a change order that a variant took nothing from
		// reads Released though nothing was published, so a variant counts as
		// released only once it has a published release.
		line(in+"if rolled_out %s && released %s; then", ref, strings.Join(names, " "))
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
	secret := "confighub-" + targets
	desc := fmt.Sprintf("Argo CD on Kubara's hub, %s", p.Prefix)
	line("# Argo CD reads the gateway with a token of %s, which can pull only these", pull)
	line("# Targets' releases: the username is the word token, the password the token.")
	line("# A token the Secret already holds is kept while ConfigHub still lists it;")
	line("# otherwise a new one is issued, and the others this script issued for this")
	line("# hub are revoked once the Secret holds the new one. The token goes from cub")
	line("# into the Secret through variables and a file descriptor, never to disk or")
	line("# the command line.")
	line(`held_jti=$(k -n %s get secret %s -o jsonpath='{.metadata.annotations.confighub\.com/token-jti}' 2>/dev/null || true)`, argoNamespace, secret)
	line(`token=""; jti=""`)
	line(`if [ -n "$held_jti" ] && cub serviceaccount token list %s -o json | live_tokens | jq -e --arg j "$held_jti" 'any(.[]; .Jti == $j)' >/dev/null; then`, pull)
	line(`  token=$(k -n %s get secret %s -o jsonpath='{.data.password}' | base64 --decode)`, argoNamespace, secret)
	line(`  jti=$held_jti`)
	line(`  echo "the repository Secret's token of %s is still valid: kept"`, pull)
	line("fi")
	line(`if [ -z "$token" ]; then`)
	line(`  issued=$(cub serviceaccount token create %s --description %s -o json) || { no_impersonate %s; exit 1; }`, pull, q(desc), pull)
	line(`  token=$(printf '%%s' "$issued" | jq -r '.Token // empty'); jti=$(printf '%%s' "$issued" | jq -r '.UserToken.Jti // empty')`)
	line(`  [ -n "$token" ] && [ -n "$jti" ] || { echo "ConfigHub returned no token of %s"; exit 1; }`, pull)
	line("fi")
	line(`k -n %s create secret generic %s \`, argoNamespace, secret)
	line(`  --from-literal=type=oci --from-literal=url=oci://%s/space/%s- \`, opts.Gateway, p.Prefix)
	if gw.PlainHTTP {
		line(`  --from-literal=insecureOCIForceHttp=true \`)
	}
	line(`  --from-literal=username=token --from-file=password=<(printf '%%s' "$token") \`)
	line(`  --dry-run=client -o yaml | k label --local -f - argocd.argoproj.io/secret-type=repo-creds -o yaml \`)
	line(`  | k annotate --local -f - confighub.com/token-jti="$jti" -o yaml | k apply -f -`)
	line(`unset token issued`)
	line(`{ cub serviceaccount token list %[1]s -o json || { echo "could not list the tokens of %[1]s, so earlier ones are not revoked" >&2; echo '[]'; }; } | live_tokens | jq -r --arg d %[2]s --arg j "$jti" '.[] | select(.Description == $d and .Jti != $j) | .Jti' |`, pull, q(desc))
	line(`  while read -r old; do cub serviceaccount token revoke %[1]s "$old" --quiet && echo "revoked an earlier token of %[1]s" || echo "could not revoke an earlier token of %[1]s: cub serviceaccount token revoke %[1]s $old"; done`, pull)
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
	line(`step "6/6 argobot records each Application's live status on the release it synced"`)
	keyDesc := fmt.Sprintf("argobot on Kubara's hub, %s", p.Prefix)
	line("# argobot runs as %s, which step 1 gave EditChildren on each Target, and", bot)
	line("# hears of each published release on the Channel %s/argobot.", targets)
	line("# A Channel made for an earlier %s, deleted and made again since, names", bot)
	line("# that account's old identity. Adding the new one takes Claim on the Channel,")
	line("# which its maker does not have, so such a Channel is made again instead.")
	line(`bot_uid=$(cub serviceaccount get %s -o jq=.ServiceAccount.UserID | tr -d '"')`, bot)
	line(`make_channel() { echo '[{"EventTypes":["release.published"]}]' | cub channel create argobot --space %s --subscriptions - --permission Claim:serviceaccount:%s --quiet; }`, targets, bot)
	line(`if claims=$(cub channel get %s/argobot -o 'jq=.Channel.Permissions.Claim.UserIDs // {} | keys | join(" ")' 2>/dev/null); then`, targets)
	line(`  case " $(printf '%%s' "$claims" | tr -d '"') " in`)
	line(`    *" $bot_uid "*) ;;`)
	line(`    *) cub channel update %[1]s/argobot --patch --permission Claim:serviceaccount:%[2]s --quiet 2>/dev/null || { cub channel delete %[1]s/argobot --quiet && make_channel; } ;;`, targets, bot)
	line("  esac")
	line("else")
	line("  make_channel")
	line("fi")
	line("# Its credential is a key of %s; ConfigHub keeps only the public half. A key", bot)
	line("# argobot's Secret already holds is kept while ConfigHub still lists it. One it")
	line("# no longer lists, after the account was deleted and made again say, is")
	line("# replaced, and so are keys this script added earlier for this hub.")
	line(`k create namespace %s --dry-run=client -o yaml | k apply -f - >/dev/null`, argobotNamespace)
	line(`key=$(k -n %s get secret %s -o jsonpath='{.data.CONFIGHUB_AUTH_PRIVATE_KEY}' 2>/dev/null | base64 --decode 2>/dev/null || true)`, argobotNamespace, argobotSecret)
	line(`kid=""; [ -z "$key" ] || kid=$(printf '%%s' "$key" | thumbprint 2>/dev/null) || kid=""`)
	line(`if [ -n "$kid" ] && cub serviceaccount key list %s -o json | jq -e --arg k "$kid" 'any(.[].UserKey; .Kid == $k)' >/dev/null; then`, bot)
	line(`  echo "argobot's key of %s is still registered: kept"`, bot)
	line("else")
	line(`  key_dir=$(mktemp -d)`)
	line(`  trap 'rm -rf "$key_dir"' EXIT`)
	line(`  cub serviceaccount key add %s --generate "$key_dir/argobot.jwk" --description %s >/dev/null || { no_impersonate %s; exit 1; }`, bot, q(keyDesc), bot)
	line(`  key=$(cat "$key_dir/argobot.jwk"); kid=$(printf '%%s' "$key" | thumbprint)`)
	line(`  rm -rf "$key_dir"`)
	line("fi")
	line(`k -n %s create secret generic %s \`, argobotNamespace, argobotSecret)
	if opts.ConfigHubURL != "" {
		line(`  --from-literal=CONFIGHUB_URL=%s \`, q(opts.ConfigHubURL))
	} else {
		line(`  --from-file=CONFIGHUB_URL=<(cub context get -o jq=.coordinate.serverURL | tr -d '\n') \`)
	}
	line(`  --from-file=CONFIGHUB_AUTH_PRIVATE_KEY=<(printf '%%s' "$key") \`)
	line(`  --dry-run=client -o yaml | k apply -f -`)
	line(`unset key`)
	line(`{ cub serviceaccount key list %[1]s -o json || { echo "could not list the keys of %[1]s, so earlier ones are not removed" >&2; echo '[]'; }; } | jq -r --arg d %[2]s --arg k "$kid" '.[].UserKey | select(.Description == $d and .Kid != $k) | .Kid' |`, bot, q(keyDesc))
	line(`  while read -r old; do cub serviceaccount key delete %[1]s "$old" >/dev/null && echo "removed an earlier key of %[1]s" || echo "could not remove an earlier key of %[1]s: cub serviceaccount key delete %[1]s $old"; done`, bot)
	line("since=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)")
	line("k apply -f argobot.yaml")
	line("k -n %s rollout restart deployment/argobot >/dev/null", argobotNamespace)
	line(`k -n %s rollout status deployment/argobot --timeout=180s || { echo "argobot did not start. What it said: kubectl -n %s logs deployment/argobot"; exit 1; }`, argobotNamespace, argobotNamespace)
	line("# argobot records a release's status when it starts, and again whenever the")
	line("# Application changes. Wait until each variant Space's newest published")
	line("# release, the one the Healthy gate reads, has one from this start; a release")
	line("# keeps the last status an earlier argobot recorded.")
	line(`status() { cub release list --space "$1" --where "Published = true" -o 'jq=[.[].Release] | max_by(.ReleaseNum) | select((.LiveStatus.ObservedAt // "")[0:19] >= "'"${since%%Z}"'") | {ReleaseNum, LiveStatus} | tojson'; }`)
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
	line(`    printf '%%s: %%s\n' "$space" "$(jq -r '"release \(.ReleaseNum) \(.LiveStatus.Sync) \(.LiveStatus.Health), from \(.LiveStatus.Reporter)"' <<<"$s")"`)
	line("  else")
	line(`    echo "$space: no live status yet"`)
	line("  fi")
	line("done")
	line(`[ "$missing" = 0 ] || { echo "argobot has not reported every Application. Look at: kubectl -n %s logs deployment/argobot"; exit 1; }`, argobotNamespace)
	line("")
	line("echo")
	line(`echo "Done. Kubara's hub now reads each cluster's approved release from ConfigHub,"`)
	line(`echo "and argobot records each Application's sync and health on the release it synced."`)
	line(`echo "See it with: cub release list --space <a variant Space>"`)
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

func header(p plan.Plan, gw Gateway, res Result) string {
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
`, p.Source, gw.Host)
	for _, r := range res.Routes {
		fmt.Fprintf(&b, "#   %-24s %s\n", r.ApplicationSet, r.RepoURL)
	}
	if len(res.WithKubara) > 0 {
		fmt.Fprintf(&b, "#\n# No ApplicationSet delivers %s; Kubara's bootstrap keeps it.\n", strings.Join(res.WithKubara, ", "))
	}
	if gw.PlainHTTP {
		fmt.Fprintf(&b, "#\n# %s serves plain HTTP, so the gateway credential tells Argo CD not to use TLS.\n", gw.Host)
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
# installs argobot (argobot.yaml) on the hub, which records each Application's
# sync and health on the release it synced, in its variant Space. All of it is
# safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${HUB_CONTEXT:+--context "$HUB_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# Issuing a token or a key of a service account is acting as it, which takes
# Impersonate on it. Whoever created it has that; Manage does not include it.
no_impersonate() {
  echo "could not issue a credential of the service account $1 (the reason is above)."
  echo "Issuing one takes Impersonate on it, which whoever created it has, and Manage"
  echo "does not include. Someone who has it can give it to you:"
  echo "  cub serviceaccount update --patch $1 --permission Impersonate:<your user>"
}
# The tokens of a service account that still work: token list shows revoked
# and expired ones too.
live_tokens() { jq -c '[.[].UserToken | select((.RevokedAt // "") == "" and ((.ExpiresAt // "") == "" or ((.ExpiresAt | sub("\\.[0-9]+"; "")) | fromdateiso8601) > now))]'; }
# The id ConfigHub lists a key by: the RFC 7638 thumbprint of its public half.
thumbprint() { jq -j '"{\"crv\":\"\(.crv)\",\"kty\":\"\(.kty)\",\"x\":\"\(.x)\"}"' | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='; }
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
  if has Released "$ref" "$@"; then
    first_release "$ref" "$stage" "$who" "$@"
    return 0
  fi
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
        *"is someone else's to publish"*)
          echo "$s waits for its first release in $stage"
          held=$ref
          waiting="$waiting  cub release publish $s
"
          return 0 ;;
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
# first_release <change order> <stage> <me|someone-else> <space>...: the change
# order counts each Space as released. A Space it carries no change for, because
# the variant already holds every revision of its base, counts too, though it
# may never have published a release, and a release by the change order then
# has no revision to approve. Such a Space's first release is its variant as
# apply.sh made it: the script publishes it where it may approve, and
# elsewhere notes the command for someone else to run.
first_release() {
  local ref=$1 stage=$2 who=$3 s
  shift 3
  for s in "$@"; do
    if released "$s"; then echo "$ref: $stage has released it in $s"; continue; fi
    if [ "$who" = me ]; then
      echo "$s: $ref carries no change for it; publishing its first release"
      cub release publish "$s" --quiet
    else
      echo "$s waits for its first release in $stage"
      held=$ref
      waiting="$waiting  cub release publish $s
"
      return 0
    fi
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
  case "$out" in
    *"no changes were made since :latest bundle"*) echo "$1 already released" ;;
    *"no Revision was found to evaluate it on"*|*"marks no revision of a unit that has been released"*) publish_taken "$1" "$2" "$out" ;;
    *) echo "$out" >&2; return 1 ;;
  esac
}
# publish_taken <space> <change order> <refusal>: a variant gets the base's head
# when it is made, so its first change order takes nothing from the base, and
# from ConfigHub v0.9.2 there is then no revision to release by it. When the
# change order passed over every unit of the base as AlreadyTaken, the variant
# is released as it stands, which is what Git delivers today, where this script
# may approve; elsewhere it notes the command for someone else. Any other
# refusal stops the script.
publish_taken() {
  local skipped id out
  skipped=" $(cub changeorder get --space "${2%/*}" "${2#*/}" -o 'jq=(.ChangeOrder.SkippedUnits // {}) | to_entries | map(.key + "=" + .value) | join(" ")' | tr -d '"') "
  for id in $(cub unit list --space "${2%/*}" -o 'jq=[.[].Unit.UnitID] | join(" ")' | tr -d '"'); do
    case "$skipped" in *" $id=AlreadyTaken "*) ;; *) echo "$3" >&2; return 1 ;; esac
  done
  # In a stage this script may not approve, the first release is someone
  # else's to publish, as first_release leaves it. publish runs in a
  # subshell, so release_stage records the hold.
  if [ "${who:-me}" != me ]; then echo "the first release of $1 is someone else's to publish"; return 1; fi
  out=$(cub release publish "$1" --quiet 2>&1) && { echo "$1: the change order carried nothing new for it, so it is released as it stands"; return 0; }
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
