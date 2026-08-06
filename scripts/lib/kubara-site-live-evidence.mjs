import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listFiles, readYaml, sha256, sha256File } from "./proof-common.mjs";

const libraryRoot = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(libraryRoot, "../..");

export const KUBARA_SITE_EVIDENCE_PATHS = Object.freeze({
  config: "examples/kubara/current-platform/source/config.yaml",
  catalogParity: "examples/kubara/current-platform/catalog-parity-receipt.yaml",
  generatedChecksums: "examples/kubara/current-platform/generated-checksums.txt",
  faithful: "runs/kubara-faithful-hub-spoke/receipt.yaml",
  miniIdp: "runs/kubara-mini-idp-reconcile/receipt.yaml",
  attempts: "runs/kubara-mini-idp-reconcile/attempts.yaml",
  orphan: "runs/kubara-mini-idp-reconcile/orphan-audit.yaml",
  matrix: "data/kubara-platform-matrix/matrix.json",
  wiring: "data/kubara-wiring/graph.json",
  gui: "data/kubara-gui-evidence/receipt.yaml",
  guiTour: "docs/demo/kubara/gui-tour.md",
  reconciler: "scripts/reconcile-kubara-mini-idp.mjs",
  orphanAuditor: "scripts/audit-kubara-mini-idp-orphans.mjs",
  performanceContract: "data/kubara-mini-idp-performance/contract.yaml",
  performanceVerifier: "scripts/verify-kubara-mini-idp-performance.mjs",
});

export const KUBARA_MINI_IDP_SOURCE_PATHS = Object.freeze({
  config: "examples/kubara/current-platform/source/config.yaml",
  sourceLock: "examples/kubara/current-platform/source-lock.yaml",
  componentArtifacts: "examples/kubara/current-platform/component-artifacts.yaml",
  generationReceipt: "examples/kubara/current-platform/generation-receipt.yaml",
  appSourceLock: "examples/kubara/current-platform/apps/source-lock.yaml",
  argoAppSetTemplate: "examples/kubara/current-platform/generated/platform-components/helm/template-library/templates/argocd/_argo.appset.tpl",
  argoValues: "examples/kubara/current-platform/generated/platform-configs/hx-app-dev/helm/argo-cd/values.generated.yaml",
  catalogFullCoverageReceipt: "data/kubara-catalog-1.1-full-coverage/receipt.yaml",
  adapterOutput: "data/kubara-catalog-adapter/adapter-output.yaml",
  adapterReceipt: "data/kubara-catalog-adapter/receipt.yaml",
  desiredMatrix: "data/kubara-platform-matrix/desired-matrix.json",
  wiring: "data/kubara-wiring/graph.json",
  effectiveReceipt: "data/kubara-effective-renders/current-platform/receipt.yaml",
  qualificationReceipt: "runs/kubara-current-live-qualification/receipt.yaml",
  promotionReceipt: "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml",
  faithfulReceipt: "runs/kubara-faithful-hub-spoke/receipt.yaml",
});

export const KUBARA_GUI_REQUIRED_HASH_FIELDS = Object.freeze([
  "faithfulReceiptSHA256",
  "miniIdpReceiptSHA256",
  "orphanReceiptSHA256",
  "matrixSHA256",
  "wiringSHA256",
]);

const EXPECTED = Object.freeze({
  kubaraVersion: "v0.13.0",
  catalogVersion: "1.1.0",
  organizationName: "Kubara",
  organizationExternalID: "58b23b85-9699-4384-bd57-80ef695a1d58",
  organizationInternalID: "12c33fa8-00b1-4011-ad3e-19d56458b29c",
  serverURL: "https://hub.confighub.com",
  generatedFiles: 135,
  spaces: 55,
  managedUnits: 63,
  preservedFaithfulUnits: 2,
  deployments: 27,
  deliveryApplications: 35,
  releases: 27,
  needsProvidesLinks: 25,
  matrixRows: 36,
  components: 9,
  platformComponents: 7,
  applications: 2,
  clusters: 4,
  orphanUnits: 105,
  orphanLinks: 64,
  orphanTargets: 4,
  orphanReleaseStreams: 35,
  requiredGuiFrames: 6,
});

const COMPONENTS = Object.freeze([
  "argo-cd",
  "cert-manager",
  "external-secrets",
  "homer-dashboard",
  "kube-prometheus-stack",
  "metrics-server",
  "traefik",
  "hx-web",
  "cubbychat",
]);
const CLUSTERS = Object.freeze(["hx-app-dev", "hx-app-staging", "hx-app-prod-a", "hx-app-prod-b"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortDeep(nested)]));
  }
  return value;
}

function gate(reasons) {
  return { current: reasons.length === 0, reasons };
}

function requireFact(reasons, condition, message) {
  if (!condition) reasons.push(message);
}

function validTimestamp(value) {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function timestampNotFuture(value, nowMs = Date.now()) {
  return validTimestamp(value) && Date.parse(value) <= nowMs + MAX_FUTURE_CLOCK_SKEW_MS;
}

function timestampsStrictlyIncrease(rows) {
  return rows.slice(1).every((row, index) => Date.parse(rows[index].observedAt) < Date.parse(row.observedAt));
}

function timestampAtOrAfter(value, lowerBound) {
  return validTimestamp(value)
    && validTimestamp(lowerBound)
    && Date.parse(value) >= Date.parse(lowerBound);
}

function normalizedObservedVersion(value) {
  return value === null || value === undefined || value === "" ? "Unknown" : String(value);
}

function normalizedReadiness(value = {}) {
  return {
    result: value.result,
    ready: value.ready ?? null,
    desired: value.desired ?? null,
    workloads: Array.isArray(value.workloads) ? value.workloads : [],
  };
}

function sameStringSet(left, right) {
  return stableJson([...new Set(left ?? [])].sort()) === stableJson([...new Set(right ?? [])].sort());
}

function expectedSourceDigest(digests, path) {
  const digest = digests[path];
  return SHA256.test(digest ?? "") ? `sha256:${digest}` : null;
}

function evaluateFaithful({ config, catalogParity, faithful, digests, generatedEvidence, nowMs }) {
  const reasons = [];
  if (!faithful) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.faithful} is absent`]);
  const currentExample = faithful.spec?.source?.currentExample ?? {};
  const remoteGit = faithful.spec?.source?.git ?? {};
  const expectedCount = Number(catalogParity?.spec?.comparison?.fileCount ?? 0);
  const expectedParityTree = catalogParity?.spec?.comparison?.outputTreeSha256;
  const currentParityTree = digests[KUBARA_SITE_EVIDENCE_PATHS.generatedChecksums];
  const configDigest = digests[KUBARA_SITE_EVIDENCE_PATHS.config];
  const hub = (config?.clusters ?? []).find((cluster) => cluster.type === "hub");
  const repo = hub?.argocd?.repo?.https?.components;

  requireFact(reasons, faithful.kind === "KubaraFaithfulHubSpokeProofReceipt", "faithful receipt kind is not exact");
  requireFact(reasons, faithful.metadata?.name === "kubara-v0-13-0-faithful-hub-spoke", "faithful receipt identity is not exact");
  requireFact(reasons, faithful.status?.result === "pass", "faithful receipt does not pass");
  requireFact(reasons, faithful.spec?.execution === "serial-live-lock", "faithful receipt was not recorded under the serial live lock");
  requireFact(reasons, validTimestamp(faithful.spec?.observedAt), "faithful receipt observedAt is invalid");
  requireFact(reasons, timestampNotFuture(faithful.spec?.observedAt, nowMs), "faithful receipt observedAt is in the future");
  requireFact(reasons, faithful.spec?.source?.kubara?.version === EXPECTED.kubaraVersion, "faithful Kubara version is stale");
  requireFact(reasons, String(faithful.spec?.source?.catalogs?.version) === EXPECTED.catalogVersion, "faithful catalog version is stale");
  requireFact(reasons, catalogParity?.status?.result === "pass", "catalog parity receipt does not pass");
  requireFact(reasons, expectedCount === EXPECTED.generatedFiles, "catalog parity generated-file count changed");
  requireFact(reasons, SHA256.test(expectedParityTree ?? ""), "catalog parity tree digest is malformed");
  requireFact(reasons, expectedParityTree === currentParityTree, "catalog parity tree digest is stale in the generated-checksums hash domain");
  requireFact(reasons, catalogParity?.spec?.sourceConfig?.sha256 === configDigest, "catalog parity source config is stale");
  requireFact(reasons, currentExample.configSha256 === configDigest, "faithful source config is stale");
  requireFact(reasons, Number(generatedEvidence?.fileCount) === expectedCount, "current generated-tree file count differs from catalog parity");
  requireFact(reasons, SHA256.test(generatedEvidence?.sha256 ?? ""), "current generated-tree faithful-proof digest is unavailable");
  requireFact(reasons, Number(currentExample.generatedFileCount) === expectedCount, "faithful generated-file count is stale");
  requireFact(reasons, currentExample.generatedSha256 === generatedEvidence?.sha256, "faithful generated tree is stale in the faithful-proof hash domain");
  requireFact(reasons, Number(remoteGit.generatedFileCount) === expectedCount, "faithful remote Git generated-file count is stale");
  requireFact(reasons, remoteGit.generatedSha256 === generatedEvidence?.sha256, "faithful remote Git generated tree is stale in the faithful-proof hash domain");
  requireFact(reasons, remoteGit.currentExampleReachable === true, "faithful current example was not reachable in remote Git");
  requireFact(reasons, GIT_COMMIT.test(remoteGit.commit ?? ""), "faithful remote Git commit is not exact");
  requireFact(reasons, remoteGit.repository === repo?.url && remoteGit.targetRevision === repo?.targetRevision, "faithful remote Git identity differs from the Kubara config");
  requireFact(reasons, faithful.spec?.source?.contract?.gitRepository === repo?.url && faithful.spec?.source?.contract?.targetRevision === repo?.targetRevision, "faithful source contract differs from the Kubara config");
  requireFact(reasons, faithful.spec?.source?.contract?.zeroRepoint === true && faithful.spec?.argo?.sourceIntegrity?.zeroRepoint === true, "faithful proof does not retain zero-repoint Git delivery");
  requireFact(reasons, faithful.spec?.argo?.registration?.result === "pass", "faithful spoke registration does not pass");
  requireFact(reasons, faithful.spec?.argo?.sourceIntegrity?.result === "pass", "faithful Argo source-integrity check does not pass");
  requireFact(reasons, faithful.spec?.argo?.sourceIntegrity?.gitRepository === remoteGit.repository && faithful.spec?.argo?.sourceIntegrity?.targetRevision === remoteGit.targetRevision, "faithful Argo source identity differs from the verified Git source");
  const application = faithful.spec?.argo?.application ?? {};
  requireFact(reasons, application.name === "hx-app-staging-cert-manager" && application.destinationName === "hx-app-staging" && application.component === "cert-manager" && application.version === "v1.21.0", "faithful witness Application identity differs");
  requireFact(reasons, application.sync === "Synced" && application.health === "Healthy", "faithful witness Application is not Synced and Healthy");
  requireFact(reasons, Array.isArray(application.revisions) && application.revisions.length > 0 && application.revisions.every((revision) => revision === remoteGit.commit), "faithful witness Application did not reconcile the exact verified Git commit");
  requireFact(reasons, faithful.spec?.argo?.workload?.ready === true, "faithful witness workload is not ready");
  requireFact(reasons, faithful.spec?.cleanup?.baselineRestored === true && faithful.spec?.cleanup?.hubCluster === "pass" && faithful.spec?.cleanup?.spokeCluster === "pass" && faithful.spec?.cleanup?.localFiles === "pass", "faithful proof cleanup is incomplete");
  return gate(reasons);
}

function evaluateMiniIdp({ miniIdp, attempts, digests, canonicalValidation, nowMs }) {
  const reasons = [];
  if (!miniIdp) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.miniIdp} is absent`]);
  const sourceFiles = miniIdp.spec?.source?.files ?? {};
  const expectedSourceKeys = Object.keys(KUBARA_MINI_IDP_SOURCE_PATHS);
  const counts = miniIdp.spec?.counts ?? {};
  const runs = miniIdp.spec?.reconcileRuns ?? [];
  const rows = miniIdp.spec?.liveMatrix?.rows ?? [];
  const links = miniIdp.spec?.wiring?.links ?? [];
  const spaces = miniIdp.spec?.spaces ?? [];
  const units = miniIdp.spec?.units ?? [];
  const releases = miniIdp.spec?.releases ?? [];
  const applications = miniIdp.spec?.applications ?? [];

  requireFact(reasons, miniIdp.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", "mini-IDP receipt kind is not exact");
  requireFact(reasons, miniIdp.metadata?.name === "kubara-v0-13-0-confighub-mini-idp", "mini-IDP receipt identity is not exact");
  requireFact(reasons, miniIdp.spec?.organization?.name === EXPECTED.organizationName, "mini-IDP organization name differs");
  requireFact(reasons, miniIdp.spec?.organization?.externalID === EXPECTED.organizationExternalID, "mini-IDP external organization ID differs");
  requireFact(reasons, miniIdp.spec?.organization?.entityID === EXPECTED.organizationInternalID, "mini-IDP internal organization ID differs");
  requireFact(reasons, miniIdp.spec?.organization?.serverURL === EXPECTED.serverURL, "mini-IDP server differs");
  requireFact(reasons, miniIdp.spec?.source?.kubaraVersion === EXPECTED.kubaraVersion, "mini-IDP Kubara version is stale");
  requireFact(reasons, miniIdp.spec?.source?.catalogVersion === EXPECTED.catalogVersion, "mini-IDP catalog version is stale");
  requireFact(reasons, miniIdp.spec?.source?.exactVersionPolicy === "fail-if-missing", "mini-IDP exact-version policy changed");
  requireFact(reasons, miniIdp.spec?.source?.retentionPolicy === "additive-only", "mini-IDP retention policy changed");
  requireFact(reasons, sameStringSet(Object.keys(sourceFiles), expectedSourceKeys), "mini-IDP source evidence key set is not exact");
  for (const [key, path] of Object.entries(KUBARA_MINI_IDP_SOURCE_PATHS)) {
    const stored = sourceFiles[key];
    const expectedDigest = expectedSourceDigest(digests, path);
    requireFact(reasons, stored?.path === path, `mini-IDP source path ${key} differs`);
    requireFact(reasons, expectedDigest !== null && stored?.sha256 === expectedDigest, `mini-IDP source digest ${key} is stale`);
  }

  const expectedCounts = {
    spaces: EXPECTED.spaces,
    managedUnits: EXPECTED.managedUnits,
    preservedFaithfulControlUnits: EXPECTED.preservedFaithfulUnits,
    deployments: EXPECTED.deployments,
    deliveryApplicationUnits: EXPECTED.deliveryApplications,
    protectedNamespaceOwnershipDetachments: EXPECTED.clusters,
    kindTraefikContracts: EXPECTED.clusters,
    releases: EXPECTED.releases,
    needsProvidesLinks: EXPECTED.needsProvidesLinks,
    liveMatrixRows: EXPECTED.matrixRows,
  };
  for (const [name, value] of Object.entries(expectedCounts)) requireFact(reasons, Number(counts[name]) === value, `mini-IDP ${name} count is not ${value}`);
  requireFact(reasons, spaces.length === EXPECTED.spaces, "mini-IDP Space evidence is incomplete");
  requireFact(reasons, spaces.every((row) => typeof row.slug === "string" && UUID.test(row.id ?? "")) && new Set(spaces.map((row) => row.slug)).size === EXPECTED.spaces && new Set(spaces.map((row) => row.id)).size === EXPECTED.spaces, "mini-IDP Space identities are missing or duplicated");
  requireFact(reasons, units.length === EXPECTED.managedUnits, "mini-IDP Unit evidence is incomplete");
  requireFact(reasons, units.every((row) => typeof row.ref === "string" && UUID.test(row.id ?? "")) && new Set(units.map((row) => row.ref)).size === EXPECTED.managedUnits && new Set(units.map((row) => row.id)).size === EXPECTED.managedUnits, "mini-IDP Unit identities are missing or duplicated");
  requireFact(reasons, releases.length === EXPECTED.releases, "mini-IDP release evidence is incomplete");
  requireFact(reasons, releases.every((row) => typeof row.space === "string" && SHA256_PREFIXED.test(row.bundleDigest ?? "") && SHA256_PREFIXED.test(row.manifestDigest ?? "")) && new Set(releases.map((row) => row.space)).size === EXPECTED.releases, "mini-IDP release identities or OCI digests are missing or duplicated");
  requireFact(reasons, applications.length === EXPECTED.deployments, "mini-IDP Argo Application evidence is incomplete");
  requireFact(reasons, miniIdp.spec?.deliveryApplicationUnits?.length === EXPECTED.deliveryApplications, "mini-IDP delivery Application identity evidence is incomplete");
  requireFact(reasons, links.length === EXPECTED.needsProvidesLinks, "mini-IDP NeedsProvides Link evidence is incomplete");
  requireFact(reasons, links.every((row) => row.updateType === "NeedsProvides" && row.autoUpdate === false && UUID.test(row.id ?? "")), "mini-IDP Link identities or semantics are incomplete");
  requireFact(reasons, new Set(links.map((row) => row.id)).size === EXPECTED.needsProvidesLinks && new Set(links.map((row) => row.ref)).size === EXPECTED.needsProvidesLinks && links.every((row) => typeof row.ref === "string" && row.ref.includes("/")), "mini-IDP Link identities are missing or duplicated");
  requireFact(reasons, miniIdp.spec?.wiring?.sourceLedger === KUBARA_MINI_IDP_SOURCE_PATHS.wiring, "mini-IDP wiring source differs");
  requireFact(reasons, miniIdp.spec?.liveMatrix?.kind === "KubaraMiniIDPLiveMatrixObservation", "mini-IDP live matrix kind differs");
  requireFact(reasons, miniIdp.spec?.liveMatrix?.observationMode === "kubectl-and-confighub-live-read", "mini-IDP matrix is not a live observation");
  requireFact(reasons, miniIdp.spec?.liveMatrix?.desiredSource === KUBARA_MINI_IDP_SOURCE_PATHS.componentArtifacts, "mini-IDP live matrix desired source differs");
  requireFact(reasons, miniIdp.spec?.liveMatrix?.rowCount === EXPECTED.matrixRows && rows.length === EXPECTED.matrixRows, "mini-IDP live matrix is incomplete");
  const matrixKeys = rows.map((row) => `${row.cluster}/${row.component}`);
  requireFact(reasons, new Set(matrixKeys).size === EXPECTED.matrixRows, "mini-IDP live matrix contains duplicate cells");
  requireFact(reasons, sameStringSet(rows.map((row) => row.cluster), CLUSTERS), "mini-IDP live matrix cluster set differs");
  requireFact(reasons, sameStringSet(rows.map((row) => row.component), COMPONENTS), "mini-IDP live matrix component set differs");
  for (const row of rows) {
    if (row.deliveryState === "delivered") {
      requireFact(reasons, row.syncState === "Synced" && row.healthState === "Healthy", `${row.cluster}/${row.component} is not Synced and Healthy`);
      requireFact(reasons, row.readiness?.result === "pass", `${row.cluster}/${row.component} readiness is not pass`);
      requireFact(reasons, row.observedVersion !== null && row.observedVersion !== undefined && row.observedVersion !== "", `${row.cluster}/${row.component} observed version is missing`);
    } else {
      requireFact(reasons, row.deliveryState === "not-selected", `${row.cluster}/${row.component} delivery state is invalid`);
      requireFact(reasons, row.syncState === "NotApplicable" && row.healthState === "NotApplicable" && row.readiness?.result === "not-applicable", `${row.cluster}/${row.component} not-selected state is inconsistent`);
    }
  }
  const releasesBySpace = new Map(releases.map((row) => [row.space, row]));
  const applicationKeys = applications.map((row) => `${row.cluster}/${row.name}`);
  requireFact(reasons, new Set(applicationKeys).size === EXPECTED.deployments, "mini-IDP Argo Application identities are duplicated");
  for (const row of applications) {
    requireFact(reasons, SHA256_PREFIXED.test(row.expectedRevision ?? "") && row.observedRevision === row.expectedRevision, `${row.cluster}/${row.name} did not observe its exact OCI revision`);
    requireFact(reasons, row.expectedRevision === releasesBySpace.get(row.name)?.manifestDigest, `${row.cluster}/${row.name} expected revision is not its ConfigHub release manifest digest`);
    requireFact(reasons, row.syncState === "Synced" && row.healthState === "Healthy", `${row.cluster}/${row.name} is not Synced and Healthy`);
  }
  requireFact(reasons, runs.length >= 2 && runs.every((run) => run.result === "pass" && validTimestamp(run.observedAt) && timestampNotFuture(run.observedAt, nowMs)), "mini-IDP does not retain valid, non-future passing reconciliation observations");
  requireFact(reasons, runs.length >= 2 && timestampsStrictlyIncrease(runs), "mini-IDP reconciliation timestamps are not strictly increasing");
  const [changedRun, noopRun] = runs.length >= 2 ? runs.slice(-2) : [{}, {}];
  const durableAttempts = attempts?.attempts ?? [];
  const adjacentChangedThenNoop = changedRun.idempotentNoop === false
    && Number(changedRun.actionCount) > 0
    && noopRun.idempotentNoop === true
    && noopRun.actionCount === 0;
  requireFact(reasons, adjacentChangedThenNoop, "mini-IDP latest two observations are not an adjacent changed apply followed immediately by a zero-action apply");
  requireFact(reasons, attempts?.kind === "KubaraMiniIDPApplyAttemptLedger", "mini-IDP durable apply attempt ledger is missing or invalid");
  requireFact(reasons, Number(noopRun.attemptSequence) === Number(changedRun.attemptSequence) + 1, "mini-IDP accepted runs are not consecutive durable attempts");
  const changedAttempt = durableAttempts.find((item) => item.sequence === changedRun.attemptSequence);
  const noopAttempt = durableAttempts.find((item) => item.sequence === noopRun.attemptSequence);
  requireFact(reasons, changedAttempt?.id === changedRun.attemptID && changedAttempt?.result === "pass", "mini-IDP changed run is not backed by its passing durable attempt");
  requireFact(reasons, noopAttempt?.id === noopRun.attemptID && noopAttempt?.result === "pass", "mini-IDP no-op run is not backed by its passing durable attempt");
  requireFact(reasons, durableAttempts.at(-1)?.sequence === noopRun.attemptSequence, "a later mini-IDP apply attempt invalidates the accepted pair");
  requireFact(reasons, SHA256_PREFIXED.test(changedRun.executionFingerprint ?? "") && changedRun.executionFingerprint === noopRun.executionFingerprint, "mini-IDP accepted pair does not share one exact execution fingerprint");
  requireFact(reasons, miniIdp.spec?.deterministicProofMode === "immediate-changed-then-zero-action-rerun", "mini-IDP deterministic proof mode is not the required immediate changed-then-noop proof");
  const scenario = miniIdp.spec?.rolloutScenario ?? {};
  for (const id of ["initial-rollout", "base-promotion", "prod-approval", "prod-a-rollback", "staging-departure", "departure-survives-promotion"]) requireFact(reasons, (scenario.steps ?? []).some((row) => row.id === id && row.result === "pass"), `mini-IDP rollout scenario step ${id} is missing`);
  for (const [name, value] of Object.entries(scenario.claims ?? {})) requireFact(reasons, value === "pass", `mini-IDP rollout scenario claim ${name} does not pass`);
  requireFact(reasons, Object.keys(scenario.claims ?? {}).length >= 4, "mini-IDP rollout scenario claims are incomplete");
  requireFact(reasons, (scenario.finalChecks ?? []).length === 5 && scenario.finalChecks.every((row) => row.result === "pass"), "mini-IDP rollout final checks are incomplete");
  for (const ref of ["hx-web-prod-a", "hx-web-prod-b"]) requireFact(reasons, (scenario.operationEvidence ?? []).some((row) => row.type === "approval-gate-observed" && row.ref === ref && row.observationMode === "read-only-authoritative-gate" && row.gatedHeads?.length > 0), `mini-IDP stable read-only approval-gate evidence is missing for ${ref}`);
  requireFact(reasons, miniIdp.status?.result === "pass", "mini-IDP receipt does not pass");
  requireFact(reasons, validTimestamp(miniIdp.status?.observedAt), "mini-IDP observedAt is invalid");
  requireFact(reasons, timestampNotFuture(miniIdp.status?.observedAt, nowMs), "mini-IDP observedAt is in the future");
  requireFact(reasons, miniIdp.status?.observedAt === noopRun.observedAt, "mini-IDP status observedAt is not the immediate zero-action observation");
  requireFact(reasons, miniIdp.status?.deterministicReconciliationProven === true, "mini-IDP deterministic reconciliation is not proven");
  requireFact(reasons, miniIdp.status?.idempotentRerunProven === true, "mini-IDP idempotent rerun is not proven");
  requireFact(reasons, miniIdp.status?.fullCurrentSelectionDelivered === true, "mini-IDP full current selection is not delivered");
  requireFact(reasons, sameStringSet(miniIdp.status?.applicationsDelivered, ["hx-web", "cubbychat"]), "mini-IDP application set differs");
  requireFact(reasons, canonicalValidation?.miniIdp?.current === true, canonicalValidation?.miniIdp?.reason ?? "mini-IDP canonical current-fingerprint verifier did not pass");
  return gate(reasons);
}

function evaluatePerformance({ miniIdp, orphan, attempts, digests, performanceContract, canonicalValidation, nowMs }) {
  const reasons = [];
  if (!miniIdp) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.miniIdp} is absent, so no performance pair exists`]);
  if (!performanceContract) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.performanceContract} is absent`]);
  const receiptSchema = performanceContract.spec?.receiptSchema ?? {};
  const fixture = performanceContract.spec?.fixture ?? {};
  const pair = performanceContract.spec?.pairAcceptance ?? {};
  const runs = miniIdp.spec?.reconcileRuns ?? [];
  const [changedRun, noopRun] = runs.length >= 2 ? runs.slice(-2) : [{}, {}];

  requireFact(reasons, performanceContract.kind === "KubaraMiniIDPPerformanceAcceptance", "performance acceptance contract kind differs");
  requireFact(reasons, receiptSchema.schemaVersion === 2, "performance acceptance contract is not schema v2");
  requireFact(reasons, sameStringSet(receiptSchema.requiredRunClasses, ["changed-apply", "idempotent-apply"]), "performance acceptance run classes differ");
  requireFact(reasons, pair.secondMustBeImmediateNextRun === true && stableJson(pair.order) === stableJson(["changed-apply", "idempotent-apply"]), "performance contract does not require the immediate ordered pair");
  requireFact(reasons, pair.sameExecutionFingerprint === true && pair.sameFixture === true && pair.orphanAuditRequired === true, "performance pair identity or orphan boundary changed");
  requireFact(reasons, miniIdp.status?.performanceResult === pair.receiptStatus && pair.receiptStatus === "performance-pass", "mini-IDP performance status is not performance-pass");
  requireFact(reasons, miniIdp.status?.performanceAcceptance?.applyAttemptLedgerSha256 === expectedSourceDigest(digests, KUBARA_SITE_EVIDENCE_PATHS.attempts), "performance acceptance is not bound to the current durable attempt ledger");
  requireFact(reasons, attempts?.attempts?.at(-1)?.sequence === noopRun.attemptSequence && attempts.attempts.at(-1)?.result === "pass", "latest durable apply attempt invalidates performance acceptance");
  requireFact(reasons, changedRun.idempotentNoop === false && Number(changedRun.actionCount) > 0 && noopRun.idempotentNoop === true && noopRun.actionCount === 0, "performance evidence is not the latest adjacent changed/idempotent pair");
  requireFact(reasons, changedRun.result === "pass" && noopRun.result === "pass", "performance pair contains a failed reconciliation");
  requireFact(reasons, SHA256_PREFIXED.test(changedRun.executionFingerprint ?? "") && changedRun.executionFingerprint === noopRun.executionFingerprint, "performance pair execution fingerprints differ or are missing");
  requireFact(reasons, validTimestamp(changedRun.observedAt) && validTimestamp(noopRun.observedAt) && Date.parse(changedRun.observedAt) < Date.parse(noopRun.observedAt), "performance pair timestamps are invalid or unordered");
  requireFact(reasons, timestampNotFuture(changedRun.observedAt, nowMs) && timestampNotFuture(noopRun.observedAt, nowMs), "performance pair timestamp is in the future");
  for (const [run, runClass] of [[changedRun, "changed-apply"], [noopRun, "idempotent-apply"]]) {
    requireFact(reasons, run.performance?.schemaVersion === 2, `${runClass} performance evidence is not schema v2`);
    requireFact(reasons, run.performance?.fixtureID === fixture.id, `${runClass} performance fixture differs`);
    requireFact(reasons, run.performance?.runClass === runClass, `${runClass} performance class differs`);
  }
  requireFact(reasons, orphan?.status?.result === "pass" && orphan?.status?.findingCount === 0, "performance pair is not accompanied by a passing zero-finding orphan audit");
  requireFact(reasons, timestampAtOrAfter(orphan?.spec?.observedAt, noopRun.observedAt), "performance pair is not followed by its orphan audit");
  requireFact(reasons, canonicalValidation?.performance?.current === true, canonicalValidation?.performance?.reason ?? "performance v2 budget verifier did not pass");
  return gate(reasons);
}

function evaluateOrphan({ orphan, miniIdp, digests, planSha256, reconcilerSha256, canonicalValidation, nowMs }) {
  const reasons = [];
  if (!orphan) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.orphan} is absent`]);
  const expected = orphan.spec?.expected ?? {};
  const observed = orphan.spec?.observed ?? {};
  const expectedCounts = {
    spaces: EXPECTED.spaces,
    units: EXPECTED.orphanUnits,
    links: EXPECTED.orphanLinks,
    targets: EXPECTED.orphanTargets,
    currentReleaseStreams: EXPECTED.orphanReleaseStreams,
    argoApplications: EXPECTED.deliveryApplications,
  };
  requireFact(reasons, orphan.kind === "KubaraMiniIDPOrphanAuditReceipt", "orphan receipt kind is not exact");
  requireFact(reasons, orphan.metadata?.name === "kubara-v0-13-0-mini-idp-orphan-audit", "orphan receipt identity is not exact");
  requireFact(reasons, orphan.spec?.organization?.name === miniIdp?.spec?.organization?.name && orphan.spec?.organization?.name === EXPECTED.organizationName, "orphan and mini-IDP organization names differ");
  requireFact(reasons, orphan.spec?.organization?.externalID === miniIdp?.spec?.organization?.externalID && orphan.spec?.organization?.externalID === EXPECTED.organizationExternalID, "orphan and mini-IDP external organization IDs differ");
  requireFact(reasons, orphan.spec?.organization?.entityID === miniIdp?.spec?.organization?.entityID && orphan.spec?.organization?.entityID === EXPECTED.organizationInternalID, "orphan and mini-IDP internal organization IDs differ");
  requireFact(reasons, orphan.spec?.organization?.serverURL === miniIdp?.spec?.organization?.serverURL && orphan.spec?.organization?.serverURL === EXPECTED.serverURL, "orphan and mini-IDP servers differ");
  requireFact(reasons, validTimestamp(orphan.spec?.observedAt), "orphan receipt observedAt is invalid");
  requireFact(reasons, timestampNotFuture(orphan.spec?.observedAt, nowMs), "orphan receipt observedAt is in the future");
  requireFact(reasons, timestampAtOrAfter(orphan.spec?.observedAt, miniIdp?.status?.observedAt), "orphan audit predates the accepted mini-IDP observation");
  requireFact(reasons, orphan.spec?.source?.auditor === KUBARA_SITE_EVIDENCE_PATHS.orphanAuditor && orphan.spec?.source?.auditorSha256 === expectedSourceDigest(digests, KUBARA_SITE_EVIDENCE_PATHS.orphanAuditor), "orphan audit implementation digest is stale");
  requireFact(reasons, SHA256_PREFIXED.test(planSha256 ?? "") && orphan.spec?.source?.reconcilePlanSha256 === planSha256, "orphan audit reconcile plan is stale");
  requireFact(reasons, SHA256_PREFIXED.test(reconcilerSha256 ?? "") && orphan.spec?.source?.reconcilerSha256 === reconcilerSha256, "orphan audit reconciler is stale");
  requireFact(reasons, orphan.spec?.source?.applyAttemptLedgerSha256 === expectedSourceDigest(digests, KUBARA_SITE_EVIDENCE_PATHS.attempts), "orphan audit durable attempt ledger is stale");
  requireFact(reasons, orphan.spec?.execution?.readOnly === true && orphan.spec?.execution?.liveMutationCommands === 0 && orphan.spec?.execution?.sharedSerialLiveLock === true && orphan.spec?.execution?.operationJournalRequiredQuiescent === true, "orphan audit was not a quiescent, serial, read-only observation");
  requireFact(reasons, sameStringSet(orphan.spec?.execution?.persistentClustersPreserved, CLUSTERS), "orphan audit persistent-cluster allowlist differs");
  for (const [name, value] of Object.entries(expectedCounts)) requireFact(reasons, Number(expected[name]) === value, `orphan expected ${name} count is not ${value}`);
  for (const name of ["spaces", "units", "links", "targets", "argoApplications"]) requireFact(reasons, Number(observed[name]) === Number(expected[name]), `orphan observed ${name} count differs from its exact allowlist`);
  requireFact(reasons, orphan.spec?.findings?.length === 0, "orphan audit retains findings");
  requireFact(reasons, orphan.spec?.releaseClassification?.activeCurrent?.length === EXPECTED.orphanReleaseStreams && new Set(orphan.spec.releaseClassification.activeCurrent.map((row) => row.space)).size === EXPECTED.orphanReleaseStreams, "orphan audit active release-stream classification is incomplete or duplicated");
  requireFact(reasons, orphan.spec?.releaseClassification?.orphaned?.length === 0, "orphan audit retains orphan releases");
  requireFact(reasons, orphan.spec?.argo?.requiresPruningPolicy === "zero", "orphan audit permits Argo requiresPruning residue");
  requireFact(reasons, orphan.spec?.argo?.applications?.length === EXPECTED.deliveryApplications && new Set(orphan.spec.argo.applications.map((row) => `${row.cluster}/${row.name}`)).size === EXPECTED.deliveryApplications, "orphan audit Argo Application inventory is incomplete or duplicated");
  const durable = orphan.spec?.durableWorkloads ?? {};
  requireFact(reasons, orphan.spec?.auditScope?.clusterWideOrphanFreeClaim === false && String(orphan.spec?.auditScope?.excludedFromClusterWideClaim ?? "").includes("not a complete cluster inventory"), "orphan audit does not disclose its cluster inventory boundary");
  requireFact(reasons, durable.unclassifiedCount === 0 && durable.danglingTrackedCount === 0 && durable.missingBootstrap?.length === 0, "orphan audit retains unclassified, dangling, or missing bootstrap workloads");
  requireFact(reasons, Array.isArray(durable.rows) && durable.rows.length === Number(observed.durableWorkloads) && durable.rows.every((row) => ["argo-status-desired", "bootstrap-baseline", "generated-by-argo-desired-root"].includes(row.classification)), "orphan audit durable workload inventory is incomplete or contains a rejected classification");
  requireFact(reasons, durable.rows?.filter((row) => row.classification === "generated-by-argo-desired-root").every((row) => row.desiredControllerOwnerRoots?.length === 1 && row.staleDesiredOwnerRoots?.length === 0 && row.desiredControllerOwnerRoots.every((owner) => owner.uid && owner.uid === owner.liveUID)), "orphan audit generated workloads are not UID-bound to exactly one current desired controller owner");
  const protectedRows = orphan.spec?.protectedNamespaces?.rows ?? [];
  requireFact(reasons, Number(expected.protectedNamespaces) > 0 && protectedRows.length === Number(expected.protectedNamespaces), "orphan audit protected Namespace inventory is incomplete");
  requireFact(reasons, protectedRows.every((row) => CLUSTERS.includes(row.cluster) && UUID.test(row.uid ?? "") && row.phase === "Active" && row.staleOwnershipAnnotations?.length === 0 && row.staleLegacyOwnershipLabels?.length === 0), "orphan audit retains invalid or stale protected Namespace evidence");
  requireFact(reasons, orphan.status?.result === "pass", "orphan audit does not pass");
  for (const field of [
    "zeroAuditedResidue",
    "zeroUnexpectedConfigHubInventory",
    "zeroArgoRequiresPruning",
    "zeroUnclassifiedDurableWorkloads",
    "zeroDanglingTrackedDurableWorkloads",
    "zeroStaleControllerOwnership",
    "zeroProtectedNamespaceOwnership",
    "retainedReleaseHistoryProvedByTags",
  ]) requireFact(reasons, orphan.status?.[field] === true, `orphan audit ${field} is not true`);
  requireFact(reasons, Object.keys(orphan.status?.orphanCounts ?? {}).length > 0 && Object.values(orphan.status?.orphanCounts ?? {}).every((value) => value === 0), "orphan audit counters are absent or non-zero");
  requireFact(reasons, orphan.status?.findingCount === 0, "orphan audit finding count is non-zero");
  requireFact(reasons, canonicalValidation?.orphan?.current === true, canonicalValidation?.orphan?.reason ?? "orphan canonical exact-inventory verifier did not pass");
  return gate(reasons);
}

function evaluateWiring({ wiring, miniIdp, digests }) {
  const reasons = [];
  if (!wiring) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.wiring} is absent`]);
  const summary = wiring.spec?.summary ?? {};
  requireFact(reasons, wiring.kind === "KubaraProvidesNeedsGraph", "wiring graph kind is not exact");
  requireFact(reasons, wiring.metadata?.name === "current-platform-provides-needs", "wiring graph identity is not current");
  requireFact(reasons, wiring.spec?.evidence?.profileRole === "primary-current", "wiring graph is not the primary-current profile");
  requireFact(reasons, wiring.spec?.evidence?.kubaraVersion === EXPECTED.kubaraVersion && String(wiring.spec?.evidence?.catalogVersion) === EXPECTED.catalogVersion, "wiring graph version is stale");
  requireFact(reasons, sameStringSet(wiring.spec?.evidence?.clusters, CLUSTERS), "wiring graph cluster set differs");
  requireFact(reasons, Number(summary.componentInstances) === 13 && Number(summary.logicalComponents) === EXPECTED.platformComponents && Number(summary.clusters) === EXPECTED.clusters, "wiring graph scope differs");
  requireFact(reasons, wiring.spec?.components?.length === Number(summary.componentInstances), "wiring component inventory is incomplete");
  requireFact(reasons, wiring.spec?.facts?.length === Number(summary.facts) && Number(summary.facts) > EXPECTED.needsProvidesLinks, "wiring fact inventory is incomplete");
  requireFact(reasons, Array.isArray(wiring.spec?.edges) && wiring.spec.edges.length > Number(summary.facts), "wiring edge inventory is incomplete");
  requireFact(reasons, Number(summary.ambiguous) === 0, "wiring graph retains ambiguous ownership");
  requireFact(reasons, miniIdp?.spec?.wiring?.sourceLedger === KUBARA_SITE_EVIDENCE_PATHS.wiring, "mini-IDP does not cite the current wiring ledger");
  requireFact(reasons, miniIdp?.spec?.wiring?.links?.length === EXPECTED.needsProvidesLinks, "mini-IDP curated wiring Link inventory is incomplete");
  requireFact(reasons, miniIdp?.spec?.source?.files?.wiring?.sha256 === expectedSourceDigest(digests, KUBARA_SITE_EVIDENCE_PATHS.wiring), "mini-IDP does not hash the exact current wiring graph");
  return gate(reasons);
}

function evaluateMatrix({ matrix, miniIdp }) {
  const reasons = [];
  if (!matrix) return gate([`${KUBARA_SITE_EVIDENCE_PATHS.matrix} is absent`]);
  const evidence = matrix.spec?.evidence ?? {};
  const scope = matrix.spec?.scope ?? {};
  const rows = matrix.spec?.rows ?? [];
  const miniRows = miniIdp?.spec?.liveMatrix?.rows ?? [];
  requireFact(reasons, matrix.kind === "KubaraPlatformMatrix", "matrix kind is not exact");
  requireFact(reasons, matrix.metadata?.name === "kubara-v0.13.0-current-four-cluster", "matrix identity is not current");
  requireFact(reasons, matrix.spec?.profile?.role === "primary-current" && matrix.spec?.profile?.evidenceLayer === "optional-live-overlay", "matrix profile is not the current live overlay");
  requireFact(reasons, evidence.kubaraVersion === EXPECTED.kubaraVersion && String(evidence.catalogVersion) === EXPECTED.catalogVersion, "matrix version is stale");
  requireFact(reasons, evidence.faithfulReceiptStatus === "pass", "matrix does not accept the faithful receipt as source-current");
  requireFact(reasons, evidence.miniIdpReceipt?.path === KUBARA_SITE_EVIDENCE_PATHS.miniIdp, "matrix cites a different mini-IDP receipt");
  requireFact(reasons, evidence.miniIdpReceipt?.status === "accepted-current-live" && evidence.miniIdpReceipt?.acceptedAsLive === true, "matrix does not accept the mini-IDP receipt as current live evidence");
  requireFact(reasons, evidence.miniIdpReceipt?.observedAt === miniIdp?.status?.observedAt, "matrix and mini-IDP observation timestamps differ");
  requireFact(reasons, Number(evidence.miniIdpReceipt?.sourceDigestsVerified) === Object.keys(KUBARA_MINI_IDP_SOURCE_PATHS).length, "matrix did not verify every mini-IDP source digest");
  requireFact(reasons, Number(evidence.miniIdpReceipt?.parsedCells) === EXPECTED.matrixRows && Number(evidence.parsedObservationCells) === EXPECTED.matrixRows, "matrix did not parse every live cell");
  requireFact(reasons, scope.faithfulKubaraGitDelivery === "source-current-receipt-pass-with-recorded-scope", "matrix does not retain a current faithful delivery proof");
  requireFact(reasons, Number(scope.components) === EXPECTED.components && Number(scope.platformComponents) === EXPECTED.platformComponents && Number(scope.applications) === EXPECTED.applications && Number(scope.clusters) === EXPECTED.clusters && Number(scope.cells) === EXPECTED.matrixRows, "matrix scope differs");
  requireFact(reasons, matrix.spec?.components?.length === EXPECTED.components && matrix.spec?.clusters?.length === EXPECTED.clusters && rows.length === EXPECTED.matrixRows, "matrix inventory is incomplete");
  requireFact(reasons, sameStringSet(matrix.spec?.components?.map((row) => row.name), COMPONENTS), "matrix component set differs");
  requireFact(reasons, sameStringSet(matrix.spec?.clusters?.map((row) => row.name), CLUSTERS), "matrix cluster set differs");
  const miniByKey = new Map(miniRows.map((row) => [`${row.cluster}/${row.component}`, row]));
  requireFact(reasons, miniByKey.size === EXPECTED.matrixRows, "mini-IDP matrix rows are unavailable for the public matrix join");
  const seen = new Set();
  if (miniByKey.size === EXPECTED.matrixRows) {
    for (const row of rows) {
      const key = `${row.cluster}/${row.component}`;
      const source = miniByKey.get(key);
      requireFact(reasons, !seen.has(key), `matrix duplicates ${key}`);
      seen.add(key);
      requireFact(reasons, Boolean(source), `matrix contains unexpected cell ${key}`);
      if (!source) continue;
      for (const field of ["desiredVersion", "deliveryState", "syncState", "healthState", "unknownReason"]) requireFact(reasons, stableJson(row[field]) === stableJson(source[field]), `matrix ${key} ${field} differs from the mini-IDP receipt`);
      requireFact(reasons, row.observedVersion === normalizedObservedVersion(source.observedVersion), `matrix ${key} observedVersion differs from the mini-IDP receipt`);
      requireFact(reasons, stableJson(row.readiness) === stableJson(normalizedReadiness(source.readiness)), `matrix ${key} readiness differs from the canonical mini-IDP receipt mapping`);
      requireFact(reasons, stableJson(row.departure ?? null) === stableJson(source.departure ?? null), `matrix ${key} departure differs from the mini-IDP receipt`);
    }
    requireFact(reasons, seen.size === EXPECTED.matrixRows, "matrix cell set is incomplete");
  }
  return gate(reasons);
}

function evaluateGui({ gui, guiImagePaths, faithful, miniIdp, orphan, digests, requireGui = true, nowMs }) {
  const reasons = [];
  const required = requireGui || guiImagePaths.length > 0 || Boolean(gui);
  if (!required) return { current: true, required: false, status: "not-required", reasons: [] };
  if (guiImagePaths.length === 0 && !gui) return { current: false, required: true, status: "not-published", reasons: [`the final current-live release requires exactly ${EXPECTED.requiredGuiFrames} receipt-bound GUI frames`] };
  if (!gui) return { current: false, required: true, status: "receipt-missing", reasons: [`${KUBARA_SITE_EVIDENCE_PATHS.gui} is required when GUI screenshots are published`] };
  requireFact(reasons, guiImagePaths.length === EXPECTED.requiredGuiFrames, `GUI tour must publish exactly ${EXPECTED.requiredGuiFrames} receipt-bound frames`);
  requireFact(reasons, guiImagePaths.every((path) => !/^(?:[a-z]+:|\/)/i.test(path) && path !== ".." && !path.startsWith("../")), "GUI tour contains a non-repository-local or escaping image path");
  requireFact(reasons, gui.kind === "KubaraConfigHubGuiEvidenceReceipt", "GUI receipt kind is not exact");
  requireFact(reasons, gui.status?.result === "pass" && gui.status?.sourceCurrent === true, "GUI receipt does not pass as source-current");
  requireFact(reasons, gui.spec?.sourceCommit === faithful?.spec?.source?.git?.commit && GIT_COMMIT.test(gui.spec?.sourceCommit ?? ""), "GUI source commit differs from the faithful Git commit");
  requireFact(reasons, gui.spec?.organizationExternalID === miniIdp?.spec?.organization?.externalID && gui.spec?.organizationExternalID === orphan?.spec?.organization?.externalID, "GUI external organization ID differs from the live receipts");
  requireFact(reasons, gui.spec?.organizationInternalID === miniIdp?.spec?.organization?.entityID && gui.spec?.organizationInternalID === orphan?.spec?.organization?.entityID, "GUI internal organization ID differs from the live receipts");
  const hashTargets = {
    faithfulReceiptSHA256: KUBARA_SITE_EVIDENCE_PATHS.faithful,
    miniIdpReceiptSHA256: KUBARA_SITE_EVIDENCE_PATHS.miniIdp,
    orphanReceiptSHA256: KUBARA_SITE_EVIDENCE_PATHS.orphan,
    matrixSHA256: KUBARA_SITE_EVIDENCE_PATHS.matrix,
    wiringSHA256: KUBARA_SITE_EVIDENCE_PATHS.wiring,
  };
  for (const [field, path] of Object.entries(hashTargets)) requireFact(reasons, SHA256.test(gui.spec?.[field] ?? "") && gui.spec?.[field] === digests[path], `GUI ${field} is stale`);
  const records = gui.spec?.images ?? [];
  requireFact(reasons, records.length === guiImagePaths.length, "GUI receipt image inventory differs from the published tour");
  requireFact(reasons, new Set(records.map((row) => row.path)).size === records.length, "GUI receipt contains duplicate image paths");
  requireFact(reasons, sameStringSet(records.map((row) => row.path), guiImagePaths), "GUI receipt paths differ from the published tour");
  for (const path of guiImagePaths) {
    const record = records.find((row) => row.path === path);
    requireFact(reasons, Boolean(record), `GUI receipt is missing ${path}`);
    if (!record) continue;
    requireFact(reasons, SHA256.test(record.sha256 ?? "") && record.sha256 === digests[path], `GUI screenshot ${path} digest is stale`);
    requireFact(reasons, validTimestamp(record.capturedAt), `GUI screenshot ${path} capturedAt is invalid`);
    requireFact(reasons, timestampNotFuture(record.capturedAt, nowMs), `GUI screenshot ${path} capturedAt is in the future`);
    requireFact(reasons, timestampAtOrAfter(record.capturedAt, faithful?.spec?.observedAt) && timestampAtOrAfter(record.capturedAt, miniIdp?.status?.observedAt) && timestampAtOrAfter(record.capturedAt, orphan?.spec?.observedAt), `GUI screenshot ${path} predates the accepted live receipts`);
    requireFact(reasons, Array.isArray(record.visibleIdentities) && record.visibleIdentities.length > 0, `GUI screenshot ${path} has no visible identities`);
    for (const field of ["sensitiveValues", "caption", "claimBoundary"]) requireFact(reasons, Boolean(record[field]), `GUI screenshot ${path} has no ${field}`);
  }
  return { ...gate(reasons), required: true, status: reasons.length === 0 ? "current" : "stale-or-incomplete" };
}

export function evaluateKubaraSiteLiveEvidenceDocuments(input) {
  const faithful = evaluateFaithful(input);
  const miniIdp = evaluateMiniIdp(input);
  const orphan = evaluateOrphan(input);
  const performance = evaluatePerformance(input);
  const wiring = evaluateWiring(input);
  const matrix = evaluateMatrix(input);
  const gui = evaluateGui(input);
  const gates = { faithful, miniIdp, orphan, performance, matrix, wiring, gui };
  return {
    ...gates,
    current: Object.values(gates).every((item) => item.current),
    reasons: Object.entries(gates).flatMap(([name, item]) => item.reasons.map((reason) => `${name}: ${reason}`)),
    receiptDigests: {
      faithful: input.digests[KUBARA_SITE_EVIDENCE_PATHS.faithful] ?? null,
      miniIdp: input.digests[KUBARA_SITE_EVIDENCE_PATHS.miniIdp] ?? null,
      orphan: input.digests[KUBARA_SITE_EVIDENCE_PATHS.orphan] ?? null,
      matrix: input.digests[KUBARA_SITE_EVIDENCE_PATHS.matrix] ?? null,
      wiring: input.digests[KUBARA_SITE_EVIDENCE_PATHS.wiring] ?? null,
      performanceContract: input.digests[KUBARA_SITE_EVIDENCE_PATHS.performanceContract] ?? null,
    },
  };
}

function optionalYaml(root, path) {
  const absolute = join(root, path);
  return existsSync(absolute) ? readYaml(absolute) : null;
}

function optionalJson(root, path) {
  const absolute = join(root, path);
  return existsSync(absolute) ? JSON.parse(readFileSync(absolute, "utf8")) : null;
}

function repoDigest(root, path) {
  if (!safeRepoRelativePath(path)) return null;
  const absolute = resolve(root, path);
  return existsSync(absolute) ? sha256File(absolute) : null;
}

function currentGeneratedEvidence(root) {
  const generatedRoot = join(root, "examples", "kubara", "current-platform", "generated");
  const components = join(generatedRoot, "platform-components");
  const configs = join(generatedRoot, "platform-configs");
  if (!existsSync(components) || !existsSync(configs)) return null;
  const files = [...listFiles(components), ...listFiles(configs)]
    .sort((left, right) => relative(generatedRoot, left).localeCompare(relative(generatedRoot, right)));
  const entries = files.map((path) => ({
    path: relative(generatedRoot, path).replaceAll("\\", "/"),
    sha256: sha256File(path),
  }));
  return {
    fileCount: entries.length,
    sha256: sha256(JSON.stringify(entries)),
  };
}

function safeRepoRelativePath(path) {
  return typeof path === "string"
    && !/^(?:[a-z]+:|\/)/i.test(path)
    && path !== ".."
    && !path.startsWith("../");
}

export function kubaraGuiImagePaths(root = defaultRepoRoot) {
  const tourPath = join(root, KUBARA_SITE_EVIDENCE_PATHS.guiTour);
  if (!existsSync(tourPath)) return [];
  const raw = readFileSync(tourPath, "utf8");
  const markdown = [...raw.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const html = [...raw.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  return [...new Set([...markdown, ...html].map((path) => {
    if (/^(?:[a-z]+:|\/)/i.test(path)) return path;
    return relative(root, resolve(dirname(tourPath), path)).replaceAll("\\", "/");
  }))].sort();
}

function currentPlanDigest(root) {
  const reconciler = join(root, KUBARA_SITE_EVIDENCE_PATHS.reconciler);
  if (!existsSync(reconciler)) return null;
  try {
    const plan = JSON.parse(execFileSync(process.execPath, [reconciler, "--plan"], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    }));
    return `sha256:${sha256(stableJson(plan))}`;
  } catch {
    return null;
  }
}

function offlineVerifier(root, path, args, enabled, label) {
  if (!enabled) return { current: false, reason: `${label} receipt is absent` };
  const script = join(root, path);
  if (!existsSync(script)) return { current: false, reason: `${path} is absent` };
  try {
    execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    });
    return { current: true, reason: null };
  } catch {
    return { current: false, reason: `${label} canonical offline verifier rejected the committed receipt` };
  }
}

export function evaluateKubaraSiteLiveEvidence({ root = defaultRepoRoot, requireGui = true } = {}) {
  const guiImagePaths = kubaraGuiImagePaths(root);
  const digestPaths = new Set([
    ...Object.values(KUBARA_MINI_IDP_SOURCE_PATHS),
    ...Object.values(KUBARA_SITE_EVIDENCE_PATHS).filter((path) => path !== KUBARA_SITE_EVIDENCE_PATHS.guiTour),
    ...guiImagePaths.filter(safeRepoRelativePath),
  ]);
  const digests = Object.fromEntries([...digestPaths].map((path) => [path, repoDigest(root, path)]));
  const miniIdp = optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.miniIdp);
  const attempts = optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.attempts);
  const orphan = optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.orphan);
  const canonicalValidation = {
    miniIdp: offlineVerifier(root, KUBARA_SITE_EVIDENCE_PATHS.reconciler, ["--receipt-verify"], Boolean(miniIdp), "mini-IDP"),
    orphan: offlineVerifier(root, KUBARA_SITE_EVIDENCE_PATHS.orphanAuditor, ["--receipt-verify"], Boolean(orphan), "orphan audit"),
    performance: offlineVerifier(root, KUBARA_SITE_EVIDENCE_PATHS.performanceVerifier, ["--receipt-verify"], Boolean(miniIdp && orphan), "performance pair"),
  };
  return evaluateKubaraSiteLiveEvidenceDocuments({
    config: optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.config),
    catalogParity: optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.catalogParity),
    faithful: optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.faithful),
    miniIdp,
    attempts,
    orphan,
    performanceContract: optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.performanceContract),
    matrix: optionalJson(root, KUBARA_SITE_EVIDENCE_PATHS.matrix),
    wiring: optionalJson(root, KUBARA_SITE_EVIDENCE_PATHS.wiring),
    gui: optionalYaml(root, KUBARA_SITE_EVIDENCE_PATHS.gui),
    guiImagePaths,
    requireGui,
    canonicalValidation,
    generatedEvidence: currentGeneratedEvidence(root),
    nowMs: Date.now(),
    digests,
    planSha256: orphan ? currentPlanDigest(root) : null,
    reconcilerSha256: expectedSourceDigest(digests, KUBARA_SITE_EVIDENCE_PATHS.reconciler),
  });
}
