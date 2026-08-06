# Kubara exact-version catalog candidates

These additive candidate trees capture the seven exact public chart artifacts
selected by Kubara v0.12.0. They are artifact-addressed and digest-verified, so
candidate generation does not depend on a mutable Helm repository index.

The exact versions also have additive root recipe and package copies after
the separately recorded live qualification passed. These candidate trees remain
the immutable offline evaluation snapshot; root retention still does not claim
complete Kubara ServiceDefinition or wrapper compatibility.

| Component | Version | Variants and object counts | Status |
| --- | --- | --- | --- |
| `helm:argo-cd/argo-cd` | `10.1.3` | `default:55`<br>`no-crds:52` | offline-candidate-pass |
| `helm:jetstack/cert-manager` | `v1.21.0` | `default:40`<br>`crds-enabled:46` | offline-candidate-pass |
| `helm:external-secrets/external-secrets` | `2.7.0` | `default:43`<br>`no-crds:19` | offline-candidate-pass |
| `helm:prometheus-community/kube-prometheus-stack` | `87.15.1` | `default:125`<br>`no-crds:115`<br>`existing-secret:124` | offline-candidate-pass |
| `helm:prometheus-community/prometheus-blackbox-exporter` | `11.15.1` | `default:4` | offline-candidate-pass |
| `helm:metrics-server/metrics-server` | `3.13.1` | `default:9`<br>`external-tls-ca:9` | offline-candidate-pass |
| `helm:traefik/traefik` | `41.0.2` | `default:31` | offline-candidate-pass |

## Reproduce

```sh
npm run kubara-catalog-candidates:generate
npm run kubara-catalog-candidates:verify
```
