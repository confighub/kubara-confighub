# workshop-platform

This folder is a small starting point for one Kubara development platform.
Kubara still chooses and generates the platform. Config Workshop records the
exact component versions and links each one to its checked Catalog material.

## 1. Review the platform choice

Open `config.yaml`. It defines one hub cluster, workshop-dev, and enables
cert-manager, metrics-server, traefik. Every other built-in service is disabled explicitly,
so a future catalog default cannot add a component without a visible diff.

Open `source-and-intent.yaml` next. It records the Kubara and catalog versions,
the exact Helm components selected by Kubara, and the Config Workshop pages for
their configurations and evidence. Kubara does not read this companion file.

## 2. Generate the platform

Review `.env.example`, create a private `.env`, and replace every placeholder.
Do not commit credentials.

```sh
kubara --work-dir . --config-file config.yaml --env-file .env generate --helm
```

Kubara writes `platform-components/` and `platform-configs/`. Review that output
before committing it.

## 3. Check what must happen around the YAML

List the generated CRDs, Helm hooks, setup Jobs, Secrets, certificate issuers,
storage classes, and required APIs. Decide who owns each one and how success will
be checked. The component links in `source-and-intent.yaml` show the matching
Config Workshop investigations, but the final answer must match this generated
platform and its target cluster.

## 4. Keep and promote the reviewed result

Commit the complete generated hand-off to Git. You can then package the exact
revision as OCI and load it into ConfigHub without changing Kubara's role.
ConfigHub adds retained versions, diffs, approvals, promotion, releases, and fleet
status. Argo CD remains the cluster reconciler.

Start with the [Kubara and ConfigHub tutorial](https://confighub.github.io/helm-expt/site/kubara.html).
