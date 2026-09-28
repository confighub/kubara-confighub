#!/usr/bin/env bash
# Bring the Kubara platform in testdata/platform into ConfigHub: bootstrap-crds, traefik, argo-cd, homer-dashboard.
# Written by `cub kubara apply`. Read it, then run it:
#
#   bash apply.sh
#
# cub uses its current context; set CUB_CONTEXT to choose another.
# It only creates records in ConfigHub. It changes nothing in Kubara or on any
# cluster: Kubara's hub, AppProject and ApplicationSets keep delivering from Git
# until takeover. All of it is safe to re-run.
#
# These Secrets are uploaded with their keys and without their values, which
# belong in the cluster's secret store:
#   argo-cd: Secret monitoring/grafana (2 values)
set -euo pipefail
cd "$(dirname "$0")"
step() { printf '\n== %s\n' "$*"; }
# A re-run patches a workflow only where it differs from this plan: the stages,
# when a cluster joins in a stage the workflow does not have yet, and the
# approval rule, when --allow-authors changes. Anything else set since is kept.
stages_are() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.Stages[].Name] | join(",")')" = "$3" ]; }
approval_is() { [ "$(cub changeworkflow get --space "$1" "$2" -o 'jq=[.ChangeWorkflow.AttestationPrerequisites[]? | select(.Name == "approval") | (.AllowAuthors // false)] | first // false | tostring')" = "$3" ]; }
# A variant takes its cluster's render once, as the first change after the
# clone. Later changes are made in ConfigHub, and a re-run leaves them alone.
# The clone is revisions 1 and 2, and the server may resolve it once as
# revision 3; anything else, a later resolve included, counts as a change.
take_render() {
  local edits
  edits=$(cub revision list --space "$1" "$2" -o 'jq=[.[] | .Revision | select(.RevisionNum > 2) | select(.RevisionNum != 3 or .Source != "Resolve")] | length')
  if [ "$edits" = 0 ]; then
    cub unit update --space "$1" "$2" "$3" --change-desc "$4" --quiet
  else
    echo "$1/$2 already has its cluster's render"
  fi
}

step "0/2 Check before changing anything"
cub space list --quiet >/dev/null || { echo "cub is not logged in: run cub auth login"; exit 1; }
cub changeworkflow --help >/dev/null 2>&1 || { echo "this cub has no change workflows; upgrade cub"; exit 1; }

step "1/2 A component, a base and a rollout workflow per Kubara component"
cub component create kx-bootstrap-crds --allow-exists --quiet
cub space create kx-bootstrap-crds-base --component kx-bootstrap-crds --allow-exists --quiet
cub unit create --space kx-bootstrap-crds-base bootstrap-crds bootstrap-crds/base.yaml --change-desc 'Kubara'\''s bootstrap-crds as generated for hub: the shared base' --allow-exists --quiet
cub changeworkflow create --space kx-bootstrap-crds-base rollout --filename bootstrap-crds/change-workflow.yaml --allow-exists --quiet
stages_are kx-bootstrap-crds-base rollout dev,prod || echo '{"Stages":[{"Name":"dev","WhereSpace":"Labels.Stage = '\''dev'\''","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space kx-bootstrap-crds-base rollout --from-stdin --quiet
approval_is kx-bootstrap-crds-base rollout true || echo '{"AttestationPrerequisites":[{"AllowAuthors":true,"Count":1,"Name":"approval","Type":"Approval"}]}' | cub changeworkflow update --patch --space kx-bootstrap-crds-base rollout --from-stdin --quiet
cub component create kx-traefik --allow-exists --quiet
cub space create kx-traefik-base --component kx-traefik --allow-exists --quiet
cub unit create --space kx-traefik-base traefik traefik/base.yaml --change-desc 'Kubara'\''s traefik as generated for hub: the shared base' --allow-exists --quiet
cub changeworkflow create --space kx-traefik-base rollout --filename traefik/change-workflow.yaml --allow-exists --quiet
stages_are kx-traefik-base rollout dev,prod || echo '{"Stages":[{"Name":"dev","WhereSpace":"Labels.Stage = '\''dev'\''","ReleasePrerequisites":["approval"]},{"Name":"prod","WhereSpace":"Labels.Stage = '\''prod'\''","Prerequisites":["Released"],"ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space kx-traefik-base rollout --from-stdin --quiet
approval_is kx-traefik-base rollout true || echo '{"AttestationPrerequisites":[{"AllowAuthors":true,"Count":1,"Name":"approval","Type":"Approval"}]}' | cub changeworkflow update --patch --space kx-traefik-base rollout --from-stdin --quiet
cub component create kx-argo-cd --allow-exists --quiet
cub space create kx-argo-cd-base --component kx-argo-cd --allow-exists --quiet
cub unit create --space kx-argo-cd-base argo-cd argo-cd/base.yaml --change-desc 'Kubara'\''s argo-cd as generated for hub: the shared base' --allow-exists --quiet
cub changeworkflow create --space kx-argo-cd-base rollout --filename argo-cd/change-workflow.yaml --allow-exists --quiet
stages_are kx-argo-cd-base rollout dev || echo '{"Stages":[{"Name":"dev","WhereSpace":"Labels.Stage = '\''dev'\''","ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space kx-argo-cd-base rollout --from-stdin --quiet
approval_is kx-argo-cd-base rollout true || echo '{"AttestationPrerequisites":[{"AllowAuthors":true,"Count":1,"Name":"approval","Type":"Approval"}]}' | cub changeworkflow update --patch --space kx-argo-cd-base rollout --from-stdin --quiet
cub component create kx-homer-dashboard --allow-exists --quiet
cub space create kx-homer-dashboard-base --component kx-homer-dashboard --allow-exists --quiet
cub unit create --space kx-homer-dashboard-base homer-dashboard homer-dashboard/base.yaml --change-desc 'Kubara'\''s homer-dashboard as generated for hub: the shared base' --allow-exists --quiet
cub changeworkflow create --space kx-homer-dashboard-base rollout --filename homer-dashboard/change-workflow.yaml --allow-exists --quiet
stages_are kx-homer-dashboard-base rollout dev || echo '{"Stages":[{"Name":"dev","WhereSpace":"Labels.Stage = '\''dev'\''","ReleasePrerequisites":["approval"]}]}' | cub changeworkflow update --patch --space kx-homer-dashboard-base rollout --from-stdin --quiet
approval_is kx-homer-dashboard-base rollout true || echo '{"AttestationPrerequisites":[{"AllowAuthors":true,"Count":1,"Name":"approval","Type":"Approval"}]}' | cub changeworkflow update --patch --space kx-homer-dashboard-base rollout --from-stdin --quiet

step "2/2 A variant per cluster, holding that cluster's own render"
cub variant create hub kx-bootstrap-crds-base --stage dev --space-pattern template:kx-bootstrap-crds-hub --allow-exists --quiet >/dev/null
echo 'kx-bootstrap-crds-hub: the base is this cluster'\''s render'
cub variant create edge kx-bootstrap-crds-base --stage prod --space-pattern template:kx-bootstrap-crds-edge --allow-exists --quiet >/dev/null
echo 'kx-bootstrap-crds-edge: Kubara renders it the same as on hub; no change to record'
cub variant create hub kx-traefik-base --stage dev --space-pattern template:kx-traefik-hub --allow-exists --quiet >/dev/null
echo 'kx-traefik-hub: the base is this cluster'\''s render'
cub variant create edge kx-traefik-base --stage prod --space-pattern template:kx-traefik-edge --allow-exists --quiet >/dev/null
take_render kx-traefik-edge traefik traefik/edge.yaml 'Kubara'\''s values for edge'
cub variant create hub kx-argo-cd-base --stage dev --space-pattern template:kx-argo-cd-hub --allow-exists --quiet >/dev/null
echo 'kx-argo-cd-hub: the base is this cluster'\''s render'
cub variant create hub kx-homer-dashboard-base --stage dev --space-pattern template:kx-homer-dashboard-hub --allow-exists --quiet >/dev/null
echo 'kx-homer-dashboard-hub: the base is this cluster'\''s render'

step "Done"
echo "Every Kubara component now has a base and a variant per cluster in ConfigHub."
echo "To change the platform: edit a base, promote the change stage by stage with"
echo "  cub changeorder create ... then cub variant promote and cub variant approve."
echo "Kubara's hub still delivers from Git; pointing it at approved releases is takeover."
