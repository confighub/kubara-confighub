# prometheus-community/kube-prometheus-stack 87.15.1 Proof

> **Offline candidate only.** This artifact is for local, deterministic evaluation. It is not root-Catalog-retained, Kubara-compatible, live-qualified, or published.

This is the offline candidate proof slice for the kube-prometheus-stack public Helm chart.

Variants:

- `default`: default stack with Grafana admin password bound as a generated fact; 125 Helm objects, 126 cub installer objects including Namespace.
- `no-crds`: CRDs disabled with Grafana admin password bound; 115 Helm objects, 116 cub installer objects including Namespace.
- `existing-secret`: Grafana admin credentials referenced from a target Secret; 124 Helm objects, 125 cub installer objects including Namespace.

What this proves:

- regular Helm output is preserved by `cub installer setup`, plus the explained Namespace support object;
- default chart render becomes deterministic when grafana.adminPassword is bound before render;
- the no-crds variant deliberately removes the 10 Prometheus Operator CRDs;
- the existing-secret variant records monitoring/grafana-admin-credentials as a target fact instead of rendering admin credentials;
- CRD lifecycle, admission webhook, generated Grafana credential, umbrella dependency, and cluster RBAC risks are visible as scan/gate findings instead of hidden Helm behavior.

Useful commands:

```sh
npm run kubara-catalog-candidates:generate
npm run kubara-catalog-candidates:verify
```
