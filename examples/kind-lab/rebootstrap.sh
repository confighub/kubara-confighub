#!/usr/bin/env bash
# Run Kubara's bootstrap on the hub again after handover, as someone who runs
# Kubara does after changing Argo CD's settings, and see what it changes. Then
# hand the hub to ConfigHub again, with handover.sh.
#
#   bash examples/kind-lab/rebootstrap.sh
#
# It works in $LAB (default ./kubara-lab), with the same settings as run.sh,
# after run.sh. It changes the hub; ConfigHub keeps every Space and release.
set -euo pipefail
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
# Where each ApplicationSet's Applications read from: Git sources, or the
# ConfigHub source handover gave it.
appsets() {
  hub -n argocd get applicationsets -o json | jq -r '
    ["APPLICATIONSET", "GIT SOURCES", "CONFIGHUB SOURCE"], (.items[] | [.metadata.name,
      ([.spec.template.spec.sources[]?.repoURL] | unique | join(",") | if . == "" then "-" else . end),
      (.spec.template.spec.source.repoURL // "-")]) | @tsv' | column -t -s "$(printf '\t')"
}
apps() {
  hub -n argocd get applications -o json | jq -r '
    ["APPLICATION", "SYNC", "HEALTH", "READS", "SYNCED"], (.items[] | [.metadata.name, .status.sync.status, .status.health.status,
      (if (.spec.sources // []) != [] then "Git" elif (.spec.source.repoURL // "" | startswith("oci://")) then "ConfigHub" else "?" end),
      (.status.sync.revision // .status.sync.revisions[0] // "" | .[0:19])]) | @tsv' | column -t -s "$(printf '\t')"
}
replicas() { kubectl --context "$1" -n metrics-server get deploy metrics-server -o jsonpath='{.spec.replicas}'; }
check() { run cub kubara check platform --prefix "$PREFIX" --hub-context "$HUB_CONTEXT" || true; }
# Wait until metrics-server on the hub runs $1 replicas, for up to five minutes.
wait_replicas() {
  for _ in $(seq 1 60); do [ "$(replicas "$HUB_CONTEXT")" = "$1" ] && return 0; sleep 5; done
  return 1
}

section "1. Before: every routed ApplicationSet reads ConfigHub"
appsets
released=$(replicas "$HUB_CONTEXT")
echo
echo "metrics-server runs $released replicas on $HUB and $(replicas "$SPOKE_CONTEXT") on $SPOKE, as ConfigHub released; Git holds the chart's default, 1."

section "2. Kubara's bootstrap on the hub, again"
(cd platform && run kubara --work-dir . --config-file config.yaml --env-file .env --kubeconfig ../hub.kubeconfig bootstrap "$HUB" --timeout 10m)

section "3. After: what bootstrap changed"
appsets
echo
echo "The field managers of the metrics-server ApplicationSet's template:"
hub -n argocd get applicationset metrics-server --show-managed-fields -o json |
  jq -r '.metadata.managedFields[] | select(.fieldsV1["f:spec"]["f:template"]["f:spec"] != null) |
    "  \(.manager) (\(.operation)): \(.fieldsV1["f:spec"]["f:template"]["f:spec"] | keys | map(ltrimstr("f:")) | join(", "))"'
echo
if wait_replicas 1; then
  echo "Argo CD synced metrics-server from Git: $HUB runs $(replicas "$HUB_CONTEXT") replica, Git's default."
else
  echo "After five minutes, metrics-server on $HUB still runs $(replicas "$HUB_CONTEXT") replicas."
fi
apps
check

section "4. Hand the hub to ConfigHub again: handover.sh"
run bash confighub/handover.sh
# Argo CD pulls each release again; wait for metrics-server to run what ConfigHub released.
hub -n argocd annotate application "$HUB-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
wait_replicas "$released" || true
echo
appsets
echo
apps
echo
echo "metrics-server runs $(replicas "$HUB_CONTEXT") replicas on $HUB and $(replicas "$SPOKE_CONTEXT") on $SPOKE again."
check
