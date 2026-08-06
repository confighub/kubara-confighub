# Kubara Effective Render Corpus — primary-current

This directory is the primary offline
desired-state input to the Kubara wiring extractor. It covers Kubara
v0.13.0 with catalogs 1.1.0.
It is not a live-health receipt.

| Cluster | Component | Render namespace | Objects | SHA-256 prefix |
| --- | --- | --- | ---: | --- |
| hx-app-dev | argo-cd | argocd | 86 | `3881930e58f3` |
| hx-app-dev | cert-manager | cert-manager | 54 | `d42bd87d5d10` |
| hx-app-dev | external-secrets | external-secrets | 50 | `b90bd5215ed8` |
| hx-app-dev | homer-dashboard | homer-dashboard | 8 | `0810f86226a1` |
| hx-app-dev | kube-prometheus-stack | kube-prometheus-stack | 116 | `a9c778d0a46b` |
| hx-app-dev | metrics-server | metrics-server | 10 | `da40e4395191` |
| hx-app-dev | traefik | traefik | 33 | `0c39aaa42662` |
| hx-app-prod-a | cert-manager | cert-manager | 52 | `27f69adde8d4` |
| hx-app-prod-a | traefik | traefik | 32 | `f3f494ffb978` |
| hx-app-prod-b | cert-manager | cert-manager | 52 | `ddab0a44c5ef` |
| hx-app-prod-b | traefik | traefik | 32 | `9d5ce0593524` |
| hx-app-staging | cert-manager | cert-manager | 52 | `d7cc5ad406be` |
| hx-app-staging | traefik | traefik | 32 | `3ebec65bab14` |

Render profile: Kubernetes 1.35.0, Helm v4.1.4, CRDs and
hooks included, tests skipped, and cross-component API versions listed in
[receipt.yaml](receipt.yaml).

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --generate --profile current
node scripts/generate-kubara-effective-renders.mjs --verify --profile current
~~~

Generation builds dependencies in a temporary directory, checks every reviewed
upstream archive against the committed artifact index, and requires two
successive renders to be byte-identical. Verification is offline.
