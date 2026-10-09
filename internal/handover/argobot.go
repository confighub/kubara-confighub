package handover

import "fmt"

// ArgobotImage is the argobot release handover installs on the hub. argobot
// watches Argo CD's Applications and records each one's sync and health on the
// release it synced, in its variant Space, which is where ConfigHub's Healthy
// gate and its UI read live status from v0.8.2 on. argobot v0.1.9 is the first
// that writes there; an earlier one writes a Space annotation ConfigHub no
// longer reads. See https://github.com/confighub/argobot.
const ArgobotImage = "ghcr.io/confighub/argobot:v0.1.9"

// MinimumCub is the first cub, and the first ConfigHub, with live status on
// the Release.
const MinimumCub = "v0.8.2"

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
# It records each Argo CD Application's sync and health on the release the
# Application synced, in the ConfigHub Space its OCI source names.
# It runs as the Targets' server worker, the same identity Argo CD pulls
# releases with; handover.sh writes that credential to the %[3]s Secret.
apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argobot
  namespace: %[1]s
---
# argobot watches Applications, and patches an Application's refresh
# annotation when ConfigHub publishes a release. It needs nothing else, and
# nothing outside the Argo CD namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argobot
  namespace: %[2]s
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications"]
    verbs: ["get", "list", "watch", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argobot
  namespace: %[2]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argobot
subjects:
  - kind: ServiceAccount
    name: argobot
    namespace: %[1]s
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argobot
  namespace: %[1]s
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
          image: %[4]s
          env:
            - name: CONFIGHUB_URL
              valueFrom:
                secretKeyRef:
                  name: %[3]s
                  key: CONFIGHUB_URL
            - name: CONFIGHUB_WORKER_ID
              valueFrom:
                secretKeyRef:
                  name: %[3]s
                  key: CONFIGHUB_WORKER_ID
            - name: CONFIGHUB_WORKER_SECRET
              valueFrom:
                secretKeyRef:
                  name: %[3]s
                  key: CONFIGHUB_WORKER_SECRET
            - name: ARGO_SYNC_MODE
              value: kubernetes
            - name: ARGO_NAMESPACE
              value: %[2]s
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
`, argobotNamespace, argoNamespace, argobotSecret, ArgobotImage)
}
