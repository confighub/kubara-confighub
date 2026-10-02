package handover

import "fmt"

// ArgobotImage is the argobot release handover installs on the hub. argobot
// watches Argo CD's Applications and writes each one's sync and health to its
// variant Space as confighub.com/live-status, which ConfigHub's Healthy gate
// and its UI read. See https://github.com/confighub/argobot.
const ArgobotImage = "ghcr.io/confighub/argobot:v0.1.8"

// LiveStatus is the Space annotation argobot writes.
const LiveStatus = "confighub.com/live-status"

const (
	argobotNamespace = "argobot"
	argobotSecret    = "argobot-secrets"
)

// argobotManifest is argobot's own deployment (manifests/argobot.yaml in its
// repository), pinned to ArgobotImage, with narrower access to the cluster.
// argobot reads and patches Argo CD Applications in the Argo CD namespace, and
// nothing else: Kubara's Argo CD namespace holds repository credentials, so the
// Role names only Applications. The Secret it reads is not in the manifest;
// handover.sh writes it from the Targets' server worker.
func argobotManifest() string {
	return fmt.Sprintf(`# argobot, as cub kubara handover installs it on Kubara's hub.
# It reports each Argo CD Application's sync and health to the ConfigHub Space
# its OCI source names, as the %[1]s annotation.
# It runs as the Targets' server worker, the same identity Argo CD pulls
# releases with; handover.sh writes that credential to the %[4]s Secret.
apiVersion: v1
kind: Namespace
metadata:
  name: %[2]s
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argobot
  namespace: %[2]s
---
# argobot watches Applications, and patches an Application's refresh
# annotation when ConfigHub publishes a release. It needs nothing else, and
# nothing outside the Argo CD namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argobot
  namespace: %[3]s
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications"]
    verbs: ["get", "list", "watch", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argobot
  namespace: %[3]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argobot
subjects:
  - kind: ServiceAccount
    name: argobot
    namespace: %[2]s
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argobot
  namespace: %[2]s
  labels:
    app: argobot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: argobot
  template:
    metadata:
      labels:
        app: argobot
    spec:
      serviceAccountName: argobot
      containers:
        - name: argobot
          image: %[5]s
          env:
            - name: CONFIGHUB_URL
              valueFrom:
                secretKeyRef:
                  name: %[4]s
                  key: CONFIGHUB_URL
            - name: CONFIGHUB_WORKER_ID
              valueFrom:
                secretKeyRef:
                  name: %[4]s
                  key: CONFIGHUB_WORKER_ID
            - name: CONFIGHUB_WORKER_SECRET
              valueFrom:
                secretKeyRef:
                  name: %[4]s
                  key: CONFIGHUB_WORKER_SECRET
            - name: ARGO_SYNC_MODE
              value: kubernetes
            - name: ARGO_NAMESPACE
              value: %[3]s
            - name: ARGO_REFRESH_TYPE
              value: hard
            - name: CONFIGHUB_SUBSCRIPTION_NAME
              value: argobot
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities:
              drop: ["ALL"]
`, LiveStatus, argobotNamespace, argoNamespace, argobotSecret, ArgobotImage)
}
