# Certified bundle receipts

One receipt per current-platform component, adopting the shared certified-bundle receipt spec. The spec's canonical home is the confighub/helm-expt repository; the schema at schemas/certified-bundle-receipt.schema.json is a byte-faithful copy so these receipts verify standalone. The component digest index stays Kubara's own format, and every receipt points at it.

| component | charts | lane | status |
| --- | --- | --- | --- |
| argo-cd | argo-cd 10.2.1 | do-not-flatten | provisional |
| bootstrap-crds | first-party | flatten-with-routes | certified |
| cert-manager | cert-manager v1.21.0 | flatten-with-routes | certified |
| external-secrets | external-secrets 2.8.0 | flatten-with-routes | certified |
| homer-dashboard | first-party | safe-to-flatten | provisional |
| kube-prometheus-stack | kube-prometheus-stack 87.19.2; prometheus-blackbox-exporter 11.15.1 | do-not-flatten | certified |
| metrics-server | metrics-server 3.13.1 | safe-to-flatten | certified |
| template-library | first-party | safe-to-flatten | provisional |
| traefik | traefik 41.0.2 | flatten-with-routes | certified |

A certified lane is cited from a flattening-safety verdict in confighub/helm-expt on an exact chart and version match. A provisional lane states what current evidence supports and names its open questions inside the receipt. Lanes move when receipts change, never by hand.

Regenerate with `npm run certified-bundles`. Verify with `npm run certified-bundles:verify`.
