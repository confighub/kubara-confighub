# Import one Kubara Git revision into ConfigHub

This is the reusable six-step adoption boundary for an existing Kubara user:

1. choose components and wiring in Kubara;
2. let Kubara generate the platform, add-ons, ApplicationSets, overrides, and
   per-cluster configuration;
3. prepare, scan, commit, push, and offline-verify the raw inputs plus their
   separate clean hand-off subtree at one exact Git revision;
4. verify that exact revision and publish immutable component/config OCI
   packages plus the platform index;
5. load them into a user-selected ConfigHub organization with the recognizable
   hub-and-spoke shape; and
6. deploy and promote applications through ConfigHub while Argo CD remains the
   cluster reconciler.

The importer is deterministic code, not an AI rewrite. Kubara remains the
composer. ConfigHub adds a component-first Catalog surface, immutable package
and release evidence, reviewable definitions and variants, visible wiring, and
promotion history.

## What the importer publishes

It does **not** flatten the platform into one giant OCI layer. It publishes:

- one target-neutral, immutable OCI package per reusable component definition;
- one target-neutral, immutable OCI package per effective component/config set;
- one target-neutral platform index referencing every exact manifest and layer
  digest plus the Kubara config, wiring ledger, content lock, runtime contract,
  and delivery-template contract; and
- a separate `destination-binding-lock.yaml` for organization, Space, Target,
  delivery-runtime, workload, and evidence identities. This file is explicitly
  excluded from OCI.

`PlatformDigest` identifies the portable Kubara result and materialization
contract. `BindingDigest` identifies its exact ConfigHub destination. Importing
the same Git revision under the same import name and catalog repository base
into two organizations preserves the platform digest, component/config member
payloads, and aggregate index while producing different binding digests. If the
import name or repository base changes, member content bytes and
`PlatformDigest` still remain stable, but the aggregate index's metadata or
member refs necessarily change. Secrets and target-local facts stay outside
Git and OCI.

## Before you begin

Install `git`, Node.js, the exact Kubara binary and Helm build named by your
reviewed preparation request/source lock, `cub` 0.2.11 or later, `oras`, a
pinned external secret scanner, and the tools you use to observe each cluster.
Authenticate `oras` to the package repository named by the portable request.
No ConfigHub organization is required for portable compile or publication.
Authenticate `cub` only when you are ready to select and bind the destination.
Hold exclusive single-writer control of that OCI repository base for the whole
`--package-portable` operation. ORAS publication uses inspect, push, and post-inspect;
without an external single-writer gate, a concurrent writer could race between
those operations.

Serialize each `--apply` against other writers to importer-managed Spaces,
Units, Links, target/bootstrap metadata, platform delivery Applications, and
request-pinned workload heads. `cub` reads and mutations are not a
cross-client conditional transaction; post-verification detects drift but
cannot prove another writer did not race between a read and write. Unrelated
application source Spaces not named by the request remain outside this lock.

The importer never creates or selects an organization implicitly. It also
never creates Targets or ConfigHub's cluster-local Argo bootstrap. After the
portable package is compiled and published, create or select the organization
explicitly, switch to its exact context, and provision each cluster with `cub
cluster up` or an equivalent controlled process. For a disposable four-cluster
proof that could be:

```sh
cub --context acme-kubara cluster up --name hx-app-dev \
  --space acme-target-dev
cub --context acme-kubara cluster up --name hx-app-staging \
  --space acme-target-staging
cub --context acme-kubara cluster up --name hx-app-prod-a \
  --space acme-target-prod-a
cub --context acme-kubara cluster up --name hx-app-prod-b \
  --space acme-target-prod-b
```

Do not rerun bootstrap commands against production blindly. The required
pre-existing shape is:

- one target Space and OCI Target for every Kubara cluster;
- one `<cluster>-argo-apps` Space containing `root` and the argobot
  Application;
- `argobot-base/argobot`; and
- one `argobot-<cluster>/argobot` instance with its `UpgradeUnit` lineage.

The selected organization may be newly created, but those bootstrap objects
must exist before inspection. Anything else that must remain outside importer
ownership is declared under `spec.externalInfrastructure`.

## 1. Generate and prepare the complete Kubara hand-off

Choose the platform in Kubara's `config.yaml`, then run the normal Kubara
generation path. The bridge does not replace or emulate that run. It consumes
Kubara's native `config.yaml`, generated `platform-components` and
`platform-configs`, documented overrides, a SHA-pinned source lock, and a
reviewed `KubaraComponentArtifactSet`.

Copy and review
[`current-platform.prepare.yaml`](./current-platform.prepare.yaml). Its paths
may point anywhere inside an existing dedicated Kubara checkout, including
`source.path: .`; only the named inputs are read. `output.path` must be a
separate, non-overlapping clean subtree. Pin every enabled service's release
name and namespace, the exact kube version/API capabilities, the full Helm Git
commit, the Kubara binary version/SHA, and every exact chart archive SHA. OCI
chart rows also require the exact OCI manifest digest. A missing, duplicate,
conflicting, or unreviewed component/version fails—there is no silent nearby
version or arbitrary Catalog auto-resolution.

After Kubara has generated its normal tree, run the only network/write phase:

```sh
node scripts/prepare-kubara-git-handoff.mjs --generate \
  --request /absolute/path/to/current-platform.prepare.yaml \
  --checkout /absolute/path/to/kubara-checkout \
  --kubara-bin /absolute/path/to/sha-pinned-kubara
```

The preparer fetches only reviewed exact artifacts, rejects pre-vendored opaque
chart archives, renders every enabled instance twice with the pinned profile,
extracts the in-tree provides/needs graph, applies a conservative structural
credential-shaped-material scan, and atomically replaces only `output.path`.
It re-inventories every input immediately before promotion, so a concurrent
source edit leaves the prior output untouched. It never runs Kubara, reads a
cluster, creates an organization, packages OCI, or claims that its built-in
scan replaces the required external scan.

The clean output contains source/config and reviewed overrides, generated
component/config trees, exact source/artifact locks, effective renders, an
importer-compatible generation receipt, wiring graph, preparation receipt, and
checksums. It excludes `apps/**`, `target-facts/**`, `.env`, and material caught
by the structural scanner. Application sources remain a later, separate
ConfigHub workflow.

This repository's reproducible example writes that complete boundary to
`examples/kubara/prepared-current-platform`; its committed preparation receipt
and checksums cover all 167 files. The preparer also refuses `.env.*` and
singular `target-facts.yaml`, `target-facts.yml`, and `target-facts.json` files.

Commit and push together to the HTTPS remote named by the import request:

- `config.yaml` and documented overrides;
- Kubara's generated platform components, add-ons, ApplicationSets, and cluster
  config;
- the reviewed preparation request and exact chart/dependency/source locks; and
- the complete prepared output subtree.

In a clean checkout of that final commit, verify offline with zero repository
writes and no network access:

```sh
node scripts/prepare-kubara-git-handoff.mjs --verify \
  --request /absolute/path/to/current-platform.prepare.yaml \
  --checkout /absolute/path/to/clean-checkout
```

Pass `--kubara-bin` as an optional stronger re-observation of the exact binary.
Without it, verification still checks the committed SHA/version claim copied
from the source lock, the exact Helm build, all inventories, renders, wiring,
receipts, checksums, and the zero-write boundary. The repository gate exercises
the concrete four-cluster subtree with `npm run
kubara-git-handoff:verify-current`; `npm run kubara-git-handoff:self-test`
also proves two-root byte neutrality, atomic interruption, adversarial
refusals, and preparer-to-importer compile/verify.

The subsequent import request names an HTTPS repository ending in `.git`, one full 40- or
64-character lowercase commit object ID, and one selected path. Use a detached,
clean checkout at that exact object. A branch, tag, dirty file, untracked file,
symlink, source-origin mismatch, or byte change during compilation is refused.

Keep application source trees, target facts, credentials, private keys, and
secret values outside the selected platform path. The importer inventories the
complete selected path, applies a conservative credential-shaped-material
check, and requires a separately produced external scan attestation. Neither
check is a general proof that arbitrary bytes contain no secret; review opaque
files and scanner scope explicitly.

## 2. Scan the exact commit and scope

Run the approved scanner/version against the selected directory in the exact
detached checkout. For example, after independently installing and verifying
Gitleaks 8.24.3:

```sh
gitleaks dir /absolute/path/to/clean-checkout/platform \
  --report-format json \
  --report-path /controlled/evidence/gitleaks-report.json
```

Require the scanner to exit successfully, retain its report outside the Git
tree, set `scanner: gitleaks@8.24.3`, and set
`opaqueFilesReviewed: true` only after that review is complete. The destination
inspector hashes the report bytes and binds the exact source commit and scope;
it never embeds the report contents in the reviewed request.

## 3. Compile and publish the portable package set

Copy and review
[`portable-request.example.yaml`](./portable-request.example.yaml). It contains
only the immutable Git source, selected layout, exact external scan
attestation, and the OCI package repository base. It contains no ConfigHub
organization, context, Space, Target, runtime observation, target fact, or
secret.

Compile and reproduce the target-neutral payload set outside the checkout:

```sh
node scripts/import-kubara-git-revision.mjs --compile-portable \
  --request /controlled/import/portable-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/portable

node scripts/import-kubara-git-revision.mjs --verify-portable \
  --request /controlled/import/portable-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/portable
```

The output contains `platform-lock.yaml`, `portable-package-set.json`, one
local payload per component definition and effective configuration set, and
`portable-checksums.txt`. It deliberately refuses a
`destination-binding-lock.yaml` or target-fact file in this directory.

With exclusive single-writer control of the package repository, publish those
same bytes:

```sh
node scripts/import-kubara-git-revision.mjs --package-portable \
  --request /controlled/import/portable-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/portable
```

`oci-publication-receipt.json` pins every observed manifest and layer digest.
An existing exact payload is reused; a conflicting content-addressed reference
is refused. At this checkpoint the user can take the Git revision and portable
OCI set to any later selected organization. No ConfigHub or cluster mutation
has occurred.

## 4. Select/bootstrap the organization and record each runtime

Kubara's generated Argo CD component and ConfigHub's existing delivery runtime
are distinct identities:

- `hx-argo-base` is the **Faithful** Kubara definition. In the current example,
  wrapper chart 10.2.1 renders Argo CD v3.4.5.
- `hx-argo-runtime-base` is the **Adapted** ConfigHub delivery-runtime
  definition. Its exact version and image come from external observation of
  each already running target; the current example observes v3.4.6.

For every target, create a secret-free observation outside the imported Git
path. Example:

```yaml
apiVersion: import.confighub.com/v1alpha1
kind: KubaraArgoRuntimeObservation
metadata:
  name: hx-app-dev-argocd-runtime
spec:
  cluster: hx-app-dev
  componentVersion: v3.4.6
  image: quay.io/argoproj/argocd:v3.4.6
  evidenceRef: evidence://change/CR-1234/hx-app-dev/argocd-runtime
status:
  result: pass
```

Derive those facts with your approved `kubectl`, provider, or inventory
workflow. The importer validates and hashes the observation file; it does not
connect to the cluster or infer a runtime version from a chart.

## 5. Inspect the selected ConfigHub destination

Copy [request.example.yaml](./request.example.yaml), replace the Git source,
layout, scanner version, desired organization/context and stable entity slugs,
then run one read-only inspection:

```sh
node scripts/import-kubara-git-revision.mjs --inspect-destination \
  --request /absolute/path/to/request-template.yaml \
  --context acme-kubara \
  --credential-scan-report /controlled/evidence/gitleaks-report.json \
  --runtime-evidence hx-app-dev=/controlled/evidence/dev-runtime.yaml \
  --runtime-evidence hx-app-staging=/controlled/evidence/staging-runtime.yaml \
  --runtime-evidence hx-app-prod-a=/controlled/evidence/prod-a-runtime.yaml \
  --runtime-evidence hx-app-prod-b=/controlled/evidence/prod-b-runtime.yaml \
  --output /controlled/import/acme-reviewed-request.yaml
```

The inspector requires exactly one runtime observation per request target. It
uses narrow `cub ... list --where ... --select ... -o json` queries and
`cub unit data` only for the exact named bootstrap/workload Units. It records
IDs, ConfigHub `DataHash` values, raw Unit-byte SHA-256 hashes, argobot source
identity, published workload release pins, and the explicit organization
coordinate. It does not put Unit data, scanner-report content, runtime-evidence
content, tokens, or secret values in its output.

Review the resulting request before continuing. This is the user-visible
authorization boundary: wrong organization, context, server, Space, Target,
Unit, delivery root, argobot lineage, workload pin, or unexpected infrastructure
is a refusal rather than a guessed repair.

## 6. Bind the portable content without recompiling it for the organization

Keep the destination-bound output separate from the portable directory:

```sh
node scripts/import-kubara-git-revision.mjs --bind \
  --request /controlled/import/acme-reviewed-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --portable /controlled/import/portable \
  --output /controlled/import/bound

node scripts/import-kubara-git-revision.mjs --verify \
  --request /controlled/import/acme-reviewed-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/bound
```

Binding recompiles the target-neutral content from the exact Git revision and
requires byte-for-byte equality with the already compiled portable package
set. It then writes the destination-specific files and, when publication has
already passed, copies the exact local package payloads and receipt into the
separate bound directory. It never republishes OCI.

`--plan` prints the destination plan without writing it. Bind writes:

- `platform-lock.yaml` — target-neutral source/content/materialization lock and
  `PlatformDigest`;
- `destination-binding-lock.yaml` — target-specific binding and
  `BindingDigest`, marked `includedInOCI: false`;
- `import-plan.json` — ordered Spaces, Units, packages, delivery Applications,
  `UpgradeUnit` lineage, and curated `NeedsProvides` Links;
- `target-facts-required.yaml` — a pending operator-attestation template;
- `acceptance.json` — implemented claims and explicit boundaries; and
- `checksums.txt` — exact hashes of the five semantic outputs.
- `portable-binding-receipt.json` — the portable package-set hash, separate
  `BindingDigest`, and copied-publication status without a live apply claim.

Verification regenerates all six from the same Git bytes and request and
requires byte-for-byte equality.

## 7. Complete the target-fact attestation

Copy `target-facts-required.yaml` to controlled storage outside Git and OCI.
For each binding set `status: verified-present`. For every required resolution,
set `status: satisfied` or `not-applicable-reviewed` and add an external,
secret-free `evidenceRef` plus the exact `sha256:` digest of that evidence.
Finally set:

```yaml
policy:
  secretValuesIncluded: false
  generatedTemplateIsAnAttestation: true
```

The generated file is only a template until an operator makes those changes.
Apply refuses pending facts, another organization/binding digest, missing
evidence hashes, or an attestation containing secret values.

## 8. Apply twice and require the zero-action proof

```sh
node scripts/import-kubara-git-revision.mjs --apply \
  --request /controlled/import/acme-reviewed-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/bound \
  --context acme-kubara \
  --target-facts /controlled/evidence/target-facts-attested.yaml

# Required acceptance run: identical inputs, immediately again.
node scripts/import-kubara-git-revision.mjs --apply \
  --request /controlled/import/acme-reviewed-request.yaml \
  --checkout /absolute/path/to/clean-checkout \
  --output /controlled/import/bound \
  --context acme-kubara \
  --target-facts /controlled/evidence/target-facts-attested.yaml
```

While holding that apply lock, the order is deterministic: pin bootstrap and
target facts; publish any argobot source releases; create definitions and
control Units; create variants and instances; create exact Links; publish each
component source Space; replace transient auto-created delivery Applications
with the exact source-release `ManifestDigest` and no `automated` field; then
publish each apps root. A bounded interruption can be resumed from the same
exact inputs. The second run must produce:

```text
status.result: pass
status.lastActionCount: 0
status.secondRunZeroActions: true
status.localReceiptCryptographicProof: false
```

The local receipt is an exact deterministic continuity record, not a
server-signed or cryptographically tamper-proof attestation. A changed input or
live drift is rechecked/refused; any actual mutation resets the two-run proof.
The importer issues no delete operation. Importer-managed platform Applications
do not enable automated sync and do not authorize mutable `latest`. The
subsequent explicit reconciler submits the exact release digest; its reviewed
sync contract may prune objects removed from that exact release.

## 9. Verify Argo and cluster convergence separately

The canonical `apply-receipt.json` records the current exact ConfigHub and OCI
state. In the selected-organization workflow, the first and immediate no-op
runs are also preserved separately as immutable
`evidence/apply-first-receipt.json` and
`evidence/apply-immediate-noop-receipt.json`; no two steps may share an evidence
path. These receipts deliberately
sets `clusterConvergenceClaim: false`. For each cluster, independently retain
observations showing every platform Application is `Synced`, `Healthy`, and has
completed successfully at the exact source-release manifest digest recorded in
the receipt. A ConfigHub release is not itself proof of cluster health.

## 10. Compile and run the reusable application release path

After the platform converges, teams create or reuse application definition
Units, target variants, promotion/approval policy, and releases. Start from
[`app-release.example.yaml`](./app-release.example.yaml). Every target pins its
source Unit ID, numeric head revision, data hash, release bundle digest, and
release manifest digest. The policy rejects mutable tags, automated sync,
ApplicationSets, and target facts in application source.

Compile and reproduce the app hand-off:

```sh
node scripts/compile-kubara-app-release.mjs --compile \
  --request /controlled/import/payments-release.yaml \
  --output /controlled/import/payments-release

node scripts/compile-kubara-app-release.mjs --verify \
  --request /controlled/import/payments-release.yaml \
  --output /controlled/import/payments-release

node scripts/run-kubara-app-release.mjs --execute \
  --request /controlled/import/payments-release.yaml \
  --output /controlled/import/payments-release \
  --acceptance-evidence /controlled/evidence/payments-live.json

node scripts/run-kubara-app-release.mjs --verify-acceptance \
  --request /controlled/import/payments-release.yaml \
  --output /controlled/import/payments-release \
  --acceptance-evidence /controlled/evidence/payments-live.json
```

The compiler produces exact-digest, no-auto Argo Applications, the explicit
promotion/departure/rollback plan, and a durable per-target operation journal.
It performs no live action. The runner rechecks the request-bound ConfigHub
Organization, server, context, and Space-release OCI origin before every
ConfigHub write; publishes the exact source release; materializes the
digest-bound delivery Unit; and publishes the apps root. It then removes live
root automation, pins that root to the exact apps-root `ManifestDigest`, and
submits both root and workload sync operations with Kubernetes UID and
`resourceVersion` JSON-Patch compare-and-set. Each phase has immutable attempt
evidence and can be resumed from its completed prefix. Acceptance is written
only after the root and workload Applications report their exact revisions,
`Synced`, and `Healthy`, followed immediately by a zero-action audit. A
ConfigHub release or generated YAML alone is not a live app claim.

Before any live action, the runner independently derives the canonical plan
and delivery Application bytes from the exact request and refuses a consistent
edit to the stored plan, document hash, or document. Each application source
Space must contain exactly the one request-bound deployable Unit. This is the
generic runner's complete source-inventory authority; use separate one-Unit
source Spaces, or wait for a future request format that binds a complete
multi-Unit source inventory.

The runner's `.application-release-execution.lock` serializes only processes
sharing this output directory on one host/filesystem. It is not a ConfigHub
Organization, Space, or distributed lock. Hold one external writer/lease for
all request-bound source/apps Spaces and cluster Applications across hosts and
output directories. ConfigHub approval and release publication are not an
atomic transaction with the preceding reads. ConfigHub v0.2.11 rejects a
literal numeric approval revision, so production approval uses the proven
server-current-head selector `--revision HeadRevisionNum`, fenced by immediate
reads of the same Unit ID, observed numeric head, `DataHash`, and approval gate.
The gate must clear and the approval count must advance exactly once. That
client-side bracket detects a race after the side effect; it is not a server
numeric-head CAS and therefore still requires serialized ownership with no
competing writer.

Every application request must name its destination explicitly, including
`destination.spaceReleaseOCIBase`, and each target must bind its exact Target
ID, Kubernetes context, kube-system Namespace UID, Argo namespace, and root Application. The compiler and
runner never infer the OCI origin from `serverURL`, and no production registry
origin is hard-coded. The supported generic health contract is
`argo-synced-and-healthy-exact-source-manifest`; richer application-specific
checks remain additional evidence rather than being silently claimed by this
runner.

If workload Applications already exist in a target apps-root Space, preserve
them explicitly. Add each known Application and its source Space/Unit to
`delivery.workloadApplications` in the request template, then rerun
`--inspect-destination`. Inspection fills its exact Unit ID, `DataHash`, raw
byte hash, published head revision, source IDs, and source release manifest
digest. Recompile and apply twice. Adding these destination pins changes only
`BindingDigest`; it does not change `PlatformDigest` or the target-neutral OCI
payloads. A pending workload head or later silent change is refused. A
request-pinned legacy workload Application that still names `latest` is
preserved byte-for-byte during platform adoption; it is explicitly outside
importer-managed delivery authority. Move it through the application release
contract as a later reviewed change to gain exact-digest/no-auto authority
without blocking platform import or silently rewriting application ownership.

## 11. Use the selected-organization command contract and move forward

[`selected-org-workflow.example.yaml`](./selected-org-workflow.example.yaml)
joins the portable, bootstrap, inspection, binding, two-run apply, application,
and final acceptance boundaries without hiding them in shell. Compile it with:

```sh
node scripts/compile-kubara-selected-org-workflow.mjs --compile \
  --request /controlled/import/selected-org-workflow.yaml \
  --output /controlled/import/workflow
```

`workflow-plan.json` stores shell-free executable/argv arrays.
`operation-journal.json` starts every step pending, distinguishes read-only,
OCI, ConfigHub, cluster, and multi-system effects, and records a replay rule for
each. In particular, an interrupted `cub cluster up` is **in flight** and must
be inspected before any replay. Recompilation refuses to overwrite an advanced
journal. Validate either the pristine compiler output with `--verify` or an
advanced exact completed prefix with:

```sh
node scripts/compile-kubara-selected-org-workflow.mjs --verify-journal \
  --request /controlled/import/selected-org-workflow.yaml \
  --output /controlled/import/workflow
```

The journal verifier refuses reordered steps, changed commands, more than one
prepared action, non-prefix completion, or a completion without an exact
evidence digest. The selected-organization compiler is a command and recovery
contract, not a hidden overall live runner; organization and cluster creation
remain explicit user-authorized actions. Its application live-release step is
no longer a placeholder: it invokes the resumable application runner above and
binds that runner's exact acceptance evidence.

The terminal evidence must prove exact live digests, accepted health, the
immediate zero-action rerun, exact ConfigHub inventory, zero Argo-prunable
resources, zero unclassified or dangling objects among the five durable
workload types, and UID-current ownership in protected Namespaces. This is a
declared ConfigHub/Argo/workload residue scope, not a whole-cluster inventory or
an “entire cluster is orphan-free” claim. Until that evidence exists, neither
the journal nor the offline compilers claim a completed import.

For a later Kubara Git revision, use an explicit additive transition:

A platform-content change is an explicit, additive transition:

1. Preserve the prior passing `apply-receipt.json` as an immutable, separate
   file. Never overwrite it in the next output directory.
2. Generate and commit the next complete Kubara result, rescan its exact commit
   and path, refresh runtime evidence if it changed, and rerun destination
   inspection.
3. Compile once **without** `spec.transition` into a disposable draft directory
   to review the new `PlatformDigest` and `BindingDigest`.
4. Add `spec.transition` to the reviewed request using the prior receipt's
   platform/binding digests and the SHA-256 of its exact bytes:

   ```yaml
   transition:
     fromPlatformDigest: sha256:<prior-platform-digest>
     fromBindingDigest: sha256:<prior-binding-digest>
     previousApplyReceiptSHA256: sha256:<exact-prior-receipt-bytes>
     policy: additive-confighub-topology-importer-no-delete-argo-prune-disclosed
   ```

5. Compile and package into a new, empty final output directory. Transition
   authority is recorded but excluded from both content and binding digests.
6. Apply twice, passing the preserved receipt each time:

   ```sh
   node scripts/import-kubara-git-revision.mjs --apply \
     --request /controlled/import/revision-2-request.yaml \
     --checkout /absolute/path/to/revision-2-checkout \
     --output /controlled/import/revision-2 \
     --context acme-kubara \
     --target-facts /controlled/evidence/revision-2-target-facts.yaml \
     --previous-apply-receipt /controlled/receipts/revision-1-apply-receipt.json
   ```

The transition accepts an exact prior state, an exact current state, or the
bounded mixed state produced by an interrupted authorized run. It cannot remove
or rename a previously managed Space, Unit, Link, delivery Application, or
preserved workload pin; rebind a Target or upstream lineage; or rewire a Link.
Decommissioning is a separate, explicitly authorized workflow.

Contract v1.2 adds the explicit destination-bound Space-release OCI base and
retains the v1.1 ability to accept an exact passing v1.0 apply receipt as
transition authority. That additive transition normalizes previously generated mutable
`latest`/automated platform Applications to exact ManifestDigest/no-auto
authority; adopters do not have to delete and recreate their topology.

## What a Kubara user still recognizes

The source is still Kubara's `config.yaml`; Kubara still selects and specializes
its platform catalog; generated folders, wrapper versions, overrides,
ApplicationSets, hub/spoke placement, and local Argo reconciliation retain
their meaning. ConfigHub takes the hub governance role while each cluster keeps
a small local reconciler. The Kubara docs remain useful.

The visible improvement is additive: Components is component-first and retains
every catalog version; selected deployable/config variants follow from those
components; definition and instance Spaces make the hub/spoke shape queryable;
`NeedsProvides` Links expose operational wiring; immutable OCI and release
receipts make exact content reviewable; and app promotion no longer requires
rewriting Kubara's composition model.

Run the complete offline adoption-contract suite with:

```sh
npm run kubara-adoption:self-test
```

The suite creates isolated fake Git, OCI, and ConfigHub surfaces. It proves
source-only portable compilation before organization selection, target-neutral
cross-organization packaging, remote-layer reuse/refusal, separate destination
binding, destination inspection without content disclosure, bootstrap pinning,
source-before-exact-digest-apps-root release order, workload preservation,
exact-digest/no-auto delivery, resumable additive transitions, the
selected-organization journal contract, the reusable application release
contract, a zero-action second run, and adversarial refusals. It does not
contact a live ConfigHub organization, registry, or cluster. A fresh selected
organization still needs the real serialized workflow and retained live
acceptance evidence before this path can be called live-proven.
