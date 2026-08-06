# Kubara v0.13.0 current catalog candidates

This is the component-first ConfigHub view of the seven exact public chart
artifacts selected by Kubara catalogs 1.1.0. Three changed versions are stored
as additive candidates here. Four unchanged versions reference the already
immutable v0.12 candidate trees. Nothing is replaced or discarded.

| Component | Version | Storage | Variants |
| --- | --- | --- | --- |
| `helm:argo-cd/argo-cd` | `10.2.1` | current-addition | `default:55`<br>`no-crds:52` |
| `helm:jetstack/cert-manager` | `v1.21.0` | reused-identical-v0.12-candidate | `default:40`<br>`crds-enabled:46` |
| `helm:external-secrets/external-secrets` | `2.8.0` | current-addition | `default:44`<br>`no-crds:19` |
| `helm:prometheus-community/kube-prometheus-stack` | `87.19.2` | current-addition | `default:125`<br>`no-crds:115`<br>`existing-secret:124` |
| `helm:prometheus-community/prometheus-blackbox-exporter` | `11.15.1` | reused-identical-v0.12-candidate | `default:4` |
| `helm:metrics-server/metrics-server` | `3.13.1` | reused-identical-v0.12-candidate | `default:9`<br>`external-tls-ca:9` |
| `helm:traefik/traefik` | `41.0.2` | reused-identical-v0.12-candidate | `default:31` |

Generate and verify offline:

```sh
npm run kubara-current-catalog-candidates:generate
npm run kubara-current-catalog-candidates:verify
```
