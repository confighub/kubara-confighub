# Run a Kubara platform through ConfigHub with cub kubara

`cub kubara` is a plugin for the ConfigHub CLI. It takes a Kubara platform,
either one you are about to create or one Kubara has already generated, and
shows what ConfigHub would hold for it: a base for each component, a variant
for each cluster it runs on, and the order a change rolls out in. That much
works offline, with no account and no cluster, and changes nothing. When you
are ready, it writes the cub steps that bring the platform into ConfigHub as
one script you read before you run it.

Kubara keeps doing what it does. Its catalogs stay the source of every
component, and Kubara still generates the platform. The ConfigHub Workshop
Catalog adds evidence: where it has checked the exact chart version Kubara pins,
the plan links to what that chart installs and what it needs.

## How Kubara, cub kubara and Workshop stacks fit together

Three pieces meet here, and each has one job.

**Kubara generates the platform.** You write a `config.yaml` that chooses services
from Kubara's catalogs. `kubara generate` writes a wrapper chart for each service
and each cluster's values. Kubara's hub Argo CD then delivers to every cluster
through ApplicationSets. Kubara knows nothing about ConfigHub.

**`cub kubara` is for people who run Kubara.** It governs a Kubara platform in
ConfigHub without changing how Kubara works. Your path is:

```text
kubara generate  →  cub kubara plan  →  cub kubara apply  →  cub kubara handover
```

Kubara generates. `cub kubara` puts the result under ConfigHub's governance, as a
base for each component and a variant for each cluster, with an approval before
each release. `handover` then points Kubara's hub at the approved releases.
`handover` is still a draft (#13). There is no stack step on this path.

`cub kubara apply` renders each service the way Kubara's hub delivers it. It uses
the chart its ApplicationSet names, with the same release name, namespace and
values files, in the same order. bootstrap-crds becomes the CRDs `kubara bootstrap`
applies, and nothing else. It uses `helm` today. Once `cub helm template` can declare
capabilities ([confighub/cub-helm#2](https://github.com/confighub/cub-helm/issues/2)),
it uses `cub helm` and writes the certified bundle shape directly.

**Workshop stacks serve a different job:** using a Kubara platform as a stack,
rather than governing it the way Kubara runs it. Reach for `cub stack` when you
want to:

- check the platform before anything runs, for components that conflict, CRD
  order, and webhooks that need a certificate;
- compose apps onto it with `cub app`;
- publish it as OCI, or place it on clusters without Kubara's hub Argo CD;
- produce a platform on demand, when someone asks their AI for one. Kubara is one
  way to produce it, and the result is a stack like any other.

`cub stack from-kubara` makes that stack. Today it makes one stack per cluster;
one stack for the whole platform, a hub and its spokes, is next
([confighub/cub-workshop#59](https://github.com/confighub/cub-workshop/issues/59)).

The two tools share only the renderer and the certified bundle format. The rules
they share are in
One flattening model for every plugin, in review as
[confighub/helm-expt#2000](https://github.com/confighub/helm-expt/pull/2000).

## Install

```bash
cub plugin install confighub/kubara-confighub
cub kubara version
```

## See what a Kubara catalog offers

```bash
cub kubara services
```

This lists the services in Kubara's 3.0 catalogs, the default for Kubara v0.16.
The bootstrap catalog's services are always installed. You choose from the
general catalog's services. Under each service is the upstream chart and version
Kubara pins, with what the Workshop Catalog says about it:

- **checked** links to the Workshop page for that exact version;
- **Workshop has 41.0.2** means the Workshop has checked a different version of
  the same chart, not the one Kubara pins;
- **unchecked** means the Workshop Catalog has no entry for that chart.

Add `--catalog-version 5.1.0` for Kubara's newest catalogs, or
`--catalog-version 1.1.0` for the ones the committed examples use.

## Start a new platform

```bash
cub kubara init --out my-platform \
  --services cert-manager,metrics-server,traefik \
  --hub hub-dev:dev --spoke edge-staging:staging --spoke edge-prod:prod \
  --repository https://github.com/acme/platform.git
```

`init` writes three files into `my-platform`:

- `config.yaml`, Kubara's own configuration, with the catalogs pinned and your
  services enabled on each cluster that can run them;
- `.env.example`, with placeholders only and no secret;
- `confighub-intent.yaml`, a record of the catalogs, the chart version each
  service pins, and the Workshop evidence for each.

A Kubara config has exactly one hub, and `init` refuses a second. It also
refuses to overwrite an existing `config.yaml`. A service that runs only on the
hub, such as `homer-dashboard`, is left out of the spokes, and `init` says so.

Then let Kubara generate the platform:

```bash
cp my-platform/.env.example my-platform/.env   # then fill in the values it asks for
kubara --work-dir my-platform --config-file config.yaml --env-file .env generate --helm
```

## See the plan

```bash
cub kubara plan my-platform
```

`plan` reads a Kubara work directory or a `config.yaml`. When Kubara has already
generated the platform, it reads the exact chart versions Kubara wrote.
Otherwise it takes them from the catalog. For this example the plan shows three
stages, dev, staging and prod, from each cluster's `stage` field. Each
component gets a base and a variant for every cluster it runs on. Every chart is listed with its evidence, and a summary line counts
how many were checked at the exact version.

Kubara's hub, AppProject and ApplicationSets stay as Kubara generates them:
the hub's Argo CD delivers to the spokes. `plan` exits non-zero when it finds
something to fix first, such as two hubs, a service the catalog does not
define, or a hub-only service on a spoke.

Pass `--stages dev,canary,prod` to set the stage order yourself, and
`--prefix` to change the prefix of everything the plan would create.

## Bring the platform into ConfigHub

Once Kubara has generated the platform, `apply` renders every cluster and
writes the steps as a script:

```bash
cub kubara apply my-platform --out my-platform-confighub
less my-platform-confighub/apply.sh
bash my-platform-confighub/apply.sh
```

`apply` renders each cluster the way Kubara's hub delivers it, so each render
holds exactly the objects Kubara's Argo CD runs there. It needs `helm` on your
PATH. It runs nothing in ConfigHub itself.

Argo CD renders each chart with the target cluster's Kubernetes version and the
APIs it serves. To render the same way, give `apply` a kubectl context for each
cluster:

```bash
cub kubara apply my-platform --out my-platform-confighub \
  --capabilities hub-dev=<hub context> --capabilities edge-prod=<spoke context>
```

Without `--capabilities`, a cluster renders with Helm's default capabilities and
the CRDs bootstrap-crds provides, and `apply` says so. It writes `apply.sh`, the plan it carries out as `plan.txt`, and a
directory per component holding its renders and its rollout workflow.

The script creates a component, a base Space and a rollout workflow for each
Kubara component. The base holds the render of the cluster in the earliest
stage that runs it. The workflow orders the stages, holds each one until the
stage ahead has released, and asks for an approval before each release. Then
the script creates a variant for each cluster. A variant whose cluster renders
differently records that render as its first change, described as Kubara's
values for that cluster. You can run the script again safely. It skips what
exists and leaves alone any change made in ConfigHub since, except that it sets
a workflow's stages and approval rule back to the plan's when they differ, as
when a cluster joins in a new stage or you pass `--allow-authors=false`.

Secret values stay out of ConfigHub. A chart can generate a credential at
render time, as Kubara's bundled Grafana does with its admin password, so every
Secret goes to ConfigHub with its keys and without its values. `apply` and the
top of `apply.sh` name each Secret it emptied. The values belong in the
cluster's secret store.

The script creates no Targets and releases nothing. Kubara's hub, AppProject
and ApplicationSets keep delivering from Git. To change the platform, edit a
base, then move the change through the stages with `cub changeorder create`,
`cub variant promote` and `cub variant approve`.

`cub stack check` looks at one cluster's render for conflicts between
components, CRD ordering, API versions, webhooks that need a certificate, and
namespaces, offline:

```bash
cub stack from-kubara my-platform --cluster hub-dev --out hub-dev
cub stack check hub-dev/stack.yaml
```

## What this version does not do yet

`cub kubara handover`, in draft as #13, will point Kubara's hub at the releases
ConfigHub has approved, so a change reaches a cluster only after its stage
approves it. Until then, the committed scripts in this repository show an older
kind of handover, where each cluster runs its own reconciler; see
[the six-step tutorial](../demo/kubara/adoption.md).

## Refresh the plugin's data

The plugin carries a snapshot of Kubara's catalogs and of the Workshop Catalog,
so it can answer offline. To refresh it:

```bash
go run ./tools/snapshot -helm-expt ../helm-expt
go test ./internal/plan -update   # review the changed golden files
```
