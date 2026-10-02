# What's new in cub kubara

`cub kubara` brings the add-ons Kubara manages for your clusters into
ConfigHub, without changing how Kubara works. Each Kubara component gets a base, each cluster
gets a variant, and after handover Kubara's hub delivers only what each
stage approved. The [guide](user/cub-kubara.md) is the full walkthrough.

## 0.3.0, 2026-10-02

`cub kubara` now works with ConfigHub v0.8.0 and `cub` v0.8.0, and `check`
asks ConfigHub through the SDK. Use `cub` and ConfigHub v0.8.0 or newer with
this release.

**`check` no longer runs `cub`.** `check` and `check --record` used to run
`cub release list` and `cub attestation create`, and read what they printed.
They now ask ConfigHub in the plugin's own process, through the ConfigHub SDK
(`core/cubapi` v0.8.0). This is the Kubara step of confighub/helm-expt#2063.
- What `check` prints, its verdicts, how it judges health, "not yet", and the
  attestation it records are the same as before: the same type, revision,
  claims and note.
- The login is the one `cub` passes a plugin, which is what you get when you
  run `cub kubara check`. `CUB_CONTEXT` still chooses another context. Run
  on its own, the plugin uses `CUB_SERVER` and `CUB_TOKEN`, or else `cub`'s
  current context.
- With no login, `check` says so and how to get one, instead of passing on an
  error from `cub`.
- `check` still runs `kubectl`, to read Kubara's hub.

**The scripts still use `cub`, on purpose.** `apply.sh`, `handover.sh` and
`handback.sh` are for you to read and then run, so every step in them is a
`cub` or `kubectl` command you can run yourself. helm-expt#2063 leaves open
whether that changes.

**Fixed for ConfigHub v0.8.0.** Three things `handover.sh` did stopped working:
- **Targets.** A Target no longer names a worker, a provider or parameters,
  and `cub target create` takes only its name. `handover.sh` now creates the
  server worker with `cub worker create --is-server-worker --org-role none`,
  and gives the worker's bot user View and ViewChildren on each cluster's
  Target, which is how Argo CD may pull the releases published for it. It no
  longer writes `worker.json`.
- **argobot.** argobot v0.1.7 found its Targets by the worker they named, and
  stopped at start-up with ``unrecognized attribute name `BridgeWorkerID` ``,
  so `handover.sh` failed at step 6 with "no live status yet". `handover.sh`
  now installs argobot v0.1.8, which finds its Targets by that grant.
- **Live status.** A worker used to be allowed to write to the Spaces that
  released to its Targets. Now it needs a grant, and argobot's writes were
  refused with `permission denied`. `handover.sh` gives the worker's bot user
  Edit on each variant Space, and on no other Space. Edit covers the Space's
  own fields, such as its annotations and labels; ConfigHub v0.8.0 has no
  narrower grant for the live status alone.

`check` also works around a fault in SDK core v0.8.0: its `ResolveClient`
reads `CUB_CONFIG`, which names `cub`'s config directory, as the config file.

Every other `cub` command the scripts run was checked against `cub` v0.8.0
and needed no change.

**What was run.** On the kind lab, with Kubara v0.16.0, `cub` v0.8.0 and
ConfigHub v0.8.0: `apply.sh`, all of `handover.sh`, `check`, argobot's live
status, and one change released to dev
([log](../examples/kind-lab/run-sdk-2026-10-02.log)). `check --record` wrote
a Pass and rejections on the same lab. The recording stops in section 6 of
`run.sh`. The promotion to prod and the stage gated on dev's health,
sections 7 to 9, have not run against ConfigHub v0.8.0 yet.

## 0.2.5, 2026-10-01

Every chart version Kubara's 3.0 catalogs pin is now checked in the
ConfigHub Workshop Catalog. The Workshop added the 14 that were missing,
published and signed (confighub/helm-expt#2052). `cub kubara services` and
`cub kubara plan` now show each 3.0 service as `checked`, with a link to its
chart page, where before most said which nearby versions the Workshop had.

The snapshot reads the Workshop Catalog at helm-expt `3e63edb`. The 5.x
catalogs gain the same versions wherever they pin them.

## 0.2.4, 2026-09-30

A cold read of the guide found six things to fix before handing the plugin
to someone outside ConfigHub. Each is fixed or tested here.

**A second person can approve handover's releases.** `handover.sh` used to
approve every first release, prod included, as the person who ran it.
`cub kubara handover --approve-stages dev` now names the stages it may
approve. `none` approves no stage. The default is still every stage.
- In another stage, it promotes each release and stops before publishing it.
  It prints one `cub variant approve` command per release, and exits 2
  before it changes the hub.
- It stops the same way where a workflow does not count its approval, as
  after `apply --allow-authors=false`.
- Run it again once someone else has approved. It resumes the same change
  orders, so it publishes what they approved. It skips what has released,
  and does not promote or approve a stage again.
- A re-run used to treat a change order as done once its last stage was
  promoted, even when prod's publish had failed. It now waits until every
  variant has released it.
- On the kind lab, handover stopped before prod. Each release got a second
  approval, and the second run handed the hub over
  ([log](../examples/kind-lab/run-approve-2026-09-30.log)).

**`kubara bootstrap` after handover, tested.** On a hub that has been handed
over, `kubara bootstrap` hands it back to Git without a word:
- It writes Kubara's Git sources back into every routed ApplicationSet.
- Every Application then syncs from Git. On the kind lab, metrics-server went
  from ConfigHub's three replicas to Git's one.
- `cub kubara check` names it: `it still lists Git sources`.
- Running `handover.sh` again is the whole recovery. On the kind lab,
  nothing was pruned, and metrics-server went back to three replicas
  ([log](../examples/kind-lab/rebootstrap-2026-09-30.log)).
- The guide now says to run `handover.sh` straight after any
  `kubara bootstrap`.

**`--stages` must name every stage.** A stage that `--stages` left out used
to go last, after prod, with no warning. `plan`, `apply`, `handover`, `check`
and `handback` now refuse it, and name the stage. They also refuse a stage
no cluster has, and a stage named twice. The default order is unchanged.

**Helm's error comes through.** When helm failed, `render` and `apply`
printed only `Use --debug flag to render out invalid YAML`. They now print
helm's own error, then the chart and each values file they passed.

**The work directory stays clean.**
- Rendering used to let helm write `charts/*.tgz` and `Chart.lock` into the
  platform's Git repository. Renders now read a copy of the charts.
- What helm fetched is cached in your user cache directory, under
  `cub-kubara/chart-dependencies`, until a chart changes.
- `cub kubara init` writes a `.gitignore` that keeps out `.env`, which holds
  the Argo CD password and a Git token, and the fetched charts. An existing
  `.gitignore` keeps every line, and gains only the lines it lacks.

**`init` refuses a second `--hub`.** It used to keep the last one and exit 0.

## 0.2.3, 2026-09-30

**Check judges health.** `cub kubara check --record` used to record a Pass
while Argo CD reported an Application Degraded. On the kind lab it did so for
cert-manager. Health is now part of the verdict.
- Degraded or Missing is a failure that names the Application, and `--record`
  writes a rejection.
- Progressing, or any other health that is not Healthy yet, is "not yet".
  `check` records nothing and exits non-zero, so run it again later.
- Each attestation carries the Application's health as a claim.
- `--record` stays off by default.

**Render.** `cub kubara render <kubara-dir> --out <dir>` renders each service
for each cluster the way Kubara's ApplicationSets deliver it. It writes each
service's objects and a manifest, `render.json`: each cluster's enabled
services, and each service's chart and version, values files, API versions,
object count and digest. It also names the one owner of each object two
services render. It uses the same renderer as `apply`, and contacts no
cluster and no ConfigHub server. `cub stack from-kubara` in the ConfigHub
Workshop is moving to it, so there is one way to render as Kubara delivers.
- Each rendered document now ends in one newline. Helm 4.3 leaves blank lines
  between documents that helm 4.1 does not, and a render no longer changes
  with them. This applies to `apply` renders too.

**Kubara's 5.x catalogs.** Tests now hold general 5.1.0 and bootstrap 5.0.1
to the same wiring as 3.0.0, in `services`, `init` and `plan`.

**Live status after handover.** `handover.sh` now installs argobot on the hub.
argobot writes each Argo CD Application's sync and health to its variant Space,
as `confighub.com/live-status`, so a stage can require `Healthy`. It runs as the
Targets' server worker, not as a person, and may read and patch only Argo CD
Applications. On the kind lab, prod refused a release that left dev Degraded.
- The status names the release Argo CD synced. Neither argobot nor the gate
  compares it with the latest release, so the gate can pass on the previous
  release's health for a few minutes. Run `check` on the stage ahead first.

**Hand the hub back to Git.** `cub kubara handback` writes `handback.sh`, which
points Kubara's ApplicationSets and AppProject back at Git, and removes argobot
and the gateway credential. It stops first if Argo CD would prune anything.
Secrets keep their live values. ConfigHub keeps every Space and release, so
`handover.sh` hands the hub over again.

**A new Kubara catalog, as a reviewed change.** Run `apply` and `apply.sh`
again after `kubara generate`. Each base whose render changed takes the
difference as one three-way merge that keeps changes made in ConfigHub, in a
change order for you to take through the stages.
- `apply.sh` used to create each base with `--allow-exists`, which with cub
  v0.6.8 merges a new render into an existing base with no change order. It now
  creates a base only once.

**Kubara v0.16.** The kind lab runs on Kubara v0.16.0 with no change to
`cub kubara`. There, catalogs bootstrap 5.0.1 and general 5.1.0 took traefik
v3.7.13 to dev, then prod. An Argo CD upgrade does not land on kind, because
the hub's argocd Application waits for an Ingress address that never comes.

**The kind lab.** `KIND` names its clusters, so a lab can run beside another,
and `EMAIL` sets cert-manager's ACME contact. `upgrade.sh` takes newer catalogs
through the stages, and `handback.sh` hands the hub back to Git. The recorded
runs are `run-2026-09-30.log`, `handback-2026-09-30.log` and
`run-v0.16-2026-09-30.log`.

## 0.2.2, 2026-09-28

**Handover stops a sync Argo CD started from Git.** On the kind lab, the
hub's argocd Application had a sync from Git still running at handover. On
kind that sync waits forever for an Ingress address. After the switch, Argo CD
retried it against the ConfigHub source and could never finish. `handover.sh`
now stops such a sync, as `argocd app terminate-op` does, and the automated
sync starts again from ConfigHub. It no longer carries on quietly after a
timeout.
- `cub kubara check` names a sync from Git that is still running, and says to
  run `handover.sh` again.
- The [kind lab](../examples/kind-lab/README.md) builds a Kubara hub and spoke
  on your laptop and runs the whole story.

## 0.2.1, 2026-09-28

**Running handover.sh again is safe mid-rollout.** A component whose variants
all have a release is skipped, because a change made since then belongs to
your own change orders. argo-cd is still checked, because handover changes its
base.

## 0.2.0, 2026-09-28

**Handover.** `cub kubara handover` writes `handover.sh`. It gives each
cluster a Target and releases every variant an ApplicationSet delivers, stage by stage. It then points
each of Kubara's ApplicationSets at the cluster's approved release in
ConfigHub, after checking that Argo CD would delete nothing. The first live
run found three faults, and each is fixed in this release. The
[log](../examples/cub-kubara/lab-handover-2026-09-28.log) shows them.
- Server-side apply kept the Git `sources` that Kubara's bootstrap owns, so
  the hub stayed on Git. The script now removes them.
- Kubara's AppProject lists no `sourceRepos`, because its Git repository is
  scoped to the project, so Argo CD refused the gateway. The script now gives
  the AppProject the gateway first.
- Each release's change order is named after the base's revision, so a
  routing change is released when the script runs again.

**Check.** `cub kubara check` says, for each variant, whether the cluster runs
the release its stage approved. With `--record` it writes each result into
ConfigHub as an attestation.

**Rendering the way Kubara delivers.** `apply` renders each service with the
release name, namespace and values order of Kubara's ApplicationSets, and
bootstrap-crds as CRDs only. `--capabilities <cluster>=<context>` renders with
each cluster's own Kubernetes version and APIs. Before this, a preview found
that Argo CD would have deleted 48 objects from the hub's own Argo CD.

## 0.1.0, 2026-09-28

The first release: `services`, `init`, `plan` and `apply`.
- `services` lists Kubara's catalog with the ConfigHub Workshop's evidence
  for each chart version.
- `init` writes a Kubara `config.yaml`.
- `plan` shows, offline, what ConfigHub would hold: a base per component, a
  variant per cluster, and stages from Kubara's `stage` field.
- `apply` writes `apply.sh`, which creates it all in ConfigHub. Secrets go in
  with their keys and without their values.
