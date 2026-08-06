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
  'external-tls-ca')
    if [ "$check_mode" = "live" ]; then
      live_check_secret 'kube-system' 'metrics-server-tls' 'tls.crt'
      live_check_secret 'kube-system' 'metrics-server-tls' 'tls.key'
      result="pass"
    else
      result="recorded"
    fi
    cat <<YAML
targetFacts:
  requiredSecrets:
  -
    namespace: "kube-system"
    name: "metrics-server-tls"
    keys:
      - "tls.crt"
      - "tls.key"
    purpose: "metrics-server serving certificate"
  requiredCRDs: []
  requiredValues:
  -
    path: "apiService.caBundle"
    purpose: "APIService CA bundle that validates kube-system/metrics-server-tls"
    stage: "pre-render"
    source: "metrics-server-tls-ca"
    installerInput: "apiServiceCaBundle"
    regularHelmFormat: "pem"
    installerInputFormat: "base64-pem"
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
