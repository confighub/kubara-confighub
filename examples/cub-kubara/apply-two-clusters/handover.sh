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
# Steps 0 to 4 change only ConfigHub. Step 5 changes the hub: a credential for
# the gateway, and the argo-cd ApplicationSet, after checking that Argo CD would
# delete nothing. Secrets keep their live values: ConfigHub holds their keys,
# and each ApplicationSet tells Argo CD to leave their data alone. All of it is
# safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
k() { kubectl ${HUB_CONTEXT:+--context "$HUB_CONTEXT"} "$@"; }
step() { printf '\n== %s\n' "$*"; }
# A finished change order is skipped, so a re-run releases only what is new.
rolled_out() { [ "$(cub changeorder get --space "${1%/*}" "${1#*/}" -o jq=.ChangeOrder.Stage)" = Completed ]; }
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

step "0/5 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
for space in kx-traefik-base kx-traefik-hub kx-traefik-edge kx-homer-dashboard-base kx-homer-dashboard-hub kx-argo-cd-base kx-argo-cd-hub; do
  cub space get "$space" --quiet >/dev/null 2>&1 || { echo "$space is missing: run apply.sh first"; exit 1; }
done
image=$(k -n argocd get deployment -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].spec.template.spec.containers[0].image}')
version=${image##*:}
if [ "$(printf '%s\n' v3.1.0 "$version" | sort -V | head -1)" != v3.1.0 ]; then
  echo "the hub runs Argo CD $version; reading releases from ConfigHub's gateway needs v3.1.0 or later"; exit 1
fi

step "1/5 One Target per cluster, in kx-targets"
cub space create kx-targets --allow-exists --quiet
cub worker create --space kx-targets server-worker --filename worker.json --allow-exists --quiet
cub target create hub '{}' server-worker --space kx-targets --provider OCI --toolchain Any --allow-exists --quiet
cub target create edge '{}' server-worker --space kx-targets --provider OCI --toolchain Any --allow-exists --quiet

step "2/5 Each variant releases to its own cluster's Target"
cub unit set-target --space kx-traefik-hub traefik kx-targets/hub --quiet
cub space update kx-traefik-hub --release-target kx-targets/hub --quiet
cub unit set-target --space kx-traefik-edge traefik kx-targets/edge --quiet
cub space update kx-traefik-edge --release-target kx-targets/edge --quiet
cub unit set-target --space kx-homer-dashboard-hub homer-dashboard kx-targets/hub --quiet
cub space update kx-homer-dashboard-hub --release-target kx-targets/hub --quiet
cub unit set-target --space kx-argo-cd-hub argo-cd kx-targets/hub --quiet
cub space update kx-argo-cd-hub --release-target kx-targets/hub --quiet

step "3/5 Kubara's ApplicationSets read ConfigHub: a change to the argo-cd base"
cub unit data --space kx-argo-cd-base argo-cd -O argo-cd/current.yaml
cub kubara route-appsets argo-cd/current.yaml --prefix kx --gateway oci.hub.confighub.com --charts argo-cd,homer-dashboard,traefik > argo-cd/routed.yaml
if cmp -s argo-cd/current.yaml argo-cd/routed.yaml; then
  echo 'the argo-cd base already points its ApplicationSets at ConfigHub'
else
  cub unit update --space kx-argo-cd-base argo-cd argo-cd/routed.yaml --change-desc 'Point Kubara'\''s ApplicationSets at each cluster'\''s approved release in ConfigHub, keeping live Secret values' --quiet
fi

step "4/5 Release each variant, stage by stage: promote, approve, publish"
cub changeorder create --space kx-traefik-base handover-e84ab4de --change-workflow kx-traefik-base/rollout --description 'First release of kx-traefik-hub, kx-traefik-edge for handover' --allow-exists --quiet
if rolled_out kx-traefik-base/handover-e84ab4de; then
  echo 'traefik: every variant is released'
else
  cub variant promote --change-order kx-traefik-base/handover-e84ab4de --target-stage dev --quiet
  cub variant approve --change-order kx-traefik-base/handover-e84ab4de --stage dev --quiet
  publish kx-traefik-hub kx-traefik-base/handover-e84ab4de
  cub variant promote --change-order kx-traefik-base/handover-e84ab4de --target-stage prod --quiet
  cub variant approve --change-order kx-traefik-base/handover-e84ab4de --stage prod --quiet
  publish kx-traefik-edge kx-traefik-base/handover-e84ab4de
fi
cub changeorder create --space kx-homer-dashboard-base handover-0d585623 --change-workflow kx-homer-dashboard-base/rollout --description 'First release of kx-homer-dashboard-hub for handover' --allow-exists --quiet
if rolled_out kx-homer-dashboard-base/handover-0d585623; then
  echo 'homer-dashboard: every variant is released'
else
  cub variant promote --change-order kx-homer-dashboard-base/handover-0d585623 --target-stage dev --quiet
  cub variant approve --change-order kx-homer-dashboard-base/handover-0d585623 --stage dev --quiet
  publish kx-homer-dashboard-hub kx-homer-dashboard-base/handover-0d585623
fi
cub changeorder create --space kx-argo-cd-base handover-dec294e7 --change-workflow kx-argo-cd-base/rollout --description 'First release of kx-argo-cd-hub for handover' --allow-exists --quiet
if rolled_out kx-argo-cd-base/handover-dec294e7; then
  echo 'argo-cd: every variant is released'
else
  cub variant promote --change-order kx-argo-cd-base/handover-dec294e7 --target-stage dev --quiet
  cub variant approve --change-order kx-argo-cd-base/handover-dec294e7 --stage dev --quiet
  publish kx-argo-cd-hub kx-argo-cd-base/handover-dec294e7
fi

step "5/5 Hand the hub to ConfigHub (your hub cluster)"
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
# The one change Kubara's Git does not make: the argo-cd ApplicationSet reads
# the hub's argo-cd release, and that release carries every other routed one.
cub unit data --space kx-argo-cd-hub argo-cd -O argo-cd/released.yaml
cub kubara route-appsets argo-cd/released.yaml --only argocd | k apply --server-side --force-conflicts -f -
for _ in $(seq 1 60); do
  [ "$(k -n argocd get application hub-argocd -o jsonpath='{.spec.source.repoURL}' 2>/dev/null)" = 'oci://oci.hub.confighub.com/space/kx-argo-cd-hub' ] && break
  sleep 5
done

echo
echo "Done. Kubara's hub now reads each cluster's approved release from ConfigHub."
echo "Watch it with: kubectl get applications -n argocd"
echo "A manual sync must keep RespectIgnoreDifferences, as Kubara's sync options do;"
echo "without it, Argo CD empties the values of the Secrets ConfigHub holds without values."
