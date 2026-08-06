# Kubara configuration delivered through OCI

Kubara generated the Argo CD bootstrap and cluster settings for a Kubernetes
platform. ConfigHub stored the 75 non-Secret objects as one system-configuration
base. A dry-run apply was blocked until that exact revision was approved.
The failed dry-run did not create a durable ConfigHub UnitEvent, so this receipt
names the guarded run that observed it rather than claiming a server audit event.

The live test then handled the work that a flat YAML bundle cannot do by itself.
It installed the Argo CD CRDs first, created the two target-owned Secrets without
recording their data, and ran the Redis initializer Job before Argo CD started.

The test deliberately selected one downstream service, Metrics Server. It deferred
the ClusterExternalSecret because External Secrets, its ClusterSecretStore, and the
remote key were outside this small lane. It also deferred the Argo CD gRPC Ingress
because the throwaway cluster had no ingress controller.

After that route work, 69 prepared
objects were packaged as a temporary portable OCI. Pulling the package required no
ConfigHub account. Bootstrap Argo CD reconciled the exact OCI digest, the Kubara
Argo CD installation became ready, and Kubara created one Metrics Server
Application. That Application became Synced and Healthy.

| Check | Result |
| --- | --- |
| ConfigHub apply before approval | blocked |
| ConfigHub apply after approval | allowed |
| ConfigHub private release | `sha256:2331e1684a4ee56bab2fe38c925aa12d76ad5ec8d13f91f5d1d467614ceff9aa` |
| Argo CD CRDs established | 3/3 |
| Redis initializer | pass |
| External Secrets object | deferred |
| Argo CD gRPC Ingress | deferred |
| Portable OCI pull-back | Pass |
| Bootstrap Argo CD | Synced and Healthy |
| Kubara Argo CD | Ready |
| Selected platform Application | `test-cluster-metrics-server`: Synced and Healthy |
| Metrics Server Deployments | 1 ready |
| Cleanup | Pass |

## What changed for the throwaway target

The approved base remains unchanged in ConfigHub. The portable output adds the
public helm-expt repository to the Kubara AppProject and adds
`--kubelet-insecure-tls` to the Metrics Server ApplicationSet for kind. It also
scales Dex to zero because this Kubara configuration does not provide a Dex login
configuration. Four hook resources were executed before delivery, and the
unresolved ClusterExternalSecret and Ingress were deferred rather than applied
without their prerequisites.

## Limits

This run used one kind cluster, one selected platform service, and a temporary OCI
registry. It does not prove the full seven-service local-evaluation profile or a
multi-cluster promotion wave. The kind-specific Metrics Server setting is not a
production recommendation.

- [Kubara example](../../examples/kubara/local-platform/README.md)
- [Route intent](../../examples/kubara/local-platform/route-intent.yaml)
- [Committed receipt](../../runs/kubara-oci-delivery-proof/receipt.yaml)
