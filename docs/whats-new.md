# What's new in cub kubara

`cub kubara` brings a platform Kubara generates into ConfigHub, without
changing how Kubara works. Each Kubara component gets a base, each cluster
gets a variant, and after handover Kubara's hub delivers only what each
stage approved. The [guide](user/cub-kubara.md) is the full walkthrough.

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
