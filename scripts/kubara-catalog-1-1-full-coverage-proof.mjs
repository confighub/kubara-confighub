// Exact-artifact package proofs for Kubara catalogs 1.1.0 selections that were
// not present in the 120-version ConfigHub component Catalog baseline.
//
// The orchestrator supplies and independently verifies the exact artifact URL
// and SHA. This declaration never resolves a mutable Helm repository index.

import { runProofCli } from "./lib/proof-kit.mjs";
import { identityFor } from "./lib/proof-common.mjs";

const candidateName = process.env.HELM_EXPT_KUBARA_FULL_COVERAGE_CANDIDATE ?? "";
const chartVersion = process.env.HELM_EXPT_CHART_VERSION ?? "";

const candidates = {
  kyverno: candidate({
    repository: "kyverno",
    repositoryURL: "https://kyverno.github.io/kyverno",
    name: "kyverno",
    version: "3.8.2",
    namespace: "kyverno",
    objects: 69,
    crds: 22,
    secrets: 0,
    dependencies: 5,
  }),
  "kyverno-policies": candidate({
    repository: "kyverno",
    repositoryURL: "https://kyverno.github.io/kyverno",
    name: "kyverno-policies",
    version: "3.8.2",
    namespace: "kyverno",
    objects: 11,
    crds: 0,
    secrets: 0,
    dependencies: 0,
  }),
  "policy-reporter": candidate({
    repository: "policy-reporter",
    repositoryURL: "https://kyverno.github.io/policy-reporter",
    name: "policy-reporter",
    version: "3.9.1",
    namespace: "policy-reporter",
    objects: 8,
    crds: 0,
    secrets: 1,
    dependencies: 0,
  }),
  loki: candidate({
    repository: "grafana",
    repositoryURL: "https://grafana.github.io/helm-charts",
    name: "loki",
    version: "7.1.0",
    namespace: "loki",
    objects: 19,
    crds: 0,
    secrets: 0,
    dependencies: 3,
    displayName: "single binary filesystem",
    valuesFile: "effective-values-single-binary-filesystem.yaml",
    valuesText: `deploymentMode: SingleBinary
loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 1
  storage:
    type: filesystem
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
singleBinary:
  replicas: 1
read:
  replicas: 0
write:
  replicas: 0
backend:
  replicas: 0
`,
    valuesSummary: "single-binary Loki with filesystem storage and an explicit schema epoch",
  }),
  alloy: candidate({
    repository: "grafana",
    repositoryURL: "https://grafana.github.io/helm-charts",
    name: "alloy",
    version: "1.11.0",
    namespace: "alloy",
    objects: 7,
    crds: 1,
    secrets: 0,
    dependencies: 1,
  }),
  longhorn: candidate({
    repository: "longhorn",
    repositoryURL: "https://charts.longhorn.io",
    name: "longhorn",
    version: "1.12.0",
    namespace: "longhorn-system",
    objects: 42,
    crds: 23,
    secrets: 0,
    dependencies: 0,
  }),
  metallb: candidate({
    repository: "metallb",
    repositoryURL: "https://metallb.github.io/metallb",
    name: "metallb",
    version: "0.16.1",
    namespace: "metallb-system",
    objects: 42,
    crds: 13,
    secrets: 2,
    dependencies: 2,
  }),
  "oauth2-proxy": candidate({
    repository: "oauth2-proxy",
    repositoryURL: "https://oauth2-proxy.github.io/manifests",
    name: "oauth2-proxy",
    version: "10.7.0",
    namespace: "oauth2-proxy",
    objects: 5,
    crds: 0,
    secrets: 1,
    dependencies: 1,
  }),
  reloader: candidate({
    repository: "stakater",
    repositoryURL: "https://stakater.github.io/stakater-charts",
    name: "reloader",
    version: "2.2.14",
    namespace: "reloader",
    objects: 6,
    crds: 0,
    secrets: 0,
    dependencies: 0,
  }),
  velero: candidate({
    repository: "velero",
    repositoryURL: "https://vmware-tanzu.github.io/helm-charts",
    name: "velero",
    version: "12.1.0",
    namespace: "velero",
    objects: 23,
    crds: 13,
    secrets: 1,
    dependencies: 0,
  }),
};

const selected = candidates[candidateName];
if (!selected) {
  throw new Error(
    `HELM_EXPT_KUBARA_FULL_COVERAGE_CANDIDATE must be one of ${Object.keys(candidates).join(", ")}`,
  );
}
if (chartVersion !== selected.chart.version) {
  throw new Error(
    `${candidateName} expects reviewed version ${selected.chart.version}; received ${chartVersion || "<unset>"}`,
  );
}

const scanPolicy = {
  scanner: "helm-expt-local-rendered-object-scan",
  version: "0.1.0",
  rules: [
    { id: "mutable-image-tag", severity: "high", description: "Container images must not use latest or an untagged reference." },
    { id: "service-selector-has-workload-match", severity: "high", description: "Service selectors must match a rendered workload." },
    { id: "workload-service-account-exists", severity: "high", description: "Workload ServiceAccounts must be rendered." },
    { id: "crd-upgrade-policy", severity: "medium", description: "CRDs require explicit ownership and upgrade policy." },
    { id: "rendered-secret-ownership", severity: "medium", description: "Rendered Secrets require explicit ownership and replacement policy." },
    { id: "cluster-rbac-review", severity: "medium", description: "Cluster-scoped RBAC requires production review." },
    { id: "stateful-workload-review", severity: "medium", description: "Stateful workloads require storage, upgrade, and rollback policy." },
  ],
};

runProofCli({
  chart: selected.chart,
  variants: [selected.variant],
  scanPolicy,
  scriptPrefix: "kubara-catalog-1.1-full-coverage",
  receiptSlug: selected.chart.name,
  expectedDependencyCount: selected.dependencies,
  recordChartLockDigest: selected.dependencies > 0,
  semanticNormalizations: [
    "prune-null-fields",
    ...(["loki", "oauth2-proxy"].includes(selected.chart.name)
      ? [`${selected.chart.name}-configmap-leading-blank-line-pruned-by-kustomize`]
      : []),
  ],
  allowedSemanticDiff({ key, helmObjectJson, cubObjectJson }) {
    const configMap = selected.chart.name === "loki"
      ? { identity: "v1|ConfigMap|loki|loki", dataKey: "config.yaml" }
      : selected.chart.name === "oauth2-proxy"
        ? { identity: "v1|ConfigMap|oauth2-proxy|oauth2-proxy", dataKey: "oauth2_proxy.cfg" }
        : null;
    if (!configMap || key !== configMap.identity) return false;
    const helmObject = JSON.parse(helmObjectJson);
    const cubObject = JSON.parse(cubObjectJson);
    const helmConfig = helmObject.data?.[configMap.dataKey];
    const cubConfig = cubObject.data?.[configMap.dataKey];
    if (typeof helmConfig !== "string" || typeof cubConfig !== "string") return false;
    helmObject.data[configMap.dataKey] = helmConfig.replace(/^\n/, "");
    return JSON.stringify(helmObject) === JSON.stringify(cubObject);
  },
  valueModel: {
    checkedValues: [
      {
        path: selected.variant.valuesText ? selected.variant.valuesFile : "<chart defaults>",
        variant: "default",
        disposition: selected.variant.valuesText ? "bounded-render-profile" : "default-render-captured",
        reason: selected.variant.valuesText
          ? "the chart defaults do not render; the package binds the smallest deterministic local configuration"
          : "the exact Kubara-selected chart default render is captured",
      },
    ],
    unknownValues: "not-exhaustively-checked-by-additive-coverage-proof",
    deadValues: "not-exhaustively-checked-by-additive-coverage-proof",
    ignoredValues: "not-exhaustively-checked-by-additive-coverage-proof",
  },
  controlPoints: [
    { category: "source-lock", status: "handled", evidence: "source-lock.yaml" },
    { category: "dependency-lock", status: "handled", evidence: "dependency-lock.yaml", dependencyCount: selected.dependencies },
    { category: "capability-profile", status: "handled", kubeVersion: selected.chart.kubeVersion },
    ...(selected.variant.expectedCRDCount
      ? [{ category: "crd-lifecycle", status: "review-required", count: selected.variant.expectedCRDCount }]
      : []),
    ...(selected.variant.expectedSecretCount
      ? [{ category: "rendered-secret-ownership", status: "review-required", count: selected.variant.expectedSecretCount }]
      : []),
    {
      category: "catalog-coverage",
      status: "packaged-with-controls",
      note: "exact source and deterministic package are retained; live qualification and production support remain separate gates",
    },
  ],
  dossier: {
    maintainedNotes: [
      `This package is the exact ${selected.chart.name}@${selected.chart.version} dependency selected by Kubara catalogs 1.1.0.`,
      "The retained root proves exact source bytes, deterministic rendering, and deterministic ConfigHub installer packaging.",
      "It does not claim Kubara wrapper equivalence, live convergence, or production support.",
    ],
    knownControlPoints: [
      "source-lock",
      "dependency-lock",
      "capability-profile",
      "target-facts",
      "production-readiness-review",
    ],
  },
  plan: {
    status: "packaged-with-controls",
    scanGate: "warn-production-blocked",
    nextAction: "select a reviewed configuration and complete target-specific live qualification before production",
  },
  readme: {
    intro: `This is the exact-artifact ConfigHub component package for the ${selected.chart.name}@${selected.chart.version} dependency selected by Kubara catalogs 1.1.0.`,
    proves: [
      "the version-specific upstream artifact and SHA are locked without a mutable Helm index lookup;",
      "the selected configuration renders deterministically and the installer package preserves the rendered object set;",
      "Catalog retention does not imply Kubara wrapper equivalence, live convergence, or production support.",
    ],
  },
  installGate: (variant) => ({
    decision: "warn",
    allowedScopes: ["catalog-selection", "local-test"],
    blockedScopes: ["production"],
    reasons: [
      `Helm equivalence passed for ${variant.name}`,
      "the exact artifact and deterministic installer package are retained for Kubara selection",
      "Kubara wrapper behavior and target-specific live readiness require separate review",
      variant.targetFactNote,
    ],
  }),
  scanExtra(docs) {
    const findings = [];
    for (const doc of docs) {
      const identity = identityFor(doc);
      if (doc.kind === "CustomResourceDefinition") {
        findings.push({
          id: `crd-upgrade-policy:${identity}`,
          rule: "crd-upgrade-policy",
          severity: "medium",
          object: identity,
          message: "CRD ownership and upgrade behavior require production review",
        });
      }
      if (doc.kind === "Secret") {
        findings.push({
          id: `rendered-secret-ownership:${identity}`,
          rule: "rendered-secret-ownership",
          severity: "medium",
          object: identity,
          message: "Rendered Secret ownership and target-specific replacement require review",
        });
      }
      if (["ClusterRole", "ClusterRoleBinding"].includes(doc.kind)) {
        findings.push({
          id: `cluster-rbac-review:${identity}`,
          rule: "cluster-rbac-review",
          severity: "medium",
          object: identity,
          message: "Cluster-scoped RBAC requires production review",
        });
      }
      if (doc.kind === "StatefulSet") {
        findings.push({
          id: `stateful-workload-review:${identity}`,
          rule: "stateful-workload-review",
          severity: "medium",
          object: identity,
          message: "Stateful workload requires storage, upgrade, and rollback policy",
        });
      }
    }
    return findings;
  },
  verifyExtra({ dependencyLock, perVariant, check }) {
    const row = perVariant.get("default");
    const objects = row?.objects ?? [];
    check(objects.length === selected.variant.expectedObjectCount, `${candidateName} object count mismatch`);
    check(
      objects.filter((item) => item.kind === "CustomResourceDefinition").length === selected.variant.expectedCRDCount,
      `${candidateName} CRD count mismatch`,
    );
    check(
      objects.filter((item) => item.kind === "Secret").length === selected.variant.expectedSecretCount,
      `${candidateName} Secret count mismatch`,
    );
    check((dependencyLock.spec?.dependencies ?? []).length === selected.dependencies, `${candidateName} dependency count mismatch`);
  },
});

function candidate({
  repository,
  repositoryURL,
  name,
  version,
  namespace,
  objects,
  crds,
  secrets,
  dependencies,
  displayName = "chart defaults",
  valuesFile = "effective-values.yaml",
  valuesText = "",
  valuesSummary = "chart defaults",
}) {
  return {
    chart: {
      repository,
      repositoryURL,
      name,
      version,
      releaseName: name,
      namespace,
      kubeVersion: "1.30.0",
    },
    dependencies,
    variant: {
      name: "default",
      base: "default",
      displayName,
      valuesFile,
      valuesText,
      valuesSummary,
      expectedObjectCount: objects,
      expectedCRDCount: crds,
      expectedSecretCount: secrets,
      targetFactNote: "target facts and lifecycle prerequisites remain explicit and target-specific",
    },
  };
}
