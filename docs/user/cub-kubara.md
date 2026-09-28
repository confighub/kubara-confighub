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

To see all of it before you use your own platform, run the
[kind lab](../../examples/kind-lab/README.md). It builds a Kubara hub and spoke
on your laptop and runs every step below against them.

## How Kubara, cub kubara and Workshop stacks fit together

Three pieces meet here, and each has one job.

**Kubara generates the platform.** You write a `config.yaml` that chooses services
from Kubara's catalogs. `kubara generate` writes a wrapper chart for each service
and each cluster's values. Kubara's hub Argo CD then delivers to every cluster
through ApplicationSets. Kubara knows nothing about ConfigHub.

**`cub kubara` is for people who run Kubara.** It governs a Kubara platform in
ConfigHub without changing how Kubara works. Your path is:

```text
kubara generate  →  cub kubara plan  →  cub kubara apply  →  cub kubara handover  →  cub kubara check
```

Kubara generates. `cub kubara` puts the result under ConfigHub's governance, as a
base for each component and a variant for each cluster, with an approval before
each release. `handover` then points Kubara's hub at the approved releases, and
`check` confirms that each cluster runs them. There is no stack step on this path.

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

The two tools share only the renderer and the certified bundle format. See
[one flattening model for every plugin](https://github.com/confighub/helm-expt/blob/main/docs/reference/flattening-across-plugins.md)
for the rules they share.

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

## Hand the hub to ConfigHub

`handover` writes the steps that follow `apply.sh`. After them, a change reaches
a cluster only once its stage has approved and released it:

```bash
cub kubara handover my-platform --out my-platform-confighub --capabilities hub-dev=<hub context>
less my-platform-confighub/handover.sh
HUB_CONTEXT=<kubectl context of Kubara's hub> bash my-platform-confighub/handover.sh
```

Kubara's hub, AppProject and ApplicationSets stay. Each ApplicationSet whose
chart ConfigHub holds reads the cluster's approved release from ConfigHub's OCI
gateway instead of Git, and Kubara's own sync settings are kept. Argo CD 3.1 or
later reads those releases; Kubara v0.16 ships 3.5.

The script gives each cluster a Target and releases every variant through its
rollout workflow, stage by stage, with argo-cd last. On a re-run it skips a
component whose variants all have a release. A change made since then belongs
to your own change orders, and may be part way through its stages. argo-cd is
the exception, because the script changes its base. Its change order is named
after the base's revision, so a re-run releases a routing change that was not
released yet.

Then the script changes the hub. Before any change, it compares what each
Application manages with the release it will read. Kubara's ApplicationSets
prune, so the script stops if Argo CD would delete anything. It then makes
these changes:

1. It stores one credential for the gateway, scoped to your prefix's Spaces.
2. It applies the AppProject your ApplicationSets use, so that it permits the
   gateway. Kubara's AppProject lists no sources, because its Git repository
   is scoped to the project. The script gives it a list that holds only the
   gateway, and the Git repository stays permitted.
3. It applies each routed ApplicationSet and removes its Git sources. Kubara's
   bootstrap owns those fields, so an apply alone leaves them, and Argo CD
   reads them before the ConfigHub source.
4. It stops any sync Argo CD started from Git and has not finished. After the
   switch, such a sync can never finish, because Argo CD retries it against the
   ConfigHub source. The script stops it, as `argocd app terminate-op` does,
   and the automated sync starts again from ConfigHub.
5. It waits until every Application reads ConfigHub. If one does not, the
   script names it and stops. It is safe to run again.

Secrets keep their live values. ConfigHub holds each Secret's keys, and each
ApplicationSet tells Argo CD to leave Secret data alone. A cluster that joins
later gets its Secrets without values, for its secret store to fill. A manual
sync must keep `RespectIgnoreDifferences`, which Kubara's sync options include.
A sync without it empties those values.

bootstrap-crds is installed by Kubara's bootstrap, not by an ApplicationSet,
so it stays with Kubara.

`handover.sh` has been run against a live Kubara hub and spoke on kind, with
Kubara v0.15.0 and Argo CD 3.5.2. Every Application synced from ConfigHub, and
nothing was pruned. No workload restarted, and every Secret kept its value. The
first runs found the Git sources, AppProject and Git sync problems above, and
the script now handles each. See the
[first live run](../../examples/cub-kubara/lab-handover-2026-09-28.log) for how
they were found, and the [kind lab](../../examples/kind-lab/README.md) to run it
yourself.

## Change the platform after handover

After handover you change the platform with ConfigHub's own commands. Make a
change once, on the base, and take it through the stages. Here, two replicas
for metrics-server:

```bash
cub function set --space kubara-metrics-server-base --unit metrics-server \
  --change-desc "Run two metrics-server replicas" set-replicas 2
cub changeorder create --space kubara-metrics-server-base two-replicas \
  --change-workflow kubara-metrics-server-base/rollout --description "Two metrics-server replicas"
```

In each stage, promote the change, approve it, and publish each variant's
release:

```bash
cub variant promote --change-order kubara-metrics-server-base/two-replicas --target-stage dev
cub variant approve --change-order kubara-metrics-server-base/two-replicas --stage dev
cub release publish kubara-metrics-server-hub --revision ChangeOrder:kubara-metrics-server-base/two-replicas
```

Kubara's hub pulls the new release within a few minutes, and `check` confirms
it. Then do the same for prod. ConfigHub refuses to promote into a stage before
the stage ahead has released the change.

A change that comes from Kubara itself, such as a new catalog version, is not
automatic yet. `apply.sh` leaves alone what already exists, so it does not
replace a base. Run `kubara generate` and `cub kubara apply` again, then bring
each new render into its base as a change you review, and take it through the
stages as above:

```bash
cub unit update --space kubara-metrics-server-base metrics-server \
  my-platform-confighub/metrics-server/base.yaml --change-desc "Kubara catalog 3.1.0"
```

## Check that each cluster runs what was approved

`check` looks at Kubara's hub and says, for each variant, whether the cluster
runs the release ConfigHub approved. It changes nothing on the hub:

```bash
cub kubara check my-platform --hub-context <hub context>
```

A variant passes when all of these are true:

- One Application reads the variant's release from ConfigHub, and no Git source.
- Argo CD has synced the latest published release. `check` compares the digest
  Argo CD synced with the release's digest.
- Argo CD would delete nothing. Helm hooks do not count, because Argo CD runs
  them as hooks and never prunes them.
- A sync leaves live Secret values alone.

`check` shows each Application's health, but does not judge it. Health depends
on the cluster as much as on the release. A variant that no ApplicationSet
delivers, such as bootstrap-crds, is skipped.

Run it after a release, when Argo CD has had time to sync. Until then it
reports the release Argo CD has not pulled yet:

```text
kubara-metrics-server-hub: FAIL: Argo CD runs sha256:4036b0725aa0, and the latest release, 2, is sha256:4350343dd3b4
```

With `--record`, `check` records each verdict in the variant's Space as a
`LiveCheck` attestation on the released revisions. A failed check records a
rejection that names what is wrong. `--type` sets another attestation type.

## If something goes wrong

| You see | What it means | What to do |
| --- | --- | --- |
| `Argo CD would delete the objects above` from `handover.sh` | The release a cluster would read lacks objects Argo CD manages there today. | Look at the named objects. Usually the render differs from what Kubara delivers: rerun `apply` with `--capabilities` for that cluster. Rerun with `ALLOW_PRUNE=yes` only if the deletion is what you want. |
| `Some Applications do not read ConfigHub yet` | An ApplicationSet has not caught up, or something wrote its Git sources back. | Run `handover.sh` again once the hub is idle. It is safe to run again. |
| `InvalidSpecError ... is not permitted in project` on an Application | The AppProject does not permit the gateway. | Run `handover.sh` again; it applies the AppProject first. |
| `check` says `a sync Argo CD started from Git is still running` | A sync from before the switch cannot finish. | Run `handover.sh` again; it stops such a sync. |
| `check` says `Argo CD runs …, and the latest release … is …` | Argo CD has not pulled the newest release yet. | Wait a few minutes, or refresh the Application in Argo CD, then run `check` again. |
| Secret values empty after a manual sync | The sync left out `RespectIgnoreDifferences`. | Restore the values from your secret store, and keep the option on every manual sync. |

## Refresh the plugin's data

The plugin carries a snapshot of Kubara's catalogs and of the Workshop Catalog,
so it can answer offline. To refresh it:

```bash
go run ./tools/snapshot -helm-expt ../helm-expt
go test ./internal/plan -update   # review the changed golden files
```
