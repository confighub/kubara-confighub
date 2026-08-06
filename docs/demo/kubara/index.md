# Kubara with ConfigHub

**ConfigHub simplifies Kubara without making it fundamentally different.**

Kubara users keep choosing components and wiring in Kubara, generating the
familiar platform tree, committing it to Git, and using Argo CD to reconcile
clusters. ConfigHub adds a component-first Catalog, immutable releases,
review and promotion history, a fleet-wide platform view, and visible wiring.

The shortest description is:

> **Kubara composes. ConfigHub governs. Argo CD reconciles.**

This is an adoption path, not an AI-led rewrite. Catalog references and
configuration may need ordinary reviewed updates, but the Kubara model and
generated artifacts remain recognizable and portable.

## Choose your path

| If you want to... | Start here |
| --- | --- |
| Decide whether ConfigHub makes Kubara better for your team | Continue on this page. |
| Adopt it from an existing Kubara repository | Follow the [six-step adoption tutorial](adoption.md). |
| See exactly what has been proved | Open the [evidence checkpoints](checkpoints.md). |
| Walk through the result in ConfigHub | Use the [GUI tour](gui-tour.md). |
| Reproduce every implementation and release gate | Use the [complete technical reference](single-platform.md). |
| Understand the importer contract in full | Read [Import one Kubara Git revision into ConfigHub](../../../examples/kubara/git-import/README.md). |

## What stays, what becomes better, and how to verify it

| Kubara stays | ConfigHub adds | Proof to show |
| --- | --- | --- |
| `config.yaml`, ordered catalogs, values overlays, service definitions, and generated files | A component-first Catalog that retains reusable components and older versions independently of one platform selection | The current Catalog retains 103 components and 130 versions, including all 18 exact Kubara selections, under additive-only retention. |
| Kubara's platform package and per-platform selection and wiring | Governed definitions, effective configurations, target instances, and explicit relationships without flattening the platform into one object | The official and ConfigHub-aligned catalog lanes generate the same 135 files, path-and-byte-for-byte. |
| Git as the portable platform hand-off | Exact-source verification and immutable per-component/config OCI packages plus a digest-bound platform index | The deterministic importer self-test compiles the exact Git source into 22 component/config packages and refuses dirty, ambiguous, or mismatched inputs. |
| The familiar hub, ApplicationSets, AppProjects, and registered spokes | A faithful lane for unchanged Kubara topology and an adapted lane in which ConfigHub takes the hub role while each cluster keeps a local reconciler | The faithful and adapted lanes are separately receipt-gated so one cannot be mistaken for the other. |
| Argo CD as the cluster reconciler | Approvals, promotion, rollback, retained departures, release history, and OCI digest provenance before Argo receives a release | The current mini-IDP receipt proves hx-web and Cubbychat across development, staging, and two production targets. |
| Kubara's generated component and cluster placement | A component-by-cluster matrix and visible provides/needs wiring | The source-current receipt contains all 36 runtime observations; the public matrix shows them only after that exact receipt is bound and the projection is regenerated. |

The retained `Kubara` organization now has a passing source-current faithful
receipt and a passing source-current adapted mini-IDP receipt. That proves the
four-cluster example, its 35 managed Argo Applications, both applications, and
the zero-action rerun. It does not by itself prove a clean import into an
arbitrary newly selected organization; that remains a separate graduation
gate.

## The adoption journey

Every buyer, tutorial reader, and future repository user should see the same
six steps in the same order:

1. **Choose platform components and wiring in Kubara.**
2. **Run Kubara to generate the platform, add-ons, ApplicationSets, overrides,
   and cluster wiring.**
3. **Commit and push the complete reviewed hand-off to Git.**
4. **Run the deterministic ConfigHub importer against that exact Git revision;
   verify and publish immutable OCI packages.**
5. **Load the result into the organization selected by the user and materialize
   the familiar topology as governed ConfigHub objects.**
6. **Add, promote, and deploy applications through ConfigHub while Argo CD
   remains the cluster reconciler.**

Step 4 is genuinely portable: `--compile-portable`, `--verify-portable`, and
`--package-portable` need no ConfigHub organization. In Step 5 the user
explicitly selects or bootstraps a destination, inspects it read-only, and
runs `--bind`; the resulting `BindingDigest` stays outside OCI while the
`PlatformDigest` and member payloads remain unchanged.

The [tutorial](adoption.md) expands these steps without changing their
order. Internal preparation, scanning, packaging, binding, and verification
operations appear as checkpoints inside the relevant step rather than as a
second competing journey.

## Why a Kubara user should prefer this

### Compare the operating choices honestly

ConfigHub does not rename one implementation and call it a migration. The
example keeps three deliberately different operating choices visible:

| Operating choice | What the operator keeps | What the operator runs day to day | What ConfigHub adds |
| --- | --- | --- | --- |
| Raw Kubara | Native catalogs, `config.yaml`, generated platform tree, hub Argo, ApplicationSets, AppProjects, and spoke registration | Git review plus hub-and-spoke Argo operation | Nothing; this remains the portable baseline and exit path. |
| Faithful Kubara + ConfigHub | The same generated topology and central hub/spoke reconciliation | Kubara's familiar delivery lane, with exact source and release evidence retained in ConfigHub | Component/version retention, immutable release identity, history, and governed visibility without changing topology. |
| Adapted Kubara + ConfigHub | Native Kubara selection, generation, Git hand-off, target placement, and Argo reconciliation | ConfigHub takes the governance/hub role; each target keeps a small local Argo reconciler | Fewer hub-specific operating objects, approvals and promotion, exact rollback, visible wiring, a live fleet matrix, and an exact orphan audit. |

The faithful lane proves that adoption does not require a rewrite. The adapted
lane earns preference only when its current receipts show a simpler day-two
operation without losing exact topology, release identity, health, or the Git
exit path. Governance is additional capability and additional policy surface;
it is not advertised as free complexity reduction.

### Align the three catalog layers

The word *catalog* names related but different layers. Alignment preserves all
three instead of flattening them:

1. **ConfigHub component catalog:** reusable components and every retained
   exact version come first. Deployable variants and effective configurations
   follow from the component; adding a version never deletes an older one.
2. **Kubara compatibility profile:** Kubara's `Catalog.yaml`,
   `ServiceDefinition`s, wrappers, defaults, templates, and configuration
   surfaces are retained as the deterministic bridge for each component.
3. **Kubara platform package:** a platform's ordered catalogs plus
   `config.yaml` select, place, specialize, and wire those components for its
   hub and spokes.

An adopter may start from Kubara's upstream catalog or a ConfigHub-aligned
export. The acceptance test is the same: identical native Kubara input intent
must produce the same generated paths and bytes, while ConfigHub can still
show the reusable component and its retained versions independently of this
one platform selection.

### Keep the platform portable

The exact Git revision remains the neutral hand-off. OCI is the immutable
delivery form; ConfigHub is the governance and release plane. A user can still
inspect the generated tree and continue to understand it with Kubara's own
documentation.

### Retain components beyond one platform package

Kubara's catalogs describe reusable platform architecture and each platform's
configuration selects and wires a package. ConfigHub's Catalog starts with the
component: every retained version remains independently discoverable, with
deployable variants and effective configurations following from it. Neither
catalog model is discarded.

### See the platform as live data

Instead of treating the fleet matrix and wiring as documentation diagrams,
ConfigHub can expose exact component instances, target placement, departures,
release state, and curated `NeedsProvides` relationships. Generated evidence
views remain available outside the GUI and explicitly distinguish desired,
historical, and live-observed state.

The matrix is a direct runtime projection, not a health score inferred from
desired configuration. Each cell keeps Kubara's desired placement and version
separate from the exact ConfigHub release digest, Argo's observed revision and
sync/health result, and Kubernetes desired/ready counts supplied by the
source-current receipt. A disabled selection is `NotApplicable`; a missing
observation is `Unknown`, never silently green.

### Govern changes without replacing reconciliation

ConfigHub records the review, approval, promotion, rollback, release digest,
and revision history. Argo CD continues doing the in-cluster reconciliation a
Kubara operator already understands.

For production approval, the current client passes the Unit slug with
`--revision HeadRevisionNum`. The reconciler brackets that server-head
operation with authoritative reads and accepts it only when Unit ID, observed
numeric head, and `DataHash` are unchanged before and after. That is exact-head
evidence; it is not a claim that the approval API accepts a numeric
compare-and-set token.

### Make retained-cluster upgrades explicit

Kubernetes selectors are immutable. The current proof therefore records 16
one-time, allowlisted selector replacements: four hx-web Deployments and the
backend, frontend, and PostgreSQL workloads for Cubbychat on all four targets.
Every replacement is journaled, bound to the exact OCI revision and old
UID/resourceVersion, and accepted only after the replacement is healthy. The
four PostgreSQL PVCs retain the same bound PVC UID and volume identity across
StatefulSet replacement. This is visible upgrade evidence, not an invisible
delete-and-hope migration.

### Make `latest` discoverable, not deployable

The adapted lane keeps `targetRevision: latest` so each cluster-local Argo can
discover its ConfigHub OCI stream, but removes `spec.syncPolicy.automated` from
every managed Application. The pinned argobot v0.1.6 runtime can hard-refresh
only. ConfigHub revalidates the authoritative release and submits the exact
`ManifestDigest` with Kubernetes UID/resourceVersion compare-and-set when no
operation is active.

That is an intentionally better governed departure: a newly published mutable
pointer cannot race past approval, promotion, or rollback, yet Argo remains the
familiar local reconciler. The evidence covers the managed automated path. A
claim that even privileged humans cannot issue a manual Argo sync requires
separate RBAC or admission proof.

## The buyer walkthrough

Show the evidence in the same order an adopter crosses the boundaries:

1. **Native Kubara source:** open `config.yaml`, its ordered catalogs, and
   normal overrides. Explain that no replacement schema or AI rewrite is
   required.
2. **Kubara output and Git:** run the offline verifier, show the 135
   path-and-byte-identical files from both catalog lanes, then open the exact
   pushed commit and complete hand-off inventory.
3. **Component Catalog and OCI:** start with one reusable component and its
   retained versions, then follow the selected variant/config package and its
   immutable digest into the platform index.
4. **Recognizable topology:** show faithful and adapted lanes together, the
   one-hub/three-spoke identity, and the same four explicit targets.
5. **One application change:** follow hx-web from development through staging,
   exact production approval (server `HeadRevisionNum`, bracketed by Unit ID,
   observed head, and `DataHash`) and promotion, one retained departure, and
   an exact one-target rollback. Use Cubbychat to show the same model at a
   richer application shape and the PVC-retaining selector migration.
6. **Fleet visibility:** finish with native wiring Links, the current 36-cell
   platform matrix, measured reconciliation evidence, and the scoped residue
   result.

Explain rather than wait through the cold path: exact OCI media details,
source and destination locks, secret isolation, compare-and-set journals,
qualification internals, and initial cluster/bootstrap prerequisites. Those
mechanics remain fully documented and reproducible, but the buyer walkthrough
should spend its time on recognizable inputs and visible day-two outcomes.

## Honest boundaries

- The selected ConfigHub organization, Targets, and cluster-local delivery
  runtime must exist before the current importer applies the platform. The
  importer never silently chooses an organization.
- Secrets and target-local facts stay outside Git and the portable OCI
  packages.
- A generated matrix cell is not called live until an accepted exact-source
  receipt supplies its observation.
- Publication proves immutable packaging and retrieval, not production support
  for every possible chart configuration.
- The current accepted no-op reconciliation performed zero ConfigHub mutation
  attempts and zero Argo sync requests, while recording 33 ConfigHub CLI read
  commands, 208 total subprocess calls, and about 77 seconds end to end. It
  meets the fixture regression target. A CLI command is not an HTTP round trip,
  and this is neither a raw-Kubara comparison nor a service-level promise.
- The generic selected-new-organization path has deterministic compile,
  package, refusal, and idempotence tests, but has not yet passed the complete
  live path in a fresh user-selected organization. The retained four-cluster
  organization must not be presented as that missing proof.

## Graduation to a dedicated repository

The eventual `github.com/confighub/kubara-confighub` repository should contain
this same six-step journey, the importer, a small reproducible example,
contracts, tests, and current evidence. It graduates from this proof repository
only after the current example passes twice idempotently, the organization is
free of unexpected governed inventory and audited runtime residue, the GUI walkthrough is current, and a fresh user-selected
organization import reaches one healthy application.

Next: [follow the six-step adoption tutorial](adoption.md).
