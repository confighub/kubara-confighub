#!/usr/bin/env bash
# Remove the kind lab: its two clusters and its working directory. With
# CONFIGHUB=yes it also deletes the lab's Spaces ($PREFIX-*) from your
# ConfigHub organization, after listing them.
#
#   bash examples/kind-lab/down.sh
#   CONFIGHUB=yes bash examples/kind-lab/down.sh
set -euo pipefail
LAB=${LAB:-$PWD/kubara-lab}
HUB=${HUB:-hub}
SPOKE=${SPOKE:-spoke}
KIND=${KIND:-kubara}   # the kind clusters are $KIND-$HUB and $KIND-$SPOKE
PREFIX=${PREFIX:-kubara}

# grep reads all of what kind prints: grep -q stops early, kind then fails on a
# broken pipe, and pipefail would report a cluster that exists as missing.
for c in "$KIND-$HUB" "$KIND-$SPOKE"; do
  kind get clusters 2>/dev/null | grep -x "$c" >/dev/null && kind delete cluster --name "$c"
done
rm -rf "$LAB"

if [ "${CONFIGHUB:-}" = yes ]; then
  spaces=$(cub space list --where "Slug LIKE '$PREFIX-%'" --no-headers -o name)
  if [ -n "$spaces" ]; then
    echo "Deleting these Spaces and everything in them:"
    echo "$spaces"
    # One request, so Spaces that link to each other go together.
    cub space delete --where "Slug LIKE '$PREFIX-%'" --recursive-force --quiet
  else
    echo "no $PREFIX-* Spaces"
  fi
  # The service accounts handover.sh made; deleting one revokes its tokens and keys.
  for account in "$PREFIX-delivery" "$PREFIX-argobot"; do
    if cub serviceaccount get "$account" >/dev/null 2>&1; then
      cub serviceaccount delete "$account" --quiet && echo "deleted the service account $account"
    fi
  done
else
  echo "The lab's Spaces are still in ConfigHub. To delete them: CONFIGHUB=yes bash $0"
fi
