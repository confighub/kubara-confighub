# Kubara catalogs 1.1.0 full component coverage

This receipt set inventories all 21 remote dependency occurrences and all 18
unique exact component/version selections in the pinned bootstrap and general
wrapper charts. ConfigHub retains ten missing version roots additively, taking
the component Catalog from 100 components / 120 versions to 103 components /
130 versions.

The existing external-dns 1.21.1 and Traefik 41.0.2 recipe/package roots remain
byte-identical. Their version-specific URL and upstream OCI manifest evidence is
recorded separately in `exact-artifact-registry.yaml`.

Published exact installer packages: 10/10.

The packages prove exact source bytes, deterministic render/package output, and
OCI retention. They do not by themselves claim Kubara wrapper equivalence,
target-specific live convergence, or production support.
