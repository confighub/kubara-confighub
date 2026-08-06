# Historical Kubara v0.12.0 platform configuration

> **Compatibility record.** This page preserves the original Kubara v0.12.0
> one-cluster proof. For the current, four-cluster, reproducible Kubara v0.13.0
> adoption path, start with
> [Adopt Kubara with ConfigHub](single-platform.md). Nothing in this historical
> fixture is removed or silently rewritten.

A platform team usually manages more than one Helm release. Argo CD,
certificates, Secrets, ingress, monitoring, and cluster services must be chosen
together and kept consistent across a fleet. Kubara provides that platform
description and generates the Helm source and cluster values.

This historical example uses Kubara v0.12.0 to describe one local test cluster
and seven enabled services. The generated Argo CD chart renders 77 Kubernetes objects,
including the ApplicationSets that assign those services to matching clusters.

ConfigHub adds a durable record of that result. The render can become a base
variant, while development, staging, production, region, or cluster-class
differences become reviewed variants. A platform change can then be compared,
checked, and promoted in waves instead of being repeated as an imperative
upgrade on every cluster.

## Follow the example

1. Read the [Kubara source config](../../../examples/kubara/local-platform/source/config.yaml)
   to see the cluster and enabled services.
2. Read the [portal values override](../../../examples/kubara/local-platform/source/values-homer-links.yaml)
   for a small example of changing Kubara output through its normal values path.
3. Open the [generated cluster values](../../../examples/kubara/local-platform/generated/platform-configs/test-cluster/helm/argo-cd/values.generated.yaml)
   to see what Kubara produced for Argo CD.
4. Inspect the [literal Kubernetes render](../../../examples/kubara/local-platform/rendered/release-objects.yaml)
   that ConfigHub can record.
5. Read the [route intent](../../../examples/kubara/local-platform/route-intent.yaml)
   for the CRDs, hook Job, Secret handling, and External Secrets prerequisite.
6. Check the [generation receipt](../../../examples/kubara/local-platform/generation-receipt.yaml)
   for the exact commands, checksums, OCI digest, and live-test boundary.
7. Check the [ConfigHub upload receipt](../../../examples/kubara/local-platform/confighub-upload-receipt.yaml)
   for the Space, Unit, matching object identities, omitted Secrets, and policy.

The [example README](../../../examples/kubara/local-platform/README.md) explains
how to regenerate and verify every committed file.

## Four different artifacts

| Artifact | Contents | Use |
| --- | --- | --- |
| Kubara source | Platform config, generated Helm charts, and cluster values | Regenerate or change the platform |
| Literal configuration OCI | The 77 rendered Kubernetes objects | Create a ConfigHub base variant |
| ConfigHub release OCI | An approved revision of the stored Units | Keep a private release record or deliver through a configured controller |
| Portable configuration OCI | The prepared objects after target work | Deliver to an external Argo CD or Flux without sharing a ConfigHub target credential |

This example now has all four forms. ConfigHub pulled the local literal OCI and
recorded the 75 non-Secret objects in one Unit. Approval was required before apply,
and ConfigHub published a private release. A separate portable OCI was then delivered
through Argo CD to a throwaway cluster.

## The work around the render

The render includes three Argo CD CRDs. They must be installed and established
before the Argo CD custom resources. It also contains four resources marked as
a Helm pre-install and pre-upgrade hook; together they run the Job that creates
the Redis Secret.

The render also expects the External Secrets CRD, a `ClusterSecretStore`, and a
remote image-pull key. Two ordinary Secret objects are present, but
`cub variant upload` deliberately does not upload rendered Secrets. The route
record names each case and the action an implementation must take.

The live route installed the three Argo CD CRDs first, supplied the two target-owned
Secrets without recording their data, and ran the Redis initializer Job. It did not
apply the `ClusterExternalSecret`, because the test cluster had no External Secrets
controller, `ClusterSecretStore`, or remote key. It also left out the Argo CD gRPC
Ingress because the test cluster had no ingress controller.

The target package added the public source repository to the AppProject, disabled Dex
because no Dex login was configured, and gave Metrics Server the kind-only TLS option
needed by the throwaway cluster. These changes are listed in the receipt instead of
being hidden in a shell command.

## What has been checked

`npm run kubara-example:verify` checks the pinned Kubara release, every generated
file, Helm dependency lock, all 77 rendered objects, the three CRDs, four hook
resources, two Secrets, repository paths, route record, and literal OCI layout.

The [OCI delivery proof](../../../data/kubara-oci-delivery-proof/summary.md) checks the
next stage. ConfigHub held the exact 75-object non-Secret base and required approval.
The route work ran, 69 prepared objects were packaged as a portable OCI, bootstrap
Argo CD reconciled its exact digest, Kubara Argo CD became ready, and Kubara created
one Metrics Server Application. That Application became Synced and Healthy.

This example proves only one kind cluster, one selected downstream service, and
a temporary OCI registry. It did not run the complete seven-service profile or
a multi-cluster promotion wave.

## Deploy an app onto the platform

A separate run deploys an app onto a live Kubara platform and promotes it across
a fleet. See [Roll out an app on a Kubara platform](app-rollout.md). A larger
write-up builds
[one platform from ConfigHub and Kubara that runs GitOps apps](single-platform.md).
