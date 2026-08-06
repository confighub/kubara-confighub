# prometheus-community/kube-prometheus-stack 87.15.1

> **Offline candidate only.** This artifact is for local, deterministic evaluation. It is not root-Catalog-retained, Kubara-compatible, live-qualified, or published.

This package contains 3 locally inspectable offline candidate preset configs:

- `default` includes the ten Prometheus Operator CRDs.
- `no-crds` leaves CRD ownership with the platform.
- `existing-secret` includes CRDs and references target-owned Grafana admin credentials.


All three presets carry the chart's real admission-webhook setup work. The package
includes the CRDs, the certificate creation and webhook patch Jobs, their
temporary RBAC, direct scripts, and a lifecycle action record under
`prerequisites/kube-prometheus-stack-lifecycle/`.

`cub installer setup` renders the checked Kubernetes objects. It does not
silently run the lifecycle actions. For this offline candidate, read `prerequisites/kube-prometheus-stack-lifecycle/README.md` and inspect the ordered steps; do not treat them as live-qualified.

The hook image is pinned by digest. The generation receipt ties every packaged
route file to the locked upstream chart.
