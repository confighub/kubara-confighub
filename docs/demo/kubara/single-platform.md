# Adopt Kubara with ConfigHub: a reproducible four-cluster mini-IDP

> Start with the [Kubara + ConfigHub buyer overview](index.md), follow the
> [six-step adoption tutorial](adoption.md), inspect the
> [evidence checkpoints](checkpoints.md), or use the [GUI tour](gui-tour.md).
> This page retains the complete technical and maintainer reference.

**ConfigHub simplifies Kubara without making it fundamentally different.** This
primary example uses Kubara v0.13.0, four clusters, seven platform roles, and
two applications, with no AI rewrite or platform-model migration.

An existing Kubara user can adopt it by updating normal catalog references,
`config.yaml`, and values overrides. The official Kubara `bootstrap:1.1.0` and
`general:1.1.0` catalogs remain valid inputs, and no permanent chart fork is
part of the path.

That is the adoption promise: Kubara's documentation and generated shape stay
useful, while ConfigHub adds searchable component identity, governed variants,
approval and release history, and operational wiring. The result is a stronger
way to operate Kubara, not a replacement platform that requires a rewrite.

The boundary is intentionally simple:

> **Kubara composes; ConfigHub governs; Argo reconciles.**

- Kubara's catalogs, `ServiceDefinition`s, wrappers, `config.yaml`, and
  `values-*.yaml` overlays continue to describe the platform.
- ConfigHub retains and reviews exact component versions, records the resulting
  configuration and its relationships, applies policy, and gives promotion and
  rollback a durable history.
- Argo CD remains the reconciler: the familiar Kubara hub retains its native
  mode, while each optional small local reconciler applies only the exact
  digest authorized by ConfigHub.

The source is
[`examples/kubara/current-platform`](../../../examples/kubara/current-platform/README.md).
The older Kubara v0.12.0 material is retained as
[historical compatibility evidence](local-platform.md); it is no longer the
recommended starting point.

## The platform you will reproduce

The same checked-in Kubara config describes one hub and three spokes:

| Cluster | Kubara role | Environment | Selected platform services |
| --- | --- | --- | --- |
| `hx-app-dev` | hub | development | Argo CD, cert-manager, External Secrets, Homer, kube-prometheus-stack, Metrics Server, Traefik |
| `hx-app-staging` | spoke | staging | cert-manager, Traefik |
| `hx-app-prod-a` | spoke | production | cert-manager, Traefik |
| `hx-app-prod-b` | spoke | production | cert-manager, Traefik |

This is 13 component instances: one hub Argo CD, cert-manager and Traefik on all
four clusters, and four additional services on the hub. The selected versions
are exact:

| Kubara role | Exact selected component and ConfigHub candidate |
| --- | --- |
| Argo CD | `argo-cd/argo-cd@10.2.1` |
| cert-manager | `jetstack/cert-manager@v1.21.0` |
| External Secrets | `external-secrets/external-secrets@2.8.0` |
| Homer | Kubara first-party wrapper `0.1.0` |
| monitoring | `kube-prometheus-stack@87.19.2` plus `prometheus-blackbox-exporter@11.15.1` |
| Metrics Server | `metrics-server/metrics-server@3.13.1` |
| Traefik | `traefik/traefik@41.0.2` |

Two applications are defined to use those services on the same four targets:

- **hx-web** is the smallest useful proof: a digest-pinned nginx Deployment and
  Service, plus a cert-manager Certificate and Traefik Ingress.
- **cubbychat** is a three-tier application: digest-pinned Postgres, backend,
  and frontend workloads, plus a Certificate and Ingress. Its upstream commit
  and every image digest are recorded in
  [`apps/source-lock.yaml`](../../../examples/kubara/current-platform/apps/source-lock.yaml).

The committed cubbychat credential is deliberately demo-only. A real adopter
must replace it with an ExternalSecret or another target-owned Secret.

## Start Here in the ConfigHub GUI

In the `Kubara` organization, filter Spaces by `StartHere=true`, open
`hx-platform`, and then open its `platform-contract` Unit. That is the stable
entry point for the example; it links the governed platform contract to these
public views:

- [buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html);
- [component-first Catalog with every retained version](https://confighub.github.io/helm-expt/site/charts/);
- [36-cell component × cluster matrix](https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html);
- [full extracted wiring graph](https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html).

Open the adjacent `component-catalog-coverage` Unit to see the Catalog promise
inside the GUI itself: `CatalogComponents=103`, `CatalogVersions=130`,
`KubaraSelections=18`, and `Retention=AdditiveOnly`. Its payload is the exact
passing full-coverage receipt, and `URL-CatalogCoverage` opens that receipt
directly. The `component-catalog-selection` Unit remains the platform-specific
view of what this four-cluster platform actually chose.

The GUI labels make the Kubara shape searchable instead of hiding it in folder
names. The native Components view is component-first: `Owner=KubaraGeneral`
groups the selected Kubara catalog and `Component` names the reusable catalog
component. `ComponentSurface` names a deployable or configuration surface,
while `Variant` shows its base or target specialization.
`CatalogComponent`/`KubaraComponent` and `ComponentVersion` retain source
identity and the exact selection. `Role`, `DefinitionSpace`, and `InstanceOf`
expose definition-to-instance lineage.
The Components view shows the exact versions selected for this platform; follow
`URL-Catalog` to browse the full additive Catalog, including all 130 retained
versions rather than mistaking this platform selection for the whole catalog.
Pure platform-control and ClusterTarget Spaces deliberately stay out of the
Components view; they remain visible through `StartHere`, `Role`, `Cluster`,
and `ClusterRole` searches in Spaces.
`ClusterRole` exposes hub versus spoke, while `Reconciler`, `DeliveryMode`, and
`ControlPlane` make the simplified lane explicit: ConfigHub is the control
plane, and each target keeps a cluster-local Argo reconciler. Search for
`Component=argo-cd` to see two deliberately separate cards and lineages:
`hx-argo-base` is `Owner=KubaraBootstrap`, `Lane=Faithful`, chart 10.2.1 to
runtime v3.4.5; `hx-argo-runtime-base` is `Owner=ConfigHubBootstrap`,
`Lane=Adapted`, runtime v3.4.6, and is the definition for the four delivery
instances. The target instances are not children of Kubara's faithful chart
definition. Search for
`Component=argobot` to see the exact ConfigHub delivery helper at v0.1.6 and
its four target instances; its version is kept separate from Kubara's version.
Search for
`Component=hx-web` or `Component=cubbychat` to follow either application
from its definition to all four target instances.

After the source-current mini-IDP and orphan receipts pass, the shortest
complete GUI tour uses native pages and repeatable searches:

1. Open **Components**. Expand `KubaraBootstrap` and
   `ConfigHubBootstrap`: the former contains the faithful Kubara Argo
   definition; the latter contains the adapted runtime and its four cluster
   deployment cards. Their Space and Unit metadata shows `Lane=Faithful` and
   `Lane=Adapted` respectively.
2. Expand `ConfigHubApplications`, open `hx-web`, and use **Auto** layout. The
   page shows the reusable workload and platform-binding bases, all four target
   deployments, their release numbers, Argo health/sync state, and the actual
   promotion topology. Open `cubbychat` to repeat the same four-target check for
   the second application.
3. From `hx-web`, open the `dev` workload, select `hx-web-deployment`, and open
   **Links**. The table must show both its `UpgradeUnit` lineage and
   `needs-platform-binding` as `NeedsProvides`; every curated wiring Link also
   carries `Relationship=NeedsProvides` for a direct GUI filter. Then open
   `hx-web-platform-dev/hx-web-platform`; its **Links** table shows the
   cert-manager and Traefik requirements. These are the native GUI proof of the
   curated wiring, while `URL-Wiring` opens the complete extracted graph.
4. Filter Spaces by `Environment=Prod`, open `hx-web-prod-a` and
   `hx-web-prod-b`, then inspect their revisions and approvals to see promotion,
   exact gated heads, server `HeadRevisionNum` approval bracketed by Unit ID,
   observed numeric head, and `DataHash`, rollback, and retained history.
5. Filter by `DeliveryMode=ConfigHubOCI`, open a source Space and its
   **Releases**, and inspect the exact published OCI manifest digest that its
   Argo Application reconciles.

This is the useful continuity for an adopter: the same hub, spokes, components,
applications, and Argo reconciliation remain recognizable, while ConfigHub
adds a component-first and queryable operating model that plain Kubara does not
provide on its own.

## The two delivery lanes preserve the same Kubara shape

The example proves two ways to operate one generated platform. They are delivery
choices, not competing platform definitions.

### Faithful lane: keep Kubara's hub and spokes

```text
Kubara catalogs + config.yaml + values overrides
  -> kubara generate --helm
  -> platform-components/ + platform-configs/ in Git
  -> ConfigHub review, approval, and revision attestation
  -> existing hub Argo CD + ApplicationSets
  -> registered spoke clusters
```

The hub stays the management cluster. Kubara's generated AppProjects,
ApplicationSets, cluster labels, Git paths, and `kubara cluster add` workflow
remain recognizable. ConfigHub adds a governed decision around the Git revision;
Git merge remains the enforceable release decision until a repository requires
the ConfigHub status. The faithful proof explicitly records that required-status
integration as not enforced rather than implying otherwise.

### Simplified lane: ConfigHub takes the hub role

```text
the same Kubara-generated desired state
  -> ConfigHub base Units + target variants
  -> checks, approval, promotion, and immutable release
  -> one small local Argo CD reconciler per cluster
  -> hub and spoke targets
```

Here ConfigHub is the fleet control plane and release authority. Each cluster
keeps a local reconciler, so promotion and rollback can be isolated by cluster.
The selected components, namespaces, target differences, and dependency order
still come from Kubara. An adopter may keep the faithful topology indefinitely
or move to this lane one target at a time.

## Catalog mapping: component first, platform composition preserved

Kubara and ConfigHub use the word *catalog* at different levels. Alignment keeps
both levels instead of flattening one into the other. Kubara's
[catalog documentation](https://docs.kubara.io/latest-stable/2_concepts/catalogs/)
describes the reusable package of service definitions, platform components, and
platform configurations; that package remains intact here.

| Layer | Owner | What it contains |
| --- | --- | --- |
| Exact reusable component | ConfigHub Catalog | One reviewed chart or first-party component version, its source digest, rendered bases, lifecycle routes, target facts, and retained history. Deployable variants and configurations follow the component; they do not replace it. |
| Kubara compatibility profile | Kubara plus the deterministic adapter | The matching `ServiceDefinition`, wrapper templates, defaults, additions, and `platform-configs` templates needed to reproduce Kubara behavior from that exact component. |
| Per-platform package, selection, and wiring | Kubara | The effective ordered catalogs and `config.yaml` select services for each hub or spoke and specialize them with normal values overrides. |
| Fleet desired state and change history | ConfigHub | Searchable definition and instance Units, variants, releases, checks, approvals, promotions, rollbacks, departures, a governed desired matrix, and 25 curated operational wiring Links. |
| Derived public evidence | Deterministic generators plus exact receipts | The 36-cell receipt-aware matrix and the full extracted wiring graph. These views link from the ConfigHub Start Here Unit but are not mislabeled as native GUI observations. |

The adapter retains all four Kubara catalog surfaces: `Catalog.yaml`,
`services/`, `platform-components/`, and `platform-configs/`. The current 1.1.0
release contains 18 ServiceDefinitions. Seven selected platform roles are
deeply mapped, `bootstrap-crds` remains a separate non-user-selectable bootstrap
concern, and the other ten services are retained byte-for-byte as explicitly
unreviewed pass-through content. Nothing is silently dropped or upgraded.

Most importantly, the two source lanes now produce the same result:

```text
same config.yaml and values overrides
  |-- Kubara official 1.1.0 release snapshot -----------|
  `-- ConfigHub-aligned, byte-preserving catalog export -|
                                                        v
                                          kubara v0.13.0 generate
                                                        |
                                      135 identical files, no diffs
```

The
[`catalog-parity-receipt.yaml`](../../../examples/kubara/current-platform/catalog-parity-receipt.yaml)
records path-and-byte-for-byte equality across all 135 generated files. The
adapter receipt separately proves that the complete catalog export matches the
pinned upstream release tree. This is a deterministic export, not an AI
translation. The committed source config continues to name Kubara's official
OCI catalogs; only temporary generation copies are repointed for the comparison.

ConfigHub's exact-version policy is `fail-if-missing` and retention is
`additive-only`. A missing exact mapping never turns into a nearby-version
substitution. New versions are added after qualification; older recipes,
packages, receipts, and public paths remain available.

### What an existing Kubara user edits

Adoption is a bounded data update, not a translation project:

| Existing Kubara surface | Adoption action |
| --- | --- |
| Catalog references | Keep the official or organization-owned references for the faithful lane. Add an aligned ConfigHub export only after its parity check passes. |
| `config.yaml` | Keep the same schema and service selections. Add the desired hub and spoke entries or start with one existing cluster. |
| `values-*.yaml` | Copy supported customizations into the canonical `source/overrides/<cluster>/helm/<service>/` hierarchy. |
| Custom wrapper or external catalog | Retain its ServiceDefinition, wrapper, defaults, and config templates as a compatibility profile; do not reduce it to the upstream chart version. |
| Exact chart pins | Add missing versions to `component-artifacts.yaml`, generate candidates, live-qualify them, and promote additively. Never replace an unavailable pin silently. |
| Git and Argo settings | Keep current repositories, revisions, AppProjects, ApplicationSets, and registrations in faithful mode. Repoint only a target deliberately moved to ConfigHub delivery. |
| Cluster prerequisites | Record issuers, secret stores, storage classes, load balancers, and kind-only differences as target facts. |
| Applications | Keep application source independent of the platform contract; bind each target instance to the platform capabilities it consumes. |

Generated trees, checksums, matrices, wiring graphs, and receipts are outputs.
Regenerate them after changing the inputs; do not maintain a second hand-edited
copy.

## From Kubara's Git revision to ConfigHub in six adoption steps

The general importer now implements the complete reusable boundary. It is a
semantic port of Kubara's generated result, not a source rewrite: the same
catalog selections, hub/spoke placement, per-cluster specialization, rendered
objects, namespaces, and wiring remain identifiable throughout.

```text
config.yaml + ordered Kubara catalogs
  -> generated platform + add-ons + ApplicationSets + wiring
  -> deterministic preparer + reviewed exact artifact lock
  -> separate clean hand-off subtree
  -> immutable, pushed Git revision + locks + external scan receipt
  -> target-neutral component/config OCI set + platform content lock
  -> selected ConfigHub organization + separate destination binding lock
  -> governed app releases -> cluster-local Argo reconciliation
```

### 1. Select and wire the platform in Kubara

Keep using Kubara's `config.yaml`, effective ordered catalogs, normal
`values-*.yaml` overrides, and familiar service definitions. The official
catalog and the byte-preserving ConfigHub-aligned export produce the same 135
generated files for this example. ConfigHub does not choose a different
platform or require AI to reconstruct the intent.

### 2. Let Kubara generate the complete platform tree

Retain `platform-components/`, `platform-configs/`, add-ons, AppProjects,
ApplicationSets, documented overrides, effective renders, and wiring. The
importer treats them as one coherent platform revision while keeping every
reusable definition and effective component/config instance separately
packageable and reviewable.

### 3. Prepare, commit, and push a clean Git hand-off

Run the hand-off preparer after Kubara's normal generation command. It does not
run or emulate Kubara, rearrange the existing source tree, consult a cluster,
or use AI. A reviewed request maps the ordinary Kubara paths, pins the exact
Kubara binary, Helm build, render capabilities, and component artifacts, and
writes a separate clean subtree atomically:

```sh
node scripts/prepare-kubara-git-handoff.mjs --generate \
  --request /absolute/path/to/checkout/examples/kubara/git-import/current-platform.prepare.yaml \
  --checkout /absolute/path/to/checkout \
  --kubara-bin /absolute/path/to/sha-pinned-kubara
```

For this example the output is
`examples/kubara/prepared-current-platform`: 167 checked files containing the
copied source/config and reviewed generated tree, 13 deterministic effective
renders, exact locks, generation and preparation receipts, checksums, and the
offline wiring graph. The preparer refuses a missing or ambiguous exact
component artifact, copied-input drift, credential-shaped material, dotenv and
target-fact files, symlinks, pre-vendored chart archives, and a concurrent input
change. It keeps applications, destination facts, and secret values outside the
platform hand-off.

#### Commit, push, scan, and offline-verify the exact hand-off

Commit and push the source config, complete generated tree, reviewed
preparation request, exact artifact and dependency locks, separate prepared
subtree, source/render checksums, generation and preparation receipts, and
wiring ledger together. The import request pins one HTTPS `.git` remote, full
immutable commit object, and selected prepared path. A mutable ref, wrong
origin, dirty or untracked file, symlink, checksum drift, or selected byte
changing during compile is refused.

In a clean checkout of the pushed commit, verify that the raw Kubara inputs and
prepared subtree still match byte for byte. This command is offline and must
leave the checkout unchanged:

```sh
npm run kubara-git-handoff:verify-current
```

Then run a pinned external secret scanner over that exact commit and selected
path, retain its report outside the tree, and explicitly review opaque files.
The importer also applies a conservative credential-shaped-material check, but
does not pretend either mechanism can prove arbitrary bytes secret-free.

The reusable request, path rules, and exact command sequence are in the
[Git-revision hand-off guide](../../../examples/kubara/git-import/README.md).

### 4. Verify the exact revision and publish immutable OCI

The importer verifies the clean, immutable source revision, exact artifacts,
effective renders, object counts, and wiring ledger before publishing the
portable packages. Start from `portable-request.example.yaml`; it names only
the immutable Git source and layout, exact external scan attestation, and
untagged OCI repository base. `--compile-portable` and `--verify-portable`
cross-check the complete Git inventory, exact component artifacts,
effective-render hashes and object counts, generation receipt, and wiring
ledger without requiring a ConfigHub organization. `--package-portable` then
publishes one target-neutral immutable OCI layer per component definition, one
per effective component/config set, and one platform index. Under the required
exclusive single-writer gate for that OCI repository base, existing exact
artifacts are reused and an observed conflicting layer or media contract is
refused.

The portable `PlatformDigest` excludes all destination facts. A separate
`BindingDigest` covers the organization, targets, runtime observations,
workload pins, and navigation. Consequently the same Kubara revision produces
the same component payloads and platform digest in two organizations, while
each organization receives its own binding lock. The binding lock and target
facts are explicitly excluded from OCI.

### 5. Load the selected organization and verify twice

The user first selects and bootstraps the destination organization, Targets,
and ConfigHub-managed cluster-local Argo roots. The importer never guesses an
ambient organization and never creates an organization or Target. A read-only
`--inspect-destination` pins the context/server, organization entity,
Space/Target/Unit IDs, Unit data hashes, argobot source, published workload
heads, and separately observed delivery-runtime version and image. `--bind`
then recompiles the Git source, requires byte equality with the portable set,
and writes the destination plan, binding lock, and pending target-fact template
into a separate directory. It copies or exactly reuses the local OCI tree and
passing publication receipt and refuses conflicting bound output;
destination-bound `--verify` must pass before any apply. An operator completes
the generated, secret-free target-fact attestation
from external evidence. `--apply` pulls and verifies every exact OCI layer
before mutation, then materializes definition/instance Spaces and Units, target
metadata, `UpgradeUnit` lineage, curated `NeedsProvides` Links, platform Argo
Applications, apps-root releases, and source releases in deterministic order.
Each run requires serialized control of that importer-managed topology and its
request-pinned bootstrap/workload heads because `cub` mutations are not one
cross-client conditional transaction; unrelated app source Spaces stay outside
that operational lock.

The first apply records changes. An immediate identical second apply must
record zero actions before `apply-receipt.json` passes. That receipt is a
deterministic continuity record, not a server-signed or cryptographically
tamper-proof attestation. The importer itself issues no delete operation;
generated Argo Applications disclose and retain pruning, so removals in a later
reviewed source release can be deleted from a cluster after sync. Argo sync and
cluster health are verified separately at the receipt's exact release digests.

The request exposes two Argo identities rather than conflating them:
`hx-argo-base` is Kubara's **Faithful** chart 10.2.1 definition, whose current
render contains Argo CD v3.4.5; `hx-argo-runtime-base` is the **Adapted**
ConfigHub delivery-runtime definition, bound to the externally observed local
runtime (v3.4.6 in this example). The faithful hub executor remains a separate
proved lane; the general importer materializes the ConfigHub-managed local-Argo
lane without changing the platform selection.

### 6. Deploy and promote applications

Teams use the normal ConfigHub application workflow for app definitions,
target variants, checks, approvals, promotions, rollbacks, departures, and
releases. Argo remains the cluster-local reconciler of each exact requested
digest. The platform importer
does not invent app code or flatten applications into its platform index.

Existing workload Applications can be request-pinned and preserved exactly.
Adding those pins changes `BindingDigest`, not `PlatformDigest` or component
OCI. A later Kubara content revision requires a separately preserved passing
receipt and an explicit additive transition: the importer can resume an exact
authorized partial run, but cannot silently remove or rename managed topology,
drop a workload pin, rebind a Target or upstream, or rewire a Link.

### Implemented versus separately proved

| Surface | Current four-cluster evidence | General importer implementation |
| --- | --- | --- |
| Kubara selection and generation | Kubara v0.13.0 generates 135 byte-identical files from both catalog lanes and 13 deterministic effective renders. | Accepts the complete supported Kubara tree without changing selections, topology, namespaces, or wiring. |
| Git and security boundary | Committed locks, checksums, generated files, renders, and wiring remain reviewable. | Requires an exact clean pushed revision, inventories every selected path, requires an external scanner attestation, and keeps target facts outside Git/OCI. |
| Component-first OCI | The Catalog retains all 130 versions across 103 components while this platform selects seven roles. | Under exclusive single-writer publication control, publishes reusable definition and effective-config packages plus a target-neutral digest index; exact observed remote layers are reused and conflicts are refused. |
| ConfigHub shape | The purpose-built mini-IDP's live claim depends on its exact receipt. | Applies to an explicitly selected existing context with pre-existing targets/bootstrap; allows only an identical current digest or exact prior-receipt-authorized additive transition, and proves a second zero-action run in its isolated acceptance suite. |
| Wiring and delivery | The desired contract requires 25 curated `NeedsProvides` Links; the accepted live and orphan receipts decide whether the GUI currently has all 25. The public graph retains the full extracted evidence. | Materializes exact Links and Applications from a versioned contract; publishes apps-root releases before source releases and verifies pulled payload bytes. |
| Applications | hx-web and cubbychat exercise promotion, approval, rollback, departures, release, and reconciliation in the mini-IDP lane. | Preserves explicitly pinned existing workload Applications, then hands new application delivery to the ordinary ConfigHub workflow. |

Use the copyable, fully linear
[request contract and walkthrough](../../../examples/kubara/git-import/README.md)
and its separate
[`portable-request.example.yaml`](https://github.com/confighub/helm-expt/blob/main/examples/kubara/git-import/portable-request.example.yaml)
and
[`request.example.yaml`](https://github.com/confighub/helm-expt/blob/main/examples/kubara/git-import/request.example.yaml).
The general importer modes are implemented: `--compile-portable`,
`--verify-portable`, `--package-portable`, `--inspect-destination`, `--bind`,
`--plan`, destination-bound `--verify`, and `--apply`. The companion
selected-organization workflow compiler turns those commands, explicit
bootstrap, two-run apply, application release, and final acceptance into a
durable operation journal without executing them. Its journal verifier checks
the immutable command contract and ordered prefix, then opens every completed
step's regular evidence file and verifies its recorded SHA-256. Evidence-type
specific verifiers still decide whether those bytes support the live claim.
The isolated acceptance suite covers two destination organizations, OCI
publication and pulled-layer verification, exact bootstrap and workload pins,
interruption/resume, additive next-revision transitions, adversarial refusals,
and the required second zero-action run:

```bash
npm run kubara-git-import:self-test
```

This self-test does not contact a live ConfigHub organization, registry, or
cluster. The canned four-cluster reconciler below remains the separate live
proof and website source of truth.

It is therefore not a live acceptance receipt for a fresh user-selected
organization. A clean-checkout run that bootstraps or binds one newly selected
organization, imports the portable packages, applies twice, passes its orphan
audit, and reaches one healthy application remains the general-path graduation
gate.

## Prepare the deterministic inputs

Complete this preparation from the repository root before entering the ordered
release gates below. These commands generate or verify repository artifacts;
they do not qualify a live release or publish catalog packages.

### Prepare the pinned Kubara catalog bridge

Generate the byte-preserving export from the immutable snapshots, then verify
it offline:

```bash
node scripts/generate-kubara-catalog-adapter.mjs --generate
node scripts/generate-kubara-catalog-adapter.mjs --verify
```

Review
[`data/kubara-catalog-adapter/receipt.yaml`](../../../data/kubara-catalog-adapter/receipt.yaml)
before changing a catalog reference. The release snapshot and a later observed
Git head are separate sources even though both say `1.1.0`; their 16 changed
files are not treated as interchangeable.

### Prepare the exact component candidates

The current candidate set reuses four byte-identical retained versions and adds
only the three versions that changed in Kubara v0.13.0: Argo CD 10.2.1,
External Secrets 2.8.0, and kube-prometheus-stack 87.19.2.

```bash
node scripts/run-kubara-catalog-candidates.mjs --generate
node scripts/run-kubara-catalog-candidates.mjs --verify

node scripts/run-kubara-current-catalog-candidates.mjs --generate
node scripts/run-kubara-current-catalog-candidates.mjs --verify
```

The
[`candidate-set.yaml`](../../../data/kubara-catalog-refresh/current-candidates/candidate-set.yaml)
binds every candidate to its exact public artifact and SHA-256 digest. Candidate
status means offline render and package checks passed; it does not by itself
mean live qualification or root-catalog promotion passed.

### Generate the four-cluster platform from both catalog sources

Download the Kubara v0.13.0 release binary for your platform and verify it
against
[`source-lock.yaml`](../../../examples/kubara/current-platform/source-lock.yaml).
Then run:

```bash
KUBARA_BIN=/absolute/path/to/kubara \
  node scripts/generate-kubara-current-example.mjs --generate

node scripts/generate-kubara-current-example.mjs --verify
```

Generation checks the Kubara binary, both pinned catalog trees, all seven public
artifacts, documented overrides, 135 generated files, and 13 effective renders.
It renders each component twice and requires deterministic bytes. Verification
is network-free and does not require Kubara, Helm, a registry, ConfigHub, or a
cluster. The complete outcome is in
[`generation-receipt.yaml`](../../../examples/kubara/current-platform/generation-receipt.yaml).

The normal overrides remain in the familiar Kubara hierarchy:
`source/overrides/<cluster>/helm/<service>/values-*.yaml`. They record the kind
self-signed issuer, the Metrics Server kind TLS setting, the Homer links, and
the hub Git/AppProject paths. Each cluster also has a Traefik kind variant that
uses cub's existing NodePort window and publishes the cluster's configured
`dnsName` into Ingress status. The local proof therefore uses standard Argo
health without installing a load-balancer controller; production targets omit
that kind-only values file and retain their normal LoadBalancer configuration.
These are authoring inputs, not hidden post-render patches.

The committed kind exposure is deliberately explicit. The first mapped port in
each cub window remains reserved for `argocd-server`; Traefik uses the separate
HTTP/HTTPS pair two slots later:

| Cluster | Reserved for Argo CD | Traefik HTTP | Traefik HTTPS | Ingress status hostname |
| --- | ---: | ---: | ---: | --- |
| `hx-app-dev` | 30000 | 30002 | 30003 | `hx-app-dev.traefik.me` |
| `hx-app-staging` | 30010 | 30012 | 30013 | `hx-app-staging.traefik.me` |
| `hx-app-prod-a` | 30020 | 30022 | 30023 | `hx-app-prod-a.traefik.me` |
| `hx-app-prod-b` | 30030 | 30032 | 30033 | `hx-app-prod-b.traefik.me` |

The mini-IDP preflight must reserve and verify those four cub port windows
before it publishes target releases. Once the live receipt passes, a user can
exercise either application through any cluster without adding a load-balancer
controller:

```bash
curl -H 'Host: hx-web.local' http://127.0.0.1:30002/
curl --insecure --resolve cubbychat.local:30003:127.0.0.1 \
  https://cubbychat.local:30003/
```

Use the corresponding port pair for staging, prod-a, or prod-b. `--insecure`
is appropriate only for this explicitly self-signed local proof.

### Materialize the current matrix and wiring views

```bash
node scripts/generate-kubara-effective-renders.mjs --verify --profile current

node scripts/generate-kubara-wiring.mjs --generate --profile current
node scripts/generate-kubara-wiring.mjs --verify --profile current
node scripts/generate-kubara-wiring.mjs --self-test

node scripts/generate-kubara-platform-matrix.mjs --generate --profile current
node scripts/generate-kubara-platform-matrix.mjs --verify --profile current
node scripts/generate-kubara-platform-matrix.mjs --self-test
```

Open the
[colored component × cluster matrix](../../../data/kubara-platform-matrix/matrix.html)
to see exact selected versions, placement, departures, and any sync or workload
observations supplied by the exact current receipt. ConfigHub governs the
desired-only matrix in `hx-platform/platform-matrix`; the public matrix is
regenerated from that desired state plus receipt evidence and leaves any
unobserved field `unknown`. Open the
[wiring graph](../../../data/kubara-wiring/graph.html)
to see the complete extracted set of component-to-component needs and provides,
including ApplicationSet to cluster-registration edges, CRD dependencies,
Secret production, issuer and IngressClass references, and unresolved target
facts. After an accepted live run, the ConfigHub GUI must show 25 curated
operational `NeedsProvides` Links; the public graph is the complete evidence
view. Machine-readable CSV and JSON live beside both HTML reports.

These views are stronger than a static platform diagram because they are
regenerated from the committed platform data and exact receipts. They also stay
honest: a desired render or ConfigHub Unit is not a live cluster observation.
Until a receipt records an observed version, sync state, or workload state for
an exact cell, the public matrix says `unknown`. The
[evidence guide](platform-evidence.md) explains every status and the boundary
between governed GUI state and derived public evidence.

## Run the audited release sequence exactly in this order

The
[`KubaraConfigHubReleaseAcceptance` contract](../../../data/kubara-release-acceptance/contract.yaml)
binds this order to the expected inputs, receipts, catalog additions, published
artifacts, topology proofs, mini-IDP state, and website. The faithful topology
proof follows catalog publication; the mini-IDP receipt follows that proof;
the live matrix and final catalog/site release follow the receipt.

The live steps require Docker, kind, Kubernetes tools, a signed-in `cub` CLI,
and access to the `Kubara` ConfigHub organization. Qualification runners own
only their explicitly named temporary resources. The mini-IDP reconciler
preserves and updates the four persistent `hx-app-*` targets.

### 1. Pass the offline acceptance gate

```bash
npm run kubara-release:verify-static
```

This gate proves the committed snapshots, candidates, current example, parity,
effective renders, matrix, and wiring. It does not turn a missing live receipt
into a pass.

### 2. Run and verify the historical live qualification

```bash
npm run kubara-live-qualification:preflight
npm run kubara-live-qualification:run
npm run kubara-live-qualification:verify
```

The v0.12-selected set remains a required compatibility root. All 13 bases must
pass before those seven exact versions can be promoted.

### 3. Run and verify the current live qualification

```bash
npm run kubara-current-live-qualification:preflight
npm run kubara-current-live-qualification:run
npm run kubara-current-live-qualification:verify
```

The current set reuses four identical qualified versions and runs the changed
Argo CD 10.2.1, External Secrets 2.8.0, and kube-prometheus-stack 87.19.2 lanes.
Do not convert a `watch` or `blocked` lane into a pass from prose. Large CRDs,
target facts, hooks, and existing-Secret requirements remain explicit in the
receipts.

### 4. Promote the seven historical versions additively

```bash
npm run kubara-catalog-promotion:dry-run
npm run kubara-catalog-promotion:stage
npm run kubara-catalog-promotion:stage:verify
npm run kubara-catalog-promotion:promote
npm run kubara-catalog-promotion:verify
```

### 5. Promote the three current additions additively

```bash
npm run kubara-current-catalog-promotion:dry-run
npm run kubara-current-catalog-promotion:stage
npm run kubara-current-catalog-promotion:stage:verify
npm run kubara-current-catalog-promotion:promote
npm run kubara-current-catalog-promotion:verify
```

Both promotion gates refuse a pre-existing destination, preserve the immutable
110-version baseline, and only add the ten qualified versions. Their
intermediate root total is 120; no older recipe, package, receipt, or path is
removed. The next gate retains that complete 120-root state byte-for-byte while
adding the remaining Kubara catalogs 1.1.0 selections.

### 6. Publish and verify the ten exact catalog OCI additions

```bash
npm run kubara-catalog-oci:dry-run
npm run kubara-catalog-oci:publish
npm run kubara-catalog-oci:verify
```

Publication is deliberately after both root promotions. It addresses the exact
ten approved packages and records immutable digests; a local candidate or root
path alone is not a publication claim.

### 7. Complete every Kubara catalogs 1.1.0 component selection

Kubara's pinned bootstrap and general wrapper catalogs contain 21 dependency
occurrences and 18 unique exact component/version selections. Ten were not yet
version roots in ConfigHub's Catalog. Generate and verify those candidates,
perform the no-write source/registry preflight, promote them additively, then
publish only their ten exact OCI refs:

```bash
npm run kubara-catalog-full-coverage:generate
npm run kubara-catalog-full-coverage:verify-candidates
npm run kubara-catalog-full-coverage:preflight
npm run kubara-catalog-full-coverage:promote
npm run kubara-catalog-full-coverage:publish
npm run kubara-catalog-full-coverage:verify
```

This gate increases the component-first Catalog from 100 components and 120
versions to 103 components and 130 versions. It byte-locks every older root,
refuses an existing different remote layer, records the exact URL and SHA-256
for each selected source, and keeps external-dns 1.21.1 and Traefik 41.0.2 as
separate supplemental source locks because their existing package roots do not
need to change. Publication proof does not by itself claim target-specific
runtime health or production readiness.

### 8. Prove the faithful Kubara hub-and-spoke lane

```bash
export KUBARA_BIN=/absolute/path/to/kubara
npm run kubara-faithful-hub-spoke:rehearse
npm run kubara-faithful-hub-spoke:run
npm run kubara-faithful-hub-spoke:generate
npm run kubara-faithful-hub-spoke:verify
```

This lane keeps one Git source, Kubara's hub Argo CD, its AppProject and
ApplicationSet, an External Secrets-backed spoke registration, and the spoke
cert-manager workload. It proves the recognizable topology before the optional
simplified lane. The current
[machine-generated summary](../../../data/kubara-faithful-hub-spoke/summary.md)
records a pass for Kubara v0.13.0, catalog 1.1.0, ConfigHub plan approval,
OpenBao-to-External-Secret registration, Synced/Healthy cert-manager delivery,
and exact cleanup. The receipt also states that a ConfigHub approval
attestation is not yet an enforced GitHub required status.

### 9. Reconcile and verify the complete ConfigHub mini-IDP

```bash
npm run kubara-mini-idp:plan
npm run kubara-mini-idp:apply
npm run kubara-mini-idp:apply
npm run kubara-mini-idp:verify
npm run kubara-mini-idp:receipt-verify
npm run kubara-mini-idp:orphan-plan
npm run kubara-mini-idp:orphan-audit:self-test
npm run kubara-mini-idp:orphan-audit
npm run kubara-mini-idp:orphan-audit:receipt-verify
```

The [measured reconciliation cost model](reconciliation-performance.md)
explains why Unit count is not request count, which N+1 reads were removed,
what the receipt measures before first Argo convergence, and which safety
checks remain deliberately serial.

The current immediate no-op is functional idempotence evidence, not a speed
claim: it made zero ConfigHub mutation attempts and zero Argo sync requests,
recorded 33 ConfigHub CLI read commands and 208 total subprocess calls, and took
about 77 seconds end to end. It meets the fixture regression target. A CLI
command is not an authenticated HTTP round trip, and this is neither a
raw-Kubara comparison nor a service-level promise.

The adapted lane deliberately separates OCI discovery from deployment
authority. Every managed Application keeps
`spec.source.targetRevision: latest` only so Argo can discover the ConfigHub
OCI stream; every one omits `spec.syncPolicy.automated`, including the four
self-managing roots. `argobot` is pinned to
`ghcr.io/confighub/argobot:v0.1.6` with the literal environment
`ARGO_SYNC_MODE=kubernetes`, `ARGO_NAMESPACE=argocd`, and
`ARGO_REFRESH_TYPE=hard`. That reviewed mode performs a hard refresh only and
cannot submit a sync.

ConfigHub is the release authority. Immediately before any cluster-side
operation, the reconciler revalidates the exact authoritative published
release and Unit heads, requires that no Argo operation is active, and submits
`operation.sync.revision=<ManifestDigest>`. The Kubernetes JSON patch tests the
Application's exact `metadata.uid` and `metadata.resourceVersion`; a concurrent
change forces a reread rather than a last-writer-wins deployment. This is the
governed improvement over raw mutable-tag auto-sync: approval, promotion, and
rollback select the digest, while the familiar cluster-local Argo controller
still reconciles it. The proof covers this managed automated delivery path,
not a privileged human or manual Argo sync; excluding that path requires
separate Argo RBAC or admission evidence.

Run the orphan audit only after the second apply and ordinary live verification
have completed. It consumes the reconciler's exact plan rather than a separate
hand-maintained topology, takes the shared serial live lock, and refuses an
in-flight convergence, namespace migration, scenario or fleet-bootstrap
journal. Its live commands are read-only. For the current plan it requires
exactly 55 Spaces, 105 total allowed Units, 64 UpgradeUnit/NeedsProvides Links,
four Targets and the 35 Argo Applications declared by the delivery Units. Every
live Application must report the exact authoritative published manifest digest,
retain `targetRevision: latest` as discovery-only, omit
`spec.syncPolicy.automated`, and have no
`status.resources[].requiresPruning` entry. The protected
`default`, `kube-system`, `kube-public` and `kube-node-lease` Namespaces must
remain present while carrying no stale Argo tracking or ConfigHub origin
metadata; `default` must also carry neither of the two reviewed legacy
`project-name`/`stage` labels. Older releases in an allowed stream and additive catalog/proof
packages are classified as retained history, not orphans; the audit never
deletes them. The passing evidence is written to
`runs/kubara-mini-idp-reconcile/orphan-audit.yaml`.

The same audit bulk-reads every Deployment, StatefulSet, DaemonSet, CronJob and
Job in every cluster. Each durable workload must be one of three things: an
exact desired key in one of those 35 Applications' current `status.resources`;
one of the 11 exact cluster-bootstrap workloads (`kindnet`, `kube-proxy`,
`coredns`, `local-path-provisioner`, or one of the seven reviewed Argo CD
v3.4.6 runtime workloads); or a controller-generated object whose direct
ownerReference is a current desired root and whose recorded owner UID matches
that live root's UID. The last case covers, for example,
Prometheus/Alertmanager-generated StatefulSets and Jobs generated by a desired
CronJob, while rejecting children left behind when a same-named controller is
recreated. A workload carrying `argocd.argoproj.io/tracking-id` whose exact key
is absent from every expected Application status is accepted only when the
tracking identity names that one UID-verified controller owner and its expected
Application; every other dangling tracking identity fails. The receipt records
every workload and requires both the unclassified and dangling-tracking
counters to be zero.

The canned reconciler is scoped to the `Kubara` organization at
`https://hub.confighub.com`, pins context/external organization ID
`58b23b85-9699-4384-bd57-80ef695a1d58` and internal organization entity ID
`12c33fa8-00b1-4011-ad3e-19d56458b29c`, and enforces the exact 55-Space
allowlist. It captures the selected context name and revalidates both IDs and
the server before every write. The generalized importer instead requires the
user's explicitly selected organization. It creates missing owned objects and converges changed owned objects,
but never deletes ConfigHub objects or persistent clusters. Clean-room safety
is strict: any Space outside that allowlist, or any unexpected Unit or Link
inside a managed Space, makes the run refuse rather than coexist, delete, or
recreate. Partial state within one cluster is always rejected; a mixed fleet is
resumable only when its complete clusters are the exact ordered prefix in the
durable bootstrap journal. Re-running the accepted state at the desired revision produces no
semantic changes. Apply refuses to start
unless all prior qualification,
promotion, publication, and faithful-lane gates pass. The first apply writes a
pending-idempotence receipt by atomic rename. All delivery Application Units
are materialized and identity-checked before the first fleet-root release;
workload releases then converge in Kubara dependency order. The hx-web
promotion, approval, rollback, and departure sequence is checkpointed in the
durable write-ahead operation journal, so a restart resumes completed steps
instead of replaying production history from a missing receipt. Each checkpoint
binds exact Unit heads and data hashes, approvals, releases, and UpgradeUnit
merge bases. Every ConfigHub mutation in that rollout is a nested write-ahead
transition with an exact pre-state and one reviewed post-state; a restart
accepts only the durable ordered transition prefix and fails closed on any
undeclared head, approval, release, provenance, or merge-base delta. The
retained proof observes each production gated head twice without issuing an
unsafe non-CAS negative publish, then binds approval to the exact Unit IDs,
observed numeric revisions, and data hashes. The actual approval command uses
the Unit slug and server `HeadRevisionNum`; authoritative before/after reads
must preserve Unit ID, observed head, and `DataHash`. This is bracketed
exact-head evidence, not a numeric approval-API compare-and-set claim.
ConfigHub's gate behavior is explained separately; this run does not claim a
directly observed refusal. The proof also
binds the one-target rollback to the exact initial-rollout revision plus its
source and result heads.
Cluster creation is a separate prerequisite boundary: `cub cluster up` rolls back a
returned failure, while an abrupt process or host termination inside that
multi-system command may leave one partial cluster. The reconciler never
deletes or guesses through that state; it refuses until cub-native or operator
recovery restores either a fully absent or fully complete cluster. Complete
cluster prefixes are resumed automatically from the bootstrap journal. The
cluster bootstrap journal remains active until each cluster's first delivery
root is published; immediately before that activation, every source Space for
the cluster must still have no published `:latest`. A state-changing apply plus
an immediate zero-action rerun proves convergence. When adopting an already
exact retained organization under a newly reviewed reconciler fingerprint, two
consecutive zero-action observations establish the retained baseline without
inventing a change. A restarted apply also compares
every Unit's head revision with its last applied revision, so an interrupted
run cannot mistake an older existing release for the current desired state.
An Application is accepted only when Argo reports the exact authoritative
ConfigHub `ManifestDigest`; `Synced` on an older revision is not success, and
`targetRevision: latest` is never accepted as deployment authority.
Each Application and OCI digest has one 90-minute overall convergence deadline
and at most four sync-submission reservations, persisted across process
restarts in the local operation journal. An existing
Argo operation is observed without replacement for an explicit 60-minute
deadline, retained across restarts from Argo's `startedAt`. An exact
revision that is already `Synced` but still becoming healthy is observed for a
separate 30-minute health deadline and is never resynced merely for being
`Progressing`. Only after an active operation has ended may a terminal failure,
`OutOfSync` state, or wrong revision cause a hard refresh and a new exact-digest
sync; no more than four new sync operations may be submitted. Every submission
repeats the authoritative release check and Kubernetes UID/resourceVersion
compare-and-set. This is part of the deterministic
retry path; it requires no console click, never takes over a running operation,
and never broadens the resource allowlist.

The result includes every selected platform role, lifecycle and target facts,
the platform contract, catalog-alignment evidence, matrix and wiring evidence,
and both apps on all four targets. ConfigHub-managed Argo CD already supplies
the adapted delivery role, so this lane does not also install the Kubara hub
Argo chart on the same targets. Large CRD Applications use
`ServerSideApply=true`; `Replace=true` is forbidden. Deployment Applications
retain Kubara's `prune`, `PruneLast`, shared-resource, and bounded retry
semantics, but only within the resources tracked by the exact 27-Application
allowlist and after ConfigHub release/production gates. Bootstrap Applications
remain non-pruning. External Secrets owns the Grafana admin Secret through the
dev fake-provider target fact. Every adapted
Argo Application also retains Kubara's generated destination namespace (the
service name unless Kubara declares an override), so namespace-less Helm
objects resolve exactly as they do under Kubara's ApplicationSet template.
One declared migration makes that namespace contract upgrade-safe: if Argo
proves at the exact expected OCI revision that the old `default` node-exporter
DaemonSet is tracked by the same Application and requires pruning, the desired
replacement already exists in `kube-prometheus-stack`, both ConfigHub origins
and tracking IDs match, and the two copies contend for reviewed TCP/9100, the
reconciler removes only that exact UID/resourceVersion of the obsolete
DaemonSet before the normal `PruneLast` wave. A durable write-ahead operation
journal prevents a crash or ambiguous API timeout from authorizing a second
UID; restart recovery promotes the original UID's observed absence into the
final receipt. This prevents a
health-before-prune deadlock while leaving Kubara's ordinary prune behavior
unchanged; the action and exact binding are retained in the reconciliation
receipt.

Sixteen additional one-time replacements handle immutable application
selectors in the retained fleet: the hx-web Deployment on four targets and
Cubbychat's backend Deployment, frontend Deployment, and PostgreSQL StatefulSet
on every target. Each exact allowlist entry progresses durably through
`prepared`, `delete-returned`, `old-uid-gone`, and `replacement-healthy`.
Deletion requires the reviewed legacy selector, exact Argo tracking and
ConfigHub origin, expected OCI revision, no active Argo operation, and old
UID/resourceVersion; completion requires a new UID, reviewed selector and pod
template, available replicas, and ready endpoints. The four PostgreSQL entries
also bind the same `Bound` PVC UID and volume name before and after StatefulSet
replacement. This is an exact migration policy, not general delete authority.

On kind, Traefik uses the explicitly reviewed NodePorts already reserved by
`cub cluster up`. Its configured `ingressEndpoint.hostname` populates Ingress
status, so Traefik, hx-web, and cubbychat must all reach `Synced/Healthy`; a
permanent `Progressing` health exception is not an accepted result.
Four exact `default`-Namespace ownership migrations retain each protected
Namespace UID and remove only the reviewed stale tracking/origin and
`project-name`/`stage` fields after the replacement Namespace is proven at the
expected revision. The operation journal and receipt distinguish a guarded
patch from an already-clean retained Namespace; deletion or recreation is
never authorized.

The accepted desired plan is explicit: 55 Spaces, 63 managed Units, 27
deployments, and 25 `NeedsProvides` Links. The two Argo definitions are both
present: `hx-argo-base` retains Kubara's chart/runtime evidence and
`hx-argo-runtime-base` describes ConfigHub's independently observed delivery
runtime. Exact governed payload membership is recorded in the current plan and
receipt rather than inferred from these counts. Plan and allowlist counts are
not a substitute for the live mini-IDP receipt.

The final state must show more than pods:

1. hx-web and cubbychat have definition and per-cluster instance Spaces.
2. Both apps use shared cert-manager and Traefik services on every target.
3. A base change promotes through development and staging to production.
4. Production Units expose the approval gate; the run observes stable exact
   heads, invokes approval at server `HeadRevisionNum`, and brackets it with
   unchanged Unit ID, observed numeric head, and `DataHash` before publication.
5. One production target can roll back without rolling back its peer.
6. A staging-only departure survives a later base promotion.
7. Catalog owner, component, exact version, deployable/configuration surface,
   variant, definition or instance, hub or spoke, delivery mode, and local-Argo
   roles are queryable in the ConfigHub GUI.
8. hx-web and cubbychat are each traceable from their definition through all
   four target instances and their desired Argo Applications.
9. Exactly 25 curated operational Wiring Links expose consumer-to-provider
   relationships in the GUI, while the full extracted graph remains linked
   deterministic evidence.
10. The desired matrix remains governed in ConfigHub; the public live-aware
    matrix gains observations only from the exact mini-IDP receipt.

On a clean, unmarked fleet the reconciler executes that operation sequence and
writes its scenario marker only after every check passes. Later runs reconcile
the same final state and verify retained history without manufacturing duplicate
promotions. The receipt distinguishes `executed` from
`retained-proven-history`. Do not claim this lane passed unless
`runs/kubara-mini-idp-reconcile/receipt.yaml` reports `pass` and receipt
verification succeeds.

### 10. Regenerate the matrix from the exact live receipt

```bash
npm run kubara-platform-matrix:generate
npm run kubara-platform-matrix:verify
```

Generation happens after the mini-IDP receipt so each component-by-cluster cell
can use exact observed evidence where it exists and remain `unknown` where it
does not. The generated JSON, CSV, Markdown, and colored HTML must agree.

### 11. Regenerate and verify every catalog and website release surface

```bash
npm run kubara-catalog-release:generate
npm run kubara-catalog-release:verify
```

This refreshes the catalog status, chart catalogs, root catalog, promotion
review, installer OCI index, npm command catalog, and public site from the
promoted, published, reconciled, and freshly generated matrix state.

### 12. Pass the umbrella release verifier

```bash
npm run kubara-release:verify
```

This is the only final release gate. It fails unless the static contract, both
live qualification sets, both additive promotions, exact OCI publications,
faithful lane, mini-IDP reconciliation and idempotence, live-aware matrix,
catalog-release surfaces, and public site all verify.

## What ConfigHub keeps, adapts, and deliberately does not replace

| Kubara concept | Kept unchanged | ConfigHub addition or explicit adaptation |
| --- | --- | --- |
| Catalogs | Built-in and external Kubara catalogs remain valid sources. | Exact component-first retention plus a Kubara compatibility profile can export a byte-identical external catalog. |
| `config.yaml` | Still selects clusters, stages, services, and service configuration. | Mirrored as a non-targeted contract Unit with provenance and revision history. |
| `platform-components/` | Still generated and valid in Git. | Reviewed component definitions and immutable release content. |
| `platform-configs/<cluster>/` | Still carries Kubara's per-cluster specialization. | Target variants, semantic diffs, promotion, rollback, and departure tracking. |
| `values-*.yaml` | Still the durable authoring mechanism for supported overrides. | Their effects are visible in Units and the matrix; no silent post-render owner is introduced. |
| Hub Argo CD and ApplicationSets | Preserved exactly in the faithful lane. | ConfigHub review and attestation around the Git revision. |
| Reconciliation | Argo CD remains the familiar reconciler. | Optional per-cluster Argo applies only the exact ConfigHub-authorized digest, making release and rollback state independently governable. |
| Git review | Remains the platform-authoring review in faithful mode. | ConfigHub adds object-aware checks, approvals, release evidence, and an optional required-status integration. |
| Secrets | External secret systems remain value owners. | ConfigHub stores references and prerequisites; the kind demo uses a clearly labeled fake provider. |
| Day-2 update | Update catalog/config/overrides and regenerate as Kubara documents. | Inspect semantic change, approve, promote, preserve target departures, and roll back an exact revision. |
| Exit path | Generated Git state and Argo topology remain intelligible without ConfigHub. | ConfigHub is an adoptable operating layer, not a mandatory rewrite boundary. |

## Evidence boundaries

- The current generation and catalog-source parity receipts are complete offline
  evidence. They prove deterministic desired state, not cluster health.
- The wiring graph includes rendered and controller-declared relationships.
  `resolved-runtime` means a controller contract exists; it does not claim the
  controller created the object in a live cluster. ConfigHub exposes 25 curated
  operational `NeedsProvides` Links, not every extracted graph edge.
- The ConfigHub `platform-matrix` Unit is desired-only governed evidence. The
  public 36-cell matrix is regenerated from that state and the exact live
  receipt. Each cell keeps desired placement, selected version, and departure
  separate from the exact ConfigHub release digest, Argo observed revision,
  sync/health, and Kubernetes desired/ready counts. It leaves current live
  fields `Unknown` unless the receipt supplies them, while disabled selections
  are explicitly `NotApplicable`.
- The
  [faithful-lane summary](../../../data/kubara-faithful-hub-spoke/summary.md)
  is current proof only when its generated-file count and digest match the
  current hand-off; the [checkpoint ledger](checkpoints.md) records that gate.
  GitHub required-status enforcement remains a named gap.
- The simplified lane is a deliberate delivery adaptation. It must never be
  described as Kubara's native Argo ownership model.
- The fake External Secrets provider, self-signed kind issuer, kind-only Metrics
  Server TLS setting, and Traefik NodePort exposure are test-target facts,
  not production recommendations.
- The v0.12.0
  [single-platform](../../../runs/kubara-single-platform-proof/receipt.yaml) and
  [app-rollout](../../../runs/kubara-app-rollout-proof/receipt.yaml) receipts
  remain useful historical live evidence. They do not establish current v0.13.0
  versions or faithful delivery.

For the detailed machine-generated views, start with
[Kubara wiring and platform evidence](platform-evidence.md). For the older
promotion narrative, see the [historical app rollout](app-rollout.md).
