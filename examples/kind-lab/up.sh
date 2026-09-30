#!/usr/bin/env bash
# Build a Kubara platform on kind: a hub and a spoke, generated and
# bootstrapped by Kubara, with the hub's Argo CD delivering every service to
# both clusters from a Git server inside the hub. Nothing here touches
# ConfigHub; run.sh does that.
#
#   bash examples/kind-lab/up.sh
#
# It works in $LAB (default ./kubara-lab) and is safe to run again.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
LAB=${LAB:-$PWD/kubara-lab}
HUB=${HUB:-hub}
SPOKE=${SPOKE:-spoke}
KIND=${KIND:-kubara}   # the kind clusters are $KIND-$HUB and $KIND-$SPOKE
# cert-manager's ClusterIssuer registers this address with Let's Encrypt's
# staging server, which refuses example.com. Give your own to make it Ready.
EMAIL=${EMAIL:-lab@example.com}
SERVICES=${SERVICES:-cert-manager,metrics-server,traefik,homer-dashboard}   # init enables homer-dashboard on the hub only
NODE_IMAGE=${NODE_IMAGE:-kindest/node:v1.35.0}
REPO=http://git.git-server.svc.cluster.local/platform.git

step() { printf '\n== %s\n' "$*"; }
for tool in docker kind kubectl helm git jq kubara cub; do
  command -v "$tool" >/dev/null || { echo "up.sh needs $tool on your PATH"; exit 1; }
done
cub kubara version >/dev/null 2>&1 || { echo "up.sh needs the plugin: cub plugin install confighub/kubara-confighub"; exit 1; }

# kind switches your current kubectl context; put it back at the end.
previous=$(kubectl config current-context 2>/dev/null || true)
restore() { [ -z "$previous" ] || kubectl config use-context "$previous" >/dev/null; }
trap restore EXIT

mkdir -p "$LAB"
cd "$LAB"
# Helm repositories of the lab's own, so a broken entry in your global list
# cannot stop Kubara's bootstrap.
export HELM_REPOSITORY_CONFIG=$LAB/helm/repositories.yaml HELM_REPOSITORY_CACHE=$LAB/helm/cache HELM_CACHE_HOME=$LAB/helm/cache-home
hub() { kubectl --kubeconfig "$LAB/hub.kubeconfig" "$@"; }
kubara_() { (cd platform && kubara --work-dir . --config-file config.yaml --env-file .env "$@"); }

step "1/7 Two kind clusters: $KIND-$HUB for the hub and $KIND-$SPOKE for the spoke"
for c in "$KIND-$HUB" "$KIND-$SPOKE"; do
  kind get clusters 2>/dev/null | grep -qx "$c" || kind create cluster --name "$c" --image "$NODE_IMAGE" --wait 120s
done
kind get kubeconfig --name "$KIND-$HUB" > hub.kubeconfig
kind get kubeconfig --name "$KIND-$SPOKE" > spoke.kubeconfig
# The hub's Argo CD reaches the spoke over the kind network.
kind get kubeconfig --name "$KIND-$SPOKE" --internal > spoke.internal.kubeconfig

step "2/7 A Kubara platform: $HUB in dev, $SPOKE in prod, with $SERVICES"
if [ ! -f platform/config.yaml ]; then
  cub kubara init --out platform --hub "$HUB:dev" --spoke "$SPOKE:prod" --services "$SERVICES" \
    --repository "$REPO" --email "$EMAIL"
  cp platform/.env.example platform/.env
fi
kubara_ generate --helm

step "3/7 The platform in Git, copied onto the hub's node"
(
  cd platform
  [ -d .git ] || { git init -q -b main; printf '.env\n.local/\n' > .gitignore; }
  git add -A
  git diff --cached --quiet || git -c user.name=kubara-lab -c user.email=lab@example.com commit -q -m "Kubara lab platform"
)
rm -rf platform.git
git clone -q --bare platform platform.git
git -C platform.git update-server-info
docker exec "$KIND-$HUB-control-plane" sh -c 'rm -rf /srv/git && mkdir -p /srv/git'
docker cp -q platform.git "$KIND-$HUB-control-plane:/srv/git/"

step "4/7 A Git server in the hub that Argo CD can read"
hub apply -f "$here/git-server.yaml" >/dev/null
hub -n git-server create configmap git-server --from-file=server.py="$here/git-server.py" --dry-run=client -o yaml | hub apply -f - >/dev/null
hub -n git-server rollout restart deploy/git >/dev/null
hub -n git-server rollout status deploy/git --timeout=240s
hub run git-check --rm -i --restart=Never --image=alpine/git:2.47.2 -q -- ls-remote "$REPO" | grep -q refs/heads/main \
  || { echo "the Git server does not serve $REPO"; exit 1; }
echo "$REPO serves main"

step "5/7 Kubara's bootstrap: the spoke first, for its CRDs, then the hub"
kubara_ --kubeconfig ../spoke.kubeconfig bootstrap "$SPOKE" --timeout 10m
kubara_ --kubeconfig ../hub.kubeconfig bootstrap "$HUB" --timeout 10m

step "6/7 The spoke joins the hub's Argo CD"
# Kubara registers a spoke with an ExternalSecret, $SPOKE-es, which reads the
# spoke's kubeconfig from your secret store. The lab has no secret store, so
# this writes the Secret that ExternalSecret would: its name and labels come
# from Kubara's ExternalSecret, and the spoke's address and credentials from kind.
es=$SPOKE-es
hub -n argocd get externalsecret "$es" >/dev/null || { echo "Kubara's bootstrap made no ExternalSecret $es"; exit 1; }
target=$(hub -n argocd get externalsecret "$es" -o jsonpath='{.spec.target.name}')
labels=()
# shellcheck disable=SC2016 # a Go template, not shell
while IFS= read -r l; do [ -n "$l" ] && labels+=("$l"); done < <(hub -n argocd get externalsecret "$es" \
  -o go-template='{{range $k, $v := .spec.target.template.metadata.labels}}{{$k}}={{$v}}{{"\n"}}{{end}}')
field() { kubectl --kubeconfig spoke.internal.kubeconfig config view --raw --minify -o jsonpath="$1"; }
hub -n argocd create secret generic "$target" \
  --from-literal=name="$SPOKE" --from-literal=project="$HUB-dev" \
  --from-literal=server="$(field '{.clusters[0].cluster.server}')" \
  --from-file=config=<(printf '{"tlsClientConfig":{"caData":"%s","certData":"%s","keyData":"%s","insecure":false}}' \
    "$(field '{.clusters[0].cluster.certificate-authority-data}')" \
    "$(field '{.users[0].user.client-certificate-data}')" \
    "$(field '{.users[0].user.client-key-data}')") \
  --dry-run=client -o yaml | hub label --local -f - "${labels[@]}" -o yaml | hub apply -f -
# A fresh controller reads the spoke's new CRDs instead of a cached discovery.
hub -n argocd rollout restart statefulset argocd-application-controller >/dev/null
hub -n argocd rollout status statefulset argocd-application-controller --timeout=180s

step "7/7 Argo CD delivers every service to both clusters from Git"
# Every Application syncs. The hub's own argocd Application never finishes on
# kind: it waits for an Ingress address, which kind has no load balancer for.
settled() {
  hub -n argocd get applications -o json | jq -r --arg argocd "$HUB-argocd" '
    if (.items | length) > 0 and all(.items[];
      .status.sync.status == "Synced" and
      (.metadata.name == $argocd or .status.operationState.phase != "Running"))
    then (.items | length) else 0 end'
}
last=0
ready=no
for _ in $(seq 1 90); do
  n=$(settled)
  # The same number of settled Applications twice running: the ApplicationSets have caught up.
  if [ "$n" -gt 0 ] && [ "$n" = "$last" ]; then ready=yes; break; fi
  last=$n
  sleep 10
done
hub -n argocd get applications -o custom-columns='APPLICATION:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
if [ "$ready" != yes ]; then
  echo
  echo "Argo CD has not synced every Application after 15 minutes. Look at the ones above"
  echo "that are not Synced (kubectl --kubeconfig $LAB/hub.kubeconfig -n argocd describe application <name>),"
  echo "then run up.sh again."
  exit 1
fi
echo
echo "On kind, cert-manager is Degraded (Let's Encrypt refuses the example.com"
echo "contact), traefik is Progressing (no load balancer), and argocd waits for an"
echo "Ingress address. None of that affects what follows."
echo
echo "The Kubara platform is up. Kubara's hub delivers it from Git. Next:"
echo "  cub auth login"
echo "  bash $here/run.sh"
