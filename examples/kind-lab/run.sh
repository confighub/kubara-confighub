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
KIND=${KIND:-kubara}   # the kind clusters are $KIND-$HUB and $KIND-$SPOKE
PREFIX=${PREFIX:-kubara}
export HUB_CONTEXT=kind-$KIND-$HUB
SPOKE_CONTEXT=kind-$KIND-$SPOKE

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
# check judges health too. On kind, cert-manager stays Degraded and Traefik
# Progressing (see the README), so check exits non-zero; carry on.
check() { run cub kubara check platform --prefix "$PREFIX" --hub-context "$HUB_CONTEXT" "$@" || true; }
replicas() { kubectl --context "$1" -n metrics-server get deploy metrics-server -o jsonpath='{.status.readyReplicas}'; }
# The live status argobot wrote on a variant Space: the Application, whether
# it is synced and healthy, and the release it synced.
live() {
  cub space get "$1" -o 'jq=.Space.Annotations["confighub.com/live-status"] // ""' |
    jq -r --arg s "$1" '"\($s): \(.app) \(.syncStatus) \(.healthStatus), synced \(.revision[0:19])"'
}
# The OCI digest of a variant Space's latest published release.
latest() { cub release list --space "$1" -o 'jq=[.[] | select(.Release.Published)] | max_by(.Release.ReleaseNum) | .Release.ManifestDigest'; }
# wait_live <space> <health>: until argobot reports the latest release synced,
# its sync finished, and that health.
wait_live() {
  local want
  want=$(latest "$1")
  for _ in $(seq 1 120); do
    cub space get "$1" -o 'jq=.Space.Annotations["confighub.com/live-status"] // "{}"' |
      jq -e --arg d "$want" --arg h "$2" '.revision == $d and .syncStatus == "Synced" and .operationPhase != "Running" and .healthStatus == $h' >/dev/null && { live "$1"; return 0; }
    sleep 5
  done
  echo "$1 did not report $2 for its latest release"; live "$1"; return 1
}
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

section "5. See each cluster's live status in ConfigHub, as argobot reports it"
for space in $(cub space list --where "Slug LIKE '$PREFIX-%' AND Labels.Stage IN ('dev', 'prod')" --no-headers -o name | sort); do
  case "$space" in *bootstrap-crds*) continue ;; esac
  live "$space"
done

section "6. One change, released to dev first: two metrics-server replicas"
base=$PREFIX-metrics-server-base
run cub function set --space "$base" --unit metrics-server --change-desc "Run two metrics-server replicas" set-replicas 2 --quiet
run cub changeorder create --space "$base" two-replicas --change-workflow "$base/rollout" \
  --description "Two metrics-server replicas" --allow-exists
run cub variant promote --change-order "$base/two-replicas" --target-stage dev --quiet
run cub variant approve --change-order "$base/two-replicas" --stage dev
run cub release publish "$PREFIX-metrics-server-$HUB" --revision "ChangeOrder:$base/two-replicas" --quiet
echo
echo "Released to dev. Until Argo CD pulls it, check says so:"
check
pull "$HUB" "$HUB_CONTEXT"
run kubectl --context "$HUB_CONTEXT" -n metrics-server get deploy metrics-server
run kubectl --context "$SPOKE_CONTEXT" -n metrics-server get deploy metrics-server
check

section "7. The same change in prod, after its own approval"
run cub variant promote --change-order "$base/two-replicas" --target-stage prod --quiet
run cub variant approve --change-order "$base/two-replicas" --stage prod
run cub release publish "$PREFIX-metrics-server-$SPOKE" --revision "ChangeOrder:$base/two-replicas" --quiet
pull "$SPOKE" "$SPOKE_CONTEXT"
run kubectl --context "$SPOKE_CONTEXT" -n metrics-server get deploy metrics-server
check --record

section "8. Gate prod on dev's health"
# A change order copies its workflow when it is created, so the gate applies
# to the change orders created from here on.
gate='{"Stages":[
  {"Name":"dev","WhereSpace":"Labels.Stage = '"'dev'"'","ReleasePrerequisites":["approval"]},
  {"Name":"prod","WhereSpace":"Labels.Stage = '"'prod'"'","Prerequisites":["Released","Healthy"],"ReleasePrerequisites":["approval"]}]}'
printf '\n$ echo <prod waits for Released and Healthy> | cub changeworkflow update --patch --space %s rollout --from-stdin --quiet\n' "$base"
echo "$gate" | cub changeworkflow update --patch --space "$base" rollout --from-stdin --quiet
run cub changeworkflow get --space "$base" rollout -o 'jq=.ChangeWorkflow.Stages[] | "\(.Name): \(.Prerequisites // [] | join(", "))"'
run cub function set --space "$base" --unit metrics-server --change-desc "Run three metrics-server replicas" set-replicas 3 --quiet
run cub changeorder create --space "$base" three-replicas --change-workflow "$base/rollout" \
  --description "Three metrics-server replicas" --allow-exists
run cub variant promote --change-order "$base/three-replicas" --target-stage dev --quiet
run cub variant approve --change-order "$base/three-replicas" --stage dev
run cub release publish "$PREFIX-metrics-server-$HUB" --revision "ChangeOrder:$base/three-replicas" --quiet
echo
echo "Straight after the release, argobot still reports the release before it:"
live "$PREFIX-metrics-server-$HUB"
echo "latest release: $(latest "$PREFIX-metrics-server-$HUB" | cut -c1-19)"
echo "ConfigHub's Healthy gate reads that status, so a dry run of the promotion to prod passes:"
run cub variant promote --change-order "$base/three-replicas" --target-stage prod --dry-run || true
echo
echo "check compares digests, and says dev does not run its latest release yet:"
check || true
kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$HUB-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
echo
echo "Once Argo CD syncs the release and dev is Healthy, prod accepts the change:"
wait_live "$PREFIX-metrics-server-$HUB" Healthy
run cub variant promote --change-order "$base/three-replicas" --target-stage prod --quiet
run cub variant approve --change-order "$base/three-replicas" --stage prod
run cub release publish "$PREFIX-metrics-server-$SPOKE" --revision "ChangeOrder:$base/three-replicas" --quiet
kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$SPOKE-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
wait_live "$PREFIX-metrics-server-$SPOKE" Healthy

section "9. A release that breaks dev holds prod back"
run cub function set --space "$base" --unit metrics-server --change-desc "An image that does not exist" \
  set-container-image metrics-server registry.k8s.io/metrics-server/metrics-server:v0.0.0-missing --quiet
# Kubernetes gives up on a rollout after progressDeadlineSeconds, 10 minutes by
# default, and only then does Argo CD call the Deployment Degraded.
run cub function set --space "$base" --unit metrics-server --change-desc "Report a stuck rollout after 30 seconds" \
  set-int-path apps/v1/Deployment spec.progressDeadlineSeconds 30 --quiet
run cub changeorder create --space "$base" missing-image --change-workflow "$base/rollout" \
  --description "An image that does not exist" --allow-exists
run cub variant promote --change-order "$base/missing-image" --target-stage dev --quiet
run cub variant approve --change-order "$base/missing-image" --stage dev
run cub release publish "$PREFIX-metrics-server-$HUB" --revision "ChangeOrder:$base/missing-image" --quiet
kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$HUB-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
wait_live "$PREFIX-metrics-server-$HUB" Degraded
run kubectl --context "$HUB_CONTEXT" -n metrics-server get pods
echo
echo "ConfigHub refuses to promote it into prod:"
if run cub variant promote --change-order "$base/missing-image" --target-stage prod --quiet; then
  echo "prod accepted a change that dev cannot run"; exit 1
fi
echo
echo "Take the change back out, and dev is Healthy again:"
run cub changeorder update --space "$base" missing-image --aborted-reason "dev is Degraded: the image does not exist" --quiet
run cub variant demote --change-order "$base/missing-image" --quiet
run cub release publish "$PREFIX-metrics-server-$HUB" --quiet
kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$HUB-metrics-server" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
wait_live "$PREFIX-metrics-server-$HUB" Healthy
check

echo
echo "Done. Kubara's hub delivers what ConfigHub approved, stage by stage."
echo "See it in ConfigHub: cub space list --where \"Slug LIKE '$PREFIX-%'\""
