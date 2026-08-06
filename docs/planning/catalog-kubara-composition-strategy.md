# Catalog and Kubara composition strategy

Planning doc. Status: draft for discussion. This note answers three questions
that came out of the live IDP build recorded in
[the single-platform example](../demo/kubara/single-platform.md) and
[its receipt](../../runs/kubara-single-platform-proof/receipt.yaml). Should the
catalog grow newer chart versions? Did Kubara expose faults in the catalog? And
how should wiring and composition work when the catalog cannot review every
platform? It is a companion to the Pilot ad-hoc variant model, whose
generation-gated-by-parity doctrine this note extends from single charts to
whole platforms.

## What the comparison showed

We compared the catalog's reviewed components with the charts Kubara generated
for the live platform. Every public upstream chart selected by this Kubara
profile has a local catalog recipe, but only at a different version. Kubara's
own `homer-dashboard` wrapper and `template-library` are separate first-party
surfaces.

| Chart | Retained root versions | Kubara-selected offline candidate |
| --- | --- | --- |
| argo-cd | 9.5.15, 9.5.17 | 10.1.3 |
| cert-manager | v1.20.2 | v1.21.0 |
| kube-prometheus-stack | 85.3.3, 86.1.0 | 87.15.1 |
| prometheus-blackbox-exporter | 11.10.0 | 11.15.1 |
| external-secrets | 2.5.0 | 2.7.0 |
| metrics-server | 3.13.0 | 3.13.1 |
| traefik | 40.2.0 | 41.0.2 |

All seven exact public artifacts were retrievable from their official sources
when rechecked on 2026-08-04, including kube-prometheus-stack 87.15.1. They now
have digest-bound offline candidate recipes and packages under
`data/kubara-catalog-refresh/candidates/`; none is root-retained, live-qualified,
or published as a supported installer yet. Candidate generation uses exact
artifact URLs rather than trusting a mutable Helm index. The earlier live run
failed to resolve 87.15.1 from the then-visible upstream index and used 87.19.0;
that remains valid historical evidence about mutable discovery, not a permissible
version substitution.

The two sides hold different kinds of knowledge. The catalog holds review: the
[cert-manager recipe](../../recipes/jetstack/cert-manager/v1.20.2/README.md)
records hook policy, required CRDs as target facts, a value model, a source lock
with the package digest, and the rendered objects themselves. Kubara holds
composition: its values wire cert-manager's ACME solver to traefik's ingress
class, every ServiceMonitor to the monitoring instance, Grafana's admin Secret
to an external-secrets store, and seventeen ApplicationSets to a label
switchboard on the in-cluster Secret that enables exactly seven services.

The catalog's per-chart review predicted every live failure we hit. The CRD
ordering, the hook Job, the webhook readiness wait, and the Grafana password
were all already recorded on the recipes. Kubara's raw wrappers walked into
each one.

The comparison also found wiring defects in the generated platform that nobody
had noticed, because nothing checks wiring today. metrics-server's generated
values set ServiceMonitor labels while leaving the monitor disabled, so
metrics-server is never scraped, and the labels themselves are a nested
`monitoring:` map that would be rejected as invalid if anyone enabled the
monitor, while cert-manager's values use the correct flat form. Grafana ships a
Loki datasource while the switchboard disables Loki. The external-secrets
config creates no ClusterSecretStore, yet three services reference one. Each of
these is silent today. The platform looks healthy while a declared intent
quietly fails.

## The scaling problem

The obvious next step would be to review compositions the way we review charts.
That step does not scale, and we should say so plainly. The catalog can afford
deep review of roughly a hundred charts times a few variants each, because that
surface is bounded. Platforms are not bounded. Every team composes its own,
with its own services, clusters, hosts, and secret backends. A catalog of
reviewed compositions would chase an unbounded surface with a bounded team, and
it would always be behind.

## The thesis

Composition is derived, not separately curated in ConfigHub. ConfigHub Catalog
reviews bounded component parts and records small facts about each part. For a
Kubara platform, the effective ordered catalog set, `config.yaml`, and documented
overrides remain authoritative for selection and wiring. An organization-owned
external catalog may package part of that architecture, but it is optional.
Kubara generates the render, and ConfigHub will derive a checked Composition
ledger from those inputs. Deterministic gates will check the derivation against
component facts.

This is the Pilot ad-hoc variant doctrine applied one level up, but it does not
make AI part of the Kubara adoption path. The effective Kubara catalogs,
contract, and overrides are authoritative. Generated renders and ConfigHub
Compositions are deterministic derivations. An AI generator may optionally
author a bespoke non-Kubara composition, but it faces the same gates and never
becomes authority.

## How wiring works

Each catalog variant gains one sibling file, `wiring-facts.yaml`, holding two
lists. The `needs` list says what this chart requires from outside itself. The
`provides` list says what this chart offers to others. Both draw from a small
closed vocabulary of typed facts taken from the real wiring inventory:
IngressClass, ClusterIssuer, CRDs, Secret, SecretStore, PrometheusScrape,
NamespaceLabels, HttpPath, HookRun, PullSecretFanout.

A need names its kind, its parameters, and the exact values paths where the
provider's value must land. A Secret need also names who materializes it, for
example external-secrets, which is precisely the distinction the Grafana
failure taught us. A provide names its kind and the rendered field that carries
the authoritative value.

Two rules keep the facts honest. Provides are derived mechanically from the
variant's rendered objects, never hand-claimed, because hand-written facts rot
exactly as prose route notes do. And no chart declares anything about another
chart. Cross-chart knowledge lives only in generated compositions.

A sketch for kube-prometheus-stack shows the shape.

```yaml
kind: WiringFacts
spec:
  needs:
    - kind: CRDs
      names: [prometheuses.monitoring.coreos.com, ...]
      applyMode: server-side-apply
      establishedBeforeConsumers: true
    - kind: IngressClass
      boundAt: [kube-prometheus-stack.grafana.ingress.ingressClassName]
    - kind: Secret
      name: grafana-admin-credentials
      keys: [admin-user, admin-password]
      materializedBy: external-secrets
      boundAt: [kube-prometheus-stack.grafana.admin.existingSecret]
  provides:
    - kind: PrometheusScrape
      selector: { monitoring.instance: "<instance>" }
```

This unifies three things that already exist in inconsistent shapes: the
`targetFacts.requiredCRDs` on variants, the kube-prometheus-stack value-model
binds, and the free-text external requirements in installer packages. It is an
extension of existing machinery, not a new system.

## How composition works

For Kubara, the planned importer will take the effective ordered catalog set,
`config.yaml`, documented overrides, source locks, and generated tree. It will
not choose a different platform. It will emit one derived data object, the
Composition. The Composition will record the exact selections per cluster, the
edges already encoded by Kubara's wiring, a wave order derived from those edges
and lifecycle facts, the target facts assumed from the environment, hook routes,
and policy exceptions.

For a bespoke non-Kubara platform, an optional generator may start from intent
and select parts. Whether that author is a person, an AI agent, or another
platform tool, it writes the same object and faces the same gates. Existing
Kubara users need no such generation or migration.

Four deterministic gates will then run, offline, before anything is delivered.

1. Closure. Every need is met by exactly one enabled provider on that cluster,
   or by one named target fact. Unmet needs and duplicate providers both fail.
2. Parity. Each part re-renders from its catalog package plus the overlay, and
   the diff against the catalog render may differ only at declared need paths.
   A hallucinated value fails here, exactly as in the Pilot variant doctrine.
   The same pass verifies every claimed provide actually renders.
3. Ordering. CRD facts become wave semantics with server-side apply, checked
   rather than remembered. Hook objects must carry a route or fail.
4. Policy. Vet functions run over the composed render. The privileged
   pod-security labels Kubara stamps on namespaces stop passing silently and
   become an explicit exception a person accepts or rejects.

One further check is a hard gate, not advisory. Any ingress class, issuer
annotation, secret reference, or secret store reference that appears in the
rendered objects but is covered by no edge and no target fact fails the run.
This is how the closed vocabulary gets caught when it is incomplete, and it is
what would have caught the metrics-server label mismatch and the undeclared
ClusterSecretStore.

Run against this Kubara fixture, the gates must reproduce the real defects as
findings. That reproduction is the acceptance test for the whole mechanism.

The implementation must canonicalize Composition output so generating the same
intent twice produces the same object. Once that gate exists, the second use of
a wiring will be a lookup and a diff, not a fresh authoring pass.

## What a human reviews

Nobody reviews generated YAML line by line. The review is a short pass over
five things: the exceptions list with reasons, the external boundary the
composition assumes from the cluster and the secret backend, the hook route
table, the closure report, and the edge-level diff against the previously
approved composition. The production approval gate stays exactly where it is,
as the live IDP example proved it, and it remains the last word before a
production cluster changes.

## How it lands in ConfigHub

There are two delivery modes, sharing one Kubara-authored revision.

1. **Native Git mode requires no Argo source change.** ConfigHub checks, approves,
   and attests the generated Git revision; a repository rule must require that
   status before merge or promotion for the approval to be enforceable. The
   existing Kubara hub Argo CD and ApplicationSets continue pulling Git. Without
   that required-status integration, Git remains the release authority and
   ConfigHub is an advisory governance record. The full multi-cluster loop
   remains to be proved.
2. **ConfigHub-delivery mode is an explicit opt-in source change.** Each
   selection becomes a Unit in a per-cluster Space and is published as an OCI
   release that Argo CD pulls and argobot syncs. This is the lane the live
   four-cluster example proved.

In either mode, each edge can later become a ConfigHub Link, whose direction,
consumer to provider, matches the need-to-provide relationship one for one. The
derived Composition itself can be uploaded as a Unit, so the wiring ledger is
diffable data beside the delivery or attestation record.

Two cautions from the Link research. Automatic needs and provides matching
today recognizes a small set of standard attributes, so the chart-specific
paths here each need an Attribute registration once per kind. The committed
Composition is a derived, diffable ledger that must reproduce from the
authoritative Kubara inputs; Links remain a delivery convenience. Automatic
updates stay off until the round trip is proven, including survival across
`cub variant create`, which is currently assumed rather than proven.

## What the live failures map to

Every failure from the live build should become a named gate finding rather than
an afternoon of debugging. The historical 87.15.1 resolution failure would
become a sourcing failure until the exact selected package and digest were
retained, whether its origin were Kubara's upstream catalog or ConfigHub
Catalog. No nearby version would be substituted. The Grafana secret would
become an unmet Secret need naming its materializer. CRD ordering and apply mode
would become wave semantics. The hook Job shipped as a plain object would become
a missing hook route. Privileged namespace labels would become a policy
exception requiring a decision. The metrics-server mismatch would become a
value mismatch at compose time.

## Where Kubara fits

Kubara stays the composer of the platform shape. Its upstream component catalog
also remains a supported source; adoption does not require dependencies to be
repointed. The planned importer will parse the resolved catalog inputs and
generated tree into a Composition so today's output becomes checkable without
Kubara changing at all.

ConfigHub Catalog is a component catalog first, not a Kubara catalog today. An
exact reviewed upstream chart is necessary but insufficient: Kubara's
`ServiceDefinition`, wrapper templates, defaults, and additions are also part of
the component's behavior. The second, optional source lane therefore requires a
versioned Kubara compatibility profile, sourced from the resolved Kubara catalog
until ConfigHub retains it, beside the exact reviewed upstream package. A
deterministic adapter/export will combine them into Kubara-compatible
`Catalog.yaml`, `services/`, `platform-components/`, and `platform-configs/`
artifacts. Import must never rewrite a version or silently choose a nearby one.

A dual-source parity lane will run two alternatives, not merge their inputs:
lane A resolves the normal Kubara catalogs; lane B resolves the exported
ConfigHub-backed catalog. The harness derives two config copies from one
platform intent and changes only the non-bootstrap component-catalog references;
cluster/service selections, service configuration, and values overrides remain
identical. Each lane resolves in a clean work directory. Lane B replaces the
normal component catalog rather than appending beside it, and an unexpected
service collision fails instead of using `--catalog-overwrite`. Their outputs
are compared for identity, version, defaults, wrapper additions, render
capabilities, lifecycle routes, target facts, semantic object inventory, and
live outcome. Only after that passes is the ConfigHub-backed source an equivalent
choice.

Longer term Kubara's template library can emit wiring facts natively.
Kubara-authored charts such as homer-dashboard should gain first-party
ConfigHub Catalog component entries so their defects surface as component
findings rather than platform noise.

## What this means for catalog growth

Grow versions demand-driven, not by chasing latest. The composers set the
freshness bar, and today that means adding the exact versions Kubara pins:
argo-cd 10.1.3, cert-manager v1.21.0, external-secrets 2.7.0, traefik
41.0.2, metrics-server 3.13.1, kube-prometheus-stack 87.15.1, and its direct
prometheus-blackbox-exporter 11.15.1 dependency. All are currently retrievable,
but none has an exact retained local entry yet. The adapted live proof's use of
kube-prometheus-stack 87.19.0 remains a recorded departure, not a permissible
import substitution. `homer-dashboard` 0.1.0 needs a first-party Kubara component
entry; `template-library` 0.2.0 is a build dependency to source-lock with the
wrappers, not a deployable installer.

Keep every older version as a retained, still-reviewable entry. This is an
additive-only rule: a refresh may add a version and mark support or replacement
status, but it never deletes an older recipe, package, receipt, candidate,
fixture, or public path. Exact versions must enter through scoped candidate
harnesses and version-aware assertions; blindly overriding the current proof
scripts would turn old-version assumptions into false evidence. The exact
kube-prometheus-stack candidate now includes an `existing-secret` variant that
matches Kubara's Grafana credential reference, keeps credential material out of
the render, and records the target Secret as a prerequisite fact.

The alignment contract and first exact candidate set are now checked in as the
example's
[catalog alignment manifest](../../examples/kubara/local-platform/catalog-alignment.yaml).
The manifest records the eight component identities, seven verified public
artifact digests, candidate paths, upstream-package gaps, missing Kubara
compatibility profiles, all retained older versions, the first-party Homer
disposition, and the required adapter inputs and outputs. The candidate-set
receipt records exact source locks, offline render/package results, and object
counts. Verification fails if an old retained recipe or package disappears, if
the candidate differs from the selected artifact, or if an upstream-package
status disagrees with the root repository.

## Risks

The closed fact vocabulary will be incomplete at first, which is why the
unreviewed-reference check is a hard gate rather than advisory. Derived
provides depend on the extractor being right, so its output is digest-pinned
and fixture-tested. Exactly-one-provider closure needs scoping before real
fleets arrive, because two ingress classes on one cluster is legitimate. New
committed surfaces invite the schema-drift cascade this repo has met before, so
the surface count stays minimal until the gates earn their keep. Environment
fact checks are point-in-time, so live verification remains load-bearing.
Gate-green is not works; the live lanes stay.

## Linear implementation sequence

1. **Lock the source map — done.** Keep the checked alignment manifest exact;
   nearby versions never count as matches.
2. **Build scoped, version-aware candidate harnesses — done.** All seven public
   pins use reviewed version-specific assertions and exact artifact digests; the
   harness writes only the dedicated candidate tree and verifies every old root.
3. **Generate exact offline candidates — done.** Each selected recipe and package
   has deterministic render, package, policy, and applicable lifecycle evidence.
   The kube-prometheus-stack candidate also carries the Kubara-shaped Grafana
   `existing-secret` base. Root upstream-package and complete-component statuses
   remain `missing`.
4. Add the first-party Homer component entry and source-lock the template library
   with its wrappers rather than publishing the library as an installer.
5. Capture a versioned Kubara compatibility profile for each component: its
   `ServiceDefinition`, wrapper templates, defaults, and additions. Until those
   profiles are retained, the adapter must read the resolved Kubara catalog
   assets rather than pretending the upstream chart is the whole component.
6. Build the deterministic Kubara catalog adapter/export with the four required
   artifact surfaces, then prove a normal Kubara invocation can consume it.
7. Ship the provides extractor and hand-author the initial needs from the current
   wiring inventory, folding CRDs, Secrets, secret stores, and external
   requirements into one schema.
8. Build the four gates plus the unreviewed-reference check. Fixture-test them
   until they reproduce the six live failures and three latent defects.
9. Build the Kubara importer over the effective catalog set, `config.yaml`,
   overrides, locks, and generated tree; commit the canonical Composition and
   findings with recorded-not-live statuses.
10. Run offline dual-source parity through Kubara's own catalog resolution for
   every exact ConfigHub match. Keep the Kubara-upstream lane authoritative for
   each missing or failing match.
11. Generate the platform matrix deterministically from committed ConfigHub
    receipts and observation snapshots as Markdown, CSV, and self-contained
    HTML, showing component version, recorded sync state, and explicit departures
    by cluster. Offline verification never queries the live organization.
12. Qualify the exact component candidates through their scoped live lanes,
    preserve the resulting receipts, and only then mark the upstream packages
    retained.
13. Prove the faithful zero-repoint lane on a fresh hub and registered spokes:
    Argo keeps pulling Git while ConfigHub checks, approves, and attests the same
    revision through an enforced repository status gate.
14. Re-deliver the optional OCI lane from the gated Composition on fresh targets,
    then prove the ConfigHub Link round trip before any wiring fan-out relies on
    it.
15. Graduate a whole `componentEntryStatus` to `retained` only when its upstream
    package is retained, its Kubara compatibility profile is captured, the
    adapter succeeds, offline parity passes, and the required live outcome is
    recorded. Otherwise the complete component stays `missing`, even if its
    upstream package is retained.
16. Put any AI author behind the deterministic gates last. It remains optional
    and outside Kubara adoption.

Steps one through eleven are offline. Steps twelve through fourteen are live and
quota-bound, so they run serially only after their offline prerequisites pass.
Step fifteen is the evidence-backed status transition after those lanes.
