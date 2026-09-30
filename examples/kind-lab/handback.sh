#!/usr/bin/env bash
# Hand the kind lab's hub back to Git, after run.sh. It shows that Argo CD
# would prune nothing, that every Secret keeps its value, and that Git
# delivers again: first what Git already holds, then a new commit.
#
#   bash examples/kind-lab/handback.sh
#
# It works in $LAB (default ./kubara-lab), with the same settings as run.sh.
# It changes only the hub and the lab's Git server; ConfigHub keeps every
# Space and release.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
LAB=${LAB:-$PWD/kubara-lab}
HUB=${HUB:-hub}
SPOKE=${SPOKE:-spoke}
KIND=${KIND:-kubara}   # the kind clusters are $KIND-$HUB and $KIND-$SPOKE
PREFIX=${PREFIX:-kubara}
export HUB_CONTEXT=kind-$KIND-$HUB
SPOKE_CONTEXT=kind-$KIND-$SPOKE

cd "$LAB"
[ -f confighub/handover.sh ] || { echo "no handover in $LAB: run run.sh first"; exit 1; }
export HELM_REPOSITORY_CONFIG=$LAB/helm/repositories.yaml HELM_REPOSITORY_CACHE=$LAB/helm/cache HELM_CACHE_HOME=$LAB/helm/cache-home

section() { printf '\n== %s\n' "$*"; }
run() {
  local a line='$'
  for a in "$@"; do case "$a" in *[[:space:]\'\"\$]*) line+=" '$a'" ;; *) line+=" $a" ;; esac; done
  printf '\n%s\n' "$line"
  "$@"
}
hub() { kubectl --context "$HUB_CONTEXT" "$@"; }
apps() { hub -n argocd get applications -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,SOURCE:.spec.sources[1].repoURL,OCI:.spec.source.repoURL'; }
# Each Secret on both clusters, with a hash of its data; never the data.
secrets() {
  local ctx
  for ctx in "$HUB_CONTEXT" "$SPOKE_CONTEXT"; do
    kubectl --context "$ctx" get secrets -A -o json |
      jq -r --arg c "${ctx#kind-}" '.items[] | "\($c) \(.metadata.namespace)/\(.metadata.name) \(.data // {} | tostring)"' |
      while read -r c name data; do printf '%s %s %s\n' "$c" "$name" "$(printf '%s' "$data" | shasum -a 256 | cut -c1-12)"; done
  done | sort
}
# What each Application manages, by kind, namespace and name.
managed() { hub -n argocd get applications -o json | jq -r '.items[] | .metadata.name as $a | .status.resources[]? | "\($a) \(.group // "")/\(.kind) \(.namespace // "")/\(.name)"' | sort; }
replicas() { kubectl --context "$1" -n metrics-server get deploy metrics-server -o jsonpath='{.spec.replicas}'; }

section "1. Before: Kubara's hub reads ConfigHub"
apps
echo
echo "metrics-server runs $(replicas "$HUB_CONTEXT") replicas on $HUB and $(replicas "$SPOKE_CONTEXT") on $SPOKE, as ConfigHub released; Git holds the chart's default, 1."
secrets > secrets.before
managed > managed.before
echo "$(wc -l < secrets.before | tr -d ' ') Secrets on the two clusters; $(wc -l < managed.before | tr -d ' ') objects the Applications manage."

section "2. Hand the hub back to Git"
run cub kubara handback platform --prefix "$PREFIX" --out confighub \
  --capabilities "$HUB=$HUB_CONTEXT" --capabilities "$SPOKE=$SPOKE_CONTEXT"
run bash confighub/handback.sh

section "3. After: Git delivers what it holds, and nothing was pruned"
for _ in $(seq 1 60); do
  [ "$(replicas "$HUB_CONTEXT")" = 1 ] && [ "$(replicas "$SPOKE_CONTEXT")" = 1 ] && break
  sleep 5
done
apps
echo
echo "metrics-server runs $(replicas "$HUB_CONTEXT") replica(s) on $HUB and $(replicas "$SPOKE_CONTEXT") on $SPOKE, as Git holds."
secrets > secrets.after
managed > managed.after
# handback removes two Secrets of its own: argobot's credential and the gateway's.
grep -v -e ' argobot/argobot-secrets ' -e " argocd/confighub-$PREFIX-targets " secrets.before > secrets.kept || true
echo "handback removed argobot's credential and the gateway's:"
diff secrets.before secrets.kept | sed -n 's/^< \([^ ]*\) \([^ ]*\) .*/  \1 \2/p' || true
if diff secrets.kept secrets.after >/dev/null; then
  echo "Every other Secret on both clusters, $(wc -l < secrets.after | tr -d ' '), is unchanged, values included."
else
  echo "Secrets that changed (cluster, name, hash of data; < before, > after):"; diff secrets.kept secrets.after || true
fi
gone=$(comm -23 managed.before managed.after)
if [ -z "$gone" ]; then
  echo "Of the $(wc -l < managed.before | tr -d ' ') objects the Applications managed before, none was pruned."
else
  echo "Objects the Applications no longer manage:"; echo "$gone"
fi
added=$(comm -13 managed.before managed.after)
[ -z "$added" ] || { echo "Objects they manage now and did not before (Helm hooks Git's syncs run):"; echo "$added" | sed 's/^/  /'; }
run kubectl --context "$HUB_CONTEXT" get namespace argobot --ignore-not-found

section "4. A new commit in Git reaches the hub"
mkdir -p "platform/platform-configs/$HUB/helm/metrics-server"
printf 'metrics-server:\n  replicas: 2\n' > "platform/platform-configs/$HUB/helm/metrics-server/values-replicas.yaml"
run git -C platform add -A
run git -C platform -c user.name=kubara-lab -c user.email=lab@example.com commit -q -m "Two metrics-server replicas on $HUB"
rm -rf platform.git
git clone -q --bare platform platform.git
git -C platform.git update-server-info
# The Git server mounts /srv/git, so replace only the repository inside it.
docker exec "$KIND-$HUB-control-plane" rm -rf /srv/git/platform.git
docker cp -q platform.git "$KIND-$HUB-control-plane:/srv/git/"
hub -n argocd annotate application "$HUB-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
for _ in $(seq 1 60); do [ "$(replicas "$HUB_CONTEXT")" = 2 ] && break; sleep 5; done
run kubectl --context "$HUB_CONTEXT" -n argocd get application "$HUB-metrics-server" \
  -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revisions[1]'
run git -C platform rev-parse HEAD
run kubectl --context "$HUB_CONTEXT" -n metrics-server get deploy metrics-server
[ "$(replicas "$HUB_CONTEXT")" = 2 ] || { echo "Git's commit did not reach $HUB"; exit 1; }

echo
echo "Done. Kubara's hub delivers from Git again. ConfigHub keeps every Space and"
echo "release; bash confighub/handover.sh hands the hub over again."
