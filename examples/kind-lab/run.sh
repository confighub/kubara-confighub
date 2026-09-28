#!/usr/bin/env bash
# The cub kubara story on the kind lab that up.sh built. It puts the platform
# into ConfigHub, hands Kubara's hub over to it, and takes one change to dev
# and then prod, checking each cluster as it goes.
#
#   cub auth login
#   bash examples/kind-lab/run.sh
#
# It works in $LAB (default ./kubara-lab) and creates Spaces named $PREFIX-*
# (default kubara-*) in your ConfigHub organization. down.sh removes both.
set -euo pipefail
LAB=${LAB:-$PWD/kubara-lab}
HUB=${HUB:-hub}
SPOKE=${SPOKE:-spoke}
PREFIX=${PREFIX:-kubara}
export HUB_CONTEXT=kind-kubara-$HUB
SPOKE_CONTEXT=kind-kubara-$SPOKE

cd "$LAB"
[ -f platform/config.yaml ] || { echo "no platform in $LAB: run up.sh first"; exit 1; }
cub space list --quiet >/dev/null 2>&1 || { echo "cub is not logged in: run cub auth login"; exit 1; }
export HELM_REPOSITORY_CONFIG=$LAB/helm/repositories.yaml HELM_REPOSITORY_CACHE=$LAB/helm/cache HELM_CACHE_HOME=$LAB/helm/cache-home

section() { printf '\n== %s\n' "$*"; }
# Argo CD takes a few minutes to sync each release it has just started reading:
# wait until every Application has synced a ConfigHub release, an OCI digest.
settle() {
  for _ in $(seq 1 120); do
    kubectl --context "$HUB_CONTEXT" -n argocd get applications -o json \
      | jq -e 'all(.items[]; .status.sync.status == "Synced" and (.status.sync.revision // "" | startswith("sha256:")))' >/dev/null && return 0
    sleep 5
  done
}
# Print each command as you would type it, then run it.
run() {
  local a line='$'
  for a in "$@"; do case "$a" in *[[:space:]\'\"\$]*) line+=" '$a'" ;; *) line+=" $a" ;; esac; done
  printf '\n%s\n' "$line"
  "$@"
}
check() { run cub kubara check platform --prefix "$PREFIX" --hub-context "$HUB_CONTEXT" "$@"; }
replicas() { kubectl --context "$1" -n metrics-server get deploy metrics-server -o jsonpath='{.status.readyReplicas}'; }
# Argo CD looks for new releases every few minutes; ask it to look now.
pull() {
  kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$1-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
  for _ in $(seq 1 60); do [ "$(replicas "$2")" = 2 ] && return 0; sleep 5; done
  echo "$1 did not reach 2 replicas"; return 1
}

section "1. See what ConfigHub will hold. This needs no account and changes nothing."
run cub kubara plan platform --prefix "$PREFIX"

section "2. Put the platform into ConfigHub: a base per component, a variant per cluster"
run cub kubara apply platform --prefix "$PREFIX" --out confighub \
  --capabilities "$HUB=$HUB_CONTEXT" --capabilities "$SPOKE=$SPOKE_CONTEXT"
run bash confighub/apply.sh

section "3. Hand Kubara's hub to ConfigHub"
run cub kubara handover platform --prefix "$PREFIX" --out confighub --capabilities "$HUB=$HUB_CONTEXT"
run bash confighub/handover.sh

section "4. Check that each cluster runs the release its stage approved"
settle
check

section "5. One change, released to dev first: two metrics-server replicas"
base=$PREFIX-metrics-server-base
run cub function set --space "$base" --unit metrics-server --change-desc "Run two metrics-server replicas" set-replicas 2 --quiet
run cub changeorder create --space "$base" two-replicas --change-workflow "$base/rollout" \
  --description "Two metrics-server replicas" --allow-exists
run cub variant promote --change-order "$base/two-replicas" --target-stage dev --quiet
run cub variant approve --change-order "$base/two-replicas" --stage dev
run cub release publish "$PREFIX-metrics-server-$HUB" --revision "ChangeOrder:$base/two-replicas" --quiet
echo
echo "Released to dev. Until Argo CD pulls it, check says so:"
check || true
pull "$HUB" "$HUB_CONTEXT"
run kubectl --context "$HUB_CONTEXT" -n metrics-server get deploy metrics-server
run kubectl --context "$SPOKE_CONTEXT" -n metrics-server get deploy metrics-server
check

section "6. The same change in prod, after its own approval"
run cub variant promote --change-order "$base/two-replicas" --target-stage prod --quiet
run cub variant approve --change-order "$base/two-replicas" --stage prod
run cub release publish "$PREFIX-metrics-server-$SPOKE" --revision "ChangeOrder:$base/two-replicas" --quiet
pull "$SPOKE" "$SPOKE_CONTEXT"
run kubectl --context "$SPOKE_CONTEXT" -n metrics-server get deploy metrics-server
check --record

echo
echo "Done. Kubara's hub delivers what ConfigHub approved, stage by stage."
echo "See it in ConfigHub: cub space list --where \"Slug LIKE '$PREFIX-%'\""
