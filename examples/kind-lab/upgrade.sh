#!/usr/bin/env bash
# Take newer Kubara catalogs through ConfigHub, after run.sh. Kubara generates
# the platform from bootstrap 5.0.1 and general 5.1.0, cub kubara apply
# proposes each base's new render as a reviewed change, and the traefik
# upgrade goes to dev and then prod.
#
#   bash examples/kind-lab/upgrade.sh
#
# It works in $LAB (default ./kubara-lab), with the same settings as run.sh.
set -euo pipefail
LAB=${LAB:-$PWD/kubara-lab}
HUB=${HUB:-hub}
SPOKE=${SPOKE:-spoke}
KIND=${KIND:-kubara}   # the kind clusters are $KIND-$HUB and $KIND-$SPOKE
PREFIX=${PREFIX:-kubara}
BOOTSTRAP=${BOOTSTRAP:-5.0.1}
GENERAL=${GENERAL:-5.1.0}
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
check() { run cub kubara check platform --prefix "$PREFIX" --hub-context "$HUB_CONTEXT" "$@"; }
image() { kubectl --context "$1" -n "$2" get deploy "$3" -o jsonpath='{.spec.template.spec.containers[0].image}'; }
# order <component>: the change order apply.sh proposed for the component's base.
order() { echo "$PREFIX-$1-base/kubara-generated-r$(cub unit get --space "$PREFIX-kubara-generated" "$1" -o jq=.Unit.HeadRevisionNum)"; }
# release <component> <stage> <cluster>: promote, approve and publish in one stage.
release() {
  local o
  o=$(order "$1")
  run cub variant promote --change-order "$o" --target-stage "$2" --quiet
  run cub variant approve --change-order "$o" --stage "$2"
  run cub release publish "$PREFIX-$1-$3" --revision "ChangeOrder:$o" --quiet
}
# pull <application> <space>: ask Argo CD to look for the release now, and wait
# until it has synced the Space's latest release.
pull() {
  local want
  want=$(cub release list --space "$2" -o 'jq=[.[] | select(.Release.Published)] | max_by(.Release.ReleaseNum) | .Release.ManifestDigest')
  kubectl --context "$HUB_CONTEXT" -n argocd annotate application "$1" argocd.argoproj.io/refresh=normal --overwrite >/dev/null
  for _ in $(seq 1 90); do
    [ "$(kubectl --context "$HUB_CONTEXT" -n argocd get application "$1" -o jsonpath='{.status.sync.status} {.status.sync.revision}')" = "Synced $want" ] && return 0
    sleep 5
  done
  echo "$1 did not sync $want"; return 1
}

section "1. Kubara generates the platform from newer catalogs"
run kubara --version
run perl -pi -e "s#catalogs/bootstrap:[0-9.]+#catalogs/bootstrap:$BOOTSTRAP#; s#catalogs/general:[0-9.]+#catalogs/general:$GENERAL#" platform/config.yaml
run grep -n 'catalogs/' platform/config.yaml
(cd platform && kubara --work-dir . --config-file config.yaml --env-file .env generate --helm)
run git -C platform diff --stat
git -C platform add -A
run git -C platform -c user.name=kubara-lab -c user.email=lab@example.com commit -q -m "Kubara catalogs bootstrap $BOOTSTRAP and general $GENERAL"
# Kubara's own flow: push the platform to Git. After handover, Git still
# delivers only what ConfigHub does not hold.
rm -rf platform.git
git clone -q --bare platform platform.git
git -C platform.git update-server-info
docker exec "$KIND-$HUB-control-plane" rm -rf /srv/git/platform.git
docker cp -q platform.git "$KIND-$HUB-control-plane:/srv/git/"

section "2. What ConfigHub will hold now"
run cub kubara plan platform --prefix "$PREFIX"

section "3. apply proposes each base's new render as a change to review"
run cub kubara apply platform --prefix "$PREFIX" --out confighub \
  --capabilities "$HUB=$HUB_CONTEXT" --capabilities "$SPOKE=$SPOKE_CONTEXT"
run bash confighub/apply.sh
echo
echo "The change each base took, with the images it moves:"
for c in traefik argo-cd; do
  run cub unit diff --space "$PREFIX-$c-base" "$c" -u --from=-1 | grep -E '^[-+] +image:' | sort | uniq -c
done
echo
echo "A change made in ConfigHub before the new catalog stays: the argo-cd base still"
echo "points Kubara's ApplicationSets at ConfigHub, as handover set it."
echo "ApplicationSets in the argo-cd base that read ConfigHub: $(cub unit data --space "$PREFIX-argo-cd-base" argo-cd | grep -c "repoURL: oci://oci.hub.confighub.com/space/$PREFIX-")"

section "4. traefik $(image "$HUB_CONTEXT" traefik traefik | sed 's/.*://') to $(cub unit data --space "$PREFIX-traefik-base" traefik | sed -n 's/.*image: docker.io\/traefik:\(.*\)/\1/p' | head -1), in dev first"
release traefik dev "$HUB"
pull "$HUB-traefik" "$PREFIX-traefik-$HUB"
check
echo
echo "traefik on $HUB: $(image "$HUB_CONTEXT" traefik traefik)"
echo "traefik on $SPOKE: $(image "$SPOKE_CONTEXT" traefik traefik)"

section "5. The same upgrade in prod, after its own approval"
release traefik prod "$SPOKE"
pull "$SPOKE-traefik" "$PREFIX-traefik-$SPOKE"
check
echo
echo "traefik on $HUB: $(image "$HUB_CONTEXT" traefik traefik)"
echo "traefik on $SPOKE: $(image "$SPOKE_CONTEXT" traefik traefik)"

echo
echo "Done. traefik from Kubara's newer catalog reached each cluster as a reviewed change,"
echo "dev first. On kind the hub's argocd Application never finishes a sync, because its"
echo "Ingress gets no address, so the lab does not release the argo-cd change."
echo "The other proposed changes wait in their change orders:"
cub changeorder list --space '*' --where "Slug LIKE 'kubara-generated-%' AND Space.Slug LIKE '$PREFIX-%'" -o 'jq=.[] | "  \(.Space.Slug)/\(.ChangeOrder.Slug): \(.ChangeOrder.Stage // "not promoted yet")"' || true
