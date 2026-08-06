// Scoped proof declarations for Kubara-selected charts that are not part of the
// maintained top-20 chart-specific proof set. The orchestrator supplies an exact
// artifact URL and digest, so this lane never depends on a mutable Helm index.

import { runProofCli } from "./lib/proof-kit.mjs";
import { identityFor } from "./lib/proof-common.mjs";

const candidateName = process.env.HELM_EXPT_KUBARA_CANDIDATE ?? "";
const chartVersion = process.env.HELM_EXPT_CHART_VERSION ?? "";
const rootReady = process.env.HELM_EXPT_KUBARA_ROOT_READY === "1";
if (rootReady && process.env.HELM_EXPT_PROOF_OFFLINE_CANDIDATE === "1") {
  throw new Error("HELM_EXPT_KUBARA_ROOT_READY cannot be combined with HELM_EXPT_PROOF_OFFLINE_CANDIDATE");
}
const candidates = {
  "prometheus-blackbox-exporter": {
    chart: {
      repository: "prometheus-community",
      repositoryURL: "https://prometheus-community.github.io/helm-charts",
      name: "prometheus-blackbox-exporter",
      version: "11.15.1",
      releaseName: "prometheus-blackbox-exporter",
      namespace: "monitoring",
      kubeVersion: "1.30.0",
    },
    expectedObjectCount: 4,
    expectedCRDCount: 0,
    knownControlPoints: ["source-lock", "dependency-lock", "capability-profile", "tpl-extension-slots"],
    notes: [
      "The exact Kubara-selected chart renders four objects with chart defaults.",
      rootReady
        ? "This exact upstream-package proof is suitable for additive root retention after the separate live-qualification gate passes; Kubara wrapper compatibility remains separate."
        : "This is an offline upstream-package candidate; Kubara wrapper compatibility and live qualification remain separate gates.",
    ],
  },
  traefik: {
    chart: {
      repository: "traefik",
      repositoryURL: "oci://ghcr.io/traefik/helm",
      name: "traefik",
      version: "41.0.2",
      releaseName: "traefik",
      namespace: "traefik",
      kubeVersion: "1.30.0",
    },
    expectedObjectCount: 31,
    expectedCRDCount: 25,
    knownControlPoints: [
      "source-lock",
      "dependency-lock",
      "capability-profile",
      "crd-lifecycle",
      "cluster-rbac",
      "admission-webhook",
      "tpl-extension-slots",
    ],
    notes: [
      "The exact Kubara OCI chart layer renders 31 objects with chart defaults, including 25 CRDs.",
      "The OCI layer digest is required because the same version from the Helm repository is a different archive.",
      rootReady
        ? "This exact upstream-package proof is suitable for additive root retention after the separate live-qualification gate passes; CRD lifecycle and Kubara wrapper compatibility remain separate."
        : "This is an offline upstream-package candidate; CRD lifecycle, Kubara wrapper compatibility, and live qualification remain separate gates.",
    ],
  },
};

const selected = candidates[candidateName];
if (!selected) {
  throw new Error(
    `HELM_EXPT_KUBARA_CANDIDATE must be one of ${Object.keys(candidates).join(", ")}`,
  );
}
if (chartVersion !== selected.chart.version) {
  throw new Error(
    `${candidateName} expects reviewed version ${selected.chart.version}; received ${chartVersion || "<unset>"}`,
  );
}

const chart = { ...selected.chart, version: chartVersion };
const variants = [
  {
    name: "default",
    base: "default",
    displayName: "chart defaults",
    valuesFile: "effective-values.yaml",
    valuesText: "",
    valuesSummary: "chart defaults",
    expectedObjectCount: selected.expectedObjectCount,
    targetFactNote: rootReady
      ? "target facts remain explicit; root retention is gated by the separate exact-version live-qualification receipt"
      : "offline candidate only; target facts and live readiness remain unqualified",
  },
];

const scanPolicy = {
  scanner: "helm-expt-local-rendered-object-scan",
  version: "0.1.0",
  rules: [
    { id: "mutable-image-tag", severity: "high", description: "Container images must not use latest or an untagged reference." },
    { id: "service-selector-has-workload-match", severity: "high", description: "Service selectors must match a rendered workload." },
    { id: "workload-service-account-exists", severity: "high", description: "Workload ServiceAccounts must be rendered." },
    { id: "crd-upgrade-policy", severity: "medium", description: "CRDs require explicit ownership and upgrade policy." },
    { id: "cluster-rbac-review", severity: "medium", description: "Cluster-scoped RBAC requires production review." },
    { id: "admission-webhook-requires-observation", severity: "medium", description: "Webhook readiness requires live observation." },
  ],
};

runProofCli({
  chart,
  variants,
  scanPolicy,
  scriptPrefix: "kubara-catalog-candidates",
  receiptSlug: candidateName,
  expectedDependencyCount: 0,
  valueModel: {
    checkedValues: [
      {
        path: "<chart defaults>",
        variant: "default",
        disposition: "default-render-captured",
        reason: rootReady
          ? "the root-retention proof binds the exact artifact and records its deterministic default render"
          : "the candidate binds the exact artifact and records its deterministic default render",
      },
    ],
    unknownValues: rootReady
      ? "not-exhaustively-checked-in-root-retention-proof"
      : "not-exhaustively-checked-in-offline-candidate-lane",
    deadValues: rootReady
      ? "not-exhaustively-checked-in-root-retention-proof"
      : "not-exhaustively-checked-in-offline-candidate-lane",
    ignoredValues: rootReady
      ? "not-exhaustively-checked-in-root-retention-proof"
      : "not-exhaustively-checked-in-offline-candidate-lane",
  },
  controlPoints: [
    { category: "source-lock", status: "handled", evidence: "source-lock.yaml" },
    { category: "dependency-lock", status: "handled", evidence: "dependency-lock.yaml", dependencyCount: 0 },
    { category: "capability-profile", status: "handled", kubeVersion: chart.kubeVersion },
    ...(selected.expectedCRDCount
      ? [{ category: "crd-lifecycle", status: "review-required", count: selected.expectedCRDCount }]
      : []),
    rootReady
      ? {
          category: "root-retention",
          status: "qualification-gated",
          note: "the promotion orchestrator separately requires all exact-version live lanes before additive root copy",
        }
      : {
          category: "candidate-boundary",
          status: "offline-only",
          note: "root retention, Kubara compatibility, and live qualification are not implied",
        },
  ],
  dossier: {
    maintainedNotes: selected.notes,
    knownControlPoints: selected.knownControlPoints,
  },
  plan: {
    status: rootReady ? "usable-with-controls" : "offline-candidate",
    scanGate: rootReady ? "warn-review-before-production" : "warn-production-blocked",
    nextAction: rootReady
      ? "retain additively only after the 13-lane Kubara live-qualification receipt passes; keep complete Kubara component compatibility separate"
      : "capture the Kubara compatibility profile and complete scoped live qualification before root retention",
  },
  readme: {
    intro: rootReady
      ? `This is the exact-artifact root-retention proof for ${chart.repository}/${chart.name}@${chart.version}. It remains a catalog candidate, not a claim of production support or complete Kubara wrapper compatibility.`
      : `This is the exact-artifact offline candidate for ${chart.repository}/${chart.name}@${chart.version}.`,
    proves: [
      "the exact upstream artifact digest is captured independently of a mutable repository index;",
      "the chart renders deterministically and the installer package preserves the rendered object set;",
      rootReady
        ? "additive root retention remains gated by the separately committed exact-version live-qualification receipt, and does not imply Kubara wrapper compatibility or production support."
        : "candidate status does not imply root Catalog retention, Kubara wrapper compatibility, or live support.",
    ],
  },
  installGate: (variant) => ({
    decision: "warn",
    allowedScopes: rootReady ? ["local-test", "root-catalog-retention"] : ["offline-review", "local-test"],
    blockedScopes: ["production"],
    reasons: [
      `Helm equivalence passed for ${variant.name}`,
      rootReady
        ? "the exact artifact is root-retention-ready only when the external 13-lane live-qualification receipt passes"
        : "the exact artifact is qualified only as an offline candidate",
      rootReady
        ? "Kubara ServiceDefinition and wrapper compatibility remain outside upstream-package root retention"
        : "Kubara wrapper compatibility and live evidence remain required before retention",
    ],
  }),
  scanExtra(docs) {
    const findings = [];
    for (const doc of docs.filter((item) => item.kind === "CustomResourceDefinition")) {
      findings.push({
        id: `crd-upgrade-policy:${identityFor(doc)}`,
        rule: "crd-upgrade-policy",
        severity: "medium",
        object: identityFor(doc),
        message: "CRD ownership and upgrade behavior require review before retention",
      });
    }
    return findings;
  },
  verifyExtra({ perVariant, check }) {
    const objects = perVariant.get("default")?.objects ?? [];
    const crdCount = objects.filter((item) => item.kind === "CustomResourceDefinition").length;
    check(crdCount === selected.expectedCRDCount, `${candidateName} CRD count mismatch`);
  },
});
