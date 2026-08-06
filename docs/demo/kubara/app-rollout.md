# Historical Kubara v0.12.0 app rollout

> **Compatibility record.** This page records the earlier adapted four-cluster
> live rollout. It remains evidence for promotion, approval, rollback, and
> target departures, but it does not establish current Kubara v0.13.0 component
> versions. Start with the
> [current reproducible mini-IDP guide](single-platform.md).

> **Delivery authority superseded.** The force-sync behavior below is accurate
> for this retained v0.12 proof, but it is not the current adapted-lane design.
> The v0.13 lane leaves `spec.syncPolicy.automated` absent, treats
> `targetRevision: latest` as discovery-only, pins argobot to refresh-only
> Kubernetes mode, and lets the ConfigHub reconciler submit only the exact
> revalidated release `ManifestDigest` with Kubernetes identity
> compare-and-set. Use the current guide for operational adoption.

This example shows two things. First, ConfigHub manages Argo CD across four
clusters and rolls out, promotes, and rolls back an app for the operator. Second,
a real Kubara-generated platform (cert-manager and traefik) is delivered the same
way on one cluster, and the app runs on it and uses it: reachable through the
platform's ingress with a cert-manager certificate. `cub cluster up` provides the
Argo CD that owns delivery on each cluster.

## What ran

`cub cluster up` created four kind clusters: `hx-app-dev`, `hx-app-staging`,
`hx-app-prod-a`, and `hx-app-prod-b`. On each cluster it installed Argo CD and
argobot. In this historical proof, argobot is a ConfigHub bot that force-syncs
the matching Argo CD Application the moment a release is published. That
historical mechanism is preserved as evidence, not recommended as the current
deployment-authority model.

The app is a small nginx service. It is stored as three literal-YAML Units, one
resource per Unit: a Namespace, a Deployment, and a Service. The base Space
`hx-web-base` holds the reviewed app.

## The delivery path

Each cluster receives the app the same way:

1. `cub variant create` clones the base into a per-cluster Space bound to that
   cluster's Argo target, and auto-creates the cluster's Argo CD Application.
2. `cub release publish` bundles the Space's Units as an OCI release.
3. Argo CD pulls that exact release, and argobot force-syncs it.

The promotion chain is `base -> dev -> staging -> prod-a` and `prod-b`.

## What the run proved

- **Initial rollout.** The app reached all four clusters. Every Argo CD
  Application reported `Synced/Healthy` at 2/2 pods.
- **Fleet promotion.** One change in the base, `set-replicas 2 -> 3`, promoted
  through dev and staging, then to both production clusters as one wave. All four
  clusters reached 3/3.
- **Rollback.** A revision restore returned `prod-a` to 2/2 while `prod-b` stayed
  at 3/3.
- **Optional staging sandbox.** A `SANDBOX_URL` env var was added to staging
  only. It appeared on the staging cluster and was absent on dev and both
  production clusters.
- **Departures survive promotion.** A later base annotation was promoted into
  staging. Staging kept its `SANDBOX_URL` while adopting the annotation.

Production Units carry `prod-critical` delete and destroy gates.

## The app on a real Kubara platform

The rollout above shows delivery. This part shows the app running on an actual
Kubara-generated platform and using it.

Two Kubara platform services were rendered from Kubara's own generated umbrella
charts and delivered to all four clusters through the same ConfigHub path, one
variant Space per cluster:

- **cert-manager** `v1.21.0` — three Deployments Running on each cluster.
- **traefik** `41.0.2` — one Deployment Running on each cluster, with its
  `traefik` IngressClass.

The app then used the platform on every cluster. A traefik `Ingress` routes
`hx-web.local` to the app's Service. A cert-manager `Certificate` issued the
app's TLS certificate (`Ready=True`, SAN `DNS:hx-web.local`). On all four
clusters an HTTPS request through traefik returned `HTTP 200` and the nginx page,
served with the cert-manager certificate rather than traefik's default.

Bringing these up taught the platform's shape. Kubara's charts assume the whole
platform exists: they guard their `ServiceMonitor` behind the Prometheus-operator
CRD, and cert-manager's `ClusterIssuer` is a custom resource that needs its CRD
established first. So the bring-up order is CRDs, then controllers, then custom
resources.

## What this does not prove

This proof delivered cert-manager and traefik on all four clusters. The fuller
platform (all seven Kubara services, and monitoring) is covered in the
[single-platform write-up](single-platform.md). Kubara's ClusterIssuer is
Let's Encrypt ACME, which needs a public-reachable ingress, so a self-signed
issuer was used for TLS on kind. The app is a minimal nginx service, not a
production workload.

## Production requires approval

The two production clusters carry a require-approval gate. A Trigger in the
`hx-platform` Space runs `vet-approvedby`, attached to the production Spaces
through a Filter. When a change is promoted to production, `cub release publish`
is refused with `HTTP 422` until every Unit in the Space is approved. After a
`cub unit approve`, the release publishes and argobot delivers it. The gate
covers every Unit in the Space, so a namespace or service Unit must be approved
alongside the workload.

## Check the evidence

The [committed receipt](../../../runs/kubara-app-rollout-proof/receipt.yaml)
records the clusters, Spaces and their IDs, the OCI release digest for each
cluster, the promotion and rollback steps, argobot health, and the final fleet
state.

```bash
npm run kubara-app-rollout:verify
```
