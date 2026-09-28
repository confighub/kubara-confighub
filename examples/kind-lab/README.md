# The kind lab: a Kubara platform on your laptop, handed to ConfigHub

This lab runs the whole `cub kubara` story on two kind clusters. Kubara
generates and bootstraps a hub and a spoke, and the hub's Argo CD delivers
every service from Git, as it would on a real platform. Then `cub kubara` puts
the platform into ConfigHub, hands the hub over, and takes one change to dev
and then prod.

```bash
bash examples/kind-lab/up.sh     # the Kubara platform, about 10 minutes
cub auth login
bash examples/kind-lab/run.sh    # the cub kubara story, about 6 minutes
bash examples/kind-lab/down.sh   # remove it
```

The [recorded run](run-2026-09-28.log) shows each command and what it printed,
from scratch, with `cub kubara` v0.2.2.


## What you need

- Docker, with about 5 GB of memory and a few CPU cores to spare for two kind
  clusters. On a busy machine, Argo CD's repo server can fail its health
  checks and restart, which slows every sync.
- `kind`, `kubectl`, `helm`, `git` and `jq`.
- [Kubara](https://github.com/kubara-io/kubara) v0.15 or newer.
- The `cub` CLI and the plugin: `cub plugin install confighub/kubara-confighub`.
- A ConfigHub organization, for `run.sh` only. `up.sh` needs no account.

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
| 3 | `cub kubara handover` writes `handover.sh`, which releases every variant and points Kubara's ApplicationSets at ConfigHub. |
| 4 | `cub kubara check` confirms that each cluster runs the release its stage approved. |
| 5 | Two metrics-server replicas, changed once on the base, and released to dev. `check` fails until Argo CD pulls the release, then passes. The spoke keeps one replica. |
| 6 | The same change is promoted, approved and released in prod. `check --record` writes each result into ConfigHub. |

`run.sh` creates Spaces named `kubara-*` in your organization. `PREFIX=<name>`
chooses another prefix.

## What to expect on kind

Some Applications never turn fully green on kind, and none of it affects the
story.
- cert-manager is Degraded, because Let's Encrypt refuses the `example.com`
  contact address.
- Traefik is Progressing, because kind has no load balancer to give it an
  address.
- The hub's argocd Application is Degraded and never finishes its sync,
  because it waits for an Ingress address. Dex restarts, because the lab has
  no single sign-on.

## Remove it

```bash
bash examples/kind-lab/down.sh                  # the clusters and the lab directory
CONFIGHUB=yes bash examples/kind-lab/down.sh    # and the lab's kubara-* Spaces
```

## Settings

| Variable | Default | What it sets |
| --- | --- | --- |
| `LAB` | `./kubara-lab` | where the platform, the kubeconfigs and the scripts' output go |
| `HUB`, `SPOKE` | `hub`, `spoke` | the Kubara cluster names; the kind clusters are `kubara-<name>` |
| `SERVICES` | `cert-manager,metrics-server,traefik,homer-dashboard` | the Kubara services `init` enables |
| `PREFIX` | `kubara` | the prefix of the Spaces `run.sh` creates |
| `NODE_IMAGE` | `kindest/node:v1.35.0` | the kind node image |
