#!/usr/bin/env bash
set -euo pipefail

namespace="${1:-monitoring}"
base="${KPS_LIFECYCLE_BASE:-default}"
route_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
secret_name="kube-prometheus-stack-admission"
create_job="kube-prometheus-stack-admission-create"
patch_job="kube-prometheus-stack-admission-patch"
operator_deployment="kube-prometheus-stack-operator"
receipt_path="${HELM_EXPT_LIFECYCLE_RECEIPT:-${KPS_LIFECYCLE_RECEIPT:-}}"

if [[ "$namespace" != "monitoring" ]]; then
  printf 'This packaged route was rendered for namespace monitoring, not %s.\n' "$namespace" >&2
  exit 1
fi

if [[ "$base" != "default" && "$base" != "no-crds" && "$base" != "existing-secret" ]]; then
  printf 'This packaged route supports the default, no-crds, and existing-secret bases, not %s.\n' "$base" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  printf 'kubectl is required to finish the Kube Prometheus Stack admission webhook setup.\n' >&2
  exit 1
fi

kubectl apply -f "$route_dir/hook-support.yaml"
kubectl -n "$namespace" delete "job/$patch_job" --ignore-not-found --wait=true
kubectl apply -f "$route_dir/admission-patch-job.yaml"
kubectl -n "$namespace" wait \
  --for=condition=complete \
  --timeout=300s \
  "job/$patch_job"

secret_ca="$(kubectl -n "$namespace" get "secret/$secret_name" -o jsonpath='{.data.ca}')"
if [[ -z "$secret_ca" ]]; then
  printf 'Admission Secret %s/%s has no ca value.\n' "$namespace" "$secret_name" >&2
  exit 1
fi

bundle_count=0
while IFS= read -r bundle; do
  [[ -z "$bundle" ]] && continue
  bundle_count=$((bundle_count + 1))
  if [[ "$bundle" != "$secret_ca" ]]; then
    printf 'A webhook CA bundle does not match Secret %s/%s.\n' "$namespace" "$secret_name" >&2
    exit 1
  fi
done < <(
  {
    kubectl get "mutatingwebhookconfiguration/$secret_name" \
      -o jsonpath='{range .webhooks[*]}{.clientConfig.caBundle}{"\n"}{end}'
    kubectl get "validatingwebhookconfiguration/$secret_name" \
      -o jsonpath='{range .webhooks[*]}{.clientConfig.caBundle}{"\n"}{end}'
  }
)

if [[ "$bundle_count" -ne 3 ]]; then
  printf 'Expected three admission webhook CA bundles; found %s.\n' "$bundle_count" >&2
  exit 1
fi

kubectl -n "$namespace" rollout status \
  "deployment/$operator_deployment" \
  --timeout=300s

endpoint="$(
  kubectl -n "$namespace" get "endpoints/$operator_deployment" \
    -o jsonpath='{.subsets[0].addresses[0].ip}'
)"
if [[ -z "$endpoint" ]]; then
  printf 'The Prometheus Operator webhook Service has no ready endpoint.\n' >&2
  exit 1
fi

kubectl apply --server-side --dry-run=server -f - >/dev/null <<EOF_RULE
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: packaged-lifecycle-probe
  namespace: ${namespace}
spec:
  groups:
    - name: packaged-lifecycle-probe
      rules:
        - alert: PackagedLifecycleProbe
          expr: vector(1)
EOF_RULE

kubectl -n "$namespace" delete \
  "job/$create_job" \
  "job/$patch_job" \
  --ignore-not-found \
  --wait=true
kubectl delete -f "$route_dir/hook-support.yaml" \
  --ignore-not-found \
  --wait=true

printf 'Admission webhook setup passed: three CA bundles match and the operator endpoint is ready.\n'

if [[ -n "$receipt_path" ]]; then
  cat >"$receipt_path" <<EOF_RECEIPT
apiVersion: helm-expt.confighub.com/v1alpha1
kind: LifecycleActionReceipt
metadata:
  name: prometheus-community-kube-prometheus-stack-87-15-1-admission
spec:
  result: pass
  chart: prometheus-community/kube-prometheus-stack
  version: 87.15.1
  base: ${base}
  namespace: ${namespace}
  admissionSecret: ${secret_name}
  matchingWebhookCABundles: ${bundle_count}
  operatorEndpointReady: true
  serverDryRun: pass
  temporaryResourcesRemoved: true
EOF_RECEIPT
fi
