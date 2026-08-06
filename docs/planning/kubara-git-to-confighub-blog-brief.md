# Future blog source brief: Kubara Git to ConfigHub without a rewrite

Status: editorial source for a future public post. This is not itself an
importer release announcement or a live proof receipt.

## The two sentences the post must earn

> **ConfigHub simplifies Kubara without making it fundamentally different.**

> **Kubara composes; ConfigHub governs; Argo reconciles.**

Every section should reinforce those boundaries. Kubara remains the platform
author and generator. ConfigHub imports and governs one exact generated
revision. Argo CD remains the reconciler. AI is optional assistance, never a
required migration or authority.

## Audience and reader promise

Primary audience: platform teams already using Kubara, Git, and Argo CD who
want stronger catalog retention, review, approvals, promotion, rollback,
topology visibility, and dependency visibility without replacing their
platform model.

Reader promise:

```text
You update the Kubara catalogs, config, and ordinary overrides you already
understand. A deterministic bridge imports the exact Git revision. You do not
need an AI-led rewrite, a second hand-maintained platform definition, or a new
deployment controller.
```

## Suggested titles

- ConfigHub Simplifies Kubara Without Rewriting It
- From Kubara Git to Governed Configuration
- Kubara Composes, ConfigHub Governs, Argo Reconciles
- A GitOps-First Kubara Platform With Reviewable Fleet State

## The six-step adoption architecture

The article must use this sequence and must not collapse its trust boundaries.

### 1. Select and wire in Kubara

`config.yaml`, the effective Kubara catalogs, and documented `values-*.yaml`
overrides select the hub, spokes, enabled and disabled services, per-cluster
configuration, and wiring. ConfigHub does not select a different platform.

### 2. Generate the full Kubara tree

Kubara produces platform components, platform configs, add-ons, AppProjects,
ApplicationSets, overrides, and wiring. The platform revision is coherent, but
its deployable component instances remain separately identifiable.

### 3. Prepare, scan, commit, and push one clean Git hand-off

Run `prepare-kubara-git-handoff.mjs --generate` against the ordinary Kubara
worktree. A reviewed request maps the existing native paths; no repository
rearrangement or AI rewrite is required. The preparer requires a reviewed exact
`KubaraComponentArtifactSet`, the SHA-pinned Kubara binary/source lock, the full
Helm build identity, and pinned kube/API capabilities. It refuses missing or
ambiguous component versions, opaque pre-vendored chart archives, credential-
shaped material, and concurrent source edits. It renders each enabled instance
twice, extracts wiring, and atomically writes a separate clean subtree while
leaving apps, target facts, and `.env` outside it.

This bridge is general over that explicit reviewed artifact contract. It does
not claim that every arbitrary Kubara Catalog version has already been reviewed
or can be resolved automatically.

#### Commit and push one immutable Git revision

Commit and push the source config, generated tree, exact source and dependency locks,
the generation receipt with render checksums and object counts, effective
renders, and the wiring ledger together. The hand-off is one commit SHA plus a
selected path, never a moving branch name.

Run the preparer's offline, zero-write `--verify` against the clean checkout of
that final commit before scanning and import.

### 4. Import deterministically and package by deployable config

The importer verifies the clean checkout and exact SHA, then resolves each
selected component against the component-first ConfigHub Catalog. Resolution
requires the canonical identity, exact package version and digest, Kubara
compatibility profile, and lifecycle facts. Missing, duplicate, conflicting, or
secret-bearing input fails.

The importer cross-checks every dependency SHA, effective-render SHA and object
count against the committed generation receipt, then requires the wiring
graph's component, version, and object inventories to describe the same
instances.

The output is:

- one ConfigHub configuration Unit and one immutable deployable-configuration
  OCI package/release for every component instance;
- one digest-pinned platform bundle indexing the exact component-instance OCI
  digests, not one opaque fleet blob;
- separate hub/spoke topology, enabled/disabled selection, upgrade lineage,
  and wiring facts.

Secret values and environment-owned target facts stay outside Git and OCI.
The same Git revision, import name, catalog repository base, and
materialization contract must produce the same `PlatformDigest`, component
member bytes, and aggregate OCI index in two organizations; only the
destination `BindingDigest` may differ. Changing the import name or catalog
repository base preserves target-neutral member content and `PlatformDigest`,
but necessarily changes aggregate metadata or member references.

The current kind fixture is a named exception, not the generalized design: it
commits a fake-provider target fact with demo-only Grafana data so a laptop run
does not need a production secret backend. The reusable import contract must
exclude that file from its Git and OCI payloads and bind equivalent target data
through the separately authorized target path.

### 5. Reconcile an explicit ConfigHub organization

The user creates or selects the destination organization and pins its existing
context, organization coordinates, target Spaces, Target IDs, and any external
delivery infrastructure. The importer never guesses or silently switches those
identities. It reconciles importer-owned component-definition and
component-instance Spaces, Units, Variants, UpgradeUnit lineage,
`NeedsProvides` Links, and the platform delivery Application surfaces declared
by the accepted plan. Target facts and secret references bind at apply time.
Conflicts fail without deletion. A repeated zero-action organization receipt
proves ConfigHub convergence; a separate controller receipt must prove Argo and
workload convergence at the exact released digests.

### 6. Promote apps in ConfigHub; reconcile with Argo

Application bases and target variants follow as a separate hand-off. ConfigHub
checks, approves, promotes, publishes, and rolls back exact revisions. Argo CD
keeps reconciling them. The importer does not invent application definitions or
become a second deployment controller.

## The diagram to reuse

```text
Kubara catalogs + config.yaml + values overrides
                    |
                    v
Kubara-generated platform/add-ons/ApplicationSets/wiring
                    |
                    v
deterministic hand-off preparer + reviewed exact artifact lock
                    |
                    v
immutable Git SHA + locks + checksums
                    |
                    v
deterministic ConfigHub importer
       |                  |                    |
       v                  v                    v
per-config OCI      platform bundle      topology/wiring facts
       |             (digest index)       (no secret values)
       `------------------+--------------------'
                          v
explicit ConfigHub org: Spaces / Units / Variants / NeedsProvides
                          |
                          v
application promotion -> Argo CD reconciliation
```

## Catalog language to keep precise

ConfigHub Catalog is **component-first**. Its durable entry is one exact
component version, source digest, reviewed configuration bases, lifecycle
facts, and retained history. Deployable variants and configurations follow that
component.

Kubara's catalog remains a reusable platform-architecture package.
`config.yaml` selects and specializes that package for a platform and its
clusters. A Kubara compatibility profile preserves the `ServiceDefinition`,
wrapper, defaults, additions, and config templates beside the exact upstream
component. An upstream chart alone is not a complete Kubara component.

The same Kubara input must generate the same result from the normal Kubara
catalog lane and the ConfigHub-aligned export. Missing exact versions fail;
nearby versions are never silently substituted. Catalog growth is additive and
older versions stay available.

## Why a Kubara user should prefer ConfigHub

- Exact older component versions remain retained instead of disappearing from
  an upstream index.
- The generated revision becomes queryable Units with semantic history rather
  than only a directory tree.
- Approvals, promotion, rollback, and target departures are explicit fleet
  operations.
- A component-by-cluster matrix exposes selected versions and says `unknown`
  wherever no exact live observation receipt exists.
- `NeedsProvides` Links and a generated wiring ledger make dependencies visible
  without turning inferred wiring into authority.
- Each deployable config has its own OCI release, while a digest-pinned bundle
  records the whole platform revision.
- The existing Kubara authoring model and Argo reconciliation model survive.

## The GUI proof the post must show

Do not leave the improvement only in a diagram or receipt. Start from the one
`StartHere=true` platform Space and show the native GUI searches an adopter can
repeat:

- expand `KubaraBootstrap/argo-cd` for the faithful Kubara definition, then
  `ConfigHubBootstrap/argo-cd` for the adapted runtime and four cluster-local
  deployments; show the two exact `Lane` values in their metadata;
- open `ConfigHubApplications/hx-web` to show both bases, all four target
  deployments, releases, Argo health/sync state, and promotion topology;
- open `hx-web-dev/hx-web-deployment` and its **Links** tab to show
  `needs-platform-binding` beside `UpgradeUnit`, then open
  `hx-web-platform-dev/hx-web-platform` to show its cert-manager and Traefik
  `NeedsProvides` links;
- `Environment=Prod` for hx-web approval, rollback, and revision history; and
- `DeliveryMode=ConfigHubOCI` for source-Space Releases and their exact OCI
  manifest digests.

The GUI Components view is the selected platform, not the complete Catalog.
Show `URL-Catalog` opening the component-first public Catalog with all retained
versions, while `URL-Matrix` and `URL-Wiring` open evidence for this exact
platform. The matrix must call controller state **Argo sync**, never
“ConfigHub sync”; ConfigHub evidence is its separately recorded release and
manifest digest. Keep reusable definition lineage (`DefinitionSpace`) distinct
from the immediate promotion chain (`PromotionUpstreamSpace`).

## Current proof and importer claim boundary

The primary four-cluster fixture proves Kubara v0.13.0 generation, two
byte-identical catalog lanes, exact component locks, 13 effective renders, two
applications, generated matrix and wiring data, additive catalog retention,
and a deterministic ConfigHub mini-IDP contract. Its ConfigHub, Argo, and
workload claims remain gated by their specific receipts.

The generalized Git importer is the reusable adoption boundary rather than a
replacement platform definition. Its linear command family is
`--inspect-destination`, `--plan`, `--compile`, `--verify`, `--package`,
`--apply`, and `--self-test`. A public post
may describe only modes that pass the then-current acceptance suite. Package
and apply support must not be inferred merely because the flags exist: the
accepted implementation and receipts must prove:

1. an immutable Git-SHA receipt;
2. exact component-resolution results;
3. one OCI digest per deployable configuration;
4. a digest-pinned platform-bundle receipt;
5. separate topology and wiring outputs;
6. an explicit-organization, no-delete reconciliation receipt;
7. a repeated-run no-op receipt.

Even after package and organization reconciliation pass, describe their exact
boundary. ConfigHub platform Application objects and published source releases
are visible governed state; they are not evidence that Argo synced them or that
workloads are healthy. The faithful Kubara-hub lane remains a separate topology
proof. The retained v0.12.0 one-cluster route remains read-only historical
compatibility evidence, not the current adoption starting point.

## Honesty rails for every future post

- Do not print or package target Secret values.
- Do not call a moving Git ref immutable.
- Do not describe one opaque fleet YAML as component-level governance.
- Do not claim ConfigHub replaces Kubara's selection or wiring authority.
- Do not claim ConfigHub replaces Argo CD reconciliation.
- Do not call desired matrix cells live; leave observed version, sync, and
  workload state unknown until an exact receipt supplies them.
- Do not label an Argo CD sync observation as ConfigHub sync.
- Do not call a purpose-built fixture reconciler a general importer.
- Publish only importer modes exercised by the current accepted self-test and
  receipts. Do not preserve an old refusal claim after support lands, and do not
  announce an aspirational mode before its gate passes.
- Do not turn `watch`, `blocked`, or a missing receipt into `pass`.
- Do not require AI for adoption, generation, import, reconciliation, or
  verification.

## Evidence and visuals to use

- Primary buyer route:
  [`site/kubara.html`](../../site/kubara.html) and the
  [six-step adoption tutorial](../demo/kubara/adoption.md)
- Complete technical reference:
  [`docs/demo/kubara/single-platform.md`](../demo/kubara/single-platform.md)
- Current source:
  [`examples/kubara/current-platform`](../../examples/kubara/current-platform/README.md)
- Accepted importer and request contract:
  [`examples/kubara/git-import`](../../examples/kubara/git-import/README.md)
- Upstream-versus-aligned generation parity:
  [`examples/kubara/current-platform/catalog-parity-receipt.yaml`](../../examples/kubara/current-platform/catalog-parity-receipt.yaml)
- Catalog adapter:
  [`data/kubara-catalog-adapter/receipt.yaml`](../../data/kubara-catalog-adapter/receipt.yaml)
- Current component matrix:
  [`data/kubara-platform-matrix/matrix.html`](../../data/kubara-platform-matrix/matrix.html)
- Current wiring graph:
  [`data/kubara-wiring/graph.html`](../../data/kubara-wiring/graph.html)
- Release acceptance contract:
  [`data/kubara-release-acceptance/contract.yaml`](../../data/kubara-release-acceptance/contract.yaml)
- Historical live promotion and rollback:
  [`runs/kubara-app-rollout-proof/receipt.yaml`](../../runs/kubara-app-rollout-proof/receipt.yaml)

Preferred visuals:

1. The six-step adoption diagram above.
2. A side-by-side faithful hub Argo lane and optional ConfigHub delivery lane.
3. The component-by-cluster matrix with explicit unknown states visible.
4. A wiring view showing issuer to Certificate, IngressClass to Ingress, and
   ExternalSecret to Secret/store edges.
5. One component-instance OCI digest list plus the platform-bundle digest.

## Suggested article structure

1. Open with the two boundary sentences.
2. Show the familiar Kubara config and generated directory shape.
3. Walk the six adoption steps.
4. Explain component-first Catalog versus per-platform Kubara catalogs.
5. Show why per-config OCI plus a bundle index is stronger than one fleet blob.
6. Show the explicit ConfigHub organization, matrix, and wiring.
7. Show app promotion, approval, rollback, and Argo reconciliation.
8. Separate current proof from generalized importer status.
9. Close with the no-rewrite adoption path and the evidence links.

## Publication readiness checklist

- [x] Importer interface and request schema are committed.
- [ ] A real immutable Git revision is recorded; no synthetic SHA is used.
- [x] Offline compile, verify, and self-test pass.
- [ ] Per-config OCI digests and platform-bundle digest are published and
      verified.
- [ ] Explicit-organization reconciliation passes twice, with the second run a
      semantic no-op.
- [ ] Secrets and target facts remain outside Git and OCI artifacts.
- [ ] Current matrix live fields come only from exact observation receipts.
- [ ] The faithful and simplified delivery lanes remain clearly distinguished.
- [ ] The public page, blog copy, and release acceptance contract verify.
