#!/usr/bin/env bash
# Hand the Kubara hub in ../apply/testdata/platform back to Git. Run it after handover.sh.
# Written by `cub kubara handback`. Read it, then run it:
#
#   HUB_CONTEXT=<kubectl context of Kubara's hub> bash handback.sh
#
# It changes only the hub. Each ApplicationSet below reads Kubara's Git
# sources again, as Kubara generated it:
#
#   argocd
#   homer-dashboard
#   traefik
#
# The AppProject hx-dev-dev no longer permits the gateway, and argobot and the
# gateway credential leave the hub. Before any change, it checks that Argo CD
# would delete nothing. Secrets keep their live values: each ApplicationSet
# keeps the rule that leaves Secret data alone. ConfigHub keeps every Space and
# release, so handover.sh can hand the hub over again. Git must hold what you
# want Kubara to deliver: a change made in ConfigHub since handover is undone
# unless it is in Git too. All of it is safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${HUB_CONTEXT:+--context "$HUB_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# would_prune <application> <inventory>: fails, naming each object, when the
# Application manages something Kubara's Git render for it does not hold.
would_prune() {
  local app
  app=$(k -n argocd get application "$1" -o json 2>/dev/null) || { echo "$1: not on the hub, nothing to prune"; return 0; }
  cub kubara would-prune --application <(printf '%s' "$app") --release "$2" --name "$1"
}
reads() { k -n argocd get application "$1" -o jsonpath='{.spec.sources[*].repoURL}{" "}{.spec.source.repoURL}' 2>/dev/null; }
# restore_appset <name>: the ApplicationSet's spec as Kubara generated it,
# unless it already reads Git and nothing else.
restore_appset() {
  local src
  src=$(k -n argocd get applicationset "$1" -o jsonpath='{.spec.template.spec.source.repoURL}')
  [ -z "$src" ] && [ -n "$(k -n argocd get applicationset "$1" -o jsonpath='{.spec.template.spec.sources}')" ] && return 0
  k -n argocd patch applicationset "$1" --type=json -p "$(jq -c '[{op: "replace", path: "/spec", value: .}]' "handback/applicationset-$1.json")"
}
# A sync Argo CD started from ConfigHub names an OCI source or digest. After
# the switch it can never finish, because Argo CD retries it against Git.
confighub_operation() {
  local op t
  op=$(k -n argocd get application "$1" -o jsonpath='{.status.operationState.phase} {.status.operationState.operation.sync.sources[*].repoURL} {.status.operationState.operation.sync.source.repoURL} {.status.operationState.operation.sync.revisions[*]} {.status.operationState.operation.sync.revision}' 2>/dev/null) || return 1
  read -ra op <<<"$op"
  [ "${op[0]:-}" = Running ] || return 1
  for t in "${op[@]:1}"; do
    case "$t" in oci://* | sha256:*) return 0 ;; esac
  done
  return 1
}

step "0/4 Check before changing anything"
command -v jq >/dev/null || { echo "handback.sh needs jq"; exit 1; }
for a in argocd homer-dashboard traefik; do
  k -n argocd get applicationset "$a" >/dev/null || { echo "the hub has no ApplicationSet $a"; exit 1; }
done
# Kubara's ApplicationSets prune. Compare what each Application manages today
# with what Kubara's Git render holds for it, and stop if Argo CD would delete
# anything.
blocked=0
would_prune edge-traefik handback/traefik/edge.yaml || blocked=1
would_prune hub-argocd handback/argo-cd/hub.yaml || blocked=1
would_prune hub-homer-dashboard handback/homer-dashboard/hub.yaml || blocked=1
would_prune hub-traefik handback/traefik/hub.yaml || blocked=1
if [ "$blocked" = 1 ] && [ "${ALLOW_PRUNE:-}" != yes ]; then
  echo "Argo CD would delete the objects above. Put them in Git first, or rerun with ALLOW_PRUNE=yes to accept it."; exit 1
fi

step "1/4 Kubara's ApplicationSets read Git again, argocd first"
# Until the hub's argocd Application reads Git, Argo CD can write the routed
# ApplicationSets back from ConfigHub's release, so this repeats until every
# Application reads Git.
for _ in $(seq 1 60); do
  for a in argocd homer-dashboard traefik; do restore_appset "$a"; done
  left=0
  for app in edge-traefik hub-argocd hub-homer-dashboard hub-traefik; do
    case "$(reads "$app")" in *oci://oci.hub.confighub.com/*) left=1; continue ;; esac
    if confighub_operation "$app"; then
      echo "$app: stopping a sync Argo CD started from ConfigHub"
      k -n argocd patch application "$app" --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}' >/dev/null
      left=1
    fi
  done
  [ "$left" = 0 ] && break
  sleep 5
done
for app in edge-traefik hub-argocd hub-homer-dashboard hub-traefik; do
  echo "$app reads $(reads "$app")"
done
[ "$left" = 0 ] || { echo "Some Applications still read ConfigHub. Re-run this script once the hub is idle."; exit 1; }

step "2/4 The AppProject permits Kubara's sources only"
if k -n argocd get appproject hx-dev-dev -o jsonpath='{.spec.sourceRepos}' | grep -q 'oci://oci.hub.confighub.com/'; then
  k -n argocd patch appproject hx-dev-dev --type=json -p "$(jq -c '[{op: "replace", path: "/spec", value: .}]' handback/appproject-hx-dev-dev.json)"
fi

step "3/4 argobot and the gateway credential leave the hub"
# argobot reports only Applications that read ConfigHub, so it has nothing left
# to report. Each variant Space keeps the last status it wrote.
k delete namespace argobot --ignore-not-found
k -n argocd delete role,rolebinding argobot --ignore-not-found
k -n argocd delete secret confighub-kx-targets --ignore-not-found

step "4/4 Argo CD syncs every Application from Git"
# A sync from Git names commits, not OCI digests.
from_git() {
  k -n argocd get application "$1" -o json | jq -e '.status.sync.status == "Synced" and ([.status.sync.revision // empty, (.status.sync.revisions // [])[]] | length > 0 and all(startswith("sha256:") | not))' >/dev/null
}
for _ in $(seq 1 60); do
  left=0
  for app in edge-traefik hub-argocd hub-homer-dashboard hub-traefik; do
    from_git "$app" || left=1
  done
  [ "$left" = 0 ] && break
  sleep 5
done
k -n argocd get applications edge-traefik hub-argocd hub-homer-dashboard hub-traefik -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revisions[1]'
[ "$left" = 0 ] || { echo "Some Applications have not synced from Git yet. Look at them with: kubectl -n argocd describe application <name>"; exit 1; }

echo
echo "Done. Kubara's hub delivers from Git again. ConfigHub keeps every Space and"
echo "release; to hand the hub over again, run handover.sh."
