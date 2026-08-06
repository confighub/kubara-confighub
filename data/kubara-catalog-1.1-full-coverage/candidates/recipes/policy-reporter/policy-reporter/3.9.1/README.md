# policy-reporter/policy-reporter 3.9.1 Proof

This is the exact-artifact ConfigHub component package for the policy-reporter@3.9.1 dependency selected by Kubara catalogs 1.1.0.

Variants:

- `default`: chart defaults; 8 Helm objects, 9 cub installer objects including Namespace.

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
