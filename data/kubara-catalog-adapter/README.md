# Deterministic Kubara catalog adapter

This adapter is the non-AI bridge between Kubara's platform-oriented catalog
and ConfigHub's component-first catalog.

It reads the committed immutable snapshots and the example's existing
`config.yaml`. It keeps Kubara's layers separate:

1. `Catalog.yaml` and `ServiceDefinition` describe the reusable platform
   package.
2. `platform-components` retain each Kubara Helm wrapper and its additions.
3. `platform-configs` retain the templates that specialize the package for a
   cluster.
4. ConfigHub mappings point at an exact component recipe/package only when
   that exact version exists.

`exports/` is a byte-for-byte export of each snapshot. For both current 1.1.0
lines that means the complete `bootstrap/` and `general/` catalog trees, not
only the seven deeply profiled roles. Kubara can therefore still apply defaults
for omitted services and validate explicit disabled entries. Unprofiled
services are retained as `byte-preserved-unreviewed`; the adapter does not
pretend they have a reviewed ConfigHub mapping.

The receipt compares each full source/export tree and each of the four path
classes. The v0.12.0 built-in layout has no `Catalog.yaml`, so the adapter
records that upstream absence instead of inventing one. Its snapshot remains a
selected compatibility slice because the existing v0.12 example already keeps
the full generated output. The released 1.1.0 bytes and the later observed Git
head also remain separate; equal manifest versions do not make their trees
equivalent.

Current Kubara bootstrap needs both `argo-cd` and `bootstrap-crds`. The latter
is retained in the 1.1.0 exports and has its own compatibility profile. It is a
deployable bootstrap concern, not an eighth user-selectable platform role.

No AI, cluster, ConfigHub write, chart download, or root-catalog promotion is
part of this adapter:

```sh
npm run kubara-catalog-adapter:generate
npm run kubara-catalog-adapter:verify
```

To refresh the immutable source snapshots themselves, run the separate
networked command and review the resulting provenance and byte changes:

```sh
npm run kubara-catalog-snapshots:refresh
```
