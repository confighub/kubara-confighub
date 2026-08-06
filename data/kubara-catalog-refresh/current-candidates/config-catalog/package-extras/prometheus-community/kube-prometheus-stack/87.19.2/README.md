# Kube Prometheus Stack setup

> **Offline candidate only.** This lifecycle route is for local evaluation and has not been live-qualified or root-Catalog-retained.

Kube Prometheus Stack needs more than one unordered `kubectl apply`.

This chart installs ten Prometheus Operator CRDs. It also runs one Job before
the ordinary objects to create the admission-webhook certificate, then a
second Job after the ordinary objects to patch and check the webhook.

The package keeps those steps beside the rendered Kubernetes objects:

1. Apply `default-crds.yaml` and wait for all ten CRDs.
2. Run `prepare.sh` to create the admission Secret.
3. Apply the rendered Secrets and ordinary objects.
4. Run `finish.sh` to patch and check the webhook, then remove the temporary
   Jobs and RBAC.

The two Jobs and their RBAC come from the locked
`prometheus-community/kube-prometheus-stack@87.19.2` chart. Their container
image is pinned to the multi-platform digest recorded in
`generation-receipt.yaml`.

After qualification and promotion, a generated `try.sh` for this preset runs these steps in order. ConfigHub does
not silently execute them. `lifecycle-actions.yaml` records the same order for
people, agents, and delivery-tool integrations.
