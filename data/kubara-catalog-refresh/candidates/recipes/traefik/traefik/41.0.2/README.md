# traefik/traefik 41.0.2 Proof

> **Offline candidate only.** This artifact is for local, deterministic evaluation. It is not root-Catalog-retained, Kubara-compatible, live-qualified, or published.

This is the exact-artifact offline candidate for traefik/traefik@41.0.2.

Variants:

- `default`: chart defaults; 31 Helm objects, 32 cub installer objects including Namespace.

What this proves:

- the exact upstream artifact digest is captured independently of a mutable repository index;
- the chart renders deterministically and the installer package preserves the rendered object set;
- candidate status does not imply root Catalog retention, Kubara wrapper compatibility, or live support.

Useful commands:

```sh
npm run kubara-catalog-candidates:generate
npm run kubara-catalog-candidates:verify
```
