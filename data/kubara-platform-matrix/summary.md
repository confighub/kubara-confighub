# Kubara Component × Cluster Matrix — primary current

This is the primary matrix for Kubara v0.13.0 with official
catalogs 1.1.0. It is generated from the four-cluster
current config, committed effective renders, and two digest-pinned app fixtures.
Historical v0.12.0 adapted
evidence is retained separately under [historical-v0.12.0](historical-v0.12.0/summary.md).

[Return to the Kubara buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html)
· [Browse the component-first Catalog](https://confighub.github.io/helm-expt/site/charts/)

Colored, accessible view: [matrix.html](matrix.html). Machine-readable forms:
[matrix.csv](matrix.csv) and [matrix.json](matrix.json).

## Matrix

| Component / selected version | hx-app-dev<br>dev / hub | hx-app-staging<br>staging / spoke | hx-app-prod-a<br>prod / spoke | hx-app-prod-b<br>prod / spoke |
| --- | --- | --- | --- | --- |
| argo-cd<br>argo-cd/argo-cd@10.2.1 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: v3.4.6 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: v3.4.6 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: v3.4.6 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: v3.4.6 |
| cert-manager<br>jetstack/cert-manager@v1.21.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: cert-manager-v1.21.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: cert-manager-v1.21.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: cert-manager-v1.21.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: cert-manager-v1.21.0 |
| external-secrets<br>external-secrets/external-secrets@2.8.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: external-secrets-2.8.0 | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown |
| homer-dashboard<br>kubara/homer-dashboard@0.1.0 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: b4bz/homer:v26.4.2 | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown |
| kube-prometheus-stack<br>prometheus-community/kube-prometheus-stack@87.19.2 + prometheus-community/prometheus-blackbox-exporter@11.15.1 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: 87.19.2 + grafana-12.8.1 + kube-state-metrics-8.0.0 + prometheus-blackbox-exporter-11.15.1 + prometheus-node-exporter-4.56.1 | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown |
| metrics-server<br>metrics-server/metrics-server@3.13.1 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: metrics-server-3.13.1 | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown | ➖ **disabled**<br>Argo sync: NotApplicable<br>health/ready: NotApplicable / not-applicable<br>observed: Unknown |
| traefik<br>traefik/traefik@41.0.2 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: traefik-41.0.2 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: traefik-41.0.2 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: traefik-41.0.2 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: traefik-41.0.2 |
| hx-web<br>nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d |
| cubbychat<br>commit e9e76a076924d95897c3ede7a0f21cec523c4f6f; 3 digest-pinned images | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: ghcr.io/confighub/cubbychat/backend@sha256:0d8342bcb139662ab76b962609f3f99da0b3aaa050a97ad7230eb0c73f440755 + ghcr.io/confighub/cubbychat/frontend@sha256:4e2c305b56af8414fab8f1ee2c3b075d96d7f60a7bd9f1c73c733e0ee81dffe5 + postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: ghcr.io/confighub/cubbychat/backend@sha256:0d8342bcb139662ab76b962609f3f99da0b3aaa050a97ad7230eb0c73f440755 + ghcr.io/confighub/cubbychat/frontend@sha256:4e2c305b56af8414fab8f1ee2c3b075d96d7f60a7bd9f1c73c733e0ee81dffe5 + postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: ghcr.io/confighub/cubbychat/backend@sha256:0d8342bcb139662ab76b962609f3f99da0b3aaa050a97ad7230eb0c73f440755 + ghcr.io/confighub/cubbychat/frontend@sha256:4e2c305b56af8414fab8f1ee2c3b075d96d7f60a7bd9f1c73c733e0ee81dffe5 + postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20 | ✅ **observed**<br>Argo sync: Synced<br>health/ready: Healthy / pass<br>observed: ghcr.io/confighub/cubbychat/backend@sha256:0d8342bcb139662ab76b962609f3f99da0b3aaa050a97ad7230eb0c73f440755 + ghcr.io/confighub/cubbychat/frontend@sha256:4e2c305b56af8414fab8f1ee2c3b075d96d7f60a7bd9f1c73c733e0ee81dffe5 + postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20 |

Status counts: observed=24, disabled=12.
Purple `rendered-only` means desired state is committed and mechanically
rendered but sync/workload state is unknown. Blue `centralized` records that
spokes are managed by hub Argo CD rather than pretending an Argo instance is
installed on each spoke.

Live overlay receipt: `runs/kubara-mini-idp-reconcile/receipt.yaml` (validation:
`accepted-current-live`; accepted as live:
`true`; source digests verified:
16; parsed cells:
36). Validation notes:
- Kubara v0.13.0, all source digests, and all 36 liveMatrix cells validated.

Scoped residue audit: `runs/kubara-mini-idp-reconcile/orphan-audit.yaml` (validation:
`accepted-current-scoped-residue-clean`; accepted:
`true`; observed:
`2026-08-06T09:10:55.578Z`; SHA-256:
`c588c4882ed5de66d4dde68cf0f09f94ee9b976bca740e14cec4c6796bebdb23`). It proves exact ConfigHub
inventory, zero Argo-prunable resources, and zero unclassified, dangling, or
UID-stale workloads among the five audited durable types. It does not claim a
complete inventory of every Kubernetes resource type.

The non-live [desired-matrix.json](desired-matrix.json) is generated first and
digest-pinned by the reconciliation receipt. The final matrix overlays that
base only after the receipt proves Kubara v0.13.0, all current source digests,
and all 36 component/application cells. The faithful-lane receipt remains
separate topology evidence (status: `pass`).

## Explicit unknowns

| Component | Cluster | Observed version | Argo sync | Health | Readiness | Why Unknown |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — |

## Declared values overrides

These are normal Kubara input overlays, not silently reclassified as live
departures.

| Cluster | Component | Override file(s) |
| --- | --- | --- |
| hx-app-dev | argo-cd | `examples/kubara/current-platform/source/overrides/hx-app-dev/helm/argo-cd/values-repository-paths.yaml` |
| hx-app-dev | cert-manager | `examples/kubara/current-platform/source/overrides/hx-app-dev/helm/cert-manager/values-kind.yaml` |
| hx-app-staging | cert-manager | `examples/kubara/current-platform/source/overrides/hx-app-staging/helm/cert-manager/values-kind.yaml` |
| hx-app-prod-a | cert-manager | `examples/kubara/current-platform/source/overrides/hx-app-prod-a/helm/cert-manager/values-kind.yaml` |
| hx-app-prod-b | cert-manager | `examples/kubara/current-platform/source/overrides/hx-app-prod-b/helm/cert-manager/values-kind.yaml` |
| hx-app-dev | homer-dashboard | `examples/kubara/current-platform/source/overrides/hx-app-dev/helm/homer-dashboard/values-project-links.yaml` |
| hx-app-dev | metrics-server | `examples/kubara/current-platform/source/overrides/hx-app-dev/helm/metrics-server/values-kind.yaml` |
| hx-app-dev | traefik | `examples/kubara/current-platform/source/overrides/hx-app-dev/helm/traefik/values-kind.yaml` |
| hx-app-staging | traefik | `examples/kubara/current-platform/source/overrides/hx-app-staging/helm/traefik/values-kind.yaml` |
| hx-app-prod-a | traefik | `examples/kubara/current-platform/source/overrides/hx-app-prod-a/helm/traefik/values-kind.yaml` |
| hx-app-prod-b | traefik | `examples/kubara/current-platform/source/overrides/hx-app-prod-b/helm/traefik/values-kind.yaml` |

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --verify --profile current
node scripts/generate-kubara-platform-matrix.mjs --generate --profile current
node scripts/generate-kubara-platform-matrix.mjs --verify --profile current
node scripts/generate-kubara-platform-matrix.mjs --self-test
~~~
