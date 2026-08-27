# Live evidence: the app promotion chain in the reference organization

A read-only demonstration that the mini-IDP's deploy-and-promote machinery is
real in the reference Kubara organization (`58b23b85-9699-4384-bd57-80ef695a1d58`).
It reads the live organization and changes nothing. It corroborates the README's
"the complete journey has passed live against the reference organization" with
the current promotion lineage and release history for one application.

Read on 2026-08-27 against context `munch-cub`. No mutation was performed.

## The application runs as a base plus four environment variants

`hx-cubbychat` spans three regions across the four-cluster fleet.

| Space | Role | Region | Head revision | Upstream (base revision) |
| --- | --- | --- | --- | --- |
| hx-cubbychat-base | base | — | 5 | — |
| hx-cubbychat-dev | dev | local | 5 | 2 |
| hx-cubbychat-staging | staging | local | 5 | 2 |
| hx-cubbychat-prod-a | prod | us-east | 6 | 1 |
| hx-cubbychat-prod-b | prod | us-west | 6 | 1 |

Every environment carries an `UpstreamRevisionNum` pointing back to the base.
That pointer is how ConfigHub binds an environment to the base it was promoted
from: the environments are not copies, they are variants that track the base.

## The environment was cloned from the base, then released

`hx-cubbychat-staging` revision history:

| Revision | Source | Release tag |
| --- | --- | --- |
| 1 | CloneUnit (from base) | — |
| 2 | Resolve | release-1 |
| 3 | UpdateUnit (reconcile) | release-2 |
| 4 | UpdateUnit (reconcile) | release-3 |
| 5 | Invoke | release-4 |

Revision 1 is a `CloneUnit` from the base: the variant creation that begins the
promotion chain. Each later revision was published as a Space Release.

## The releases are real OCI artifacts

`cub release list --space hx-cubbychat-staging` returns four published releases,
each with an immutable manifest digest, over three weeks.

| Published | Manifest digest | Created |
| --- | --- | --- |
| true | sha256:79cebc51… | 2026-08-26 |
| true | sha256:b9d06e8a… | 2026-08-06 |
| true | sha256:00f7c8d4… | 2026-08-05 |
| true | sha256:f4dcad0b… | 2026-08-03 |

## Honest current state

The organization is mid-flight. Every environment reads `UPGRADE-NEEDED=Yes` and
`LastReleasedRevisionNum=None`, because a later change moved the base ahead (base
head is 5, the environments track base revisions 1 and 2) and the current release
pointers were cleared during an in-progress endpoint-migration replay. So this
evidence is structural and historical: it proves the deploy, promote, and release
machinery ran and produced real releases, not that the organization is currently
converged. The committed reconcile receipt and the checkpoints ledger remain the
authorities on the converged state.
