# Kubara Component × Cluster Matrix

This generated matrix joins the committed single-platform and four-cluster app
rollout receipts. It is a historical evidence view, not a current live query.
The proof uses ConfigHub-owned Argo CD and adapted variant/OCI delivery, so it
must not be presented as faithful Kubara Git/ApplicationSet delivery.

Colored, accessible view: [matrix.html](matrix.html). Machine-readable forms:
[matrix.csv](matrix.csv) and [matrix.json](matrix.json).

Receipt times: single-platform `2026-08-03T22:14:20Z`;
app-rollout `2026-08-03T08:10:00Z`.

## Matrix

| Component / selected version | hx-app-dev<br>dev | hx-app-staging<br>staging | hx-app-prod-a<br>prod / us-east | hx-app-prod-b<br>prod / us-west |
| --- | --- | --- | --- | --- |
| argo-cd<br>argo-cd/argo-cd@10.1.3 | 🔁 **substituted**<br>sync: Synced/Healthy (argobot delivery app)<br>observed: unknown | 🔁 **substituted**<br>sync: Synced/Healthy (argobot delivery app)<br>observed: unknown | 🔁 **substituted**<br>sync: Synced/Healthy (argobot delivery app)<br>observed: unknown | 🔁 **substituted**<br>sync: Synced/Healthy (argobot delivery app)<br>observed: unknown |
| cert-manager<br>jetstack/cert-manager@v1.21.0 | ⚠️ **watch**<br>sync: OutOfSync/Healthy<br>observed: v1.21.0 | ⚠️ **watch**<br>sync: OutOfSync/Healthy<br>observed: v1.21.0 | ⚠️ **watch**<br>sync: OutOfSync/Healthy<br>observed: v1.21.0 | ⚠️ **watch**<br>sync: OutOfSync/Healthy<br>observed: v1.21.0 |
| external-secrets<br>external-secrets/external-secrets@2.7.0 | ✅ **observed**<br>sync: Synced/Healthy (3 split apps)<br>observed: 2.7.0 | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed |
| homer-dashboard<br>kubara/homer-dashboard@0.1.0 | 🟣 **partial**<br>sync: unknown<br>observed: unknown | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed |
| kube-prometheus-stack<br>prometheus-community/kube-prometheus-stack@87.15.1 + prometheus-community/prometheus-blackbox-exporter@11.15.1 | 🟣 **partial**<br>sync: partial: CRD app hx-kps-crds-dev Synced/Healthy; main app sync unknown<br>observed: 87.19.0 (kube-prometheus-stack); prometheus-blackbox-exporter unknown | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed |
| metrics-server<br>metrics-server/metrics-server@3.13.1 | 🟣 **partial**<br>sync: unknown<br>observed: unknown | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed | ➖ **not-delivered**<br>sync: not-applicable<br>observed: not-observed |
| traefik<br>traefik/traefik@41.0.2 | ⚠️ **watch**<br>sync: Synced/Progressing<br>observed: 41.0.2 | ⚠️ **watch**<br>sync: Synced/Progressing<br>observed: 41.0.2 | ⚠️ **watch**<br>sync: Synced/Progressing<br>observed: 41.0.2 | ⚠️ **watch**<br>sync: Synced/Progressing<br>observed: 41.0.2 |

Status counts: substituted=4, watch=8, observed=1, not-delivered=12, partial=3. A green
`observed` cell requires both workload and exact component sync evidence.
Amber `watch` and purple `partial` cells are intentionally not promoted to
pass. Blue `substituted` means the role exists through a recorded replacement.

## Explicit unknowns in present cells

| Component | Cluster | Observed version | Sync state | Evidence scope |
| --- | --- | --- | --- | --- |
| argo-cd | hx-app-dev | unknown | Synced/Healthy (argobot delivery app) | per-cluster argobot summary; Kubara argo-cd is substituted |
| argo-cd | hx-app-staging | unknown | Synced/Healthy (argobot delivery app) | per-cluster argobot summary; Kubara argo-cd is substituted |
| argo-cd | hx-app-prod-a | unknown | Synced/Healthy (argobot delivery app) | per-cluster argobot summary; Kubara argo-cd is substituted |
| argo-cd | hx-app-prod-b | unknown | Synced/Healthy (argobot delivery app) | per-cluster argobot summary; Kubara argo-cd is substituted |
| homer-dashboard | hx-app-dev | unknown | unknown | dev workload recorded; exact component Argo state not recorded |
| kube-prometheus-stack | hx-app-dev | 87.19.0 (kube-prometheus-stack); prometheus-blackbox-exporter unknown | partial: CRD app hx-kps-crds-dev Synced/Healthy; main app sync unknown | dev CRD app exact; main app not recorded |
| metrics-server | hx-app-dev | unknown | unknown | dev workload recorded; exact component Argo state not recorded |

Selected versions remain visible in every cell, but they are not copied into
the observed-version field unless a receipt says what ran.

## Recorded departures

| ID | Components | Clusters | Compact description | Evidence |
| --- | --- | --- | --- | --- |
| `adapted-delivery` | cert-manager, external-secrets, homer-dashboard, kube-prometheus-stack, metrics-server, traefik | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | ConfigHub variant/OCI delivery replaces the native Kubara Git/ApplicationSet delivery path in this proof. | `runs/kubara-app-rollout-proof/receipt.yaml` → `spec.kubaraPlatform.source` |
| `argo-owner-substitution` | argo-cd | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | ConfigHub-owned Argo CD plus argobot replaces Kubara's selected argo-cd wrapper. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.argoOwner` |
| `cert-manager-cr-ordering` | cert-manager | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | ClusterIssuer and ServiceMonitor were split from the controller render for CRD-before-CR ordering. | `runs/kubara-app-rollout-proof/receipt.yaml` → `spec.kubaraPlatform.servicesDelivered[cert-manager].note` |
| `cert-manager-kind-issuer` | cert-manager | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | The kind proof uses a self-signed issuer instead of Kubara's public Let's Encrypt ACME issuer. | `runs/kubara-app-rollout-proof/receipt.yaml` → `status.limits` |
| `external-secrets-dev-scope` | external-secrets | hx-app-dev | External Secrets is evidenced on dev only in the committed platform receipt. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.platform.services[external-secrets]` |
| `external-secrets-fake-provider` | external-secrets | hx-app-dev | The dev proof uses external-secrets' fake provider, not a production secret backend. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.findings[external-secrets-fake-provider-contract]` |
| `external-secrets-namespace-adaptation` | external-secrets | hx-app-dev | A redundant Namespace/default object was removed after a shared-resource conflict. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.findings[external-secrets-shared-namespace]` |
| `homer-namespace-adaptation` | homer-dashboard | hx-app-dev | The live Units were assigned a namespace because the wrapper render omitted it. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.findings[render-omits-namespace]` |
| `kps-crd-split-ssa` | kube-prometheus-stack | hx-app-dev | Large monitoring CRDs were split and reconciled with server-side apply. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.findings[large-crd-annotation-limit]` |
| `kps-version-departure` | kube-prometheus-stack | hx-app-dev | The live proof used kube-prometheus-stack 87.19.0 because the selected 87.15.1 archive was unavailable from the repository index at run time. | `runs/kubara-single-platform-proof/receipt.yaml` → `spec.findings[pinned-version-pruned]` |
| `traefik-kind-loadbalancer` | traefik | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | Traefik remains Progressing because its LoadBalancer has no MetalLB on kind, while its pod is serving. | `runs/kubara-app-rollout-proof/receipt.yaml` → `spec.kubaraPlatform.argoStatusNotes` |
| `traefik-monitoring-strip` | traefik | hx-app-dev, hx-app-prod-a, hx-app-prod-b, hx-app-staging | ServiceMonitor was stripped in the adapted render; the Prometheus API was declared to satisfy the wrapper's render guard. | `runs/kubara-app-rollout-proof/receipt.yaml` → `spec.kubaraPlatform.servicesDelivered[traefik].note` |

Every present non-Argo cell includes `adapted-delivery`. The matrix therefore
shows what the existing ConfigHub proof established without turning it into a
claim that Kubara's native Git topology was exercised.

## Commands

~~~sh
node scripts/generate-kubara-platform-matrix.mjs --generate
node scripts/generate-kubara-platform-matrix.mjs --verify
node scripts/generate-kubara-platform-matrix.mjs --self-test
~~~
