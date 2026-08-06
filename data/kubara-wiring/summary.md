# Kubara Effective-Render Wiring — primary-current

This primary report is generated from
committed effective Helm renders for Kubara
v0.13.0 across 4 cluster(s). It records
object references and selector matches visible in those manifests. It performs
no live reads and does not claim live reconciliation.

[Return to the Kubara buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html)
· [Browse the component-first Catalog](https://confighub.github.io/helm-expt/site/charts/)

Colored, accessible table: [graph.html](graph.html). Machine-readable forms:
[graph.json](graph.json) and [edges.csv](edges.csv). Render provenance:
[effective-render receipt](../kubara-effective-renders/current-platform/receipt.yaml).

## Summary

| Metric | Count |
| --- | ---: |
| Clusters | 4 |
| Logical components | 7 |
| Component instances | 13 |
| Normalized facts | 663 |
| Provides edges | 626 |
| Needs edges | 649 |
| Cross-component needs | 40 |
| Application delivery edges | 13 |
| ApplicationSets selecting zero clusters | 10 |
| Resolved by rendered object/CRD | 508 |
| Declared controller/hook output | 49 |
| External inputs | 39 |
| Target-cluster prerequisites not in render | 4 |
| Explicitly optional references without provider | 23 |
| Unresolved in aggregate render | 26 |
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
| hx-app-dev | argo-cd | argo-cd/argo-cd@10.2.1 | 86 | 335 | 248 | 21 | 38 | 0 | 23 | 5 | 0 |
| hx-app-dev | cert-manager | jetstack/cert-manager@v1.21.0 | 54 | 43 | 38 | 5 | 0 | 0 | 0 | 0 | 0 |
| hx-app-dev | external-secrets | external-secrets/external-secrets@2.8.0 | 50 | 22 | 19 | 3 | 0 | 0 | 0 | 0 | 0 |
| hx-app-dev | homer-dashboard | kubara:homer-dashboard@0.1.0 | 8 | 7 | 5 | 1 | 0 | 0 | 0 | 1 | 0 |
| hx-app-dev | kube-prometheus-stack | prometheus-community/kube-prometheus-stack@87.19.2; prometheus-community/prometheus-blackbox-exporter@11.15.1 | 116 | 95 | 73 | 17 | 1 | 2 | 0 | 2 | 0 |
| hx-app-dev | metrics-server | metrics-server/metrics-server@3.13.1 | 10 | 9 | 6 | 1 | 0 | 2 | 0 | 0 | 0 |
| hx-app-dev | traefik | traefik/traefik@41.0.2 | 33 | 6 | 5 | 1 | 0 | 0 | 0 | 0 | 0 |
| hx-app-prod-a | cert-manager | jetstack/cert-manager@v1.21.0 | 52 | 40 | 35 | 0 | 0 | 0 | 0 | 5 | 0 |
| hx-app-prod-a | traefik | traefik/traefik@41.0.2 | 32 | 4 | 3 | 0 | 0 | 0 | 0 | 1 | 0 |
| hx-app-prod-b | cert-manager | jetstack/cert-manager@v1.21.0 | 52 | 40 | 35 | 0 | 0 | 0 | 0 | 5 | 0 |
| hx-app-prod-b | traefik | traefik/traefik@41.0.2 | 32 | 4 | 3 | 0 | 0 | 0 | 0 | 1 | 0 |
| hx-app-staging | cert-manager | jetstack/cert-manager@v1.21.0 | 52 | 40 | 35 | 0 | 0 | 0 | 0 | 5 | 0 |
| hx-app-staging | traefik | traefik/traefik@41.0.2 | 32 | 4 | 3 | 0 | 0 | 0 | 0 | 1 | 0 |

## Hub ApplicationSet delivery joins

Each row is one mechanically matched `ApplicationSet` selector and Argo cluster
registration Secret. `resolved-runtime` means an ExternalSecret declares the
spoke registration, but this offline render does not prove the Secret or the
generated Application exists live.

| ApplicationSet | Matching registration | Resolution |
| --- | --- | --- |
| metrics-server | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| cert-manager | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| traefik | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| kube-prometheus-stack | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| homer-dashboard | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| argocd | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| external-secrets | Secret/argocd/cluster-kubernetes.default.svc | resolved-rendered |
| cert-manager | Secret/argocd/hx-app-prod-a-cluster-secret | resolved-runtime |
| traefik | Secret/argocd/hx-app-prod-a-cluster-secret | resolved-runtime |
| traefik | Secret/argocd/hx-app-prod-b-cluster-secret | resolved-runtime |
| cert-manager | Secret/argocd/hx-app-prod-b-cluster-secret | resolved-runtime |
| cert-manager | Secret/argocd/hx-app-staging-cluster-secret | resolved-runtime |
| traefik | Secret/argocd/hx-app-staging-cluster-secret | resolved-runtime |

## Cross-component joins

| Consumer | Provider(s) | Fact | Resolution |
| --- | --- | --- | --- |
| hx-app-dev/argo-cd | hx-app-dev/external-secrets | API external-secrets.io/ClusterExternalSecret | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/external-secrets | API external-secrets.io/ExternalSecret | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/external-secrets | API external-secrets.io/ExternalSecret | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/external-secrets | API external-secrets.io/ExternalSecret | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/traefik | IngressClass/traefik | resolved-rendered |
| hx-app-dev/argo-cd | hx-app-dev/argo-cd, hx-app-dev/cert-manager, hx-app-dev/external-secrets, hx-app-dev/homer-dashboard, hx-app-dev/kube-prometheus-stack, hx-app-dev/metrics-server, hx-app-dev/traefik | Namespace selector {"matchLabels":{"project-name":"hx-app-dev","stage":"dev"}} in _cluster | resolved-rendered |
| hx-app-dev/cert-manager | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/PrometheusRule | resolved-rendered |
| hx-app-dev/cert-manager | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/cert-manager | hx-app-dev/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| hx-app-dev/cert-manager | hx-app-dev/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| hx-app-dev/cert-manager | hx-app-dev/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| hx-app-dev/cert-manager | hx-app-dev/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| hx-app-dev/cert-manager | hx-app-dev/argo-cd | Secret/cert-manager/image-pull-secret | resolved-runtime |
| hx-app-dev/external-secrets | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/external-secrets | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/external-secrets | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/external-secrets | hx-app-dev/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| hx-app-dev/external-secrets | hx-app-dev/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| hx-app-dev/external-secrets | hx-app-dev/argo-cd | Secret/external-secrets/image-pull-secret | resolved-runtime |
| hx-app-dev/homer-dashboard | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/homer-dashboard | hx-app-dev/argo-cd | Secret/homer-dashboard/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/cert-manager | API cert-manager.io/Certificate | resolved-rendered |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/cert-manager | API cert-manager.io/Certificate | resolved-rendered |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/cert-manager | API cert-manager.io/Issuer | resolved-rendered |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/cert-manager | API cert-manager.io/Issuer | resolved-rendered |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/external-secrets | API external-secrets.io/ExternalSecret | resolved-rendered |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/kube-prometheus-stack | hx-app-dev/argo-cd | Secret/kube-prometheus-stack/image-pull-secret | resolved-runtime |
| hx-app-dev/metrics-server | hx-app-dev/argo-cd | Secret/metrics-server/image-pull-secret | resolved-runtime |
| hx-app-dev/traefik | hx-app-dev/kube-prometheus-stack | API monitoring.coreos.com/ServiceMonitor | resolved-rendered |
| hx-app-dev/traefik | hx-app-dev/argo-cd | Secret/traefik/image-pull-secret | resolved-runtime |

## Explicit unknowns and external inputs

| Status | Component | Fact | Rendered reference | Why it is recorded |
| --- | --- | --- | --- | --- |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"longhorn":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"loki":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno-policies":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"metallb":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"oauth2-proxy":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"velero":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"reloader":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"external-dns":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ○ optional-unprovided | hx-app-dev/argo-cd | Argo cluster registration selector {"matchLabels":{"kyverno-policy-reporter":"enabled"}} in argocd | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.generators[0].clusters.selector` | ApplicationSet cluster generator has no matching Argo cluster registration in the effective render |
| ↗️ external | hx-app-dev/argo-cd | external secret hx-app-dev/dev/argocd/hx-app-prod-b-prod#kubeconfig | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-prod-b-es` → `spec.data[0].remoteRef` | remote secret backend input |
| ↗️ external | hx-app-dev/argo-cd | external secret hx-app-dev/dev/argocd/hx-app-staging-staging#kubeconfig | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-staging-es` → `spec.data[0].remoteRef` | remote secret backend input |
| ↗️ external | hx-app-dev/argo-cd | external secret hx-app-dev/dev/cluster_secrets/docker_config#pull-secret | `external-secrets.io/v1|ClusterExternalSecret||image-pull-secret-ces` → `spec.externalSecretSpec.data[0].remoteRef` | remote secret backend input |
| ↗️ external | hx-app-dev/argo-cd | external secret hx-app-dev/dev/argocd/hx-app-prod-a-prod#kubeconfig | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-prod-a-es` → `spec.data[0].remoteRef` | remote secret backend input |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/kube-prometheus-stack | `argoproj.io/v1alpha1|ApplicationSet|argocd|kube-prometheus-stack` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|argocd` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-secrets` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|metrics-server` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|homer-dashboard` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|cert-manager` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|traefik` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kube-prometheus-stack` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main#valuesRepo | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.template.spec.sources[0]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/reloader | `argoproj.io/v1alpha1|ApplicationSet|argocd|reloader` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/homer-dashboard | `argoproj.io/v1alpha1|ApplicationSet|argocd|homer-dashboard` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/cert-manager | `argoproj.io/v1alpha1|ApplicationSet|argocd|cert-manager` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/kyverno | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/external-dns | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-dns` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/metrics-server | `argoproj.io/v1alpha1|ApplicationSet|argocd|metrics-server` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/traefik | `argoproj.io/v1alpha1|ApplicationSet|argocd|traefik` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/metallb | `argoproj.io/v1alpha1|ApplicationSet|argocd|metallb` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/loki | `argoproj.io/v1alpha1|ApplicationSet|argocd|loki` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/velero | `argoproj.io/v1alpha1|ApplicationSet|argocd|velero` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/oauth2-proxy | `argoproj.io/v1alpha1|ApplicationSet|argocd|oauth2-proxy` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/kyverno-policy-reporter | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policy-reporter` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/argo-cd | `argoproj.io/v1alpha1|ApplicationSet|argocd|argocd` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/kyverno-policies | `argoproj.io/v1alpha1|ApplicationSet|argocd|kyverno-policies` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/longhorn | `argoproj.io/v1alpha1|ApplicationSet|argocd|longhorn` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ↗️ external | hx-app-dev/argo-cd | Git source https://github.com/confighub/helm-expt.git@main:examples/kubara/current-platform/generated/platform-components/helm/external-secrets | `argoproj.io/v1alpha1|ApplicationSet|argocd|external-secrets` → `spec.template.spec.sources[1]` | ApplicationSet source is a Git repository input outside the rendered object set |
| ❌ unresolved | hx-app-dev/argo-cd | ClusterIssuer/letsencrypt-staging | `networking.k8s.io/v1|Ingress|argocd|argo-cd-argocd-server-grpc` → `metadata.annotations.cert-manager.io/cluster-issuer` | cert-manager ingress issuer reference |
| ❌ unresolved | hx-app-dev/argo-cd | ClusterSecretStore/hx-app-dev-dev | `external-secrets.io/v1|ClusterExternalSecret||image-pull-secret-ces` → `spec.externalSecretSpec.secretStoreRef` | External Secrets store reference |
| ❌ unresolved | hx-app-dev/argo-cd | ClusterSecretStore/hx-app-dev-dev | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-prod-a-es` → `spec.secretStoreRef` | External Secrets store reference |
| ❌ unresolved | hx-app-dev/argo-cd | ClusterSecretStore/hx-app-dev-dev | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-staging-es` → `spec.secretStoreRef` | External Secrets store reference |
| ❌ unresolved | hx-app-dev/argo-cd | ClusterSecretStore/hx-app-dev-dev | `external-secrets.io/v1|ExternalSecret|argocd|hx-app-prod-b-es` → `spec.secretStoreRef` | External Secrets store reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | ConfigMap/argocd/argocd-styles-cm | `apps/v1|Deployment|argocd|argo-cd-argocd-server` → `spec.template.spec.volumes[4].configMap.name` | pod volume ConfigMap reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|Deployment|argocd|argo-cd-argocd-server` → `spec.template.spec.containers[0].env[30].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|Deployment|argocd|argo-cd-argocd-repo-server` → `spec.template.spec.containers[0].env[19].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|StatefulSet|argocd|argo-cd-argocd-application-controller` → `spec.template.spec.containers[0].env[30].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|Deployment|argocd|argo-cd-argocd-server` → `spec.template.spec.containers[0].env[31].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|StatefulSet|argocd|argo-cd-argocd-application-controller` → `spec.template.spec.containers[0].env[31].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argo-cd-argocd-redis | `apps/v1|Deployment|argocd|argo-cd-argocd-repo-server` → `spec.template.spec.containers[0].env[20].valueFrom.secretKeyRef.name` | container secret key reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-dex-server-tls | `apps/v1|Deployment|argocd|argo-cd-argocd-server` → `spec.template.spec.volumes[6].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-dex-server-tls | `apps/v1|Deployment|argocd|argo-cd-argocd-dex-server` → `spec.template.spec.volumes[2].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argo-cd-argocd-repo-server` → `spec.template.spec.volumes[8].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argo-cd-argocd-server` → `spec.template.spec.volumes[5].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|Deployment|argocd|argo-cd-argocd-applicationset-controller` → `spec.template.spec.volumes[5].secret.secretName` | pod volume secret reference |
| ○ optional-unprovided | hx-app-dev/argo-cd | Secret/argocd/argocd-repo-server-tls | `apps/v1|StatefulSet|argocd|argo-cd-argocd-application-controller` → `spec.template.spec.volumes[2].secret.secretName` | pod volume secret reference |
| ❌ unresolved | hx-app-dev/homer-dashboard | Service selector {"matchLabels":{"argocd.argoproj.io/instance":"homer-dashboard"}} in homer-dashboard | `monitoring.coreos.com/v1|ServiceMonitor|homer-dashboard|homer-dashboard-metrics` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| ↗️ external | hx-app-dev/kube-prometheus-stack | external secret hx-app-dev/dev/kube-prometheus-stack/grafana_credentials | `external-secrets.io/v1|ExternalSecret|kube-prometheus-stack|grafana-admin-credentials-es` → `spec.dataFrom[0]` | remote secret backend input |
| ❌ unresolved | hx-app-dev/kube-prometheus-stack | ClusterSecretStore/hx-app-dev-dev | `external-secrets.io/v1|ExternalSecret|kube-prometheus-stack|grafana-admin-credentials-es` → `spec.secretStoreRef` | External Secrets store reference |
| 🏗️ target-prerequisite | hx-app-dev/kube-prometheus-stack | Service selector {"matchLabels":{"component":"apiserver","provider":"kubernetes"}} in default | `monitoring.coreos.com/v1|ServiceMonitor|kube-prometheus-stack|kube-prometheus-stack-apiserver` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| 🏗️ target-prerequisite | hx-app-dev/kube-prometheus-stack | Service selector {"matchLabels":{"app.kubernetes.io/name":"kubelet","k8s-app":"kubelet"}} in kube-system | `monitoring.coreos.com/v1|ServiceMonitor|kube-prometheus-stack|kube-prometheus-stack-kubelet` → `spec.selector` | ServiceMonitor selector requires at least one rendered Service match |
| ❌ unresolved | hx-app-dev/kube-prometheus-stack | Service endpoint loki/loki-headless:3100 | `v1|ConfigMap|kube-prometheus-stack|kube-prometheus-stack-grafana-datasource` → `data.datasource.yaml` | Kubernetes service DNS endpoint reference |
| 🏗️ target-prerequisite | hx-app-dev/metrics-server | ClusterRole/system:auth-delegator | `rbac.authorization.k8s.io/v1|ClusterRoleBinding||metrics-server:system:auth-delegator` → `roleRef` | RBAC role reference |
| 🏗️ target-prerequisite | hx-app-dev/metrics-server | Role/kube-system/extension-apiserver-authentication-reader | `rbac.authorization.k8s.io/v1|RoleBinding|kube-system|metrics-server-auth-reader` → `roleRef` | RBAC role reference |
| ❌ unresolved | hx-app-prod-a/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-webhook` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-a/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-startupapicheck` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-a/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-cainjector` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-a/cert-manager | Secret/cert-manager/image-pull-secret | `batch/v1|Job|cert-manager|cert-manager-startupapicheck` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |
| ❌ unresolved | hx-app-prod-a/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-a/traefik | Secret/traefik/image-pull-secret | `apps/v1|Deployment|traefik|traefik` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |
| ❌ unresolved | hx-app-prod-b/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-b/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-startupapicheck` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-b/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-webhook` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-b/cert-manager | Secret/cert-manager/image-pull-secret | `batch/v1|Job|cert-manager|cert-manager-startupapicheck` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |
| ❌ unresolved | hx-app-prod-b/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-cainjector` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-prod-b/traefik | Secret/traefik/image-pull-secret | `apps/v1|Deployment|traefik|traefik` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |
| ❌ unresolved | hx-app-staging/cert-manager | Secret/cert-manager/image-pull-secret | `batch/v1|Job|cert-manager|cert-manager-startupapicheck` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |
| ❌ unresolved | hx-app-staging/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-cainjector` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-staging/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-startupapicheck` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-staging/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager-webhook` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-staging/cert-manager | Secret/cert-manager/image-pull-secret | `v1|ServiceAccount|cert-manager|cert-manager` → `imagePullSecrets[0].name` | ServiceAccount image pull secret reference |
| ❌ unresolved | hx-app-staging/traefik | Secret/traefik/image-pull-secret | `apps/v1|Deployment|traefik|traefik` → `spec.template.spec.imagePullSecrets[0].name` | workload image pull secret reference |

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
node scripts/generate-kubara-effective-renders.mjs --verify --profile current
node scripts/generate-kubara-wiring.mjs --generate --profile current
node scripts/generate-kubara-wiring.mjs --verify --profile current
node scripts/generate-kubara-wiring.mjs --self-test
~~~
