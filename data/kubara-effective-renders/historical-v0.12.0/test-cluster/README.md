# Kubara Effective Render Corpus — secondary-historical

This directory is the secondary historical offline
desired-state input to the Kubara wiring extractor. It covers Kubara
v0.12.0 with its built-in catalog.
It is not a live-health receipt.

| Cluster | Component | Render namespace | Objects | SHA-256 prefix |
| --- | --- | --- | ---: | --- |
| test-cluster | argo-cd | argocd | 78 | `2c04287f57e1` |
| test-cluster | cert-manager | cert-manager | 54 | `a037a1d9608c` |
| test-cluster | external-secrets | external-secrets | 44 | `918451436e07` |
| test-cluster | homer-dashboard | homer-dashboard | 8 | `71d547af4a8e` |
| test-cluster | kube-prometheus-stack | kube-prometheus-stack | 116 | `f46deb990f56` |
| test-cluster | metrics-server | metrics-server | 10 | `0684e1c944c7` |
| test-cluster | traefik | traefik | 33 | `1087500bfc35` |

Render profile: Kubernetes 1.34.0, Helm v4.1.4, CRDs and
hooks included, tests skipped, and cross-component API versions listed in
[receipt.yaml](receipt.yaml).

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --generate --profile historical-v0.12.0
node scripts/generate-kubara-effective-renders.mjs --verify --profile historical-v0.12.0
~~~

Generation builds dependencies in a temporary directory, checks every reviewed
upstream archive against the committed artifact index, and requires two
successive renders to be byte-identical. Verification is offline.
