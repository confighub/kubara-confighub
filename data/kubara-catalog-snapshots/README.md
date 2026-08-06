# Kubara catalog snapshots

This directory keeps the catalog bytes needed by the seven-service Kubara
adoption example available offline. The snapshots are deliberately separate:

- `kubara-v0.12.0-built-in` is the catalog embedded in Kubara v0.12.0 at
  commit `ad039dd3e038c8580592b3b9134c2165a426344d` and repository tree
  `92cb8480e662d53906418c8c1e0b6f7bbd545f40`.
- `kubara-catalogs-1.1.0-release` is the source selected by the
  `bootstrap-1.1.0` and `general-1.1.0` release tags at commit
  `b451260636bba764ccdb0561d9f8f5ce414e2ee5`. It is the only 1.1.0
  snapshot here that can be compared directly with those released OCI tags.
- `kubara-catalogs-1.1.0-observed-head` is the later observed repository
  state at commit `79d566dd82013ecf11beb8d1fec4ede7be069c20` and tree
  `a4e0dc903011577b26640b7e3fd61f5358e43cd4`. Its `Catalog.yaml` files still
  say `1.1.0`, but its bytes differ from the released tags. It is retained as
  a separate forward-looking source line, never as evidence for the OCI
  release.

The v0.12.0 snapshot is the exact seven-role compatibility slice plus the
shared template library. The existing Kubara example separately retains the
full generated output of that built-in catalog.

The two current snapshots contain the complete upstream `bootstrap/` and
`general/` catalog trees: every `Catalog.yaml`, all ServiceDefinitions, all
Helm and Terraform platform components, and all platform configs. Keeping the
full trees matters because Kubara applies catalog defaults for services omitted
from `config.yaml`; a seven-service-only export cannot reproduce an official
1.1.0 generate. The full snapshots also retain the required `bootstrap-crds`
service and wrapper. That bootstrap concern is not an eighth user-selectable
platform role; it is required input to Kubara's current bootstrap flow.

Every byte is copied without rewriting. `provenance.yaml`, `checksums.txt`, and
the upstream Apache-2.0 license lock each snapshot's exact scope.

Refresh from the pinned commits (network required):

```sh
npm run kubara-catalog-snapshots:refresh
```

Normal generation and verification use only these committed bytes and do not
contact GitHub:

```sh
npm run kubara-catalog-adapter:generate
npm run kubara-catalog-adapter:verify
```
