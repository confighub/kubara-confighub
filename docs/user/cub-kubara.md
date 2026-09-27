# Run a Kubara platform through ConfigHub with cub kubara

`cub kubara` is a plugin for the ConfigHub CLI. It takes a Kubara platform,
either one you are about to create or one Kubara has already generated, and
shows what ConfigHub would hold for it: a base for each component, a variant
for each cluster it runs on, a Target for each cluster, and the order a change
rolls out in. It works offline, with no account and no cluster, and changes
nothing.

Kubara keeps doing what it does. Its catalogs stay the source of every
component, and Kubara still generates the platform. The ConfigHub Workshop
Catalog adds evidence: where it has checked the exact chart version Kubara pins,
the plan links to what that chart installs and what it needs.

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
stages, dev, staging and prod, from each cluster's `stage` field. Each cluster
gets a Target, and each component gets a base and a variant for every cluster
it runs on. Every chart is listed with its evidence, and a summary line counts
how many were checked at the exact version.

Kubara's hub, AppProject and ApplicationSets stay as Kubara generates them:
the hub's Argo CD delivers to the spokes. `plan` exits non-zero when it finds
something to fix first, such as two hubs, a service the catalog does not
define, or a hub-only service on a spoke.

Pass `--stages dev,canary,prod` to set the stage order yourself, and
`--prefix` to change the prefix of everything the plan would create.

## Check what Kubara generated

`plan` ends by naming the next step. To check the platform Kubara generated,
use the ConfigHub Workshop plugin, one cluster at a time:

```bash
cub plugin install confighub/cub-workshop
cub stack from-kubara my-platform --cluster hub-dev
cub stack check my-platform/confighub/stack.yaml
```

`cub stack check` looks for conflicts between components, CRD ordering, API
versions, webhooks that need a certificate, and namespaces. It works offline.

## What this version does not do yet

- **Write the import as a script** (`cub kubara apply --out`). The committed
  scripts in this repository still do the import; see
  [the six-step tutorial](../demo/kubara/adoption.md).
- **Take over a running Kubara hub** (`cub kubara takeover`). The approval model
  will use attestations and a ChangeWorkflow, as `cub sveltos` does.

## Refresh the plugin's data

The plugin carries a snapshot of Kubara's catalogs and of the Workshop Catalog,
so it can answer offline. To refresh it:

```bash
go run ./tools/snapshot -helm-expt ../helm-expt
go test ./internal/plan -update   # review the changed golden files
```
