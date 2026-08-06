# grafana/loki 7.1.0 Proof

This is the exact-artifact ConfigHub component package for the loki@7.1.0 dependency selected by Kubara catalogs 1.1.0.

Variants:

- `default`: single-binary Loki with filesystem storage and an explicit schema epoch; 19 Helm objects, 20 cub installer objects including Namespace.

What this proves:

- the version-specific upstream artifact and SHA are locked without a mutable Helm index lookup;
- the selected configuration renders deterministically and the installer package preserves the rendered object set;
- Catalog retention does not imply Kubara wrapper equivalence, live convergence, or production support.

Useful commands:

```sh
npm run kubara-catalog-1.1-full-coverage:generate-proof
npm run kubara-catalog-1.1-full-coverage:generate-package
npm run kubara-catalog-1.1-full-coverage:verify-proof
npm run kubara-catalog-1.1-full-coverage:verify-package
npm run kubara-catalog-1.1-full-coverage:compare
```
