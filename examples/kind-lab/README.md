# The kind lab: a Kubara platform on your laptop, handed to ConfigHub

This lab runs the whole `cub kubara` story on two kind clusters. Kubara
generates and bootstraps a hub and a spoke, and the hub's Argo CD delivers
every service from Git, as it would on a real platform. Then `cub kubara` puts
the platform into ConfigHub, hands the hub over, and takes one change to dev
and then prod.

```bash
bash examples/kind-lab/up.sh     # the Kubara platform, about 10 minutes
cub auth login
bash examples/kind-lab/run.sh    # the cub kubara story, about 20 minutes
bash examples/kind-lab/upgrade.sh    # optional: newer Kubara catalogs, through the stages
bash examples/kind-lab/rebootstrap.sh   # optional: kubara bootstrap again, then handover.sh
bash examples/kind-lab/handback.sh   # optional: hand the hub back to Git
bash examples/kind-lab/down.sh   # remove it
```

The [recorded run](run-2026-09-30.log) shows each command and what it printed,
from scratch, with argobot reporting live status and a stage gated on it. The
[run of 2026-09-28](run-2026-09-28.log) is the same story with `cub kubara`
v0.2.2, before argobot. The [run of 2026-10-02](run-sdk-2026-10-02.log) is
the same story against ConfigHub v0.8.0, with `cub kubara` 0.3.0. The
[run of 2026-10-09](run-live-status-2026-10-09.log) is the story as it is now,
against ConfigHub v0.8.11: argobot v0.1.9 records live status on each release,
and the gate refuses a release until dev is Healthy on it.


## What you need

- Docker, with about 5 GB of memory and a few CPU cores to spare for two kind
  clusters. On a busy machine, Argo CD's repo server can fail its health
  checks and restart, which slows every sync.
- `kind`, `kubectl`, `helm`, `git` and `jq`. The recorded runs used kind
  v0.31.0 with Kubernetes v1.35.0.
- [Kubara](https://github.com/kubara-io/kubara) v0.15 or newer. The lab has run on v0.15.0 and v0.16.0.
- The `cub` CLI, v0.8.2 or newer, and the plugin: `cub plugin install confighub/kubara-confighub`.
  The plugin from 0.3.0 on needs ConfigHub v0.8.0 or newer too, and from
  0.4.0 on v0.8.2 or newer for live status.
- A ConfigHub organization, for `run.sh` only. `up.sh` needs no account.
  `run.sh` writes to the organization your current `cub` context points at;
  set `CUB_CONTEXT` to choose another.

## What up.sh builds

| Step | What happens |
| --- | --- |
| 1 | Two kind clusters, `kubara-hub` and `kubara-spoke`. |
| 2 | `cub kubara init` writes Kubara's `config.yaml`, with a hub called `hub` in stage `dev` and a spoke called `spoke` in stage `prod`. `kubara generate --helm` generates the platform. |
| 3 | The platform goes into a Git repository, which is copied onto the hub's node. |
| 4 | A small Git server in the hub serves it at `http://git.git-server.svc.cluster.local/platform.git`. |
| 5 | `kubara bootstrap` runs for the spoke, for its CRDs, and then for the hub, which installs Argo CD and Kubara's ApplicationSets. |
| 6 | The spoke joins the hub's Argo CD. |
| 7 | Argo CD delivers cert-manager, metrics-server and Traefik to both clusters, and the homer dashboard to the hub, all from Git. |

Two steps stand in for things a real platform has.
- **The Git server.** A real platform reads from GitHub or GitLab. The lab
  serves the repository from inside the hub, so it needs no account and no
  network access to your Git host.
- **The spoke's registration.** Kubara registers a spoke with an
  ExternalSecret, which reads the spoke's kubeconfig from your secret store.
  The lab has no secret store, so `up.sh` writes the Secret that ExternalSecret
  would, with the same name and labels.

Everything else is Kubara's own: its `config.yaml`, its generated charts, its
bootstrap, its AppProject and its ApplicationSets.

## What run.sh does

| Section | What happens |
| --- | --- |
| 1 | `cub kubara plan` shows what ConfigHub will hold. It needs no account and changes nothing. |
| 2 | `cub kubara apply` renders each cluster with its own capabilities, and `apply.sh` creates 6 components and 10 variants in ConfigHub. |
| 3 | `cub kubara handover` writes `handover.sh`, which releases every variant, points Kubara's ApplicationSets at ConfigHub, and installs argobot on the hub. |
| 4 | `cub kubara check` confirms that each cluster runs the release its stage approved. |
| 5 | The newest release of each variant Space shows its live status, which argobot records on the release Argo CD synced: sync and health. |
| 6 | Two metrics-server replicas, changed once on the base, and released to dev. `check` fails for metrics-server until Argo CD pulls the release, then passes it. The spoke keeps one replica. |
| 7 | The same change is promoted, approved and released in prod. `check --record` writes each result into ConfigHub. |
| 8 | prod now waits for dev to be Healthy. Three replicas reach dev. Until Argo CD syncs the release it holds no live status, and ConfigHub refuses the promotion; prod accepts it once dev reports Healthy for that release. |
| 9 | An image that does not exist reaches dev. dev turns Degraded, and ConfigHub refuses to promote the change to prod. The change is then taken back out. |

`run.sh` creates Spaces named `kubara-*` in your organization. `PREFIX=<name>`
chooses another prefix.

With `APPROVE_STAGES=dev`, section 3 changes. `handover.sh` approves only
dev's first releases. It stops before prod, before it changes the hub, and
prints a `cub variant approve` command for each release. On a real platform
someone else runs those commands. The lab has one person, so `run.sh` runs
them itself. Then it runs `handover.sh` again, which resumes the same change
orders and hands the hub over. The [recorded run](run-approve-2026-09-30.log)
shows it.

## What upgrade.sh does

| Section | What happens |
| --- | --- |
| 1 | `config.yaml` moves to Kubara's bootstrap 5.0.1 and general 5.1.0 catalogs. `kubara generate --helm` regenerates the platform, and it is pushed to the lab's Git server. |
| 2 | `cub kubara plan` shows the new chart versions. |
| 3 | `cub kubara apply` and `apply.sh` run again. Each base whose render changed takes the difference as one change, in a change order: argo-cd, bootstrap-crds, cert-manager and traefik. The argo-cd base keeps the routing handover gave it. |
| 4 | traefik v3.7.13 goes to dev, through its change order. The spoke keeps v3.7.12. |
| 5 | The same upgrade goes to prod, after its own approval. |

The argo-cd change order waits. On kind the hub's argocd Application never
finishes a sync, because its Ingress gets no address, so an Argo CD upgrade
cannot land there. The [recorded run on Kubara v0.16](run-v0.16-2026-09-30.log)
shows it.

## What rebootstrap.sh does

People who run Kubara run `kubara bootstrap` on the hub again, for instance
after they change Argo CD's settings. `rebootstrap.sh` shows what that does
to a hub that has been handed over, after `run.sh`.

| Section | What happens |
| --- | --- |
| 1 | Every routed ApplicationSet reads ConfigHub, and metrics-server runs the replicas ConfigHub released. |
| 2 | `kubara bootstrap` runs on the hub again, as in `up.sh`. |
| 3 | Bootstrap has written Kubara's Git sources back into every routed ApplicationSet. Argo CD reads them first, so every Application syncs from Git, and metrics-server goes back to Git's one replica. `cub kubara check` fails each variant, because it lists Git sources. |
| 4 | `handover.sh` again. Every release is already published, so it checks that nothing would be pruned and removes the Git sources again. Every Application reads ConfigHub, and metrics-server runs ConfigHub's replicas again. |

The [recorded run](rebootstrap-2026-09-30.log) followed the
[run with a second approver](run-approve-2026-09-30.log) on the same clusters.

## What handback.sh does

| Section | What happens |
| --- | --- |
| 1 | It records a hash of every Secret on both clusters, and every object the Applications manage. |
| 2 | `cub kubara handback` writes `handback.sh`, which checks that Argo CD would prune nothing, points each ApplicationSet back at Kubara's Git, and removes argobot and the gateway credential. |
| 3 | Git delivers what it holds: metrics-server goes back to one replica. Every Secret keeps its value, and no object is pruned. |
| 4 | A new commit in the lab's Git server reaches the hub. |

ConfigHub keeps every Space and release, so `bash kubara-lab/confighub/handover.sh`
hands the hub over again. The [recorded hand-back](handback-2026-09-30.log)
followed the recorded run on the same clusters.

## What to expect on kind

Some Applications never turn fully green on kind. None of it affects the
story, but `check` judges health, so it says so.
- cert-manager is Degraded, because Let's Encrypt refuses the `example.com`
  contact address: its ClusterIssuer cannot register an ACME account. Run
  `up.sh` with `EMAIL=<your address>` to make it Ready; the lab then registers
  that address with Let's Encrypt's staging server.
- Traefik is Progressing, because kind has no load balancer to give it an
  address.
- The hub's argocd Application is Degraded and never finishes its sync,
  because it waits for an Ingress address. Dex restarts, because the lab has
  no single sign-on.

So on kind, `check` fails each Application that is Degraded, such as
cert-manager. It says "not yet" for each one that is Progressing, such as
Traefik. It exits non-zero, and `run.sh` carries on. With `--record` it
records a rejection for each Degraded Application, and nothing for one that is
Progressing. The recorded runs of [2026-09-28](run-2026-09-28.log) and
[2026-09-30](run-2026-09-30.log) used a `check` from before health was judged,
which passed each of them.

## Remove it

```bash
bash examples/kind-lab/down.sh                  # the clusters and the lab directory
CONFIGHUB=yes bash examples/kind-lab/down.sh    # and the lab's kubara-* Spaces
```

## Settings

| Variable | Default | What it sets |
| --- | --- | --- |
| `LAB` | `./kubara-lab` | where the platform, the kubeconfigs and the scripts' output go |
| `HUB`, `SPOKE` | `hub`, `spoke` | the Kubara cluster names |
| `KIND` | `kubara` | the prefix of the kind clusters, `<KIND>-<HUB>` and `<KIND>-<SPOKE>` |
| `EMAIL` | `lab@example.com` | the ACME contact of cert-manager's ClusterIssuer; `up.sh` only |
| `SERVICES` | `cert-manager,metrics-server,traefik,homer-dashboard` | the Kubara services `init` enables |
| `PREFIX` | `kubara` | the prefix of the Spaces `run.sh` creates |
| `APPROVE_STAGES` | empty: every stage | the stages `handover.sh` may approve, passed to `handover --approve-stages`; `run.sh` only |
| `NODE_IMAGE` | `kindest/node:v1.35.0` | the kind node image |
