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
  if has Released "$ref" "$@" && released "$@"; then echo "$ref: $stage has released it"; return 0; fi
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
# is released as it stands, which is what Git delivers today. Any other refusal
# stops the script.
publish_taken() {
  local skipped id out
  skipped=" $(cub changeorder get --space "${2%/*}" "${2#*/}" -o 'jq=(.ChangeOrder.SkippedUnits // {}) | to_entries | map(.key + "=" + .value) | join(" ")' | tr -d '"') "
  for id in $(cub unit list --space "${2%/*}" -o 'jq=[.[].Unit.UnitID] | join(" ")' | tr -d '"'); do
    case "$skipped" in *" $id=AlreadyTaken "*) ;; *) echo "$3" >&2; return 1 ;; esac
  done
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

step "0/6 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
for tool in jq openssl; do command -v "$tool" >/dev/null || { echo "this script needs $tool"; exit 1; }; done
for space in kx-traefik-base kx-traefik-hub kx-traefik-edge kx-homer-dashboard-base kx-homer-dashboard-hub kx-argo-cd-base kx-argo-cd-hub; do
  cub space get "$space" --quiet >/dev/null 2>&1 || { echo "$space is missing: run apply.sh first"; exit 1; }
done
# Service accounts, which the Targets grant and argobot runs as, came with
# cub and ConfigHub v0.9.0.
# A build that names no version is let through.
# awk reads all of what cub prints: ending early would end cub with a broken
# pipe, which pipefail reports as a failure. The first version is cub's own.
cub_version=$(cub version 2>/dev/null | awk '$1 == "Version:" && $2 ~ /^v[0-9]/ && !seen {print $2; seen = 1}')
if [ -n "$cub_version" ] && [ "$(printf '%s\n' v0.9.0 "$cub_version" | sort -V | head -1)" != v0.9.0 ]; then
  echo "cub is $cub_version; this script needs v0.9.0 or later, and ConfigHub v0.9.0 or later: run cub upgrade"; exit 1
fi
image=$(k -n argocd get deployment -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].spec.template.spec.containers[0].image}')
version=${image##*:}
if [ "$(printf '%s\n' v3.1.0 "$version" | sort -V | head -1)" != v3.1.0 ]; then
  echo "the hub runs Argo CD $version; reading releases from ConfigHub's gateway needs v3.1.0 or later"; exit 1
fi

step "1/6 One Target per cluster, in kx-targets"
cub space create kx-targets --allow-exists --quiet
# Two service accounts, neither with a role in the organization:
# - kx-delivery, which Argo CD pulls the gateway with: View finds each Target,
#   ViewChildren pulls the releases published for it;
# - kx-argobot, which argobot runs as: the same, and EditChildren, which is what
#   lets it record a release's live status.
# Two, so that the token in Argo CD's repository Secret cannot write live status.
cub serviceaccount create kx-delivery --allow-exists --quiet
cub serviceaccount create kx-argobot --allow-exists --quiet
cub target create hub --space kx-targets --allow-exists --quiet
cub target create edge --space kx-targets --allow-exists --quiet
# The grants, as an update, so a Target an earlier run made gets them too.
for t in hub edge; do
  cub target update "$t" --space kx-targets --permission View:serviceaccount:kx-delivery --permission ViewChildren:serviceaccount:kx-delivery \
    --permission View:serviceaccount:kx-argobot --permission ViewChildren:serviceaccount:kx-argobot --permission EditChildren:serviceaccount:kx-argobot --quiet
done

step "2/6 Each variant releases to its own cluster's Target"
cub unit set-target --space kx-traefik-hub traefik kx-targets/hub --quiet
cub space update kx-traefik-hub --release-target kx-targets/hub --quiet
cub unit set-target --space kx-traefik-edge traefik kx-targets/edge --quiet
cub space update kx-traefik-edge --release-target kx-targets/edge --quiet
cub unit set-target --space kx-homer-dashboard-hub homer-dashboard kx-targets/hub --quiet
cub space update kx-homer-dashboard-hub --release-target kx-targets/hub --quiet
cub unit set-target --space kx-argo-cd-hub argo-cd kx-targets/hub --quiet
cub space update kx-argo-cd-hub --release-target kx-targets/hub --quiet

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
  if rolled_out kx-traefik-base/"$order" && released kx-traefik-hub kx-traefik-edge; then
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
  if rolled_out kx-homer-dashboard-base/"$order" && released kx-homer-dashboard-hub; then
    echo 'homer-dashboard: every variant is released'
  else
    held=
    release_stage kx-homer-dashboard-base/"$order" dev me kx-homer-dashboard-hub
  fi
fi
order=$(handover_order kx-argo-cd-base argo-cd handover-dec294e7)
cub changeorder create --space kx-argo-cd-base "$order" --change-workflow kx-argo-cd-base/rollout --description 'Release kx-argo-cd-hub for handover' --allow-exists --quiet
if rolled_out kx-argo-cd-base/"$order" && released kx-argo-cd-hub; then
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
# Argo CD reads the gateway with a token of kx-delivery, which can pull only these
# Targets' releases: the username is the word token, the password the token.
# A token the Secret already holds is kept while ConfigHub still lists it;
# otherwise a new one is issued, and the others this script issued for this
# hub are revoked once the Secret holds the new one. The token goes from cub
# into the Secret through variables and a file descriptor, never to disk or
# the command line.
held_jti=$(k -n argocd get secret confighub-kx-targets -o jsonpath='{.metadata.annotations.confighub\.com/token-jti}' 2>/dev/null || true)
token=""; jti=""
if [ -n "$held_jti" ] && cub serviceaccount token list kx-delivery -o json | live_tokens | jq -e --arg j "$held_jti" 'any(.[]; .Jti == $j)' >/dev/null; then
  token=$(k -n argocd get secret confighub-kx-targets -o jsonpath='{.data.password}' | base64 --decode)
  jti=$held_jti
  echo "the repository Secret's token of kx-delivery is still valid: kept"
fi
if [ -z "$token" ]; then
  issued=$(cub serviceaccount token create kx-delivery --description 'Argo CD on Kubara'\''s hub, kx' -o json) || { no_impersonate kx-delivery; exit 1; }
  token=$(printf '%s' "$issued" | jq -r '.Token // empty'); jti=$(printf '%s' "$issued" | jq -r '.UserToken.Jti // empty')
  [ -n "$token" ] && [ -n "$jti" ] || { echo "ConfigHub returned no token of kx-delivery"; exit 1; }
fi
k -n argocd create secret generic confighub-kx-targets \
  --from-literal=type=oci --from-literal=url=oci://oci.hub.confighub.com/space/kx- \
  --from-literal=username=token --from-file=password=<(printf '%s' "$token") \
  --dry-run=client -o yaml | k label --local -f - argocd.argoproj.io/secret-type=repo-creds -o yaml \
  | k annotate --local -f - confighub.com/token-jti="$jti" -o yaml | k apply -f -
unset token issued
{ cub serviceaccount token list kx-delivery -o json || { echo "could not list the tokens of kx-delivery, so earlier ones are not revoked" >&2; echo '[]'; }; } | live_tokens | jq -r --arg d 'Argo CD on Kubara'\''s hub, kx' --arg j "$jti" '.[] | select(.Description == $d and .Jti != $j) | .Jti' |
  while read -r old; do cub serviceaccount token revoke kx-delivery "$old" --quiet && echo "revoked an earlier token of kx-delivery" || echo "could not revoke an earlier token of kx-delivery: cub serviceaccount token revoke kx-delivery $old"; done
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

step "6/6 argobot records each Application's live status on the release it synced"
# argobot runs as kx-argobot, which step 1 gave EditChildren on each Target, and
# hears of each published release on the Channel kx-targets/argobot.
# A Channel made for an earlier kx-argobot, deleted and made again since, names
# that account's old identity. Adding the new one takes Claim on the Channel,
# which its maker does not have, so such a Channel is made again instead.
bot_uid=$(cub serviceaccount get kx-argobot -o jq=.ServiceAccount.UserID | tr -d '"')
make_channel() { echo '[{"EventTypes":["release.published"]}]' | cub channel create argobot --space kx-targets --subscriptions - --permission Claim:serviceaccount:kx-argobot --quiet; }
if claims=$(cub channel get kx-targets/argobot -o 'jq=.Channel.Permissions.Claim.UserIDs // {} | keys | join(" ")' 2>/dev/null); then
  case " $(printf '%s' "$claims" | tr -d '"') " in
    *" $bot_uid "*) ;;
    *) cub channel update kx-targets/argobot --patch --permission Claim:serviceaccount:kx-argobot --quiet 2>/dev/null || { cub channel delete kx-targets/argobot --quiet && make_channel; } ;;
  esac
else
  make_channel
fi
# Its credential is a key of kx-argobot; ConfigHub keeps only the public half. A key
# argobot's Secret already holds is kept while ConfigHub still lists it. One it
# no longer lists, after the account was deleted and made again say, is
# replaced, and so are keys this script added earlier for this hub.
k create namespace argobot --dry-run=client -o yaml | k apply -f - >/dev/null
key=$(k -n argobot get secret argobot-secrets -o jsonpath='{.data.CONFIGHUB_AUTH_PRIVATE_KEY}' 2>/dev/null | base64 --decode 2>/dev/null || true)
kid=""; [ -z "$key" ] || kid=$(printf '%s' "$key" | thumbprint 2>/dev/null) || kid=""
if [ -n "$kid" ] && cub serviceaccount key list kx-argobot -o json | jq -e --arg k "$kid" 'any(.[].UserKey; .Kid == $k)' >/dev/null; then
  echo "argobot's key of kx-argobot is still registered: kept"
else
  key_dir=$(mktemp -d)
  trap 'rm -rf "$key_dir"' EXIT
  cub serviceaccount key add kx-argobot --generate "$key_dir/argobot.jwk" --description 'argobot on Kubara'\''s hub, kx' >/dev/null || { no_impersonate kx-argobot; exit 1; }
  key=$(cat "$key_dir/argobot.jwk"); kid=$(printf '%s' "$key" | thumbprint)
  rm -rf "$key_dir"
fi
k -n argobot create secret generic argobot-secrets \
  --from-file=CONFIGHUB_URL=<(cub context get -o jq=.coordinate.serverURL | tr -d '\n') \
  --from-file=CONFIGHUB_AUTH_PRIVATE_KEY=<(printf '%s' "$key") \
  --dry-run=client -o yaml | k apply -f -
unset key
{ cub serviceaccount key list kx-argobot -o json || { echo "could not list the keys of kx-argobot, so earlier ones are not removed" >&2; echo '[]'; }; } | jq -r --arg d 'argobot on Kubara'\''s hub, kx' --arg k "$kid" '.[].UserKey | select(.Description == $d and .Kid != $k) | .Kid' |
  while read -r old; do cub serviceaccount key delete kx-argobot "$old" >/dev/null && echo "removed an earlier key of kx-argobot" || echo "could not remove an earlier key of kx-argobot: cub serviceaccount key delete kx-argobot $old"; done
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
k apply -f argobot.yaml
k -n argobot rollout restart deployment/argobot >/dev/null
k -n argobot rollout status deployment/argobot --timeout=180s || { echo "argobot did not start. What it said: kubectl -n argobot logs deployment/argobot"; exit 1; }
# argobot records a release's status when it starts, and again whenever the
# Application changes. Wait until each variant Space's newest published
# release, the one the Healthy gate reads, has one from this start; a release
# keeps the last status an earlier argobot recorded.
status() { cub release list --space "$1" --where "Published = true" -o 'jq=[.[].Release] | max_by(.ReleaseNum) | select((.LiveStatus.ObservedAt // "")[0:19] >= "'"${since%Z}"'") | {ReleaseNum, LiveStatus} | tojson'; }
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
    printf '%s: %s\n' "$space" "$(jq -r '"release \(.ReleaseNum) \(.LiveStatus.Sync) \(.LiveStatus.Health), from \(.LiveStatus.Reporter)"' <<<"$s")"
  else
    echo "$space: no live status yet"
  fi
done
[ "$missing" = 0 ] || { echo "argobot has not reported every Application. Look at: kubectl -n argobot logs deployment/argobot"; exit 1; }

echo
echo "Done. Kubara's hub now reads each cluster's approved release from ConfigHub,"
echo "and argobot records each Application's sync and health on the release it synced."
echo "See it with: cub release list --space <a variant Space>"
echo "Watch it with: kubectl get applications -n argocd"
echo "A manual sync must keep RespectIgnoreDifferences, as Kubara's sync options do;"
echo "without it, Argo CD empties the values of the Secrets ConfigHub holds without values."
