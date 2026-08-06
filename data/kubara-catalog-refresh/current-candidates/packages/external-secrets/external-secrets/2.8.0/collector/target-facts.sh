#!/bin/sh
set -eu

base="${INSTALLER_BASE:-default}"
check_mode="${TARGET_FACT_CHECK_MODE:-record}"

emit_empty() {
  cat <<YAML
targetFacts:
  requiredSecrets: []
  requiredCRDs: []
  requiredValues: []
  requiredObjectStores: []
  requiredTopology: null
targetFactChecks:
  base: "$base"
  mode: not-required
  result: pass
YAML
}

live_check_secret() {
  namespace="$1"
  name="$2"
  key="$3"
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2
    exit 1
  fi
  if ! kubectl -n "$namespace" get secret "$name" >/dev/null 2>&1; then
    echo "required Secret $namespace/$name was not found" >&2
    exit 1
  fi
  if [ -z "$key" ]; then
    return 0
  fi
  if ! kubectl -n "$namespace" get secret "$name" -o yaml | awk -v key="$key" '$1 == key ":" { found=1 } END { exit found ? 0 : 1 }'; then
    echo "required Secret $namespace/$name is missing key $key" >&2
    exit 1
  fi
}

live_check_crd() {
  name="$1"
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2
    exit 1
  fi
  if ! kubectl get crd "$name" >/dev/null 2>&1; then
    echo "required CRD $name was not found" >&2
    exit 1
  fi
}

live_check_min_schedulable_nodes() {
  required="$1"
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2
    exit 1
  fi
  count="$(kubectl get nodes -o jsonpath='{range .items[*]}{.spec.unschedulable}{"\n"}{end}' | awk '$1 != "true" { c++ } END { print c + 0 }')"
  if [ "$count" -lt "$required" ]; then
    echo "required at least $required schedulable node(s); found $count" >&2
    exit 1
  fi
}

case "$base" in
  'default')
    if [ "$check_mode" = "live" ]; then
      live_check_secret 'external-secrets' 'external-secrets-webhook' ''
      result="pass"
    else
      result="recorded"
    fi
    cat <<YAML
targetFacts:
  requiredSecrets:
  -
    namespace: "external-secrets"
    name: "external-secrets-webhook"
    keys:
      []
    sourceVariant: "default"
    purpose: "Rendered webhook Secret separated by installer and populated by the cert-controller after apply"
    deliveryLanes:
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
    suggestedSource: "kubectl -n external-secrets apply -f <work-dir>/out/secrets/secret-external-secrets-external-secrets-webhook.yaml"
  requiredCRDs: []
  requiredValues: []
  requiredObjectStores: []
  requiredTopology: null
targetFactChecks:
  base: "$base"
  mode: "$check_mode"
  result: "$result"
YAML
    ;;
  'no-crds')
    if [ "$check_mode" = "live" ]; then
      live_check_secret 'external-secrets' 'external-secrets-webhook' ''
      live_check_crd 'acraccesstokens.generators.external-secrets.io'
      live_check_crd 'beyondtrustworkloadcredentialsdynamicsecrets.generators.external-secrets.io'
      live_check_crd 'cloudsmithaccesstokens.generators.external-secrets.io'
      live_check_crd 'clusterexternalsecrets.external-secrets.io'
      live_check_crd 'clustergenerators.generators.external-secrets.io'
      live_check_crd 'clusterpushsecrets.external-secrets.io'
      live_check_crd 'clustersecretstores.external-secrets.io'
      live_check_crd 'ecrauthorizationtokens.generators.external-secrets.io'
      live_check_crd 'externalsecrets.external-secrets.io'
      live_check_crd 'fakes.generators.external-secrets.io'
      live_check_crd 'gcraccesstokens.generators.external-secrets.io'
      live_check_crd 'generatorstates.generators.external-secrets.io'
      live_check_crd 'githubaccesstokens.generators.external-secrets.io'
      live_check_crd 'gitlabdeploytokens.generators.external-secrets.io'
      live_check_crd 'grafanas.generators.external-secrets.io'
      live_check_crd 'mfas.generators.external-secrets.io'
      live_check_crd 'passwords.generators.external-secrets.io'
      live_check_crd 'pushsecrets.external-secrets.io'
      live_check_crd 'quayaccesstokens.generators.external-secrets.io'
      live_check_crd 'secretstores.external-secrets.io'
      live_check_crd 'sshkeys.generators.external-secrets.io'
      live_check_crd 'stssessiontokens.generators.external-secrets.io'
      live_check_crd 'uuids.generators.external-secrets.io'
      live_check_crd 'vaultdynamicsecrets.generators.external-secrets.io'
      live_check_crd 'webhooks.generators.external-secrets.io'
      result="pass"
    else
      result="recorded"
    fi
    cat <<YAML
targetFacts:
  requiredSecrets:
  -
    namespace: "external-secrets"
    name: "external-secrets-webhook"
    keys:
      []
    sourceVariant: "default"
    purpose: "Rendered webhook Secret separated by installer and populated by the cert-controller after apply"
    deliveryLanes:
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
    suggestedSource: "kubectl -n external-secrets apply -f <work-dir>/out/secrets/secret-external-secrets-external-secrets-webhook.yaml"
  requiredCRDs:
  -
    name: "acraccesstokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "beyondtrustworkloadcredentialsdynamicsecrets.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "cloudsmithaccesstokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "clusterexternalsecrets.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "clustergenerators.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "clusterpushsecrets.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "clustersecretstores.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "ecrauthorizationtokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "externalsecrets.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "fakes.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "gcraccesstokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "generatorstates.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "githubaccesstokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "gitlabdeploytokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "grafanas.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "mfas.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "passwords.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "pushsecrets.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "quayaccesstokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "secretstores.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "sshkeys.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "stssessiontokens.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "uuids.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "vaultdynamicsecrets.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  -
    name: "webhooks.generators.external-secrets.io"
    sourceVariant: "default"
    purpose: "External Secrets CRD managed outside this no-crds base"
    deliveryLanes:
      - "regularHelm"
      - "cubInstallerApply"
      - "configHubKubectlApply"
      - "configHubOciArgo"
  requiredValues: []
  requiredObjectStores: []
  requiredTopology: null
targetFactChecks:
  base: "$base"
  mode: "$check_mode"
  result: "$result"
YAML
    ;;
  *)
    emit_empty
    ;;
esac
