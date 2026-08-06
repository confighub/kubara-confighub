#!/usr/bin/env bash
set -euo pipefail

namespace="${1:-monitoring}"
route_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
secret_name="kube-prometheus-stack-admission"
create_job="kube-prometheus-stack-admission-create"

if [[ "$namespace" != "monitoring" ]]; then
  printf 'This packaged route was rendered for namespace monitoring, not %s.\n' "$namespace" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  printf 'kubectl is required to prepare the Kube Prometheus Stack admission webhook.\n' >&2
  exit 1
fi

secret_ready() {
  kubectl -n "$namespace" get "secret/$secret_name" >/dev/null 2>&1 &&
    test -n "$(kubectl -n "$namespace" get "secret/$secret_name" -o jsonpath='{.data.ca}')" &&
    test -n "$(kubectl -n "$namespace" get "secret/$secret_name" -o jsonpath='{.data.cert}')" &&
    test -n "$(kubectl -n "$namespace" get "secret/$secret_name" -o jsonpath='{.data.key}')"
}

kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$route_dir/hook-support.yaml"

if secret_ready; then
  printf 'Admission Secret %s/%s already has ca, cert, and key; keeping it.\n' "$namespace" "$secret_name"
  exit 0
fi

kubectl -n "$namespace" delete "job/$create_job" --ignore-not-found --wait=true
kubectl apply -f "$route_dir/admission-create-job.yaml"
kubectl -n "$namespace" wait \
  --for=condition=complete \
  --timeout=300s \
  "job/$create_job"

if ! secret_ready; then
  printf 'The admission-create Job completed without a complete %s/%s Secret.\n' "$namespace" "$secret_name" >&2
  exit 1
fi

printf 'Admission Secret %s/%s now has ca, cert, and key.\n' "$namespace" "$secret_name"
