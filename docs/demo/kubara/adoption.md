# Adopt an existing Kubara platform with ConfigHub

This tutorial follows one continuous path from an ordinary Kubara selection to
applications deployed through ConfigHub and Argo CD. It preserves the six
adoption steps exactly; implementation details appear as checkpoints within
those steps.

Start with [why a Kubara user would add ConfigHub](index.md), consult the
[checkpoint ledger](checkpoints.md) while reproducing the journey, and use the
[complete mini-IDP reference](single-platform.md) when you need every command
and safety condition.

| Step | User action | Detailed chapter |
| --- | --- | --- |
| 1 | Choose platform components and wiring | [Choose in Kubara](adoption-1-choose.md) |
| 2 | Run Kubara to generate platform, add-ons, and wiring | [Generate the platform](adoption-2-generate.md) |
| 3 | Push the complete portable hand-off to Git | [Prepare, scan, commit, and push](adoption-3-git.md) |
| 4 | Import the exact Git revision and create OCI | [Verify and publish immutable packages](adoption-4-oci.md) |
| 5 | Load the selected ConfigHub organization | [Materialize, rerun, and audit](adoption-5-confighub-org.md) |
| 6 | Deploy applications | [Promote through ConfigHub; reconcile with Argo](adoption-6-apps.md) |

## Before you begin

You need:

- an existing Kubara repository or the committed current example;
- the exact Kubara and Helm versions named by its source lock;
- a clean Git commit pushed to the reviewed HTTPS remote;
- credentials for the OCI repository used by the importer; and, for Step 5,
- an explicitly selected ConfigHub organization, credentials for its exact
  context, and one ConfigHub Target plus cluster-local Argo delivery runtime
  for each target cluster.

The current importer does not create or guess an organization, Target, or
cluster-local delivery runtime. These prerequisites are deliberate security
and ownership boundaries, not hidden work performed by AI. Steps 1–4 can be
completed before an organization is chosen: the portable request contains no
ConfigHub destination identity, and its package set is published first.

## Step 1: [Choose components and wiring in Kubara](adoption-1-choose.md)

Work in Kubara's normal inputs:

- `config.yaml` chooses the platform components and per-cluster placement;
- the effective ordered catalogs resolve those choices;
- ordinary `values-*.yaml` files specialize components; and
- Kubara's service definitions express the familiar platform wiring.

For the reproducible example, inspect
[`source/config.yaml`](../../../examples/kubara/current-platform/source/config.yaml)
and its adjacent reviewed overlays. It describes one hub, three spokes, seven
platform roles, and the placement used by hx-web and Cubbychat.

Keep three catalog layers distinct: ConfigHub presents the reusable component
and all retained versions first; a byte-preserving Kubara compatibility
profile retains Kubara's service definitions, wrappers, defaults, additions,
and templates; and each Kubara platform keeps its own `config.yaml` selection,
specialization, and wiring package. The compatibility profile connects the
catalog worlds without flattening the per-platform package into the ConfigHub
component catalog.

**Checkpoint 1 — recognizable input:** a Kubara operator can review the source
without learning a replacement schema. ConfigHub has not transformed or
rewritten it.

## Step 2: [Run Kubara](adoption-2-generate.md)

Run Kubara's ordinary generation path. Kubara, not ConfigHub, creates the
platform components, add-ons, ApplicationSets, AppProjects, overrides, and
cluster configuration.

The current example checks two catalog lanes:

1. the immutable snapshot of Kubara's official catalog release; and
2. the ConfigHub-aligned export of the same catalogs.

Both lanes must produce the same path set and the same bytes. Verify the
committed example with:

```sh
npm run kubara-current-example:verify
```

**Checkpoint 2 — no semantic migration:** Kubara v0.13.0 produces 135
byte-identical generated files from both catalog lanes and 13 deterministic
effective renders across four clusters.

Evidence:

- [catalog parity receipt](../../../examples/kubara/current-platform/catalog-parity-receipt.yaml)
- [generation receipt](../../../examples/kubara/current-platform/generation-receipt.yaml)

## Step 3: [Commit and push the complete hand-off to Git](adoption-3-git.md)

Git remains the portable Kubara hand-off. Commit and push:

- Kubara's source configuration and documented overlays;
- its generated platform, add-on, ApplicationSet, and cluster trees;
- exact source, binary, chart, image, and dependency locks;
- deterministic renders and the provides/needs wiring ledger; and
- checksums plus the external secret-scan attestation required by the import
  request.

Keep application source trees, credentials, private keys, secret values, and
target-local facts outside the portable platform path.

The deterministic preparer creates a separate clean subtree without modifying
Kubara's ordinary output. Verify the committed example offline with:

```sh
npm run kubara-git-handoff:verify-current
```

**Checkpoint 3 — exact portable source:** the importer receives one clean,
pushed Git object ID and one fully inventoried path. Dirty files, untracked
files, mutable revisions, symlinks, missing locks, source changes during
compilation, and credential-shaped material are refused.

## Step 4: [Import the exact Git revision and publish OCI](adoption-4-oci.md)

The ConfigHub Kubara importer reads the exact detached Git revision, verifies
the prepared hand-off, resolves every component against the component-first
Catalog, and builds:

- one immutable target-neutral OCI package per reusable component definition;
- one immutable target-neutral OCI package per effective component/config set;
- one platform index that references every exact manifest and layer digest;
  and
- one target-neutral `PlatformDigest` and portable checksum set that contain
  no ConfigHub organization or target identity.

It deliberately does not flatten the platform into one giant OCI artifact.
Secrets and target facts remain outside both Git and portable OCI.

The executable sequence is `--compile-portable`, `--verify-portable`, then
`--package-portable`. Only Step 5 selects and inspects the organization and
runs `--bind`, which produces the separate destination lock and
`BindingDigest` without republishing or changing the portable payloads.

Exercise the complete isolated importer contract with:

```sh
npm run kubara-git-import:self-test
```

**Checkpoint 4 — deterministic immutable delivery:** the current self-test
produces 22 component/config packages plus a digest index, verifies pulled
payloads, creates pinned delivery topology, declares 12 platform Argo
Applications and four root releases, produces zero actions on the second run,
and passes its adversarial refusal cases.

The self-test proves the importer contract without claiming that a fresh live
organization has already completed the same path. The exact live destination
is the next checkpoint.

## Step 5: [Load the platform into the selected ConfigHub organization](adoption-5-confighub-org.md)

The user explicitly selects the ConfigHub organization and confirms its exact
identity. Each Kubara cluster has a pre-existing ConfigHub Target and local
Argo delivery runtime. The read-only inspector pins those identities and
runtime observations; `--bind` proves that the published target-neutral bytes
still match and creates the destination-specific plan and target-fact
template. The operator completes that secret-free attestation, then the
importer materializes the platform as:

- reusable component definitions and exact versions;
- effective component/config instances for their selected targets;
- faithful and adapted delivery definitions kept visibly separate;
- cluster and environment Spaces;
- platform, lifecycle, and application Units;
- curated `NeedsProvides` Links; and
- exact source, release, approval, and OCI digest metadata.

The recognizable shape is preserved:

```text
Kubara source and catalogs
          |
          v
exact Git revision -> immutable OCI members + platform index
          |
          v
ConfigHub governance plane
          |
          +--> local Argo reconciler -> development
          +--> local Argo reconciler -> staging
          +--> local Argo reconciler -> production A
          +--> local Argo reconciler -> production B
```

In the adapted lane, `targetRevision: latest` is discovery-only and every
managed Application omits `spec.syncPolicy.automated`. Pinned argobot v0.1.6
hard-refreshes in Kubernetes mode but cannot deploy. ConfigHub revalidates the
authoritative release before the reconciler submits the exact
`operation.sync.revision=<ManifestDigest>` with Kubernetes UID/resourceVersion
compare-and-set and no active Argo operation.

Apply is serialized. Run it a second time immediately: the second accepted run
must report zero semantic changes. Then run the exact inventory and orphan
audit before treating the organization as a clean example.

The optional selected-organization workflow compiler turns this entire path
into an ordered, shell-free command plan and durable replay journal. It never
executes organization selection, `cub cluster up`, import, application
delivery, or acceptance implicitly.

**Checkpoint 5 — governed and repeatable organization:** the retained
four-cluster `Kubara` organization has a passing current mini-IDP receipt. It
proves materialization, ConfigHub release heads, exact Argo revisions, workload
health, all 16 journaled immutable-selector replacements, preservation of the
four bound PostgreSQL PVC identities, operation-journal completion, and a
zero-action second run. The separate orphan receipt must prove no unexpected
ConfigHub objects, dangling Links, Argo pruning residue, unclassified durable
workloads, or stale ownership metadata before the organization is called
clean.

This is not yet a fresh-organization acceptance test. A real adopter must
retain a separate passing pair for the exact organization they selected; the
current deterministic importer self-test and the retained `Kubara`
organization cannot be combined into that missing proof. See the
[checkpoint ledger](checkpoints.md).

## Step 6: [Add, promote, and deploy applications](adoption-6-apps.md)

Applications remain separate from the portable platform import. Add an
application source, bind it to the services the platform provides, and promote
reviewed revisions through ConfigHub. Publication alone does not deploy mutable
`latest`: the ConfigHub reconciler authorizes one exact digest, and the local
Argo CD instance reconciles that digest on its target.

The mini-IDP uses:

- **hx-web**, a small NGINX application that consumes shared certificate and
  ingress services; and
- **Cubbychat**, a multi-workload application with three digest-pinned images.

The demonstration sequence is:

1. deploy the initial release to development;
2. promote the exact revision to staging;
3. require production approval at server `HeadRevisionNum`, bracketed by the
   unchanged Unit ID, observed numeric head, and `DataHash`;
4. promote to both production targets;
5. create one reviewed target departure;
6. roll back one production target to its exact earlier revision; and
7. show the retained source, approval, release, departure, rollback, and Argo
   histories together.

**Checkpoint 6 — better day-two operation:** every selected Application must
report the exact current ConfigHub release digest, `Synced`, and the health
required by its reviewed contract. The live matrix, native Links, and GUI tour
are regenerated only from that accepted receipt.

## Six adoption frames, only after evidence passes

Each chapter contains one publication hook for one real frame, in the same
six-step order: native config, generation parity, exact Git revision, OCI
packages/index, selected-organization topology, and application governance
with a live result. These six tutorial frames are separate from the six-frame
ConfigHub GUI tour.

The offline tutorial intentionally contains no images or screenshot receipt.
The full current-live verifier requires the complete six-frame set and the
then-created `data/kubara-adoption-screenshots/receipt.yaml`.
That receipt must bind every image to one exact source commit, its repository
and selected-path Git trees, the relevant machine receipts and generated-data
hashes, the image SHA-256, UTC capture time, visible identities,
sensitive-value handling, caption, and claim boundary. Partial, mocked,
cross-revision, or receipt-free sets are refused. The contract is published at
[`data/kubara-adoption-screenshots/contract.yaml`](../../../data/kubara-adoption-screenshots/contract.yaml).

Before opening the browser, run the machine-only pre-capture gate from the
[GUI tour](gui-tour.md#pre-capture-gate). It verifies faithful and adapted
receipts, the zero-action run, the disclosed 32-read/208-subprocess/~102-second
no-op measurement, orphan evidence, and current matrix/wiring inputs without
requiring screenshots that do not exist yet. That measurement meets the fixture
regression target but is not an HTTP-round-trip count, a raw-Kubara comparison,
or an SLO. Capture all six real frames only after that gate passes; create the
receipt; then run the final website gate.

## What the user has at the end

- the original recognizable Kubara source and generated tree in Git;
- immutable component/config OCI members plus a digest-bound platform index;
- a component-first Catalog that retains old and new versions;
- a governed platform topology in the organization they selected;
- local Argo reconciliation on every cluster;
- visible component placement and wiring;
- approval, promotion, rollback, departure, and release history; and
- applications deployed on the platform without turning AI into a required
  migration tool.

Next: begin with [Step 1 — choose components and wiring](adoption-1-choose.md),
inspect every [evidence checkpoint](checkpoints.md), then follow the
[GUI tour](gui-tour.md).
