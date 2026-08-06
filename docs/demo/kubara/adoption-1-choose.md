# Step 1: choose components and wiring in Kubara

This is the first of six adoption steps. Start with the Kubara inputs you
already understand; do not translate them into a new platform schema.

## Goal

Describe the desired platform with Kubara's ordinary `config.yaml`, ordered
catalogs, service definitions, and `values-*.yaml` overrides. At the end of
this step, another Kubara operator should be able to recognize the hub, spokes,
selected services, target-specific configuration, and platform wiring without
knowing anything about ConfigHub.

The current example selects one hub and three spokes:

| Cluster | Kubara role | Enabled platform services |
| --- | --- | --- |
| `hx-app-dev` | hub | cert-manager, External Secrets, Homer, kube-prometheus-stack, Metrics Server, Traefik |
| `hx-app-staging` | spoke | cert-manager, Traefik |
| `hx-app-prod-a` | spoke | cert-manager, Traefik |
| `hx-app-prod-b` | spoke | cert-manager, Traefik |

Together with the hub's Argo CD, this becomes 13 deployable component
instances. Application source is deliberately added in Step 6, after the
portable platform has been imported.

## What remains Kubara

- `config.yaml` remains the platform selection and per-cluster placement
  contract.
- Kubara's `bootstrap` and `general` catalogs remain valid source catalogs.
- Kubara `ServiceDefinition`s and wrappers retain their existing meanings.
- `values-*.yaml` remains the supported way to specialize a component.
- `type: hub`, `type: spoke`, `argocd`, repository, DNS, ingress, and service
  settings remain Kubara fields.
- Kubara still owns composition and wiring. ConfigHub neither chooses the
  components nor uses AI to reconstruct the user's intent.

An adopter may continue to use Kubara's official catalogs, organization-owned
catalogs, or both. A ConfigHub-aligned catalog export is acceptable only after
it has produced the same Kubara result as the corresponding pinned upstream
catalog.

## What ConfigHub adds

ConfigHub adds a component-first review layer beside the Kubara selection:

- one stable identity for each reusable component;
- every retained component version, instead of only the version selected by
  this platform;
- an exact source URL, archive checksum, and OCI manifest digest where
  applicable;
- `fail-if-missing` exact-version resolution—never a silent nearby version;
- `additive-only` retention, so adding a newer version does not discard an
  older one; and
- a deterministic compatibility mapping back to the Kubara service definition,
  wrapper, defaults, additions, and configuration templates.

At this step those additions are reviewed files. Nothing has been loaded into
a ConfigHub organization and no live platform claim is being made.

Keep the catalog mapping in three visible layers:

1. **ConfigHub reusable component/version first.** This is the component
   identity, all retained versions, source and archive provenance, qualified
   deployable variants, and their reusable configuration surfaces.
2. **Kubara compatibility profile.** This retains the complete Kubara catalog
   representation—`Catalog.yaml`, service definition, wrapper, defaults,
   additions, and platform-configuration templates—so Kubara's official
   catalog and a ConfigHub-aligned export produce the same result.
3. **Kubara per-platform package, selection, and wiring.** The platform's
   ordered catalogs, `config.yaml`, cluster placement, and ordinary overrides
   select and connect those reusable components for this platform.

The second and third layers preserve Kubara's package and operating model;
they do not turn the ConfigHub Catalog into a platform-specific bundle. In the
ConfigHub experience, people should encounter the reusable component and its
retained versions first, then its deployable variants and configurations, and
finally the Kubara platform selection that uses them.

## Work through the current example

Run these commands from the repository root:

```sh
cd /absolute/path/to/helm-expt

sed -n '1,260p' examples/kubara/current-platform/source/config.yaml
find examples/kubara/current-platform/source/overrides \
  -type f -print | sort
sed -n '1,180p' examples/kubara/current-platform/component-artifacts.yaml
sed -n '1,100p' examples/kubara/current-platform/source-lock.yaml
```

Review the files in this order:

1. In
   [`source/config.yaml`](../../../examples/kubara/current-platform/source/config.yaml),
   confirm the official catalog references
   `oci://ghcr.io/kubara-io/catalogs/bootstrap:1.1.0` and
   `oci://ghcr.io/kubara-io/catalogs/general:1.1.0`.
2. Confirm that `hx-app-dev` is the single hub and that staging, prod-a, and
   prod-b are spokes.
3. For each cluster, review every explicit `enabled` or `disabled` service.
   Explicit selection makes an accidental catalog-default change visible in
   review.
4. Review the normal overrides under
   [`source/overrides`](../../../examples/kubara/current-platform/source/overrides/).
   They record repository paths and the local-kind certificate, ingress,
   Metrics Server, and dashboard adaptations. They are not hidden imperative
   patches.
5. Review
   [`component-artifacts.yaml`](../../../examples/kubara/current-platform/component-artifacts.yaml).
   It pins the seven exact external artifacts used by the selected roles and
   separately retains Kubara's first-party Homer and template-library
   identities.
6. Review
   [`source-lock.yaml`](../../../examples/kubara/current-platform/source-lock.yaml).
   It pins Kubara v0.13.0, catalogs 1.1.0, the render capabilities, and both
   catalog comparison lanes.

For your own platform, edit your existing Kubara files in the same sequence:
catalog references first, cluster placement second, explicit service status
third, and supported values overrides last. Then add or review an exact
artifact-lock row for every enabled external chart. If an exact component
version is absent from the ConfigHub Catalog, add and qualify that version;
do not replace it with a nearby version.

## Expected artifacts

Before generation, the reviewable input set is:

```text
source/
  config.yaml
  overrides/<cluster>/helm/<service>/values-*.yaml
component-artifacts.yaml
source-lock.yaml
```

The current example's static evidence also includes the pinned official
catalog snapshot and its ConfigHub-aligned export. Those are inputs to the
parity test in Step 2; they are not a second hand-maintained platform model.

Do not place credentials, private keys, secret values, `.env` files, cluster
credentials, or target-local facts in this portable input set. Application
source and application secrets also remain outside it.

## Machine checkpoint

For the committed example, run the offline verifier:

```sh
npm run kubara-current-example:verify
```

Its passing final line must report Kubara v0.13.0, two catalog lanes, four
clusters, seven exact external artifacts, and 13 deterministic renders. This
single verifier checks the source contract as well as the already committed
outputs, so it will fail if cluster order, hub/spoke count, service selections,
catalog references, exact versions, locks, or supported overrides drift.

This is deterministic repository evidence. It does **not** prove that any
cluster or ConfigHub organization currently reconciles the result.

For an adopter's new selection, a failure is the checkpoint doing its job:
regenerate the evidence in Step 2 rather than editing a receipt or checksum to
make it agree.

## Screenshot checkpoint

No screenshot is embedded as a substitute for this check. This chapter owns
exactly one future adoption frame, separate from the ConfigHub GUI tour.

<!-- kubara-adoption-screenshot step="1" id="native-config" path="../../images/kubara-adoption/01-native-kubara-config.png" -->

![Native Kubara config.yaml reviewed on GitHub at the exact source commit](../../images/kubara-adoption/01-native-kubara-config.png)

After the machine checkpoint and the complete source-current live gate pass,
capture one real Git review frame of `config.yaml` with these facts visible:

1. the ordered official catalog references;
2. the hub and three spoke declarations;
3. one expanded service selection; and
4. the corresponding `values-*.yaml` override.

The caption should say: **“The Kubara operator still selects and wires the
platform in Kubara's native files.”** Do not use a ConfigHub GUI screenshot at
this point, because the destination organization is not involved yet. Do not
show credentials or `.env` contents. Embed the real image at the path declared
in the publication hook only when the six-frame adoption receipt binds it to
the exact source commit and Git trees, generation receipt, file digest, UTC
capture time, visible identities, sensitive-value handling, caption, and
claim boundary. Until then, leave the hook unexpanded.

## Troubleshooting

### An exact selected version is missing

Stop. Add that exact version to the component-first Catalog and qualify it.
The policy is `fail-if-missing`; changing the Kubara selection to whichever
nearby version happens to exist would break the adoption promise.

### A custom Kubara catalog has no ConfigHub mapping

Retain the complete Kubara compatibility profile: `Catalog.yaml`, service
definition, wrapper, defaults, additions, and platform-config templates. Map
the underlying reusable component separately. Do not flatten a custom Kubara
service into only a chart name and version.

### Local-cluster differences are imperative patches

Move supported customizations into
`source/overrides/<cluster>/helm/<service>/values-*.yaml`. Record genuine
cluster prerequisites—issuers, secret stores, storage classes, load balancers,
and credentials—as target facts later, outside the portable Git/OCI package.

### The verifier reports stale checksums or receipts

Do not edit generated evidence by hand. Continue to Step 2 and regenerate from
the reviewed source with the pinned toolchain.

## Safe to stop here

Yes. Step 1 changes only reviewed Kubara source inputs. Commit or preserve the
selection before generation; do not present it as generated, imported, or live
platform evidence yet.

## Continue

[← Buyer overview](index.md) · [Step 2: let Kubara generate the platform →](adoption-2-generate.md)
