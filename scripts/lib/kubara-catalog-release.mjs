// One scope declaration for the additive Kubara catalog release. Promotion,
// publication, and release acceptance all import these constants so a command
// cannot silently publish a path that the retention contract does not cover.

export const KUBARA_CATALOG_BASELINE = Object.freeze({
  versionCount: 110,
  recipesTreeSHA256: "405bb7847cff4a4c9c691aafbaf69a1baff160c5e8a8f5d927569c8dd2286424",
  packagesTreeSHA256: "68c82bb177743dc610172bacd035475160515cccb47aea68910d32d222bd6e1c",
});

export const KUBARA_HISTORICAL_ADDITIONS = Object.freeze([
  "argo-cd/argo-cd/10.1.3",
  "external-secrets/external-secrets/2.7.0",
  "jetstack/cert-manager/v1.21.0",
  "metrics-server/metrics-server/3.13.1",
  "prometheus-community/kube-prometheus-stack/87.15.1",
  "prometheus-community/prometheus-blackbox-exporter/11.15.1",
  "traefik/traefik/41.0.2",
]);

export const KUBARA_CURRENT_ADDITIONS = Object.freeze([
  "argo-cd/argo-cd/10.2.1",
  "external-secrets/external-secrets/2.8.0",
  "prometheus-community/kube-prometheus-stack/87.19.2",
]);

export const KUBARA_CATALOG_ADDITIONS = Object.freeze([
  ...KUBARA_HISTORICAL_ADDITIONS,
  ...KUBARA_CURRENT_ADDITIONS,
]);

export const KUBARA_OCI_PACKAGES = Object.freeze(
  KUBARA_CATALOG_ADDITIONS.map((path) => `packages/${path}`),
);

export const KUBARA_PROMOTION_RECEIPTS = Object.freeze([
  "data/kubara-catalog-refresh/root-promotion/receipt.yaml",
  "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml",
]);

export function kubaraAdditionPath(rootName, chartVersionPath) {
  return `${rootName}/${chartVersionPath}`;
}
