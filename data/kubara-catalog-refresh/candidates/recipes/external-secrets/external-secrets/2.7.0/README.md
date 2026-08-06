# external-secrets/external-secrets 2.7.0 Proof

> **Offline candidate only.** This artifact is for local, deterministic evaluation. It is not root-Catalog-retained, Kubara-compatible, live-qualified, or published.

This is the offline candidate proof slice for the external-secrets public Helm chart.

Variants:

- `default`: chart defaults; 43 Helm objects, 44 cub installer objects including Namespace.
- `no-crds`: external-secrets CRDs disabled; 19 Helm objects, 20 cub installer objects including Namespace.

What this proves:

- regular Helm output is preserved by `cub installer setup`, plus the explained Namespace support object;
- default chart render is deterministic under the pinned Kubernetes capability profile;
- the no-crds variant deliberately removes the 23 external-secrets CRDs;
- CRD lifecycle, admission webhook, webhook Secret, disabled dependency, and cluster RBAC risks are visible as scan/gate findings instead of hidden Helm behavior.

Useful commands:

```sh
npm run kubara-catalog-candidates:generate
npm run kubara-catalog-candidates:verify
```
