#!/usr/bin/env bash
# Hand the Kubara hub in ../apply/testdata/platform to ConfigHub. Run it after apply.sh.
# Written by `cub kubara handover`. Read it, then run it:
#
#   HUB_CONTEXT=<kubectl context of Kubara's hub> bash handover.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# Kubara's hub, AppProject and ApplicationSets stay. Each ApplicationSet below
# reads the cluster's approved release from oci.hub.confighub.com instead of Git:
#
#   argocd                   oci://oci.hub.confighub.com/space/kx-argo-cd-{{name}}
#   homer-dashboard          oci://oci.hub.confighub.com/space/kx-homer-dashboard-{{name}}
#   traefik                  oci://oci.hub.confighub.com/space/kx-traefik-{{name}}
#
# No ApplicationSet delivers bootstrap-crds; Kubara's bootstrap keeps it.
#
# Step 4 releases each variant, stage by stage.
# It approves each release as the person who runs it in: dev, prod.
# Where a release still needs an approval, because this script may not give
# it or the workflow does not count it (apply --allow-authors=false), step 4
# promotes it, prints the cub variant approve command for someone else to
# run, and the script exits 2 before it changes the hub. Run it again once
# they have: it resumes the same change orders.
#
# Steps 0 to 4 change only ConfigHub. Step 5 changes the hub, after checking
# that Argo CD would delete nothing: a credential for the gateway, the
# AppProject so it permits the gateway, and each routed ApplicationSet, which
# loses its Git sources. Secrets keep their live values: ConfigHub holds their keys,
# and each ApplicationSet tells Argo CD to leave their data alone. Step 6
# installs argobot (argobot.yaml) on the hub, which writes each Application's
# sync and health to its variant Space as confighub.com/live-status. All of it is
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

step "0/6 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
for space in kx-traefik-base kx-traefik-hub kx-traefik-edge kx-homer-dashboard-base kx-homer-dashboard-hub kx-argo-cd-base kx-argo-cd-hub; do
  cub space get "$space" --quiet >/dev/null 2>&1 || { echo "$space is missing: run apply.sh first"; exit 1; }
done
image=$(k -n argocd get deployment -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].spec.template.spec.containers[0].image}')
version=${image##*:}
if [ "$(printf '%s\n' v3.1.0 "$version" | sort -V | head -1)" != v3.1.0 ]; then
  echo "the hub runs Argo CD $version; reading releases from ConfigHub's gateway needs v3.1.0 or later"; exit 1
fi

step "1/6 One Target per cluster, in kx-targets"
cub space create kx-targets --allow-exists --quiet
# A Target names no worker. The server worker is the identity Argo CD pulls
# as, and it reaches a Target through a grant to its bot user: View to find
# the Target, and ViewChildren to pull the releases published for it.
cub worker create --space kx-targets server-worker --is-server-worker --org-role none --allow-exists --quiet
bot_user=$(cub worker get --space kx-targets server-worker -o jq=.BridgeWorker.UserID | tr -d '"\n')
[ -n "$bot_user" ] && [ "$bot_user" != null ] || { echo "the worker kx-targets/server-worker has no bot user to grant the Targets to"; exit 1; }
cub target create hub --space kx-targets --permission "View:$bot_user" --permission "ViewChildren:$bot_user" --allow-exists --quiet
cub target create edge --space kx-targets --permission "View:$bot_user" --permission "ViewChildren:$bot_user" --allow-exists --quiet

step "2/6 Each variant releases to its own cluster's Target"
cub unit set-target --space kx-traefik-hub traefik kx-targets/hub --quiet
cub space update kx-traefik-hub --release-target kx-targets/hub --permission "Edit:$bot_user" --quiet
cub unit set-target --space kx-traefik-edge traefik kx-targets/edge --quiet
cub space update kx-traefik-edge --release-target kx-targets/edge --permission "Edit:$bot_user" --quiet
cub unit set-target --space kx-homer-dashboard-hub homer-dashboard kx-targets/hub --quiet
cub space update kx-homer-dashboard-hub --release-target kx-targets/hub --permission "Edit:$bot_user" --quiet
cub unit set-target --space kx-argo-cd-hub argo-cd kx-targets/hub --quiet
cub space update kx-argo-cd-hub --release-target kx-targets/hub --permission "Edit:$bot_user" --quiet

step "3/6 Kubara's ApplicationSets read ConfigHub: a change to the argo-cd base"
cub unit data --space kx-argo-cd-base argo-cd -O argo-cd/current.yaml
cub kubara route-appsets argo-cd/current.yaml --prefix kx --gateway oci.hub.confighub.com --charts argo-cd,homer-dashboard,traefik > argo-cd/routed.yaml
if cmp -s argo-cd/current.yaml argo-cd/routed.yaml; then
  echo 'the argo-cd base already points its ApplicationSets at ConfigHub'
else
  cub unit update --space kx-argo-cd-base argo-cd argo-cd/routed.yaml --change-desc 'Point Kubara'\''s ApplicationSets at each cluster'\''s approved release in ConfigHub, keeping live Secret values' --quiet
fi

step "4/6 Release each variant, stage by stage: promote, approve, publish"
if released kx-traefik-hub kx-traefik-edge; then
  echo 'traefik: every variant has a release; later changes go through your own change orders'
else
  order=$(handover_order kx-traefik-base traefik handover-e84ab4de)
  cub changeorder create --space kx-traefik-base "$order" --change-workflow kx-traefik-base/rollout --description 'Release kx-traefik-hub, kx-traefik-edge for handover' --allow-exists --quiet
  if rolled_out kx-traefik-base/"$order"; then
    echo 'traefik: every variant is released'
  else
    held=
    release_stage kx-traefik-base/"$order" dev me kx-traefik-hub
    release_stage kx-traefik-base/"$order" prod me kx-traefik-edge
  fi
fi
if released kx-homer-dashboard-hub; then
  echo 'homer-dashboard: every variant has a release; later changes go through your own change orders'
else
  order=$(handover_order kx-homer-dashboard-base homer-dashboard handover-0d585623)
  cub changeorder create --space kx-homer-dashboard-base "$order" --change-workflow kx-homer-dashboard-base/rollout --description 'Release kx-homer-dashboard-hub for handover' --allow-exists --quiet
  if rolled_out kx-homer-dashboard-base/"$order"; then
    echo 'homer-dashboard: every variant is released'
  else
    held=
    release_stage kx-homer-dashboard-base/"$order" dev me kx-homer-dashboard-hub
  fi
fi
order=$(handover_order kx-argo-cd-base argo-cd handover-dec294e7)
cub changeorder create --space kx-argo-cd-base "$order" --change-workflow kx-argo-cd-base/rollout --description 'Release kx-argo-cd-hub for handover' --allow-exists --quiet
if rolled_out kx-argo-cd-base/"$order"; then
  echo 'argo-cd: every variant is released'
else
  held=
  release_stage kx-argo-cd-base/"$order" dev me kx-argo-cd-hub
fi
if [ -n "$waiting" ]; then
  echo
  echo "handover.sh stopped before it changed the hub. Kubara's hub still delivers from Git."
  echo "These releases wait for an approval from someone other than the person running"
  echo "this script. Once they have run each of these commands:"
  printf '%s' "$waiting"
  echo "run handover.sh again. It resumes the same change orders, publishes what was"
  echo "approved, and then hands the hub over."
  exit 2
fi

step "5/6 Hand the hub to ConfigHub (your hub cluster)"
# Kubara's ApplicationSets prune. Before any Application switches, compare
# what each one manages today with the release it will read, and stop if
# Argo CD would delete anything.
blocked=0
would_prune hub-traefik kx-traefik-hub traefik || blocked=1
would_prune edge-traefik kx-traefik-edge traefik || blocked=1
would_prune hub-homer-dashboard kx-homer-dashboard-hub homer-dashboard || blocked=1
would_prune hub-argocd kx-argo-cd-hub argo-cd || blocked=1
if [ "$blocked" = 1 ] && [ "${ALLOW_PRUNE:-}" != yes ]; then
  echo "Argo CD would delete the objects above. Fix the release, or rerun with ALLOW_PRUNE=yes to accept it."; exit 1
fi
# Argo CD reads the gateway as the Targets' server worker: a credential that
# can pull only those Targets' releases. The ID and secret go from cub into
# the Secret through file descriptors, never to disk or the command line.
k -n argocd create secret generic confighub-kx-targets \
  --from-literal=type=oci --from-literal=url=oci://oci.hub.confighub.com/space/kx- \
  --from-file=username=<(cub worker get --space kx-targets server-worker -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \
  --from-file=password=<(cub worker get --space kx-targets server-worker --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \
  --dry-run=client -o yaml | k label --local -f - argocd.argoproj.io/secret-type=repo-creds -o yaml | k apply -f -
# The change Kubara's Git does not make: each routed ApplicationSet reads
# ConfigHub, and its AppProject, applied first, permits it; Argo CD cannot
# sync the release that permits the gateway until the gateway is permitted.
# Server-side apply keeps fields other managers own, and Kubara's
# bootstrap owns each ApplicationSet's Git sources, which Argo CD reads before
# source. So each routed ApplicationSet also loses its sources.
drop_git_sources() {
  local a
  for a in argocd traefik homer-dashboard; do
    [ -z "$(k -n argocd get applicationset "$a" -o jsonpath='{.spec.template.spec.sources}')" ] ||
      k -n argocd patch applicationset "$a" --type=json -p '[{"op":"remove","path":"/spec/template/spec/sources"}]'
  done
}
cub unit data --space kx-argo-cd-hub argo-cd -O argo-cd/released.yaml
cub kubara route-appsets argo-cd/released.yaml --only hx-dev-dev,argocd,traefik,homer-dashboard | k apply --server-side --force-conflicts -f -
drop_git_sources
# An operation Argo CD started from Git names Git's sources. After the switch
# it can never finish, because Argo CD retries it against the ConfigHub source.
# The script stops it, as argocd app terminate-op does, and the automated sync
# starts again from ConfigHub. A Git sync that finishes first can write the Git
# sources back, so they are dropped again until every Application reads ConfigHub.
reads() { k -n argocd get application "$1" -o jsonpath='{.spec.sources[*].repoURL}{.spec.source.repoURL}' 2>/dev/null; }
# A sync names its sources, or at least its revisions: a Git sync has commit
# SHAs, and a sync of a ConfigHub release has an OCI digest.
git_operation() {
  local op t
  op=$(k -n argocd get application "$1" -o jsonpath='{.status.operationState.phase} {.status.operationState.operation.sync.sources[*].repoURL} {.status.operationState.operation.sync.source.repoURL} {.status.operationState.syncResult.sources[*].repoURL} {.status.operationState.syncResult.source.repoURL} {.status.operationState.operation.sync.revisions[*]} {.status.operationState.operation.sync.revision} {.status.operationState.syncResult.revisions[*]} {.status.operationState.syncResult.revision}' 2>/dev/null) || return 1
  read -ra op <<<"$op"
  [ "${op[0]:-}" = Running ] || return 1
  for t in "${op[@]:1}"; do
    case "$t" in oci://* | sha256:*) ;; *) return 0 ;; esac
  done
  return 1
}
for _ in $(seq 1 60); do
  drop_git_sources
  left=0
  for app in hub-traefik edge-traefik hub-homer-dashboard hub-argocd; do
    case "$(reads "$app")" in oci://oci.hub.confighub.com/*) ;; *) left=1; continue ;; esac
    if git_operation "$app"; then
      echo "$app: stopping a sync Argo CD started from Git"
      k -n argocd patch application "$app" --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}' >/dev/null
      left=1
    fi
  done
  [ "$left" = 0 ] && break
  sleep 5
done
for app in hub-traefik edge-traefik hub-homer-dashboard hub-argocd; do
  echo "$app reads $(reads "$app")"
done
[ "$left" = 0 ] || { echo "Some Applications do not read ConfigHub yet. Re-run this script once the hub is idle."; exit 1; }

step "6/6 argobot reports each Application's live status to its variant Space"
# argobot runs as the Targets' server worker, the identity Argo CD already pulls
# releases with. Step 2 gave its bot user Edit on each variant Space, which is
# what lets it write the Space's live status.
# No personal token goes into the cluster. Its ID and secret go from cub into
# the Secret through file descriptors, as above.
k create namespace argobot --dry-run=client -o yaml | k apply -f - >/dev/null
k -n argobot create secret generic argobot-secrets \
  --from-file=CONFIGHUB_URL=<(cub context get -o jq=.coordinate.serverURL | tr -d '\n') \
  --from-file=CONFIGHUB_WORKER_ID=<(cub worker get --space kx-targets server-worker -o jq=.BridgeWorker.BridgeWorkerID | tr -d '\n') \
  --from-file=CONFIGHUB_WORKER_SECRET=<(cub worker get --space kx-targets server-worker --include-secret -o jq=.BridgeWorker.Secret | tr -d '\n') \
  --dry-run=client -o yaml | k apply -f -
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
k apply -f argobot.yaml
k -n argobot rollout restart deployment/argobot >/dev/null
k -n argobot rollout status deployment/argobot --timeout=180s
# argobot writes a Space's status when it starts, and again whenever the
# Application changes. Wait until each variant Space has one from this start;
# a Space keeps the last status an earlier argobot wrote.
status() { cub space get "$1" -o 'jq=.Space.Annotations["confighub.com/live-status"] // "{}" | fromjson | select((.observedAt // "") >= "'"$since"'") | tojson'; }
for _ in $(seq 1 60); do
  missing=0
  for space in kx-traefik-hub kx-traefik-edge kx-homer-dashboard-hub kx-argo-cd-hub; do
    [ -n "$(status "$space")" ] || missing=1
  done
  [ "$missing" = 0 ] && break
  sleep 5
done
for space in kx-traefik-hub kx-traefik-edge kx-homer-dashboard-hub kx-argo-cd-hub; do
  s=$(status "$space")
  if [ -n "$s" ]; then
    printf '%s: %s\n' "$space" "$(jq -r '"\(.app) \(.syncStatus) \(.healthStatus) at \(.revision[0:19])"' <<<"$s")"
  else
    echo "$space: no live status yet"
  fi
done
[ "$missing" = 0 ] || { echo "argobot has not reported every Application. Look at: kubectl -n argobot logs deployment/argobot"; exit 1; }

echo
echo "Done. Kubara's hub now reads each cluster's approved release from ConfigHub,"
echo "and argobot writes each Application's sync and health to its variant Space."
echo "Watch it with: kubectl get applications -n argocd"
echo "A manual sync must keep RespectIgnoreDifferences, as Kubara's sync options do;"
echo "without it, Argo CD empties the values of the Secrets ConfigHub holds without values."
