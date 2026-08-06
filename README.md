# Kubara on ConfigHub

This repository shows how a [Kubara](https://github.com/kubara-io)-generated platform runs through [ConfigHub](https://confighub.com): the native config stays the input, every generated file is imported at an exact Git revision, and delivery becomes governed releases with receipts you can verify.

Kubara keeps what it is good at. It selects components from its catalogs, wires a hub and spokes, and generates the platform files. ConfigHub adds what teams ask for next: component identity with retained versions, approvals before production, exact-digest releases, one-target rollback, drift repair, a fleet matrix, and queryable wiring. Argo CD remains the cluster reconciler on every target.

## Read the journey

The six-step adoption tutorial starts at [docs/demo/kubara/adoption.md](docs/demo/kubara/adoption.md):

1. [Choose the platform in native Kubara config](docs/demo/kubara/adoption-1-choose.md)
2. [Run Kubara and verify the generated platform](docs/demo/kubara/adoption-2-generate.md)
3. [Commit the exact hand-off to Git](docs/demo/kubara/adoption-3-git.md)
4. [Compile per-component OCI packages and the digest index](docs/demo/kubara/adoption-4-oci.md)
5. [Import into a selected ConfigHub organization](docs/demo/kubara/adoption-5-confighub-org.md)
6. [Add, promote, approve, and roll back applications](docs/demo/kubara/adoption-6-apps.md)

The [GUI tour](docs/demo/kubara/gui-tour.md) walks the same platform through the ConfigHub interface in six receipt-bound frames. The [checkpoints ledger](docs/demo/kubara/checkpoints.md) records what is machine-proven and what remains gated.

## Try it without any accounts

Every step has a deterministic self-test that runs against fake Git, OCI, and ConfigHub surfaces. No cluster, registry, or ConfigHub account is needed:

```sh
npm run kubara-adoption:self-test
```

## Copy it

Start from [examples/kubara/current-platform/source/config.yaml](examples/kubara/current-platform/source/config.yaml) and the request templates in [examples/kubara/git-import/](examples/kubara/git-import/). Each adoption chapter names the command that consumes each template and states its machine checkpoint before any live claim.

## Evidence discipline

Every screenshot, matrix cell, and measured number in these pages binds to a committed receipt by SHA-256. Receipts live in [runs/](runs/) and [data/](data/), and the offline verifiers prove them:

```sh
npm run kubara-mini-idp:receipt-verify
npm run kubara-mini-idp:performance:receipt-verify
npm run kubara-mini-idp:orphan-audit:receipt-verify
npm run kubara-platform-matrix:verify
npm run kubara-wiring:verify
```

A screenshot never replaces a machine checkpoint. Missing or stale evidence stays visible instead of becoming a marketing claim.

## Boundary with helm-expt

The Helm chart and config catalog stayed in [confighub/helm-expt](https://github.com/confighub/helm-expt); this repository carries only the Kubara work. Deep links inside the generated catalog evidence views under `data/kubara-catalog-release/recipe-views/` still point at catalog paths in that repository, and the vendored Kubara catalog snapshots keep their upstream-relative links byte-identical by contract. Every reader-facing page in `docs/` and `examples/` resolves inside this repository.

## Provenance

This project moved here from [confighub/helm-expt](https://github.com/confighub/helm-expt) at commit `6b4bc9d6b`, where its full development history remains public. Relative paths were preserved, so every receipt's path-and-digest binding verifies unchanged. The release-acceptance gates that referenced the helm-expt generated site are included but not yet re-targeted to this repository's pages.
