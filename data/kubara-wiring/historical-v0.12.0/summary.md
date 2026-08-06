# Kubara Effective-Render Wiring — secondary-historical

This secondary historical report is generated from
committed effective Helm renders for Kubara
v0.12.0 across 1 cluster(s). It records
object references and selector matches visible in those manifests. It performs
no live reads and does not claim live reconciliation.

[Return to the Kubara buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html)
· [Browse the component-first Catalog](https://confighub.github.io/helm-expt/site/charts/)

Colored, accessible table: [graph.html](graph.html). Machine-readable forms:
[graph.json](graph.json) and [edges.csv](edges.csv). Render provenance:
[effective-render receipt](../../kubara-effective-renders/historical-v0.12.0/test-cluster/receipt.yaml).

## Summary

| Metric | Count |
| --- | ---: |
| Clusters | 1 |
| Logical components | 7 |
| Component instances | 7 |
| Normalized facts | 385 |
| Provides edges | 358 |
| Needs edges | 493 |
| Cross-component needs | 35 |
| Application delivery edges | 7 |
| ApplicationSets selecting zero clusters | 10 |
| Resolved by rendered object/CRD | 382 |
| Declared controller/hook output | 49 |
| External inputs | 37 |
| Target-cluster prerequisites not in render | 4 |
| Explicitly optional references without provider | 17 |
| Unresolved in aggregate render | 4 |
| Ambiguous owners | 0 |

`resolved-runtime` is deliberately amber: an ExternalSecret, Certificate,
annotated Ingress, or Helm hook declares an output, but this offline graph
cannot prove that a controller or hook created it. `target-prerequisite` and
`optional-unprovided` keep expected absences separate from genuine unresolved
wiring. `unresolved` means the aggregate render has no matching provider
declaration; it does not prove that a separately managed prerequisite is absent.

## Per component

| Cluster | Component | Selected package version(s) | Rendered objects | Needs | Rendered | Runtime | External | Target | Optional | Unresolved | Ambiguous |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| test-cluster | argo-cd | argo-cd/argo-cd@10.1.3 | 78 | 316 | 242 | 21 | 35 | 0 | 17 | 1 | 0 |
| test-cluster | cert-manager | jetstack/cert-manager@v1.21.0 | 54 | 44 | 38 | 5 | 1 | 0 | 0 | 0 | 0 |
| test-cluster | external-secrets | external-secrets/external-secrets@2.7.0 | 44 | 16 | 13 | 3 | 0 | 0 | 0 | 0 | 0 |
| test-cluster | homer-dashboard | kubara:homer-dashboard@0.1.0 | 8 | 7 | 5 | 1 | 0 | 0 | 0 | 1 | 0 |
| test-cluster | kube-prometheus-stack | prometheus-community/kube-prometheus-stack@87.15.1; prometheus-community/prometheus-blackbox-exporter@11.15.1 | 116 | 95 | 73 | 17 | 1 | 2 | 0 | 2 | 0 |
| test-cluster | metrics-server | metrics-server/metrics-server@3.13.1 | 10 | 9 | 6 | 1 | 0 | 2 | 0 | 0 | 0 |
| test-cluster | traefik | traefik/traefik@41.0.2 | 33 | 6 | 5 | 1 | 0 | 0 | 0 | 0 | 0 |

## Hub ApplicationSet delivery joins

Each row is one mechanically matched `ApplicationSet` selector and Argo cluster
registration Secret. `resolved-runtime` means an ExternalSecret declares the
spoke registration, but this offline render does not prove the Secret or the
generated Application exists live.

| ApplicationSet | Matching registration | Resolution |
| --- | --- | --- |
| cert-manager | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| traefik | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| homer-dashboard | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| metrics-server | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| argocd | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| external-secrets | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| kube-prometheus-stack | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |

## Cross-component joins

| Consumer | Provider(s) | Fact | Resolution |
| --- | --- | --- | --- |
| test-cluster/argo-cd | test-cluster/external-secrets | API external-secrets.io/ClusterExternalSecret | resolved-rendered |
| test-cluster/argo-cd | test-cluster/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| test-cluster/argo-cd | test-cluster/cert-manager | ClusterIssuer/letsencrypt-staging | resolved-rendered |
| test-cluster/argo-cd | test-cluster/traefik | IngressClass/traefik | resolved-rendered |
| test-cluster/argo-cd | test-cluster/argo-cd, test-cluster/cert-manager, test-cluster/external-secrets, test-cluster/homer-dashboard, test-cluster/kube-prometheus-stack, test-cluster/metrics-server, test-cluster/traefik | Namespace selector {"matchLabels":{"project-name":"test-cluster","stage":"local"}} in _cluster | resolved-rendered |
| test-cluster/cert-manager | test-cluster/kube-prometheus-stack | API monitoring.coreos.com/PrometheusRule | resolved-rendered |
| test-cluster/cert-manager | test-cluster/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| test-cluster/cert-manager | test-cluster/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| test-cluster/cert-manager | test-cluster/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| test-cluster/cert-manager | test-cluster/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| test-cluster/cert-manager | test-cluster/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| test-cluster/cert-manager | test-cluster/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| test-cluster/external-secrets | test-cluster/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| test-cluster/external-secrets | test-cluster/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| test-cluster/external-secrets | test-cluster/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| test-cluster/homer-dashboard | test-cluster/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| test-cluster/homer-dashboard | test-cluster/argo-cd | Secret/homer-dashboard/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/cert-manager | API cert-manager.io/Certificate | resolved-rendered |
| test-cluster/kube-prometheus-stack | test-cluster/cert-manager | API cert-manager.io/Certificate | resolved-rendered |
| test-cluster/kube-prometheus-stack | test-cluster/cert-manager | API cert-manager.io/Issuer | resolved-rendered |
| test-cluster/kube-prometheus-stack | test-cluster/cert-manager | API cert-manager.io/Issuer | resolved-rendered |
| test-cluster/kube-prometheus-stack | test-cluster/external-secrets | API external-secrets.io/ExternalSecret | resolved-rendered |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/kube-prometheus-stack | test-cluster/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| test-cluster/metrics-server | test-cluster/argo-cd | Secret/metrics-server/image-pull-secret | resolved-runtime |
| test-cluster/traefik | test-cluster/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| test-cluster/traefik | test-cluster/argo-cd | Secret/traefik/image-pull-secret | resolved-runtime |

## Explicit unknowns and external inputs

| Status | Component | Fact | Rendered reference | Why it is recorded |
| --- | --- | --- | --- | --- |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"longhorn":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"loki":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno-policies":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"metallb":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"oauth2-proxy":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"velero":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"reloader":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"external-dns":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | test-cluster/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno-policy-reporter":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ↗️ external | test-cluster/argo-cd | external secret test-cluster/local/cluster_secrets/docker_config#pull-secret | `external-secrets.io/v1|ClusterExternalSecret||image-pull-secret-ces` → `spec.externalSecretSpec.data[0].remoteRef` | remote secret backend input |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|homer-dashboard` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|traefik` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-secrets` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|argocd` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|metrics-server` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kube-prometheus-stack` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|cert-manager` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/external-secrets | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-secrets` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/longhorn | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/external-dns | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/cert-manager | `argoproj.io/v1alpha1|ApplicationSet|argocd|cert-manager` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/metrics-server | `argoproj.io/v1alpha1|ApplicationSet|argocd|metrics-server` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/metallb | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/traefik | `argoproj.io/v1alpha1|ApplicationSet|argocd|traefik` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/homer-dashboard | `argoproj.io/v1alpha1|ApplicationSet|argocd|homer-dashboard` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/kyverno-policy-reporter | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/velero | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/kyverno-policies | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/loki | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/reloader | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/argo-cd | `argoproj.io/v1alpha1|ApplicationSet|argocd|argocd` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/kube-prometheus-stack | `argoproj.io/v1alpha1|ApplicationSet|argocd|kube-prometheus-stack` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/kyverno | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | test-cluster/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/local-platform/generated/platform-components/helm/oauth2-proxy | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ❌ unresolved | test-cluster/argo-cd | ClusterSecretStore/test-cluster-local | `external-secrets.io/v1|ClusterExternalSecret||image-pull-secret-ces` → `spec.externalSecretSpec.secretStoreRef` | External Secrets store reference |
| ○ optional-unprovided | test-cluster/argo-cd | ConfigMap/argocd/argocd-styles-cm | `apps/v1|Deployment|argocd|argocd-server` → `spec.template.spec.volumes[4].configMap.name` | pod volume ConfigMap reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-dex-server-tls | `apps/v1|Deployment|argocd|argocd-server` → `spec.template.spec.volumes[6].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-dex-server-tls | `apps/v1|Deployment|argocd|argocd-dex-server` → `spec.template.spec.volumes[2].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argocd-server` → `spec.template.spec.volumes[5].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argocd-applicationset-controller` → `spec.template.spec.volumes[5].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argocd-repo-server` → `spec.template.spec.volumes[8].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | test-cluster/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|StatefulSet|argocd|argocd-application-controller` → `spec.template.spec.volumes[2].secret.secretName` | pod volume secret reference |
| ↗️ external | test-cluster/cert-manager | external endpoint https://acme-staging-v02.api.letsencrypt.org/directory | `cert-manager.io/v1|ClusterIssuer||letsencrypt-staging` → `spec.acme.server` | ACME server is external to the rendered object set |
| ❌ unresolved | test-cluster/homer-dashboard | Service selector {"matchLabels":{"argocd.argoproj.io/instance":"homer-dashboard"}} in homer-dashboard | `monitoring.coreos.com/v1|ServiceMonitor|homer-dashboard|homer-dashboard-metrics` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| ↗️ external | test-cluster/kube-prometheus-stack | external secret test-cluster/local/kube-prometheus-stack/grafana_credentials | `external-secrets.io/v1|ExternalSecret|kube-prometheus-stack|grafana-admin-credentials-es` → `spec.dataFrom[0]` | remote secret backend input |
| ❌ unresolved | test-cluster/kube-prometheus-stack | ClusterSecretStore/test-cluster-local | `external-secrets.io/v1|ExternalSecret|kube-prometheus-stack|grafana-admin-credentials-es` → `spec.secretStoreRef` | External Secrets store reference |
| 🏗️ target-prerequisite | test-cluster/kube-prometheus-stack | Service selector {"matchLabels":{"component":"apiserver","provider":"kubernetes"}} in default | `monitoring.coreos.com/v1|ServiceMonitor|kube-prometheus-stack|kube-prometheus-stack-apiserver` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| 🏗️ target-prerequisite | test-cluster/kube-prometheus-stack | Service selector {"matchLabels":{"app.kubernetes.io/name":"kubelet","k8s-app":"kubelet"}} in kube-system | `monitoring.coreos.com/v1|ServiceMonitor|kube-prometheus-stack|kube-prometheus-stack-kubelet` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| ❌ unresolved | test-cluster/kube-prometheus-stack | Service endpoint loki/loki-headless:3100 | `v1|ConfigMap|kube-prometheus-stack|kube-prometheus-stack-grafana-datasource` → `data.datasource.yaml` | Kubernetes service DNS endpoint reference |
| 🏗️ target-prerequisite | test-cluster/metrics-server | ClusterRole/system:auth-delegator | `rbac.authorization.k8s.io/v1|ClusterRoleBinding||metrics-server:system:auth-delegator` → `roleRef` | RBAC role reference |
| 🏗️ target-prerequisite | test-cluster/metrics-server | Role/kube-system/extension-apiserver-authentication-reader | `rbac.authorization.k8s.io/v1|RoleBinding|kube-system|metrics-server-auth-reader` → `roleRef` | RBAC role reference |

## Mechanical extraction scope

The extractor covers CRD/API dependencies, exact object references from pods,
RBAC, ingress, webhooks, APIService and autoscaling resources; ServiceMonitor,
Prometheus and ClusterExternalSecret label selectors; External Secrets stores
and remote keys; cert-manager issuer and generated-Secret contracts; Kubernetes
service-DNS URLs; service endpoints; PVC storage classes; Helm hook objects;
and Argo ApplicationSet joins to AppProjects, Git sources, and rendered or
controller-declared cluster registrations. An ApplicationSet selector with no
matching cluster registration is recorded as optional-unprovided because zero
generated Applications is a valid selector result.

Values branches that produced no object are absent by design. The graph does
not infer availability from component names, chart documentation, or the
historical live receipt.

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --verify --profile historical-v0.12.0
node scripts/generate-kubara-wiring.mjs --generate --profile historical-v0.12.0
node scripts/generate-kubara-wiring.mjs --verify --profile historical-v0.12.0
node scripts/generate-kubara-wiring.mjs --self-test
~~~
