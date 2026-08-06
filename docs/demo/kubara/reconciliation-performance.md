# Kubara mini-IDP reconciliation performance

This page records the measured cost model and safety boundaries for
`scripts/reconcile-kubara-mini-idp.mjs`. It is an engineering baseline, not a
service-level promise. The reconciler emits a sanitized `kubara-performance`
JSON line on exit. Each retained live reconcile run records schema-v2 evidence
under `spec.reconcileRuns[].performance`; failed processes retain incomplete
cache and phase evidence on stderr without being accepted as successful runs.

## Baseline measurements

The ConfigHub reads below were measured serially on 2026-08-05 against the
quiescent Kubara organization. They describe this organization and client at
that point in time; they are not portable latency claims.

| Read | Calls | Elapsed | Mean per call |
| --- | ---: | ---: | ---: |
| `unit get` | 10 | 5.95 s | 0.595 s |
| `unit data` | 10 | 5.72 s | 0.572 s |
| organization-wide Link list | 1 | 4.60 s | 4.60 s |
| organization-wide published-release list | 1 | 0.43 s | 0.43 s |
| `context get` | 10 | 0.61 s | 0.061 s |
| organization list | 5 | 2.69 s | 0.538 s |
| control-Space get | 5 | 2.73 s | 0.546 s |
| organization-wide Unit list (105 Units) | 1 | 3.10 s | 3.10 s |

A full context, organization, and control-Space pin revalidation adds about
1.15 seconds before each mutation. This is deliberately retained: selecting
the right organization and control Space is a safety property, not an
eventual-consistency optimization target.

The organization-wide shape probe observed 105 Units, 39 Links, 35 published
releases, and 4 targets. The target-list duration was not isolated, so no
target-list latency is claimed here. The Link sample predates the 25
NeedsProvides Links in the completed 64-Link organization and must be
remeasured before it is used as a current Link-list baseline.

The pre-change offline runs on the same host were 8.72 s, 8.57 s, and 8.58 s
for `--plan`, and 7.83 s for `--self-test`. Instrumented process profiles ranged
from 7.74 s to 7.95 s. Every run stopped at the same pre-existing stale faithful
hub/spoke receipt after concurrent generated-example changes. These values show
that instrumentation did not create an obvious regression on that failure
path; they do **not** prove a successful end-to-end speedup. The instrumented
plan reported about 0.13 s in its single child command, which suggests that
local rendering, YAML, checksumming, and contract work dominate this particular
failure path. That last statement is an inference from the profile, not a
standalone benchmark.

## Rejected end-to-end profile and the current measured pair

The first instrumented end-to-end attempt did not complete successfully, so it
is a rejection profile rather than a speed result. It took 1,541,558 ms
(25.69 minutes) and launched 1,372 subprocesses. The seven known ConfigHub read
verbs accounted for 866 commands, or 63.1% of every subprocess and 13.75 reads
per managed Unit:

| Class | Sanitized verbs | Calls |
| --- | --- | ---: |
| Metadata discovery | `unit list`, `unit get`, `target get`, `link list`, `space get`, `space list` | 658 |
| Exact content verification | `unit data` | 208 |
| Known ConfigHub reads | both rows above | 866 |
| One observed mutation verb | `unit update` | 20 |

The 20 `unit update` calls are not the complete write count. Other mutation
verbs were present, and the old profile did not yet classify every mutation by
purpose and outcome. It would therefore be false to describe this as “866
reads versus 20 writes.” The useful finding is that metadata and content reads
alone already dominate the command shape.

Explicit `sleep` subprocesses consumed 866,701 ms (14.45 minutes, 56.2% of the
wall time). The remaining wall time was 674,857 ms (11.25 minutes). The old
single `sleep.wait` bucket mixes Argo Application appearance, active-operation,
health, refresh, namespace-move, and protected-Namespace settling. It cannot
prove that all 14.45 minutes were caused by Argo.

The exact baseline and accepted budgets live in the
[performance acceptance contract](../../../data/kubara-mini-idp-performance/contract.yaml).
The [offline verifier](../../../scripts/verify-kubara-mini-idp-performance.mjs)
requires a successful changed apply followed immediately by a successful
zero-action apply with the same execution fingerprint. These are fixture
regression budgets, not service-level objectives:

| Dimension | Rejected attempt | Current changed apply | Immediate no-op | Accepted no-op fixture target |
| --- | ---: | ---: | ---: | ---: |
| Wall time | 1,541,558 ms | 142,874 ms | about 76,994 ms end to end (~77 seconds) | at most 300,000 ms |
| Subprocess calls | 1,372 | 287 | 208 | at most 220 |
| ConfigHub read commands | at least 866 known | 123 | 33 | at most 96 |
| ConfigHub reads through first accepted dev Application | not isolated | 44 | 19 | at most 96 |
| First accepted dev Application | not isolated | 60,655 ms | 42,922 ms | at most 90,000 ms |
| Explicit wait time | 866,701 ms, unclassified | 0 ms | 0 ms | at most 120,000 ms |
| ConfigHub mutation attempts | not completely classified | 1, action-attributed | 0 | exactly 0 |
| Argo sync requests | not isolated | 0 | 0 | exactly 0 |

The reconciliation and idempotence pair passes its functional receipt: the
second run made zero semantic changes, zero ConfigHub mutation attempts, and
zero Argo sync requests. Its current buyer-facing conservative measurement is
therefore **33 ConfigHub CLI read commands, 208 total subprocess calls, and
about 77 seconds**. It reaches the first accepted `hx-app-dev` Application
within 19 reads, then completes fleet and closing-stability verification within
the 96-read and 220-subprocess ceilings. The fixture regression target is met.
This remains evidence for this retained four-cluster fixture, not a speed
comparison with raw Kubara or a service-level promise.

Command count is also not wire-request count: one `cub` command can make more
than one authenticated request. “Fewer than 100 authenticated HTTP round
trips” remains forbidden until sanitized client-transport evidence measures it.

Final performance publication is accepted only when the paired receipt verifier
and orphan audit also pass. This prevents a faster run from succeeding by
silently skipping part of the managed fleet. No budget permits removing target
pinning, stable approval-gate observation, server `HeadRevisionNum` approval
bracketed by unchanged Unit ID, observed numeric head, and `DataHash`, immutable
OCI revision checks, release-boundary stability, wiring, or Application health.

## What “63 Units means more than 100 round trips” actually means

The sentence was directionally right about the old client shape, but it is not
a current measurement. A Unit is not one request. The steady-state reconciler
used to read each managed Unit's metadata three or four times, read its body,
then repeat endpoint, target, release-boundary, and final-verification reads.
Static call-path accounting found 537 `cub` reads in the final verification body
alone and a lower bound of hundreds more before the first Argo convergence
wait. The accepted no-op now uses 33 ConfigHub CLI read commands for the whole
fixture; that command count still must not be relabelled as HTTP round trips.

This is an N+1 client problem, not a reason to collapse the platform into fewer
governed Units. The useful unit of analysis is:

```text
inventory snapshots + content reads + changed-object writes + convergence
```

not `Unit count × an assumed constant`.

## Bottlenecks and the implemented read optimizations

Per-Unit metadata and data reads cost roughly 0.57--0.60 seconds each in the
sample. Repeating those reads makes verification grow with the number of Units.
An organization-wide Link list is individually expensive, but one list is still
preferable to repeating it for every Space.

Read-only verification now brackets organization-wide Space, Unit, Link,
published-release, and Target snapshots. The Unit list selects `Data`,
`DataHash`, `ContentHash`, revision, endpoint, label, annotation, and gate
fields, so one bounded bulk observation supplies both metadata and the exact
canonical Unit body. A second five-resource snapshot closes the verification
barrier. No `cub unit data` or `cub unit get` command remains in the accepted
path, and a foreign Target slug or unexpected Space fails the final allowlist.

The apply path uses the same bulk Unit data for content comparisons and refreshes
the organization snapshot only at explicit mutation or phase boundaries.
Release decisions still use authoritative targeted snapshots immediately before
publication, and a cached no-op is compare-and-set revalidated before any write.
The accepted 96-command no-op ceiling includes the closing stability check.
The current measured no-op uses 32 commands and keeps that closing boundary.

The apply path also removes three separate multipliers:

- an unchanged managed Unit reuses its one fresh metadata observation instead
  of fetching the same metadata three or four times;
- each delivery Application Space is listed once per metadata pass instead of
  fetching every Application Unit separately, and the already-read Unit is
  reused while checking its Application contract;
- all Application Units are reconciled before delivery, then the complete
  delivery root is published once per cluster, lazily just before that
  cluster's first source Application converges. The previous implementation
  republished and fully revalidated the same cluster root for every one of 27
  deployments. Static accounting falls from about 1,302 reads for that repeated
  root path to 182 for four root publications plus the closing currency checks.

Source-release checks use an authoritative boundary-local snapshot and merge a
successful closing observation back into the outer apply cache. The latest
release is always taken from that inner authoritative snapshot while it is
active; an older outer-cache release can never overrule it. No snapshot
survives a release mutation. This preserves exact Unit bodies, endpoints,
targets, labels, Links, approvals, and opening/closing release identity without
returning to per-Unit reads.

These are API-backed `cub` reads, not literal wire round trips. A read-only
client trace showed that space-scoped `unit list`, `unit get`, and `unit data`
can each issue two authenticated application requests: one resolves the Space
and one queries the Unit endpoint. The organization-wide Unit snapshot issues
one. The accepted run records 32 CLI reads, but an exact full-run application-
request or wire-request count is not claimed. The current `cub --debug` output
is unsuitable for receipts or CI because raw debug traces can contain sensitive
headers and request/response bodies. Safe instrumentation must count sanitized
route templates and status/latency in the
client transport, and use wire-level hooks separately for transmitted attempts,
connection reuse, and TLS cost.

The receipt records a dedicated
`apply-start-to-first-argo-convergence` phase. That measurement matters because
optimizing total runtime and optimizing time to the first converged Application
are not always the same tradeoff.

The initial and final Space/Unit/Link/release/Target snapshots must have
identical row counts and a canonical fingerprint. Every row must belong to the
pinned Kubara organization and the exact final allowlist. If any of those five
resource sets differ at the closing observation, the run fails and asks for a
retry against a quiescent organization. This is an opening/closing net-state
check, not an event stream: an ABA change between observations is outside the
claim. Apply-cache mutation decisions are separately guarded by a fresh
targeted comparison immediately before the actual write.

Canonical Kubernetes and AppConfig YAML is memoized by content digest within a
single process. Cache keys also retain a length/head/tail collision check, and
the profile records requests, hits, misses, entries, and parse time. No
cross-run cache is trusted.

## Concurrency and safety boundary

All commands remain serial and deterministically ordered. Organization-wide
reads are batched by resource, not executed concurrently. The five snapshot
lists are independent and could be parallelized later, but doing so needs
server-load and stable-evidence testing first.

The following remain strictly serial:

- every ConfigHub mutation and its full pinned-target revalidation;
- release publication, approvals, promotion, and operation-journal changes;
- cluster and Argo convergence checks whose observations depend on earlier
  actions;
- the opening and closing snapshot barriers.

A possible future optimization is to validate the full target once at a
well-defined mutation-batch barrier, then verify a locally pinned context token
before each mutation. It is intentionally not implemented: it must first prove
equivalent protection against context and organization changes.

## Other things that can slow the platform down

In priority order for this example:

1. **Repeated authenticated reads.** Per-object CLI calls pay process startup,
   TLS, authentication, API routing, and JSON decoding every time. Bulk read
   APIs and boundary snapshots are the main remaining product opportunity.
2. **Per-mutation target pinning.** A context, organization, and control-Space
   revalidation costs about 1.15 seconds before every write. It remains intact;
   the safe product fix is a server-enforced organization/batch boundary, not a
   weaker client check.
3. **Release-boundary verification.** Source releases deliberately prove Unit
   data, endpoint identity, target, labels, Links, and a stable before/after
   boundary. A boundary-scoped bulk API could retain those invariants with far
   fewer round trips.
4. **OCI work.** Rendering, hashing, uploading immutable layers, publishing a
   release, registry propagation, and controller pulls all add latency. Cache
   hits help, but exact digests and retained versions must not be discarded.
5. **Argo polling.** Serial five-second polls make quiet convergence easy to
   reason about but add tail latency. A watch/event path can improve this later
   if it preserves the exact revision and operation-journal deadlines.
6. **Kubernetes controller dependencies.** CRDs, webhook readiness,
   cert-manager issuance, ESO reconciliation, Ingress status, and workload
   health are real dependency barriers; parallelizing across them blindly can
   make the run slower and less reproducible.
7. **Image pulls and target capacity.** Cold images, registry throttling, CPU,
   memory, disk, DNS, and the single-node kind topology can dominate once API
   chatter is reduced.
8. **Local parsing and subprocesses.** YAML canonicalization and one process per
   `cub`/`kubectl` command are measurable overhead. Process-local canonical-YAML
   memoization is implemented; a long-lived API client would remove more.
9. **GUI query shape.** Component matrices, wiring Links, history, and health
   views should query by indexed labels and page/batch results. Rendering every
   revision or edge eagerly would move the same N+1 problem into the browser.
10. **Source and catalog hand-off.** Kubara generation, Git fetch/checkout,
    lock and checksum verification, exact catalog-version resolution, and CI
    gates add deterministic latency before import. Cache by Git revision and
    catalog lock, but never replace exact-version failure with a silent upgrade.

## Performance guardrails

These are regression budgets for this implementation, not user-facing SLAs:

- verification uses exactly two organization-wide list calls per cached
  resource: one opening and one closing Space, Unit, Link, release, and Target
  list;
- active verification must issue no per-Unit metadata get or per-Space Unit
  inventory list; exact Unit data comes from the bulk Unit rows;
- each source-release boundary reads authoritative targeted inventories,
  issues no point Unit metadata/data gets, and invalidates or refreshes its
  cache at every release mutation;
- mutations remain serial and keep full target-pin validation;
- the opening and closing fingerprint must match before evidence can say
  `stability: pass`;
- command evidence contains sanitized resource/verb labels only, never names,
  arguments, paths, tokens, or payloads;
- canonical-cache hit/miss accounting must balance and every miss must create
  exactly one process-local entry;
- on the same host and fixture, an offline failure-path plan or self-test above
  10 seconds should be investigated against the approximately 8.6/7.8-second
  baseline;
- a changed apply must meet the `changed-apply` contract and the immediate
  zero-action apply must meet the tighter `idempotent-apply` contract under the
  same execution fingerprint;
- the current 32-read/208-subprocess/~102-second no-op meets the fixture
  regression target and is disclosed as bounded evidence, not a raw-Kubara
  speed comparison or SLO. The v2 receipt verifier and scoped residue audit remain
  authoritative for what actually happened.

Verify the offline contract and its negative tests without a ConfigHub login:

```sh
npm run kubara-mini-idp:performance-contract:verify
npm run kubara-mini-idp:performance:self-test
```

After the changed/idempotent live pair and orphan audit exist, verify only the
committed evidence—without network access—with:

```sh
npm run kubara-mini-idp:performance:receipt-verify
```
