#!/usr/bin/env node

// Deterministically reconcile the current Kubara + ConfigHub mini-IDP.
//
// The required path is deliberately conventional: committed Kubara v0.13.0
// output is stored as ConfigHub Units, ConfigHub variants bind it to four
// persistent targets, and ConfigHub-owned Argo CD/argobot reconciles each
// target. No AI authoring or migration step is required.
//
// Modes:
//   --plan            validate local inputs and print the exact offline plan
//   --apply           reconcile the allowlisted live state and write a receipt
//   --verify          read-only comparison of live state with the plan
//   --receipt-verify  verify the committed live receipt without a login
//   --self-test       exercise restart-safe release decisions without live I/O
//   --self-test-performance  exercise only read-cache/performance invariants
//   --diagnose-journal read-only comparison of an in-flight scenario journal
//   --diagnose-history read-only explanation of prior scenario receipt trust
//   --rebind-journal safely rebind an exact matching scenario checkpoint and
//                    recover an allowlisted immutable-selector convergence blocker
//
// Safety properties:
//   * live modes require the Kubara organization;
//   * every writable Space, Unit, Trigger, Filter, and Link is allowlisted;
//   * ConfigHub objects and hx-app-* clusters are never deleted by this script;
//   * exact workload Applications retain Kubara's bounded Argo prune behavior;
//   * one exact tracked namespace-move DaemonSet may be pruned only after
//     proving the old/new tracking identities and shared host-network binding;
//   * sixteen exact hx-web and Cubbychat workloads may be replaced once, with
//     UID/resourceVersion preconditions, solely to migrate immutable selectors;
//   * a completely absent cluster may be created with `cub cluster up`;
//   * partial state within one cluster is rejected; a complete ordered fleet
//     prefix resumes only from the exact write-ahead bootstrap journal;
//   * apply refuses to overlap the serial live-parity harness;
//   * PILOT_ACTIVE and other mutation-guard environment variables are ignored,
//     as explicitly requested for this example.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  check,
  identityFor,
  parseDocs,
  readYaml,
  readYamlText,
  relativeRepo,
  repoRoot,
  sha256,
  sha256File,
  toYaml,
} from "./lib/proof-common.mjs";
import {
  PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS,
  PROTECTED_NAMESPACE_OWNERSHIP_POLICY,
  assertProtectedNamespaceDetachmentEvidence,
  classifyProtectedNamespaceOwnership,
  protectedNamespaceDetachPatch,
  protectedNamespaceDetachmentFor,
  selfTestProtectedNamespaceOwnership,
  validateProtectedNamespaceDetached,
} from "./lib/kubara-protected-namespace.mjs";
import {
  KIND_TRAEFIK_CONTRACTS,
  KIND_TRAEFIK_POLICY,
  assertKindTraefikLiveObjects,
  assertKindTraefikRenderedObjects,
  selfTestKindTraefikContract,
} from "./lib/kubara-kind-traefik.mjs";

const modes = new Set(["--plan", "--apply", "--verify", "--receipt-verify", "--self-test", "--self-test-performance", "--diagnose-journal", "--diagnose-history", "--rebind-journal"]);
validateCliArgs();
const requestedModes = process.argv.filter((arg) => modes.has(arg));
check(requestedModes.length <= 1, `choose one mode: ${[...modes].join(", ")}`);
const mode = requestedModes[0] ?? "--plan";
const contextValue = optionValue("--context") || process.env.CUB_CONTEXT?.trim() || "";
let pinnedContextName = contextValue;
let contextArgs = contextValue ? ["--context", contextValue] : [];

const ORGANIZATION = "Kubara";
const ORGANIZATION_EXTERNAL_ID = "58b23b85-9699-4384-bd57-80ef695a1d58";
const ORGANIZATION_ENTITY_ID = "12c33fa8-00b1-4011-ad3e-19d56458b29c";
const CONFIGHUB_SERVER_URL = "https://hub.confighub.com";
const KUBARA_VERSION = "v0.13.0";
const CATALOG_VERSION = "1.1.0";
const MIN_CUB_VERSION = "0.2.11";
const EXAMPLE_COHORT = "kubara-v0.13.0";
const PRIOR_COHORT = "kubara-v0.12.0";
const CONTROL_SPACE = "hx-platform";
const APPROVAL_TRIGGER = "require-approval";
const APPROVAL_FILTER = "prod-approval";
const APPROVAL_GATE = `${CONTROL_SPACE}/${APPROVAL_TRIGGER}/vet-approvedby`;
const PROD_SAFETY_GATE = "prod-critical";
const SCENARIO_VERSION = "hx-web-promotion-v2";
const SCENARIO_STEPS = [
  "merge-bases-reset",
  "initial-rollout",
  "base-promotion",
  "prod-approval",
  "prod-a-rollback",
  "staging-departure",
  "departure-survives-promotion",
];
const LINK_REASON_ANNOTATION = "helm-expt.confighub.com/reason";
const CONFIGHUB_OCI_SPACE_PREFIX = "oci://oci.hub.confighub.com:443/space/";
const ARGO_PRUNE_POLICY = "Argo may prune only resources tracked by one of the 27 exact allowlisted deployment Applications; ConfigHub objects and persistent clusters are never deleted";
const ARGO_NAMESPACE_MOVE_POLICY = "one declared tracked DaemonSet may be deleted with UID/resourceVersion preconditions from its obsolete namespace only at the exact expected OCI revision and after Argo marks it requiresPruning, the same desired workload exists in the Kubara namespace, both tracking IDs match, both ConfigHub origins match, and the reviewed TCP/9100 host-network binding conflicts";
const IMMUTABLE_SELECTOR_REPLACEMENT_POLICY = "each of the sixteen declared hx-web and Cubbychat workloads may be deleted and recreated once with UID/resourceVersion preconditions only after an attempted operation at the exact expected OCI revision records that exact resource's immutable-selector failure, the live object matches its reviewed legacy selector and exact Argo/ConfigHub ownership, the desired payload matches its reviewed replacement selector, and any retained PostgreSQL PVC is UID-bound before and after replacement";
const ARGO_RETRY_POLICY = "persist one 90-minute convergence deadline and at most four sync-submission reservations per Application and OCI digest across restarts; observe an existing Argo operation without replacement for up to 60 minutes; wait for exact-revision health without resyncing for up to 30 minutes; reserve a new sync only after inactive terminal failure, OutOfSync, or wrong revision";
const ARGO_OPERATION_TIMEOUT_MS = 60 * 60 * 1000;
const ARGO_HEALTH_TIMEOUT_MS = 30 * 60 * 1000;
const ARGO_CONVERGENCE_TIMEOUT_MS = 90 * 60 * 1000;
const ARGO_MAX_SYNC_REQUESTS = 4;
const ARGO_OBSERVE_SECONDS = 5;
const NAMESPACE_MOVE_MIGRATION_ID = "hx-kps-main/node-exporter-default-to-kube-prometheus-stack/v1";
const IMMUTABLE_SELECTOR_MIGRATION_VERSION = "v1";
const IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY = "terminal-exact-resource-failure-v2";
const IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_EFFECTIVE_AT = "2026-08-05T19:30:00.000Z";
const HX_WEB_LEGACY_SELECTOR = Object.freeze({ app: "hx-web" });
const HX_WEB_REVIEWED_SELECTOR = Object.freeze({ "app.kubernetes.io/name": "hx-web" });
const CUBBYCHAT_LEGACY_SELECTORS = Object.freeze({
  backend: Object.freeze({ app: "backend" }),
  frontend: Object.freeze({ app: "frontend" }),
  postgres: Object.freeze({ app: "postgres" }),
});
const CUBBYCHAT_REVIEWED_SELECTORS = Object.freeze({
  backend: Object.freeze({ "app.kubernetes.io/name": "cubbychat-backend" }),
  frontend: Object.freeze({ "app.kubernetes.io/name": "cubbychat-frontend" }),
  postgres: Object.freeze({ "app.kubernetes.io/name": "postgres" }),
});
const ARGO_REVISION_POLICY = "disable Argo automated sync for every managed Application; accept and submit only the exact authoritative ConfigHub OCI ManifestDigest with a Kubernetes UID/resourceVersion compare-and-set; targetRevision latest is discovery-only and argobot refreshes cannot deploy";
const INTERRUPTED_RELEASE_POLICY = "publish whenever any Unit head differs from its last applied revision; reuse the exact published release for metadata-only changes or ConfigHub's unchanged-bundle response; pass only the published OCI ManifestDigest to Argo";
const INTERRUPTED_SCENARIO_POLICY = "write ahead every ordered hx-web mutation as a nested transition with exact pre/post Unit, release, provenance, and UpgradeUnit checkpoints; bind approval to exact heads observed twice behind the gate and rollback to the exact initial-rollout revision; resume only an exact durable prefix and fail closed on every undeclared delta";
const PUBLISHED_RELEASE_SELECTION_POLICY = "filter Published = true server-side before selecting the highest ReleaseNum; withdrawn releases never satisfy currency or drive Argo";
const DELIVERY_ROOT_PUBLICATION_POLICY = "reconcile every declared Argo Application Unit with automated sync disabled; retain bootstrap and variant-created release history only behind a fenced no-auto root; select or publish one complete authoritative delivery-root release per cluster; compare-and-set that exact root ManifestDigest into Argo before any source release can converge; and forbid later Application Unit mutations in the run";
const UNCHANGED_RELEASE_ERROR = "no changes were made since :latest bundle";
const GUI_IDENTITY_POLICY = "native Component, Owner, Variant, and Lane labels make the component-first Kubara catalog, faithful/adapted delivery choice, and definition-instance hub-spoke shape visible; the component-catalog-coverage Unit exposes the additive 103-component/130-version scope and all 18 Kubara selections; Kubara hub Argo and ConfigHub cluster-bootstrap Argo retain separate exact version provenance; public navigation annotations link complete evidence without claiming live health";
const RECONCILE_PROFILE = "bounded-bulk-v3";
const PUBLIC_GUIDE_URL = "https://confighub.github.io/helm-expt/site/kubara.html";
const PUBLIC_ADOPTION_URL = "https://confighub.github.io/helm-expt/site/d/docs/demo/kubara/adoption.html";
const PUBLIC_PERFORMANCE_URL = "https://confighub.github.io/helm-expt/site/d/docs/demo/kubara/reconciliation-performance.html";
const PUBLIC_CATALOG_URL = "https://confighub.github.io/helm-expt/site/charts/";
const PUBLIC_CATALOG_COVERAGE_URL = "https://confighub.github.io/helm-expt/data/kubara-catalog-1.1-full-coverage/receipt.yaml";
const PUBLIC_MATRIX_URL = "https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html";
const PUBLIC_WIRING_URL = "https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html";
const PUBLIC_RESIDUE_AUDIT_URL = "https://confighub.github.io/helm-expt/runs/kubara-mini-idp-reconcile/orphan-audit.yaml";
const PUBLIC_NAVIGATION_ANNOTATIONS = Object.freeze({
  "URL-Guide": PUBLIC_GUIDE_URL,
  "URL-Adoption": PUBLIC_ADOPTION_URL,
  "URL-Performance": PUBLIC_PERFORMANCE_URL,
  "URL-Catalog": PUBLIC_CATALOG_URL,
  "URL-CatalogCoverage": PUBLIC_CATALOG_COVERAGE_URL,
  "URL-Matrix": PUBLIC_MATRIX_URL,
  "URL-Wiring": PUBLIC_WIRING_URL,
  "URL-ResidueAudit": PUBLIC_RESIDUE_AUDIT_URL,
});
const MATRIX_PUBLICATION_PATH = "data/kubara-platform-matrix/matrix.json";
const RECEIPT_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "receipt.yaml");
const APPLY_ATTEMPTS_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "attempts.yaml");
const OPERATION_JOURNAL_PATH = join(homedir(), ".confighub", "locks", "helm-expt-kubara-operation-journal.json");
const FAITHFUL_PROOF_SCRIPT = "scripts/run-kubara-faithful-hub-spoke-proof.mjs";
const FAITHFUL_FAILURE_PATH = "runs/kubara-faithful-hub-spoke/failure.yaml";
const FAITHFUL_ATTEMPT_PATH = "runs/kubara-faithful-hub-spoke/attempt.yaml";
const PRESERVED_FAITHFUL_CONTROL_UNITS = [
  {
    slug: "faithful-hub-spoke-plan",
    receiptKey: "planCheckAndApproval",
    role: "FaithfulLanePlan",
    proofPhase: "Plan",
  },
  {
    slug: "faithful-hub-spoke-attestation",
    receiptKey: "observedAttestation",
    role: "FaithfulLaneAttestation",
    proofPhase: "Observed",
  },
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINAL_CONFIGHUB_FINGERPRINT_RESOURCES = Object.freeze(["space", "unit", "release", "link", "target"]);
let cachedCubVersions = null;
let cachedFaithfulReceipt = null;
let cachedFaithfulAvailability = null;
const PROCESS_STARTED_AT_MS = performance.now();
const commandPerformance = new Map();
const canonicalYamlCache = new Map();
const canonicalYamlPerformance = {
  requests: 0,
  hits: 0,
  misses: 0,
  parseMs: 0,
};
let activeVerificationReadSnapshot = null;
let activeSourceReleaseBoundarySnapshot = null;
let activeAuthoritativeReleaseReuseBatch = null;
let activeApplyReadSnapshot = null;
let activeReconcilePerformance = null;
let activeConfigHubReadPurpose = "";
let lastCompletedApplyReadEvidence = null;
let lastCompletedPerformancePhases = [];

const RECONCILE_PERFORMANCE_SCHEMA_VERSION = 2;
const RECONCILE_PERFORMANCE_FIXTURE_ID = "kubara-v0-13-0-four-cluster-warm-v1";
const CONFIGHUB_READ_PURPOSES = Object.freeze([
  "content",
  "metadata-discovery",
  "mutation-target-pin",
]);
const WAIT_REASONS = new Set([
  "argo-application-contract",
  "argo-active-operation",
  "argo-health-pending",
  "argo-retry-backoff",
  "argo-refresh-ack",
  "immutable-selector-old-uid-gone",
  "immutable-selector-settle",
  "namespace-move-uid-gone",
  "protected-namespace-settle",
]);
const ACTION_MUTATION_VERB = Object.freeze({
  "approval-policy": "cub.space.update",
  "argo-application": "cub.unit.update",
  "argo-application-metadata": "cub.unit.update",
  "cluster-up": "cub.cluster.up",
  "filter-create": "cub.filter.create",
  "filter-update": "cub.filter.update",
  "link-create": "cub.link.create",
  "link-update": "cub.link.update",
  "release-publish": "cub.release.publish",
  rollback: "cub.unit.update",
  "scenario-marker": "cub.space.update",
  "scenario-merge-base-reset": "cub.link.update",
  "space-create": "cub.space.create",
  "space-metadata": "cub.space.update",
  "space-release-target": "cub.space.update",
  "trigger-create": "cub.trigger.create",
  "trigger-update": "cub.trigger.update",
  "unit-approve": "cub.unit.approve",
  "unit-create": "cub.unit.create",
  "unit-data": "cub.unit.update",
  "unit-metadata": "cub.unit.update",
  "unit-protection": "cub.unit.update",
  "unit-target": "cub.unit.set-target",
  "unit-target-clear": "cub.unit.set-target",
  "variant-create": "cub.variant.create",
  "variant-promote": "cub.variant.promote",
});

const APPLY_READ_RESOURCES = Object.freeze(["space", "unit", "release", "link", "target"]);
const APPLY_READ_CONSISTENCY = "one organization-wide snapshot at apply start and each declared phase boundary; successful ConfigHub mutations invalidate their affected cache scope and the no-write release-reuse batch; every ConfigHub or Argo side effect revalidates its exact release boundary; final verification must open at the unchanged pre-release organization fingerprint and close at that same fingerprint";
const MUTATING_CUB_COMMAND_PAIRS = new Set([
  "cluster/up",
  "filter/create", "filter/update",
  "link/create", "link/update",
  "release/publish",
  "space/create", "space/update",
  "trigger/create", "trigger/update",
  "unit/approve", "unit/create", "unit/set-target", "unit/update",
  "variant/create", "variant/promote",
]);
const READ_ONLY_CUB_COMMAND_PAIRS = new Set([
  "filter/get",
  "link/list",
  "release/list",
  "space/get", "space/list",
  "target/get", "target/list",
  "trigger/get",
  "unit/data", "unit/diff", "unit/get", "unit/list",
  "version/",
]);
const UNIT_READ_SELECT = "Labels,Annotations,TargetID,UpstreamUnitID,DeleteGates,DestroyGates,ToolchainType,ProviderType,Data,DataHash,ContentHash,HeadRevisionNum,LastAppliedRevisionNum,ApprovedBy,ApplyGates";
const LINK_READ_SELECT = "FromUnitID,ToUnitID,ToSpaceID,UpdateType,AutoUpdate,Labels,Annotations,UpstreamLastMergedRevisionNum,DownstreamLastMergedRevisionNum";
const SPACE_READ_SELECT = "OrganizationID,Labels,Annotations,ReleaseTargetID,TriggerFilterID,TriggerIDs,WhereTrigger,DeleteGates";
const RELEASE_READ_SELECT = "TagID,Digest,ManifestDigest,ReleaseNum,UnitCount,CreatedAt";
const TARGET_READ_SELECT = "SpaceID,ProviderType,ToolchainType,Annotations";
const SPACE_DECISION_FIELDS = Object.freeze(["OrganizationID", "SpaceID", "Slug", "Labels", "Annotations", "ReleaseTargetID", "TriggerFilterID", "TriggerIDs", "WhereTrigger", "DeleteGates"]);
const UNIT_DECISION_FIELDS = Object.freeze(["SpaceID", "UnitID", "Slug", "Labels", "Annotations", "TargetID", "UpstreamUnitID", "DeleteGates", "DestroyGates", "ToolchainType", "ProviderType", "Data", "DataHash", "ContentHash", "HeadRevisionNum", "LastAppliedRevisionNum", "ApprovedBy", "ApplyGates"]);
const RELEASE_DECISION_FIELDS = Object.freeze(["SpaceID", "ReleaseID", "TagID", "Digest", "ManifestDigest", "ReleaseNum", "UnitCount", "CreatedAt"]);
const LINK_DECISION_FIELDS = Object.freeze(["SpaceID", "LinkID", "Slug", "FromUnitID", "ToUnitID", "ToSpaceID", "UpdateType", "AutoUpdate", "UpstreamLastMergedRevisionNum", "DownstreamLastMergedRevisionNum", "Labels", "Annotations"]);
const TARGET_DECISION_FIELDS = Object.freeze(["SpaceID", "TargetID", "Slug", "ProviderType", "ToolchainType", "Annotations"]);

process.once("exit", () => {
  const evidence = performanceEvidence(`${mode.replace(/^--/, "")}-process-exit`);
  const applyReadCache = currentApplyReadEvidence() ?? lastCompletedApplyReadEvidence;
  if (applyReadCache) evidence.applyReadCache = applyReadCache;
  const phases = activeReconcilePerformance?.phases ?? lastCompletedPerformancePhases;
  if (phases.length > 0) evidence.phases = JSON.parse(stableJson(phases));
  if (activeReconcilePerformance) {
    evidence.incompleteReconcileRun = reconcilePerformanceEvidence(activeReconcilePerformance, null, {
      complete: false,
    });
  }
  process.stderr.write(`kubara-performance ${JSON.stringify(evidence)}\n`);
});

const paths = {
  config: "examples/kubara/current-platform/source/config.yaml",
  argoValues: "examples/kubara/current-platform/generated/platform-configs/hx-app-dev/helm/argo-cd/values.generated.yaml",
  argoAppSetTemplate: "examples/kubara/current-platform/generated/platform-components/helm/template-library/templates/argocd/_argo.appset.tpl",
  sourceLock: "examples/kubara/current-platform/source-lock.yaml",
  componentArtifacts: "examples/kubara/current-platform/component-artifacts.yaml",
  catalogFullCoverageReceipt: "data/kubara-catalog-1.1-full-coverage/receipt.yaml",
  generationReceipt: "examples/kubara/current-platform/generation-receipt.yaml",
  appSourceLock: "examples/kubara/current-platform/apps/source-lock.yaml",
  adapterOutput: "data/kubara-catalog-adapter/adapter-output.yaml",
  adapterReceipt: "data/kubara-catalog-adapter/receipt.yaml",
  desiredMatrix: "data/kubara-platform-matrix/desired-matrix.json",
  wiring: "data/kubara-wiring/graph.json",
  effectiveReceipt: "data/kubara-effective-renders/current-platform/receipt.yaml",
  qualificationReceipt: "runs/kubara-current-live-qualification/receipt.yaml",
  promotionReceipt: "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml",
  faithfulReceipt: "runs/kubara-faithful-hub-spoke/receipt.yaml",
};

const requiredApplyEvidence = [
  paths.qualificationReceipt,
  paths.promotionReceipt,
  paths.catalogFullCoverageReceipt,
  paths.faithfulReceipt,
];

const FLEET = [
  target("dev", "hx-app-dev", "Dev", "local", "dev", "Hub"),
  target("staging", "hx-app-staging", "Staging", "local", "staging", "Spoke"),
  target("prod-a", "hx-app-prod-a", "Prod", "us-east", "prod", "Spoke"),
  target("prod-b", "hx-app-prod-b", "Prod", "us-west", "prod", "Spoke"),
];
const DEV = FLEET[0];

const EXPECTED_VERSIONS = {
  "argo-cd": "10.2.1",
  "cert-manager": "v1.21.0",
  "external-secrets": "2.8.0",
  "homer-dashboard": "0.1.0",
  "kube-prometheus-stack": "87.19.2",
  "prometheus-blackbox-exporter": "11.15.1",
  "metrics-server": "3.13.1",
  traefik: "41.0.2",
};
const ARGOBOT_VERSION = "v0.1.6";
const ARGOBOT_IMAGE = `ghcr.io/confighub/argobot:${ARGOBOT_VERSION}`;
const ARGOBOT_SOURCE_REF = "oci://ghcr.io/confighub/configs/argobot";
const ARGOBOT_SOURCE_DIGEST = "sha256:59962c4e80bccac0b69330ff2bec0bf0be8aa5e953bdcb6edf00387f1bcd0fce";

const ARGO_CD_DEFINITION_SPACE = "hx-argo-base";
const ARGO_CD_DEFINITION_UNIT = "argo-cd";
const ARGO_CD_EVIDENCE_UNIT = "kubara-argo-definition";
const ARGO_CD_PAYLOAD_KEY = `${CONTROL_SPACE}/${ARGO_CD_EVIDENCE_UNIT}`;
const KUBARA_ARGO_RUNTIME_VERSION = "v3.4.5";
const KUBARA_ARGO_RUNTIME_IMAGE = `quay.io/argoproj/argocd:${KUBARA_ARGO_RUNTIME_VERSION}`;
const ARGO_CD_RUNTIME_SPACE = "hx-argo-runtime-base";
const ARGO_CD_RUNTIME_UNIT = "argo-cd-runtime";
const ARGO_CD_RUNTIME_VERSION = "v3.4.6";
const ARGO_CD_RUNTIME_IMAGE = `quay.io/argoproj/argocd:${ARGO_CD_RUNTIME_VERSION}`;
const ARGO_CD_RUNTIME_PAYLOAD_KEY = `${ARGO_CD_RUNTIME_SPACE}/${ARGO_CD_RUNTIME_UNIT}`;
const ARGO_CD_RUNTIME_CONTAINER_PAIRS = Object.freeze([
  ["argocd-application-controller", "argocd-application-controller"],
  ["argocd-applicationset-controller", "argocd-applicationset-controller"],
  ["argocd-dex-server", "copyutil"],
  ["argocd-notifications-controller", "argocd-notifications-controller"],
  ["argocd-redis", "secret-init"],
  ["argocd-repo-server", "argocd-repo-server"],
  ["argocd-repo-server", "copyutil"],
  ["argocd-server", "argocd-server"],
]);

const CONTROL_UNITS = [
  controlUnit("platform-contract", paths.config, "AppConfig/YAML", "PlatformContract"),
  controlUnit("component-catalog-selection", paths.componentArtifacts, "AppConfig/YAML", "ComponentCatalogSelection"),
  controlUnit("component-catalog-coverage", paths.catalogFullCoverageReceipt, "AppConfig/YAML", "ComponentCatalogCoverage", true),
  controlUnit("catalog-adapter", paths.adapterOutput, "AppConfig/YAML", "CatalogAdapter"),
  controlUnit("catalog-adapter-receipt", paths.adapterReceipt, "AppConfig/YAML", "CatalogAdapterReceipt"),
  controlUnit("platform-matrix", paths.desiredMatrix, "AppConfig/JSON", "PlatformMatrixDesired"),
  controlUnit("wiring-ledger", paths.wiring, "AppConfig/JSON", "WiringLedger"),
  controlUnit("current-generation-receipt", paths.generationReceipt, "AppConfig/YAML", "GenerationReceipt"),
  controlUnit("current-live-qualification", paths.qualificationReceipt, "AppConfig/YAML", "QualificationReceipt", true),
  controlUnit("catalog-root-promotion", paths.promotionReceipt, "AppConfig/YAML", "CatalogPromotionReceipt", true),
  controlUnit("faithful-hub-spoke-receipt", paths.faithfulReceipt, "AppConfig/YAML", "FaithfulLaneReceipt", true),
  {
    slug: ARGO_CD_EVIDENCE_UNIT,
    source: "examples/kubara/current-platform/effective-renders/hx-app-dev/argo-cd/release-objects.yaml",
    toolchain: "Kubernetes/YAML",
    role: "KubaraDeliveryDefinition",
    requiredForApply: false,
  },
];

const SURFACES = [
  surface({
    prefix: "hx-kps-crds",
    component: "kube-prometheus-stack",
    destinationNamespace: "kube-prometheus-stack",
    version: EXPECTED_VERSIONS["kube-prometheus-stack"],
    role: "Lifecycle",
    part: "crds",
    targets: [DEV],
    materialize: ({ kps }) => renderDocuments(kps.filter((doc) => doc.kind === "CustomResourceDefinition")),
    order: 10,
    serverSideApply: true,
  }),
  surface({
    prefix: "hx-cm",
    component: "cert-manager",
    destinationNamespace: "cert-manager",
    version: EXPECTED_VERSIONS["cert-manager"],
    targets: FLEET,
    sourceFor: (item) => effectiveRender(item.cluster, "cert-manager"),
    order: 20,
    serverSideApply: true,
    ignoreInjectedCertificateData: true,
  }),
  surface({
    prefix: "hx-eso",
    component: "external-secrets",
    destinationNamespace: "external-secrets",
    version: EXPECTED_VERSIONS["external-secrets"],
    targets: [DEV],
    sourceFor: () => effectiveRender(DEV.cluster, "external-secrets"),
    order: 30,
    serverSideApply: true,
  }),
  surface({
    prefix: "hx-eso-store",
    component: "external-secrets",
    destinationNamespace: "external-secrets",
    version: EXPECTED_VERSIONS["external-secrets"],
    role: "Prerequisite",
    part: "cluster-secret-store",
    targets: [DEV],
    sourceFor: () => "examples/kubara/current-platform/target-facts/hx-app-dev/cluster-secret-store.yaml",
    order: 40,
  }),
  surface({
    prefix: "hx-eso-grafana-es",
    component: "external-secrets",
    kubaraService: "kube-prometheus-stack",
    destinationNamespace: "kube-prometheus-stack",
    version: EXPECTED_VERSIONS["external-secrets"],
    role: "Wiring",
    part: "grafana-admin-credentials",
    targets: [DEV],
    materialize: ({ kps }) => renderDocuments(kps.filter(
      (doc) => doc.kind === "ExternalSecret" || isKpsNamespace(doc),
    )),
    order: 45,
  }),
  surface({
    prefix: "hx-kps-main",
    component: "kube-prometheus-stack",
    bundledCatalogComponent: "prometheus-blackbox-exporter",
    bundledComponentVersion: EXPECTED_VERSIONS["prometheus-blackbox-exporter"],
    destinationNamespace: "kube-prometheus-stack",
    version: EXPECTED_VERSIONS["kube-prometheus-stack"],
    targets: [DEV],
    materialize: ({ kps }) => renderDocuments(
      kps.filter((doc) => !["CustomResourceDefinition", "ExternalSecret"].includes(doc.kind) && !isKpsNamespace(doc)),
    ),
    order: 50,
    serverSideApply: true,
    namespaceMovePrunes: [{
      migrationID: NAMESPACE_MOVE_MIGRATION_ID,
      apiVersion: "apps/v1",
      resource: "daemonset",
      kind: "DaemonSet",
      name: "kube-prometheus-stack-prometheus-node-exporter",
      fromNamespace: "default",
      conflictingBindings: ["TCP/9100"],
      reason: "hostNetwork TCP/9100 prevents the Kubara-namespace replacement from becoming healthy before PruneLast",
    }],
  }),
  surface({
    prefix: "hx-metrics",
    component: "metrics-server",
    destinationNamespace: "metrics-server",
    version: EXPECTED_VERSIONS["metrics-server"],
    targets: [DEV],
    sourceFor: () => effectiveRender(DEV.cluster, "metrics-server"),
    order: 60,
    serverSideApply: true,
  }),
  surface({
    prefix: "hx-traefik",
    component: "traefik",
    destinationNamespace: "traefik",
    version: EXPECTED_VERSIONS.traefik,
    targets: FLEET,
    sourceFor: (item) => effectiveRender(item.cluster, "traefik"),
    order: 70,
    serverSideApply: true,
  }),
  surface({
    prefix: "hx-homer",
    component: "homer-dashboard",
    destinationNamespace: "homer-dashboard",
    version: EXPECTED_VERSIONS["homer-dashboard"],
    targets: [DEV],
    sourceFor: () => effectiveRender(DEV.cluster, "homer-dashboard"),
    order: 80,
    serverSideApply: true,
  }),
];

const APP_FAMILIES = [
  appFamily({
    prefix: "hx-web",
    role: "Application",
    catalog: "ConfigHubApplications",
    version: "6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d",
    destinationNamespace: "hx-web",
    units: [
      appUnit("hx-web-namespace", "examples/kubara/current-platform/apps/hx-web/base/namespace.yaml"),
      appUnit("hx-web-deployment", "examples/kubara/current-platform/apps/hx-web/base/deployment.yaml", { scenario: true }),
      appUnit("hx-web-service", "examples/kubara/current-platform/apps/hx-web/base/service.yaml"),
    ],
    order: 90,
    scenario: true,
    immutableSelectorReplacements: [{
      migrationKey: "hx-web-immutable-selector",
      unitSlug: "hx-web-deployment",
      apiVersion: "apps/v1",
      resource: "deployment",
      resourcePlural: "deployments",
      kind: "Deployment",
      name: "hx-web",
      serviceName: "hx-web",
      fromSelector: HX_WEB_LEGACY_SELECTOR,
      toSelector: HX_WEB_REVIEWED_SELECTOR,
      reason: "the retained pre-example Deployment uses app=hx-web, while the reviewed component contract uses app.kubernetes.io/name=hx-web",
    }],
  }),
  appFamily({
    prefix: "hx-web-platform",
    component: "hx-web",
    part: "platform-binding",
    role: "PlatformBinding",
    catalog: "ConfigHubApplications",
    version: KUBARA_VERSION,
    destinationNamespace: "hx-web",
    units: [appUnit("hx-web-platform", [
      "examples/kubara/current-platform/apps/hx-web/platform/certificate.yaml",
      "examples/kubara/current-platform/apps/hx-web/platform/ingress.yaml",
    ])],
    order: 100,
  }),
  appFamily({
    prefix: "hx-cubbychat",
    component: "cubbychat",
    role: "Application",
    catalog: "ConfigHubApplications",
    version: "e9e76a076924d95897c3ede7a0f21cec523c4f6f",
    destinationNamespace: "cubbychat",
    units: [appUnit("hx-cubbychat", [
      "examples/kubara/current-platform/apps/cubbychat/base/namespace.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/credentials.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/postgres-service.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/postgres.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/backend-service.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/backend.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/frontend-service.yaml",
      "examples/kubara/current-platform/apps/cubbychat/base/frontend.yaml",
      "examples/kubara/current-platform/apps/cubbychat/platform/certificate.yaml",
      "examples/kubara/current-platform/apps/cubbychat/platform/ingress.yaml",
    ])],
    order: 110,
    immutableSelectorReplacements: [
      {
        migrationKey: "backend-immutable-selector",
        unitSlug: "hx-cubbychat",
        apiVersion: "apps/v1",
        resource: "deployment",
        resourcePlural: "deployments",
        kind: "Deployment",
        name: "backend",
        serviceName: "backend",
        fromSelector: CUBBYCHAT_LEGACY_SELECTORS.backend,
        toSelector: CUBBYCHAT_REVIEWED_SELECTORS.backend,
        reason: "the retained Kubara Cubbychat backend uses app=backend, while the reviewed application contract uses app.kubernetes.io/name=cubbychat-backend",
      },
      {
        migrationKey: "frontend-immutable-selector",
        unitSlug: "hx-cubbychat",
        apiVersion: "apps/v1",
        resource: "deployment",
        resourcePlural: "deployments",
        kind: "Deployment",
        name: "frontend",
        serviceName: "frontend",
        fromSelector: CUBBYCHAT_LEGACY_SELECTORS.frontend,
        toSelector: CUBBYCHAT_REVIEWED_SELECTORS.frontend,
        reason: "the retained Kubara Cubbychat frontend uses app=frontend, while the reviewed application contract uses app.kubernetes.io/name=cubbychat-frontend",
      },
      {
        migrationKey: "postgres-immutable-selector",
        unitSlug: "hx-cubbychat",
        apiVersion: "apps/v1",
        resource: "statefulset",
        resourcePlural: "statefulsets",
        kind: "StatefulSet",
        name: "postgres",
        serviceName: "postgres",
        retainedPVCNames: ["postgres-storage-postgres-0"],
        fromSelector: CUBBYCHAT_LEGACY_SELECTORS.postgres,
        toSelector: CUBBYCHAT_REVIEWED_SELECTORS.postgres,
        reason: "the retained Kubara Cubbychat PostgreSQL StatefulSet uses app=postgres, while the reviewed application contract uses app.kubernetes.io/name=postgres",
      },
    ],
  }),
];

const OWNED_SPACE_LABELS = new Set([
  "ExampleCohort",
  "KubaraVersion",
  "CatalogVersion",
  "Cluster",
  "Environment",
  "Region",
  "Role",
  "Scope",
  "DefinitionScope",
  "Component",
  "ComponentSurface",
  "Owner",
  "KubaraComponent",
  "ComponentVersion",
  "RuntimeVersion",
  "RuntimeImage",
  "Part",
  "Layer",
  "SourceType",
  "Variant",
  "InstanceOf",
  "DefinitionSpace",
  "ClusterRole",
  "KubaraStage",
  "DeliveryMode",
  "Reconciler",
  "ControlPlane",
  "Catalog",
  "CatalogComponent",
  "BundledCatalogComponent",
  "BundledComponentVersion",
  "StartHere",
  "Lane",
  "ReconcileProfile",
  "SelectorMigrationSafety",
]);

const OWNED_UNIT_LABELS = new Set([
  ...OWNED_SPACE_LABELS,
  "ApplicationKind",
  "CatalogComponents",
  "CatalogVersions",
  "KubaraSelections",
  "Retention",
  "SourceSpace",
  "PromotionUpstreamSpace",
]);

const OWNED_LINK_LABELS = new Set([
  "ExampleCohort",
  "KubaraVersion",
  "CatalogVersion",
  "Relationship",
  "ConsumerComponent",
  "ProviderComponent",
]);

const OWNED_PUBLIC_ANNOTATIONS = new Set(Object.keys(PUBLIC_NAVIGATION_ANNOTATIONS));
const START_HERE_CONTROL_UNITS = new Set([
  "platform-contract",
  "component-catalog-selection",
  "component-catalog-coverage",
  "platform-matrix",
  "wiring-ledger",
  "faithful-hub-spoke-receipt",
]);

const FAITHFUL_LANE_CONTROL_UNITS = new Set([
  "faithful-hub-spoke-receipt",
  ARGO_CD_EVIDENCE_UNIT,
]);

function target(suffix, cluster, environment, region, kubaraStage, clusterRole) {
  return { suffix, cluster, environment, region, kubaraStage, clusterRole };
}

function controlUnit(slug, source, toolchain, role, requiredForApply = false) {
  return { slug, source, toolchain, role, requiredForApply };
}

function surface(definition) {
  return {
    role: "Component",
    kubaraService: definition.component,
    acceptedHealth: ["Healthy"],
    serverSideApply: false,
    ignoreInjectedCertificateData: false,
    ...definition,
  };
}

function appUnit(slug, source, extra = {}) {
  return { slug, source: Array.isArray(source) ? source : [source], ...extra };
}

function appFamily(definition) {
  return {
    targets: FLEET,
    component: definition.prefix,
    part: "application",
    acceptedHealth: ["Healthy"],
    ...definition,
  };
}

function surfaceVariant(definition, targetVariant) {
  return definition.part ? `${definition.part}-${targetVariant}` : targetVariant;
}

function appFamilyVariant(definition, targetVariant) {
  return definition.part === "application"
    ? targetVariant
    : `${definition.part}-${targetVariant}`;
}

function effectiveRender(cluster, service) {
  return `examples/kubara/current-platform/effective-renders/${cluster}/${service}/release-objects.yaml`;
}

function isKpsNamespace(doc) {
  return doc.kind === "Namespace" && doc.metadata?.name === "kube-prometheus-stack";
}

function absolute(relative) {
  return join(repoRoot, relative);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  check(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1];
}

function validateCliArgs() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (modes.has(arg)) continue;
    if (arg === "--context") {
      check(args[index + 1] && !args[index + 1].startsWith("--"), "--context requires a value");
      index += 1;
      continue;
    }
    check(false, `unknown argument ${arg}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function firstStableDifference(expected, actual, path = "$") {
  if (stableJson(expected) === stableJson(actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length expected=${expected.length} actual=${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstStableDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  } else if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const difference = firstStableDifference(expected[key], actual[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  const render = (value) => {
    const text = stableJson(value);
    return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
  };
  return `${path} expected=${render(expected)} actual=${render(actual)}`;
}

function renderDocuments(documents) {
  check(documents.length > 0, "refusing to materialize an empty Kubernetes Unit");
  return `${documents.map((doc) => toYaml(doc)).join("\n---\n")}\n`;
}

function joinedSource(pathsToJoin) {
  return `${pathsToJoin.map((item) => readFileSync(absolute(item), "utf8").trimEnd()).join("\n---\n")}\n`;
}

function expectedLabels(extra = {}) {
  return {
    ExampleCohort: EXAMPLE_COHORT,
    KubaraVersion: KUBARA_VERSION,
    CatalogVersion: CATALOG_VERSION,
    ...extra,
  };
}

function clusterIdentityLabels(item) {
  return {
    Cluster: item.cluster,
    Environment: item.environment,
    Region: item.region,
    ClusterRole: item.clusterRole,
    KubaraStage: item.kubaraStage,
  };
}

function deliveryIdentityLabels() {
  return {
    Lane: "Adapted",
    DeliveryMode: "ConfigHubOCI",
    Reconciler: "ClusterLocalArgo",
    ControlPlane: "ConfigHub",
  };
}

function definitionLabels(prefix, role, extra = {}) {
  return expectedLabels({
    Component: prefix,
    CatalogComponent: extra.CatalogComponent ?? extra.KubaraComponent ?? prefix,
    ...(extra.Catalog ? { Owner: extra.Owner ?? extra.Catalog } : {}),
    Layer: role.includes("Application") ? "App" : "Platform",
    Scope: "Fleet",
    DefinitionScope: "Base",
    Role: `${role}Definition`,
    Variant: "base",
    ControlPlane: "ConfigHub",
    ...extra,
  });
}

function instanceLabels(prefix, role, item, extra = {}) {
  return expectedLabels({
    Component: prefix,
    CatalogComponent: extra.CatalogComponent ?? extra.KubaraComponent ?? prefix,
    ...(extra.Catalog ? { Owner: extra.Owner ?? extra.Catalog } : {}),
    Layer: role.includes("Application") ? "App" : "Platform",
    ...clusterIdentityLabels(item),
    Role: `${role}Instance`,
    Variant: item.suffix,
    InstanceOf: prefix,
    DefinitionSpace: `${prefix}-base`,
    ...deliveryIdentityLabels(),
    ...extra,
  });
}

function controlUnitNavigation(slug) {
  if (!START_HERE_CONTROL_UNITS.has(slug)) return { labels: {}, annotations: {} };
  if (slug === "component-catalog-selection") {
    return {
      labels: { StartHere: "true" },
      annotations: { "URL-Guide": PUBLIC_GUIDE_URL, "URL-Catalog": PUBLIC_CATALOG_URL },
    };
  }
  if (slug === "component-catalog-coverage") {
    return {
      labels: {
        StartHere: "true",
        CatalogComponents: "103",
        CatalogVersions: "130",
        KubaraSelections: "18",
        Retention: "AdditiveOnly",
      },
      annotations: {
        "URL-Guide": PUBLIC_GUIDE_URL,
        "URL-Catalog": PUBLIC_CATALOG_URL,
        "URL-CatalogCoverage": PUBLIC_CATALOG_COVERAGE_URL,
      },
    };
  }
  if (slug === "platform-matrix") {
    return {
      labels: { StartHere: "true" },
      annotations: { "URL-Guide": PUBLIC_GUIDE_URL, "URL-Matrix": PUBLIC_MATRIX_URL },
    };
  }
  if (slug === "wiring-ledger") {
    return {
      labels: { StartHere: "true" },
      annotations: { "URL-Guide": PUBLIC_GUIDE_URL, "URL-Wiring": PUBLIC_WIRING_URL },
    };
  }
  return {
    labels: {
      StartHere: "true",
      ...(slug === "platform-contract" ? {
        ReconcileProfile: RECONCILE_PROFILE,
        SelectorMigrationSafety: "ExactRevisionFailureBound",
      } : {}),
    },
    annotations: slug === "platform-contract"
      ? PUBLIC_NAVIGATION_ANNOTATIONS
      : { "URL-Guide": PUBLIC_GUIDE_URL },
  };
}

function managedUnitLabels({
  role,
  component,
  kubaraComponent = component,
  catalogComponent = kubaraComponent,
  componentVersion,
  catalog,
  variant,
  fleetItem = null,
  extra = {},
}) {
  return expectedLabels({
    Role: role,
    Component: component,
    ...(kubaraComponent ? { KubaraComponent: kubaraComponent } : {}),
    CatalogComponent: catalogComponent,
    ComponentVersion: componentVersion,
    Catalog: catalog,
    Owner: catalog,
    Variant: variant,
    ControlPlane: "ConfigHub",
    ...(fleetItem ? { ...clusterIdentityLabels(fleetItem), ...deliveryIdentityLabels() } : {}),
    ...extra,
  });
}

function sourceAnnotation(payload, sourcePaths, transform = "none") {
  const annotations = {
    // cub's repeated --annotation flag still uses its StringSlice parser, so
    // commas and additional equals signs inside a value are ambiguous. Keep
    // the stored provenance readable while using unambiguous separators.
    "confighub.com/source-path": sourcePaths.join(";"),
    "confighub.com/source-sha256": `sha256:${sha256(payload)}`,
    "confighub.com/source-transform": transform,
  };
  for (const [key, value] of Object.entries(annotations)) {
    assertCubAnnotationValue(key, value);
  }
  return annotations;
}

function argoCdRuntimeContract() {
  return `${toYaml({
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "DeliveryRuntimeContract",
    metadata: { name: ARGO_CD_RUNTIME_UNIT },
    spec: {
      component: "argo-cd",
      lane: "Adapted",
      installedBy: "cub cluster up",
      scope: "cluster-local",
      runtimeVersion: ARGO_CD_RUNTIME_VERSION,
      runtimeImage: ARGO_CD_RUNTIME_IMAGE,
      targets: FLEET.map((item) => item.cluster),
      kubaraFaithfulDefinition: {
        space: ARGO_CD_DEFINITION_SPACE,
        unit: ARGO_CD_DEFINITION_UNIT,
        chartVersion: EXPECTED_VERSIONS["argo-cd"],
        runtimeVersion: KUBARA_ARGO_RUNTIME_VERSION,
        runtimeImage: KUBARA_ARGO_RUNTIME_IMAGE,
      },
      lineagePolicy: "cluster-local delivery is not an instance of the Kubara hub chart render",
      verificationPolicy: "the exact eight reviewed Argo CD workload/container pairs in every pinned target must equal runtimeImage",
    },
  })}\n`;
}

function materializeInputs() {
  const faithfulAvailability = faithfulProofAvailability();
  const missing = [];
  for (const item of Object.values(paths)) {
    if (!existsSync(absolute(item))) missing.push(item);
  }
  for (const item of SURFACES) {
    for (const fleetItem of item.targets) {
      if (item.sourceFor) {
        const source = item.sourceFor(fleetItem);
        if (!existsSync(absolute(source))) missing.push(source);
      }
    }
  }
  for (const family of APP_FAMILIES) {
    for (const unit of family.units) {
      for (const source of unit.source) if (!existsSync(absolute(source))) missing.push(source);
    }
  }

  const kpsPath = effectiveRender(DEV.cluster, "kube-prometheus-stack");
  const kps = existsSync(absolute(kpsPath))
    ? parseDocs(readFileSync(absolute(kpsPath), "utf8"))
    : [];
  const payloads = new Map();
  const payload = (key, value, sourcePaths, toolchain = "Kubernetes/YAML", transform = "none") => {
    check(!payloads.has(key), `duplicate payload key ${key}`);
    const documents = toolchain === "Kubernetes/YAML" ? parseDocs(value) : [];
    const identities = documents.map(identityFor);
    const duplicateIdentities = identities.filter((identity, index) => identities.indexOf(identity) !== index);
    check(
      duplicateIdentities.length === 0,
      `${key}: duplicate Kubernetes resource identities: ${[...new Set(duplicateIdentities)].join(", ")}`,
    );
    payloads.set(key, {
      key,
      value,
      sourcePaths,
      toolchain,
      transform,
      sha256: sha256(value),
      objectCount: toolchain === "Kubernetes/YAML" ? documents.length : 1,
    });
  };

  if (kps.length) {
    check(kps.filter((doc) => doc.kind === "CustomResourceDefinition").length === 10, "current KPS render must contain 10 CRDs");
    check(kps.filter((doc) => doc.kind === "ExternalSecret").length === 1, "current KPS render must contain one Grafana ExternalSecret");
    check(kps.filter(isKpsNamespace).length === 1, "current KPS render must contain one kube-prometheus-stack Namespace");
  }

  for (const item of SURFACES) {
    for (const fleetItem of item.targets) {
      let value = "";
      let sourcePaths = [];
      let transform = "none";
      if (item.materialize && kps.length) {
        value = item.materialize({ kps });
        sourcePaths = [kpsPath];
        transform = item.part === "crds"
          ? "select-kind:CustomResourceDefinition"
          : item.part === "grafana-admin-credentials"
            ? "select-kind:Namespace/kube-prometheus-stack;ExternalSecret"
            : "exclude-kinds:CustomResourceDefinition;ExternalSecret;Namespace/kube-prometheus-stack";
      } else if (item.sourceFor) {
        const source = item.sourceFor(fleetItem);
        sourcePaths = [source];
        if (existsSync(absolute(source))) value = readFileSync(absolute(source), "utf8");
      }
      if (value) payload(`${item.prefix}/${fleetItem.suffix}`, value, sourcePaths, "Kubernetes/YAML", transform);
    }
  }

  for (const family of APP_FAMILIES) {
    for (const unit of family.units) {
      const value = unit.source.every((source) => existsSync(absolute(source)))
        ? joinedSource(unit.source)
        : "";
      if (!value) continue;
      if (unit.scenario) {
        const initialDocs = parseDocs(value);
        for (const stage of ["initial", "v1", "v2"]) {
          const transformed = hxWebPayload(initialDocs, { stage, target: null });
          payload(`${family.prefix}/base/${unit.slug}/${stage}`, transformed, unit.source, "Kubernetes/YAML", `hx-web-${stage}`);
        }
        payload(
          `${family.prefix}/staging/${unit.slug}/departure`,
          hxWebPayload(initialDocs, { stage: "departure", target: FLEET[1] }),
          unit.source,
          "Kubernetes/YAML",
          "hx-web-staging-departure",
        );
        for (const fleetItem of family.targets) {
          const transformed = hxWebPayload(initialDocs, { stage: "final", target: fleetItem });
          payload(`${family.prefix}/${fleetItem.suffix}/${unit.slug}/final`, transformed, unit.source, "Kubernetes/YAML", `hx-web-final-${fleetItem.suffix}`);
        }
      } else {
        payload(`${family.prefix}/base/${unit.slug}`, value, unit.source);
        for (const fleetItem of family.targets) payload(`${family.prefix}/${fleetItem.suffix}/${unit.slug}`, value, unit.source);
      }
    }
  }

  for (const control of CONTROL_UNITS) {
    if (!existsSync(absolute(control.source))) continue;
    if (control.source === paths.faithfulReceipt && !faithfulAvailability.sourceCurrent) continue;
    const value = readFileSync(absolute(control.source), "utf8");
    payload(`${CONTROL_SPACE}/${control.slug}`, value, [control.source], control.toolchain);
  }

  payload(
    ARGO_CD_RUNTIME_PAYLOAD_KEY,
    argoCdRuntimeContract(),
    ["scripts/reconcile-kubara-mini-idp.mjs"],
    "AppConfig/YAML",
    "embedded-reviewed-runtime-contract",
  );

  return {
    missing: [...new Set(missing)].sort(),
    kps,
    payloads,
    faithfulAvailability,
  };
}

function hxWebPayload(initialDocs, { stage, target: fleetItem }) {
  const docs = structuredClone(initialDocs);
  const deployment = docs.find((doc) => doc.kind === "Deployment" && doc.metadata?.name === "hx-web");
  check(deployment, "hx-web deployment fixture is missing");
  deployment.metadata.annotations ??= {};
  const effectiveStage = stage === "final"
    ? fleetItem?.suffix === "prod-a"
      ? "initial"
      : fleetItem?.suffix === "prod-b"
        ? "v1"
        : "v2"
    : stage;
  if (effectiveStage !== "initial") {
    deployment.spec.replicas = 3;
    deployment.metadata.annotations["platform.confighub.com/revision"] = "promotion-v1";
  }
  if (effectiveStage === "v2") {
    deployment.metadata.annotations["platform.confighub.com/promotion"] = "promotion-v2";
  }
  if (["departure", "final"].includes(stage) && fleetItem?.suffix === "staging") {
    const container = deployment.spec?.template?.spec?.containers?.[0];
    check(container, "hx-web deployment has no first container");
    container.env ??= [];
    if (!container.env.some((entry) => entry.name === "SANDBOX_URL")) {
      container.env.push({
        name: "SANDBOX_URL",
        value: "http://sandbox.hx-web.svc:8080",
      });
    }
  }
  return renderDocuments(docs);
}

function buildPlan(inputs) {
  verifyLocalContract(inputs, { requireLiveEvidence: false });
  const spaces = [];
  const managedUnits = [];
  const deployments = [];

  spaces.push({
    slug: CONTROL_SPACE,
    type: "control",
    labels: expectedLabels({
      CatalogComponent: "platform-control",
      ComponentSurface: "platform-control",
      ComponentVersion: KUBARA_VERSION,
      Layer: "Platform",
      Scope: "Fleet",
      Role: "PlatformControl",
      SourceType: "Kubara+ConfigHub",
      Variant: "base",
      ControlPlane: "ConfigHub",
      Catalog: "ConfigHubControl",
      Owner: "ConfigHubControl",
      StartHere: "true",
      ReconcileProfile: RECONCILE_PROFILE,
    }),
    annotations: PUBLIC_NAVIGATION_ANNOTATIONS,
  });
  spaces.push({
    slug: ARGO_CD_DEFINITION_SPACE,
    type: "component-definition",
    labels: definitionLabels("argo-cd", "Component", {
      ComponentSurface: "argocd-delivery",
      KubaraComponent: "argo-cd",
      ComponentVersion: EXPECTED_VERSIONS["argo-cd"],
      RuntimeVersion: KUBARA_ARGO_RUNTIME_VERSION,
      RuntimeImage: KUBARA_ARGO_RUNTIME_IMAGE,
      Catalog: "KubaraBootstrap",
      Lane: "Faithful",
    }),
  });
  spaces.push({
    slug: ARGO_CD_RUNTIME_SPACE,
    type: "delivery-runtime-definition",
    labels: definitionLabels("argo-cd", "DeliveryRuntime", {
      ComponentSurface: "argocd-delivery-runtime",
      ComponentVersion: ARGO_CD_RUNTIME_VERSION,
      RuntimeVersion: ARGO_CD_RUNTIME_VERSION,
      RuntimeImage: ARGO_CD_RUNTIME_IMAGE,
      Catalog: "ConfigHubBootstrap",
      Lane: "Adapted",
    }),
  });
  for (const item of FLEET) {
    spaces.push({
      slug: item.cluster,
      type: "cluster-target",
      labels: expectedLabels({
        CatalogComponent: "cluster-target",
        ComponentSurface: "cluster-target",
        ComponentVersion: KUBARA_VERSION,
        Layer: "Platform",
        ...clusterIdentityLabels(item),
        Role: "ClusterTarget",
        Variant: item.suffix,
        Catalog: "ConfigHubControl",
        Owner: "ConfigHubControl",
        ...deliveryIdentityLabels(),
      }),
    });
    spaces.push({
      slug: `${item.cluster}-argo-apps`,
      type: "delivery-instance",
      labels: instanceLabels("argocd-delivery", "Delivery", item, {
        Component: "argo-cd",
        ComponentSurface: "argocd-delivery",
        InstanceOf: ARGO_CD_RUNTIME_UNIT,
        DefinitionSpace: ARGO_CD_RUNTIME_SPACE,
        CatalogComponent: "argo-cd",
        ComponentVersion: ARGO_CD_RUNTIME_VERSION,
        RuntimeVersion: ARGO_CD_RUNTIME_VERSION,
        RuntimeImage: ARGO_CD_RUNTIME_IMAGE,
        Catalog: "ConfigHubBootstrap",
      }),
    });
  }
  spaces.push({
    slug: "argobot-base",
    type: "delivery-definition",
    labels: definitionLabels("argobot", "Delivery", {
      ComponentSurface: "argobot",
      ComponentVersion: ARGOBOT_VERSION,
      Catalog: "ConfigHubDelivery",
    }),
  });
  for (const item of FLEET) {
    spaces.push({
      slug: `argobot-${item.cluster}`,
      type: "delivery-instance",
      labels: instanceLabels("argobot", "Delivery", item, {
        ComponentSurface: "argobot",
        ComponentVersion: ARGOBOT_VERSION,
        Catalog: "ConfigHubDelivery",
      }),
    });
  }

  for (const control of CONTROL_UNITS) {
    const content = inputs.payloads.get(`${CONTROL_SPACE}/${control.slug}`);
    const navigation = controlUnitNavigation(control.slug);
    const kubaraArgo = control.slug === ARGO_CD_EVIDENCE_UNIT;
    managedUnits.push({
      space: CONTROL_SPACE,
      slug: control.slug,
      role: control.role,
      payloadKey: content?.key ?? "",
      toolchain: control.toolchain,
      provider: "None",
      target: null,
      requiredForApply: control.requiredForApply,
      labels: managedUnitLabels({
        role: control.role,
        component: kubaraArgo ? "argo-cd" : control.slug,
        kubaraComponent: kubaraArgo ? "argo-cd" : control.slug,
        componentVersion: kubaraArgo ? EXPECTED_VERSIONS["argo-cd"] : KUBARA_VERSION,
        catalog: kubaraArgo ? "KubaraBootstrap" : "ConfigHubControl",
        variant: "base",
        extra: {
          ComponentSurface: control.slug,
          SourceType: "CommittedEvidence",
          ...(FAITHFUL_LANE_CONTROL_UNITS.has(control.slug) ? { Lane: "Faithful" } : {}),
          ...navigation.labels,
        },
      }),
      annotations: navigation.annotations,
    });
  }

  managedUnits.push({
    space: ARGO_CD_DEFINITION_SPACE,
    slug: ARGO_CD_DEFINITION_UNIT,
    role: "ComponentDefinition",
    payloadKey: ARGO_CD_PAYLOAD_KEY,
    toolchain: "Kubernetes/YAML",
    provider: null,
    target: null,
    labels: managedUnitLabels({
      role: "ComponentDefinition",
      component: "argo-cd",
      componentVersion: EXPECTED_VERSIONS["argo-cd"],
      catalog: "KubaraBootstrap",
      variant: "base",
      extra: {
        ComponentSurface: "argocd-delivery",
        SourceType: "CommittedEvidence",
        RuntimeVersion: KUBARA_ARGO_RUNTIME_VERSION,
        RuntimeImage: KUBARA_ARGO_RUNTIME_IMAGE,
        Lane: "Faithful",
      },
    }),
  });

  managedUnits.push({
    space: ARGO_CD_RUNTIME_SPACE,
    slug: ARGO_CD_RUNTIME_UNIT,
    role: "DeliveryRuntimeDefinition",
    payloadKey: ARGO_CD_RUNTIME_PAYLOAD_KEY,
    toolchain: "AppConfig/YAML",
    provider: "None",
    target: null,
    labels: managedUnitLabels({
      role: "DeliveryRuntimeDefinition",
      component: "argo-cd",
      kubaraComponent: null,
      catalogComponent: "argo-cd",
      componentVersion: ARGO_CD_RUNTIME_VERSION,
      catalog: "ConfigHubBootstrap",
      variant: "base",
      extra: {
        ComponentSurface: "argocd-delivery-runtime",
        SourceType: "ReviewedRuntimeContract",
        RuntimeVersion: ARGO_CD_RUNTIME_VERSION,
        RuntimeImage: ARGO_CD_RUNTIME_IMAGE,
        Lane: "Adapted",
      },
    }),
  });

  for (const item of SURFACES) {
    check(item.destinationNamespace, `${item.prefix}: destination namespace is required`);
    for (const migration of item.namespaceMovePrunes ?? []) {
      check(migration.apiVersion === "apps/v1", `${item.prefix}: namespace-move prune apiVersion must be apps/v1`);
      check(migration.resource === "daemonset" && migration.kind === "DaemonSet", `${item.prefix}: only an exact DaemonSet namespace-move prune is supported`);
      check(migration.name && migration.fromNamespace, `${item.prefix}: namespace-move prune identity is incomplete`);
      check(migration.fromNamespace !== item.destinationNamespace, `${item.prefix}: namespace-move prune source still matches the destination namespace`);
      check(
        stableJson(migration.conflictingBindings) === stableJson(["TCP/9100"]),
        `${item.prefix}: namespace-move prune must retain the reviewed TCP/9100 conflict`,
      );
      check(migration.reason, `${item.prefix}: namespace-move prune reason is required`);
    }
    const surfaceLabels = {
      Component: item.component,
      ComponentSurface: item.prefix,
      KubaraComponent: item.component,
      CatalogComponent: item.component,
      ComponentVersion: item.version,
      Catalog: "KubaraGeneral",
      Owner: "KubaraGeneral",
      ...(item.bundledCatalogComponent ? {
        BundledCatalogComponent: item.bundledCatalogComponent,
        BundledComponentVersion: item.bundledComponentVersion,
      } : {}),
      ...(item.part ? { Part: item.part } : {}),
    };
    spaces.push({
      slug: `${item.prefix}-base`,
      type: "component-definition",
      labels: definitionLabels(item.prefix, item.role, {
        ...surfaceLabels,
        Variant: surfaceVariant(item, "base"),
      }),
    });
    managedUnits.push({
      space: `${item.prefix}-base`,
      slug: item.prefix,
      role: `${item.role}Definition`,
      payloadKey: `${item.prefix}/${item.targets[0].suffix}`,
      toolchain: "Kubernetes/YAML",
      provider: null,
      target: null,
      labels: managedUnitLabels({
        role: `${item.role}Definition`,
        component: item.component,
        kubaraComponent: item.component,
        componentVersion: item.version,
        catalog: "KubaraGeneral",
        variant: surfaceVariant(item, "base"),
        extra: {
          ComponentSurface: item.prefix,
          ...(item.part ? { Part: item.part } : {}),
          ...(item.bundledCatalogComponent ? {
            BundledCatalogComponent: item.bundledCatalogComponent,
            BundledComponentVersion: item.bundledComponentVersion,
          } : {}),
        },
      }),
    });
    for (const fleetItem of item.targets) {
      const space = `${item.prefix}-${fleetItem.suffix}`;
      spaces.push({
        slug: space,
        type: "component-instance",
        upstreamSpace: `${item.prefix}-base`,
        target: `${fleetItem.cluster}/target`,
        prodProtected: fleetItem.environment === "Prod",
        labels: instanceLabels(item.prefix, item.role, fleetItem, {
          ...surfaceLabels,
          Variant: surfaceVariant(item, fleetItem.suffix),
        }),
      });
      managedUnits.push({
        space,
        slug: item.prefix,
        role: `${item.role}Instance`,
        payloadKey: `${item.prefix}/${fleetItem.suffix}`,
        toolchain: "Kubernetes/YAML",
        provider: null,
        target: `${fleetItem.cluster}/target`,
        upstream: `${item.prefix}-base/${item.prefix}`,
        prodProtected: fleetItem.environment === "Prod",
        labels: managedUnitLabels({
          role: `${item.role}Instance`,
          component: item.component,
          kubaraComponent: item.component,
          componentVersion: item.version,
          catalog: "KubaraGeneral",
          variant: surfaceVariant(item, fleetItem.suffix),
          fleetItem,
          extra: {
            ComponentSurface: item.prefix,
            ...(item.part ? { Part: item.part } : {}),
            ...(item.bundledCatalogComponent ? {
              BundledCatalogComponent: item.bundledCatalogComponent,
              BundledComponentVersion: item.bundledComponentVersion,
            } : {}),
          },
        }),
      });
      const protectedNamespaceOwnershipDetachment = protectedNamespaceDetachmentFor(
        fleetItem.cluster,
        space,
      );
      deployments.push({
        id: space,
        type: "platform",
        order: item.order,
        cluster: fleetItem.cluster,
        space,
        appSpace: `${fleetItem.cluster}-argo-apps`,
        appUnit: space,
        destinationNamespace: item.destinationNamespace,
        serverSideApply: item.serverSideApply,
        ignoreInjectedCertificateData: item.ignoreInjectedCertificateData,
        acceptedHealth: item.acceptedHealth,
        namespaceMovePrunes: item.namespaceMovePrunes ?? [],
        protectedNamespaceOwnershipDetachment:
          protectedNamespaceOwnershipDetachment?.migrationID ?? null,
      });
    }
  }

  for (const family of APP_FAMILIES) {
    check(family.destinationNamespace, `${family.prefix}: destination namespace is required`);
    spaces.push({
      slug: `${family.prefix}-base`,
      type: "app-definition",
      labels: definitionLabels(family.prefix, family.role, {
        Component: family.component,
        ComponentSurface: family.prefix,
        KubaraComponent: family.component,
        CatalogComponent: family.component,
        ComponentVersion: family.version,
        Catalog: family.catalog,
        Variant: appFamilyVariant(family, "base"),
      }),
    });
    for (const unit of family.units) {
      managedUnits.push({
        space: `${family.prefix}-base`,
        slug: unit.slug,
        role: `${family.role}Definition`,
        payloadKey: unit.scenario
          ? `${family.prefix}/base/${unit.slug}/v2`
          : `${family.prefix}/base/${unit.slug}`,
        initialPayloadKey: unit.scenario
          ? `${family.prefix}/base/${unit.slug}/initial`
          : "",
        toolchain: "Kubernetes/YAML",
        provider: null,
        target: null,
        labels: managedUnitLabels({
          role: `${family.role}Definition`,
          component: family.component,
          kubaraComponent: family.component,
          catalogComponent: family.component,
          componentVersion: family.version,
          catalog: family.catalog,
          variant: appFamilyVariant(family, "base"),
          extra: { ComponentSurface: family.prefix },
        }),
      });
    }
    for (let index = 0; index < family.targets.length; index += 1) {
      const fleetItem = family.targets[index];
      // Only the hx-web scenario is a promotion chain. Platform bindings and
      // ordinary applications are independent per-cluster instances of the
      // reusable definition, matching Kubara's definition/instance shape.
      const upstreamSpace = family.scenario
        ? index === 0
          ? `${family.prefix}-base`
          : index === 1
            ? `${family.prefix}-dev`
            : `${family.prefix}-staging`
        : `${family.prefix}-base`;
      const space = `${family.prefix}-${fleetItem.suffix}`;
      spaces.push({
        slug: space,
        type: "app-instance",
        upstreamSpace,
        target: `${fleetItem.cluster}/target`,
        prodProtected: fleetItem.environment === "Prod",
        labels: instanceLabels(family.prefix, family.role, fleetItem, {
          Component: family.component,
          ComponentSurface: family.prefix,
          KubaraComponent: family.component,
          CatalogComponent: family.component,
          ComponentVersion: family.version,
          Catalog: family.catalog,
          Variant: appFamilyVariant(family, fleetItem.suffix),
        }),
      });
      for (const unit of family.units) {
        managedUnits.push({
          space,
          slug: unit.slug,
          role: `${family.role}Instance`,
          payloadKey: unit.scenario
            ? `${family.prefix}/${fleetItem.suffix}/${unit.slug}/final`
            : `${family.prefix}/${fleetItem.suffix}/${unit.slug}`,
          initialPayloadKey: unit.scenario
            ? `${family.prefix}/base/${unit.slug}/initial`
            : "",
          toolchain: "Kubernetes/YAML",
          provider: null,
          target: `${fleetItem.cluster}/target`,
          upstream: `${upstreamSpace}/${unit.slug}`,
          prodProtected: fleetItem.environment === "Prod",
          labels: managedUnitLabels({
            role: `${family.role}Instance`,
            component: family.component,
            kubaraComponent: family.component,
            catalogComponent: family.component,
            componentVersion: family.version,
            catalog: family.catalog,
            variant: appFamilyVariant(family, fleetItem.suffix),
            fleetItem,
            extra: { ComponentSurface: family.prefix },
          }),
        });
      }
      deployments.push({
        id: space,
        type: "application",
        order: family.order,
        cluster: fleetItem.cluster,
        space,
        appSpace: `${fleetItem.cluster}-argo-apps`,
        appUnit: space,
        destinationNamespace: family.destinationNamespace,
        serverSideApply: false,
        acceptedHealth: family.acceptedHealth,
        immutableSelectorReplacements: (family.immutableSelectorReplacements ?? []).map((migration) => ({
          ...migration,
          migrationID: `${space}/${migration.migrationKey}/${IMMUTABLE_SELECTOR_MIGRATION_VERSION}`,
          namespace: family.destinationNamespace,
        })),
      });
    }
  }

  const links = buildLinks();
  const fleetOrder = new Map(FLEET.map((item, index) => [item.cluster, index]));
  spaces.sort((left, right) => left.slug.localeCompare(right.slug));
  managedUnits.sort((left, right) => `${left.space}/${left.slug}`.localeCompare(`${right.space}/${right.slug}`));
  deployments.sort((left, right) => (
    left.order - right.order
      || fleetOrder.get(left.cluster) - fleetOrder.get(right.cluster)
      || left.id.localeCompare(right.id)
  ));
  check(spaces.length === 55, `internal plan error: expected 55 Spaces, got ${spaces.length}`);
  check(new Set(spaces.map((item) => item.slug)).size === spaces.length, "internal plan has duplicate Spaces");
  check(new Set(managedUnits.map((item) => `${item.space}/${item.slug}`)).size === managedUnits.length, "internal plan has duplicate Units");
  check(new Set(links.map((item) => `${item.space}/${item.slug}`)).size === links.length, "internal plan has duplicate Links");
  const plannedProtectedNamespaceDetachments = deployments
    .map((item) => item.protectedNamespaceOwnershipDetachment)
    .filter(Boolean)
    .sort();
  check(
    stableJson(plannedProtectedNamespaceDetachments)
      === stableJson(PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.map((item) => item.migrationID).sort()),
    "internal plan protected Namespace ownership detachments drifted",
  );
  const immutableSelectorReplacements = deployments.flatMap((deployment) => (
    (deployment.immutableSelectorReplacements ?? []).map((migration) => ({ deployment, migration }))
  ));
  check(immutableSelectorReplacements.length === FLEET.length * 4, "internal plan must declare four immutable-selector replacements per fleet target");
  for (const { deployment, migration } of immutableSelectorReplacements) {
    check(deployment.type === "application" && ["hx-web", "hx-cubbychat"].some((prefix) => deployment.space.startsWith(`${prefix}-`)), `${deployment.cluster}: immutable-selector replacement escaped the two reviewed Applications`);
    check(migration.apiVersion === "apps/v1" && ["Deployment", "StatefulSet"].includes(migration.kind), `${deployment.cluster}: immutable-selector replacement kind drifted`);
    check(
      (migration.kind === "Deployment" && migration.resource === "deployment" && migration.resourcePlural === "deployments")
        || (migration.kind === "StatefulSet" && migration.resource === "statefulset" && migration.resourcePlural === "statefulsets"),
      `${deployment.cluster}: immutable-selector replacement resource drifted`,
    );
    check(migration.name && migration.namespace === deployment.destinationNamespace && migration.unitSlug && migration.serviceName, `${deployment.cluster}: immutable-selector replacement identity drifted`);
    check(Object.keys(migration.fromSelector ?? {}).length === 1 && Object.keys(migration.toSelector ?? {}).length === 1, `${deployment.cluster}: immutable-selector replacement must bind one reviewed label transition`);
    check(stableJson(migration.fromSelector) !== stableJson(migration.toSelector), `${deployment.cluster}: immutable-selector replacement does not change the selector`);
    check(
      migration.kind !== "StatefulSet" || stableJson(migration.retainedPVCNames) === stableJson(["postgres-storage-postgres-0"]),
      `${deployment.cluster}: StatefulSet immutable-selector replacement must retain the exact PostgreSQL PVC`,
    );
  }
  const plan = { spaces, managedUnits, deployments, links };
  assertAppFamilyPlanConsistency(plan);
  return plan;
}

function buildLinks() {
  const links = [];
  const add = (
    space,
    slug,
    fromUnit,
    toSpace,
    toUnit,
    consumerComponent,
    providerComponent,
    reason,
  ) => {
    links.push({
      space,
      slug,
      fromUnit,
      toSpace,
      toUnit,
      updateType: "NeedsProvides",
      autoUpdate: false,
      reason,
      labels: expectedLabels({
        Relationship: "NeedsProvides",
        ConsumerComponent: consumerComponent,
        ProviderComponent: providerComponent,
      }),
    });
  };
  for (const item of FLEET) {
    add(`hx-web-${item.suffix}`, "needs-platform-binding", "hx-web-deployment", `hx-web-platform-${item.suffix}`, "hx-web-platform", "hx-web", "hx-web-platform", "workload uses its reviewed Certificate and Ingress binding");
    add(`hx-web-platform-${item.suffix}`, "needs-cert-manager", "hx-web-platform", `hx-cm-${item.suffix}`, "hx-cm", "hx-web-platform", "cert-manager", "Certificate requires cert-manager and ClusterIssuer");
    add(`hx-web-platform-${item.suffix}`, "needs-traefik", "hx-web-platform", `hx-traefik-${item.suffix}`, "hx-traefik", "hx-web-platform", "traefik", "Ingress selects the traefik ingress class");
    add(`hx-cubbychat-${item.suffix}`, "needs-cert-manager", "hx-cubbychat", `hx-cm-${item.suffix}`, "hx-cm", "cubbychat", "cert-manager", "Certificate requires cert-manager and ClusterIssuer");
    add(`hx-cubbychat-${item.suffix}`, "needs-traefik", "hx-cubbychat", `hx-traefik-${item.suffix}`, "hx-traefik", "cubbychat", "traefik", "Ingress selects the traefik ingress class");
  }
  add("hx-eso-store-dev", "needs-external-secrets", "hx-eso-store", "hx-eso-dev", "hx-eso", "external-secrets-store", "external-secrets", "ClusterSecretStore requires the ESO API and controller");
  add("hx-eso-grafana-es-dev", "needs-secret-store", "hx-eso-grafana-es", "hx-eso-store-dev", "hx-eso-store", "grafana-external-secret", "external-secrets-store", "Grafana ExternalSecret reads from the cluster store");
  add("hx-eso-grafana-es-dev", "needs-external-secrets", "hx-eso-grafana-es", "hx-eso-dev", "hx-eso", "grafana-external-secret", "external-secrets", "ExternalSecret requires the ESO API and controller");
  add("hx-kps-main-dev", "needs-monitoring-crds", "hx-kps-main", "hx-kps-crds-dev", "hx-kps-crds", "kube-prometheus-stack", "monitoring-crds", "monitoring resources require their lifecycle CRDs first");
  add("hx-kps-main-dev", "needs-grafana-secret", "hx-kps-main", "hx-eso-grafana-es-dev", "hx-eso-grafana-es", "kube-prometheus-stack", "grafana-external-secret", "Grafana consumes the ESO-owned admin Secret");
  return links;
}

function assertAppFamilyPlanConsistency(desired, familyFilter = APP_FAMILIES) {
  for (const family of familyFilter) {
    const baseSpace = `${family.prefix}-base`;
    for (let index = 0; index < family.targets.length; index += 1) {
      const fleetItem = family.targets[index];
      const space = `${family.prefix}-${fleetItem.suffix}`;
      const plannedSpace = desired.spaces.find((item) => item.slug === space);
      check(plannedSpace, `${space}: app-family Space is missing from the plan`);
      const expectedUpstream = family.scenario
        ? index === 0
          ? baseSpace
          : index === 1
            ? `${family.prefix}-dev`
            : `${family.prefix}-staging`
        : baseSpace;
      check(
        plannedSpace.upstreamSpace === expectedUpstream,
        `${space}: planned upstream ${plannedSpace.upstreamSpace ?? "missing"} differs from ${expectedUpstream}`,
      );
      const plannedUnits = desired.managedUnits.filter((item) => item.space === space);
      check(plannedUnits.length === family.units.length, `${space}: planned Unit inventory differs from the app family`);
      for (const unit of plannedUnits) {
        check(
          unit.upstream === `${expectedUpstream}/${unit.slug}`,
          `${space}/${unit.slug}: planned Unit upstream ${unit.upstream ?? "missing"} differs from ${expectedUpstream}/${unit.slug}`,
        );
      }
    }
  }
}

function verifyLocalContract(inputs, { requireLiveEvidence }) {
  const alwaysRequired = Object.values(paths).filter((item) => !requiredApplyEvidence.includes(item));
  const required = requireLiveEvidence ? Object.values(paths) : alwaysRequired;
  const missing = required.filter((item) => !existsSync(absolute(item)));
  check(missing.length === 0, `missing required Kubara mini-IDP inputs:\n- ${missing.join("\n- ")}`);

  const config = readYaml(absolute(paths.config));
  check(config.version === "v1alpha4", "current Kubara config must be v1alpha4");
  check(config.bootstrapCatalog === `oci://ghcr.io/kubara-io/catalogs/bootstrap:${CATALOG_VERSION}`, "bootstrap catalog reference drifted");
  check(config.clusters?.length === FLEET.length, `expected ${FLEET.length} clusters in current config`);
  for (const item of FLEET) {
    const cluster = config.clusters.find((entry) => entry.name === item.cluster);
    check(cluster, `${item.cluster} is missing from current Kubara config`);
    check(cluster.stage === item.suffix.replace(/-.*$/, "") || (item.environment === "Prod" && cluster.stage === "prod"), `${item.cluster} stage drifted`);
    check(cluster.catalogs?.includes(`oci://ghcr.io/kubara-io/catalogs/general:${CATALOG_VERSION}`), `${item.cluster} general catalog reference drifted`);
  }
  const hub = config.clusters.find((entry) => entry.type === "hub");
  check(hub?.name === DEV.cluster, "hx-app-dev must remain the Kubara hub");
  check(config.clusters.filter((entry) => entry.type === "spoke").length === 3, "current Kubara config must retain three spokes");

  const appSetTemplate = readFileSync(absolute(paths.argoAppSetTemplate), "utf8");
  check(
    appSetTemplate.includes("namespace: {{ default $app.name $app.namespace }}"),
    "Kubara ApplicationSet destination namespace default drifted",
  );
  const kubaraApps = readYaml(absolute(paths.argoValues))
    .bootstrapValues?.applicationSets?.["hx-app-dev-dev"]?.apps ?? {};
  for (const item of SURFACES) {
    const kubaraApp = kubaraApps[item.kubaraService];
    check(kubaraApp?.name, `${item.prefix}: Kubara service ${item.kubaraService} is missing from generated Argo values`);
    const kubaraNamespace = kubaraApp.namespace ?? kubaraApp.name;
    check(
      item.destinationNamespace === kubaraNamespace,
      `${item.prefix}: destination namespace ${item.destinationNamespace} does not match Kubara's ${kubaraNamespace}`,
    );
  }

  const artifacts = readYaml(absolute(paths.componentArtifacts));
  check(artifacts.spec?.exactVersionPolicy === "fail-if-missing", "component artifact policy must fail if an exact version is missing");
  check(artifacts.spec?.retentionPolicy === "additive-only", "component artifact retention must remain additive-only");
  const actualVersions = new Map();
  for (const item of artifacts.spec?.artifacts ?? []) {
    const name = item.canonicalIdentity.endsWith("prometheus-blackbox-exporter")
      ? "prometheus-blackbox-exporter"
      : item.service;
    actualVersions.set(name, String(item.version));
    check(/^[0-9a-f]{64}$/.test(String(item.sha256 ?? "")), `${item.canonicalIdentity} exact SHA is missing`);
  }
  for (const item of artifacts.spec?.firstParty ?? []) actualVersions.set(item.service, String(item.wrapperVersion));
  for (const [name, version] of Object.entries(EXPECTED_VERSIONS)) {
    check(actualVersions.get(name) === version, `${name} must remain selected at ${version}`);
  }

  const fullCatalogCoverage = readYaml(absolute(paths.catalogFullCoverageReceipt));
  check(
    fullCatalogCoverage.kind === "KubaraCatalogFullCoverageReceipt"
      && fullCatalogCoverage.spec?.finalCatalog?.componentCount === 103
      && fullCatalogCoverage.spec?.finalCatalog?.versionCount === 130
      && fullCatalogCoverage.spec?.selections?.length === 18
      && fullCatalogCoverage.status?.result === "pass"
      && fullCatalogCoverage.status?.oldRootsByteIdentical === true,
    "full Kubara catalogs 1.1.0 component coverage must remain a passing additive 103-component/130-version receipt",
  );

  const generation = readYaml(absolute(paths.generationReceipt));
  check(
    generation.status?.result === "offline-generation-and-render-pass"
      && generation.status?.kubaraGeneration === "pass"
      && generation.status?.catalogParity === "pass",
    "current Kubara generation receipt is not an offline generation/parity pass",
  );
  check(generation.spec?.tools?.kubaraVersion === KUBARA_VERSION, "generation receipt Kubara version drifted");
  check(generation.spec?.platform?.renderCount === 13, "generation receipt must retain 13 effective renders");

  const adapter = readYaml(absolute(paths.adapterReceipt));
  check(
    adapter.kind === "KubaraCatalogAdapterReceipt"
      && adapter.spec?.invariants?.sourceMutation === false
      && adapter.spec?.invariants?.aiRequired === false
      && adapter.spec?.invariants?.currentCatalogExportsAreFullBootstrapAndGeneralTrees === true,
    "catalog adapter receipt invariants are not satisfied",
  );
  const desiredMatrix = JSON.parse(readFileSync(absolute(paths.desiredMatrix), "utf8"));
  check(
    desiredMatrix.kind === "KubaraPlatformMatrix"
      && desiredMatrix.metadata?.name === "kubara-v0.13.0-current-four-cluster-desired"
      && desiredMatrix.spec?.profile?.evidenceLayer === "desired-only"
      && desiredMatrix.spec?.evidence?.kubaraVersion === KUBARA_VERSION
      && desiredMatrix.spec?.evidence?.catalogVersion === CATALOG_VERSION
      && desiredMatrix.spec?.evidence?.parsedObservationCells === 0
      && desiredMatrix.spec?.components?.length === 9
      && desiredMatrix.spec?.clusters?.length === FLEET.length
      && desiredMatrix.spec?.rows?.length === FLEET.length * 9
      && desiredMatrix.spec.rows.every(
        (row) => row.syncState === "Unknown" && row.observedVersion === "Unknown",
      ),
    "desired platform matrix must remain the 9×4 Kubara v0.13.0 desired-only contract with zero live observations",
  );
  const wiring = JSON.parse(readFileSync(absolute(paths.wiring), "utf8"));
  check(wiring.spec?.evidence?.kubaraVersion === KUBARA_VERSION, "primary wiring ledger is not current Kubara v0.13.0 evidence");

  if (requireLiveEvidence) {
    const qualification = readYaml(absolute(paths.qualificationReceipt));
    check(qualification.kind === "KubaraLiveQualificationSetReceipt", "current qualification receipt kind drifted");
    check(qualification.spec?.laneCount === 13 && qualification.status?.result === "pass", "all 13 current qualification lanes must pass");
    const promotion = readYaml(absolute(paths.promotionReceipt));
    check(promotion.kind === "KubaraCatalogRootPromotionReceipt", "current promotion receipt kind drifted");
    check(promotion.status?.result === "pass" && promotion.status?.historicalRootsPreserved === true, "current promotion must pass and retain historical roots");
    const faithful = verifyFaithfulProof();
    check(faithful.kind === "KubaraFaithfulHubSpokeProofReceipt", "faithful lane receipt kind drifted");
    check(faithful.status?.result === "pass", "faithful hub-spoke lane must pass before adapted fleet apply");
  }

  const appDocs = APP_FAMILIES.flatMap((family) => family.units.flatMap((unit) => unit.source.flatMap((source) => parseDocs(readFileSync(absolute(source), "utf8")))));
  for (const family of APP_FAMILIES) {
    const docs = family.units.flatMap((unit) => unit.source.flatMap((source) => parseDocs(readFileSync(absolute(source), "utf8"))));
    const namespaced = docs.filter((doc) => doc.metadata?.namespace);
    check(namespaced.length > 0, `${family.prefix}: application fixture has no namespaced objects`);
    check(
      namespaced.every((doc) => doc.metadata.namespace === family.destinationNamespace),
      `${family.prefix}: application fixture namespace does not match ${family.destinationNamespace}`,
    );
  }
  const images = appDocs.flatMap(imagesInDocument);
  check(images.length >= 4, "current app fixtures should expose four pinned workload images");
  for (const image of images) check(image.includes("@sha256:"), `app image is not digest pinned: ${image}`);

  verifyKindTraefikRenderedContracts();
  verifyHxWebPayloadContract(inputs);
}

function verifyKindTraefikRenderedContracts() {
  for (const contract of KIND_TRAEFIK_CONTRACTS) {
    const renderPath = absolute(
      `examples/kubara/current-platform/effective-renders/${contract.cluster}/traefik/release-objects.yaml`,
    );
    check(existsSync(renderPath), `${contract.cluster}: Traefik effective render is missing`);
    assertKindTraefikRenderedObjects(
      contract,
      parseDocs(readFileSync(renderPath, "utf8")),
    );
  }
}

function verifyFaithfulProof() {
  const availability = faithfulProofAvailability();
  check(
    availability.sourceCurrent,
    `current faithful hub-spoke evidence is unavailable (${availability.status}); live apply and verification require a regenerated source-current receipt${availability.detail ? `:\n${availability.detail}` : ""}`,
  );
  return cachedFaithfulReceipt;
}

function faithfulProofAvailability() {
  if (cachedFaithfulAvailability) return cachedFaithfulAvailability;

  const retainedHistoricalReceipt = existsSync(absolute(paths.faithfulReceipt));
  const unavailable = (status, detail = "") => {
    cachedFaithfulAvailability = {
      path: paths.faithfulReceipt,
      retainedHistoricalReceipt,
      sourceCurrent: false,
      status,
      detail,
    };
    return cachedFaithfulAvailability;
  };

  if (!retainedHistoricalReceipt) return unavailable("missing");
  if (existsSync(absolute(FAITHFUL_FAILURE_PATH))) {
    return unavailable(
      "newer-failure-recorded",
      `${FAITHFUL_FAILURE_PATH} records a newer failed proof attempt`,
    );
  }
  if (existsSync(absolute(FAITHFUL_ATTEMPT_PATH))) {
    return unavailable(
      "proof-attempt-active",
      `${FAITHFUL_ATTEMPT_PATH} records an active proof attempt`,
    );
  }

  const result = tryCommand(process.execPath, [absolute(FAITHFUL_PROOF_SCRIPT), "--verify"]);
  if (!result.ok) return unavailable("source-stale-or-invalid", result.output);

  try {
    const faithful = readYaml(absolute(paths.faithfulReceipt));
    if (faithful.kind !== "KubaraFaithfulHubSpokeProofReceipt") {
      return unavailable("invalid-kind", "faithful lane receipt kind drifted");
    }
    if (faithful.status?.result !== "pass") {
      return unavailable("not-passing", "faithful hub-spoke lane is not a pass");
    }
    cachedFaithfulReceipt = faithful;
  } catch (error) {
    return unavailable("unreadable", String(error));
  }

  cachedFaithfulAvailability = {
    path: paths.faithfulReceipt,
    retainedHistoricalReceipt: true,
    sourceCurrent: true,
    status: "current-pass",
    detail: "",
  };
  return cachedFaithfulAvailability;
}

function verifyHxWebPayloadContract(inputs) {
  const deployment = (key) => parseDocs(inputs.payloads.get(key)?.value ?? "")
    .find((doc) => doc.kind === "Deployment" && doc.metadata?.name === "hx-web");
  const containerEnv = (doc) => doc?.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const hasSandbox = (doc) => containerEnv(doc).some(
    (entry) => entry.name === "SANDBOX_URL" && entry.value === "http://sandbox.hx-web.svc:8080",
  );

  const base = deployment("hx-web/base/hx-web-deployment/v2");
  const dev = deployment("hx-web/dev/hx-web-deployment/final");
  const staging = deployment("hx-web/staging/hx-web-deployment/final");
  const prodA = deployment("hx-web/prod-a/hx-web-deployment/final");
  const prodB = deployment("hx-web/prod-b/hx-web-deployment/final");
  check([base, dev, staging, prodA, prodB].every(Boolean), "hx-web rollout payload set is incomplete");
  check(base.spec?.replicas === 3 && base.metadata?.annotations?.["platform.confighub.com/promotion"] === "promotion-v2", "hx-web base must end at promotion-v2 with three replicas");
  check(dev.spec?.replicas === 3 && dev.metadata?.annotations?.["platform.confighub.com/promotion"] === "promotion-v2" && !hasSandbox(dev), "hx-web dev final payload drifted");
  check(staging.spec?.replicas === 3 && staging.metadata?.annotations?.["platform.confighub.com/promotion"] === "promotion-v2" && hasSandbox(staging), "hx-web staging must retain only its SANDBOX_URL departure through promotion-v2");
  check(prodA.spec?.replicas === 2 && !prodA.metadata?.annotations?.["platform.confighub.com/revision"] && !hasSandbox(prodA), "hx-web prod-a must retain the one-target rollback without staging's departure");
  check(prodB.spec?.replicas === 3 && prodB.metadata?.annotations?.["platform.confighub.com/revision"] === "promotion-v1" && !prodB.metadata?.annotations?.["platform.confighub.com/promotion"] && !hasSandbox(prodB), "hx-web prod-b must remain on promotion-v1 without staging's departure");
}

function imagesInDocument(doc) {
  const podSpec = doc.kind === "Deployment" || doc.kind === "StatefulSet"
    ? doc.spec?.template?.spec
    : null;
  return [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])]
    .map((container) => container.image)
    .filter(Boolean);
}

if (mode === "--self-test-performance") {
  selfTestPerformanceInstrumentation();
  process.exit(0);
}

const inputs = materializeInputs();
const plan = buildPlan(inputs);

if (mode === "--plan") {
  printPlan(inputs, plan);
} else if (mode === "--diagnose-journal") {
  verifyLocalContract(inputs, { requireLiveEvidence: true });
  diagnoseOperationJournal();
} else if (mode === "--diagnose-history") {
  verifyLocalContract(inputs, { requireLiveEvidence: true });
  assertKubaraOrganization();
  console.log(stableJson(scenarioReceiptHistoryDiagnosis()));
} else if (mode === "--rebind-journal") {
  verifyLocalContract(inputs, { requireLiveEvidence: true });
  diagnoseOperationJournal({ rebind: true });
} else if (mode === "--apply") {
  verifyLocalContract(inputs, { requireLiveEvidence: true });
  applyPlan(inputs, plan);
} else if (mode === "--verify") {
  verifyLocalContract(inputs, { requireLiveEvidence: true });
  const observation = verifyLive(inputs, plan);
  console.log(`verified Kubara mini-IDP: ${observation.spaces.length} Spaces, ${observation.units.length} managed Units, ${observation.links.length} NeedsProvides Links`);
} else if (mode === "--receipt-verify") {
  verifyReceipt(inputs, plan);
} else {
  selfTestProtectedNamespaceOwnership();
  selfTestKindTraefikContract();
  selfTestPerformanceInstrumentation();
  selfTestReleaseRecovery();
  selfTestArgoConvergence();
  selfTestScenarioOperationEvidence();
  selfTestReceiptLinkEvidence(plan);
}

function prepareImmutableSelectorConvergenceRebind(journal) {
  const entries = Object.entries(journal.convergence ?? {});
  if (entries.length === 0) return [];
  check(entries.length === 1, "refusing to recover more than one immutable-selector Argo convergence during execution rebind");
  const [key, entry] = entries[0];
  const deployment = plan.deployments.find(
    (item) => `${item.cluster}/${item.space}` === entry.application,
  );
  const migrations = immutableSelectorMigrationsFor(deployment);
  check(migrations.length > 0, `${key}: convergence is not an allowlisted immutable-selector migration`);
  check(key === convergenceJournalKey(deployment, entry.expectedRevision), `${key}: convergence key drifted from its Application/revision`);
  const app = readLiveArgoApplication(deployment);
  assertArgoApplicationContract(app, deployment);
  check(!app.operation && !["Running", "Terminating"].includes(app.status?.operationState?.phase), `${key}: Argo operation is still active`);
  check(
    Number(entry.syncReservations) >= 0 && Number(entry.syncReservations) <= ARGO_MAX_SYNC_REQUESTS,
    `${key}: convergence sync reservations are outside the declared bound`,
  );
  check(
    app.status?.sync?.revision === entry.expectedRevision
      && operationStateRevision(app) === entry.expectedRevision,
    `${key}: convergence is not bound to the exact current OCI revision`,
  );
  const release = validatedPublishedRelease(
    deployment.space,
    latestRelease(deployment.space),
    `${key}: recovery published release`,
  );
  check(release.ManifestDigest === entry.expectedRevision, `${key}: published release digest changed before recovery authorization`);
  const expectedIdentity = releaseIdentity({ latestPublishedRelease: release });
  assertReleaseStreamStillCurrent(deployment.space, expectedIdentity, entry.expectedRevision, {});
  journal.convergenceRecoveries ??= [];
  const recoveries = [];
  for (const migration of migrations) {
    const existingAttempt = journal.immutableSelectorReplacements[migration.migrationID];
    if (existingAttempt?.state === "replacement-healthy") continue;
    if (existingAttempt?.state === "old-uid-gone") {
      assertImmutableSelectorReplacementEvidence(existingAttempt, `${key}: quiescent immutable-selector recovery`, { requireComplete: false });
      check(existingAttempt.expectedRevision === entry.expectedRevision, `${key}: quiescent migration revision drifted`);
      const current = immutableSelectorCurrentObject(deployment, migration);
      check(current?.metadata?.uid !== existingAttempt.uid, `${key}: old workload UID still exists after journaled deletion`);
      if (current) {
        assertImmutableSelectorOwnedObject(deployment, migration, current, migration.toSelector, `${key}: quiescent replacement candidate`);
        assertRetainedPVCsUnchanged(deployment, migration, existingAttempt.retainedPVCs, `${key}: quiescent replacement candidate`);
      }
      const recovery = {
        key,
        application: entry.application,
        expectedRevision: entry.expectedRevision,
        exhaustedSyncReservations: entry.syncReservations,
        classification: "quiescent-old-uid-gone-convergence-resume",
        migrationID: migration.migrationID,
        oldUID: existingAttempt.uid,
        recoveredAt: new Date().toISOString(),
      };
      journal.convergenceRecoveries.push(recovery);
      recoveries.push(recovery);
      continue;
    }
    check(!existingAttempt, `${migration.migrationID}: immutable-selector recovery has an unrecognized journal state`);
    const failure = immutableSelectorFailureRow(app, migration);
    check(failure, `${migration.migrationID}: exact resource-level immutable-selector failure is absent`);
    const workload = immutableSelectorCurrentObject(deployment, migration);
    check(workload, `${migration.migrationID}: legacy workload is absent before recovery authorization`);
    assertImmutableSelectorOwnedObject(deployment, migration, workload, migration.fromSelector, `${migration.migrationID}: legacy workload`);
    assertImmutableSelectorReviewedPayload(deployment, migration);
    const retainedPVCs = retainedPVCObservations(deployment, migration);
    const preparedAt = new Date().toISOString();
    journal.immutableSelectorReplacements[migration.migrationID] = {
      migrationID: migration.migrationID,
      ref: immutableSelectorReplacementRef(deployment, migration),
      uid: workload.metadata.uid,
      resourceVersion: workload.metadata.resourceVersion,
      application: `${deployment.cluster}/${deployment.space}`,
      expectedRevision: entry.expectedRevision,
      apiVersion: migration.apiVersion,
      kind: migration.kind,
      name: migration.name,
      namespace: migration.namespace,
      fromSelector: migration.fromSelector,
      toSelector: migration.toSelector,
      retainedPVCs,
      reason: migration.reason,
      trigger: "recovered-resource-level-immutable-selector-failure",
      failureEvidencePolicy: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY,
      failureEvidence: immutableSelectorFailureEvidence(app, failure),
      state: "prepared",
      preparedAt,
    };
    const recovery = {
      key,
      application: entry.application,
      expectedRevision: entry.expectedRevision,
      exhaustedSyncReservations: entry.syncReservations,
      resourceFailure: {
        group: failure.group,
        kind: failure.kind,
        namespace: failure.namespace,
        name: failure.name,
        status: failure.status,
        hookPhase: failure.hookPhase,
        classification: "immutable-workload-selector",
      },
      migrationID: migration.migrationID,
      oldUID: workload.metadata.uid,
      oldResourceVersion: workload.metadata.resourceVersion,
      retainedPVCs,
      recoveredAt: preparedAt,
    };
    journal.convergenceRecoveries.push(recovery);
    recoveries.push(recovery);
  }
  check(recoveries.length > 0, `${key}: immutable-selector convergence has no recoverable declared workload`);
  delete journal.convergence[key];
  return recoveries;
}

function preparedScenarioTransitionRecoveryForRebind(scenario, current) {
  const transition = scenario.preparedStep?.preparedTransition;
  if (!transition) return null;
  const match = /^(hx-web-(dev|staging|prod-a|prod-b))-promote-v([12])$/.exec(transition.id ?? "");
  const provenanceMatch = /^(hx-web-prod-[ab])-v1-provenance$/.exec(transition.id ?? "");
  if (provenanceMatch) {
    const space = provenanceMatch[1];
    const payloadKey = "hx-web/base/hx-web-deployment/v1";
    assertScenarioUpsertPost(
      transition.preCheckpoint,
      current,
      space,
      "hx-web-deployment",
      payloadKey,
    );
    return {
      step: scenario.preparedStep.id,
      transition: transition.id,
      space,
      payloadKey,
      classification: "exact-reviewed-production-upsert-plus-semantically-empty-trigger-revision",
    };
  }
  check(match, `refusing execution rebind for unrecognized prepared scenario transition ${transition.id ?? "unknown"}`);
  const space = match[1];
  const version = Number(match[3]);
  let beforePayloadKey = "";
  let afterPayloadKey = "";
  if (version === 1) {
    beforePayloadKey = "hx-web/base/hx-web-deployment/initial";
    afterPayloadKey = "hx-web/base/hx-web-deployment/v1";
  } else if (space === "hx-web-dev") {
    beforePayloadKey = "hx-web/base/hx-web-deployment/v1";
    afterPayloadKey = "hx-web/dev/hx-web-deployment/final";
  } else if (space === "hx-web-staging") {
    beforePayloadKey = "hx-web/staging/hx-web-deployment/departure";
    afterPayloadKey = "hx-web/staging/hx-web-deployment/final";
  } else {
    check(false, `${transition.id}: v2 promotion recovery escaped the declared dev/staging targets`);
  }
  assertScenarioPromotionPost(
    transition.preCheckpoint,
    current,
    space,
    beforePayloadKey,
    afterPayloadKey,
  );
  return {
    step: scenario.preparedStep.id,
    transition: transition.id,
    space,
    beforePayloadKey,
    afterPayloadKey,
    classification: "reviewed-pathwise-before-after-promotion-blend",
  };
}

function diagnoseOperationJournal({ rebind = false } = {}) {
  assertKubaraOrganization();
  const lockPath = acquireSerialLiveLock();
  try {
    check(existsSync(OPERATION_JOURNAL_PATH), "operation journal is absent");
    const journal = JSON.parse(readFileSync(OPERATION_JOURNAL_PATH, "utf8"));
    check(
      journal.organizationExternalID === ORGANIZATION_EXTERNAL_ID
        && journal.organizationEntityID === ORGANIZATION_ENTITY_ID
        && journal.serverURL === CONFIGHUB_SERVER_URL,
      "operation journal does not belong to the pinned Kubara organization",
    );
    const scenario = journal.scenario;
    check(scenario?.version === SCENARIO_VERSION && ["started", "completed"].includes(scenario.state), "no recoverable hx-web scenario exists in the operation journal");
    check(scenario.sourceFingerprint === scenarioSourceFingerprint(), "scenario source fingerprint changed; diagnostic comparison is not meaningful");
    const expected = scenario.preparedStep?.transitionCheckpoint ?? scenario.checkpoint;
    check(expected, "scenario journal has no durable comparison checkpoint");
    const current = scenarioCheckpoint();
    const difference = firstStableDifference(expected, current);
    const preparedTransitionRecovery = difference
      ? preparedScenarioTransitionRecoveryForRebind(scenario, current)
      : null;
    const currentExecutionFingerprint = operationExecutionFingerprint();
    let rebinding = null;
    if (rebind) {
      check(
        !difference || preparedTransitionRecovery,
        `refusing to rebind a scenario journal whose live checkpoint differs: ${difference}`,
      );
      check(!journal.fleetBootstrap || journal.fleetBootstrap.state === "completed", "refusing to rebind with fleet bootstrap in flight");
      check(!journal.namespaceMove || ["observed-gone", "completed"].includes(journal.namespaceMove.state), "refusing to rebind with namespace move in flight");
      check(
        Object.values(journal.protectedNamespaceDetachments ?? {}).every(
          (item) => ["observed-detached", "already-detached", "completed"].includes(item?.state),
        ),
        "refusing to rebind with protected Namespace detachment in flight",
      );
      const completedScenario = scenario.state === "completed"
        && stableJson(scenario.completedSteps) === stableJson(SCENARIO_STEPS)
        && !scenario.preparedStep;
      const durableScenarioPrefix = scenario.state === "started"
        && Array.isArray(scenario.completedSteps)
        && scenario.preparedStep?.id
        && Array.isArray(scenario.preparedStep.completedTransitions)
        && (!scenario.preparedStep.preparedTransition || preparedTransitionRecovery);
      check(completedScenario || durableScenarioPrefix, "refusing to rebind outside an exact completed scenario or durable reviewed prefix");
      journal.immutableSelectorReplacements ??= {};
      const convergenceRecoveries = prepareImmutableSelectorConvergenceRebind(journal);
      check(
        Object.keys(journal.convergence ?? {}).length === 0,
        "refusing to rebind with an unrecognized Argo convergence in flight",
      );
      check(
        Object.values(journal.immutableSelectorReplacements).every(
          (item) => ["prepared", "old-uid-gone", "replacement-healthy"].includes(item?.state),
        ),
        "refusing to rebind with an unrecognized immutable-selector replacement state",
      );
      const priorExecutionFingerprint = journal.executionFingerprint;
      journal.executionFingerprint = currentExecutionFingerprint;
      scenario.executionFingerprint = currentExecutionFingerprint;
      journal.executionRebindings ??= [];
      journal.executionRebindings.push({
        priorExecutionFingerprint,
        currentExecutionFingerprint,
        reboundAt: new Date().toISOString(),
        reason: preparedTransitionRecovery
          ? "source-identical-prepared-promotion-postcondition-reviewed-and-live-state-exactly-recovered"
          : convergenceRecoveries.some((item) => item.classification === "quiescent-old-uid-gone-convergence-resume")
            ? "source-identical-checkpoint-exactly-matched-and-quiescent-immutable-selector-convergence-resumed"
            : convergenceRecoveries.length > 0
              ? "source-identical-checkpoint-exactly-matched-and-exact-immutable-selector-convergence-recovered"
              : "source-identical-transition-free-checkpoint-exactly-matched-live-state",
        completedSteps: [...scenario.completedSteps],
        preparedStep: scenario.preparedStep?.id ?? null,
        completedTransitions: [...(scenario.preparedStep?.completedTransitions ?? [])],
        preparedTransitionRecovery,
        convergenceRecoveries,
      });
      writeOperationJournal(journal);
      rebinding = journal.executionRebindings.at(-1);
    }
    console.log(JSON.stringify({
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "KubaraMiniIDPJournalDiagnostic",
      metadata: { name: "hx-web-scenario" },
      spec: {
        readOnly: !rebind,
        sourceFingerprintMatches: true,
        journalExecutionFingerprint: rebind ? rebinding.priorExecutionFingerprint : scenario.executionFingerprint,
        currentExecutionFingerprint,
        completedSteps: scenario.completedSteps,
        preparedStep: scenario.preparedStep?.id ?? null,
        completedTransitions: scenario.preparedStep?.completedTransitions ?? [],
        preparedTransition: scenario.preparedStep?.preparedTransition?.id ?? null,
        firstDifference: difference,
        preparedTransitionRecovery,
        rebinding,
      },
      status: {
        checkpointMatches: difference === null,
        preparedTransitionRecoveryValidated: Boolean(preparedTransitionRecovery),
        rebound: Boolean(rebinding),
      },
    }, null, 2));
  } finally {
    releaseSerialLiveLock(lockPath);
  }
}

function printPlan(inputs, desired) {
  const missingApplyEvidence = requiredApplyEvidence.filter((item) => item === paths.faithfulReceipt
    ? !inputs.faithfulAvailability.sourceCurrent
    : !existsSync(absolute(item)));
  const payloadRows = [...inputs.payloads.values()].map((item) => ({
    key: item.key,
    sha256: item.sha256,
    objectCount: item.objectCount,
    toolchain: item.toolchain,
    sourcePaths: item.sourcePaths,
    transform: item.transform,
  })).sort((left, right) => left.key.localeCompare(right.key));
  console.log(JSON.stringify({
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPReconcilePlan",
    metadata: { name: "kubara-v0-13-0-confighub-mini-idp" },
    spec: {
      organization: ORGANIZATION,
      execution: {
        organizationExternalID: ORGANIZATION_EXTERNAL_ID,
        organizationEntityID: ORGANIZATION_ENTITY_ID,
        serverURL: CONFIGHUB_SERVER_URL,
        deterministic: true,
        aiRequired: false,
        mutationGuardConsulted: false,
        destructiveOperations: [ARGO_PRUNE_POLICY, ARGO_NAMESPACE_MOVE_POLICY, IMMUTABLE_SELECTOR_REPLACEMENT_POLICY],
        persistentClustersPreserved: FLEET.map((item) => item.cluster),
        partialClusterStatePolicy: "fail-except-exact-journaled-prefix",
        serialLiveParityLock: true,
        unexpectedSpacePolicy: "fail-outside-exact-55-space-allowlist",
        unexpectedManagedUnitOrLinkPolicy: "fail",
        preservedControlUnitPolicy: "exact-receipt-bound-faithful-proof-units",
        argoApplicationContract: "allowlisted ConfigHub OCI source -> cluster-local API + Kubara destination namespace",
        argoRetryPolicy: ARGO_RETRY_POLICY,
        argoPrunePolicy: ARGO_PRUNE_POLICY,
        argoNamespaceMovePolicy: ARGO_NAMESPACE_MOVE_POLICY,
        immutableSelectorReplacementPolicy: IMMUTABLE_SELECTOR_REPLACEMENT_POLICY,
        immutableSelectorFailureEvidencePolicy: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY,
        immutableSelectorFailureEvidenceEffectiveAt: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_EFFECTIVE_AT,
        protectedNamespaceOwnershipPolicy: PROTECTED_NAMESPACE_OWNERSHIP_POLICY,
        kindTraefikPolicy: KIND_TRAEFIK_POLICY,
        argoRevisionPolicy: ARGO_REVISION_POLICY,
        guiIdentityPolicy: GUI_IDENTITY_POLICY,
        interruptedScenarioPolicy: INTERRUPTED_SCENARIO_POLICY,
        interruptedReleasePolicy: INTERRUPTED_RELEASE_POLICY,
        publishedReleaseSelectionPolicy: PUBLISHED_RELEASE_SELECTION_POLICY,
        deliveryRootPublicationPolicy: DELIVERY_ROOT_PUBLICATION_POLICY,
        receiptRequiresZeroActionRerun: true,
        minimumCubVersion: `v${MIN_CUB_VERSION}`,
      },
      source: {
        kubaraVersion: KUBARA_VERSION,
        catalogVersion: CATALOG_VERSION,
        config: paths.config,
        componentArtifacts: paths.componentArtifacts,
        faithfulEvidence: {
          path: inputs.faithfulAvailability.path,
          retainedHistoricalReceipt: inputs.faithfulAvailability.retainedHistoricalReceipt,
          sourceCurrent: inputs.faithfulAvailability.sourceCurrent,
          status: inputs.faithfulAvailability.status,
          retentionPolicy: "retain-history-exclude-from-current-plan-until-source-current",
        },
        missingApplyEvidence,
      },
      counts: {
        spaces: desired.spaces.length,
        managedUnits: desired.managedUnits.length,
        preservedFaithfulControlUnits: PRESERVED_FAITHFUL_CONTROL_UNITS.length,
        deployments: desired.deployments.length,
        deliveryApplicationUnits: desired.deployments.length + (FLEET.length * 2),
        deploymentAuthorityApplications: desired.deployments.length + (FLEET.length * 2),
        protectedNamespaceOwnershipDetachments: PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
        kindTraefikContracts: KIND_TRAEFIK_CONTRACTS.length,
        needsProvidesLinks: desired.links.length,
        payloads: payloadRows.length,
      },
      phases: [
        "preflight exact sources and live qualification receipts",
        "create or validate four persistent ConfigHub-owned Argo targets",
        "reconcile current contract, catalog, matrix, wiring, and lane evidence",
        "deliver lifecycle CRDs and platform prerequisites in dependency order",
        "retain protected default Namespaces while detaching only declared obsolete ownership metadata",
        "deliver the complete current Kubara component selection",
        "exercise hx-web promotion, prod approval, rollback, and staging departure",
        "deliver cubbychat and hx-web across all four clusters",
        "create visible NeedsProvides wiring Links",
        "verify ConfigHub state, Argo sync, workloads, and write the receipt",
        "rerun to prove zero-drift idempotence",
      ],
      spaces: desired.spaces,
      units: desired.managedUnits,
      preservedControlUnits: PRESERVED_FAITHFUL_CONTROL_UNITS.map((item) => ({
        ref: `${CONTROL_SPACE}/${item.slug}`,
        owner: "faithful-hub-spoke-proof",
        policy: "preserve-and-verify-against-current-pass-receipt",
      })),
      deployments: desired.deployments,
      protectedNamespaceOwnershipDetachments: PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS,
      deliveryApplicationUnits: plannedDeliveryApplicationIdentity(desired),
      links: desired.links,
      payloads: payloadRows,
    },
    status: {
      readyForApply: missingApplyEvidence.length === 0,
      missingApplyEvidence,
    },
  }, null, 2));
}

function command(binary, args, options = {}) {
  const verb = sanitizedCommandVerb(binary, args);
  const {
    expectedFailure = false,
    expectedMutationRefusal = false,
    waitReason = "",
    ...executionOptions
  } = options;
  const isSleep = basename(binary) === "sleep";
  if (isSleep) check(WAIT_REASONS.has(waitReason), `sleep.wait requires a classified wait reason, got ${waitReason || "none"}`);
  const startedAt = performance.now();
  let failed = false;
  try {
    return execFileSync(binary, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CONFIGHUB_AGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 200,
      timeout: executionOptions.timeout ?? 600_000,
      ...executionOptions,
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    recordCommandPerformance(verb, elapsedMs, failed);
    recordReconcileCommand({
      binary,
      verb,
      elapsedMs,
      failed,
      expectedFailure: expectedFailure || expectedMutationRefusal,
      expectedMutationRefusal,
      waitReason,
      args,
    });
  }
}

function sanitizedCommandVerb(binary, args) {
  const executable = basename(binary) === basename(process.execPath) ? "node" : safeMetricToken(basename(binary));
  if (executable === "cub") {
    let index = 0;
    while (index < args.length && args[index].startsWith("--")) {
      index += args[index] === "--context" || args[index] === "--space" ? 2 : 1;
    }
    const resource = safeMetricToken(args[index] ?? "command");
    const candidateVerb = args[index + 1];
    const action = candidateVerb && !candidateVerb.startsWith("-")
      ? safeMetricToken(candidateVerb)
      : "command";
    return action === "command" ? `cub.${resource}` : `cub.${resource}.${action}`;
  }
  if (executable === "kubectl") {
    const action = args.find((arg) => [
      "annotate", "delete", "get", "patch", "rollout", "wait",
    ].includes(arg));
    return `kubectl.${safeMetricToken(action ?? "command")}`;
  }
  if (executable === "kind") {
    return `kind.${safeMetricToken(args[0] ?? "command")}.${safeMetricToken(args[1] ?? "command")}`;
  }
  if (executable === "node") {
    const action = args.find((arg) => /^--[a-z0-9-]+$/i.test(arg));
    return `node.${safeMetricToken(action?.replace(/^--/, "") ?? "execute")}`;
  }
  if (executable === "pgrep") return "pgrep.scan";
  if (executable === "sleep") return "sleep.wait";
  return `${executable}.execute`;
}

function safeMetricToken(value) {
  const token = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "command";
}

function recordCommandPerformance(verb, elapsedMs, failed) {
  const current = commandPerformance.get(verb) ?? {
    verb,
    calls: 0,
    failures: 0,
    totalMs: 0,
    maxMs: 0,
  };
  current.calls += 1;
  current.failures += failed ? 1 : 0;
  current.totalMs += elapsedMs;
  current.maxMs = Math.max(current.maxMs, elapsedMs);
  commandPerformance.set(verb, current);
}

function configHubReadPurpose(verb) {
  if (activeConfigHubReadPurpose) return activeConfigHubReadPurpose;
  return verb === "cub.unit.data" ? "content" : "metadata-discovery";
}

function withConfigHubReadPurpose(purpose, run) {
  check(CONFIGHUB_READ_PURPOSES.includes(purpose), `unknown ConfigHub read purpose ${purpose}`);
  const prior = activeConfigHubReadPurpose;
  activeConfigHubReadPurpose = purpose;
  try {
    return run();
  } finally {
    activeConfigHubReadPurpose = prior;
  }
}

function mutationVerbFromMetric(verb) {
  if (!verb.startsWith("cub.")) return false;
  const [, resource, action = ""] = verb.split(".");
  return MUTATING_CUB_COMMAND_PAIRS.has(`${resource}/${action}`);
}

function recordReconcileCommand({
  binary,
  verb,
  elapsedMs,
  failed,
  expectedFailure,
  expectedMutationRefusal,
  waitReason,
  args,
}) {
  if (!activeReconcilePerformance) return;
  const event = {
    verb,
    elapsedMs,
    failed,
    expectedFailure: Boolean(expectedFailure && failed),
  };
  activeReconcilePerformance.commands.push(event);
  if (basename(binary) === "cub") {
    if (mutationVerbFromMetric(verb)) {
      activeReconcilePerformance.mutations.push({
        verb,
        outcome: failed
          ? expectedMutationRefusal ? "expected-refusal" : "unexpected-failure"
          : "succeeded",
        attributed: false,
      });
    } else {
      const purpose = configHubReadPurpose(verb);
      check(CONFIGHUB_READ_PURPOSES.includes(purpose), `unclassified ConfigHub read purpose ${purpose}`);
      activeReconcilePerformance.reads.push({ verb, purpose });
    }
  }
  if (basename(binary) === "sleep") {
    const requestedMs = Math.round(Number(args[0] ?? 0) * 1000);
    check(Number.isInteger(requestedMs) && requestedMs >= 0, `invalid requested sleep duration ${args[0] ?? ""}`);
    activeReconcilePerformance.waits.push({
      reason: waitReason,
      requestedMs,
      elapsedMs,
    });
  }
}

function beginReconcilePerformance() {
  check(!activeReconcilePerformance, "reconcile performance measurement is already active");
  const measurement = {
    startedAtMs: performance.now(),
    commands: [],
    reads: [],
    mutations: [],
    waits: [],
    milestones: {
      preArgoWallElapsedMs: null,
      firstArgoAcceptedMs: null,
      firstArgoAcceptedCluster: null,
      readsAtFirstDevAccepted: null,
    },
    argoSyncRequests: 0,
    phases: [],
  };
  activeReconcilePerformance = measurement;
  return measurement;
}

function markFirstDevConvergenceStart() {
  if (!activeReconcilePerformance) return;
  const milestones = activeReconcilePerformance.milestones;
  if (milestones.preArgoWallElapsedMs === null) {
    milestones.preArgoWallElapsedMs = Math.round(performance.now() - activeReconcilePerformance.startedAtMs);
  }
}

function markFirstDevAccepted() {
  if (!activeReconcilePerformance) return;
  const milestones = activeReconcilePerformance.milestones;
  if (milestones.firstArgoAcceptedMs !== null) return;
  milestones.firstArgoAcceptedMs = Math.round(performance.now() - activeReconcilePerformance.startedAtMs);
  milestones.firstArgoAcceptedCluster = "hx-app-dev";
  milestones.readsAtFirstDevAccepted = activeReconcilePerformance.reads.length;
}

function recordArgoSyncRequest() {
  if (activeReconcilePerformance) activeReconcilePerformance.argoSyncRequests += 1;
}

function classifyLatestMutationFailureAsExpected(verb) {
  if (!activeReconcilePerformance) return;
  const mutation = activeReconcilePerformance.mutations.findLast(
    (item) => item.verb === verb && item.outcome === "unexpected-failure",
  );
  const commandEvent = activeReconcilePerformance.commands.findLast(
    (item) => item.verb === verb && item.failed && !item.expectedFailure,
  );
  check(mutation && commandEvent, `${verb}: expected refusal has no measured failed mutation`);
  mutation.outcome = "expected-refusal";
  commandEvent.expectedFailure = true;
}

function attributeSuccessfulMutationForAction(type) {
  if (!activeReconcilePerformance) return;
  const verb = ACTION_MUTATION_VERB[type];
  if (!verb) return;
  const candidates = activeReconcilePerformance.mutations.filter(
    (item) => item.outcome === "succeeded" && !item.attributed && item.verb === verb,
  );
  check(candidates.length > 0, `${type}: no successful ${verb} mutation is available for action attribution`);
  if (["approval-policy", "unit-approve"].includes(type)) {
    for (const item of candidates) item.attributed = true;
  } else {
    candidates.at(-1).attributed = true;
  }
}

function summarizedCommandRows(events) {
  const rows = new Map();
  for (const event of events) {
    const row = rows.get(event.verb) ?? {
      verb: event.verb,
      calls: 0,
      expectedFailures: 0,
      unexpectedFailures: 0,
      elapsedMs: 0,
    };
    row.calls += 1;
    row.expectedFailures += event.failed && event.expectedFailure ? 1 : 0;
    row.unexpectedFailures += event.failed && !event.expectedFailure ? 1 : 0;
    row.elapsedMs += event.elapsedMs;
    rows.set(event.verb, row);
  }
  return [...rows.values()].sort((left, right) => left.verb.localeCompare(right.verb)).map((row) => ({
    ...row,
    elapsedMs: Math.round(row.elapsedMs),
  }));
}

function summarizedReadRows(reads) {
  const rows = new Map();
  for (const item of reads) rows.set(item.verb, (rows.get(item.verb) ?? 0) + 1);
  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([verb, calls]) => ({ verb, calls }));
}

function summarizedReadPurposes(reads) {
  return CONFIGHUB_READ_PURPOSES.map((purpose) => {
    const selected = reads.filter((item) => item.purpose === purpose);
    return { purpose, commands: selected.length, byVerb: summarizedReadRows(selected) };
  });
}

function summarizedMutationRows(mutations) {
  const rows = new Map();
  for (const item of mutations) {
    const row = rows.get(item.verb) ?? {
      verb: item.verb,
      attempts: 0,
      succeeded: 0,
      attributedSucceeded: 0,
      expectedRefusals: 0,
      unexpectedFailures: 0,
    };
    row.attempts += 1;
    if (item.outcome === "succeeded") {
      row.succeeded += 1;
      if (item.attributed) row.attributedSucceeded += 1;
    }
    else if (item.outcome === "expected-refusal") row.expectedRefusals += 1;
    else row.unexpectedFailures += 1;
    rows.set(item.verb, row);
  }
  return [...rows.values()].sort((left, right) => left.verb.localeCompare(right.verb));
}

function summarizedWaitRows(waits) {
  const rows = new Map();
  for (const item of waits) {
    const row = rows.get(item.reason) ?? { reason: item.reason, calls: 0, requestedMs: 0, elapsedMs: 0 };
    row.calls += 1;
    row.requestedMs += item.requestedMs;
    row.elapsedMs += item.elapsedMs;
    rows.set(item.reason, row);
  }
  return [...rows.values()].sort((left, right) => left.reason.localeCompare(right.reason)).map((row) => ({
    ...row,
    elapsedMs: Math.round(row.elapsedMs),
  }));
}

function reconcilePerformanceEvidence(measurement, state, { complete = true } = {}) {
  const wallElapsedMs = Math.round(performance.now() - measurement.startedAtMs);
  const commandRows = summarizedCommandRows(measurement.commands);
  const readRows = summarizedReadRows(measurement.reads);
  const mutationRows = summarizedMutationRows(measurement.mutations);
  const waitRows = summarizedWaitRows(measurement.waits);
  const succeeded = measurement.mutations.filter((item) => item.outcome === "succeeded");
  const unclassifiedWaitMs = measurement.waits
    .filter((item) => !WAIT_REASONS.has(item.reason))
    .reduce((sum, item) => sum + item.elapsedMs, 0);
  const commandElapsedMs = measurement.commands.reduce((sum, item) => sum + item.elapsedMs, 0);
  const actionCount = state?.actions?.length;
  const evidence = {
    schemaVersion: RECONCILE_PERFORMANCE_SCHEMA_VERSION,
    fixtureID: RECONCILE_PERFORMANCE_FIXTURE_ID,
    runClass: Number.isInteger(actionCount)
      ? actionCount === 0 ? "idempotent-apply" : "changed-apply"
      : "incomplete-apply",
    complete,
    wallElapsedMs,
    subprocesses: {
      calls: measurement.commands.length,
      unexpectedFailures: measurement.commands.filter((item) => item.failed && !item.expectedFailure).length,
      byVerb: commandRows,
    },
    confighub: {
      reads: {
        commands: measurement.reads.length,
        beforeFirstDevAcceptedCommands: measurement.milestones.readsAtFirstDevAccepted,
        byVerb: readRows,
        byPurpose: summarizedReadPurposes(measurement.reads),
      },
      mutations: {
        attempts: measurement.mutations.length,
        succeeded: succeeded.length,
        expectedRefusals: measurement.mutations.filter((item) => item.outcome === "expected-refusal").length,
        unexpectedFailures: measurement.mutations.filter((item) => item.outcome === "unexpected-failure").length,
        unattributedSucceeded: succeeded.filter((item) => !item.attributed).length,
        byVerb: mutationRows,
      },
    },
    waits: {
      explicitElapsedMs: Math.round(measurement.waits.reduce((sum, item) => sum + item.elapsedMs, 0)),
      unclassifiedExplicitMs: Math.round(unclassifiedWaitMs),
      byReason: waitRows,
    },
    milestones: {
      preArgoWallElapsedMs: measurement.milestones.preArgoWallElapsedMs,
      firstArgoAcceptedMs: measurement.milestones.firstArgoAcceptedMs,
      firstArgoAcceptedCluster: measurement.milestones.firstArgoAcceptedCluster,
    },
    argo: { syncRequests: measurement.argoSyncRequests },
    localProcess: {
      wallOutsideSubprocessMs: Math.max(0, Math.round(wallElapsedMs - commandElapsedMs)),
    },
  };
  if (state?.applyReadCacheEvidence) evidence.applyReadCache = state.applyReadCacheEvidence;
  return evidence;
}

function finishReconcilePerformance(measurement, state) {
  check(activeReconcilePerformance === measurement, "reconcile performance measurement identity drifted");
  const evidence = reconcilePerformanceEvidence(measurement, state);
  activeReconcilePerformance = null;
  return evidence;
}

function assertReconcileRunPerformanceEvidence(evidence, state) {
  check(evidence?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION, "reconcile run performance schema drifted");
  check(evidence.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID, "reconcile run performance fixture drifted");
  check(evidence.complete === true, "reconcile run performance is incomplete");
  check(
    evidence.runClass === (state.actions.length === 0 ? "idempotent-apply" : "changed-apply"),
    "reconcile run performance class disagrees with its action count",
  );
  check(Number.isInteger(evidence.wallElapsedMs) && evidence.wallElapsedMs >= 0, "reconcile run wall time is invalid");
  check(Number.isInteger(evidence.confighub?.reads?.beforeFirstDevAcceptedCommands), "reconcile run lacks first-dev ConfigHub read milestone");
  check(evidence.milestones?.firstArgoAcceptedCluster === "hx-app-dev", "reconcile run lacks exact hx-app-dev acceptance");
  check(Number.isInteger(evidence.milestones?.firstArgoAcceptedMs), "reconcile run first-dev acceptance time is invalid");
  check(Number.isInteger(evidence.milestones?.preArgoWallElapsedMs), "reconcile run pre-Argo time is invalid");
  check(evidence.waits?.unclassifiedExplicitMs === 0, "reconcile run contains unclassified explicit wait time");
  for (const row of evidence.subprocesses?.byVerb ?? []) {
    check(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,2}$/.test(row.verb ?? ""), `unsafe performance verb ${row.verb ?? ""}`);
  }
}

function performanceEvidence(scope, bulkSnapshots = activeVerificationReadSnapshot?.evidence ?? null) {
  const byVerb = [...commandPerformance.values()]
    .sort((left, right) => left.verb.localeCompare(right.verb))
    .map((item) => ({
      verb: item.verb,
      calls: item.calls,
      failures: item.failures,
      totalMs: roundedMilliseconds(item.totalMs),
      maxMs: roundedMilliseconds(item.maxMs),
    }));
  return {
    schemaVersion: 1,
    scope,
    wallElapsedMs: roundedMilliseconds(performance.now() - PROCESS_STARTED_AT_MS),
    commands: {
      executionPolicy: "serial",
      calls: byVerb.reduce((sum, item) => sum + item.calls, 0),
      failures: byVerb.reduce((sum, item) => sum + item.failures, 0),
      totalMs: roundedMilliseconds(byVerb.reduce((sum, item) => sum + item.totalMs, 0)),
      byVerb,
    },
    canonicalYaml: {
      requests: canonicalYamlPerformance.requests,
      cacheHits: canonicalYamlPerformance.hits,
      cacheMisses: canonicalYamlPerformance.misses,
      cacheEntries: canonicalYamlCache.size,
      parseMs: roundedMilliseconds(canonicalYamlPerformance.parseMs),
    },
    bulkSnapshots: bulkSnapshots ?? {
      mode: "disabled-outside-read-only-verification",
      stability: "not-applicable",
      resources: [],
    },
  };
}

function roundedMilliseconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function performanceCheckpoint() {
  return {
    wallStartedAtMs: performance.now(),
    commands: new Map([...commandPerformance.entries()].map(([verb, item]) => [verb, {
      calls: item.calls,
      failures: item.failures,
      totalMs: item.totalMs,
    }])),
  };
}

function performancePhaseEvidence(name, checkpoint) {
  const byVerb = [];
  for (const [verb, current] of [...commandPerformance.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const prior = checkpoint.commands.get(verb) ?? { calls: 0, failures: 0, totalMs: 0 };
    const calls = current.calls - prior.calls;
    if (calls === 0) continue;
    byVerb.push({
      verb,
      calls,
      failures: current.failures - prior.failures,
      totalMs: roundedMilliseconds(current.totalMs - prior.totalMs),
    });
  }
  const applyReadCache = currentApplyReadEvidence();
  return {
    name,
    wallElapsedMs: roundedMilliseconds(performance.now() - checkpoint.wallStartedAtMs),
    commands: {
      executionPolicy: "serial",
      calls: byVerb.reduce((sum, item) => sum + item.calls, 0),
      failures: byVerb.reduce((sum, item) => sum + item.failures, 0),
      totalMs: roundedMilliseconds(byVerb.reduce((sum, item) => sum + item.totalMs, 0)),
      byVerb,
    },
    ...(applyReadCache ? { configHubReadCache: applyReadCache } : {}),
  };
}

function assertApplyReadCacheEvidence(evidence, prefix = "apply read cache evidence") {
  check(evidence?.mode === "phase-scoped-mutation-aware-organization-wide", `${prefix} mode drifted`);
  check(evidence.consistency === APPLY_READ_CONSISTENCY, `${prefix} consistency contract drifted`);
  const boundaries = evidence.phaseBoundaries ?? [];
  check(boundaries[0] === "apply-start", `${prefix} does not start at apply-start`);
  check(new Set(boundaries).size === boundaries.length, `${prefix} phase boundaries are duplicated`);
  const resources = evidence.resources ?? [];
  check(
    stableJson(resources.map((item) => item.resource).sort()) === stableJson([...APPLY_READ_RESOURCES].sort()),
    `${prefix} resource coverage drifted`,
  );
  for (const item of resources) {
    check(item.initialListCalls === 1, `${prefix} ${item.resource} must use exactly one initial organization-wide list`);
    check(
      item.phaseRefreshListCalls === boundaries.length - 1,
      `${prefix} ${item.resource} phase refreshes are not constant by declared boundary`,
    );
    check(Number.isInteger(item.mutationRefreshCalls) && item.mutationRefreshCalls >= 0, `${prefix} ${item.resource} mutation refresh count is invalid`);
    check(Number.isInteger(item.invalidations) && item.invalidations >= 0, `${prefix} ${item.resource} invalidation count is invalid`);
    check(Number.isInteger(item.servedReads) && item.servedReads >= 0, `${prefix} ${item.resource} served-read count is invalid`);
    check(
      item.mutationRefreshCalls <= item.servedReads,
      `${prefix} ${item.resource} issued more mutation refreshes than reads`,
    );
  }
  const releaseReuse = evidence.authoritativeReleaseReuse;
  if (releaseReuse) {
    check(
      releaseReuse.mode === "single-dependency-complete-organization-snapshot",
      `${prefix} authoritative release-reuse mode drifted`,
    );
    check(
      /^sha256:[0-9a-f]{64}$/.test(releaseReuse.fingerprint ?? ""),
      `${prefix} authoritative release-reuse fingerprint is invalid`,
    );
    check(
      releaseReuse.finalVerification === "opening-and-closing-fingerprint-required",
      `${prefix} authoritative release-reuse final verification contract drifted`,
    );
    const streams = releaseReuse.streams ?? [];
    check(streams.length > 0, `${prefix} authoritative release-reuse stream inventory is empty`);
    check(
      stableJson(streams) === stableJson([...new Set(streams)].sort()),
      `${prefix} authoritative release-reuse streams are duplicated or unsorted`,
    );
  }
}

function assertPerformancePhaseEvidence(phase, prefix) {
  check(phase?.name === "apply-start-to-first-argo-convergence", `${prefix} name drifted`);
  check(Number.isFinite(phase.wallElapsedMs) && phase.wallElapsedMs >= 0, `${prefix} wall time is invalid`);
  check(phase.commands?.executionPolicy === "serial", `${prefix} command policy drifted`);
  const rows = phase.commands?.byVerb ?? [];
  check(Array.isArray(rows), `${prefix} command rows are invalid`);
  check(stableJson(rows.map((item) => item.verb)) === stableJson(rows.map((item) => item.verb).sort()), `${prefix} command rows are not sorted`);
  check(new Set(rows.map((item) => item.verb)).size === rows.length, `${prefix} command rows are duplicated`);
  for (const item of rows) {
    check(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,2}$/.test(item.verb ?? ""), `${prefix} contains a non-sanitized command verb`);
    check(Number.isInteger(item.calls) && item.calls > 0, `${prefix} ${item.verb} calls are invalid`);
    check(Number.isInteger(item.failures) && item.failures >= 0 && item.failures <= item.calls, `${prefix} ${item.verb} failures are invalid`);
    check(Number.isFinite(item.totalMs) && item.totalMs >= 0, `${prefix} ${item.verb} time is invalid`);
  }
  check(phase.commands.calls === rows.reduce((sum, item) => sum + item.calls, 0), `${prefix} call total is inconsistent`);
  check(phase.commands.failures === rows.reduce((sum, item) => sum + item.failures, 0), `${prefix} failure total is inconsistent`);
  if (phase.configHubReadCache) assertApplyReadCacheEvidence(phase.configHubReadCache, `${prefix} ConfigHub read cache`);
}

function assertPerformanceEvidence(evidence, prefix = "performance evidence") {
  check(evidence?.schemaVersion === 1, `${prefix} schema version drifted`);
  check(typeof evidence.scope === "string" && evidence.scope.length > 0, `${prefix} scope is missing`);
  check(Number.isFinite(evidence.wallElapsedMs) && evidence.wallElapsedMs >= 0, `${prefix} wall time is invalid`);
  check(evidence.commands?.executionPolicy === "serial", `${prefix} command execution is not serial`);
  const verbs = evidence.commands?.byVerb ?? [];
  check(Array.isArray(verbs), `${prefix} command verb rows are invalid`);
  check(
    verbs.every((item) => /^[a-z0-9-]+(?:\.[a-z0-9-]+){1,2}$/.test(item.verb ?? "")),
    `${prefix} contains a non-sanitized command verb`,
  );
  check(
    stableJson(verbs.map((item) => item.verb)) === stableJson(verbs.map((item) => item.verb).sort()),
    `${prefix} command verbs are not deterministic`,
  );
  check(new Set(verbs.map((item) => item.verb)).size === verbs.length, `${prefix} command verbs are duplicated`);
  check(
    evidence.commands.calls === verbs.reduce((sum, item) => sum + item.calls, 0),
    `${prefix} command call total is inconsistent`,
  );
  check(
    evidence.commands.failures === verbs.reduce((sum, item) => sum + item.failures, 0),
    `${prefix} command failure total is inconsistent`,
  );
  for (const item of verbs) {
    check(Number.isInteger(item.calls) && item.calls > 0, `${prefix} ${item.verb} call count is invalid`);
    check(Number.isInteger(item.failures) && item.failures >= 0 && item.failures <= item.calls, `${prefix} ${item.verb} failure count is invalid`);
    check(Number.isFinite(item.totalMs) && item.totalMs >= 0, `${prefix} ${item.verb} total time is invalid`);
    check(Number.isFinite(item.maxMs) && item.maxMs >= 0 && item.maxMs <= item.totalMs + 0.001, `${prefix} ${item.verb} max time is invalid`);
  }
  const yaml = evidence.canonicalYaml ?? {};
  check(Number.isInteger(yaml.requests) && yaml.requests >= 0, `${prefix} canonical YAML request count is invalid`);
  check(yaml.cacheHits + yaml.cacheMisses === yaml.requests, `${prefix} canonical YAML cache accounting is inconsistent`);
  check(Number.isInteger(yaml.cacheEntries) && yaml.cacheEntries === yaml.cacheMisses, `${prefix} canonical YAML entry count is inconsistent`);
  check(Number.isFinite(yaml.parseMs) && yaml.parseMs >= 0, `${prefix} canonical YAML parse time is invalid`);
  const bulk = evidence.bulkSnapshots ?? {};
  check(bulk.mode === "bracketed-organization-wide-read-only", `${prefix} bulk snapshot mode drifted`);
  check(bulk.stability === "pass", `${prefix} bulk snapshot stability did not pass`);
  check(/^sha256:[0-9a-f]{64}$/.test(bulk.canonicalFingerprint ?? ""), `${prefix} canonical ConfigHub fingerprint is invalid`);
  check(
    stableJson(bulk.fingerprintResources) === stableJson(FINAL_CONFIGHUB_FINGERPRINT_RESOURCES),
    `${prefix} canonical ConfigHub fingerprint resource coverage drifted`,
  );
  check(
    stableJson((bulk.resources ?? []).map((item) => item.resource).sort()) === stableJson([...FINAL_CONFIGHUB_FINGERPRINT_RESOURCES].sort()),
    `${prefix} bulk snapshot resource coverage drifted`,
  );
  for (const item of bulk.resources) {
    check(Number.isInteger(item.rows) && item.rows >= 0, `${prefix} ${item.resource} row count is invalid`);
    check(item.listCalls === 2, `${prefix} ${item.resource} must use one initial and one final list call`);
    check(Number.isInteger(item.servedReads) && item.servedReads >= 0, `${prefix} ${item.resource} served-read count is invalid`);
  }
  const phases = evidence.phases ?? [];
  check(Array.isArray(phases) && phases.length <= 1, `${prefix} phase evidence is invalid`);
  for (const phase of phases) assertPerformancePhaseEvidence(phase, `${prefix} pre-Argo phase`);
  if (evidence.applyReadCache) assertApplyReadCacheEvidence(evidence.applyReadCache, `${prefix} apply read cache`);
}

function selfTestPerformanceInstrumentation() {
  check(
    firstStableDifference({ a: [1] }, { a: [2] }) === "$.a[0] expected=1 actual=2",
    "performance self-test: deterministic checkpoint difference diagnostics drifted",
  );
  const requestCount = canonicalYamlPerformance.requests;
  const hitCount = canonicalYamlPerformance.hits;
  const missCount = canonicalYamlPerformance.misses;
  const fixture = "performance-self-test: true\nitems:\n  - one\n  - two\n";
  const first = canonicalYamlDocument(fixture);
  const second = canonicalYamlDocument(fixture);
  check(first === second, "performance self-test: canonical YAML cache changed its value");
  check(canonicalYamlPerformance.requests === requestCount + 2, "performance self-test: canonical request accounting drifted");
  check(canonicalYamlPerformance.hits === hitCount + 1, "performance self-test: canonical cache did not record one hit");
  check(canonicalYamlPerformance.misses === missCount + 1, "performance self-test: canonical cache did not record one miss");
  const left = snapshotRows([
    { SpaceID: "space-b", UnitID: "unit-b", Slug: "b" },
    { SpaceID: "space-a", UnitID: "unit-a", Slug: "a" },
  ], ["SpaceID", "UnitID", "Slug"]);
  const right = snapshotRows([
    { SpaceID: "space-a", UnitID: "unit-a", Slug: "a" },
    { SpaceID: "space-b", UnitID: "unit-b", Slug: "b" },
  ], ["SpaceID", "UnitID", "Slug"]);
  check(stableJson(left) === stableJson(right), "performance self-test: snapshot canonicalization depends on row order");
  selfTestVerificationReadSnapshotLifecycle();
  selfTestApplyReadSnapshotLifecycle();
  const resources = ["link", "release", "space", "target", "unit"].map((resource) => ({
    resource,
    rows: 1,
    listCalls: 2,
    servedReads: 1,
  }));
  assertPerformanceEvidence({
    schemaVersion: 1,
    scope: "self-test",
    wallElapsedMs: 1,
    commands: { executionPolicy: "serial", calls: 0, failures: 0, totalMs: 0, byVerb: [] },
    canonicalYaml: { requests: 1, cacheHits: 0, cacheMisses: 1, cacheEntries: 1, parseMs: 0 },
    bulkSnapshots: {
      mode: "bracketed-organization-wide-read-only",
      stability: "pass",
      canonicalFingerprint: `sha256:${"a".repeat(64)}`,
      fingerprintResources: [...FINAL_CONFIGHUB_FINGERPRINT_RESOURCES],
      resources,
    },
    phases: [{
      name: "apply-start-to-first-argo-convergence",
      wallElapsedMs: 1,
      commands: { executionPolicy: "serial", calls: 0, failures: 0, totalMs: 0, byVerb: [] },
    }],
  }, "performance self-test evidence");
  const syntheticState = { actions: [{ type: "unit-data", ref: "space-a/unit-a" }] };
  const syntheticMeasurement = {
    startedAtMs: performance.now() - 5,
    commands: [
      { verb: "cub.unit.list", elapsedMs: 1, failed: false, expectedFailure: false },
      { verb: "cub.unit.update", elapsedMs: 1, failed: false, expectedFailure: false },
      { verb: "sleep.wait", elapsedMs: 1, failed: false, expectedFailure: false },
    ],
    reads: [{ verb: "cub.unit.list", purpose: "metadata-discovery" }],
    mutations: [{ verb: "cub.unit.update", outcome: "succeeded", attributed: true }],
    waits: [{ reason: "argo-health-pending", requestedMs: 2000, elapsedMs: 1 }],
    milestones: {
      preArgoWallElapsedMs: 2,
      firstArgoAcceptedMs: 4,
      firstArgoAcceptedCluster: "hx-app-dev",
      readsAtFirstDevAccepted: 1,
    },
    argoSyncRequests: 0,
    phases: [],
  };
  const reconcileEvidence = reconcilePerformanceEvidence(syntheticMeasurement, syntheticState);
  assertReconcileRunPerformanceEvidence(reconcileEvidence, syntheticState);
  check(reconcileEvidence.confighub.reads.byPurpose.find((item) => item.purpose === "metadata-discovery")?.commands === 1, "performance self-test: ConfigHub read purpose accounting drifted");
  check(reconcileEvidence.confighub.mutations.unattributedSucceeded === 0, "performance self-test: successful mutation attribution drifted");
  check(reconcileEvidence.waits.unclassifiedExplicitMs === 0, "performance self-test: classified wait became unclassified");
  const nodePortContract = KIND_TRAEFIK_CONTRACTS[0];
  const attemptFingerprint = `sha256:${"b".repeat(64)}`;
  const attemptID = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  const attempt = (sequence, result) => ({ sequence, id: attemptID(sequence), executionFingerprint: attemptFingerprint, result });
  const run = (sequence, idempotentNoop) => ({
    attemptSequence: sequence,
    attemptID: attemptID(sequence),
    idempotentNoop,
    actionCount: idempotentNoop ? 0 : 1,
  });
  check(
    successfulAttemptPairValid(
      [run(4, false), run(5, true)],
      { attempts: [attempt(1, "failed"), attempt(2, "pass"), attempt(3, "failed"), attempt(4, "pass"), attempt(5, "pass")] },
    ),
    "performance self-test: consecutive changed/no-op durable attempts did not pass",
  );
  check(
    !successfulAttemptPairValid(
      [run(1, false), run(3, true)],
      { attempts: [attempt(1, "pass"), attempt(2, "failed"), attempt(3, "pass")] },
    ),
    "performance self-test: an intervening failed apply did not invalidate changed/no-op continuity",
  );
  const currentScenarioFingerprint = `sha256:${"c".repeat(64)}`;
  const priorScenarioFingerprint = `sha256:${"d".repeat(64)}`;
  const scenarioRun = (executionFingerprint, idempotentNoop, result = "pass") => ({
    executionFingerprint,
    idempotentNoop,
    actionCount: idempotentNoop ? 0 : 1,
    result,
  });
  check(
    reconcileRunsProveCurrentScenarioHistory([
      scenarioRun(priorScenarioFingerprint, true),
      scenarioRun(currentScenarioFingerprint, false),
    ], currentScenarioFingerprint),
    "performance self-test: retained prior-fingerprint run invalidated current changed scenario history",
  );
  check(
    !reconcileRunsProveCurrentScenarioHistory([
      scenarioRun(currentScenarioFingerprint, false),
      scenarioRun(priorScenarioFingerprint, true),
    ], currentScenarioFingerprint),
    "performance self-test: non-current latest run authorized scenario history",
  );
  check(
    !reconcileRunsProveCurrentScenarioHistory([
      scenarioRun(priorScenarioFingerprint, false),
      scenarioRun(currentScenarioFingerprint, true),
    ], currentScenarioFingerprint),
    "performance self-test: current execution without a changed run authorized scenario history",
  );
  check(
    !reconcileRunsProveCurrentScenarioHistory([
      scenarioRun(currentScenarioFingerprint, false, "failed"),
      scenarioRun(currentScenarioFingerprint, true),
    ], currentScenarioFingerprint),
    "performance self-test: failed current-fingerprint run authorized scenario history",
  );
  const terminalScenarioAttempt = {
    sequence: 9,
    id: attemptID(9),
    executionFingerprint: currentScenarioFingerprint,
    result: "pass",
  };
  const terminalScenarioRun = {
    ...scenarioRun(currentScenarioFingerprint, false),
    attemptSequence: terminalScenarioAttempt.sequence,
    attemptID: terminalScenarioAttempt.id,
  };
  const terminalScenarioReceipt = {
    status: { result: "pending-idempotence" },
    spec: { reconcileRuns: [terminalScenarioRun] },
  };
  const capturedScenarioBinding = scenarioReceiptAttemptBindingDiagnosis(
    terminalScenarioReceipt,
    { attempts: [terminalScenarioAttempt] },
    currentScenarioFingerprint,
  );
  check(
    capturedScenarioBinding.proven
      && trustedScenarioHistoryForApply({ scenarioReceiptProven: capturedScenarioBinding.proven }),
    "performance self-test: terminal pre-attempt scenario receipt was not reusable by the next apply",
  );
  const invalidatedScenarioReceipt = structuredClone(terminalScenarioReceipt);
  invalidatedScenarioReceipt.status.result = "invalidated-by-active-attempt";
  check(
    !scenarioReceiptAttemptBindingDiagnosis(
      invalidatedScenarioReceipt,
      { attempts: [terminalScenarioAttempt, {
        sequence: 10,
        id: attemptID(10),
        executionFingerprint: currentScenarioFingerprint,
        result: "active",
      }] },
      currentScenarioFingerprint,
    ).proven,
    "performance self-test: an active attempt's invalidated receipt was trusted as terminal evidence",
  );
  check(
    !scenarioReceiptAttemptBindingDiagnosis(
      terminalScenarioReceipt,
      { attempts: [{ ...terminalScenarioAttempt, id: attemptID(8) }] },
      currentScenarioFingerprint,
    ).proven,
    "performance self-test: a receipt/attempt ID mismatch authorized scenario history",
  );
  check(
    !scenarioReceiptAttemptBindingDiagnosis(
      terminalScenarioReceipt,
      { attempts: [{ ...terminalScenarioAttempt, result: "failed" }] },
      currentScenarioFingerprint,
    ).proven,
    "performance self-test: a failed terminal attempt authorized scenario history",
  );
  const argocdFixture = { items: [{
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      namespace: "argocd",
      name: "argocd-server",
      uid: "11111111-1111-4111-8111-111111111111",
      resourceVersion: "123",
    },
    spec: {
      type: "NodePort",
      ports: [{ name: "http", protocol: "TCP", port: 80, targetPort: 8080, nodePort: nodePortContract.reservedArgocdServerNodePort }],
    },
  }] };
  const argocdEvidence = assertArgocdServerNodePortEvidence(nodePortContract, argocdFixture);
  check(argocdEvidence.ports[0].nodePort === nodePortContract.reservedArgocdServerNodePort, "performance self-test: argocd-server reserved NodePort evidence drifted");
  check(argocdServerNodePortDisposition(nodePortContract, nodePortContract.reservedArgocdServerNodePort) === "current", "performance self-test: current argocd-server NodePort disposition drifted");
  check(argocdServerNodePortDisposition(nodePortContract, nodePortContract.reservedArgocdServerNodePort + 8) === "declared-recovery", "performance self-test: declared argocd-server recovery NodePort disposition drifted");
  let foreignDriftRejected = false;
  try {
    argocdServerNodePortDisposition(nodePortContract, nodePortContract.reservedArgocdServerNodePort + 7);
  } catch (error) {
    foreignDriftRejected = error.message.includes("refusing to normalize foreign");
  }
  check(foreignDriftRejected, "performance self-test: foreign argocd-server NodePort drift was normalized");
  let collisionRejected = false;
  try {
    const collision = structuredClone(argocdFixture);
    collision.items[0].spec.ports[0].nodePort = nodePortContract.httpNodePort;
    assertArgocdServerNodePortEvidence(nodePortContract, collision);
  } catch (error) {
    collisionRejected = error.message.includes("does not own reserved port");
  }
  check(collisionRejected, "performance self-test: argocd-server/Traefik NodePort collision was not rejected");
  console.log("Kubara mini-IDP performance instrumentation self-test passed");
}

function selfTestApplyReadSnapshotLifecycle() {
  check(!activeApplyReadSnapshot, "performance self-test: apply snapshot unexpectedly active");
  check(!activeVerificationReadSnapshot, "performance self-test: verification snapshot unexpectedly active");
  check(!activeSourceReleaseBoundarySnapshot, "performance self-test: release snapshot unexpectedly active");
  const mutationFixtures = new Map([
    ["cluster/up", ["cluster", "up", "--name", "space-a", "--space", "space-a"]],
    ["filter/create", ["filter", "create", "--space", "space-a"]],
    ["filter/update", ["filter", "update", "--space", "space-a"]],
    ["link/create", ["link", "create", "--space", "space-a"]],
    ["link/update", ["link", "update", "--space", "space-a"]],
    ["release/publish", ["release", "publish", "space-a"]],
    ["space/create", ["space", "create", "space-a"]],
    ["space/update", ["space", "update", "--patch", "space-a"]],
    ["trigger/create", ["trigger", "create", "--space", "space-a"]],
    ["trigger/update", ["trigger", "update", "--space", "space-a"]],
    ["unit/approve", ["unit", "approve", "--space", "space-a"]],
    ["unit/create", ["unit", "create", "--space", "space-a"]],
    ["unit/set-target", ["unit", "set-target", "--space", "space-a"]],
    ["unit/update", ["unit", "update", "--space", "space-a"]],
    ["variant/create", ["variant", "create", "a", "base", "--space-pattern", "template:space-a"]],
    ["variant/promote", ["variant", "promote", "space-a"]],
  ]);
  check(
    stableJson([...mutationFixtures.keys()].sort()) === stableJson([...MUTATING_CUB_COMMAND_PAIRS].sort()),
    "performance self-test: mutation invalidation fixtures do not cover every classified ConfigHub write",
  );
  for (const [pair, args] of mutationFixtures) {
    check(mutatingCubCommand(args), `performance self-test: ${pair} is not classified as a mutation`);
    const scopes = applyReadInvalidationScopes(args);
    check(scopes.length > 0, `performance self-test: ${pair} has no cache invalidation scope`);
    check(
      scopes.every(([resource]) => APPLY_READ_RESOURCES.includes(resource)),
      `performance self-test: ${pair} invalidates an unknown cache resource`,
    );
  }
  const approvalArgs = exactHeadApprovalArgs("space-a", {
    Slug: "unit-a",
    UnitID: "11111111-1111-4111-8111-111111111111",
    HeadRevisionNum: 8,
  });
  check(
    approvalArgs[4] === "unit-a"
      && !approvalArgs.includes("11111111-1111-4111-8111-111111111111")
      && approvalArgs[6] === "HeadRevisionNum",
    "performance self-test: exact-head approval did not use the documented positional Unit slug and server head selector",
  );
  const spaces = new Map([
    ["space-a", { Slug: "space-a", SpaceID: "space-id-a" }],
    ["space-b", { Slug: "space-b", SpaceID: "space-id-b" }],
  ]);
  const unitPayloads = ["kind: ConfigMap\n", "kind: Secret\n"];
  const units = [
    {
      Slug: "unit-a",
      UnitID: "unit-id-a",
      SpaceID: "space-id-a",
      Data: Buffer.from(unitPayloads[0], "utf8").toString("base64"),
      DataHash: sha256(unitPayloads[0]),
    },
    {
      Slug: "unit-b",
      UnitID: "unit-id-b",
      SpaceID: "space-id-b",
      Data: Buffer.from(unitPayloads[1], "utf8").toString("base64"),
      DataHash: sha256(unitPayloads[1]),
    },
  ];
  const largeUnitText = `apiVersion: v1\nkind: ConfigMap\ndata:\n  payload: ${"x".repeat(512 * 1024)}\n`;
  const largeCanonicalUnit = {
    Data: Buffer.from(largeUnitText, "utf8").toString("base64"),
    DataHash: sha256(largeUnitText),
  };
  check(
    decodeBulkUnitData(largeCanonicalUnit, "performance self-test/large unit") === largeUnitText,
    "performance self-test: large canonical bulk Unit Data did not round-trip",
  );
  expectBulkUnitDataFailure(
    { ...units[0], Data: "not-base64!" },
    "non-canonical base64 Data",
    "malformed base64",
  );
  expectBulkUnitDataFailure(
    { ...units[0], DataHash: "0".repeat(64) },
    "DataHash does not match decoded Data",
    "decoded-data hash mismatch",
  );
  const invalidUtf8 = Buffer.from([0xff]);
  expectBulkUnitDataFailure(
    { ...units[0], Data: invalidUtf8.toString("base64"), DataHash: sha256(invalidUtf8) },
    "decoded Data is not valid UTF-8",
    "invalid UTF-8",
  );
  const links = [{ Slug: "link-a", LinkID: "link-id-a", SpaceID: "space-id-a" }];
  const releases = [{ Slug: "release-a", ReleaseID: "release-id-a", SpaceID: "space-id-a", ReleaseNum: 1, UnitCount: 1 }];
  const canonicalRelease = (row) => snapshotRows([row], RELEASE_DECISION_FIELDS);
  check(
    sameCachedRows(canonicalRelease(releases[0]), canonicalRelease({ ...releases[0], Published: true })),
    "performance self-test: non-decision Release response fields caused false drift",
  );
  check(
    !sameCachedRows(canonicalRelease(releases[0]), canonicalRelease({ ...releases[0], ReleaseNum: 2 })),
    "performance self-test: decision-relevant Release drift was ignored",
  );
  check(
    sameCachedRows(
      currentReleaseDecisionRows(releases),
      currentReleaseDecisionRows([...releases, { ...releases[0], ReleaseID: "release-id-old", ReleaseNum: 0 }]),
    ),
    "performance self-test: retained historical Releases caused false current-head drift",
  );
  check(
    !sameCachedRows(
      currentReleaseDecisionRows(releases),
      currentReleaseDecisionRows([...releases, { ...releases[0], ReleaseID: "release-id-new", ReleaseNum: 2 }]),
    ),
    "performance self-test: a new current Release was ignored",
  );
  const target = { Slug: "target", TargetID: "target-id-a", SpaceID: "space-id-a" };
  const canonicalTarget = (row) => snapshotRows([row], TARGET_DECISION_FIELDS);
  check(
    sameCachedRows(canonicalTarget(target), canonicalTarget({ ...target, CreatedAt: "ignored-by-decision" })),
    "performance self-test: non-decision Target response fields caused false drift",
  );
  check(
    !sameCachedRows(canonicalTarget(target), canonicalTarget({ ...target, ProviderType: "changed" })),
    "performance self-test: decision-relevant Target drift was ignored",
  );
  const loaderCalls = { spaces: 0, units: 0, target: 0, links: 0, releases: 0 };
  const resources = APPLY_READ_RESOURCES.map((resource) => ({
    resource,
    initialListCalls: 1,
    phaseRefreshListCalls: 0,
    mutationRefreshCalls: 0,
    invalidations: 0,
    servedReads: 0,
  }));
  const snapshot = {
    evidenceByResource: new Map(resources.map((item) => [item.resource, item])),
    evidence: {
      mode: "phase-scoped-mutation-aware-organization-wide",
      consistency: APPLY_READ_CONSISTENCY,
      phaseBoundaries: ["apply-start"],
      resources,
    },
    loaders: {
      spaces: () => {
        loaderCalls.spaces += 1;
        return new Map(spaces);
      },
      units: (space) => {
        loaderCalls.units += 1;
        return units.filter((unit) => unit.SpaceID === spaces.get(space)?.SpaceID);
      },
      target: (space) => {
        loaderCalls.target += 1;
        return space === "space-a" ? target : null;
      },
      links: (space) => {
        loaderCalls.links += 1;
        return links.filter((link) => link.SpaceID === spaces.get(space)?.SpaceID);
      },
      releases: (space) => {
        loaderCalls.releases += 1;
        return releases.filter((release) => release.SpaceID === spaces.get(space)?.SpaceID);
      },
    },
  };
  const organizationFingerprint = `sha256:${"e".repeat(64)}`;
  const capturedOrganization = {
    unitsBySpace: new Map([
      ["space-a", [units[0]]],
      ["space-b", [units[1]]],
    ]),
    unitsByRef: new Map([
      ["space-a/unit-a", units[0]],
      ["space-b/unit-b", units[1]],
    ]),
    releasesBySpace: new Map([["space-a", releases]]),
    linksBySpace: new Map([["space-a", links]]),
    targetsBySpace: new Map([["space-a", target]]),
    targetRows: [target],
    fingerprint: organizationFingerprint,
  };
  installApplyOrganizationSnapshot(snapshot, spaces, capturedOrganization);

  try {
    activeApplyReadSnapshot = snapshot;
    const repeatedPasses = 256;
    for (let index = 0; index < repeatedPasses; index += 1) {
      check(readSpaces().size === 2, "performance self-test: cached Space inventory drifted");
      check(readUnitRows("space-a").length === 1, "performance self-test: cached Unit inventory drifted");
      check(readUnit("space-b", "unit-b")?.UnitID === "unit-id-b", "performance self-test: cached Unit lookup drifted");
      check(readUnitData("space-a", "unit-a") === "kind: ConfigMap\n", "performance self-test: bulk Unit Data drifted");
      check(readTarget("space-a")?.TargetID === "target-id-a", "performance self-test: cached target drifted");
      check(readLinks("space-a").length === 1, "performance self-test: cached Link inventory drifted");
      check(latestRelease("space-a")?.ReleaseNum === 1, "performance self-test: cached release drifted");
    }
    check(
      Object.values(loaderCalls).every((calls) => calls === 0),
      "performance self-test: repeated apply reads escaped the initial resource-type snapshot",
    );

    beginAuthoritativeReleaseReuseBatch({ snapshotOnly: true });
    const reused = withAuthoritativeReleaseReuseBatch("space-a", () => ({
      units: readUnitRows("space-a").length,
      links: readLinks("space-a").length,
      releaseNum: latestRelease("space-a")?.ReleaseNum,
    }));
    check(
      stableJson(reused) === stableJson({ units: 1, links: 1, releaseNum: 1 })
        && Object.values(loaderCalls).every((calls) => calls === 0),
      "performance self-test: authoritative release reuse escaped the organization snapshot",
    );

    invalidateApplyReadSnapshotForSuccessfulMutation(["unit", "update", "--space", "space-a"]);
    check(!activeAuthoritativeReleaseReuseBatch, "performance self-test: ConfigHub mutation retained the no-write release-reuse batch");
    invalidateApplyReadSnapshotForSuccessfulMutation(["unit", "update", "--space", "space-a"]);
    readUnit("space-a", "unit-a");
    readUnitRows("space-a");
    check(loaderCalls.units === 1, "performance self-test: duplicate Unit invalidations were not coalesced");

    invalidateApplyReadSnapshotForSuccessfulMutation(["link", "update", "--space", "space-a"]);
    readLinks("space-a");
    readLinks("space-a");
    readUnitRows("space-a");
    check(loaderCalls.links === 1 && loaderCalls.units === 2, "performance self-test: Link mutation scopes did not refresh exactly once");

    invalidateApplyReadSnapshotForSuccessfulMutation(["space", "update", "--patch", "space-a"]);
    readSpaces();
    readSpaces();
    readUnitRows("space-a");
    check(loaderCalls.spaces === 1 && loaderCalls.units === 3, "performance self-test: Space mutation scopes did not refresh exactly once");

    invalidateApplyReadSnapshotForSuccessfulMutation(["release", "publish", "space-a"]);
    latestRelease("space-a");
    latestRelease("space-a");
    check(loaderCalls.releases === 1, "performance self-test: release mutation refresh was not coalesced");

    invalidateApplyReadSnapshotForSuccessfulMutation(["cluster", "up", "--name", "space-a", "--space", "space-a"]);
    readSpaces();
    readUnitRows("space-a");
    readTarget("space-a");
    readLinks("space-a");
    latestRelease("space-a");
    check(
      stableJson(loaderCalls) === stableJson({ spaces: 2, units: 4, target: 1, links: 2, releases: 2 }),
      `performance self-test: global mutation refresh complexity drifted: ${stableJson(loaderCalls)}`,
    );
    installApplyOrganizationSnapshot(snapshot, spaces, capturedOrganization);
    beginAuthoritativeReleaseReuseBatch({ snapshotOnly: true });
    withAuthoritativeReleaseReuseBatch("space-a", () => latestRelease("space-a"));
    const evidence = finishApplyReadSnapshot();
    const servedReads = evidence.resources.reduce((sum, item) => sum + item.servedReads, 0);
    const refreshCalls = evidence.resources.reduce((sum, item) => sum + item.mutationRefreshCalls, 0);
    check(servedReads >= repeatedPasses * 7, "performance self-test: repeated read accounting is incomplete");
    check(refreshCalls === 11, "performance self-test: refresh calls grew with cache-served reads");
    check(
      evidence.authoritativeReleaseReuse?.fingerprint === organizationFingerprint
        && stableJson(evidence.authoritativeReleaseReuse?.streams) === stableJson(["space-a"]),
      "performance self-test: authoritative release-reuse evidence is incomplete",
    );
    console.log(`Kubara apply read cache self-test passed: ${repeatedPasses * 7} repeated reads (including exact Unit Data) used five initial resource lists and zero refreshes; five mutation scenarios required ${refreshCalls} coalesced scoped refreshes`);
  } finally {
    activeApplyReadSnapshot = null;
    activeSourceReleaseBoundarySnapshot = null;
    activeAuthoritativeReleaseReuseBatch = null;
  }
}

function selfTestVerificationReadSnapshotLifecycle() {
  check(!activeVerificationReadSnapshot, "performance self-test: verification snapshot unexpectedly active");
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const releaseReuseEvidence = {
    authoritativeReleaseReuse: { fingerprint },
  };
  assertAuthoritativeReleaseReuseFinalOpening(releaseReuseEvidence, { fingerprint });
  let staleReleaseReuseRejected = false;
  try {
    assertAuthoritativeReleaseReuseFinalOpening(releaseReuseEvidence, {
      fingerprint: `sha256:${"b".repeat(64)}`,
    });
  } catch (error) {
    staleReleaseReuseRejected = error.message.includes("changed after the dependency-complete pre-release snapshot");
  }
  check(staleReleaseReuseRejected, "performance self-test: stale pre-release organization snapshot was accepted by final verification");
  const verificationSpaceEvidence = { resource: "space", rows: 1, listCalls: 1, servedReads: 0 };
  activeVerificationReadSnapshot = {
    spaces: new Map([["space-a", { Slug: "space-a", SpaceID: "space-id-a" }]]),
    evidenceByResource: new Map([["space", verificationSpaceEvidence]]),
  };
  const returnedSpaces = readSpaces();
  returnedSpaces.clear();
  check(
    readSpaces().size === 1 && verificationSpaceEvidence.servedReads === 2,
    "performance self-test: final verification Space reads escaped or mutated the opening snapshot",
  );
  activeVerificationReadSnapshot = null;
  const opening = () => ({
    fingerprint,
    evidence: {
      mode: "bracketed-organization-wide-read-only",
      stability: "pending-final-snapshot",
      fingerprintResources: [...FINAL_CONFIGHUB_FINGERPRINT_RESOURCES],
      resources: [{ resource: "unit", rows: 1, listCalls: 1, servedReads: 0 }],
    },
  });
  const closingSpaces = new Map();

  try {
    activeVerificationReadSnapshot = opening();
    const evidence = finishVerificationReadSnapshot(() => ({
      fingerprint,
      rowCounts: { unit: 1 },
      listCalls: { unit: 1 },
    }), () => closingSpaces);
    check(evidence.stability === "pass", "performance self-test: stable snapshot did not pass");
    check(evidence.canonicalFingerprint === fingerprint, "performance self-test: stable snapshot did not expose its canonical fingerprint");
    check(
      stableJson(evidence.fingerprintResources) === stableJson(FINAL_CONFIGHUB_FINGERPRINT_RESOURCES),
      "performance self-test: canonical fingerprint resource coverage drifted",
    );
    check(!activeVerificationReadSnapshot, "performance self-test: successful snapshot remained active");

    activeVerificationReadSnapshot = opening();
    let driftFailure = null;
    try {
      finishVerificationReadSnapshot(() => ({
        fingerprint: `sha256:${"b".repeat(64)}`,
        rowCounts: { unit: 1 },
        listCalls: { unit: 1 },
      }), () => closingSpaces);
    } catch (error) {
      driftFailure = error;
    }
    check(driftFailure?.message.includes("changed during read-only verification"), "performance self-test: final-state fingerprint drift was accepted");
    check(!activeVerificationReadSnapshot, "performance self-test: drifted snapshot remained active");

    activeVerificationReadSnapshot = opening();
    let failure = null;
    try {
      finishVerificationReadSnapshot(() => {
        throw new Error("injected final snapshot capture failure");
      }, () => closingSpaces);
    } catch (error) {
      failure = error;
    }
    check(failure?.message === "injected final snapshot capture failure", "performance self-test: snapshot failure was not preserved");
    check(!activeVerificationReadSnapshot, "performance self-test: failed snapshot remained active");
  } finally {
    activeVerificationReadSnapshot = null;
  }
}

function tryCommand(binary, args, options = {}) {
  try {
    return { ok: true, output: command(binary, args, options), status: 0 };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(error),
      status: Number.isInteger(error.status) ? error.status : 1,
    };
  }
}

function cub(args, options = {}) {
  revalidatePinnedCubContextBeforeMutation(args);
  assertApplyMutationDecisionStillCurrent(args);
  const output = command("cub", [...contextArgs, ...args], options);
  invalidateApplyReadSnapshotForSuccessfulMutation(args);
  return output;
}

function cubTry(args, options = {}) {
  revalidatePinnedCubContextBeforeMutation(args);
  assertApplyMutationDecisionStillCurrent(args);
  const result = tryCommand("cub", [...contextArgs, ...args], options);
  if (result.ok) invalidateApplyReadSnapshotForSuccessfulMutation(args);
  return result;
}

function cubJson(args) {
  return JSON.parse(cub([...args, "-o", "json"]));
}

function unwrapEntity(value, key) {
  return value?.[key] ?? value;
}

function unwrapRows(value, key) {
  const list = value?.[`${key}s`] ?? value?.[key.toLowerCase() + "s"] ?? value;
  check(Array.isArray(list), `cub ${key} list returned an unexpected shape`);
  return list.map((row) => row?.[key] ?? row);
}

function parseCubContext(text) {
  return {
    name: text.match(/^Context Name\s+(\S+)\s*$/mi)?.[1] ?? "",
    organizationExternalID: text.match(/^Organization ID\s+([0-9a-f-]+)\s*$/mi)?.[1] ?? "",
    organizationName: text.match(/^Organization Name\s+(.+?)\s*$/mi)?.[1] ?? "",
    serverURL: text.match(/^Server URL\s+(\S+)\s*$/mi)?.[1]?.replace(/\/$/, "") ?? "",
  };
}

function rawPinnedCub(args, options = {}) {
  return command("cub", [...contextArgs, ...args], options);
}

function assertPinnedKubaraTarget() {
  check(pinnedContextName, "cub context name was not pinned before live access");
  const coordinate = parseCubContext(rawPinnedCub(["context", "get"]));
  check(coordinate.name === pinnedContextName, `cub context name drifted from ${pinnedContextName} to ${coordinate.name || "unknown"}`);
  check(coordinate.organizationName === ORGANIZATION, `refusing cub organization ${coordinate.organizationName || "unknown"}; expected ${ORGANIZATION}`);
  check(
    coordinate.organizationExternalID === ORGANIZATION_EXTERNAL_ID,
    `refusing ConfigHub external organization ID ${coordinate.organizationExternalID || "unknown"}; expected ${ORGANIZATION_EXTERNAL_ID}`,
  );
  check(coordinate.serverURL === CONFIGHUB_SERVER_URL, `refusing ConfigHub server ${coordinate.serverURL || "unknown"}; expected ${CONFIGHUB_SERVER_URL}`);
  const organizations = JSON.parse(rawPinnedCub([
    "organization", "list",
    "--where", `ExternalID = '${ORGANIZATION_EXTERNAL_ID}'`,
    "--select", "DisplayName,ExternalID,OrganizationID",
    "-o", "json",
  ]));
  check(Array.isArray(organizations) && organizations.length === 1, `expected exactly one ${ORGANIZATION} Organization entity`);
  const organization = organizations[0]?.Organization ?? organizations[0];
  check(organization.DisplayName === ORGANIZATION, "ConfigHub Organization display name drifted");
  check(organization.ExternalID === ORGANIZATION_EXTERNAL_ID, "ConfigHub Organization external ID drifted");
  check(organization.OrganizationID === ORGANIZATION_ENTITY_ID, "ConfigHub Organization entity ID drifted");
  const control = tryCommand("cub", [...contextArgs, "space", "get", CONTROL_SPACE, "-o", "json"]);
  if (control.ok) {
    const space = unwrapEntity(JSON.parse(control.output), "Space");
    check(space.OrganizationID === ORGANIZATION_ENTITY_ID, `${CONTROL_SPACE}: organization entity ID drifted`);
  } else {
    check(/\b404\b|not[\s_-]*found/i.test(control.output), `${CONTROL_SPACE}: failed to verify organization ownership: ${control.output}`);
  }
  return coordinate;
}

function mutatingCubCommand(args) {
  const [resource, verb] = args;
  const pair = `${resource}/${verb ?? ""}`;
  check(
    MUTATING_CUB_COMMAND_PAIRS.has(pair) || READ_ONLY_CUB_COMMAND_PAIRS.has(pair),
    `unclassified cub command ${pair}; classify it before live use`,
  );
  return MUTATING_CUB_COMMAND_PAIRS.has(pair);
}

function cubArgumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function mutationSpaceSlug(args) {
  const [resource, verb] = args;
  const explicit = cubArgumentValue(args, "--space");
  if (explicit && explicit !== "*") return explicit;
  if (resource === "release" && verb === "publish") return args[2] ?? "";
  if (resource === "space" && ["create", "update"].includes(verb)) {
    return args.slice(2).find((arg) => !arg.startsWith("-")) ?? "";
  }
  if (resource === "variant" && verb === "promote") return args[2] ?? "";
  if (resource === "variant" && verb === "create") {
    return cubArgumentValue(args, "--space-pattern").replace(/^template:/, "");
  }
  return "";
}

function invalidateApplyReadResource(resource, space = "") {
  if (!activeApplyReadSnapshot) return;
  applyReadResourceEvidence(resource).invalidations += 1;
  if (resource === "space") {
    activeApplyReadSnapshot.spacesValid = false;
    return;
  }
  if (resource === "unit") {
    if (!space) {
      activeApplyReadSnapshot.unitsBySpace.clear();
      activeApplyReadSnapshot.unitsByRef.clear();
    } else {
      activeApplyReadSnapshot.unitsBySpace.delete(space);
      for (const ref of [...activeApplyReadSnapshot.unitsByRef.keys()]) {
        if (ref.startsWith(`${space}/`)) activeApplyReadSnapshot.unitsByRef.delete(ref);
      }
    }
    return;
  }
  if (resource === "release") {
    if (space) activeApplyReadSnapshot.releasesBySpace.delete(space);
    else activeApplyReadSnapshot.releasesBySpace.clear();
    return;
  }
  if (resource === "link") {
    if (space) activeApplyReadSnapshot.linksBySpace.delete(space);
    else activeApplyReadSnapshot.linksBySpace.clear();
    return;
  }
  if (resource === "target") {
    if (space) {
      activeApplyReadSnapshot.targetsBySpace.delete(space);
      activeApplyReadSnapshot.loadedTargetSpaces.delete(space);
    } else {
      activeApplyReadSnapshot.targetsBySpace.clear();
      activeApplyReadSnapshot.loadedTargetSpaces.clear();
    }
  }
}

function applyReadInvalidationScopes(args) {
  const [resource, verb] = args;
  const space = mutationSpaceSlug(args);
  if (resource === "cluster" && verb === "up") {
    return APPLY_READ_RESOURCES.map((tracked) => [tracked, ""]);
  }
  if (["filter", "trigger"].includes(resource)) {
    // Trigger selection is stored on Spaces and may change Unit ApplyGates.
    return [["space", ""], ["unit", ""]];
  }
  if (resource === "space") {
    return [["space", space], ...(verb === "update" ? [["unit", space]] : [])];
  }
  if (resource === "variant") {
    return [["space", space], ["unit", space], ["link", space], ["release", space]];
  }
  if (resource === "unit") {
    return [["unit", space]];
  }
  if (resource === "link") {
    // --make-current can advance the downstream Unit as well as the Link.
    return [["link", space], ["unit", space]];
  }
  if (resource === "release") {
    // Publishing advances LastAppliedRevisionNum on the released Units.
    return [["release", space], ["unit", space]];
  }
  return [];
}

function invalidateApplyReadSnapshotForSuccessfulMutation(args) {
  if (!activeApplyReadSnapshot || !mutatingCubCommand(args)) return;
  // Any successful ConfigHub write ends the dependency-closed reuse batch.
  // A later release decision must establish a fresh authoritative boundary.
  activeAuthoritativeReleaseReuseBatch = null;
  activeApplyReadSnapshot.organizationFingerprint = null;
  const scopes = applyReadInvalidationScopes(args);
  check(scopes.length > 0, `${args[0]}/${args[1]} mutation lacks apply-cache invalidation scopes`);
  for (const [resource, space] of scopes) invalidateApplyReadResource(resource, space);
}

function sameCachedRows(left, right) {
  return stableJson(left) === stableJson(right);
}

function mutationUnitSpace(args) {
  return cubArgumentValue(args, "--space");
}

function mutationUnitSlug(args) {
  const spaceIndex = args.indexOf("--space");
  const slug = spaceIndex >= 0 ? args[spaceIndex + 2] : "";
  return slug && !slug.startsWith("-") ? slug : "";
}

function assertFreshSpaceDecision(prefix) {
  const cached = readSpaces();
  const fresh = fetchSpaces();
  check(
    sameCachedRows(
      snapshotRows([...cached.values()], SPACE_DECISION_FIELDS),
      snapshotRows([...fresh.values()], SPACE_DECISION_FIELDS),
    ),
    `${prefix}: ConfigHub Space state changed after the decision; retry from a fresh apply snapshot`,
  );
  return fresh;
}

function assertFreshUnitDecision(space, prefix) {
  check(space, `${prefix}: Unit dependency Space is missing`);
  const cached = readUnitRows(space).sort((left, right) => left.Slug.localeCompare(right.Slug));
  const fresh = fetchUnitRows(space).sort((left, right) => left.Slug.localeCompare(right.Slug));
  for (const unit of fresh) decodeBulkUnitData(unit, `${space}/${unit.Slug}`);
  check(
    sameCachedRows(
      snapshotRows(cached, UNIT_DECISION_FIELDS),
      snapshotRows(fresh, UNIT_DECISION_FIELDS),
    ),
    `${prefix}: ${space} Units changed after the decision`,
  );
  return fresh;
}

function assertFreshTargetDecision(space, prefix) {
  check(space, `${prefix}: Target dependency Space is missing`);
  const cached = readTarget(space);
  const fresh = fetchTarget(space);
  const canonical = (target) => snapshotRows(target ? [target] : [], TARGET_DECISION_FIELDS);
  check(
    sameCachedRows(canonical(cached), canonical(fresh)),
    `${prefix}: ${space}/target changed after the decision`,
  );
  return fresh;
}

function assertFreshLinkDecision(space, prefix) {
  check(space, `${prefix}: Link dependency Space is missing`);
  const cached = readLinks(space).sort((left, right) => left.Slug.localeCompare(right.Slug));
  const fresh = fetchLinks(space).sort((left, right) => left.Slug.localeCompare(right.Slug));
  check(
    sameCachedRows(
      snapshotRows(cached, LINK_DECISION_FIELDS),
      snapshotRows(fresh, LINK_DECISION_FIELDS),
    ),
    `${prefix}: ${space} Links changed after the decision`,
  );
  return fresh;
}

function currentReleaseDecisionRows(rows) {
  // ConfigHub's organization-wide `--space *` release list intentionally
  // returns only the current published Release per Space, while a point list
  // returns retained history as well. Publication authority depends on the
  // current head; additive older Releases are audited separately through Tags.
  return snapshotRows(
    [...rows].sort((left, right) => Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0)
      || String(right.CreatedAt ?? "").localeCompare(String(left.CreatedAt ?? ""))).slice(0, 1),
    RELEASE_DECISION_FIELDS,
  );
}

function assertFreshReleaseDecision(space, prefix) {
  check(space, `${prefix}: release dependency Space is missing`);
  const cached = readPublishedReleaseRows(space);
  const fresh = fetchPublishedReleases(space);
  check(
    sameCachedRows(currentReleaseDecisionRows(cached), currentReleaseDecisionRows(fresh)),
    `${prefix}: ${space} published releases changed after the decision`,
  );
  return fresh;
}

function unitMutationDependencySpaces(args, sourceSpace, slug) {
  const unit = readUnit(sourceSpace, slug);
  const expected = plan.managedUnits.find((item) => item.space === sourceSpace && item.slug === slug);
  const unitSpaces = new Set();
  const targetSpaces = new Set();
  if (expected?.upstream) unitSpaces.add(expected.upstream.split("/")[0]);
  if (expected?.target) targetSpaces.add(expected.target.split("/")[0]);
  if (unit?.UpstreamUnitID) {
    const upstream = [...activeApplyReadSnapshot.unitsByRef.entries()]
      .find(([, candidate]) => candidate.UnitID === unit.UpstreamUnitID)?.[0];
    check(upstream, `${sourceSpace}/${slug}: cached upstream Unit identity is unresolved`);
    unitSpaces.add(upstream.split("/")[0]);
  }
  if (unit?.TargetID) {
    const targetSpace = [...activeApplyReadSnapshot.targetsBySpace.entries()]
      .find(([, candidate]) => candidate.TargetID === unit.TargetID)?.[0];
    check(targetSpace, `${sourceSpace}/${slug}: cached Target identity is unresolved`);
    targetSpaces.add(targetSpace);
  }
  if (args[0] === "unit" && args[1] === "set-target") {
    const spaceIndex = args.indexOf("--space");
    const targetRef = spaceIndex >= 0 ? args[spaceIndex + 3] : "";
    if (targetRef && targetRef !== "-") targetSpaces.add(targetRef.split("/")[0]);
  }
  return { unitSpaces: [...unitSpaces].sort(), targetSpaces: [...targetSpaces].sort() };
}

function linkMutationDependencies(args, space) {
  const spaceIndex = args.indexOf("--space");
  const slug = args[2]?.startsWith("-") ? args[spaceIndex + 2] : args[2];
  const declared = plan.links.find((item) => item.space === space && item.slug === slug);
  if (declared) return { slug, unitSpaces: [space, declared.toSpace] };
  const variant = plan.managedUnits.find(
    (item) => item.space === space && item.upstream && `upgrade-${item.slug}` === slug,
  );
  check(variant, `${space}/${slug || "unknown"}: Link mutation dependencies are not declared by the plan`);
  return { slug, unitSpaces: [space, variant.upstream.split("/")[0]] };
}

function assertApplyMutationDecisionStillCurrent(args) {
  if (!activeApplyReadSnapshot || !mutatingCubCommand(args)) return;
  const [resource, verb] = args;
  // These decisions are based on point reads or on the dedicated authoritative
  // release bracket, not the long-lived organization cache.
  if (["filter", "trigger"].includes(resource)) return;

  if (resource === "cluster") {
    const openingFingerprint = activeApplyReadSnapshot.organizationFingerprint;
    check(/^sha256:[0-9a-f]{64}$/.test(openingFingerprint ?? ""), "cluster/up: dependency-complete cached decision is unavailable");
    const spaces = fetchSpaces();
    const fresh = captureOrganizationReadSnapshot(spaces);
    check(
      fresh.fingerprint === openingFingerprint,
      "cluster/up: Space, Unit, release, Link, or Target state changed after the bootstrap decision",
    );
    return;
  }

  if (resource === "release") {
    const space = mutationSpaceSlug(args);
    check(
      space
        && activeApplyReadSnapshot.unitsBySpace.has(space)
        && activeApplyReadSnapshot.releasesBySpace.has(space),
      `release/${verb}: authoritative release decision for ${space || "unknown"} is unavailable before write`,
    );
    const prefix = `release/${verb}`;
    assertFreshSpaceDecision(prefix);
    assertFreshUnitDecision(space, prefix);
    assertFreshLinkDecision(space, prefix);
    assertFreshReleaseDecision(space, prefix);
    const expectedUnits = plan.managedUnits.filter((item) => item.space === space);
    for (const upstreamSpace of [...new Set(expectedUnits.map((item) => item.upstream?.split("/")[0]).filter(Boolean))].sort()) {
      assertFreshUnitDecision(upstreamSpace, prefix);
    }
    for (const targetSpace of [...new Set(expectedUnits.map((item) => item.target?.split("/")[0]).filter(Boolean))].sort()) {
      assertFreshTargetDecision(targetSpace, prefix);
    }
    const fleetItem = FLEET.find((item) => `${item.cluster}-argo-apps` === space);
    if (fleetItem) {
      const topologySpaces = ["argobot-base", fleetItem.cluster, space, `argobot-${fleetItem.cluster}`];
      for (const topologySpace of topologySpaces) {
        if (topologySpace !== space) assertFreshUnitDecision(topologySpace, prefix);
        if (topologySpace !== space) assertFreshLinkDecision(topologySpace, prefix);
      }
      assertFreshTargetDecision(fleetItem.cluster, prefix);
    }
    return;
  }

  if (["cluster", "space", "variant"].includes(resource)) {
    check(activeApplyReadSnapshot.spacesValid, `${resource}/${verb}: cached Space decision was invalidated before write`);
    const fresh = fetchSpaces();
    const cachedRows = snapshotRows([...activeApplyReadSnapshot.spaces.values()], SPACE_DECISION_FIELDS);
    const freshRows = snapshotRows([...fresh.values()], SPACE_DECISION_FIELDS);
    check(
      sameCachedRows(cachedRows, freshRows),
      `${resource}/${verb}: ConfigHub Space state changed after the cached decision (${firstStableDifference(cachedRows, freshRows) ?? "unknown difference"}); retry from a fresh apply snapshot`,
    );
  }

  if (resource === "unit") {
    const space = mutationUnitSpace(args);
    check(space && activeApplyReadSnapshot.unitsBySpace.has(space), `${resource}/${verb}: cached Unit decision for ${space || "unknown"} was invalidated before write`);
    const prefix = `${resource}/${verb}`;
    // Unit writes are governed by the exact Unit head/body/gates plus declared
    // upstream and Target identities below. Requiring every mutable field on
    // all 55 Spaces to remain unchanged over-broadens the decision, adds an
    // organization read per write, and makes one successful approval invalidate
    // the next unrelated approval. Context pinning above already proves the
    // organization and control Space before every mutation.
    assertFreshUnitDecision(space, prefix);
    const slug = mutationUnitSlug(args);
    check(slug, `${prefix}: mutation Unit slug is unavailable`);
    const dependencies = unitMutationDependencySpaces(args, space, slug);
    for (const upstreamSpace of dependencies.unitSpaces) assertFreshUnitDecision(upstreamSpace, prefix);
    for (const targetSpace of dependencies.targetSpaces) assertFreshTargetDecision(targetSpace, prefix);
  }

  if (resource === "link") {
    const space = mutationSpaceSlug(args);
    check(space && activeApplyReadSnapshot.linksBySpace.has(space), `${resource}/${verb}: cached Link decision for ${space || "unknown"} was invalidated before write`);
    const prefix = `${resource}/${verb}`;
    assertFreshSpaceDecision(prefix);
    assertFreshLinkDecision(space, prefix);
    const dependencies = linkMutationDependencies(args, space);
    for (const unitSpace of [...new Set(dependencies.unitSpaces)].sort()) {
      assertFreshUnitDecision(unitSpace, prefix);
    }
  }
}

function revalidatePinnedCubContextBeforeMutation(args) {
  if (mutatingCubCommand(args)) {
    withConfigHubReadPurpose("mutation-target-pin", () => assertPinnedKubaraTarget());
  }
}

function assertKubaraOrganization() {
  // A caller-supplied context is already an immutable CLI coordinate. Let the
  // one full pinned-target check below prove its name, organization, external
  // and entity IDs, server, and control Space. Discover the active context only
  // when the caller did not pin one; repeating the same text and JSON context
  // reads adds no independent safety evidence.
  if (!pinnedContextName) {
    const initial = parseCubContext(command("cub", ["context", "get"]));
    check(initial.name, "active cub context name is unavailable");
    pinnedContextName = initial.name;
    contextArgs = ["--context", pinnedContextName];
  }
  assertPinnedKubaraTarget();
  assertCubVersion();
}

function assertCubVersion() {
  if (cachedCubVersions) return cachedCubVersions;
  const output = cub(["version"]);
  const client = output.match(/Client Version:[\s\S]*?Version:\s+v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "";
  const server = output.match(/Server Version:[\s\S]*?Version:\s+v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "";
  check(client && versionAtLeast(client, MIN_CUB_VERSION), `cub client v${client || "unknown"} is older than required v${MIN_CUB_VERSION}`);
  check(server && versionAtLeast(server, MIN_CUB_VERSION), `ConfigHub server v${server || "unknown"} is older than required v${MIN_CUB_VERSION}`);
  cachedCubVersions = { client: `v${client}`, server: `v${server}`, minimum: `v${MIN_CUB_VERSION}` };
  return cachedCubVersions;
}

function versionAtLeast(actual, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(actual) || !/^\d+\.\d+\.\d+$/.test(minimum)) return false;
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function assertSerialLiveLock() {
  // The filesystem lock is the authoritative mutual-exclusion primitive used
  // by all three live lanes. Keep one process scan as defense in depth for an
  // old runner that predates the shared lock, rather than spawning three
  // identical scans. pgrep exit 1 means no match; every other failure is real.
  const processPattern = [
    "scripts/run-kubara-live-qualification\\.mjs",
    "tests/live-helm-confighub-parity-test",
    "scripts/run-kubara-faithful-hub-spoke-proof\\.mjs",
  ].join("|");
  const processes = tryCommand("pgrep", ["-fl", processPattern], { expectedFailure: true });
  check(processes.ok || processes.status === 1, `live proof process scan failed: ${processes.output}`);
  check(!processes.ok || !processes.output.trim(), `refusing to overlap a live Kubara proof (${processPattern}):\n${processes.output}`);
  const leaked = kindClusters().filter((name) => name.startsWith("helm-expt-parity-"));
  check(leaked.length === 0, `refusing to start with live-parity clusters present: ${leaked.join(", ")}`);
}

function acquireSerialLiveLock() {
  const lockPath = process.env.HELM_EXPT_LIVE_PARITY_LOCK
    ? resolve(process.env.HELM_EXPT_LIVE_PARITY_LOCK)
    : join(homedir(), ".confighub", "locks", "helm-expt-live-parity.lock");
  while (true) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: process.argv.join(" "),
      }, null, 2)}\n`);
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = {};
      try {
        owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
      } catch {
        // An incomplete owner file is treated as live; never remove a lock
        // whose ownership cannot be proved stale.
      }
      if (Number.isInteger(owner.pid) && !processAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      check(false, `live parity lane is locked at ${lockPath}${owner.pid ? ` by pid ${owner.pid}` : ""}`);
    }
  }
}

function releaseSerialLiveLock(lockPath) {
  if (!lockPath) return;
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    if (owner.pid === process.pid) rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Never remove a lock whose ownership cannot be proved.
  }
}

function operationJournalHeader() {
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPOperationJournal",
    organizationExternalID: ORGANIZATION_EXTERNAL_ID,
    organizationEntityID: ORGANIZATION_ENTITY_ID,
    serverURL: CONFIGHUB_SERVER_URL,
  };
}

function operationExecutionFingerprint() {
  const payloads = [...inputs.payloads.values()].map((item) => ({
    key: item.key,
    sha256: item.sha256,
  })).sort((left, right) => left.key.localeCompare(right.key));
  const executionContract = {
    reconcilerSha256: `sha256:${sha256File(absolute("scripts/reconcile-kubara-mini-idp.mjs"))}`,
    protectedNamespaceHelperSha256: `sha256:${sha256File(absolute("scripts/lib/kubara-protected-namespace.mjs"))}`,
    kindTraefikHelperSha256: `sha256:${sha256File(absolute("scripts/lib/kubara-kind-traefik.mjs"))}`,
    organization: {
      externalID: ORGANIZATION_EXTERNAL_ID,
      entityID: ORGANIZATION_ENTITY_ID,
      serverURL: CONFIGHUB_SERVER_URL,
    },
    fleet: FLEET.map((item) => ({ cluster: item.cluster, suffix: item.suffix })),
    deploymentOrder: plan.deployments.map((item) => ({
      cluster: item.cluster,
      space: item.space,
      appSpace: item.appSpace,
      appUnit: item.appUnit,
      order: item.order,
      destinationNamespace: item.destinationNamespace,
      protectedNamespaceOwnershipDetachment: item.protectedNamespaceOwnershipDetachment ?? null,
      immutableSelectorReplacements: immutableSelectorMigrationsFor(item),
    })),
    protectedNamespaceOwnershipDetachments: PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS,
    policies: {
      argoPrune: ARGO_PRUNE_POLICY,
      namespaceMove: ARGO_NAMESPACE_MOVE_POLICY,
      immutableSelectorReplacement: IMMUTABLE_SELECTOR_REPLACEMENT_POLICY,
      protectedNamespaceOwnership: PROTECTED_NAMESPACE_OWNERSHIP_POLICY,
      kindTraefik: KIND_TRAEFIK_POLICY,
      retry: ARGO_RETRY_POLICY,
      revision: ARGO_REVISION_POLICY,
      interruptedRelease: INTERRUPTED_RELEASE_POLICY,
      interruptedScenario: INTERRUPTED_SCENARIO_POLICY,
      deliveryRootPublication: DELIVERY_ROOT_PUBLICATION_POLICY,
    },
  };
  return `sha256:${sha256(stableJson({ source: sourceEvidence(), payloads, executionContract }))}`;
}

function operationJournalFingerprintDisposition(journal, fingerprint) {
  if (journal.executionFingerprint === fingerprint) return "current";
  const convergenceInFlight = Object.keys(journal.convergence ?? {}).length > 0;
  const namespaceMoveInFlight = ["prepared", "delete-returned"].includes(journal.namespaceMove?.state);
  const immutableSelectorReplacementInFlight = Object.values(journal.immutableSelectorReplacements ?? {})
    .some((item) => ["prepared", "delete-returned", "old-uid-gone"].includes(item?.state));
  const protectedNamespaceDetachmentInFlight = Object.values(journal.protectedNamespaceDetachments ?? {})
    .some((item) => ["prepared", "patch-returned"].includes(item?.state));
  const scenarioInFlight = journal.scenario?.state === "started";
  const fleetBootstrapInFlight = journal.fleetBootstrap?.state === "started";
  return convergenceInFlight || namespaceMoveInFlight || immutableSelectorReplacementInFlight || protectedNamespaceDetachmentInFlight
    || scenarioInFlight || fleetBootstrapInFlight ? "blocked" : "rotate";
}

function readOperationJournal() {
  if (!existsSync(OPERATION_JOURNAL_PATH)) {
    return {
      ...operationJournalHeader(),
      executionFingerprint: operationExecutionFingerprint(),
      convergence: {},
      namespaceMove: null,
      immutableSelectorReplacements: {},
      protectedNamespaceDetachments: {},
      scenario: null,
      fleetBootstrap: null,
    };
  }
  let journal = null;
  try {
    journal = JSON.parse(readFileSync(OPERATION_JOURNAL_PATH, "utf8"));
  } catch (error) {
    check(false, `operation journal is unreadable at ${OPERATION_JOURNAL_PATH}: ${error.message}`);
  }
  const header = operationJournalHeader();
  for (const [key, value] of Object.entries(header)) {
    check(journal?.[key] === value, `operation journal ${key} drifted at ${OPERATION_JOURNAL_PATH}`);
  }
  check(journal.convergence && typeof journal.convergence === "object" && !Array.isArray(journal.convergence), "operation journal convergence map is invalid");
  if (journal.immutableSelectorReplacements === undefined) journal.immutableSelectorReplacements = {};
  check(
    journal.immutableSelectorReplacements
      && typeof journal.immutableSelectorReplacements === "object"
      && !Array.isArray(journal.immutableSelectorReplacements),
    "operation journal immutable-selector replacement map is invalid",
  );
  if (journal.protectedNamespaceDetachments === undefined) journal.protectedNamespaceDetachments = {};
  check(
    journal.protectedNamespaceDetachments
      && typeof journal.protectedNamespaceDetachments === "object"
      && !Array.isArray(journal.protectedNamespaceDetachments),
    "operation journal protected Namespace detachment map is invalid",
  );
  if (journal.scenario === undefined) journal.scenario = null;
  check(journal.scenario === null || typeof journal.scenario === "object", "operation journal scenario entry is invalid");
  if (journal.fleetBootstrap === undefined) journal.fleetBootstrap = null;
  check(journal.fleetBootstrap === null || typeof journal.fleetBootstrap === "object", "operation journal fleet-bootstrap entry is invalid");
  const fingerprint = operationExecutionFingerprint();
  const disposition = operationJournalFingerprintDisposition(journal, fingerprint);
  check(
    disposition !== "blocked",
    "operation inputs changed while an Argo convergence, namespace move, immutable-selector replacement, protected Namespace ownership detachment, scenario transition, or fleet bootstrap is in flight",
  );
  if (disposition === "rotate") {
    journal.executionFingerprint = fingerprint;
    writeOperationJournal(journal);
  }
  return journal;
}

function writeOperationJournal(journal) {
  mkdirSync(dirname(OPERATION_JOURNAL_PATH), { recursive: true });
  const temp = `${OPERATION_JOURNAL_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, OPERATION_JOURNAL_PATH);
}

function updateOperationJournal(update) {
  const journal = readOperationJournal();
  update(journal);
  writeOperationJournal(journal);
  return journal;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function kindClusters() {
  const result = tryCommand("kind", ["get", "clusters"]);
  check(result.ok, `kind get clusters failed: ${result.output}`);
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function clusterKubeconfig(name) {
  return join(homedir(), ".confighub", "clusters", `${name}.kubeconfig`);
}

function clusterEnv(name) {
  return join(homedir(), ".confighub", "clusters", `${name}.env`);
}

function observeKindTraefikDockerBindings() {
  return KIND_TRAEFIK_CONTRACTS.map((contract) => {
    const node = `${contract.cluster}-control-plane`;
    const result = tryCommand("docker", [
      "inspect", node,
      "--format", "{{json .NetworkSettings.Ports}}",
    ]);
    check(result.ok, `${contract.cluster}: cannot inspect kind control-plane port bindings: ${result.output}`);
    const bindings = JSON.parse(result.output);
    const ports = [
      contract.reservedArgocdServerNodePort,
      contract.httpNodePort,
      contract.httpsNodePort,
    ].map((port) => {
      const rows = bindings[`${port}/tcp`] ?? [];
      check(rows.length > 0, `${contract.cluster}: Docker does not expose required TCP/${port}`);
      const loopbackReachable = rows.find(
        (item) => item.HostPort === String(port) && ["0.0.0.0", "127.0.0.1"].includes(item.HostIp),
      );
      check(loopbackReachable, `${contract.cluster}: Docker TCP/${port} is not mapped to host port ${port}`);
      return {
        containerPort: port,
        hostIP: loopbackReachable.HostIp,
        hostPort: Number(loopbackReachable.HostPort),
      };
    });
    return { cluster: contract.cluster, node, ports };
  });
}

function fetchSpaces() {
  const rows = unwrapRows(cubJson(["space", "list", "--select", SPACE_READ_SELECT]), "Space");
  for (const space of rows) {
    check(space.OrganizationID === ORGANIZATION_ENTITY_ID, `${space.Slug ?? "unknown"}: Space escaped the pinned Kubara Organization`);
  }
  return new Map(rows.map((space) => [space.Slug, space]));
}

function fetchUnitRows(space) {
  return unwrapRows(cubJson([
    "unit", "list", "--space", space,
    "--select", `SpaceID,${UNIT_READ_SELECT}`,
  ]), "Unit");
}

function fetchUnit(space, slug) {
  const result = cubTry([
    "unit", "get", "--space", space, slug,
    "--select", UNIT_READ_SELECT,
    "-o", "json",
  ]);
  if (!result.ok) return null;
  return unwrapEntity(JSON.parse(result.output), "Unit");
}

function readUnitData(space, slug) {
  const unit = readUnit(space, slug);
  check(unit, `${space}/${slug}: Unit is missing before data inspection`);
  return decodeBulkUnitData(unit, `${space}/${slug}`);
}

function decodeBulkUnitData(unit, ref) {
  check(typeof unit?.Data === "string", `${ref}: bulk Unit metadata omitted Data; refusing an unproved body comparison`);
  check(/^[a-f0-9]{64}$/.test(unit.DataHash ?? ""), `${ref}: bulk Unit metadata has an invalid DataHash`);
  const decoded = Buffer.from(unit.Data, "base64");
  check(
    unit.Data.length % 4 === 0 && decoded.toString("base64") === unit.Data,
    `${ref}: bulk Unit metadata contains non-canonical base64 Data`,
  );
  check(sha256(decoded) === unit.DataHash, `${ref}: bulk Unit DataHash does not match decoded Data`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    check(false, `${ref}: bulk Unit decoded Data is not valid UTF-8`);
  }
}

function expectBulkUnitDataFailure(unit, expectedMessage, label) {
  let message = "";
  try {
    decodeBulkUnitData(unit, `performance self-test/${label}`);
  } catch (error) {
    message = error.message;
  }
  check(message.includes(expectedMessage), `performance self-test: ${label} was not rejected`);
}

function fetchTarget(space) {
  const result = cubTry([
    "target", "get", "--space", space, "target",
    "--select", TARGET_READ_SELECT,
    "-o", "json",
  ]);
  return result.ok ? unwrapEntity(JSON.parse(result.output), "Target") : null;
}

function fetchLinks(space) {
  return unwrapRows(cubJson([
    "link", "list", "--space", space,
    "--select", `SpaceID,${LINK_READ_SELECT}`,
  ]), "Link");
}

function fetchPublishedReleases(space) {
  return unwrapRows(cubJson([
    "release", "list", "--space", space,
    "--where", "Published = true",
    "--select", `SpaceID,${RELEASE_READ_SELECT}`,
  ]), "Release").sort((left, right) => Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0)
    || String(right.CreatedAt ?? "").localeCompare(String(left.CreatedAt ?? "")));
}

function applyReadResourceEvidence(resource) {
  const row = activeApplyReadSnapshot?.evidenceByResource.get(resource);
  check(row, `apply read snapshot does not track ${resource}`);
  return row;
}

function applyReadLoader(name, fallback, ...args) {
  const loader = activeApplyReadSnapshot?.loaders?.[name] ?? fallback;
  return loader(...args);
}

function replaceCachedUnitRows(snapshot, space, rows) {
  for (const ref of [...snapshot.unitsByRef.keys()]) {
    if (ref.startsWith(`${space}/`)) snapshot.unitsByRef.delete(ref);
  }
  const sorted = [...rows].sort((left, right) => left.Slug.localeCompare(right.Slug));
  snapshot.unitsBySpace.set(space, sorted);
  for (const unit of sorted) {
    const ref = `${space}/${unit.Slug}`;
    check(!snapshot.unitsByRef.has(ref), `${ref}: apply snapshot returned duplicate Unit slugs`);
    snapshot.unitsByRef.set(ref, unit);
  }
}

function hydrateEmptyApplyReadScopes(snapshot) {
  for (const space of snapshot.spaces.keys()) {
    if (!snapshot.unitsBySpace.has(space)) snapshot.unitsBySpace.set(space, []);
    if (!snapshot.releasesBySpace.has(space)) snapshot.releasesBySpace.set(space, []);
    if (!snapshot.linksBySpace.has(space)) snapshot.linksBySpace.set(space, []);
    snapshot.loadedTargetSpaces.add(space);
  }
}

function installApplyOrganizationSnapshot(snapshot, spaces, captured) {
  snapshot.spaces = new Map(spaces);
  snapshot.spacesValid = true;
  snapshot.unitsBySpace = captured.unitsBySpace;
  snapshot.unitsByRef = captured.unitsByRef;
  snapshot.releasesBySpace = captured.releasesBySpace;
  snapshot.linksBySpace = captured.linksBySpace;
  snapshot.targetsBySpace = captured.targetsBySpace;
  snapshot.targetRows = captured.targetRows;
  snapshot.organizationFingerprint = captured.fingerprint;
  snapshot.loadedTargetSpaces = new Set();
  hydrateEmptyApplyReadScopes(snapshot);
}

function beginAuthoritativeReleaseReuseBatch({ snapshotOnly = false } = {}) {
  check(activeApplyReadSnapshot, "authoritative release-reuse batch requires the apply snapshot");
  check(!activeSourceReleaseBoundarySnapshot, "authoritative release-reuse batch cannot start inside a release boundary");
  check(!activeAuthoritativeReleaseReuseBatch, "authoritative release-reuse batch is already active");
  const openingFingerprint = activeApplyReadSnapshot.organizationFingerprint;
  check(/^sha256:[0-9a-f]{64}$/.test(openingFingerprint ?? ""), "pre-release organization fingerprint is missing");
  activeAuthoritativeReleaseReuseBatch = {
    fingerprint: openingFingerprint,
    spaces: new Map(activeApplyReadSnapshot.spaces),
    unitsBySpace: new Map(activeApplyReadSnapshot.unitsBySpace),
    targetsBySpace: new Map(activeApplyReadSnapshot.targetsBySpace),
    linksBySpace: new Map(activeApplyReadSnapshot.linksBySpace),
    releasesBySpace: new Map(activeApplyReadSnapshot.releasesBySpace),
    streamSpaces: new Set(),
    snapshotOnly,
  };
}

function withAuthoritativeReleaseReuseBatch(space, verify) {
  const batch = activeAuthoritativeReleaseReuseBatch;
  check(batch, `${space}: authoritative release-reuse batch is unavailable`);
  check(!activeSourceReleaseBoundarySnapshot, `${space}: release-reuse batch cannot overlap another release boundary`);
  batch.streamSpaces.add(space);
  let snapshot;
  if (batch.snapshotOnly) {
    check(
      activeApplyReadSnapshot?.organizationFingerprint === batch.fingerprint,
      `${space}: release-reuse organization fingerprint was invalidated`,
    );
    check(batch.unitsBySpace.has(space), `${space}: release-reuse batch omitted the Unit stream`);
    check(batch.releasesBySpace.has(space), `${space}: release-reuse batch omitted the published Release stream`);
    check(batch.linksBySpace.has(space), `${space}: release-reuse batch omitted the Link stream`);
    // The immediately preceding phase boundary captured every Unit body/hash,
    // current published Release, Link, Target, and Space in one dependency-
    // complete organization snapshot. Reuse that immutable no-write view for
    // all release decisions. Any successful ConfigHub mutation destroys this
    // batch; any Argo or ConfigHub side effect still takes its dedicated fresh
    // release boundary; final verification must open and close at this exact
    // organization fingerprint.
    snapshot = batch;
  } else {
    // Changed applies retain the narrower per-stream revalidation until the
    // first successful ConfigHub mutation invalidates the batch.
    const unitsBySpace = new Map(batch.unitsBySpace);
    const releasesBySpace = new Map(batch.releasesBySpace);
    const streamUnits = fetchUnitRows(space);
    for (const unit of streamUnits) decodeBulkUnitData(unit, `${space}/${unit.Slug}`);
    unitsBySpace.set(space, streamUnits);
    releasesBySpace.set(space, fetchPublishedReleases(space));
    snapshot = { ...batch, unitsBySpace, releasesBySpace };
  }
  activeSourceReleaseBoundarySnapshot = snapshot;
  try {
    return verify();
  } finally {
    if (activeSourceReleaseBoundarySnapshot === snapshot) activeSourceReleaseBoundarySnapshot = null;
  }
}

function assertExactManagedTargetInventory(snapshot, prefix = "ConfigHub Target inventory") {
  const expected = FLEET.map((item) => `${item.cluster}/target`).sort();
  const spaceByID = new Map([...snapshot.spaces.values()].map((space) => [space.SpaceID, space.Slug]));
  const actual = (snapshot.targetRows ?? []).map((target) => {
    const space = spaceByID.get(target.SpaceID);
    check(space, `${prefix}: Target ${target.TargetID ?? "unknown"} references an unknown Space`);
    return `${space}/${target.Slug}`;
  }).sort();
  check(
    stableJson(actual) === stableJson(expected),
    `${prefix}: expected exactly ${expected.join(", ")}, got ${actual.join(", ")}`,
  );
}

function beginApplyReadSnapshot() {
  check(!activeApplyReadSnapshot, "apply read snapshot is already active");
  check(!activeVerificationReadSnapshot, "apply read snapshot cannot overlap live verification");
  check(!activeSourceReleaseBoundarySnapshot, "apply read snapshot cannot start inside a release boundary");
  const spaces = fetchSpaces();
  const captured = captureOrganizationReadSnapshot(spaces);
  const resources = APPLY_READ_RESOURCES.map((resource) => ({
    resource,
    initialListCalls: 1,
    phaseRefreshListCalls: 0,
    mutationRefreshCalls: 0,
    invalidations: 0,
    servedReads: 0,
  }));
  const snapshot = {
    evidenceByResource: new Map(resources.map((item) => [item.resource, item])),
    evidence: {
      mode: "phase-scoped-mutation-aware-organization-wide",
      consistency: APPLY_READ_CONSISTENCY,
      phaseBoundaries: ["apply-start"],
      resources,
    },
  };
  installApplyOrganizationSnapshot(snapshot, spaces, captured);
  activeApplyReadSnapshot = snapshot;
  return snapshot;
}

function refreshApplyReadSnapshotAtPhaseBoundary(name) {
  check(activeApplyReadSnapshot, `${name}: apply read snapshot is not active`);
  check(!activeVerificationReadSnapshot, `${name}: apply read snapshot cannot refresh during live verification`);
  check(!activeSourceReleaseBoundarySnapshot, `${name}: apply read snapshot cannot refresh inside a release boundary`);
  const spaces = fetchSpaces();
  const captured = captureOrganizationReadSnapshot(spaces);
  installApplyOrganizationSnapshot(activeApplyReadSnapshot, spaces, captured);
  activeApplyReadSnapshot.evidence.phaseBoundaries.push(name);
  for (const resource of APPLY_READ_RESOURCES) {
    applyReadResourceEvidence(resource).phaseRefreshListCalls += 1;
  }
}

function currentApplyReadEvidence() {
  if (!activeApplyReadSnapshot) return null;
  return JSON.parse(stableJson(activeApplyReadSnapshot.evidence));
}

function finishApplyReadSnapshot() {
  check(activeApplyReadSnapshot, "apply read snapshot is not active");
  if (activeAuthoritativeReleaseReuseBatch?.snapshotOnly) {
    const streams = [...activeAuthoritativeReleaseReuseBatch.streamSpaces].sort();
    check(streams.length > 0, "authoritative release-reuse batch did not serve a release stream");
    activeApplyReadSnapshot.evidence.authoritativeReleaseReuse = {
      mode: "single-dependency-complete-organization-snapshot",
      fingerprint: activeAuthoritativeReleaseReuseBatch.fingerprint,
      streams,
      finalVerification: "opening-and-closing-fingerprint-required",
    };
  }
  const evidence = currentApplyReadEvidence();
  activeApplyReadSnapshot = null;
  activeAuthoritativeReleaseReuseBatch = null;
  assertApplyReadCacheEvidence(evidence, "completed apply read cache evidence");
  return evidence;
}

function readSpaces() {
  if (activeVerificationReadSnapshot) {
    const evidence = activeVerificationReadSnapshot.evidenceByResource.get("space");
    check(evidence, "verification snapshot does not track Space reads");
    evidence.servedReads += 1;
    return new Map(activeVerificationReadSnapshot.spaces);
  }
  if (activeSourceReleaseBoundarySnapshot) {
    return new Map(activeSourceReleaseBoundarySnapshot.spaces);
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("space");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.spacesValid) {
      activeApplyReadSnapshot.spaces = applyReadLoader("spaces", fetchSpaces);
      activeApplyReadSnapshot.spacesValid = true;
      evidence.mutationRefreshCalls += 1;
    }
    return new Map(activeApplyReadSnapshot.spaces);
  }
  return fetchSpaces();
}

function readUnitRows(space) {
  if (activeVerificationReadSnapshot) {
    activeVerificationReadSnapshot.evidenceByResource.get("unit").servedReads += 1;
    return [...(activeVerificationReadSnapshot.unitsBySpace.get(space) ?? [])];
  }
  if (activeSourceReleaseBoundarySnapshot) {
    check(
      activeSourceReleaseBoundarySnapshot.unitsBySpace.has(space),
      `${space}: source release boundary did not preload Unit inventory`,
    );
    return [...activeSourceReleaseBoundarySnapshot.unitsBySpace.get(space)];
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("unit");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.unitsBySpace.has(space)) {
      replaceCachedUnitRows(activeApplyReadSnapshot, space, applyReadLoader("units", fetchUnitRows, space));
      evidence.mutationRefreshCalls += 1;
    }
    return [...activeApplyReadSnapshot.unitsBySpace.get(space)];
  }
  return fetchUnitRows(space);
}

function readUnit(space, slug) {
  if (activeVerificationReadSnapshot) {
    activeVerificationReadSnapshot.evidenceByResource.get("unit").servedReads += 1;
    return activeVerificationReadSnapshot.unitsByRef.get(`${space}/${slug}`) ?? null;
  }
  if (activeSourceReleaseBoundarySnapshot) {
    check(
      activeSourceReleaseBoundarySnapshot.unitsBySpace.has(space),
      `${space}: source release boundary did not preload Unit inventory`,
    );
    return activeSourceReleaseBoundarySnapshot.unitsBySpace.get(space)
      .find((unit) => unit.Slug === slug) ?? null;
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("unit");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.unitsBySpace.has(space)) {
      replaceCachedUnitRows(activeApplyReadSnapshot, space, applyReadLoader("units", fetchUnitRows, space));
      evidence.mutationRefreshCalls += 1;
    }
    return activeApplyReadSnapshot.unitsByRef.get(`${space}/${slug}`) ?? null;
  }
  return fetchUnit(space, slug);
}

function readTarget(space) {
  if (activeVerificationReadSnapshot) {
    activeVerificationReadSnapshot.evidenceByResource.get("target").servedReads += 1;
    return activeVerificationReadSnapshot.targetsBySpace.get(space) ?? null;
  }
  if (activeSourceReleaseBoundarySnapshot) {
    check(
      activeSourceReleaseBoundarySnapshot.targetsBySpace.has(space),
      `${space}: source release boundary did not preload target`,
    );
    return activeSourceReleaseBoundarySnapshot.targetsBySpace.get(space);
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("target");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.loadedTargetSpaces.has(space)) {
      const target = applyReadLoader("target", fetchTarget, space);
      if (target) activeApplyReadSnapshot.targetsBySpace.set(space, target);
      else activeApplyReadSnapshot.targetsBySpace.delete(space);
      activeApplyReadSnapshot.loadedTargetSpaces.add(space);
      evidence.mutationRefreshCalls += 1;
    }
    return activeApplyReadSnapshot.targetsBySpace.get(space) ?? null;
  }
  return fetchTarget(space);
}

function readLinks(space) {
  if (activeVerificationReadSnapshot) {
    activeVerificationReadSnapshot.evidenceByResource.get("link").servedReads += 1;
    return [...(activeVerificationReadSnapshot.linksBySpace.get(space) ?? [])];
  }
  if (activeSourceReleaseBoundarySnapshot) {
    check(
      activeSourceReleaseBoundarySnapshot.linksBySpace.has(space),
      `${space}: source release boundary did not preload Links`,
    );
    return [...activeSourceReleaseBoundarySnapshot.linksBySpace.get(space)];
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("link");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.linksBySpace.has(space)) {
      activeApplyReadSnapshot.linksBySpace.set(space, applyReadLoader("links", fetchLinks, space));
      evidence.mutationRefreshCalls += 1;
    }
    return [...activeApplyReadSnapshot.linksBySpace.get(space)];
  }
  return fetchLinks(space);
}

function withAuthoritativeReleaseBoundarySnapshot(
  boundary,
  { unitSpaces, targetSpaces, linkSpaces, releaseSpaces = [boundary], organizationWide = false },
  verify,
) {
  check(!activeVerificationReadSnapshot, `${boundary}: release boundary cannot overlap live verification`);
  check(!activeSourceReleaseBoundarySnapshot, `${boundary}: release boundary snapshot is already active`);
  // A publication decision is a safety boundary, not an apply-cache phase.
  // Read it directly so an out-of-process mutation can never be hidden by the
  // performance cache. The closing boundary and final verifier do the same.
  const spaces = fetchSpaces();
  let unitsBySpace;
  let targetsBySpace;
  let linksBySpace;
  let releasesBySpace;
  if (organizationWide) {
    const captured = captureOrganizationReadSnapshot(spaces);
    unitsBySpace = captured.unitsBySpace;
    targetsBySpace = captured.targetsBySpace;
    linksBySpace = captured.linksBySpace;
    releasesBySpace = captured.releasesBySpace;
    for (const space of spaces.keys()) {
      if (!unitsBySpace.has(space)) unitsBySpace.set(space, []);
      if (!linksBySpace.has(space)) linksBySpace.set(space, []);
    }
  } else {
    unitsBySpace = new Map([...new Set(unitSpaces)].sort()
      .map((space) => [space, fetchUnitRows(space)]));
    targetsBySpace = new Map([...new Set(targetSpaces)].sort()
      .map((space) => [space, fetchTarget(space)]));
    linksBySpace = new Map([...new Set(linkSpaces)].sort()
      .map((space) => [space, fetchLinks(space)]));
    releasesBySpace = new Map([...new Set(releaseSpaces)].sort()
      .map((space) => [space, fetchPublishedReleases(space)]));
  }
  const snapshot = { spaces, unitsBySpace, targetsBySpace, linksBySpace, releasesBySpace };
  activeSourceReleaseBoundarySnapshot = snapshot;
  let verified = false;
  try {
    const result = verify();
    verified = true;
    return result;
  } finally {
    if (activeSourceReleaseBoundarySnapshot === snapshot) activeSourceReleaseBoundarySnapshot = null;
    if (verified && activeApplyReadSnapshot) {
      activeApplyReadSnapshot.spaces = new Map(snapshot.spaces);
      activeApplyReadSnapshot.spacesValid = true;
      for (const [space, rows] of snapshot.unitsBySpace) replaceCachedUnitRows(activeApplyReadSnapshot, space, rows);
      for (const [space, rows] of snapshot.linksBySpace) activeApplyReadSnapshot.linksBySpace.set(space, [...rows]);
      for (const [space, rows] of snapshot.releasesBySpace) activeApplyReadSnapshot.releasesBySpace.set(space, [...rows]);
      for (const space of targetSpaces) {
        const target = snapshot.targetsBySpace.get(space);
        if (target) activeApplyReadSnapshot.targetsBySpace.set(space, target);
        else activeApplyReadSnapshot.targetsBySpace.delete(space);
        activeApplyReadSnapshot.loadedTargetSpaces.add(space);
      }
    }
  }
}

function withSourceReleaseBoundarySnapshot(space, expectedUnits, verify) {
  const upstreamSpaces = [...new Set(expectedUnits
    .map((unit) => unit.upstream?.split("/")[0])
    .filter(Boolean))]
    .sort();
  const targetSpaces = [...new Set(expectedUnits
    .map((unit) => unit.target?.split("/")[0])
    .filter(Boolean))]
    .sort();
  return withAuthoritativeReleaseBoundarySnapshot(space, {
    unitSpaces: [space, ...upstreamSpaces],
    targetSpaces,
    linkSpaces: [space],
  }, verify);
}

function withDeliveryRootReleaseBoundarySnapshot(fleetItem, verify) {
  const appSpace = `${fleetItem.cluster}-argo-apps`;
  const argobotSpace = `argobot-${fleetItem.cluster}`;
  const topologySpaces = ["argobot-base", fleetItem.cluster, appSpace, argobotSpace];
  return withAuthoritativeReleaseBoundarySnapshot(appSpace, {
    unitSpaces: topologySpaces,
    targetSpaces: [fleetItem.cluster],
    linkSpaces: topologySpaces,
    organizationWide: true,
  }, verify);
}

function beginVerificationReadSnapshot(spaces) {
  check(!activeVerificationReadSnapshot, "verification read snapshot is already active");
  check(!activeApplyReadSnapshot, "final verification cannot begin while the mutation-aware apply cache is active");
  check(!activeSourceReleaseBoundarySnapshot, "final verification cannot begin inside a release boundary");
  const captured = captureOrganizationReadSnapshot(spaces);
  const resources = FINAL_CONFIGHUB_FINGERPRINT_RESOURCES.map((resource) => ({
    resource,
    rows: captured.rowCounts[resource],
    listCalls: captured.listCalls[resource],
    servedReads: 0,
  }));
  activeVerificationReadSnapshot = {
    ...captured,
    evidenceByResource: new Map(resources.map((item) => [item.resource, item])),
    evidence: {
      mode: "bracketed-organization-wide-read-only",
      stability: "pending-final-snapshot",
      fingerprintResources: [...FINAL_CONFIGHUB_FINGERPRINT_RESOURCES],
      resources,
    },
  };
  return activeVerificationReadSnapshot;
}

function assertAuthoritativeReleaseReuseFinalOpening(applyReadEvidence, openingSnapshot) {
  const releaseReuse = applyReadEvidence?.authoritativeReleaseReuse;
  if (!releaseReuse) return;
  check(
    openingSnapshot?.fingerprint === releaseReuse.fingerprint,
    "ConfigHub Space, Unit, release, Link, or Target state changed after the dependency-complete pre-release snapshot",
  );
}

function finishVerificationReadSnapshot(
  capture = captureOrganizationReadSnapshot,
  readClosingSpaces = fetchSpaces,
  desiredForAllowlist = null,
) {
  check(activeVerificationReadSnapshot, "verification read snapshot is not active");
  const opening = activeVerificationReadSnapshot;
  try {
    const closingSpaces = readClosingSpaces();
    if (desiredForAllowlist) assertSpaceAllowlist(closingSpaces, desiredForAllowlist, { requireAll: true });
    const final = capture(closingSpaces);
    for (const resource of opening.evidence.resources) {
      resource.listCalls += final.listCalls[resource.resource];
      check(
        resource.rows === final.rowCounts[resource.resource],
        `${resource.resource} organization-wide snapshot row count changed during verification`,
      );
    }
    const stable = opening.fingerprint === final.fingerprint;
    opening.evidence.stability = stable ? "pass" : "changed-during-verification";
    check(stable, "Space, Unit, release, Link, or target state changed during read-only verification; retry against a quiescent organization");
    opening.evidence.canonicalFingerprint = opening.fingerprint;
    return opening.evidence;
  } finally {
    if (activeVerificationReadSnapshot === opening) activeVerificationReadSnapshot = null;
  }
}

function captureOrganizationReadSnapshot(spaces) {
  const slugBySpaceID = new Map([...spaces.values()].map((space) => [space.SpaceID, space.Slug]));
  const unitCapture = measuredOrganizationList("unit", () => unwrapRows(cubJson([
    "unit", "list", "--space", "*",
    "--select", UNIT_READ_SELECT,
  ]), "Unit"));
  const releaseCapture = measuredOrganizationList("release", () => unwrapRows(cubJson([
    "release", "list", "--space", "*",
    "--where", "Published = true",
    "--select", `SpaceID,${RELEASE_READ_SELECT}`,
  ]), "Release"));
  const linkCapture = measuredOrganizationList("link", () => unwrapRows(cubJson([
    "link", "list", "--space", "*",
    "--select", `SpaceID,${LINK_READ_SELECT}`,
  ]), "Link"));
  const targetCapture = measuredOrganizationList("target", () => unwrapRows(cubJson([
    "target", "list", "--space", "*",
    "--select", TARGET_READ_SELECT,
  ]), "Target"));
  const units = unitCapture.rows;
  const releases = releaseCapture.rows;
  const links = linkCapture.rows;
  const targets = targetCapture.rows;

  const unitsBySpace = groupRowsBySpace(units, slugBySpaceID, "Unit");
  const unitsByRef = new Map();
  for (const [space, rows] of unitsBySpace) {
    rows.sort((left, right) => left.Slug.localeCompare(right.Slug));
    for (const unit of rows) {
      const ref = `${space}/${unit.Slug}`;
      check(!unitsByRef.has(ref), `${ref}: organization snapshot returned duplicate Unit slugs`);
      // Bulk Data is part of every authoritative snapshot. Decode and hash it
      // at ingress so malformed, truncated, or mismatched bodies can never be
      // cached as trusted evidence merely because a later path did not read it.
      decodeBulkUnitData(unit, ref);
      unitsByRef.set(ref, unit);
    }
  }
  const releasesBySpace = groupRowsBySpace(releases, slugBySpaceID, "Release");
  for (const rows of releasesBySpace.values()) {
    rows.sort((left, right) => Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0)
      || String(right.CreatedAt ?? "").localeCompare(String(left.CreatedAt ?? "")));
  }
  const linksBySpace = groupRowsBySpace(links, slugBySpaceID, "Link");
  for (const rows of linksBySpace.values()) rows.sort((left, right) => left.Slug.localeCompare(right.Slug));
  const targetsBySpace = new Map();
  const targetRefs = new Set();
  for (const target of targets) {
    assertSnapshotRow(target, slugBySpaceID, "Target");
    const targetSpace = slugBySpaceID.get(target.SpaceID);
    const targetRef = `${targetSpace}/${target.Slug}`;
    check(!targetRefs.has(targetRef), `${targetRef}: organization snapshot returned a duplicate Target`);
    targetRefs.add(targetRef);
    if (target.Slug !== "target") continue;
    check(!targetsBySpace.has(targetSpace), `${targetSpace}: organization snapshot returned duplicate target slugs`);
    targetsBySpace.set(targetSpace, target);
  }
  const canonicalRows = {
    space: snapshotRows([...spaces.values()], ["OrganizationID", "SpaceID", "Slug", "Labels", "Annotations", "ReleaseTargetID", "TriggerFilterID", "TriggerIDs", "WhereTrigger", "DeleteGates"]),
    unit: snapshotRows(units, ["SpaceID", "UnitID", "Slug", "Labels", "Annotations", "TargetID", "UpstreamUnitID", "DeleteGates", "DestroyGates", "ToolchainType", "ProviderType", "Data", "DataHash", "ContentHash", "HeadRevisionNum", "LastAppliedRevisionNum", "ApprovedBy", "ApplyGates"]),
    release: snapshotRows(releases, ["SpaceID", "ReleaseID", "TagID", "Digest", "ManifestDigest", "ReleaseNum", "UnitCount", "CreatedAt"]),
    link: snapshotRows(links, ["SpaceID", "LinkID", "Slug", "FromUnitID", "ToUnitID", "ToSpaceID", "UpdateType", "AutoUpdate", "UpstreamLastMergedRevisionNum", "DownstreamLastMergedRevisionNum", "Labels", "Annotations"]),
    target: snapshotRows(targets, ["SpaceID", "TargetID", "Slug", "ProviderType", "ToolchainType", "Annotations"]),
  };
  return {
    spaces: new Map(spaces),
    unitsBySpace,
    unitsByRef,
    releasesBySpace,
    linksBySpace,
    targetsBySpace,
    targetRows: targets,
    rowCounts: {
      space: spaces.size,
      unit: units.length,
      release: releases.length,
      link: links.length,
      target: targets.length,
    },
    listCalls: {
      space: 1,
      unit: unitCapture.listCalls,
      release: releaseCapture.listCalls,
      link: linkCapture.listCalls,
      target: targetCapture.listCalls,
    },
    fingerprint: `sha256:${sha256(stableJson(canonicalRows))}`,
  };
}

function measuredOrganizationList(resource, read) {
  const verb = `cub.${resource}.list`;
  const before = commandPerformance.get(verb)?.calls ?? 0;
  const rows = read();
  const after = commandPerformance.get(verb)?.calls ?? 0;
  check(after - before === 1, `${resource}: organization snapshot did not issue exactly one measured list command`);
  return { rows, listCalls: after - before };
}

function groupRowsBySpace(rows, slugBySpaceID, resource) {
  const grouped = new Map();
  for (const row of rows) {
    assertSnapshotRow(row, slugBySpaceID, resource);
    const space = slugBySpaceID.get(row.SpaceID);
    if (!grouped.has(space)) grouped.set(space, []);
    grouped.get(space).push(row);
  }
  return grouped;
}

function assertSnapshotRow(row, slugBySpaceID, resource) {
  check(row.OrganizationID === ORGANIZATION_ENTITY_ID, `${resource} organization-wide snapshot escaped the pinned Kubara organization`);
  check(slugBySpaceID.has(row.SpaceID), `${resource} organization-wide snapshot references an unknown Space ID`);
}

function snapshotRows(rows, fields) {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function expectedArgoApplicationSlugs(desired, fleetItem) {
  return [
    "root",
    `argobot-${fleetItem.cluster}`,
    ...desired.deployments
      .filter((deployment) => deployment.cluster === fleetItem.cluster)
      .map((deployment) => deployment.appUnit),
  ].sort();
}

function plannedDeliveryApplicationIdentity(desired) {
  return FLEET.flatMap((fleetItem) => expectedArgoApplicationSlugs(desired, fleetItem).map((slug) => ({
    ref: `${fleetItem.cluster}-argo-apps/${slug}`,
    labels: expectedArgoApplicationLabels(desired, fleetItem, slug),
  })));
}

function expectedArgoApplicationLabels(desired, fleetItem, unitSlug) {
  const appsSpace = `${fleetItem.cluster}-argo-apps`;
  if (unitSlug === "root") {
    return managedUnitLabels({
      role: "DeliveryApplication",
      component: "argo-cd",
      kubaraComponent: null,
      catalogComponent: "argo-cd",
      componentVersion: ARGO_CD_RUNTIME_VERSION,
      catalog: "ConfigHubBootstrap",
      variant: fleetItem.suffix,
      fleetItem,
      extra: {
        ComponentSurface: "argocd-delivery",
        ApplicationKind: "ClusterRoot",
        SourceSpace: appsSpace,
        InstanceOf: ARGO_CD_RUNTIME_UNIT,
        DefinitionSpace: ARGO_CD_RUNTIME_SPACE,
        RuntimeVersion: ARGO_CD_RUNTIME_VERSION,
        RuntimeImage: ARGO_CD_RUNTIME_IMAGE,
      },
    });
  }
  if (unitSlug === `argobot-${fleetItem.cluster}`) {
    return managedUnitLabels({
      role: "DeliveryApplication",
      component: "argobot",
      componentVersion: ARGOBOT_VERSION,
      catalog: "ConfigHubDelivery",
      variant: fleetItem.suffix,
      fleetItem,
      extra: {
        ComponentSurface: "argobot",
        ApplicationKind: "Argobot",
        SourceSpace: `argobot-${fleetItem.cluster}`,
        InstanceOf: "argobot",
        DefinitionSpace: "argobot-base",
      },
    });
  }
  const deployment = desired.deployments.find(
    (item) => item.cluster === fleetItem.cluster && item.appUnit === unitSlug,
  );
  check(deployment, `${appsSpace}/${unitSlug}: no planned deployment owns this Argo Application Unit`);
  const sourceSpace = desired.spaces.find((item) => item.slug === deployment.space);
  check(sourceSpace, `${appsSpace}/${unitSlug}: source Space ${deployment.space} is missing from the plan`);
  return managedUnitLabels({
    role: "DeliveryApplication",
    component: sourceSpace.labels.Component,
    kubaraComponent: sourceSpace.labels.KubaraComponent ?? sourceSpace.labels.Component,
    catalogComponent: sourceSpace.labels.CatalogComponent ?? sourceSpace.labels.KubaraComponent ?? sourceSpace.labels.Component,
    componentVersion: sourceSpace.labels.ComponentVersion ?? KUBARA_VERSION,
    catalog: sourceSpace.labels.Catalog ?? "ConfigHubDelivery",
    variant: sourceSpace.labels.Variant ?? fleetItem.suffix,
    fleetItem,
    extra: {
      ...(sourceSpace.labels.ComponentSurface ? {
        ComponentSurface: sourceSpace.labels.ComponentSurface,
      } : {}),
      ApplicationKind: deployment.type === "platform" ? "PlatformComponent" : "Application",
      SourceSpace: deployment.space,
      InstanceOf: sourceSpace.labels.InstanceOf ?? sourceSpace.labels.Component,
      DefinitionSpace: sourceSpace.labels.DefinitionSpace ?? sourceSpace.upstreamSpace,
      ...(sourceSpace.upstreamSpace ? { PromotionUpstreamSpace: sourceSpace.upstreamSpace } : {}),
      ...(sourceSpace.labels.BundledCatalogComponent ? {
        BundledCatalogComponent: sourceSpace.labels.BundledCatalogComponent,
        BundledComponentVersion: sourceSpace.labels.BundledComponentVersion,
      } : {}),
    },
  });
}

function assertArgobotRefreshOnlyDeployment(deployment, context) {
  check(
    deployment?.kind === "Deployment"
      && deployment?.metadata?.name === "argobot"
      && deployment?.metadata?.namespace === "argobot",
    `${context}: expected the exact argobot Deployment in namespace argobot`,
  );
  const podSpec = deployment.spec?.template?.spec ?? {};
  const containers = podSpec.containers ?? [];
  check(
    containers.length === 1 && (podSpec.initContainers ?? []).length === 0,
    `${context}: reviewed refresh-only runtime permits one argobot container and no init containers`,
  );
  const matchingContainers = containers
    .filter((container) => container?.name === "argobot");
  check(matchingContainers.length === 1, `${context}: expected exactly one argobot container`);
  const container = matchingContainers[0];
  check(container.image === ARGOBOT_IMAGE, `${context}: expected exact image ${ARGOBOT_IMAGE}`);
  check(
    !container.command?.length && !container.args?.length,
    `${context}: argobot command or arguments override the reviewed image entrypoint`,
  );
  const env = container.env ?? [];
  const envNames = env.map((item) => item?.name).filter(Boolean);
  check(
    new Set(envNames).size === envNames.length,
    `${context}: duplicate argobot environment variables make runtime mode ambiguous`,
  );
  const syncMode = env.filter((item) => item?.name === "ARGO_SYNC_MODE");
  check(
    syncMode.length === 1
      && syncMode[0].value === "kubernetes"
      && !syncMode[0].valueFrom,
    `${context}: ARGO_SYNC_MODE must be the literal kubernetes refresh-only mode`,
  );
  for (const [name, value] of [
    ["ARGO_NAMESPACE", "argocd"],
    ["ARGO_REFRESH_TYPE", "hard"],
  ]) {
    const matches = env.filter((item) => item?.name === name);
    check(
      matches.length === 1 && matches[0].value === value && !matches[0].valueFrom,
      `${context}: ${name} must be the literal reviewed value ${value}`,
    );
  }
  const restAuthority = envNames.filter((name) => [
    "ARGOCD_SERVER",
    "ARGOCD_AUTH_TOKEN",
    "ARGO_APP_NAMESPACE",
    "ARGO_PRUNE",
    "ARGO_FORCE",
  ].includes(name));
  check(
    restAuthority.length === 0,
    `${context}: Argo CD REST-sync authority is configured: ${restAuthority.join(", ")}`,
  );
  return {
    image: container.image,
    syncMode: syncMode[0].value,
    applicationNamespace: env.find((item) => item?.name === "ARGO_NAMESPACE")?.value ?? null,
    refreshType: env.find((item) => item?.name === "ARGO_REFRESH_TYPE")?.value ?? null,
    restSyncEnvironmentAbsent: true,
    commandOverrideAbsent: true,
    oneContainerNoInit: true,
    duplicateEnvironmentAbsent: true,
  };
}

function assertDeliveryTopology(
  spaces,
  desired,
  {
    requireAllApplications = false,
    requireApplicationMetadata = false,
    allowLegacyBootstrapAutomated = false,
    fleet = FLEET,
  } = {},
) {
  const argobotBaseRows = readUnitRows("argobot-base");
  check(
    stableJson(argobotBaseRows.map((unit) => unit.Slug).sort()) === stableJson(["argobot"]),
    `argobot-base: unsafe Unit inventory; expected only argobot, got ${argobotBaseRows.map((unit) => unit.Slug).sort().join(", ")}`,
  );
  const argobotBase = argobotBaseRows[0];
  check(argobotBase.ToolchainType === "Kubernetes/YAML", "argobot-base/argobot: toolchain drifted");
  check(!argobotBase.ProviderType, "argobot-base/argobot: provider must remain the default");
  check(!argobotBase.TargetID && !argobotBase.UpstreamUnitID, "argobot-base/argobot: base delivery Unit unexpectedly has a target or upstream");
  check(readLinks("argobot-base").length === 0, "argobot-base: unexpected Links present");
  let argobotSources = null;
  try {
    argobotSources = JSON.parse(spaces.get("argobot-base")?.Annotations?.["confighub.com/external-source"] ?? "null");
  } catch {
    check(false, "argobot-base: external-source annotation is not valid JSON");
  }
  check(
    Array.isArray(argobotSources)
      && argobotSources.length === 1
      && argobotSources[0]?.ref === ARGOBOT_SOURCE_REF
      && argobotSources[0]?.digest === ARGOBOT_SOURCE_DIGEST,
    "argobot-base: source OCI ref/digest differs from the exact reviewed delivery helper",
  );
  const argobotDeployment = parseDocs(readUnitData("argobot-base", "argobot"))
    .find((doc) => doc.kind === "Deployment" && doc.metadata?.name === "argobot");
  assertArgobotRefreshOnlyDeployment(argobotDeployment, "argobot-base/argobot");

  for (const fleetItem of fleet) {
    const clusterSpace = spaces.get(fleetItem.cluster);
    const appsSpaceSlug = `${fleetItem.cluster}-argo-apps`;
    const appsSpace = spaces.get(appsSpaceSlug);
    const argobotSpaceSlug = `argobot-${fleetItem.cluster}`;
    const argobotSpace = spaces.get(argobotSpaceSlug);
    check(clusterSpace && appsSpace && argobotSpace, `${fleetItem.cluster}: cluster delivery Spaces are incomplete`);

    const targetEntity = readTarget(fleetItem.cluster);
    check(targetEntity?.TargetID, `${fleetItem.cluster}/target: target is missing`);
    check(targetEntity.SpaceID === clusterSpace.SpaceID, `${fleetItem.cluster}/target: target belongs to a different Space`);
    check(targetEntity.ProviderType === "OCI", `${fleetItem.cluster}/target: expected OCI provider, got ${targetEntity.ProviderType ?? "missing"}`);
    check(targetEntity.ToolchainType === "Any", `${fleetItem.cluster}/target: expected Any toolchain, got ${targetEntity.ToolchainType ?? "missing"}`);
    check(
      targetEntity.Annotations?.["confighub.com/argo-apps-space"] === appsSpaceSlug,
      `${fleetItem.cluster}/target: Argo apps annotation does not name ${appsSpaceSlug}`,
    );
    check(appsSpace.ReleaseTargetID === targetEntity.TargetID, `${appsSpaceSlug}: release target is not ${fleetItem.cluster}/target`);
    check(argobotSpace.ReleaseTargetID === targetEntity.TargetID, `${argobotSpaceSlug}: release target is not ${fleetItem.cluster}/target`);

    const clusterUnits = readUnitRows(fleetItem.cluster);
    check(clusterUnits.length === 0, `${fleetItem.cluster}: cluster target Space must remain a pure namespace with no Units`);
    check(readLinks(fleetItem.cluster).length === 0, `${fleetItem.cluster}: cluster target Space must remain a pure namespace with no Links`);

    const allowedApps = expectedArgoApplicationSlugs(desired, fleetItem);
    const requiredApps = requireAllApplications
      ? allowedApps
      : ["root", `argobot-${fleetItem.cluster}`].sort();
    const appRows = readUnitRows(appsSpaceSlug);
    const actualApps = appRows.map((unit) => unit.Slug).sort();
    const unexpectedApps = actualApps.filter((slug) => !allowedApps.includes(slug));
    const missingApps = requiredApps.filter((slug) => !actualApps.includes(slug));
    check(unexpectedApps.length === 0, `${appsSpaceSlug}: refusing to publish unexpected Application Units: ${unexpectedApps.join(", ")}`);
    check(missingApps.length === 0, `${appsSpaceSlug}: required Application Units are missing: ${missingApps.join(", ")}`);
    for (const unit of appRows) {
      check(unit.ToolchainType === "Kubernetes/YAML", `${appsSpaceSlug}/${unit.Slug}: expected Kubernetes/YAML`);
      check(!unit.ProviderType, `${appsSpaceSlug}/${unit.Slug}: provider must remain the default`);
      check(unit.TargetID === targetEntity.TargetID, `${appsSpaceSlug}/${unit.Slug}: target is not ${fleetItem.cluster}/target`);
      if (requireApplicationMetadata) {
        const expectedLabels = expectedArgoApplicationLabels(desired, fleetItem, unit.Slug);
        check(mapMatches(unit.Labels, expectedLabels), `${appsSpaceSlug}/${unit.Slug}: semantic delivery labels drifted`);
        check(
          staleOwnedUnitLabels(unit.Labels, expectedLabels).length === 0,
          `${appsSpaceSlug}/${unit.Slug}: stale owned semantic delivery labels remain`,
        );
      }
    }
    assertBootstrapApplication(
      appsSpaceSlug,
      "root",
      appsSpaceSlug,
      appsSpaceSlug,
      { allowLegacyAutomated: allowLegacyBootstrapAutomated },
    );
    assertBootstrapApplication(
      appsSpaceSlug,
      `argobot-${fleetItem.cluster}`,
      `argobot-${fleetItem.cluster}`,
      argobotSpaceSlug,
      { allowLegacyAutomated: allowLegacyBootstrapAutomated },
    );
    check(readLinks(appsSpaceSlug).length === 0, `${appsSpaceSlug}: unexpected Links present`);

    const argobotRows = readUnitRows(argobotSpaceSlug);
    check(
      stableJson(argobotRows.map((unit) => unit.Slug).sort()) === stableJson(["argobot"]),
      `${argobotSpaceSlug}: unsafe Unit inventory; expected only argobot, got ${argobotRows.map((unit) => unit.Slug).sort().join(", ")}`,
    );
    const argobot = argobotRows[0];
    check(argobot.ToolchainType === "Kubernetes/YAML", `${argobotSpaceSlug}/argobot: toolchain drifted`);
    check(!argobot.ProviderType, `${argobotSpaceSlug}/argobot: provider must remain the default`);
    check(argobot.TargetID === targetEntity.TargetID, `${argobotSpaceSlug}/argobot: target is not ${fleetItem.cluster}/target`);
    check(argobot.UpstreamUnitID === argobotBase.UnitID, `${argobotSpaceSlug}/argobot: upstream is not argobot-base/argobot`);
    const argobotInstanceDeployment = parseDocs(readUnitData(argobotSpaceSlug, "argobot"))
      .find((doc) => doc.kind === "Deployment" && doc.metadata?.name === "argobot");
    assertArgobotRefreshOnlyDeployment(
      argobotInstanceDeployment,
      `${argobotSpaceSlug}/argobot`,
    );
    const argobotLinks = readLinks(argobotSpaceSlug);
    check(
      argobotLinks.length === 1
        && argobotLinks[0].Slug === "upgrade-argobot"
        && argobotLinks[0].UpdateType === "UpgradeUnit"
        && argobotLinks[0].FromUnitID === argobot.UnitID
        && argobotLinks[0].ToUnitID === argobotBase.UnitID
        && argobotLinks[0].ToSpaceID === spaces.get("argobot-base")?.SpaceID,
      `${argobotSpaceSlug}: argobot UpgradeUnit Link drifted`,
    );
  }
}

function rootApplicationSyncOptions() {
  return [
    "ServerSideApply=true",
    "ServerSideApply.ForceConflicts=true",
    "RespectIgnoreDifferences=true",
    "CreateNamespace=false",
  ];
}

function assertExactObjectKeys(value, expectedKeys, context) {
  check(
    stableJson(Object.keys(value ?? {}).sort()) === stableJson([...expectedKeys].sort()),
    `${context}: expected exact keys ${[...expectedKeys].sort().join(", ")}`,
  );
}

function assertNoStoredApplicationOperation(app, context) {
  check(!app?.operation, `${context}: stored Application must not contain an executable operation`);
}

function assertNoMultipleSources(app, context) {
  check(
    app.spec?.sources === undefined
      || (Array.isArray(app.spec.sources) && app.spec.sources.length === 0),
    `${context}: Application must not define spec.sources`,
  );
}

function assertBootstrapAutomatedPolicy(automated, unitSlug, allowLegacyAutomated, context) {
  if (!automated) return;
  const exactLegacyAutomated = unitSlug === "root"
    ? { selfHeal: true }
    : { selfHeal: true, allowEmpty: true };
  check(
    allowLegacyAutomated && stableJson(automated) === stableJson(exactLegacyAutomated),
    `${context}: bootstrap Application automated policy is neither absent nor the exact one-time ConfigHub v0.2.11 migration shape`,
  );
}

function assertBootstrapApplication(
  appSpace,
  unitSlug,
  applicationName,
  sourceSpace,
  { allowLegacyAutomated = false } = {},
) {
  const docs = parseDocs(readUnitData(appSpace, unitSlug));
  check(docs.length === 1 && docs[0].kind === "Application", `${appSpace}/${unitSlug}: expected one bootstrap Argo Application`);
  const app = docs[0];
  check(app.metadata?.name === applicationName, `${appSpace}/${unitSlug}: bootstrap Application metadata.name drifted`);
  check(app.metadata?.namespace === "argocd", `${appSpace}/${unitSlug}: bootstrap Application namespace is not argocd`);
  check(app.spec?.project === "default", `${appSpace}/${unitSlug}: bootstrap Application project is not default`);
  assertNoStoredApplicationOperation(app, `${appSpace}/${unitSlug}: bootstrap Application`);
  assertNoMultipleSources(app, `${appSpace}/${unitSlug}: bootstrap Application`);
  assertExactObjectKeys(app.spec?.source, ["path", "repoURL", "targetRevision"], `${appSpace}/${unitSlug}: bootstrap source`);
  check(
    app.spec?.source?.repoURL === `${CONFIGHUB_OCI_SPACE_PREFIX}${sourceSpace}`
      && app.spec?.source?.targetRevision === "latest"
      && app.spec?.source?.path === ".",
    `${appSpace}/${unitSlug}: bootstrap Application source is not the allowlisted ConfigHub Space ${sourceSpace}`,
  );
  const isRoot = unitSlug === "root";
  const expectedDestinationNamespace = isRoot ? "argocd" : null;
  assertExactObjectKeys(
    app.spec?.destination,
    isRoot ? ["namespace", "server"] : ["server"],
    `${appSpace}/${unitSlug}: bootstrap destination`,
  );
  check(
    app.spec?.destination?.server === "https://kubernetes.default.svc"
      && (expectedDestinationNamespace === null || app.spec?.destination?.namespace === expectedDestinationNamespace),
    `${appSpace}/${unitSlug}: bootstrap Application destination is not the reviewed cluster-local destination`,
  );
  assertBootstrapAutomatedPolicy(
    app.spec?.syncPolicy?.automated,
    unitSlug,
    allowLegacyAutomated,
    `${appSpace}/${unitSlug}`,
  );
  const expectedOptions = unitSlug === "root" ? rootApplicationSyncOptions() : [];
  check(
    stableJson(app.spec?.syncPolicy?.syncOptions ?? []) === stableJson(expectedOptions),
    `${appSpace}/${unitSlug}: bootstrap Application sync options drifted`,
  );
  check(
    !(app.spec?.syncPolicy?.syncOptions ?? []).some((option) => String(option).startsWith("Replace=")),
    `${appSpace}/${unitSlug}: bootstrap Application must not use Replace`,
  );
}

function reconcileBootstrapApplicationPolicies(desired, state) {
  for (const fleetItem of FLEET) {
    const appSpace = `${fleetItem.cluster}-argo-apps`;
    for (const definition of [
      { slug: "root", name: appSpace, sourceSpace: appSpace },
      {
        slug: `argobot-${fleetItem.cluster}`,
        name: `argobot-${fleetItem.cluster}`,
        sourceSpace: `argobot-${fleetItem.cluster}`,
      },
    ]) {
      const currentData = readUnitData(appSpace, definition.slug);
      const docs = parseDocs(currentData);
      check(docs.length === 1 && docs[0].kind === "Application", `${appSpace}/${definition.slug}: expected one bootstrap Argo Application`);
      const app = docs[0];
      assertBootstrapApplication(
        appSpace,
        definition.slug,
        definition.name,
        definition.sourceSpace,
        { allowLegacyAutomated: true },
      );
      if (definition.slug === "root") {
        app.spec.syncPolicy = { syncOptions: rootApplicationSyncOptions() };
      } else {
        delete app.spec.syncPolicy;
      }
      const expected = renderDocuments([app]);
      if (sameUnitData("Kubernetes/YAML", currentData, expected)) continue;
      const temp = mkdtempSync(join(tmpdir(), "helm-expt-kubara-bootstrap-app-"));
      try {
        const path = join(temp, `${definition.slug}.yaml`);
        writeFileSync(path, expected, "utf8");
        cub([
          "unit", "update", "--space", appSpace,
          definition.slug, path,
          "--change-desc", "Delegate deployment to ConfigHub exact-digest reconciliation",
          "--quiet",
        ]);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      recordAction(state, "argo-application", `${appSpace}/${definition.slug}`, "automated sync disabled; exact-digest CAS only");
      state.changedSpaces.add(appSpace);
    }
  }
  // Re-read through the mutation-aware cache and prove the complete delivery
  // inventory now carries the no-auto-sync boundary before publication.
  assertDeliveryTopology(readSpaces(), desired, {
    fleet: FLEET,
    requireAllApplications: true,
    requireApplicationMetadata: true,
  });
}

function expectedLiveApplicationSources(desired, fleetItem) {
  const appSpace = `${fleetItem.cluster}-argo-apps`;
  return new Map([
    [appSpace, appSpace],
    [`argobot-${fleetItem.cluster}`, `argobot-${fleetItem.cluster}`],
    ...desired.deployments
      .filter((deployment) => deployment.cluster === fleetItem.cluster)
      .map((deployment) => [deployment.appUnit, deployment.space]),
  ]);
}

function waitForInactiveApplication(cluster, name) {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const app = JSON.parse(kubectl(cluster, [
      "get", "application", name, "-n", "argocd", "-o", "json",
    ]));
    const phase = app.status?.operationState?.phase ?? "Unknown";
    if (!app.operation && !["Running", "Terminating"].includes(phase)) return app;
    command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "argo-active-operation" });
  }
  check(false, `${cluster}/${name}: active Argo operation did not finish before the automation fence`);
}

function assertLiveArgobotRefreshOnlyRuntime(cluster) {
  const deployment = JSON.parse(kubectl(cluster, [
    "get", "deployment", "argobot", "-n", "argobot", "-o", "json",
  ]));
  const deploymentAuthority = assertArgobotRefreshOnlyDeployment(
    deployment,
    `${cluster}/argobot/Deployment/argobot`,
  );
  check(
    stableJson(deployment.spec?.selector?.matchLabels ?? {}) === stableJson({ app: "argobot" }),
    `${cluster}/argobot/Deployment/argobot: selector escaped the reviewed runtime boundary`,
  );
  const replicas = Number(deployment.spec?.replicas ?? 1);
  check(replicas > 0, `${cluster}/argobot/Deployment/argobot: refresh-only runtime is scaled to zero`);
  check(
    Number(deployment.status?.observedGeneration ?? 0) === Number(deployment.metadata?.generation ?? -1)
      && Number(deployment.status?.updatedReplicas ?? 0) === replicas
      && Number(deployment.status?.availableReplicas ?? 0) === replicas,
    `${cluster}/argobot/Deployment/argobot: refresh-only rollout is not fully observed and available`,
  );
  const pods = JSON.parse(kubectl(cluster, [
    "get", "pods", "-n", "argobot", "-l", "app=argobot", "-o", "json",
  ])).items ?? [];
  check(pods.length === replicas, `${cluster}/argobot: expected exactly ${replicas} active argobot Pod(s)`);
  const podRows = [];
  for (const pod of pods) {
    check(!pod.metadata?.deletionTimestamp, `${cluster}/argobot/${pod.metadata?.name}: terminating Pod can retain obsolete sync authority`);
    const podLikeDeployment = {
      kind: "Deployment",
      metadata: { name: "argobot", namespace: "argobot" },
      spec: { template: { spec: pod.spec } },
    };
    const authority = assertArgobotRefreshOnlyDeployment(
      podLikeDeployment,
      `${cluster}/argobot/Pod/${pod.metadata?.name ?? "unknown"}`,
    );
    const argobotStatus = (pod.status?.containerStatuses ?? [])
      .find((container) => container?.name === "argobot");
    check(
      pod.status?.phase === "Running" && argobotStatus?.ready === true,
      `${cluster}/argobot/Pod/${pod.metadata?.name ?? "unknown"}: refresh-only container is not Running and Ready`,
    );
    podRows.push({
      name: pod.metadata?.name ?? null,
      uid: pod.metadata?.uid ?? null,
      runningReady: true,
      ...authority,
    });
  }
  return {
    cluster,
    version: ARGOBOT_VERSION,
    deployment: {
      uid: deployment.metadata?.uid ?? null,
      generation: deployment.metadata?.generation ?? null,
      replicas,
      selectorExact: true,
      rolloutCurrent: true,
      ...deploymentAuthority,
    },
    pods: podRows.sort((left, right) => String(left.name).localeCompare(String(right.name))),
  };
}

function reconcileLiveArgoAutomationFence(desired, state) {
  for (const fleetItem of FLEET) {
    // argobot's Kubernetes mode only refreshes an Application. Its alternate
    // REST mode can issue a sync even when automated sync is disabled, so the
    // exact source, rolled-out Deployment, and every active Pod are all proved
    // refresh-only before the Application authority fence is installed.
    assertLiveArgobotRefreshOnlyRuntime(fleetItem.cluster);
    const applicationSets = JSON.parse(kubectl(fleetItem.cluster, [
      "get", "applicationsets.argoproj.io", "-A", "-o", "json",
    ])).items ?? [];
    check(
      applicationSets.length === 0,
      `${fleetItem.cluster}: adapted lane forbids ApplicationSets that could regenerate managed Applications; observed ${applicationSets.map((item) => `${item.metadata?.namespace ?? ""}/${item.metadata?.name ?? "unknown"}`).join(", ")}`,
    );
    const expectedSources = expectedLiveApplicationSources(desired, fleetItem);
    const listed = JSON.parse(kubectl(fleetItem.cluster, [
      "get", "applications.argoproj.io", "-A", "-o", "json",
    ])).items ?? [];
    const foreignNamespaceApplications = listed
      .filter((app) => app.metadata?.namespace !== "argocd")
      .map((app) => `${app.metadata?.namespace ?? "missing"}/${app.metadata?.name ?? "unknown"}`)
      .sort();
    check(
      foreignNamespaceApplications.length === 0,
      `${fleetItem.cluster}: managed authority forbids Application CRs outside argocd; observed ${foreignNamespaceApplications.join(", ")}`,
    );
    const observedNames = new Set(listed.map((app) => app.metadata?.name));
    const requiredBootstrap = [
      `${fleetItem.cluster}-argo-apps`,
      `argobot-${fleetItem.cluster}`,
    ];
    for (const name of requiredBootstrap) {
      check(observedNames.has(name), `${fleetItem.cluster}/${name}: bootstrap Application is missing before the deployment-authority fence`);
    }
    const unexpected = [...observedNames].filter((name) => !expectedSources.has(name)).sort();
    check(unexpected.length === 0, `${fleetItem.cluster}: refusing unexpected live Argo Applications before fencing: ${unexpected.join(", ")}`);
    for (const app of listed) {
      check(
        !(app.metadata?.ownerReferences ?? []).some((owner) => owner?.kind === "ApplicationSet"),
        `${fleetItem.cluster}/${app.metadata?.name ?? "unknown"}: adapted-lane Application is still owned by an ApplicationSet`,
      );
    }

    // Fence the self-managing root first. Once it cannot auto-sync, it cannot
    // restore automation on a child while the remaining CAS patches run.
    const ordered = [...listed].sort((left, right) => {
      const root = `${fleetItem.cluster}-argo-apps`;
      return Number(right.metadata?.name === root) - Number(left.metadata?.name === root)
        || String(left.metadata?.name).localeCompare(String(right.metadata?.name));
    });
    for (const observed of ordered) {
      const name = observed.metadata?.name;
      const sourceSpace = expectedSources.get(name);
      check(sourceSpace, `${fleetItem.cluster}/${name ?? "unknown"}: Application escaped the exact fence allowlist`);
      assertNoMultipleSources(observed, `${fleetItem.cluster}/${name}: live Application`);
      assertExactObjectKeys(observed.spec?.source, ["path", "repoURL", "targetRevision"], `${fleetItem.cluster}/${name}: live source`);
      check(
        observed.spec?.source?.repoURL === `${CONFIGHUB_OCI_SPACE_PREFIX}${sourceSpace}`
          && observed.spec?.source?.targetRevision === "latest",
        `${fleetItem.cluster}/${name}: Application source changed before the automation fence`,
      );
      const isSelfManagingRoot = name === `${fleetItem.cluster}-argo-apps`;
      // A settled, already-fenced child needs no point read. The self-managing
      // root is always re-read after any active operation because an older
      // root release could otherwise restore automation while this fence runs.
      if (!isSelfManagingRoot && !observed.spec?.syncPolicy?.automated) continue;
      let app = waitForInactiveApplication(fleetItem.cluster, name);
      assertNoMultipleSources(app, `${fleetItem.cluster}/${name}: settled live Application`);
      assertExactObjectKeys(app.spec?.source, ["path", "repoURL", "targetRevision"], `${fleetItem.cluster}/${name}: settled live source`);
      check(
        app.spec?.source?.repoURL === `${CONFIGHUB_OCI_SPACE_PREFIX}${sourceSpace}`
          && app.spec?.source?.targetRevision === "latest",
        `${fleetItem.cluster}/${name}: Application source changed while waiting for the automation fence`,
      );
      if (!app.spec?.syncPolicy?.automated) continue;
      let fenced = false;
      for (let attempt = 0; attempt < 5 && !fenced; attempt += 1) {
        check(app.metadata?.uid && app.metadata?.resourceVersion, `${fleetItem.cluster}/${name}: Application CAS identity is missing`);
        const patched = kubectlTry(fleetItem.cluster, [
          "patch", "application", name, "-n", "argocd",
          "--type=json", "--patch", JSON.stringify([
            { op: "test", path: "/metadata/uid", value: app.metadata.uid },
            { op: "test", path: "/metadata/resourceVersion", value: app.metadata.resourceVersion },
            { op: "remove", path: "/spec/syncPolicy/automated" },
          ]),
        ]);
        if (!patched.ok && retryableKubernetesCompareAndSet(patched.output)) {
          app = waitForInactiveApplication(fleetItem.cluster, name);
          if (!app.spec?.syncPolicy?.automated) {
            fenced = true;
            break;
          }
          continue;
        }
        check(patched.ok, `${fleetItem.cluster}/${name}: failed to install the Argo automation fence: ${patched.output}`);
        fenced = true;
      }
      check(fenced, `${fleetItem.cluster}/${name}: could not install the Argo automation fence after compare-and-set retries`);
      const current = waitForInactiveApplication(fleetItem.cluster, name);
      check(current.metadata?.uid === app.metadata?.uid, `${fleetItem.cluster}/${name}: Application identity changed during the automation fence`);
      check(!current.spec?.syncPolicy?.automated, `${fleetItem.cluster}/${name}: automated sync remained after the automation fence`);
      recordAction(
        state,
        "argo-automation-fence",
        `${fleetItem.cluster}/${name}`,
        "removed automated sync with UID/resourceVersion CAS; exact ManifestDigest operations only",
      );
    }
  }
}

function labelsArgs(labels) {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function annotationsArgs(annotations) {
  return Object.entries(annotations).flatMap(([key, value]) => {
    assertCubAnnotationValue(key, value);
    return ["--annotation", `${key}=${value}`];
  });
}

function assertCubAnnotationValue(key, value) {
  check(
    !/[=,\r\n]/.test(String(value)),
    `annotation ${key} contains a cub CLI-ambiguous value`,
  );
}

function mapMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function staleOwnedEntries(actual, expected, ownedKeys) {
  return [...ownedKeys].filter((key) => actual?.[key] !== undefined && expected[key] === undefined);
}

function staleOwnedLabels(actual, expected) {
  return staleOwnedEntries(actual, expected, OWNED_SPACE_LABELS);
}

function staleOwnedUnitLabels(actual, expected) {
  return staleOwnedEntries(actual, expected, OWNED_UNIT_LABELS);
}

function staleOwnedLinkLabels(actual, expected) {
  return staleOwnedEntries(actual, expected, OWNED_LINK_LABELS);
}

function staleOwnedPublicAnnotations(actual, expected) {
  return staleOwnedEntries(actual, expected, OWNED_PUBLIC_ANNOTATIONS);
}

function assertOwnedSpace(space, expected) {
  const cohort = space.Labels?.ExampleCohort;
  if (!cohort) {
    check(
      expected.type === "cluster-target" || expected.type === "delivery-instance" || expected.type === "delivery-definition",
      `refusing to adopt unowned Space ${space.Slug}`,
    );
    return;
  }
  check(
    [EXAMPLE_COHORT, PRIOR_COHORT].includes(cohort),
    `refusing to adopt ${space.Slug}: ExampleCohort=${cohort}`,
  );
}

function assertSpaceAllowlist(spaces, desired, { requireAll = false } = {}) {
  const allowed = new Set(desired.spaces.map((space) => space.slug));
  const unexpected = [...spaces.keys()].filter((slug) => !allowed.has(slug)).sort();
  check(unexpected.length === 0, `refusing unexpected ConfigHub Spaces outside the 55-Space mini-IDP allowlist: ${unexpected.join(", ")}`);
  if (requireAll) {
    const missing = [...allowed].filter((slug) => !spaces.has(slug)).sort();
    check(missing.length === 0, `expected ConfigHub Spaces are missing: ${missing.join(", ")}`);
  }
}

function materializePayloadFiles(inputs, root) {
  const files = new Map();
  for (const item of inputs.payloads.values()) {
    const filename = `${item.key.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}-${item.sha256.slice(0, 12)}.${item.toolchain === "AppConfig/JSON" ? "json" : "yaml"}`;
    const path = join(root, filename);
    writeFileSync(path, item.value, "utf8");
    files.set(item.key, path);
  }
  return files;
}

function applyPlan(inputs, desired) {
  const reconcilePerformance = beginReconcilePerformance();
  assertKubaraOrganization();
  const lockPath = acquireSerialLiveLock();
  const priorNamespaceMoveEvidence = validatedPriorNamespaceMoveEvidence();
  const journalNamespaceMoveAttempt = validatedNamespaceMoveJournalAttempt();
  const priorImmutableSelectorEvidence = validatedPriorImmutableSelectorEvidence();
  const journalImmutableSelectorAttempts = validatedImmutableSelectorJournalAttempts();
  const priorProtectedNamespaceEvidence = validatedPriorProtectedNamespaceEvidence();
  const journalProtectedNamespaceAttempts = validatedProtectedNamespaceJournalAttempts();
  const scenarioJournal = validatedScenarioJournal();
  const fleetBootstrapJournal = validatedFleetBootstrapJournal();
  const namespaceMoveAttempts = new Map(
    priorNamespaceMoveEvidence.map((item) => [item.ref, { ...item, source: "receipt", state: "observed-gone" }]),
  );
  if (journalNamespaceMoveAttempt) {
    const prior = namespaceMoveAttempts.get(journalNamespaceMoveAttempt.ref);
    check(!prior || prior.uid === journalNamespaceMoveAttempt.uid, "receipt and operation journal namespace-move UIDs disagree");
    namespaceMoveAttempts.set(journalNamespaceMoveAttempt.ref, {
      ...journalNamespaceMoveAttempt,
      source: "journal",
    });
  }
  const immutableSelectorAttempts = new Map(
    priorImmutableSelectorEvidence.map((item) => [item.migrationID, { ...item, source: "receipt" }]),
  );
  for (const item of journalImmutableSelectorAttempts) {
    const prior = immutableSelectorAttempts.get(item.migrationID);
    check(
      !prior || prior.uid === item.uid,
      `${item.migrationID}: receipt and operation journal immutable-selector UIDs disagree`,
    );
    immutableSelectorAttempts.set(item.migrationID, { ...item, source: "journal" });
  }
  const protectedNamespaceAttempts = new Map(
    priorProtectedNamespaceEvidence.map((item) => [item.migrationID, { ...item, source: "receipt" }]),
  );
  for (const item of journalProtectedNamespaceAttempts) {
    const prior = protectedNamespaceAttempts.get(item.migrationID);
    check(
      !prior || prior.uid === item.uid,
      `${item.migrationID}: receipt and operation journal protected Namespace UIDs disagree`,
    );
    protectedNamespaceAttempts.set(item.migrationID, { ...item, source: "journal" });
  }
  const state = {
    actions: [],
    changedSpaces: new Set(),
    published: new Map(),
    deliveryRootReleases: new Map(),
    namespaceMoveAttempts,
    namespaceMoveEvidence: [
      ...priorNamespaceMoveEvidence,
      ...(journalNamespaceMoveAttempt?.state === "observed-gone" ? [journalNamespaceMoveAttempt] : []),
    ],
    immutableSelectorAttempts,
    immutableSelectorEvidence: [
      ...priorImmutableSelectorEvidence,
      ...journalImmutableSelectorAttempts.filter((item) => item.state === "replacement-healthy"),
    ],
    protectedNamespaceAttempts,
    protectedNamespaceEvidence: [
      ...priorProtectedNamespaceEvidence,
      ...journalProtectedNamespaceAttempts.filter((item) => item.state === "observed-detached"),
    ],
    scenarioJournal,
    fleetBootstrapJournal,
    scenario: { mode: "retained-proven-history", steps: [] },
    scenarioReceiptHistory: null,
    scenarioReceiptProven: null,
    performancePhaseStart: performanceCheckpoint(),
    performancePhases: [],
    reconcilePerformance,
    applyAttempt: null,
  };
  let workRoot = "";
  let applyReadSnapshot = null;
  try {
    assertSerialLiveLock();
    // Capture the last terminal receipt and attempt ledger before opening a new
    // attempt. beginApplyAttempt() intentionally invalidates the current receipt
    // so nobody can mistake an in-flight apply for certified idempotence. That
    // top-level invalidation must not erase already-proven rollout history.
    const priorScenarioReceipt = readPriorReceipt();
    const priorScenarioAttemptLedger = readApplyAttemptLedger();
    state.applyAttempt = beginApplyAttempt();
    applyReadSnapshot = beginApplyReadSnapshot();
    state.scenarioReceiptHistory = scenarioReceiptHistoryDiagnosis({
      receipt: priorScenarioReceipt,
      attemptLedger: priorScenarioAttemptLedger,
    });
    state.scenarioReceiptProven = state.scenarioReceiptHistory.proven;
    preflightScenarioHistory(state);
    workRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-mini-idp-"));
    const payloadFiles = materializePayloadFiles(inputs, workRoot);
    let spaces = readSpaces();
    assertSpaceAllowlist(spaces, desired);
    reconcileClusters(spaces, desired, state);
    // `cub variant create --target` can publish the apps Space as a side
    // effect. Fence the live root and every already-observed child immediately
    // after bootstrap, before creating or reconciling any platform variants.
    // Fresh clusters contain only the reviewed root and argobot at this point.
    reconcileLiveArgoAutomationFence(desired, state);
    state.kindTraefikDockerBindings = observeKindTraefikDockerBindings();
    spaces = readSpaces();
    for (const expected of desired.spaces) {
      const live = spaces.get(expected.slug);
      if (live) assertOwnedSpace(live, expected);
    }
    const preserveScenarioJournalState = Boolean(
      state.scenarioJournal
        && ["started", "completed"].includes(state.scenarioJournal.state)
        && !trustedScenarioHistoryForApply(state),
    );
    const inFlightScenarioSpaces = preserveScenarioJournalState
      ? new Set(["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)])
      : new Set();
    ensureDefinitionSpaces(spaces, desired, state, {
      assertOnlySpaces: inFlightScenarioSpaces,
    });
    spaces = readSpaces();
    reconcileSpaceLabels(spaces, desired, state, {
      requireAll: false,
      assertOnlySpaces: inFlightScenarioSpaces,
    });
    reconcileApprovalPolicy(state, {
      assertOnly: preserveScenarioJournalState,
    });
    reconcileControlUnits(inputs, payloadFiles, desired, state);
    reconcileArgoCdDefinitions(inputs, payloadFiles, desired, state);
    reconcileDeliveryApplicationMetadata(desired, state, {
      assertOnlySourceSpaces: inFlightScenarioSpaces,
    });

    for (const surfaceDefinition of SURFACES) {
      reconcileSurface(surfaceDefinition, inputs, payloadFiles, desired, state);
    }
    for (const family of APP_FAMILIES.filter((item) => !item.scenario)) {
      reconcileAppFamily(family, inputs, payloadFiles, desired, state);
    }
    const hxWebScenarioStatus = materializeHxWebScenario(inputs, payloadFiles, desired, state);
    reconcileSpaceLabels(readSpaces(), desired, state, {
      assertOnlySpaces: inFlightScenarioSpaces,
    });
    reconcileProdPolicies(desired, state, {
      assertOnly: preserveScenarioJournalState,
    });
    reconcileDeliveryApplicationMetadata(desired, state, {
      requireAll: true,
      assertOnlySourceSpaces: inFlightScenarioSpaces,
    });
    reconcileBootstrapApplicationPolicies(desired, state);
    for (const fleetItem of FLEET) {
      assertUnitAllowlist(
        `${fleetItem.cluster}-argo-apps`,
        expectedArgoApplicationSlugs(desired, fleetItem),
      );
    }
    // Freeze a fresh, organization-wide view after declarative reconciliation
    // and before any release is allowed to drive Argo. Publication boundaries
    // still bypass this cache and perform their own authoritative reads.
    refreshApplyReadSnapshotAtPhaseBoundary("pre-release-and-argo");
    assertSpaceAllowlist(readSpaces(), desired, { requireAll: true });
    assertManagedUnitInventory(desired);
    assertManagedLinkInventory(desired);
    assertExactManagedTargetInventory(activeApplyReadSnapshot, "pre-release ConfigHub Target inventory");
    // Freeze the dependency-complete pre-release phase snapshot. A run with no
    // ConfigHub changes may reuse it for read-only release decisions; changed
    // applies retain targeted stream reads. The first later ConfigHub mutation
    // invalidates either form of the frozen topology.
    beginAuthoritativeReleaseReuseBatch({ snapshotOnly: state.actions.length === 0 });
    for (const deployment of desired.deployments.filter((item) => item.type === "platform")) {
      deployOne(deployment, state);
      waitForSpecialPrerequisite(deployment);
    }
    reconcileHxWebScenario(inputs, payloadFiles, desired, state, hxWebScenarioStatus);

    reconcileSpaceLabels(readSpaces(), desired, state);
    reconcileProdPolicies(desired, state);
    // hx-web is published by its scenario state machine. The platform binding
    // and cubbychat follow once cert-manager, Traefik, and the workload service
    // they refer to exist.
    for (const deployment of desired.deployments.filter(
      (item) => item.type === "application" && !item.space.startsWith("hx-web-"),
    )) deployOne(deployment, state);
    for (const deployment of desired.deployments.filter(
      (item) => item.space.startsWith("hx-web-platform-"),
    )) deployOne(deployment, state);

    // During the one-time Traefik migration argocd-server is parked at the
    // eighth port in each kind window. Restore its reserved first port only
    // after the exact Traefik Service has converged on the new +2/+3 pair.
    reconcileArgocdServerReservedNodePorts(state);
    reconcileDeliveryApplicationMetadata(desired, state, { requireAll: true });
    assertPublishedDeliveryRootsRemainCurrent(state);
    reconcileLinks(desired, state);
    assertManagedLinkInventory(desired, { requireNeedsProvides: true });
    state.applyReadCacheEvidence = finishApplyReadSnapshot();
    lastCompletedApplyReadEvidence = state.applyReadCacheEvidence;
    const observation = verifyLive(inputs, desired, { state });
    state.runPerformance = finishReconcilePerformance(reconcilePerformance, state);
    assertReconcileRunPerformanceEvidence(state.runPerformance, state);
    const receipt = buildReceipt(inputs, desired, observation, state);
    writeReceiptAtomically(receipt);
    completeApplyAttempt(state.applyAttempt, {
      result: "pass",
      runClass: state.runPerformance.runClass,
      actionCount: state.actions.length,
      receiptObservedAt: receipt.status.observedAt,
      performance: state.runPerformance,
    });
    if (receipt.status.idempotentRerunProven) {
      verifyReceipt(inputs, desired);
      console.log(
        `reconciled Kubara mini-IDP idempotently: ${state.actions.length} action(s), ${observation.spaces.length} Spaces, ${observation.units.length} managed Units, ${observation.links.length} NeedsProvides Links`,
      );
    } else {
      console.log(
        `reconciled Kubara mini-IDP: ${state.actions.length} action(s); rerun --apply to record the required zero-action idempotence proof`,
      );
    }
  } catch (error) {
    failApplyAttempt(state.applyAttempt, error, state, reconcilePerformance);
    throw error;
  } finally {
    lastCompletedPerformancePhases = [...state.performancePhases];
    if (activeApplyReadSnapshot === applyReadSnapshot) activeApplyReadSnapshot = null;
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    releaseSerialLiveLock(lockPath);
  }
}

function reconcileArgocdServerReservedNodePorts(state) {
  for (const contract of KIND_TRAEFIK_CONTRACTS) {
    const resources = JSON.parse(kubectl(contract.cluster, ["get", "service", "-A", "-o", "json"]));
    const services = resources.items ?? [];
    const traefik = services.filter((item) => item?.apiVersion === "v1"
      && item?.kind === "Service"
      && item?.metadata?.namespace === contract.namespace
      && item?.metadata?.name === contract.serviceName);
    check(traefik.length === 1, `${contract.cluster}: cannot restore argocd-server before the exact Traefik Service exists`);
    check(
      traefik[0].spec?.type === "NodePort"
        && stableJson((traefik[0].spec?.ports ?? []).map((port) => ({
          name: port.name,
          port: port.port,
          targetPort: port.targetPort,
          protocol: port.protocol ?? "TCP",
          nodePort: port.nodePort,
        }))) === stableJson(contract.ports),
      `${contract.cluster}: refusing to restore argocd-server before Traefik owns the exact ${contract.httpNodePort}/${contract.httpsNodePort} pair`,
    );
    const opening = assertArgocdServerNodePortEvidenceShape(contract, resources);
    const disposition = argocdServerNodePortDisposition(contract, opening.ports[0].nodePort);
    if (disposition === "current") continue;
    const patch = [
      { op: "test", path: "/metadata/uid", value: opening.uid },
      { op: "test", path: "/metadata/resourceVersion", value: opening.resourceVersion },
      { op: "test", path: "/spec/ports/0/nodePort", value: opening.ports[0].nodePort },
      { op: "replace", path: "/spec/ports/0/nodePort", value: contract.reservedArgocdServerNodePort },
    ];
    kubectl(contract.cluster, [
      "patch", "service", "argocd-server", "-n", "argocd",
      "--type=json", "-p", JSON.stringify(patch),
    ]);
    const closing = JSON.parse(kubectl(contract.cluster, ["get", "service", "argocd-server", "-n", "argocd", "-o", "json"]));
    const verified = assertArgocdServerNodePortEvidenceShape(contract, { items: [closing] }, { requireReserved: true });
    check(verified.uid === opening.uid, `${contract.cluster}: argocd-server identity changed while restoring its reserved NodePort`);
    recordAction(
      state,
      "cluster-service-nodeport",
      `${contract.cluster}/argocd/argocd-server`,
      `${opening.ports[0].nodePort}->${contract.reservedArgocdServerNodePort}`,
    );
  }
}

function argocdServerNodePortDisposition(contract, nodePort) {
  if (nodePort === contract.reservedArgocdServerNodePort) return "current";
  check(
    nodePort === contract.reservedArgocdServerNodePort + 8,
    `${contract.cluster}: refusing to normalize foreign argocd-server NodePort drift ${nodePort}; expected reserved ${contract.reservedArgocdServerNodePort} or declared recovery ${contract.reservedArgocdServerNodePort + 8}`,
  );
  return "declared-recovery";
}

function recordAction(state, type, ref, detail = "") {
  recordStructuredAction(state, { type, ref, ...(detail ? { detail } : {}) });
}

function recordStructuredAction(state, action) {
  state.actions.push(action);
  attributeSuccessfulMutationForAction(action.type);
}

function reconcileClusters(spaces, desired, state) {
  const local = new Set(kindClusters());
  const allowedClusters = new Set(FLEET.map((item) => item.cluster));
  for (const name of local) {
    if (name.startsWith("hx-app-") && !allowedClusters.has(name)) {
      check(false, `unexpected hx-app cluster ${name}; the exact cluster allowlist is ${[...allowedClusters].join(", ")}`);
    }
  }

  const initialStates = [];
  for (const item of FLEET) {
    const signals = {
      kind: local.has(item.cluster),
      kubeconfig: existsSync(clusterKubeconfig(item.cluster)),
      env: existsSync(clusterEnv(item.cluster)),
      clusterSpace: spaces.has(item.cluster),
      appsSpace: spaces.has(`${item.cluster}-argo-apps`),
      argobotSpace: spaces.has(`argobot-${item.cluster}`),
      target: Boolean(readTarget(item.cluster)),
    };
    const present = Object.values(signals).filter(Boolean).length;
    check(
      present === 0 || present === Object.keys(signals).length,
      `${item.cluster}: unsafe partial persistent-cluster state; refusing repair or deletion: ${stableJson(signals)}`,
    );
    initialStates.push({ item, absent: present === 0 });
  }
  const existingCount = initialStates.filter((entry) => !entry.absent).length;
  let bootstrap = state.fleetBootstrapJournal;
  const existingClusters = initialStates
    .filter((entry) => !entry.absent)
    .map((entry) => entry.item.cluster);
  if (bootstrap?.state === "started") {
    const allowedExisting = [
      ...bootstrap.createdClusters,
      ...(bootstrap.preparedCluster && existingClusters.includes(bootstrap.preparedCluster)
        ? [bootstrap.preparedCluster]
        : []),
    ];
    check(
      stableJson(existingClusters) === stableJson(allowedExisting),
      `fleet bootstrap live clusters are not the exact journaled prefix: journal=${allowedExisting.join(",") || "none"} live=${existingClusters.join(",") || "none"}`,
    );
    const guardedSpaces = desired.deployments
      .map((deployment) => deployment.space)
      .filter((slug, index, all) => all.indexOf(slug) === index)
      .sort();
    check(
      stableJson(guardedSpaces) === stableJson(bootstrap.guardedPublishedSourceSpaces),
      "fleet bootstrap source-Space inventory changed after the zero-release guard",
    );
    const activatedClusters = new Set(bootstrap.rootActivatedClusters);
    const guardedUnactivatedSpaces = desired.deployments
      .filter((deployment) => !activatedClusters.has(deployment.cluster))
      .map((deployment) => deployment.space)
      .filter((slug, index, all) => all.indexOf(slug) === index && spaces.has(slug));
    for (const slug of guardedUnactivatedSpaces) {
      check(
        !hasRelease(slug),
        `${slug}: refusing to resume partial fleet bootstrap after a source release was published`,
      );
    }
    if (bootstrap.preparedCluster && existingClusters.includes(bootstrap.preparedCluster)) {
      bootstrap = checkpointFleetBootstrapCluster(bootstrap.preparedCluster);
      state.fleetBootstrapJournal = bootstrap;
    }
  } else {
    check(
      existingCount === 0 || existingCount === FLEET.length,
      `mixed existing/missing persistent-cluster fleet lacks an exact write-ahead bootstrap journal (${existingCount}/${FLEET.length} complete)`,
    );
  }
  if (existingCount === 0 && !bootstrap) {
    check(!spaces.has("argobot-base"), "argobot-base exists without any complete allowlisted cluster; refusing partial repair");
    const guardedSpaces = desired.deployments
      .map((deployment) => deployment.space)
      .filter((slug, index, all) => all.indexOf(slug) === index)
      .sort();
    for (const deployment of desired.deployments) {
      if (!spaces.has(deployment.space)) continue;
      check(
        !hasRelease(deployment.space),
        `${deployment.space}: refusing zero-cluster bootstrap with a pre-existing published source release that automated child Applications could consume as :latest`,
      );
    }
    bootstrap = beginFleetBootstrapJournal(guardedSpaces);
    state.fleetBootstrapJournal = bootstrap;
  } else if (existingCount === FLEET.length) {
    check(spaces.has("argobot-base"), "argobot-base is missing while persistent clusters exist; refusing partial repair");
    assertDeliveryTopology(spaces, desired, {
      allowLegacyBootstrapAutomated: true,
      fleet: initialStates.filter((entry) => !entry.absent).map((entry) => entry.item),
    });
  } else {
    check(bootstrap?.state === "started", "partial fleet bootstrap lacks an active operation journal");
    check(spaces.has("argobot-base"), "argobot-base is missing while a journaled persistent cluster exists");
    assertDeliveryTopology(spaces, desired, {
      allowLegacyBootstrapAutomated: true,
      fleet: initialStates.filter((entry) => !entry.absent).map((entry) => entry.item),
    });
  }

  for (const { item, absent } of initialStates) {
    if (!absent) continue;
    check(bootstrap?.state === "started", `${item.cluster}: missing cluster lacks an active fleet-bootstrap journal`);
    bootstrap = prepareFleetBootstrapCluster(item.cluster);
    state.fleetBootstrapJournal = bootstrap;
    cub(["cluster", "up", "--name", item.cluster, "--space", item.cluster], { timeout: 1_200_000 });
    recordAction(state, "cluster-up", item.cluster, "created persistent kind + ConfigHub Argo target; no cleanup registered");
    const afterSpaces = readSpaces();
    const afterLocal = new Set(kindClusters());
    check(afterLocal.has(item.cluster), `${item.cluster}: kind cluster missing immediately after cluster up`);
    check(existsSync(clusterKubeconfig(item.cluster)), `${item.cluster}: kubeconfig missing immediately after cluster up`);
    check(existsSync(clusterEnv(item.cluster)), `${item.cluster}: env file missing immediately after cluster up`);
    check(
      afterSpaces.has(item.cluster)
        && afterSpaces.has(`${item.cluster}-argo-apps`)
        && afterSpaces.has(`argobot-${item.cluster}`)
        && Boolean(readTarget(item.cluster)),
      `${item.cluster}: ConfigHub target topology incomplete immediately after cluster up`,
    );
    bootstrap = checkpointFleetBootstrapCluster(item.cluster);
    state.fleetBootstrapJournal = bootstrap;
    refreshApplyReadSnapshotAtPhaseBoundary(`post-cluster-up-${item.cluster}`);
  }

  const refreshed = readSpaces();
  const refreshedClusters = new Set(kindClusters());
  for (const item of FLEET) {
    check(refreshedClusters.has(item.cluster), `${item.cluster}: kind cluster missing after cluster reconciliation`);
    check(existsSync(clusterKubeconfig(item.cluster)), `${item.cluster}: kubeconfig missing after cluster reconciliation`);
    check(existsSync(clusterEnv(item.cluster)), `${item.cluster}: env file missing after cluster reconciliation`);
    check(refreshed.has(item.cluster) && refreshed.has(`${item.cluster}-argo-apps`), `${item.cluster}: ConfigHub cluster Spaces missing after cluster reconciliation`);
    check(readTarget(item.cluster), `${item.cluster}: target missing after cluster reconciliation`);
  }
  for (const slug of ["argobot-base", ...FLEET.map((item) => `argobot-${item.cluster}`)]) {
    check(refreshed.has(slug), `${slug}: delivery Space missing after cluster reconciliation; refusing partial repair`);
  }
  assertDeliveryTopology(refreshed, desired, { allowLegacyBootstrapAutomated: true });
  for (const item of FLEET) {
    const reachable = kubectlTry(item.cluster, ["get", "namespace", "kube-system", "-o", "name"]);
    check(reachable.ok && /namespace\/kube-system/.test(reachable.output), `${item.cluster}: kubeconfig/context does not reach the expected persistent kind cluster`);
    observeClusterLocalArgoRuntime(item.cluster);
  }
}

function ensureDefinitionSpaces(
  spaces,
  desired,
  state,
  { assertOnlySpaces = new Set() } = {},
) {
  const creatable = new Set(["control", "component-definition", "delivery-runtime-definition", "app-definition"]);
  for (const item of desired.spaces) {
    if (spaces.has(item.slug)) continue;
    if (!creatable.has(item.type)) continue;
    check(!assertOnlySpaces.has(item.slug), `${item.slug}: definition Space is missing during an in-flight hx-web scenario`);
    cub([
      "space", "create", item.slug,
      ...labelsArgs(item.labels),
      ...annotationsArgs(item.annotations ?? {}),
      "--quiet",
    ]);
    recordAction(state, "space-create", item.slug);
    spaces = readSpaces();
  }
}

function reconcileSpaceLabels(
  spaces,
  desired,
  state,
  { requireAll = true, assertOnlySpaces = new Set() } = {},
) {
  for (const item of desired.spaces) {
    const live = spaces.get(item.slug);
    if (!live && !requireAll) continue;
    check(live, `${item.slug}: expected Space is missing`);
    const expectedAnnotations = item.annotations ?? {};
    const staleLabels = staleOwnedLabels(live.Labels, item.labels);
    const staleAnnotations = staleOwnedPublicAnnotations(live.Annotations, expectedAnnotations);
    if (
      mapMatches(live.Labels, item.labels)
      && staleLabels.length === 0
      && mapMatches(live.Annotations, expectedAnnotations)
      && staleAnnotations.length === 0
    ) continue;
    check(!assertOnlySpaces.has(item.slug), `${item.slug}: owned Space metadata drifted during an in-flight hx-web scenario`);
    cub([
      "space", "update", "--patch", item.slug,
      ...labelsArgs(item.labels),
      ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
      ...annotationsArgs(expectedAnnotations),
      ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
      "--quiet",
    ]);
    recordAction(state, "space-metadata", item.slug);
    spaces = readSpaces();
  }
}

function reconcileApplicationUnitLabels(
  desired,
  fleetItem,
  unitSlug,
  state,
  { required = true, assertOnly = false, observedUnit = undefined } = {},
) {
  const appSpace = `${fleetItem.cluster}-argo-apps`;
  const unit = observedUnit === undefined ? readUnit(appSpace, unitSlug) : observedUnit;
  if (!unit && !required) return false;
  check(unit, `${appSpace}/${unitSlug}: Argo Application Unit is missing`);
  const expected = expectedArgoApplicationLabels(desired, fleetItem, unitSlug);
  const stale = staleOwnedUnitLabels(unit.Labels, expected);
  if (mapMatches(unit.Labels, expected) && stale.length === 0) return true;
  check(!assertOnly, `${appSpace}/${unitSlug}: delivery identity drifted during an in-flight hx-web scenario`);
  cub([
    "unit", "update", "--patch", "--space", appSpace, unitSlug,
    ...labelsArgs(expected),
    ...stale.flatMap((key) => ["--label", `${key}=-`]),
    "--change-desc", `Reconcile ${KUBARA_VERSION} delivery identity`,
    "--quiet",
  ]);
  recordAction(state, "argo-application-metadata", `${appSpace}/${unitSlug}`);
  state.changedSpaces.add(appSpace);
  return true;
}

function reconcileDeliveryApplicationMetadata(
  desired,
  state,
  { requireAll = false, assertOnlySourceSpaces = new Set() } = {},
) {
  for (const fleetItem of FLEET) {
    const appSpace = `${fleetItem.cluster}-argo-apps`;
    const requiredSlugs = ["root", `argobot-${fleetItem.cluster}`];
    for (const slug of expectedArgoApplicationSlugs(desired, fleetItem)) {
      const deployment = desired.deployments.find(
        (item) => item.cluster === fleetItem.cluster && item.appUnit === slug,
      );
      reconcileApplicationUnitLabels(desired, fleetItem, slug, state, {
        required: requireAll || requiredSlugs.includes(slug),
        assertOnly: Boolean(deployment && assertOnlySourceSpaces.has(deployment.space)),
        observedUnit: readUnit(appSpace, slug),
      });
    }
  }
}

function reconcileApprovalPolicy(state, { assertOnly = false } = {}) {
  const triggerResult = cubTry(["trigger", "get", "--space", CONTROL_SPACE, APPROVAL_TRIGGER, "-o", "json"]);
  if (!triggerResult.ok) {
    check(!assertOnly, `${CONTROL_SPACE}/${APPROVAL_TRIGGER}: approval Trigger is missing during an in-flight hx-web scenario`);
    cub([
      "trigger", "create", "--space", CONTROL_SPACE,
      APPROVAL_TRIGGER, "Mutation", "Kubernetes/YAML", "vet-approvedby", "1",
      "--description", "Production configuration requires one approval of the exact revision",
      "--quiet",
    ]);
    recordAction(state, "trigger-create", `${CONTROL_SPACE}/${APPROVAL_TRIGGER}`);
  } else {
    const trigger = unwrapEntity(JSON.parse(triggerResult.output), "Trigger");
    const argumentsMatch = stableJson(trigger.Arguments ?? []) === stableJson([
      { ParameterName: "num-approvers", Value: "1" },
    ]);
    if (
      trigger.Event !== "Mutation"
      || trigger.ToolchainType !== "Kubernetes/YAML"
      || trigger.FunctionName !== "vet-approvedby"
      || !argumentsMatch
      || trigger.Disabled === true
      || trigger.Validating !== true
      || Number(trigger.FailOpenAfter ?? 0) !== 0
    ) {
      check(!assertOnly, `${CONTROL_SPACE}/${APPROVAL_TRIGGER}: approval Trigger drifted during an in-flight hx-web scenario`);
      cub([
        "trigger", "update", "--space", CONTROL_SPACE,
        APPROVAL_TRIGGER, "Mutation", "Kubernetes/YAML", "vet-approvedby", "1",
        "--description", "Production configuration requires one approval of the exact revision",
        "--quiet",
      ]);
      recordAction(state, "trigger-update", `${CONTROL_SPACE}/${APPROVAL_TRIGGER}`);
    }
  }

  const where = "Space.Slug = 'hx-platform' AND FunctionName = 'vet-approvedby'";
  const filterResult = cubTry(["filter", "get", "--space", CONTROL_SPACE, APPROVAL_FILTER, "-o", "json"]);
  if (!filterResult.ok) {
    check(!assertOnly, `${CONTROL_SPACE}/${APPROVAL_FILTER}: approval Filter is missing during an in-flight hx-web scenario`);
    cub([
      "filter", "create", "--space", CONTROL_SPACE,
      APPROVAL_FILTER, "Trigger", "--where-field", where, "--quiet",
    ]);
    recordAction(state, "filter-create", `${CONTROL_SPACE}/${APPROVAL_FILTER}`);
  } else {
    const filter = unwrapEntity(JSON.parse(filterResult.output), "Filter");
    if (filter.From !== "Trigger" || filter.Where !== where) {
      check(!assertOnly, `${CONTROL_SPACE}/${APPROVAL_FILTER}: approval Filter drifted during an in-flight hx-web scenario`);
      cub([
        "filter", "update", "--space", CONTROL_SPACE,
        APPROVAL_FILTER, "Trigger", "--where-field", where, "--quiet",
      ]);
      recordAction(state, "filter-update", `${CONTROL_SPACE}/${APPROVAL_FILTER}`);
    }
  }
}

function reconcileControlUnits(inputs, payloadFiles, desired, state) {
  const expectedUnits = desired.managedUnits.filter((item) => item.space === CONTROL_SPACE);
  const expectedSlugs = expectedUnits.map((item) => item.slug).sort();
  const preservedSlugs = PRESERVED_FAITHFUL_CONTROL_UNITS.map((item) => item.slug).sort();
  const unexpected = readUnitRows(CONTROL_SPACE)
    .map((item) => item.Slug)
    .filter((slug) => !expectedSlugs.includes(slug) && !preservedSlugs.includes(slug))
    .sort();
  check(unexpected.length === 0, `${CONTROL_SPACE}: refusing unexpected control Units: ${unexpected.join(", ")}`);
  assertPreservedFaithfulControlUnits();
  for (const expected of expectedUnits) {
    if (expected.requiredForApply) check(expected.payloadKey, `${CONTROL_SPACE}/${expected.slug}: required evidence is missing`);
    if (!expected.payloadKey) continue;
    upsertUnit(expected, inputs, payloadFiles, state);
  }
  assertUnitAllowlist(CONTROL_SPACE, [...expectedSlugs, ...preservedSlugs]);
}

function reconcileArgoCdDefinitions(inputs, payloadFiles, desired, state) {
  for (const [space, slug] of [
    [ARGO_CD_DEFINITION_SPACE, ARGO_CD_DEFINITION_UNIT],
    [ARGO_CD_RUNTIME_SPACE, ARGO_CD_RUNTIME_UNIT],
  ]) {
    const expected = desired.managedUnits.find((item) => item.space === space && item.slug === slug);
    check(expected, `${space}/${slug}: definition is missing from the plan`);
    upsertUnit(expected, inputs, payloadFiles, state);
    assertUnitAllowlist(space, [slug]);
  }
}

function reconcileSurface(surfaceDefinition, inputs, payloadFiles, desired, state) {
  const baseSpace = `${surfaceDefinition.prefix}-base`;
  const baseUnit = desired.managedUnits.find((item) => item.space === baseSpace && item.slug === surfaceDefinition.prefix);
  upsertUnit(baseUnit, inputs, payloadFiles, state);
  assertUnitAllowlist(baseSpace, [surfaceDefinition.prefix]);
  for (const fleetItem of surfaceDefinition.targets) {
    const space = `${surfaceDefinition.prefix}-${fleetItem.suffix}`;
    ensureVariantSpace({
      space,
      upstreamSpace: baseSpace,
      variantName: fleetItem.suffix,
      fleetItem,
      prodProtected: fleetItem.environment === "Prod",
    }, state);
    const unit = desired.managedUnits.find((item) => item.space === space && item.slug === surfaceDefinition.prefix);
    upsertUnit(unit, inputs, payloadFiles, state);
    assertUnitAllowlist(space, [surfaceDefinition.prefix]);
    ensureArgoApplication(desired.deployments.find((item) => item.space === space), state);
  }
}

function reconcileAppFamily(family, inputs, payloadFiles, desired, state) {
  assertAppFamilyPlanConsistency(desired, [family]);
  const baseSpace = `${family.prefix}-base`;
  for (const unit of desired.managedUnits.filter((item) => item.space === baseSpace)) {
    upsertUnit(unit, inputs, payloadFiles, state);
  }
  assertUnitAllowlist(baseSpace, family.units.map((item) => item.slug));
  for (const fleetItem of family.targets) {
    const space = `${family.prefix}-${fleetItem.suffix}`;
    const plannedSpace = desired.spaces.find((item) => item.slug === space);
    check(plannedSpace?.upstreamSpace, `${space}: planned upstream Space is missing`);
    const upstreamSpace = plannedSpace.upstreamSpace;
    ensureVariantSpace({
      space,
      upstreamSpace,
      variantName: fleetItem.suffix,
      fleetItem,
      prodProtected: fleetItem.environment === "Prod",
    }, state);
    for (const unit of desired.managedUnits.filter((item) => item.space === space)) {
      upsertUnit(unit, inputs, payloadFiles, state);
    }
    assertUnitAllowlist(space, family.units.map((item) => item.slug));
    ensureArgoApplication(
      desired.deployments.find((item) => item.space === space),
      state,
    );
  }
}

function ensureVariantSpace(
  { space, upstreamSpace, variantName, fleetItem, prodProtected },
  state,
  { assertOnly = false } = {},
) {
  const live = readSpaces().get(space) ?? null;
  if (!live) {
    check(!assertOnly, `${space}: scenario variant is missing during in-flight recovery`);
    cub([
      "variant", "create", variantName, upstreamSpace,
      "--space-pattern", `template:${space}`,
      "--environment", fleetItem.environment,
      "--region", fleetItem.region,
      "--target", `${fleetItem.cluster}/target`,
      ...(prodProtected
        ? ["--unit-delete-gate", PROD_SAFETY_GATE, "--unit-destroy-gate", PROD_SAFETY_GATE]
        : []),
      "--wait", "--quiet",
    ], { timeout: 1_200_000 });
    recordAction(state, "variant-create", space, `upstream=${upstreamSpace} target=${fleetItem.cluster}/target`);
    state.changedSpaces.add(space);
    return;
  }
  const cohort = live.Labels?.ExampleCohort;
  check(!cohort || [EXAMPLE_COHORT, PRIOR_COHORT].includes(cohort), `${space}: refuses foreign existing variant`);
  const target = readTarget(fleetItem.cluster);
  check(target?.TargetID, `${fleetItem.cluster}/target is missing`);
  if (live.ReleaseTargetID !== target.TargetID) {
    check(!assertOnly, `${space}: release target drifted during an in-flight hx-web scenario`);
    cub(["space", "update", "--patch", space, "--release-target", `${fleetItem.cluster}/target`, "--quiet"]);
    recordAction(state, "space-release-target", space, `${fleetItem.cluster}/target`);
    state.changedSpaces.add(space);
  }
}

function assertUnitAllowlist(space, expectedSlugs) {
  const actual = readUnitRows(space).map((item) => item.Slug).sort();
  const expected = [...expectedSlugs].sort();
  check(stableJson(actual) === stableJson(expected), `${space}: unsafe Unit inventory; expected ${expected.join(", ")}, got ${actual.join(", ")}`);
}

function assertManagedUnitInventory(desired) {
  const expectedBySpace = new Map();
  for (const unit of desired.managedUnits) {
    if (!expectedBySpace.has(unit.space)) expectedBySpace.set(unit.space, []);
    expectedBySpace.get(unit.space).push(unit.slug);
  }
  for (const [space, slugs] of expectedBySpace) {
    assertUnitAllowlist(
      space,
      space === CONTROL_SPACE
        ? [...slugs, ...PRESERVED_FAITHFUL_CONTROL_UNITS.map((item) => item.slug)]
        : slugs,
    );
  }
}

function assertPreservedFaithfulControlUnits() {
  const faithful = verifyFaithfulProof();
  const generatedSha256 = faithful.spec?.source?.currentExample?.generatedSha256;
  check(/^[a-f0-9]{64}$/.test(generatedSha256 ?? ""), "faithful proof generated SHA is missing");
  const rows = [];
  for (const expected of PRESERVED_FAITHFUL_CONTROL_UNITS) {
    const evidence = faithful.spec?.configHub?.[expected.receiptKey];
    const receiptUnit = evidence?.unit;
    const receiptApproval = evidence?.approval;
    const ref = `${CONTROL_SPACE}/${expected.slug}`;
    check(receiptUnit?.ref === ref, `${ref}: faithful receipt ownership reference drifted`);
    check(UUID_PATTERN.test(receiptUnit.id ?? ""), `${ref}: faithful receipt Unit ID is missing`);
    check(Number.isInteger(receiptUnit.headRevisionNum), `${ref}: faithful receipt head revision is missing`);
    check(/^[a-f0-9]{64}$/.test(receiptUnit.dataHash ?? ""), `${ref}: faithful receipt data hash is missing`);
    check(
      receiptApproval?.revision === receiptUnit.headRevisionNum
        && Number.isInteger(receiptApproval.recordedApprovals)
        && receiptApproval.recordedApprovals > 0,
      `${ref}: faithful receipt approval is not bound to its recorded head revision`,
    );

    const live = readUnit(CONTROL_SPACE, expected.slug);
    check(live, `${ref}: retained faithful proof Unit is missing`);
    check(live.UnitID === receiptUnit.id, `${ref}: Unit ID differs from the current faithful pass receipt`);
    check(live.HeadRevisionNum === receiptUnit.headRevisionNum, `${ref}: head revision differs from the current faithful pass receipt`);
    check(live.DataHash === receiptUnit.dataHash, `${ref}: data hash differs from the current faithful pass receipt`);
    check(live.ToolchainType === "AppConfig/YAML", `${ref}: toolchain must remain AppConfig/YAML`);
    check(live.ProviderType === "None", `${ref}: provider must remain None`);
    check(!live.TargetID && !live.UpstreamUnitID, `${ref}: faithful proof evidence must remain untargeted and without an upstream`);
    check(
      approvalCount(live.ApprovedBy) === receiptApproval.recordedApprovals,
      `${ref}: live head approvals differ from the current faithful pass receipt`,
    );
    check(mapMatches(live.Labels, {
      ExampleCohort: EXAMPLE_COHORT,
      KubaraVersion: KUBARA_VERSION,
      Role: expected.role,
      Topology: "HubSpoke",
      ProofPhase: expected.proofPhase,
    }), `${ref}: faithful proof ownership labels drifted`);
    check(mapMatches(live.Annotations, {
      "confighub.com/source-path": paths.config,
      "confighub.com/generated-sha256": `sha256:${generatedSha256}`,
    }), `${ref}: faithful proof provenance annotations drifted`);
    rows.push({
      ref,
      id: live.UnitID,
      headRevisionNum: live.HeadRevisionNum,
      dataHash: live.DataHash,
      approvalCount: approvalCount(live.ApprovedBy),
      owner: "faithful-hub-spoke-proof",
      policy: "preserved",
    });
  }
  return rows;
}

function assertManagedLinkInventory(desired, { requireNeedsProvides = false } = {}) {
  const spaces = readSpaces();
  const unitsBySpace = new Map();
  for (const unit of desired.managedUnits) {
    if (!unitsBySpace.has(unit.space)) unitsBySpace.set(unit.space, []);
    unitsBySpace.get(unit.space).push(unit);
  }
  for (const [space, units] of unitsBySpace) {
    const expectedUpgrade = new Map(units.filter((unit) => unit.upstream).map((unit) => [`upgrade-${unit.slug}`, unit]));
    const expectedNeedsProvides = new Map(desired.links.filter((link) => link.space === space).map((link) => [link.slug, link]));
    const allowedSlugs = new Set([...expectedUpgrade.keys(), ...expectedNeedsProvides.keys()]);
    const liveLinks = readLinks(space);
    const unexpected = liveLinks.filter((link) => !allowedSlugs.has(link.Slug)).map((link) => link.Slug).sort();
    check(unexpected.length === 0, `${space}: refusing unexpected Links: ${unexpected.join(", ")}`);

    for (const [slug, unit] of expectedUpgrade) {
      const link = liveLinks.find((item) => item.Slug === slug);
      check(link, `${space}/${slug}: required UpgradeUnit Link is missing`);
      const downstream = readUnit(space, unit.slug);
      const [upstreamSpace, upstreamSlug] = unit.upstream.split("/");
      const upstream = readUnit(upstreamSpace, upstreamSlug);
      check(downstream && upstream, `${space}/${slug}: UpgradeUnit endpoint is missing`);
      check(link.UpdateType === "UpgradeUnit", `${space}/${slug}: expected UpgradeUnit, got ${link.UpdateType ?? "missing"}`);
      check(link.AutoUpdate !== true, `${space}/${slug}: UpgradeUnit Link must not auto-update during the explicit promotion scenario`);
      check(link.FromUnitID === downstream.UnitID, `${space}/${slug}: downstream endpoint drifted`);
      check(link.ToUnitID === upstream.UnitID, `${space}/${slug}: upstream endpoint drifted`);
      check(link.ToSpaceID === spaces.get(upstreamSpace)?.SpaceID, `${space}/${slug}: upstream Space drifted`);
    }
    if (requireNeedsProvides) {
      for (const slug of expectedNeedsProvides.keys()) {
        check(liveLinks.some((link) => link.Slug === slug), `${space}/${slug}: required NeedsProvides Link is missing`);
      }
    }
  }
}

function upsertUnit(expected, inputs, payloadFiles, state, { payloadKey = expected.payloadKey } = {}) {
  check(expected, "internal error: missing expected Unit definition");
  const payload = inputs.payloads.get(payloadKey);
  check(payload, `${expected.space}/${expected.slug}: payload ${payloadKey} is missing`);
  const path = payloadFiles.get(payloadKey);
  const annotations = {
    ...sourceAnnotation(payload.value, payload.sourcePaths, payload.transform),
    ...(expected.annotations ?? {}),
  };
  let current = readUnit(expected.space, expected.slug);
  if (!current) {
    check(!expected.upstream, `${expected.space}/${expected.slug}: variant Unit is missing; refusing partial clone repair`);
    cub([
      "unit", "create", "--space", expected.space,
      expected.slug, path,
      "--toolchain", expected.toolchain,
      ...(expected.provider ? ["--provider", expected.provider] : []),
      ...labelsArgs(expected.labels),
      ...annotationsArgs(annotations),
      "--change-desc", `Reconcile ${KUBARA_VERSION} mini-IDP source`,
      "--quiet",
    ], { timeout: 1_200_000 });
    recordAction(state, "unit-create", `${expected.space}/${expected.slug}`, payloadKey);
    state.changedSpaces.add(expected.space);
    current = readUnit(expected.space, expected.slug);
    check(current, `${expected.space}/${expected.slug}: created Unit is not observable`);
  } else {
    check(current.ToolchainType === expected.toolchain, `${expected.space}/${expected.slug}: toolchain ${current.ToolchainType} cannot be safely adopted`);
    const actualProvider = current.ProviderType ?? null;
    const expectedProvider = expected.provider ?? null;
    check(actualProvider === expectedProvider, `${expected.space}/${expected.slug}: provider ${actualProvider ?? "default"} cannot be safely adopted; expected ${expectedProvider ?? "default"}`);
    if (expected.upstream) {
      const [upstreamSpace, upstreamSlug] = expected.upstream.split("/");
      const upstream = readUnit(upstreamSpace, upstreamSlug);
      check(upstream?.UnitID, `${expected.space}/${expected.slug}: expected upstream ${expected.upstream} is missing`);
      check(
        current.UpstreamUnitID === upstream.UnitID,
        `${expected.space}/${expected.slug}: unsafe upstream mismatch; expected ${expected.upstream}, refusing partial variant repair`,
      );
    }
    if (!sameUnitData(expected.toolchain, readUnitData(expected.space, expected.slug), payload.value)) {
      cub([
        "unit", "update", "--space", expected.space,
        expected.slug, path,
        ...(expected.provider ? ["--provider", expected.provider] : []),
        "--change-desc", `Reconcile ${KUBARA_VERSION} mini-IDP source`,
        "--quiet",
      ], { timeout: 1_200_000 });
      recordAction(state, "unit-data", `${expected.space}/${expected.slug}`, payloadKey);
      state.changedSpaces.add(expected.space);
      current = readUnit(expected.space, expected.slug);
      check(current, `${expected.space}/${expected.slug}: updated Unit is not observable`);
    }
    const staleLabels = staleOwnedUnitLabels(current.Labels, expected.labels);
    const staleAnnotations = staleOwnedPublicAnnotations(current.Annotations, annotations);
    if (
      !mapMatches(current.Labels, expected.labels)
      || staleLabels.length > 0
      || !mapMatches(current.Annotations, annotations)
      || staleAnnotations.length > 0
      || (expected.provider && current.ProviderType !== expected.provider)
    ) {
      cub([
        "unit", "update", "--patch", "--space", expected.space,
        expected.slug,
        ...(expected.provider ? ["--provider", expected.provider] : []),
        ...labelsArgs(expected.labels),
        ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
        ...annotationsArgs(annotations),
        ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
        "--change-desc", `Reconcile ${KUBARA_VERSION} mini-IDP provenance`,
        "--quiet",
      ]);
      recordAction(state, "unit-metadata", `${expected.space}/${expected.slug}`);
      state.changedSpaces.add(expected.space);
      current = readUnit(expected.space, expected.slug);
      check(current, `${expected.space}/${expected.slug}: metadata-updated Unit is not observable`);
    }
  }

  if (expected.target) {
    const targetEntity = readTarget(expected.target.split("/")[0]);
    check(targetEntity?.TargetID, `${expected.target}: target is missing`);
    if (current.TargetID !== targetEntity.TargetID) {
      cub(["unit", "set-target", "--space", expected.space, expected.slug, expected.target, "--quiet"]);
      recordAction(state, "unit-target", `${expected.space}/${expected.slug}`, expected.target);
      state.changedSpaces.add(expected.space);
    }
  } else if (current.TargetID) {
    cub(["unit", "set-target", "--space", expected.space, expected.slug, "-", "--quiet"]);
    recordAction(state, "unit-target-clear", `${expected.space}/${expected.slug}`);
    state.changedSpaces.add(expected.space);
  }

  if (expected.prodProtected) ensureUnitProtection(expected.space, expected.slug, state, current);
}

function upsertScenarioUnitAtomically(expected, inputs, payloadFiles, state, payloadKey) {
  check(expected, "internal error: missing expected scenario Unit definition");
  const ref = `${expected.space}/${expected.slug}`;
  const payload = inputs.payloads.get(payloadKey);
  const path = payloadFiles.get(payloadKey);
  check(payload && path, `${ref}: scenario payload ${payloadKey} is not materialized`);
  const live = readUnit(expected.space, expected.slug);
  check(live, `${ref}: scenario Unit is missing`);
  check(live.ToolchainType === expected.toolchain, `${ref}: scenario toolchain drifted`);
  check((live.ProviderType ?? null) === (expected.provider ?? null), `${ref}: scenario provider drifted`);
  if (expected.target) {
    const target = readTarget(expected.target.split("/")[0]);
    check(target?.TargetID && live.TargetID === target.TargetID, `${ref}: scenario target drifted`);
  } else check(!live.TargetID, `${ref}: untargeted scenario Unit gained a target`);
  if (expected.upstream) {
    const [upstreamSpace, upstreamSlug] = expected.upstream.split("/");
    const upstream = readUnit(upstreamSpace, upstreamSlug);
    check(upstream?.UnitID && live.UpstreamUnitID === upstream.UnitID, `${ref}: scenario upstream drifted`);
  } else check(!live.UpstreamUnitID, `${ref}: scenario definition gained an upstream`);

  const annotations = {
    ...sourceAnnotation(payload.value, payload.sourcePaths, payload.transform),
    ...(expected.annotations ?? {}),
  };
  const staleLabels = staleOwnedUnitLabels(live.Labels, expected.labels);
  const staleAnnotations = staleOwnedPublicAnnotations(live.Annotations, annotations);
  const dataMatches = sameUnitData(
    expected.toolchain,
    readUnitData(expected.space, expected.slug),
    payload.value,
  );
  const metadataMatches = mapMatches(live.Labels, expected.labels)
    && staleLabels.length === 0
    && mapMatches(live.Annotations, annotations)
    && staleAnnotations.length === 0;
  if (dataMatches && metadataMatches) return;

  cub([
    "unit", "update", "--space", expected.space,
    expected.slug, path,
    ...(expected.provider ? ["--provider", expected.provider] : []),
    ...labelsArgs(expected.labels),
    ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
    ...annotationsArgs(annotations),
    ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
    "--change-desc", `Reconcile atomic ${SCENARIO_VERSION} transition ${payloadKey}`,
    "--quiet",
  ], { timeout: 1_200_000 });
  recordAction(state, "unit-data", ref, `${payloadKey}; atomic scenario data+provenance`);
  state.changedSpaces.add(expected.space);
}

function sameUnitData(toolchain, actual, expected) {
  if (toolchain === "Kubernetes/YAML") return canonicalDocuments(actual) === canonicalDocuments(expected);
  if (toolchain === "AppConfig/JSON") return stableJson(JSON.parse(actual)) === stableJson(JSON.parse(expected));
  return canonicalYamlDocument(actual) === canonicalYamlDocument(expected);
}

function canonicalDocuments(text) {
  return memoizedCanonicalYaml("documents", text, () => (
    parseDocs(text).sort((left, right) => identityFor(left).localeCompare(identityFor(right)))
  ));
}

function canonicalYamlDocument(text) {
  return memoizedCanonicalYaml("document", text, () => readYamlText(text));
}

function memoizedCanonicalYaml(kind, text, parse) {
  canonicalYamlPerformance.requests += 1;
  const digest = sha256(text);
  const key = `${kind}/${digest}`;
  const signature = {
    length: text.length,
    head: text.slice(0, 64),
    tail: text.slice(-64),
  };
  const cached = canonicalYamlCache.get(key);
  if (cached) {
    check(
      stableJson(cached.signature) === stableJson(signature),
      `canonical YAML cache collision for ${kind}/${digest}`,
    );
    canonicalYamlPerformance.hits += 1;
    return cached.value;
  }
  canonicalYamlPerformance.misses += 1;
  const startedAt = performance.now();
  const value = stableJson(parse());
  canonicalYamlPerformance.parseMs += performance.now() - startedAt;
  canonicalYamlCache.set(key, { signature, value });
  return value;
}

function gateEnabled(value, name) {
  if (Array.isArray(value)) return value.includes(name);
  return value?.[name] === true;
}

function ensureUnitProtection(space, slug, state, _observedUnit = null) {
  const unit = readUnit(space, slug);
  check(unit, `${space}/${slug}: Unit is missing before protection reconciliation`);
  if (gateEnabled(unit.DeleteGates, PROD_SAFETY_GATE) && gateEnabled(unit.DestroyGates, PROD_SAFETY_GATE)) return;
  cub([
    "unit", "update", "--patch", "--space", space, slug,
    "--delete-gate", PROD_SAFETY_GATE,
    "--destroy-gate", PROD_SAFETY_GATE,
    "--change-desc", "Protect production mini-IDP configuration",
    "--quiet",
  ]);
  recordAction(state, "unit-protection", `${space}/${slug}`);
  state.changedSpaces.add(space);
}

function ensureArgoApplication(deployment, state, { assertOnly = false } = {}) {
  check(deployment, "internal error: deployment definition missing");
  const existing = readUnit(deployment.appSpace, deployment.appUnit);
  check(existing, `${deployment.appSpace}/${deployment.appUnit}: Argo Application Unit missing; refusing partial variant repair`);
  const targetEntity = readTarget(deployment.cluster);
  check(targetEntity?.TargetID, `${deployment.cluster}/target: target is missing`);
  check(existing.TargetID === targetEntity.TargetID, `${deployment.appSpace}/${deployment.appUnit}: target is not ${deployment.cluster}/target`);
  const fleetItem = FLEET.find((item) => item.cluster === deployment.cluster);
  check(fleetItem, `${deployment.cluster}: fleet identity is missing`);
  reconcileApplicationUnitLabels(plan, fleetItem, deployment.appUnit, state, {
    assertOnly,
    observedUnit: existing,
  });
  const currentData = readUnitData(deployment.appSpace, deployment.appUnit);
  const docs = parseDocs(currentData);
  check(docs.length === 1 && docs[0].kind === "Application", `${deployment.appSpace}/${deployment.appUnit}: expected one Argo Application`);
  const app = docs[0];
  assertArgoApplicationContract(app, deployment, {
    allowMissingDestinationNamespace: true,
    allowAutomated: true,
  });
  app.spec ??= {};
  app.spec.destination = {
    server: "https://kubernetes.default.svc",
    namespace: deployment.destinationNamespace,
  };
  app.spec.syncPolicy = applicationSyncPolicy(deployment);
  if (deployment.ignoreInjectedCertificateData) {
    app.spec.ignoreDifferences = certificateIgnoreDifferences();
  } else delete app.spec.ignoreDifferences;
  const expected = renderDocuments([app]);
  if (sameUnitData("Kubernetes/YAML", currentData, expected)) return;
  check(!assertOnly, `${deployment.appSpace}/${deployment.appUnit}: Application contract drifted during an in-flight hx-web scenario`);
  const temp = mkdtempSync(join(tmpdir(), "helm-expt-kubara-argo-app-"));
  try {
    const path = join(temp, `${deployment.appUnit}.yaml`);
    writeFileSync(path, expected, "utf8");
    cub([
      "unit", "update", "--space", deployment.appSpace,
      deployment.appUnit, path,
      "--change-desc", "Preserve Kubara destination, prune, and bounded retry semantics",
      "--quiet",
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  recordAction(state, "argo-application", `${deployment.appSpace}/${deployment.appUnit}`);
  state.changedSpaces.add(deployment.appSpace);
}

function certificateIgnoreDifferences() {
  return [
    {
      group: "admissionregistration.k8s.io",
      kind: "MutatingWebhookConfiguration",
      jqPathExpressions: [".webhooks[]?.clientConfig.caBundle"],
    },
    {
      group: "admissionregistration.k8s.io",
      kind: "ValidatingWebhookConfiguration",
      jqPathExpressions: [".webhooks[]?.clientConfig.caBundle"],
    },
  ];
}

function applicationSyncOptions(deployment) {
  if (deployment.deliveryRoot) return rootApplicationSyncOptions();
  return [
    "CreateNamespace=false",
    "PruneLast=true",
    "FailOnSharedResource=true",
    "RespectIgnoreDifferences=true",
    "ApplyOutOfSyncOnly=true",
    ...(deployment.serverSideApply ? ["ServerSideApply=true"] : []),
  ];
}

function deliveryRootDeployment(cluster) {
  const space = `${cluster}-argo-apps`;
  return {
    id: `${space}-root`,
    type: "delivery-root",
    deliveryRoot: true,
    cluster,
    space,
    appSpace: space,
    appUnit: space,
    destinationNamespace: "argocd",
    acceptedHealth: ["Healthy"],
  };
}

function assertDeliveryRootApplicationContract(app, deployment) {
  check(app.metadata?.name === deployment.space, `${deployment.cluster}/${deployment.space}: root Application metadata.name drifted`);
  check(app.metadata?.namespace === "argocd", `${deployment.cluster}/${deployment.space}: root Application namespace is not argocd`);
  check(app.spec?.project === "default", `${deployment.cluster}/${deployment.space}: root Application project drifted`);
  assertNoMultipleSources(app, `${deployment.cluster}/${deployment.space}: root Application`);
  assertExactObjectKeys(app.spec?.source, ["path", "repoURL", "targetRevision"], `${deployment.cluster}/${deployment.space}: root source`);
  assertExactObjectKeys(app.spec?.destination, ["namespace", "server"], `${deployment.cluster}/${deployment.space}: root destination`);
  check(
    app.spec?.source?.repoURL === `${CONFIGHUB_OCI_SPACE_PREFIX}${deployment.space}`
      && app.spec?.source?.targetRevision === "latest"
      && app.spec?.source?.path === ".",
    `${deployment.cluster}/${deployment.space}: root Application source drifted`,
  );
  check(
    app.spec?.destination?.server === "https://kubernetes.default.svc"
      && app.spec?.destination?.namespace === "argocd",
    `${deployment.cluster}/${deployment.space}: root Application destination drifted`,
  );
  check(!app.spec?.syncPolicy?.automated, `${deployment.cluster}/${deployment.space}: root Application must not automatically deploy :latest`);
  check(
    stableJson(app.spec?.syncPolicy?.syncOptions ?? []) === stableJson(rootApplicationSyncOptions()),
    `${deployment.cluster}/${deployment.space}: root Application sync options drifted`,
  );
}

function applicationRetryPolicy() {
  return {
    limit: 5,
    backoff: {
      duration: "5s",
      factor: 2,
      maxDuration: "1m",
    },
  };
}

function applicationSyncPolicy(deployment) {
  return {
    syncOptions: applicationSyncOptions(deployment),
    retry: applicationRetryPolicy(),
  };
}

function assertArgoApplicationContract(
  app,
  deployment,
  { allowMissingDestinationNamespace = false, allowAutomated = false } = {},
) {
  if (deployment.deliveryRoot) {
    assertDeliveryRootApplicationContract(app, deployment);
    return;
  }
  check(app.metadata?.name === deployment.appUnit, `${deployment.appSpace}/${deployment.appUnit}: Application metadata.name drifted`);
  check(app.metadata?.namespace === "argocd", `${deployment.appSpace}/${deployment.appUnit}: Application namespace is not argocd`);
  check(app.spec?.project === "default", `${deployment.appSpace}/${deployment.appUnit}: Application project is not default`);
  assertNoMultipleSources(app, `${deployment.appSpace}/${deployment.appUnit}: Application`);
  assertExactObjectKeys(app.spec?.source, ["path", "repoURL", "targetRevision"], `${deployment.appSpace}/${deployment.appUnit}: source`);
  check(
    app.spec?.source?.repoURL === `${CONFIGHUB_OCI_SPACE_PREFIX}${deployment.space}`,
    `${deployment.appSpace}/${deployment.appUnit}: Application source is not the allowlisted ConfigHub Space ${deployment.space}`,
  );
  check(app.spec?.source?.targetRevision === "latest", `${deployment.appSpace}/${deployment.appUnit}: Application targetRevision is not latest`);
  check(app.spec?.source?.path === ".", `${deployment.appSpace}/${deployment.appUnit}: Application source path is not .`);
  check(
    app.spec?.destination?.server === "https://kubernetes.default.svc",
    `${deployment.appSpace}/${deployment.appUnit}: Application destination is not the cluster-local API`,
  );
  const actualNamespace = app.spec?.destination?.namespace;
  assertExactObjectKeys(
    app.spec?.destination,
    allowMissingDestinationNamespace && actualNamespace == null ? ["server"] : ["namespace", "server"],
    `${deployment.appSpace}/${deployment.appUnit}: destination`,
  );
  check(
    actualNamespace === deployment.destinationNamespace
      || (allowMissingDestinationNamespace && actualNamespace == null),
    `${deployment.appSpace}/${deployment.appUnit}: Application destination namespace is not ${deployment.destinationNamespace}`,
  );
  if (!allowAutomated) {
    check(
      !app.spec?.syncPolicy?.automated,
      `${deployment.appSpace}/${deployment.appUnit}: automated sync bypasses ConfigHub's exact-digest release authority`,
    );
  }
}

function reconcileProdPolicies(desired, state, { requireAll = true, assertOnly = false } = {}) {
  const filter = unwrapEntity(cubJson(["filter", "get", "--space", CONTROL_SPACE, APPROVAL_FILTER]), "Filter");
  check(filter?.FilterID, `${CONTROL_SPACE}/${APPROVAL_FILTER}: filter ID is missing`);
  const trigger = unwrapEntity(cubJson(["trigger", "get", "--space", CONTROL_SPACE, APPROVAL_TRIGGER]), "Trigger");
  check(trigger?.TriggerID, `${CONTROL_SPACE}/${APPROVAL_TRIGGER}: trigger ID is missing`);
  let knownSpaces = readSpaces();
  const control = knownSpaces.get(CONTROL_SPACE);
  check(control?.SpaceID, `${CONTROL_SPACE}: Space ID is missing`);
  const legacyControlWhere = `SpaceID = '${control.SpaceID}'`;
  const prodSpaces = desired.spaces.filter((item) => item.prodProtected);
  for (const expected of prodSpaces) {
    if (!knownSpaces.has(expected.slug) && !requireAll) continue;
    check(knownSpaces.has(expected.slug), `${expected.slug}: production Space is missing`);
    const live = knownSpaces.get(expected.slug);
    const whereTrigger = live.WhereTrigger ?? "";
    const triggerFilterID = live.TriggerFilterID ?? "";
    const selectedTriggers = [...(live.TriggerIDs ?? [])].sort();
    const ownedFilterAttached = triggerFilterID === filter.FilterID && !whereTrigger;
    const triggerSelectionExact = stableJson(selectedTriggers) === stableJson([trigger.TriggerID]);
    const alreadyExact = ownedFilterAttached && triggerSelectionExact;
    const unconfigured = !triggerFilterID && !whereTrigger && selectedTriggers.length === 0;
    const legacyUpstreamSpaceID = expected.upstreamSpace
      ? knownSpaces.get(expected.upstreamSpace)?.SpaceID
      : null;
    const recognizedLegacyWheres = new Set([
      legacyControlWhere,
      ...(legacyUpstreamSpaceID ? [`SpaceID = '${legacyUpstreamSpaceID}'`] : []),
    ]);
    const recognizedLegacy = !triggerFilterID
      && recognizedLegacyWheres.has(whereTrigger)
      && selectedTriggers.every((id) => id === trigger.TriggerID);
    check(
      ownedFilterAttached || unconfigured || recognizedLegacy,
      `${expected.slug}: refusing to replace an unowned Trigger policy (${stableJson({ triggerFilterID, whereTrigger, selectedTriggers })})`,
    );
    if (!alreadyExact) {
      check(!assertOnly, `${expected.slug}: production policy drifted during an in-flight hx-web scenario`);
      if (!ownedFilterAttached) {
        cub([
          "space", "update", "--patch", expected.slug,
          "--trigger-filter", `${CONTROL_SPACE}/${APPROVAL_FILTER}`,
          "--where-trigger", "-",
          "--quiet",
        ]);
        knownSpaces = readSpaces();
      }
      cub([
        "space", "update", "--patch", expected.slug,
        "--refresh-triggers", "--quiet",
      ]);
      recordAction(state, "approval-policy", expected.slug, `${CONTROL_SPACE}/${APPROVAL_FILTER}`);
      knownSpaces = readSpaces();
    }
    const refreshed = readSpaces().get(expected.slug);
    check(refreshed, `${expected.slug}: production Space disappeared while reconciling approval policy`);
    check(refreshed.TriggerFilterID === filter.FilterID && !(refreshed.WhereTrigger ?? ""), `${expected.slug}: production approval Filter did not attach exactly`);
    check(stableJson([...(refreshed.TriggerIDs ?? [])].sort()) === stableJson([trigger.TriggerID]), `${expected.slug}: production Trigger selection is not exactly ${CONTROL_SPACE}/${APPROVAL_TRIGGER}`);
    for (const unit of readUnitRows(expected.slug)) {
      if (assertOnly) {
        check(
          gateEnabled(unit.DeleteGates, PROD_SAFETY_GATE)
            && gateEnabled(unit.DestroyGates, PROD_SAFETY_GATE),
          `${expected.slug}/${unit.Slug}: production protection drifted during an in-flight hx-web scenario`,
        );
      } else ensureUnitProtection(expected.slug, unit.Slug, state);
    }
  }
}

function scenarioMarkerStatus() {
  const spaces = readSpaces();
  const expected = ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)];
  const marked = expected.filter((slug) => spaces.get(slug)?.Labels?.ScenarioVersion === SCENARIO_VERSION);
  return { expected, marked, complete: marked.length === expected.length };
}

function scenarioSpacesMarked() {
  return scenarioMarkerStatus().complete;
}

function readPriorReceipt() {
  if (!existsSync(RECEIPT_PATH)) return null;
  try {
    return readYaml(RECEIPT_PATH);
  } catch (error) {
    check(false, `prior mini-IDP receipt is unreadable at ${RECEIPT_PATH}: ${error.message}`);
  }
}

function applyAttemptLedgerHeader() {
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPApplyAttemptLedger",
    metadata: { name: "kubara-v0-13-0-confighub-mini-idp-attempts" },
    spec: {
      organizationExternalID: ORGANIZATION_EXTERNAL_ID,
      organizationEntityID: ORGANIZATION_ENTITY_ID,
      serverURL: CONFIGHUB_SERVER_URL,
    },
  };
}

function readApplyAttemptLedger({ allowMissing = true } = {}) {
  if (!existsSync(APPLY_ATTEMPTS_PATH)) {
    check(allowMissing, `${relativeRepo(APPLY_ATTEMPTS_PATH)} is missing`);
    return { ...applyAttemptLedgerHeader(), attempts: [] };
  }
  const ledger = readYaml(APPLY_ATTEMPTS_PATH);
  const header = applyAttemptLedgerHeader();
  check(ledger.apiVersion === header.apiVersion && ledger.kind === header.kind, "mini-IDP apply attempt ledger kind drifted");
  check(stableJson(ledger.metadata) === stableJson(header.metadata), "mini-IDP apply attempt ledger metadata drifted");
  check(stableJson(ledger.spec) === stableJson(header.spec), "mini-IDP apply attempt ledger organization boundary drifted");
  check(Array.isArray(ledger.attempts), "mini-IDP apply attempt ledger rows are invalid");
  let priorSequence = 0;
  for (const item of ledger.attempts) {
    check(Number.isInteger(item.sequence) && item.sequence === priorSequence + 1, "mini-IDP apply attempt sequences are not contiguous");
    check(UUID_PATTERN.test(item.id ?? ""), `mini-IDP apply attempt ${item.sequence} ID is invalid`);
    check(/^sha256:[0-9a-f]{64}$/.test(item.executionFingerprint ?? ""), `mini-IDP apply attempt ${item.sequence} fingerprint is invalid`);
    check(Number.isFinite(Date.parse(item.startedAt ?? "")), `mini-IDP apply attempt ${item.sequence} startedAt is invalid`);
    check(["active", "pass", "failed", "interrupted"].includes(item.result), `mini-IDP apply attempt ${item.sequence} result is invalid`);
    if (item.result === "active") {
      check(!item.completedAt, `mini-IDP apply attempt ${item.sequence} active row has completedAt`);
    } else {
      check(Number.isFinite(Date.parse(item.completedAt ?? "")), `mini-IDP apply attempt ${item.sequence} completedAt is invalid`);
      check(Date.parse(item.completedAt) >= Date.parse(item.startedAt), `mini-IDP apply attempt ${item.sequence} completed before it started`);
    }
    priorSequence = item.sequence;
  }
  check(
    ledger.attempts.filter((item) => item.result === "active").length <= 1
      && (!ledger.attempts.some((item) => item.result === "active") || ledger.attempts.at(-1)?.result === "active"),
    "mini-IDP apply attempt ledger has a non-terminal active row",
  );
  return ledger;
}

function writeYamlAtomically(path, value, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, toYaml(value), { encoding: "utf8", ...(mode ? { mode } : {}) });
  renameSync(temp, path);
}

function writeApplyAttemptLedger(ledger) {
  writeYamlAtomically(APPLY_ATTEMPTS_PATH, ledger, { mode: 0o600 });
}

function invalidateReceiptForAttempt(attempt, result) {
  if (!existsSync(RECEIPT_PATH)) return;
  const receipt = readYaml(RECEIPT_PATH);
  check(receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", "refusing to invalidate an unknown mini-IDP receipt kind");
  receipt.status = {
    ...(receipt.status ?? {}),
    result,
    deterministicReconciliationProven: false,
    idempotentRerunProven: false,
    latestApplyAttempt: {
      sequence: attempt.sequence,
      id: attempt.id,
      result,
      observedAt: new Date().toISOString(),
    },
  };
  delete receipt.status.performanceResult;
  delete receipt.status.performanceAcceptance;
  delete receipt.status.performanceAcceptedAt;
  writeReceiptAtomically(receipt);
}

function beginApplyAttempt() {
  const ledger = readApplyAttemptLedger();
  const now = new Date().toISOString();
  const active = ledger.attempts.at(-1);
  if (active?.result === "active") {
    active.result = "interrupted";
    active.completedAt = now;
    active.detail = "prior process ended without a terminal attempt record";
  }
  const attempt = {
    sequence: (ledger.attempts.at(-1)?.sequence ?? 0) + 1,
    id: randomUUID(),
    executionFingerprint: operationExecutionFingerprint(),
    startedAt: now,
    result: "active",
  };
  ledger.attempts.push(attempt);
  writeApplyAttemptLedger(ledger);
  invalidateReceiptForAttempt(attempt, "invalidated-by-active-attempt");
  return { ...attempt };
}

function completeApplyAttempt(attempt, fields) {
  const ledger = readApplyAttemptLedger({ allowMissing: false });
  const current = ledger.attempts.at(-1);
  check(
    current?.sequence === attempt.sequence
      && current.id === attempt.id
      && (current.result === "active" || (current.result === "pass" && fields.result === "failed")),
    "mini-IDP apply attempt continuity changed before terminal recording",
  );
  Object.assign(current, fields, { completedAt: new Date().toISOString() });
  check(["pass", "failed"].includes(current.result), "mini-IDP apply terminal result is invalid");
  writeApplyAttemptLedger(ledger);
  return { ...current };
}

function failApplyAttempt(attempt, error, state, measurement) {
  if (!attempt) return;
  const performance = state?.runPerformance
    ?? (measurement ? reconcilePerformanceEvidence(measurement, state, { complete: false }) : null);
  if (performance && !performance.applyReadCache) {
    const applyReadCache = currentApplyReadEvidence();
    if (applyReadCache) performance.applyReadCache = applyReadCache;
  }
  completeApplyAttempt(attempt, {
    result: "failed",
    runClass: "incomplete-apply",
    actionCount: state?.actions?.length ?? 0,
    error: String(error?.message ?? error).slice(0, 1000),
    ...(performance ? { performance } : {}),
  });
  invalidateReceiptForAttempt(attempt, "invalidated-by-failed-attempt");
}

function successfulAttemptPairValid(runs, ledger) {
  const [changed, noop] = runs.slice(-2);
  if (!changed || !noop) return false;
  const attempts = new Map(ledger.attempts.map((item) => [item.sequence, item]));
  const changedAttempt = attempts.get(changed.attemptSequence);
  const noopAttempt = attempts.get(noop.attemptSequence);
  return Number(noop.attemptSequence) === Number(changed.attemptSequence) + 1
    && changedAttempt?.id === changed.attemptID
    && noopAttempt?.id === noop.attemptID
    && changedAttempt.result === "pass"
    && noopAttempt.result === "pass"
    && ledger.attempts.at(-1)?.sequence === noop.attemptSequence;
}

function prospectiveAttemptPairValid(runs, ledger, currentAttempt) {
  const [changed, noop] = runs.slice(-2);
  if (!changed || !noop) return false;
  const changedAttempt = ledger.attempts.find((item) => item.sequence === changed.attemptSequence);
  const latest = ledger.attempts.at(-1);
  return Number(noop.attemptSequence) === Number(changed.attemptSequence) + 1
    && changedAttempt?.id === changed.attemptID
    && changedAttempt.result === "pass"
    && latest?.sequence === currentAttempt.sequence
    && latest.id === currentAttempt.id
    && latest.result === "active"
    && noop.attemptSequence === currentAttempt.sequence
    && noop.attemptID === currentAttempt.id;
}

function assertAttemptLedgerCurrentForReceipt(receipt) {
  const ledger = readApplyAttemptLedger({ allowMissing: false });
  const runs = receipt.spec?.reconcileRuns ?? [];
  const latestRun = runs.at(-1);
  const latestAttempt = ledger.attempts.at(-1);
  check(latestAttempt?.result === "pass", "latest mini-IDP apply attempt is not a pass; prior receipt evidence is invalidated");
  check(
    latestRun?.attemptSequence === latestAttempt.sequence
      && latestRun?.attemptID === latestAttempt.id,
    "mini-IDP receipt is not bound to the latest durable apply attempt",
  );
  if (receipt.status?.idempotentRerunProven === true) {
    check(successfulAttemptPairValid(runs, ledger), "mini-IDP changed/no-op proof is not a consecutive durable attempt pair");
  }
  return ledger;
}

function writeReceiptAtomically(receipt) {
  writeYamlAtomically(RECEIPT_PATH, receipt);
}

function assertNamespaceMoveEvidenceRow(item, prefix = "namespace-move evidence", { requireComplete = true } = {}) {
  check(
    item.migrationID === NAMESPACE_MOVE_MIGRATION_ID
      && item.ref === "hx-app-dev/DaemonSet/default/kube-prometheus-stack-prometheus-node-exporter"
      && item.application === "hx-app-dev/hx-kps-main-dev"
      && item.apiVersion === "apps/v1"
      && item.kind === "DaemonSet"
      && item.name === "kube-prometheus-stack-prometheus-node-exporter"
      && item.fromNamespace === "default"
      && item.toNamespace === "kube-prometheus-stack",
    `${prefix} identity drifted`,
  );
  check(UUID_PATTERN.test(item.uid ?? ""), `${prefix} UID is missing`);
  const revision = item.state === "observed-gone" ? item.revisionAtDeletion : item.expectedRevision;
  check(/^sha256:[0-9a-f]{64}$/.test(revision ?? ""), `${prefix} authorization-time revision is invalid`);
  check(stableJson(item.conflictingBindings) === stableJson(["TCP/9100"]), `${prefix} binding drifted`);
  check(/^\d+$/.test(String(item.resourceVersion ?? "")), `${prefix} resourceVersion is invalid`);
  check(Number.isFinite(Date.parse(item.preparedAt ?? "")), `${prefix} preparedAt is invalid`);
  if (item.state === "observed-gone") {
    check(item.evidenceScope === "historical-migration-event", `${prefix} evidence scope drifted`);
    check(/^original-uid-gone(?:-replaced-by-[0-9a-f-]+)?$/.test(item.outcome ?? ""), `${prefix} outcome is invalid`);
    check(Number.isFinite(Date.parse(item.observedGoneAt ?? "")), `${prefix} observedGoneAt is invalid`);
  } else if (requireComplete) check(false, `${prefix} is not completed`);
  check(typeof item.reason === "string" && item.reason.length > 20, `${prefix} reviewed reason is missing`);
}

function validatedPriorNamespaceMoveEvidence() {
  const receipt = readPriorReceipt();
  if (!receipt) return [];
  const trusted = receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt"
    && receipt.spec?.organization?.name === ORGANIZATION
    && receipt.spec?.organization?.externalID === ORGANIZATION_EXTERNAL_ID
    && receipt.spec?.organization?.entityID === ORGANIZATION_ENTITY_ID
    && receipt.spec?.organization?.serverURL === CONFIGHUB_SERVER_URL;
  if (!trusted) return [];
  const rows = receipt.spec?.namespaceMovePrunes ?? [];
  check(rows.length <= 1, "prior receipt retains more than one namespace-move DaemonSet prune");
  for (const item of rows) assertNamespaceMoveEvidenceRow(item, "prior receipt namespace-move prune");
  return rows;
}

function validatedNamespaceMoveJournalAttempt() {
  const item = readOperationJournal().namespaceMove;
  if (!item) return null;
  assertNamespaceMoveEvidenceRow(item, "operation journal namespace-move attempt", { requireComplete: false });
  check(/^\d+$/.test(String(item.resourceVersion ?? "")), "operation journal namespace-move resourceVersion is invalid");
  check(
    ["prepared", "delete-returned", "observed-gone"].includes(item.state),
    "operation journal namespace-move state is invalid",
  );
  check(Number.isFinite(Date.parse(item.preparedAt ?? "")), "operation journal namespace-move preparedAt is invalid");
  return item;
}

function immutableSelectorMigrationsFor(deployment) {
  return deployment?.immutableSelectorReplacements ?? [];
}

function allImmutableSelectorReplacements(desired = plan) {
  return desired.deployments.flatMap((deployment) => (
    immutableSelectorMigrationsFor(deployment).map((migration) => ({ deployment, migration }))
  ));
}

function immutableSelectorContractForMigration(migrationID) {
  const contract = allImmutableSelectorReplacements().find(
    (item) => item.migration.migrationID === migrationID,
  );
  check(contract, `unknown immutable-selector migration ${migrationID}`);
  return contract;
}

function assertImmutableSelectorReplacementEvidence(
  item,
  prefix = "immutable-selector replacement evidence",
  { requireComplete = true } = {},
) {
  const { deployment, migration } = immutableSelectorContractForMigration(item?.migrationID);
  check(item.ref === immutableSelectorReplacementRef(deployment, migration), `${prefix}: resource identity drifted`);
  check(item.application === `${deployment.cluster}/${deployment.space}`, `${prefix}: Application identity drifted`);
  check(
    item.apiVersion === migration.apiVersion
      && item.kind === migration.kind
      && item.name === migration.name
      && item.namespace === migration.namespace,
    `${prefix}: Kubernetes kind identity drifted`,
  );
  check(stableJson(item.fromSelector) === stableJson(migration.fromSelector), `${prefix}: legacy selector drifted`);
  check(stableJson(item.toSelector) === stableJson(migration.toSelector), `${prefix}: reviewed selector drifted`);
  check(UUID_PATTERN.test(item.uid ?? "") && /^\d+$/.test(String(item.resourceVersion ?? "")), `${prefix}: old UID/resourceVersion is invalid`);
  check(Number.isFinite(Date.parse(item.preparedAt ?? "")), `${prefix}: preparedAt is invalid`);
  check(["preflight-reviewed-selector-mismatch", "recovered-resource-level-immutable-selector-failure"].includes(item.trigger), `${prefix}: trigger is invalid`);
  if (item.failureEvidencePolicy === IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY) {
    check(item.trigger === "recovered-resource-level-immutable-selector-failure", `${prefix}: v2 failure evidence has an invalid trigger`);
    const evidence = item.failureEvidence ?? {};
    const resource = evidence.resource ?? {};
    const { sha256: storedDigest, ...canonicalEvidence } = evidence;
    check(["Failed", "Error"].includes(evidence.phase), `${prefix}: failure phase is not terminal`);
    check(
      /^sha256:[0-9a-f]{64}$/.test(evidence.syncRevision ?? "")
        && evidence.operationRevision === evidence.syncRevision,
      `${prefix}: failure revision is not exact`,
    );
    check(
      resource.group === "apps"
        && resource.kind === migration.kind
        && resource.namespace === migration.namespace
        && resource.name === migration.name
        && resource.status === "SyncFailed"
        && resource.hookPhase === "Failed"
        && immutableSelectorFailureMessage(resource),
      `${prefix}: failure resource evidence drifted`,
    );
    check(
      storedDigest === `sha256:${sha256(stableJson(canonicalEvidence))}`,
      `${prefix}: failure evidence digest drifted`,
    );
  } else {
    check(
      item.state === "replacement-healthy"
        && Number.isFinite(Date.parse(item.completedAt ?? ""))
        && Date.parse(item.completedAt) < Date.parse(IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_EFFECTIVE_AT)
        && item.failureEvidence === undefined,
      `${prefix}: legacy selector evidence is not a completed pre-v2 migration`,
    );
  }
  check(item.reason === migration.reason, `${prefix}: reason drifted`);
  const retainedPVCs = item.retainedPVCs ?? [];
  check(
    retainedPVCs.length === (migration.retainedPVCNames ?? []).length
      && stableJson(retainedPVCs.map((pvc) => pvc.name)) === stableJson(migration.retainedPVCNames ?? [])
      && retainedPVCs.every((pvc) => UUID_PATTERN.test(pvc.uid ?? "") && pvc.volumeName && pvc.phase === "Bound"),
    `${prefix}: retained PVC evidence drifted`,
  );
  if (item.state === "replacement-healthy") {
    check(/^sha256:[0-9a-f]{64}$/.test(item.revisionAtReplacement ?? ""), `${prefix}: replacement revision is invalid`);
    check(UUID_PATTERN.test(item.replacementUID ?? "") && item.replacementUID !== item.uid, `${prefix}: replacement UID is invalid`);
    check(/^\d+$/.test(String(item.replacementResourceVersion ?? "")), `${prefix}: replacement resourceVersion is invalid`);
    check(Number(item.readyEndpoints) > 0, `${prefix}: ready EndpointSlice evidence is missing`);
    check(Number.isFinite(Date.parse(item.completedAt ?? "")), `${prefix}: completion time is invalid`);
  } else {
    check(["prepared", "delete-returned", "old-uid-gone"].includes(item.state), `${prefix}: journal state is invalid`);
    check(/^sha256:[0-9a-f]{64}$/.test(item.expectedRevision ?? ""), `${prefix}: expected revision is invalid`);
    if (requireComplete) check(false, `${prefix}: replacement is not complete`);
  }
}

function validatedPriorImmutableSelectorEvidence() {
  const receipt = readPriorReceipt();
  if (!receipt) return [];
  const trusted = receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt"
    && receipt.spec?.organization?.name === ORGANIZATION
    && receipt.spec?.organization?.externalID === ORGANIZATION_EXTERNAL_ID
    && receipt.spec?.organization?.entityID === ORGANIZATION_ENTITY_ID
    && receipt.spec?.organization?.serverURL === CONFIGHUB_SERVER_URL;
  if (!trusted) return [];
  const rows = receipt.spec?.immutableSelectorReplacements ?? [];
  check(rows.length <= allImmutableSelectorReplacements().length, "prior receipt retains too many immutable-selector replacements");
  check(new Set(rows.map((item) => item.migrationID)).size === rows.length, "prior receipt duplicates an immutable-selector replacement");
  for (const item of rows) assertImmutableSelectorReplacementEvidence(item, "prior receipt immutable-selector replacement");
  return rows;
}

function validatedImmutableSelectorJournalAttempts() {
  const rows = Object.entries(readOperationJournal().immutableSelectorReplacements ?? {})
    .map(([migrationID, item]) => {
      check(item?.migrationID === migrationID, `${migrationID}: immutable-selector journal key drifted`);
      assertImmutableSelectorReplacementEvidence(
        item,
        `${migrationID}: immutable-selector journal attempt`,
        { requireComplete: false },
      );
      return item;
    })
    .sort((left, right) => left.migrationID.localeCompare(right.migrationID));
  check(rows.length <= allImmutableSelectorReplacements().length, "operation journal retains too many immutable-selector attempts");
  return rows;
}

function protectedNamespaceContract(migrationID) {
  const contract = PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.find(
    (item) => item.migrationID === migrationID,
  );
  check(contract, `unknown protected Namespace ownership migration ${migrationID}`);
  return contract;
}

function assertProtectedNamespaceCurrentObservation(item, contract, prefix = "protected Namespace current observation") {
  check(item?.migrationID === contract.migrationID, `${prefix}: migration identity drifted`);
  check(item.cluster === contract.cluster, `${prefix}: cluster drifted`);
  check(item.application === `${contract.cluster}/${contract.application}`, `${prefix}: Application drifted`);
  check(item.namespace === contract.retainedNamespace, `${prefix}: retained Namespace drifted`);
  check(item.replacementNamespace === contract.replacementNamespace, `${prefix}: replacement Namespace drifted`);
  check(item.sourceUnit === `${contract.spaceSlug}/${contract.unitSlug}`, `${prefix}: source Unit drifted`);
  check(UUID_PATTERN.test(item.uid ?? ""), `${prefix}: retained Namespace UID is invalid`);
  check(UUID_PATTERN.test(item.replacementUID ?? ""), `${prefix}: replacement Namespace UID is invalid`);
  check(item.state === "retained-clean", `${prefix}: retained Namespace state is not clean`);
  check(item.phase === "Active", `${prefix}: retained Namespace is not Active`);
  check(item.ownershipFieldsAbsent === true, `${prefix}: obsolete ownership fields remain`);
  check(item.replacementTrackingID === contract.replacementTrackingID, `${prefix}: replacement tracking identity drifted`);
  check(
    Number.isInteger(item.replacementOriginRevision)
      && item.replacementOriginRevision > contract.legacyOriginRevision,
    `${prefix}: replacement origin revision is not newer than the legacy origin`,
  );
  check(Number.isFinite(Date.parse(item.observedAt ?? "")), `${prefix}: observedAt is invalid`);
}

function validatedPriorProtectedNamespaceEvidence() {
  const receipt = readPriorReceipt();
  if (!receipt) return [];
  const trusted = receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt"
    && receipt.spec?.organization?.name === ORGANIZATION
    && receipt.spec?.organization?.externalID === ORGANIZATION_EXTERNAL_ID
    && receipt.spec?.organization?.entityID === ORGANIZATION_ENTITY_ID
    && receipt.spec?.organization?.serverURL === CONFIGHUB_SERVER_URL;
  if (!trusted) return [];
  const rows = receipt.spec?.protectedNamespaceOwnershipDetachments ?? [];
  check(
    rows.length <= PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
    "prior receipt retains too many protected Namespace ownership detachments",
  );
  check(new Set(rows.map((item) => item.migrationID)).size === rows.length, "prior receipt duplicates a protected Namespace ownership migration");
  for (const item of rows) {
    assertProtectedNamespaceDetachmentEvidence(
      item,
      protectedNamespaceContract(item.migrationID),
    );
  }
  return rows;
}

function validatedProtectedNamespaceJournalAttempts() {
  const rows = Object.entries(readOperationJournal().protectedNamespaceDetachments ?? {})
    .map(([migrationID, item]) => {
      check(item?.migrationID === migrationID, `${migrationID}: protected Namespace journal key drifted`);
      assertProtectedNamespaceDetachmentEvidence(
        item,
        protectedNamespaceContract(migrationID),
        { requireComplete: false },
      );
      return item;
    })
    .sort((left, right) => left.migrationID.localeCompare(right.migrationID));
  check(
    rows.length <= PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
    "operation journal retains too many protected Namespace ownership attempts",
  );
  return rows;
}

function validatedScenarioJournal() {
  const item = readOperationJournal().scenario;
  if (!item) return null;
  if (item.version !== SCENARIO_VERSION) {
    check(item.state === "completed", "cannot migrate an in-flight hx-web scenario journal to a new version");
    updateOperationJournal((journal) => {
      journal.scenarioHistory ??= [];
      journal.scenarioHistory.push(item);
      journal.scenario = null;
    });
    return { state: "archived", archivedVersion: item.version, migrationApprovedByVersion: SCENARIO_VERSION };
  }
  check(
    item.sourceFingerprint === scenarioSourceFingerprint(),
    "operation journal hx-web source changed; review the new rollout contract and bump SCENARIO_VERSION before replay",
  );
  check(/^sha256:[0-9a-f]{64}$/.test(item.executionFingerprint ?? ""), "operation journal hx-web execution fingerprint is invalid");
  check(["started", "completed"].includes(item.state), "operation journal hx-web scenario state is invalid");
  check(Number.isFinite(Date.parse(item.startedAt ?? "")), "operation journal hx-web scenario start time is invalid");
  check(Array.isArray(item.completedSteps), "operation journal hx-web completed step list is invalid");
  check(
    item.completedSteps.every((step, index) => step === SCENARIO_STEPS[index]),
    "operation journal hx-web steps are not an exact ordered prefix",
  );
  check(Array.isArray(item.operationEvidence), "operation journal hx-web operation evidence is invalid");
  if (item.preparedStep) {
    check(
      item.preparedStep.id === SCENARIO_STEPS[item.completedSteps.length]
        && item.preparedStep.preCheckpoint
        && Number.isFinite(Date.parse(item.preparedStep.preparedAt ?? "")),
      "operation journal hx-web prepared step is invalid",
    );
    check(
      Array.isArray(item.preparedStep.completedTransitions)
        && item.preparedStep.completedTransitions.every((transition) => typeof transition === "string" && transition),
      "operation journal hx-web prepared transition prefix is invalid",
    );
    check(
      item.preparedStep.transitionCheckpoint && typeof item.preparedStep.transitionCheckpoint === "object",
      "operation journal hx-web prepared transition checkpoint is missing",
    );
    if (item.preparedStep.preparedTransition) {
      check(
        typeof item.preparedStep.preparedTransition.id === "string"
          && item.preparedStep.preparedTransition.preCheckpoint
          && Number.isFinite(Date.parse(item.preparedStep.preparedTransition.preparedAt ?? "")),
        "operation journal hx-web prepared nested transition is invalid",
      );
    }
  }
  check(item.checkpoint && typeof item.checkpoint === "object", "operation journal hx-web checkpoint is missing");
  check(Array.isArray(item.checkpoints), "operation journal hx-web checkpoint history is missing");
  check(
    item.checkpoints[0]?.id === "materialized"
      && item.completedSteps.every((step, index) => item.checkpoints[index + 1]?.id === step),
    "operation journal hx-web checkpoint history does not match completed steps",
  );
  if (item.state === "completed") {
    check(item.completedSteps.length === SCENARIO_STEPS.length, "completed hx-web scenario journal is missing steps");
    check(Number.isFinite(Date.parse(item.completedAt ?? "")), "completed hx-web scenario journal timestamp is invalid");
    check(
      scenarioOperationProofValid(item),
      "completed hx-web scenario journal lacks exact gate observation, approval, or rollback evidence bound to its checkpoints",
    );
  }
  return item;
}

function validatedFleetBootstrapJournal() {
  const item = readOperationJournal().fleetBootstrap;
  if (!item) return null;
  check(["started", "completed"].includes(item.state), "operation journal fleet-bootstrap state is invalid");
  check(
    stableJson(item.expectedClusters) === stableJson(FLEET.map((fleetItem) => fleetItem.cluster)),
    "operation journal fleet-bootstrap allowlist drifted",
  );
  check(Array.isArray(item.createdClusters), "operation journal fleet-bootstrap checkpoint list is invalid");
  check(
    Array.isArray(item.guardedPublishedSourceSpaces)
      && item.guardedPublishedSourceSpaces.every((slug) => typeof slug === "string" && slug),
    "operation journal fleet-bootstrap guarded source inventory is invalid",
  );
  check(
    item.createdClusters.every((cluster, index) => cluster === item.expectedClusters[index]),
    "operation journal fleet-bootstrap checkpoints are not an exact ordered prefix",
  );
  if (item.preparedCluster) {
    check(
      item.preparedCluster === item.expectedClusters[item.createdClusters.length],
      "operation journal prepared fleet cluster is out of order",
    );
  }
  check(Array.isArray(item.rootActivatedClusters), "operation journal fleet-root activation prefix is invalid");
  check(
    item.createdClusters.length === item.expectedClusters.length || item.rootActivatedClusters.length === 0,
    "operation journal activated a fleet root before the full cluster fleet existed",
  );
  check(
    item.rootActivatedClusters.every((cluster, index) => cluster === item.expectedClusters[index]),
    "operation journal fleet-root activation checkpoints are not an exact ordered prefix",
  );
  check(Array.isArray(item.rootReleases), "operation journal fleet-root release evidence is invalid");
  check(
    item.rootReleases.length === item.rootActivatedClusters.length
      && item.rootReleases.every((release, index) => (
        release.cluster === item.rootActivatedClusters[index]
          && release.appSpace === `${release.cluster}-argo-apps`
          && UUID_PATTERN.test(release.releaseID ?? "")
          && UUID_PATTERN.test(release.tagID ?? "")
          && Number.isInteger(release.releaseNum)
          && Number.isInteger(release.unitCount)
          && release.unitCount > 0
          && /^sha256:[0-9a-f]{64}$/.test(release.bundleDigest ?? "")
          && /^sha256:[0-9a-f]{64}$/.test(release.manifestDigest ?? "")
      )),
    "operation journal fleet-root release evidence does not match its activation prefix",
  );
  if (item.preparedRootCluster) {
    check(
      item.preparedRootCluster === item.expectedClusters[item.rootActivatedClusters.length],
      "operation journal prepared fleet root is out of order",
    );
  }
  check(Number.isFinite(Date.parse(item.startedAt ?? "")), "operation journal fleet-bootstrap start time is invalid");
  if (
    item.state === "started"
      && item.createdClusters.length === item.expectedClusters.length
      && !item.preparedCluster
      && item.rootActivatedClusters.length === item.expectedClusters.length
      && !item.preparedRootCluster
  ) {
    return completeFleetBootstrapJournal();
  }
  if (item.state === "completed") {
    check(
      item.createdClusters.length === item.expectedClusters.length
        && !item.preparedCluster
        && item.rootActivatedClusters.length === item.expectedClusters.length
        && !item.preparedRootCluster,
      "completed fleet-bootstrap journal is incomplete",
    );
    check(Number.isFinite(Date.parse(item.completedAt ?? "")), "operation journal fleet-bootstrap completion time is invalid");
  }
  return item;
}

function beginFleetBootstrapJournal(guardedSpaces) {
  const journal = updateOperationJournal((current) => {
    if (current.fleetBootstrap) return;
    current.fleetBootstrap = {
      state: "started",
      expectedClusters: FLEET.map((item) => item.cluster),
      createdClusters: [],
      preparedCluster: null,
      rootActivatedClusters: [],
      preparedRootCluster: null,
      rootReleases: [],
      guardedPublishedSourceSpaces: [...guardedSpaces].sort(),
      startedAt: new Date().toISOString(),
    };
  });
  return journal.fleetBootstrap;
}

function prepareFleetBootstrapCluster(cluster) {
  const journal = updateOperationJournal((current) => {
    const bootstrap = current.fleetBootstrap;
    check(bootstrap?.state === "started", `cannot prepare fleet bootstrap for ${cluster}`);
    const expected = bootstrap.expectedClusters[bootstrap.createdClusters.length];
    check(expected === cluster, `fleet bootstrap cluster ${cluster} is out of order; expected ${expected ?? "none"}`);
    check(!bootstrap.preparedCluster || bootstrap.preparedCluster === cluster, `another fleet cluster is already prepared: ${bootstrap.preparedCluster}`);
    bootstrap.preparedCluster = cluster;
  });
  return journal.fleetBootstrap;
}

function checkpointFleetBootstrapCluster(cluster) {
  const journal = updateOperationJournal((current) => {
    const bootstrap = current.fleetBootstrap;
    check(bootstrap?.state === "started" && bootstrap.preparedCluster === cluster, `fleet bootstrap cluster ${cluster} lacks write-ahead intent`);
    bootstrap.createdClusters.push(cluster);
    bootstrap.preparedCluster = null;
    bootstrap.updatedAt = new Date().toISOString();
  });
  return journal.fleetBootstrap;
}

function completeFleetBootstrapJournal() {
  const journal = updateOperationJournal((current) => {
    const bootstrap = current.fleetBootstrap;
    check(bootstrap?.state === "started", "fleet-bootstrap journal is not active at completion");
    check(
      bootstrap.createdClusters.length === bootstrap.expectedClusters.length
        && !bootstrap.preparedCluster
        && bootstrap.rootActivatedClusters.length === bootstrap.expectedClusters.length
        && !bootstrap.preparedRootCluster,
      "fleet-bootstrap journal cannot complete before all clusters and first delivery roots are active",
    );
    bootstrap.state = "completed";
    bootstrap.completedAt = new Date().toISOString();
  });
  return journal.fleetBootstrap;
}

function prepareFleetRootActivation(cluster) {
  const journal = updateOperationJournal((current) => {
    const bootstrap = current.fleetBootstrap;
    check(bootstrap?.state === "started", `cannot prepare fleet-root activation for ${cluster}`);
    check(bootstrap.createdClusters.length === bootstrap.expectedClusters.length, "cannot activate a fleet root before all persistent clusters exist");
    const expected = bootstrap.expectedClusters[bootstrap.rootActivatedClusters.length];
    check(expected === cluster, `fleet-root activation ${cluster} is out of order; expected ${expected ?? "none"}`);
    check(!bootstrap.preparedRootCluster || bootstrap.preparedRootCluster === cluster, `another fleet root is already prepared: ${bootstrap.preparedRootCluster}`);
    bootstrap.preparedRootCluster = cluster;
  });
  return journal.fleetBootstrap;
}

function checkpointFleetRootActivation(cluster, release) {
  const validated = validatedPublishedRelease(`${cluster}-argo-apps`, release, "fleet-root activation release");
  const evidence = {
    cluster,
    appSpace: `${cluster}-argo-apps`,
    releaseID: validated.ReleaseID,
    tagID: validated.TagID,
    releaseNum: Number(validated.ReleaseNum),
    unitCount: Number(validated.UnitCount),
    bundleDigest: validated.Digest,
    manifestDigest: validated.ManifestDigest,
  };
  const journal = updateOperationJournal((current) => {
    const bootstrap = current.fleetBootstrap;
    check(
      bootstrap?.state === "started" && bootstrap.preparedRootCluster === cluster,
      `fleet-root activation ${cluster} lacks write-ahead intent`,
    );
    bootstrap.rootActivatedClusters.push(cluster);
    bootstrap.rootReleases.push(evidence);
    bootstrap.preparedRootCluster = null;
    bootstrap.updatedAt = new Date().toISOString();
    if (bootstrap.rootActivatedClusters.length === bootstrap.expectedClusters.length) {
      bootstrap.state = "completed";
      bootstrap.completedAt = new Date().toISOString();
    }
  });
  return journal.fleetBootstrap;
}

function beginScenarioJournal() {
  const checkpoint = scenarioCheckpoint();
  const journal = updateOperationJournal((current) => {
    if (current.scenario) return;
    current.scenario = {
      version: SCENARIO_VERSION,
      sourceFingerprint: scenarioSourceFingerprint(),
      executionFingerprint: operationExecutionFingerprint(),
      state: "started",
      completedSteps: [],
      operationEvidence: [],
      checkpoint,
      checkpoints: [{ id: "materialized", facts: checkpoint }],
      startedAt: new Date().toISOString(),
    };
  });
  return journal.scenario;
}

function scenarioSourceFingerprint() {
  const payloads = [...inputs.payloads.values()]
    .filter((item) => item.key.startsWith("hx-web/"))
    .map((item) => ({ key: item.key, sha256: item.sha256 }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const contract = {
    version: SCENARIO_VERSION,
    orderedSteps: SCENARIO_STEPS,
    approval: {
      trigger: APPROVAL_TRIGGER,
      filter: APPROVAL_FILTER,
      gate: APPROVAL_GATE,
      productionProtection: PROD_SAFETY_GATE,
      exactHeadRevision: true,
    },
    promotion: "explicit UpgradeUnit promotion with downstream departures preserved",
    rollback: "prod-a exact reviewed v1 payload -> restore the exact initial-rollout revision -> exact reviewed two-replica payload",
    stagingDeparture: "SANDBOX_URL survives promotion-v2",
    targets: FLEET.map((item) => ({ cluster: item.cluster, suffix: item.suffix })),
    payloads,
  };
  return `sha256:${sha256(stableJson(contract))}`;
}

function recordScenarioJournalStep(id, actions) {
  const checkpoint = scenarioCheckpoint();
  const journal = updateOperationJournal((current) => {
    const scenario = current.scenario;
    check(scenario?.version === SCENARIO_VERSION && scenario.state === "started", `cannot checkpoint hx-web scenario step ${id}`);
    const expected = SCENARIO_STEPS[scenario.completedSteps.length];
    check(expected === id, `hx-web scenario step ${id} is out of order; expected ${expected ?? "none"}`);
    check(scenario.preparedStep?.id === id, `hx-web scenario step ${id} lacks write-ahead intent`);
    check(!scenario.preparedStep.preparedTransition, `hx-web scenario step ${id} still has a prepared nested transition`);
    check(
      stableJson(checkpoint) === stableJson(scenario.preparedStep.transitionCheckpoint),
      `hx-web scenario step ${id} ended outside its last durable nested-transition checkpoint`,
    );
    scenario.completedSteps.push(id);
    scenario.checkpoint = checkpoint;
    scenario.checkpoints.push({ id, facts: checkpoint });
    delete scenario.preparedStep;
    scenario.updatedAt = new Date().toISOString();
  });
  return journal.scenario;
}

function prepareScenarioJournalStep(id) {
  const journal = updateOperationJournal((current) => {
    const scenario = current.scenario;
    check(scenario?.version === SCENARIO_VERSION && scenario.state === "started", `cannot prepare hx-web scenario step ${id}`);
    const expected = SCENARIO_STEPS[scenario.completedSteps.length];
    check(expected === id, `hx-web scenario step ${id} is out of order; expected ${expected ?? "none"}`);
    if (scenario.preparedStep) {
      check(scenario.preparedStep.id === id, `another hx-web scenario step is already prepared: ${scenario.preparedStep.id}`);
      return;
    }
    scenario.preparedStep = {
      id,
      preCheckpoint: scenario.checkpoint,
      transitionCheckpoint: scenario.checkpoint,
      completedTransitions: [],
      preparedTransition: null,
      preparedAt: new Date().toISOString(),
    };
  });
  return journal.scenario;
}

function scenarioOperationEvidence(actions) {
  return actions.filter((item) => [
    "variant-promote",
    "approval-gate-observed",
    "unit-approve",
    "rollback",
  ].includes(item.type));
}

function runScenarioTransition(
  state,
  stepID,
  transitionID,
  mutate,
  assertPost,
  { recoveryEvidence = [] } = {},
) {
  let scenario = state.scenarioJournal;
  const preparedStep = scenario?.preparedStep;
  check(preparedStep?.id === stepID, `${stepID}/${transitionID}: scenario step is not prepared`);
  const completedIndex = preparedStep.completedTransitions.indexOf(transitionID);
  if (completedIndex >= 0) {
    check(
      completedIndex < preparedStep.completedTransitions.length,
      `${stepID}/${transitionID}: invalid completed transition index`,
    );
    return { journal: scenario, result: null, recovered: true, skipped: true };
  }
  check(
    !preparedStep.preparedTransition || preparedStep.preparedTransition.id === transitionID,
    `${stepID}/${transitionID}: another nested transition is prepared: ${preparedStep.preparedTransition?.id}`,
  );
  if (!preparedStep.preparedTransition) {
    const current = scenarioCheckpoint();
    const checkpointDifference = firstStableDifference(
      preparedStep.transitionCheckpoint,
      current,
    );
    check(
      !checkpointDifference,
      `${stepID}/${transitionID}: live state changed after the last durable nested-transition checkpoint: ${checkpointDifference}`,
    );
    const updated = updateOperationJournal((journal) => {
      const step = journal.scenario?.preparedStep;
      check(step?.id === stepID && !step.preparedTransition, `${stepID}/${transitionID}: cannot write nested-transition intent`);
      step.preparedTransition = {
        id: transitionID,
        preCheckpoint: current,
        preparedAt: new Date().toISOString(),
      };
    });
    scenario = updated.scenario;
    state.scenarioJournal = scenario;
  }

  const transition = scenario.preparedStep.preparedTransition;
  const before = transition.preCheckpoint;
  let current = scenarioCheckpoint();
  let result = null;
  let recovered = stableJson(current) !== stableJson(before);
  const actionOffset = state.actions.length;
  if (!recovered) {
    result = mutate();
    current = scenarioCheckpoint();
  }
  assertPost(before, current, { recovered, result });
  const rawEvidence = recovered
    ? (typeof recoveryEvidence === "function"
      ? recoveryEvidence(before, current)
      : recoveryEvidence)
    : scenarioOperationEvidence(state.actions.slice(actionOffset));
  const evidence = rawEvidence.map((item) => ({
    ...item,
    ...(recovered && !item.detail
      ? { detail: `recovered exact ${stepID}/${transitionID} post-state from write-ahead intent` }
      : {}),
    transitionID: item.transitionID ?? `${stepID}/${transitionID}`,
  }));
  const updated = updateOperationJournal((journal) => {
    const step = journal.scenario?.preparedStep;
    check(
      step?.id === stepID && step.preparedTransition?.id === transitionID,
      `${stepID}/${transitionID}: nested-transition write-ahead intent disappeared`,
    );
    check(
      stableJson(step.preparedTransition.preCheckpoint) === stableJson(before),
      `${stepID}/${transitionID}: nested-transition pre-checkpoint changed`,
    );
    step.completedTransitions.push(transitionID);
    step.transitionCheckpoint = current;
    step.preparedTransition = null;
    journal.scenario.operationEvidence.push(...evidence);
    journal.scenario.updatedAt = new Date().toISOString();
  });
  state.scenarioJournal = updated.scenario;
  return { journal: updated.scenario, result, recovered, skipped: false };
}

function completeScenarioJournal() {
  const checkpoint = scenarioCheckpoint();
  const journal = updateOperationJournal((current) => {
    const scenario = current.scenario;
    check(scenario?.version === SCENARIO_VERSION, "hx-web scenario journal is missing at completion");
    check(scenario.completedSteps.length === SCENARIO_STEPS.length, "hx-web scenario cannot complete before every step");
    scenario.state = "completed";
    scenario.checkpoint = checkpoint;
    const finalCheckpoint = scenario.checkpoints.find((item) => item.id === "final-normalized");
    if (finalCheckpoint) finalCheckpoint.facts = checkpoint;
    else scenario.checkpoints.push({ id: "final-normalized", facts: checkpoint });
    scenario.completedAt ??= new Date().toISOString();
  });
  return journal.scenario;
}

function scenarioCheckpoint() {
  const spaces = ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)];
  return withAuthoritativeReleaseBoundarySnapshot("hx-web-scenario-checkpoint", {
    unitSpaces: spaces,
    targetSpaces: [],
    linkSpaces: spaces,
    releaseSpaces: FLEET.map((item) => `hx-web-${item.suffix}`),
  }, () => scenarioCheckpointFromAuthoritativeSnapshot(spaces));
}

function scenarioCheckpointFromAuthoritativeSnapshot(spaces) {
  const liveSpaces = readSpaces();
  const units = [];
  for (const space of spaces) {
    for (const unit of readUnitRows(space).sort((left, right) => left.Slug.localeCompare(right.Slug))) {
      units.push({
        ref: `${space}/${unit.Slug}`,
        id: unit.UnitID,
        headRevisionNum: unit.HeadRevisionNum,
        ...(unit.LastAppliedRevisionNum === undefined || unit.LastAppliedRevisionNum === null
          ? {}
          : { lastAppliedRevisionNum: unit.LastAppliedRevisionNum }),
        dataHash: unit.DataHash,
        targetID: unit.TargetID ?? null,
        upstreamUnitID: unit.UpstreamUnitID ?? null,
        toolchain: unit.ToolchainType,
        provider: unit.ProviderType ?? null,
        ownedLabels: Object.fromEntries([...OWNED_UNIT_LABELS]
          .filter((key) => unit.Labels?.[key] !== undefined)
          .sort()
          .map((key) => [key, unit.Labels[key]])),
        ownedAnnotations: Object.fromEntries([...OWNED_PUBLIC_ANNOTATIONS]
          .filter((key) => unit.Annotations?.[key] !== undefined)
          .sort()
          .map((key) => [key, unit.Annotations[key]])),
        deleteGates: unit.DeleteGates ?? {},
        destroyGates: unit.DestroyGates ?? {},
        approvalCount: approvalCount(unit.ApprovedBy),
        applyGates: unit.ApplyGates ?? {},
      });
    }
  }
  const releases = FLEET.map((item) => {
    const space = `hx-web-${item.suffix}`;
    const release = latestRelease(space);
    return {
      space,
      releaseNum: release?.ReleaseNum ?? null,
      bundleDigest: release?.Digest ?? null,
      manifestDigest: release?.ManifestDigest ?? null,
    };
  });
  const upgradeLinks = FLEET.flatMap((item) => readLinks(`hx-web-${item.suffix}`)
    .filter((link) => link.UpdateType === "UpgradeUnit")
    .map((link) => ({
      ref: `hx-web-${item.suffix}/${link.Slug}`,
      id: link.LinkID,
      fromUnitID: link.FromUnitID,
      toUnitID: link.ToUnitID,
      toSpaceID: link.ToSpaceID,
      updateType: link.UpdateType,
      autoUpdate: link.AutoUpdate === true,
      upstreamLastMergedRevisionNum: link.UpstreamLastMergedRevisionNum,
      downstreamLastMergedRevisionNum: link.DownstreamLastMergedRevisionNum,
    }))).sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    sourceFingerprint: scenarioSourceFingerprint(),
    units,
    releases,
    upgradeLinks,
    spaceMarkers: spaces.map((slug) => ({
      slug,
      scenarioVersion: liveSpaces.get(slug)?.Labels?.ScenarioVersion ?? null,
    })),
  };
}

function assertScenarioCheckpoint(expected) {
  check(
    stableJson(scenarioCheckpoint()) === stableJson(expected),
    "hx-web live Unit heads, approvals, data hashes, releases, or UpgradeUnit merge bases changed after the last durable scenario checkpoint",
  );
}

// Preliminary ownership check only. This never authorizes a resumed mutation;
// each prepared nested transition below must still prove its exact full pre or
// reviewed post checkpoint before it can advance the journal.
function assertScenarioRecoveryIdentity(expected) {
  const current = scenarioCheckpoint();
  const immutableUnits = (facts) => facts.units.map((unit) => ({
    ref: unit.ref,
    id: unit.id,
    targetID: unit.targetID,
    upstreamUnitID: unit.upstreamUnitID,
    toolchain: unit.toolchain,
    provider: unit.provider,
    ownedLabels: unit.ownedLabels,
  }));
  const immutableLinks = (facts) => facts.upgradeLinks.map((link) => ({
    ref: link.ref,
    id: link.id,
    fromUnitID: link.fromUnitID,
    toUnitID: link.toUnitID,
    toSpaceID: link.toSpaceID,
    updateType: link.updateType,
    autoUpdate: link.autoUpdate,
  }));
  check(
    stableJson(immutableUnits(current)) === stableJson(immutableUnits(expected))
      && stableJson(immutableLinks(current)) === stableJson(immutableLinks(expected)),
    "hx-web immutable Unit identity, target, lineage, labels, or UpgradeUnit endpoints changed during a prepared scenario step",
  );
}

function scenarioCheckpointMaps(checkpoint) {
  return {
    units: new Map(checkpoint.units.map((item) => [item.ref, item])),
    releases: new Map(checkpoint.releases.map((item) => [item.space, item])),
    links: new Map(checkpoint.upgradeLinks.map((item) => [item.ref, item])),
    markers: new Map((checkpoint.spaceMarkers ?? []).map((item) => [item.slug, item])),
  };
}

function approvalEvidenceFromCheckpoints(before, after, space) {
  const left = scenarioCheckpointMaps(before).units;
  const right = scenarioCheckpointMaps(after).units;
  const approvedHeads = before.units
    .filter((item) => item.ref.startsWith(`${space}/`) && checkpointHasApprovalGate(item))
    .map((item) => {
      const current = right.get(item.ref);
      return {
        ref: item.ref,
        id: item.id,
        headRevisionNum: item.headRevisionNum,
        dataHash: item.dataHash,
        approvalCountBefore: item.approvalCount,
        approvalCountAfter: current?.approvalCount,
      };
    })
    .sort((leftItem, rightItem) => leftItem.ref.localeCompare(rightItem.ref));
  return { type: "unit-approve", ref: space, approvedHeads };
}

function rollbackEvidenceFromUnits(source, result, restored) {
  return {
    type: "rollback",
    ref: source.ref,
    unitID: source.id,
    restoredRevisionNum: restored.headRevisionNum,
    restoredDataHash: restored.dataHash,
    sourceHeadRevisionNum: source.headRevisionNum,
    sourceDataHash: source.dataHash,
    resultHeadRevisionNum: result.headRevisionNum,
    resultDataHash: result.dataHash,
  };
}

function scenarioOperationProofValid(scenario) {
  try {
    const checkpoints = new Map(
      (scenario?.checkpoints ?? []).map((item) => [item.id, item.facts]),
    );
    const initial = checkpoints.get("initial-rollout");
    const approved = checkpoints.get("prod-approval");
    const rolledBack = checkpoints.get("prod-a-rollback");
    if (!initial || !approved || !rolledBack) return false;
    const initialUnits = scenarioCheckpointMaps(initial).units;
    const approvedUnits = scenarioCheckpointMaps(approved).units;
    const rolledBackUnits = scenarioCheckpointMaps(rolledBack).units;
    const evidence = scenario?.operationEvidence ?? [];
    const headIdentity = (item) => ({
      ref: item.ref,
      id: item.id,
      headRevisionNum: Number(item.headRevisionNum),
      dataHash: item.dataHash,
    });

    for (const space of ["hx-web-prod-a", "hx-web-prod-b"]) {
      const gateObservation = evidence.find(
        (item) => item.type === "approval-gate-observed"
          && item.ref === space
          && item.transitionID === `base-promotion/${space}-approval-gate-observation`,
      );
      const approval = evidence.find(
        (item) => item.type === "unit-approve"
          && item.ref === space
          && item.transitionID === `prod-approval/${space}-approve-v1`,
      );
      if (
        gateObservation?.observationMode !== "read-only-authoritative-gate"
          || !gateObservation.gatedHeads?.length
          || !approval?.approvedHeads?.length
      ) return false;
      const gatedHeads = gateObservation.gatedHeads.map(headIdentity).sort((a, b) => a.ref.localeCompare(b.ref));
      const approvedHeads = approval.approvedHeads.map(headIdentity).sort((a, b) => a.ref.localeCompare(b.ref));
      if (stableJson(approvedHeads) !== stableJson(gatedHeads)) return false;
      for (const item of approval.approvedHeads) {
        const checkpointUnit = approvedUnits.get(item.ref);
        if (
          !checkpointUnit
            || checkpointUnit.id !== item.id
            || Number(checkpointUnit.headRevisionNum) !== Number(item.headRevisionNum)
            || checkpointUnit.dataHash !== item.dataHash
            || Number(item.approvalCountAfter) !== Number(item.approvalCountBefore) + 1
            || Number(checkpointUnit.approvalCount) !== Number(item.approvalCountAfter)
            || checkpointHasApprovalGate(checkpointUnit)
        ) return false;
      }
    }

    const ref = "hx-web-prod-a/hx-web-deployment";
    const rollback = evidence.find(
      (item) => item.type === "rollback"
        && item.ref === ref
        && item.transitionID === "prod-a-rollback/prod-a-restore-previous",
    );
    const initialUnit = initialUnits.get(ref);
    const sourceUnit = approvedUnits.get(ref);
    const finalUnit = rolledBackUnits.get(ref);
    const rollbackApproval = evidence.find(
      (item) => item.type === "unit-approve"
        && item.ref === "hx-web-prod-a"
        && item.transitionID === "prod-a-rollback/prod-a-approve-rollback",
    );
    const rollbackApprovedHead = rollbackApproval?.approvedHeads?.find((item) => item.ref === ref);
    if (!rollback || !initialUnit || !sourceUnit || !finalUnit) return false;
    const finalRevisionDelta = Number(finalUnit.headRevisionNum) - Number(rollback.resultHeadRevisionNum);
    const boundedApprovalRevision = finalRevisionDelta === 1
      || (
        finalRevisionDelta === 2
          && rollbackApprovedHead?.id === finalUnit.id
          && Number(rollbackApprovedHead.headRevisionNum) === Number(finalUnit.headRevisionNum)
          && rollbackApprovedHead.dataHash === finalUnit.dataHash
          && Number(rollbackApprovedHead.approvalCountAfter) === Number(rollbackApprovedHead.approvalCountBefore) + 1
          && Number(finalUnit.approvalCount) === Number(rollbackApprovedHead.approvalCountAfter)
      );
    return rollback.unitID === initialUnit.id
      && rollback.unitID === sourceUnit.id
      && rollback.unitID === finalUnit.id
      && Number(rollback.restoredRevisionNum) === Number(initialUnit.headRevisionNum)
      && rollback.restoredDataHash === initialUnit.dataHash
      && Number(rollback.sourceHeadRevisionNum) === Number(sourceUnit.headRevisionNum)
      && rollback.sourceDataHash === sourceUnit.dataHash
      && Number(rollback.resultHeadRevisionNum) === Number(rollback.sourceHeadRevisionNum) + 1
      && rollback.resultDataHash === rollback.restoredDataHash
      && boundedApprovalRevision
      && finalUnit.dataHash === rollback.resultDataHash;
  } catch {
    return false;
  }
}

function assertScenarioDeltaScope(
  before,
  after,
  { unitRefs = [], releaseSpaces = [], linkRefs = [], markerSpaces = [] } = {},
) {
  check(after.sourceFingerprint === before.sourceFingerprint, "hx-web scenario source fingerprint changed inside a transition");
  const left = scenarioCheckpointMaps(before);
  const right = scenarioCheckpointMaps(after);
  for (const [kind, allowedValues] of [
    ["units", unitRefs],
    ["releases", releaseSpaces],
    ["links", linkRefs],
    ["markers", markerSpaces],
  ]) {
    const allowed = new Set(allowedValues);
    check(
      stableJson([...left[kind].keys()]) === stableJson([...right[kind].keys()]),
      `hx-web ${kind} inventory changed inside a prepared transition`,
    );
    for (const [ref, expected] of left[kind]) {
      if (allowed.has(ref)) continue;
      check(
        stableJson(right[kind].get(ref)) === stableJson(expected),
        `${ref}: changed outside the prepared hx-web transition scope`,
      );
    }
  }
}

function assertScenarioMarkerPost(before, after, space) {
  assertScenarioDeltaScope(before, after, { markerSpaces: [space] });
  const prior = scenarioCheckpointMaps(before).markers.get(space);
  const current = scenarioCheckpointMaps(after).markers.get(space);
  check(prior && current, `${space}: scenario marker checkpoint is missing`);
  check(current.scenarioVersion === SCENARIO_VERSION, `${space}: scenario marker was not set to ${SCENARIO_VERSION}`);
}

function scenarioUnitImmutable(row) {
  return {
    ref: row.ref,
    id: row.id,
    targetID: row.targetID,
    upstreamUnitID: row.upstreamUnitID,
    toolchain: row.toolchain,
    provider: row.provider,
    ownedLabels: row.ownedLabels,
    deleteGates: row.deleteGates,
    destroyGates: row.destroyGates,
  };
}

function checkpointHasApprovalGate(unit) {
  return Object.keys(unit?.applyGates ?? {}).some(
    (key) => key.includes("require-approval") || key === APPROVAL_GATE,
  );
}

function assertScenarioUnitIdentity(before, after) {
  check(
    stableJson(scenarioUnitImmutable(after)) === stableJson(scenarioUnitImmutable(before)),
    `${before.ref}: immutable Unit identity changed inside a prepared hx-web transition`,
  );
}

function expectedOwnedAnnotations(expected, payloadKey) {
  const payload = inputs.payloads.get(payloadKey);
  check(payload, `${expected.space}/${expected.slug}: missing reviewed payload ${payloadKey}`);
  const annotations = {
    ...sourceAnnotation(payload.value, payload.sourcePaths, payload.transform),
    ...(expected.annotations ?? {}),
  };
  return Object.fromEntries([...OWNED_PUBLIC_ANNOTATIONS]
    .filter((key) => annotations[key] !== undefined)
    .sort()
    .map((key) => [key, annotations[key]]));
}

function scenarioExpectedUnit(space, slug) {
  const expected = plan.managedUnits.find((item) => item.space === space && item.slug === slug);
  check(expected, `${space}/${slug}: missing planned hx-web Unit`);
  return expected;
}

function assertScenarioUpsertPost(before, after, space, slug, payloadKey) {
  const ref = `${space}/${slug}`;
  assertScenarioDeltaScope(before, after, { unitRefs: [ref] });
  const left = scenarioCheckpointMaps(before).units.get(ref);
  const right = scenarioCheckpointMaps(after).units.get(ref);
  assertScenarioUnitIdentity(left, right);
  const delta = Number(right.headRevisionNum) - Number(left.headRevisionNum);
  check(right.lastAppliedRevisionNum === left.lastAppliedRevisionNum, `${ref}: upsert changed the applied revision before publication`);
  const expected = scenarioExpectedUnit(space, slug);
  assertManagedSourceUnitContract(expected, payloadKey);
  check(
    stableJson(right.ownedAnnotations) === stableJson(expectedOwnedAnnotations(expected, payloadKey)),
    `${ref}: checkpointed provenance does not match ${payloadKey}`,
  );
  check(delta >= 0 && delta <= 2, `${ref}: one reviewed upsert advanced the head by ${delta}, expected at most one content/provenance revision plus one production-trigger revision`);
  if (delta === 2) {
    check(expected.prodProtected, `${ref}: non-production upsert unexpectedly advanced two revisions`);
    const semanticDiffs = [
      [left.headRevisionNum, left.headRevisionNum + 1],
      [left.headRevisionNum + 1, right.headRevisionNum],
    ].map(([from, to]) => cub([
      "unit", "diff", slug,
      "--space", space,
      String(from), String(to),
      "-o", "mutations",
    ]).trim());
    check(
      semanticDiffs.some((output) => output === ""),
      `${ref}: two-revision production upsert lacks a semantically empty adjacent trigger/provenance revision`,
    );
  }
  if (delta === 0) {
    for (const key of ["dataHash", "approvalCount", "applyGates"]) {
      check(stableJson(right[key]) === stableJson(left[key]), `${ref}: ${key} changed during a zero-head-delta upsert`);
    }
  } else if (expected.prodProtected) {
    check(
      right.approvalCount === 0 && checkpointHasApprovalGate(right),
      `${ref}: new production head is not bound to its approval gate`,
    );
  } else {
    check(
      right.approvalCount === 0 && !checkpointHasApprovalGate(right),
      `${ref}: new non-production head gained unexpected approval state`,
    );
  }
}

function promotionBlendDifference(actual, before, after, path = "$") {
  if (stableJson(actual) === stableJson(before) || stableJson(actual) === stableJson(after)) return null;
  if (Array.isArray(actual) || Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(actual) || !Array.isArray(before) || !Array.isArray(after)) return `${path}: array/non-array shape escaped both reviewed payloads`;
    if (actual.length !== before.length || actual.length !== after.length) return `${path}: hybrid array length escaped both reviewed payloads`;
    for (let index = 0; index < actual.length; index += 1) {
      const difference = promotionBlendDifference(actual[index], before[index], after[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  const object = (value) => value && typeof value === "object";
  if (object(actual) || object(before) || object(after)) {
    if (!object(actual) || !object(before) || !object(after)) return `${path}: object/non-object shape escaped both reviewed payloads`;
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const hasActual = Object.hasOwn(actual, key);
      const hasBefore = Object.hasOwn(before, key);
      const hasAfter = Object.hasOwn(after, key);
      if (hasActual && !hasBefore && !hasAfter) return `${path}.${key}: unexpected field escaped both reviewed payloads`;
      if (!hasActual) {
        if (hasBefore && hasAfter) return `${path}.${key}: field present in both reviewed payloads disappeared`;
        continue;
      }
      if (!hasBefore || !hasAfter) {
        const reviewed = hasBefore ? before[key] : after[key];
        if (stableJson(actual[key]) !== stableJson(reviewed)) return `${path}.${key}: value escaped its sole reviewed payload`;
        continue;
      }
      const difference = promotionBlendDifference(actual[key], before[key], after[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return `${path}: value ${stableJson(actual)} matches neither reviewed value`;
}

function assertHxWebPromotionBlend(space, beforePayloadKey, afterPayloadKey) {
  const beforePayload = inputs.payloads.get(beforePayloadKey);
  const afterPayload = inputs.payloads.get(afterPayloadKey);
  check(beforePayload && afterPayload, `${space}: reviewed promotion payload pair is missing`);
  const actualDocs = parseDocs(readUnitData(space, "hx-web-deployment"));
  const beforeDocs = parseDocs(beforePayload.value);
  const afterDocs = parseDocs(afterPayload.value);
  const byIdentity = (docs) => new Map(docs.map((doc) => [identityFor(doc), doc]));
  const actual = byIdentity(actualDocs);
  const before = byIdentity(beforeDocs);
  const after = byIdentity(afterDocs);
  check(
    stableJson([...actual.keys()].sort()) === stableJson([...before.keys()].sort())
      && stableJson([...actual.keys()].sort()) === stableJson([...after.keys()].sort()),
    `${space}: promotion changed the reviewed Kubernetes identity set`,
  );
  for (const identity of [...actual.keys()].sort()) {
    const difference = promotionBlendDifference(actual.get(identity), before.get(identity), after.get(identity));
    check(!difference, `${space}/${identity}: promotion produced an undeclared merge result: ${difference}`);
  }
}

function assertScenarioPromotionPost(before, after, space, beforePayloadKey, afterPayloadKey) {
  const unitRefs = plan.managedUnits.filter((item) => item.space === space).map((item) => `${space}/${item.slug}`);
  const linkRefs = readLinks(space)
    .filter((item) => item.UpdateType === "UpgradeUnit")
    .map((item) => `${space}/${item.Slug}`);
  assertScenarioDeltaScope(before, after, { unitRefs, linkRefs });
  const left = scenarioCheckpointMaps(before);
  const right = scenarioCheckpointMaps(after);
  assertHxWebPromotionBlend(space, beforePayloadKey, afterPayloadKey);
  for (const expected of plan.managedUnits.filter(
    (item) => item.space === space && item.slug !== "hx-web-deployment",
  )) {
    check(
      hxWebUnitMatchesPayload(inputs, space, expected.slug, expected.payloadKey),
      `${space}/${expected.slug}: promotion changed a non-deployment payload`,
    );
  }
  for (const ref of unitRefs) {
    const prior = left.units.get(ref);
    const current = right.units.get(ref);
    assertScenarioUnitIdentity(prior, current);
    const delta = Number(current.headRevisionNum) - Number(prior.headRevisionNum);
    check(delta >= 0 && delta <= 1, `${ref}: one promotion advanced the head by ${delta}, expected zero or one revision`);
    check(current.lastAppliedRevisionNum === prior.lastAppliedRevisionNum, `${ref}: promotion changed the applied revision before publication`);
    if (delta === 0) {
      check(
        stableJson(current) === stableJson(prior),
        `${ref}: promotion changed Unit facts without advancing the head`,
      );
    }
  }
  const unitsByID = new Map(after.units.map((item) => [item.id, item]));
  for (const ref of linkRefs) {
    const prior = left.links.get(ref);
    const current = right.links.get(ref);
    check(prior && current, `${ref}: UpgradeUnit Link disappeared during promotion`);
    const immutable = (item) => ({
      ref: item.ref,
      id: item.id,
      fromUnitID: item.fromUnitID,
      toUnitID: item.toUnitID,
      toSpaceID: item.toSpaceID,
      updateType: item.updateType,
      autoUpdate: item.autoUpdate,
    });
    check(stableJson(immutable(current)) === stableJson(immutable(prior)), `${ref}: UpgradeUnit identity changed during promotion`);
    check(
      current.upstreamLastMergedRevisionNum === unitsByID.get(current.toUnitID)?.headRevisionNum
        && current.downstreamLastMergedRevisionNum === unitsByID.get(current.fromUnitID)?.headRevisionNum,
      `${ref}: promotion did not bind the merge base to the exact post-promotion heads`,
    );
  }
}

function assertScenarioApprovalPost(before, after, space, { allowNoop = false } = {}) {
  const unitRefs = before.units.filter((item) => item.ref.startsWith(`${space}/`)).map((item) => item.ref);
  assertScenarioDeltaScope(before, after, { unitRefs });
  const left = scenarioCheckpointMaps(before).units;
  const right = scenarioCheckpointMaps(after).units;
  let approved = 0;
  for (const ref of unitRefs) {
    const prior = left.get(ref);
    const current = right.get(ref);
    assertScenarioUnitIdentity(prior, current);
    for (const key of ["headRevisionNum", "lastAppliedRevisionNum", "dataHash", "ownedAnnotations"]) {
      check(stableJson(current[key]) === stableJson(prior[key]), `${ref}: ${key} changed during approval`);
    }
    if (checkpointHasApprovalGate(prior)) {
      check(!checkpointHasApprovalGate(current), `${ref}: approval gate remains after exact-head approval`);
      check(current.approvalCount === prior.approvalCount + 1, `${ref}: approval count did not advance exactly once`);
      approved += 1;
    } else {
      check(stableJson(current) === stableJson(prior), `${ref}: ungated Unit changed during approval`);
    }
  }
  check(approved > 0 || (allowNoop && stableJson(after) === stableJson(before)), `${space}: approval transition had no exact gated heads`);
}

function assertScenarioReleasePost(before, after, space, sourcePayloadKeys) {
  const unitRefs = before.units.filter((item) => item.ref.startsWith(`${space}/`)).map((item) => item.ref);
  assertScenarioDeltaScope(before, after, { unitRefs, releaseSpaces: [space] });
  const left = scenarioCheckpointMaps(before);
  const right = scenarioCheckpointMaps(after);
  const hadUnreleasedHeads = unitRefs.some((ref) => {
    const unit = left.units.get(ref);
    return Number(unit.headRevisionNum) !== Number(unit.lastAppliedRevisionNum);
  });
  for (const ref of unitRefs) {
    const prior = left.units.get(ref);
    const current = right.units.get(ref);
    assertScenarioUnitIdentity(prior, current);
    for (const key of ["headRevisionNum", "dataHash", "ownedAnnotations", "approvalCount", "applyGates"]) {
      check(stableJson(current[key]) === stableJson(prior[key]), `${ref}: ${key} changed during publication`);
    }
    check(current.lastAppliedRevisionNum === current.headRevisionNum, `${ref}: publication did not apply the exact current head`);
  }
  const priorRelease = left.releases.get(space);
  const currentRelease = right.releases.get(space);
  if (hadUnreleasedHeads || !priorRelease.releaseNum) {
    check(
      Number(currentRelease.releaseNum) === Number(priorRelease.releaseNum ?? 0) + 1,
      `${space}: publication did not create exactly one next release`,
    );
  } else {
    check(
      stableJson(currentRelease) === stableJson(priorRelease),
      `${space}: reusable publication unexpectedly changed the latest release`,
    );
  }
  check(/^sha256:[0-9a-f]{64}$/.test(currentRelease.bundleDigest ?? ""), `${space}: published bundle digest is invalid`);
  check(/^sha256:[0-9a-f]{64}$/.test(currentRelease.manifestDigest ?? ""), `${space}: published manifest digest is invalid`);
  assertReleaseBoundary(space, { sourcePayloadKeys });
}

function assertScenarioRollbackRestorePost(before, after, restoredRevision) {
  const space = "hx-web-prod-a";
  const slug = "hx-web-deployment";
  const ref = `${space}/${slug}`;
  assertScenarioDeltaScope(before, after, { unitRefs: [ref] });
  const left = scenarioCheckpointMaps(before).units.get(ref);
  const right = scenarioCheckpointMaps(after).units.get(ref);
  assertScenarioUnitIdentity(left, right);
  check(
    restoredRevision?.id === right.id
      && Number.isInteger(restoredRevision.headRevisionNum)
      && restoredRevision.dataHash === right.dataHash,
    `${ref}: rollback result is not bound to the exact initial-rollout revision and data hash`,
  );
  check(Number(right.headRevisionNum) === Number(left.headRevisionNum) + 1, `${ref}: rollback did not create exactly one restore revision`);
  check(right.lastAppliedRevisionNum === left.lastAppliedRevisionNum, `${ref}: rollback changed the applied revision before publication`);
  const expected = scenarioExpectedUnit(space, slug);
  check(
    hxWebUnitMatchesPayload(inputs, space, slug, "hx-web/prod-a/hx-web-deployment/final"),
    `${ref}: rollback data is not the exact reviewed two-replica payload`,
  );
  check(
    stableJson(right.ownedAnnotations) === stableJson(expectedOwnedAnnotations(expected, "hx-web/base/hx-web-deployment/initial")),
    `${ref}: restore did not recover the exact reviewed predecessor provenance`,
  );
  check(right.approvalCount === 0 && checkpointHasApprovalGate(right), `${ref}: restored production head is not awaiting exact-head approval`);
}

function assertScenarioMergeCurrentPost(before, after, linkRef) {
  assertScenarioDeltaScope(before, after, { linkRefs: [linkRef] });
  const left = scenarioCheckpointMaps(before).links.get(linkRef);
  const right = scenarioCheckpointMaps(after).links.get(linkRef);
  check(left && right, `${linkRef}: UpgradeUnit Link is missing`);
  const immutable = (item) => ({
    ref: item.ref,
    id: item.id,
    fromUnitID: item.fromUnitID,
    toUnitID: item.toUnitID,
    toSpaceID: item.toSpaceID,
    updateType: item.updateType,
    autoUpdate: item.autoUpdate,
  });
  check(stableJson(immutable(right)) === stableJson(immutable(left)), `${linkRef}: UpgradeUnit identity changed during make-current`);
  const unitsByID = new Map(after.units.map((item) => [item.id, item]));
  check(
    right.upstreamLastMergedRevisionNum === unitsByID.get(right.toUnitID)?.headRevisionNum
      && right.downstreamLastMergedRevisionNum === unitsByID.get(right.fromUnitID)?.headRevisionNum,
    `${linkRef}: make-current did not bind both exact Unit heads`,
  );
}

function reconcileRunsProveCurrentScenarioHistory(runs, executionFingerprint) {
  if (!Array.isArray(runs) || runs.length === 0) return false;
  const latest = runs.at(-1);
  if (latest?.result !== "pass" || latest.executionFingerprint !== executionFingerprint) return false;
  const currentRuns = runs.filter((run) => run.executionFingerprint === executionFingerprint);
  return currentRuns.length > 0
    && currentRuns.every((run) => run.result === "pass")
    && currentRuns.some((run) => run.idempotentNoop === false && run.actionCount > 0);
}

function scenarioReceiptAttemptBindingDiagnosis(receipt, attemptLedger, executionFingerprint) {
  if (!["pending-idempotence", "pass"].includes(receipt?.status?.result)) {
    return { proven: false, reason: "receipt-result" };
  }
  const latestRun = receipt.spec?.reconcileRuns?.at(-1);
  const latestAttempt = attemptLedger?.attempts?.at(-1);
  if (!latestRun || !latestAttempt) return { proven: false, reason: "attempt-binding-missing" };
  if (latestAttempt.result !== "pass") {
    return { proven: false, reason: "latest-attempt-result", attemptResult: latestAttempt.result };
  }
  if (
    latestRun.attemptSequence !== latestAttempt.sequence
      || latestRun.attemptID !== latestAttempt.id
  ) {
    return {
      proven: false,
      reason: "attempt-binding",
      runAttemptSequence: latestRun.attemptSequence,
      ledgerAttemptSequence: latestAttempt.sequence,
    };
  }
  if (
    latestRun.result !== "pass"
      || latestRun.executionFingerprint !== executionFingerprint
      || latestAttempt.executionFingerprint !== executionFingerprint
  ) {
    return { proven: false, reason: "attempt-execution" };
  }
  return {
    proven: true,
    reason: "latest-terminal-receipt-and-attempt-bound",
    attemptSequence: latestAttempt.sequence,
    attemptID: latestAttempt.id,
  };
}

function scenarioReceiptHistoryDiagnosis({
  receipt = readPriorReceipt(),
  attemptLedger = readApplyAttemptLedger(),
} = {}) {
  if (!receipt) return { proven: false, reason: "receipt-missing" };
  const scenario = receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt"
    ? receipt.spec?.rolloutScenario
    : null;
  if (scenario?.version !== SCENARIO_VERSION) return { proven: false, reason: "scenario-version" };
  if (scenario?.sourceFingerprint !== scenarioSourceFingerprint()) return { proven: false, reason: "scenario-source" };
  const runs = receipt.spec?.reconcileRuns ?? [];
  const executionFingerprint = operationExecutionFingerprint();
  const attemptBinding = scenarioReceiptAttemptBindingDiagnosis(receipt, attemptLedger, executionFingerprint);
  if (!attemptBinding.proven) return attemptBinding;
  if (!reconcileRunsProveCurrentScenarioHistory(runs, executionFingerprint)) {
    return {
      proven: false,
      reason: "reconcile-runs",
      executionFingerprint,
      runs: runs.map((run) => ({
        executionFingerprint: run.executionFingerprint,
        result: run.result,
        actionCount: run.actionCount,
        idempotentNoop: run.idempotentNoop,
      })),
    };
  }
  const spaces = readSpaces();
  if (receipt.spec?.organization?.entityID !== spaces.get(CONTROL_SPACE)?.OrganizationID) {
    return { proven: false, reason: "organization-identity" };
  }
  const receiptSpaces = new Map((receipt.spec?.spaces ?? []).map((space) => [space.slug, space.id]));
  for (const slug of ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)]) {
    if (receiptSpaces.get(slug) !== spaces.get(slug)?.SpaceID) {
      return { proven: false, reason: "space-identity", ref: slug };
    }
  }
  for (const [name, evidence] of Object.entries(sourceEvidence())) {
    const stored = receipt.spec?.source?.files?.[name];
    if (stored?.path !== evidence.path || stored?.sha256 !== evidence.sha256) {
      return { proven: false, reason: "source-evidence", ref: name };
    }
  }
  const expectedSteps = SCENARIO_STEPS.slice(1);
  if (!expectedSteps.every((id) => (scenario.steps ?? []).some((item) => item.id === id && item.result === "pass"))) {
    return { proven: false, reason: "scenario-steps" };
  }
  if (!scenarioOperationProofValid(scenario)) return { proven: false, reason: "scenario-operation-proof" };
  return {
    proven: true,
    reason: "current-receipt-execution-and-terminal-attempt",
    attemptSequence: attemptBinding.attemptSequence,
    attemptID: attemptBinding.attemptID,
  };
}

function trustedScenarioHistoryForApply(state) {
  check(
    typeof state?.scenarioReceiptProven === "boolean",
    "scenario history trust was not captured before the active apply invalidated the prior receipt",
  );
  return state.scenarioReceiptProven;
}

function preflightScenarioHistory(state) {
  const priorReceipt = readPriorReceipt();
  const receiptProven = trustedScenarioHistoryForApply(state);
  const markerStatus = scenarioMarkerStatus();
  const recoverableJournal = state.scenarioJournal
    && state.scenarioJournal.version === SCENARIO_VERSION
    && ["started", "completed"].includes(state.scenarioJournal.state);
  const reviewedVersionMigration = state.scenarioJournal?.state === "archived";
  check(
    !priorReceipt || receiptProven || recoverableJournal || reviewedVersionMigration,
    "preflight refused an existing hx-web receipt that is not trusted for the current fleet/source",
  );
  check(
    markerStatus.marked.length === 0 || receiptProven || recoverableJournal || reviewedVersionMigration,
    "preflight refused hx-web scenario markers without a trusted receipt or durable recovery journal",
  );
}

function materializeHxWebScenario(inputs, payloadFiles, desired, state) {
  const family = APP_FAMILIES.find((item) => item.prefix === "hx-web");
  const baseSpace = "hx-web-base";
  const baseUnits = desired.managedUnits.filter((item) => item.space === baseSpace);
  const markerStatus = scenarioMarkerStatus();
  const priorReceipt = readPriorReceipt();
  const receiptProven = trustedScenarioHistoryForApply(state);
  const recoverableJournal = state.scenarioJournal
    && state.scenarioJournal.version === SCENARIO_VERSION
    && ["started", "completed"].includes(state.scenarioJournal.state);
  const reviewedVersionMigration = state.scenarioJournal?.state === "archived";
  check(
    markerStatus.marked.length === 0 || markerStatus.complete || receiptProven || recoverableJournal || reviewedVersionMigration,
    `partial hx-web scenario markers found in ${markerStatus.marked.join(", ")}; refusing history replay`,
  );
  const alreadyProven = receiptProven;
  check(
    !priorReceipt || alreadyProven || recoverableJournal || reviewedVersionMigration,
    "an existing hx-web receipt is not trusted for the current fleet/source and no durable recovery journal exists",
  );
  check(
    markerStatus.marked.length === 0 || alreadyProven || recoverableJournal || reviewedVersionMigration,
    "hx-web scenario markers exist without a trusted atomic receipt or durable journal; refusing destructive history replay",
  );
  const preserveJournalState = Boolean(recoverableJournal && !alreadyProven);
  if (preserveJournalState) {
    if (state.scenarioJournal.preparedStep) {
      assertScenarioRecoveryIdentity(state.scenarioJournal.preparedStep.preCheckpoint);
    } else assertScenarioCheckpoint(state.scenarioJournal.checkpoint);
  }

  for (const expected of baseUnits) {
    if (preserveJournalState) {
      check(readUnit(expected.space, expected.slug), `${expected.space}/${expected.slug}: journaled hx-web Unit is missing`);
    } else {
      upsertUnit(expected, inputs, payloadFiles, state, {
        payloadKey: alreadyProven || !expected.initialPayloadKey
          ? expected.payloadKey
          : expected.initialPayloadKey,
      });
    }
  }
  assertUnitAllowlist(baseSpace, family.units.map((item) => item.slug));

  for (let index = 0; index < family.targets.length; index += 1) {
    const fleetItem = family.targets[index];
    const upstreamSpace = index === 0
      ? baseSpace
      : index === 1
        ? "hx-web-dev"
        : "hx-web-staging";
    const space = `hx-web-${fleetItem.suffix}`;
    ensureVariantSpace({
      space,
      upstreamSpace,
      variantName: fleetItem.suffix,
      fleetItem,
      prodProtected: fleetItem.environment === "Prod",
    }, state, { assertOnly: preserveJournalState });
    for (const expected of desired.managedUnits.filter((item) => item.space === space)) {
      if (preserveJournalState) {
        check(readUnit(expected.space, expected.slug), `${expected.space}/${expected.slug}: journaled hx-web Unit is missing`);
      } else {
        upsertUnit(expected, inputs, payloadFiles, state, {
          payloadKey: alreadyProven || !expected.initialPayloadKey
            ? expected.payloadKey
            : expected.initialPayloadKey,
        });
      }
    }
    assertUnitAllowlist(space, family.units.map((item) => item.slug));
    ensureArgoApplication(
      desired.deployments.find((item) => item.space === space),
      state,
      { assertOnly: preserveJournalState },
    );
  }
  return { alreadyProven, journal: state.scenarioJournal };
}

function reconcileHxWebScenario(inputs, payloadFiles, desired, state, scenarioStatus) {
  const baseUnits = desired.managedUnits.filter((item) => item.space === "hx-web-base");
  const { alreadyProven } = scenarioStatus;
  assertManagedLinkInventory(desired);
  if (alreadyProven) {
    state.scenario = {
      mode: "retained-proven-history",
      version: SCENARIO_VERSION,
      steps: verifyHxWebFinalState(inputs),
    };
    for (const deployment of desired.deployments.filter(
      (item) => item.type === "application" && /^hx-web-(dev|staging|prod-a|prod-b)$/.test(item.space),
    )) deployOne(deployment, state);
    reconcileScenarioMarkers(state);
    return;
  }

  let scenarioJournal = state.scenarioJournal?.state === "archived"
    ? beginScenarioJournal()
    : state.scenarioJournal ?? beginScenarioJournal();
  state.scenarioJournal = scenarioJournal;
  state.scenario = {
    mode: scenarioJournal.state === "completed" ? "recovered-completed-history" : "executed",
    version: SCENARIO_VERSION,
    steps: [],
    operationEvidence: [...scenarioJournal.operationEvidence],
  };
  const scenarioStep = (id, operation) => {
    if (scenarioJournal.completedSteps.includes(id)) {
      state.scenario.steps.push({ id, result: "pass", recoveredFromJournal: true });
      return;
    }
    if (scenarioJournal.preparedStep) {
      check(scenarioJournal.preparedStep.id === id, `hx-web prepared step ${scenarioJournal.preparedStep.id} does not match ${id}`);
    } else {
      assertScenarioCheckpoint(scenarioJournal.checkpoint);
      scenarioJournal = prepareScenarioJournalStep(id);
      state.scenarioJournal = scenarioJournal;
    }
    const actionOffset = state.actions.length;
    let transitionCursor = 0;
    const transition = (transitionID, mutate, assertPost, options = {}) => {
      const completed = state.scenarioJournal.preparedStep.completedTransitions;
      if (transitionCursor < completed.length) {
        check(
          completed[transitionCursor] === transitionID,
          `${id}: nested transition order drifted at ${transitionID}; expected ${completed[transitionCursor]}`,
        );
      } else {
        check(
          transitionCursor === completed.length,
          `${id}/${transitionID}: nested transition is not the next exact prefix entry`,
        );
      }
      transitionCursor += 1;
      const outcome = runScenarioTransition(state, id, transitionID, mutate, assertPost, options);
      scenarioJournal = outcome.journal;
      return outcome;
    };
    operation(transition);
    check(
      transitionCursor === state.scenarioJournal.preparedStep.completedTransitions.length,
      `${id}: operation did not replay the complete nested-transition prefix`,
    );
    state.scenario.steps.push({ id, result: "pass" });
    scenarioJournal = recordScenarioJournalStep(id, state.actions.slice(actionOffset));
    state.scenarioJournal = scenarioJournal;
    state.scenario.operationEvidence = [...scenarioJournal.operationEvidence];
  };

  const scenarioDeployments = desired.deployments.filter(
    (item) => item.type === "application" && /^hx-web-(dev|staging|prod-a|prod-b)$/.test(item.space),
  );
  const deploymentFor = (space) => {
    const deployment = scenarioDeployments.find((item) => item.space === space);
    check(deployment, `${space}: hx-web deployment plan is missing`);
    return deployment;
  };
  const assertDeliveryRootReusable = (deployment) => {
    const boundary = assertReleaseBoundary(deployment.appSpace);
    check(!spaceHasUnreleasedHeads(deployment.appSpace), `${deployment.appSpace}: delivery root changed inside the hx-web scenario`);
    check(
      releaseBoundaryPublishedUnitCountMatches(boundary),
      `${deployment.appSpace}: scenario delivery-root release does not contain the exact Application Unit inventory`,
    );
    return validatedPublishedRelease(
      deployment.appSpace,
      boundary.latestPublishedRelease,
      "scenario delivery-root release",
    );
  };
  const scenarioUpsert = (transition, id, space, slug, payloadKey) => transition(
    id,
    () => upsertScenarioUnitAtomically(
      scenarioExpectedUnit(space, slug),
      inputs,
      payloadFiles,
      state,
      payloadKey,
    ),
    (before, after) => assertScenarioUpsertPost(before, after, space, slug, payloadKey),
  );
  const scenarioPromote = (transition, id, space, beforePayloadKey, afterPayloadKey) => transition(
    id,
    () => {
      assertHxWebSpacePayloads(inputs, desired, space, beforePayloadKey);
      cub([
        "variant", "promote", space,
        "--change-desc", `Promote ${SCENARIO_VERSION} while preserving downstream departures`,
        "--quiet",
      ], { timeout: 1_200_000 });
      recordAction(state, "variant-promote", space);
      state.changedSpaces.add(space);
    },
    (before, after) => assertScenarioPromotionPost(
      before,
      after,
      space,
      beforePayloadKey,
      afterPayloadKey,
    ),
    { recoveryEvidence: [{ type: "variant-promote", ref: space }] },
  );
  const scenarioApprove = (transition, id, space, { allowNoop = false } = {}) => transition(
    id,
    () => approveOutstanding(space, state),
    (before, after) => assertScenarioApprovalPost(before, after, space, { allowNoop }),
    {
      recoveryEvidence: (before, after) => [approvalEvidenceFromCheckpoints(before, after, space)],
    },
  );
  const scenarioPublish = (transition, id, space, deploymentPayloadKey) => {
    const deployment = deploymentFor(space);
    assertDeliveryRootReusable(deployment);
    const sourcePayloadKeys = { "hx-web-deployment": deploymentPayloadKey };
    transition(
      id,
      () => publishRelease(space, state, { sourcePayloadKeys }),
      (before, after) => assertScenarioReleasePost(before, after, space, sourcePayloadKeys),
    );
    const release = validatedPublishedRelease(space, latestRelease(space), "scenario source release");
    convergeDeploymentApplication(
      deployment,
      state,
      releaseManifestDigest(release),
      releaseIdentity({ latestPublishedRelease: release }),
      sourcePayloadKeys,
    );
  };
  const assertRefusedHeadsCurrent = (space) => {
    const gateObservation = state.scenarioJournal.operationEvidence.findLast(
      (item) => item.type === "approval-gate-observed" && item.ref === space,
    );
    check(gateObservation?.gatedHeads?.length > 0, `${space}: exact approval-gate observation head evidence is missing`);
    const currentByRef = new Map(readUnitRows(space).map((unit) => [`${space}/${unit.Slug}`, unit]));
    for (const gated of gateObservation.gatedHeads) {
      const current = currentByRef.get(gated.ref);
      check(
        current?.UnitID === gated.id
          && current.HeadRevisionNum === gated.headRevisionNum
          && current.DataHash === gated.dataHash,
        `${gated.ref}: current head is not the exact head observed behind the gate before approval`,
      );
    }
  };

  scenarioStep("merge-bases-reset", (transition) => {
    for (const fleetItem of FLEET) {
      const space = `hx-web-${fleetItem.suffix}`;
      for (const unit of desired.managedUnits.filter((item) => item.space === space && item.upstream)) {
        const slug = `upgrade-${unit.slug}`;
        const ref = `${space}/${slug}`;
        transition(
          `${fleetItem.suffix}-${slug}`,
          () => {
            cub(["link", "update", slug, "--space", space, "--patch", "--make-current", "--quiet"]);
            recordAction(state, "scenario-merge-base-reset", ref, "baseline heads marked current before deterministic replay");
          },
          (before, after) => assertScenarioMergeCurrentPost(before, after, ref),
        );
      }
    }
  });

  scenarioStep("initial-rollout", (transition) => {
    for (const deployment of scenarioDeployments) {
      const { space } = deployment;
      assertHxWebSpacePayloads(inputs, desired, space, "hx-web/base/hx-web-deployment/initial");
      if (space.includes("prod-")) scenarioApprove(transition, `${space}-approve`, space);
      scenarioPublish(transition, `${space}-publish`, space, "hx-web/base/hx-web-deployment/initial");
    }
  });

  scenarioStep("base-promotion", (transition) => {
    scenarioUpsert(transition, "base-v1", "hx-web-base", "hx-web-deployment", "hx-web/base/hx-web-deployment/v1");
    for (const deployment of scenarioDeployments) {
      const { space } = deployment;
      scenarioPromote(
        transition,
        `${space}-promote-v1`,
        space,
        "hx-web/base/hx-web-deployment/initial",
        "hx-web/base/hx-web-deployment/v1",
      );
      scenarioUpsert(transition, `${space}-v1-provenance`, space, "hx-web-deployment", "hx-web/base/hx-web-deployment/v1");
      if (space.includes("prod-")) {
        const sourcePayloadKeys = { "hx-web-deployment": "hx-web/base/hx-web-deployment/v1" };
        transition(
          `${space}-approval-gate-observation`,
          () => observeReleaseGateBeforeApproval(space, state, sourcePayloadKeys),
          (before, after) => check(
            stableJson(after) === stableJson(before),
            `${space}: read-only approval-gate observation changed live ConfigHub state`,
          ),
        );
      } else {
        scenarioPublish(transition, `${space}-publish-v1`, space, "hx-web/base/hx-web-deployment/v1");
      }
    }
  });

  scenarioStep("prod-approval", (transition) => {
    for (const space of ["hx-web-prod-a", "hx-web-prod-b"]) {
      assertRefusedHeadsCurrent(space);
      scenarioApprove(transition, `${space}-approve-v1`, space);
      scenarioPublish(transition, `${space}-publish-v1`, space, "hx-web/base/hx-web-deployment/v1");
    }
  });

  scenarioStep("prod-a-rollback", (transition) => {
    const space = "hx-web-prod-a";
    const initialCheckpoint = state.scenarioJournal.checkpoints.find((item) => item.id === "initial-rollout")?.facts;
    const initialDeployment = initialCheckpoint?.units?.find((item) => item.ref === `${space}/hx-web-deployment`);
    check(
      initialDeployment?.id && Number.isInteger(initialDeployment.headRevisionNum),
      "prod-a rollback lacks its durable initial-rollout Unit revision",
    );
    transition(
      "prod-a-restore-previous",
      () => {
        check(
          hxWebUnitMatchesPayload(inputs, space, "hx-web-deployment", "hx-web/base/hx-web-deployment/v1"),
          "prod-a is not the exact reviewed v1 head before restore -1",
        );
        const sourceUnit = readUnit(space, "hx-web-deployment");
        check(sourceUnit, `${space}/hx-web-deployment: rollback source Unit is missing`);
        cub([
          "unit", "update", "--space", space, "hx-web-deployment",
          "--restore", String(initialDeployment.headRevisionNum),
          "--change-desc", "Demonstrate one-production-target rollback",
          "--quiet",
        ]);
        const restoredUnit = readUnit(space, "hx-web-deployment");
        check(restoredUnit, `${space}/hx-web-deployment: restored Unit is missing`);
        recordStructuredAction(state, {
          ...rollbackEvidenceFromUnits(
            {
              ref: `${space}/hx-web-deployment`,
              id: sourceUnit.UnitID,
              headRevisionNum: sourceUnit.HeadRevisionNum,
              dataHash: sourceUnit.DataHash,
            },
            {
              ref: `${space}/hx-web-deployment`,
              id: restoredUnit.UnitID,
              headRevisionNum: restoredUnit.HeadRevisionNum,
              dataHash: restoredUnit.DataHash,
            },
            initialDeployment,
          ),
          detail: `restore exact initial-rollout revision ${initialDeployment.headRevisionNum} from reviewed v1 head`,
        });
        state.changedSpaces.add(space);
      },
      (before, after) => assertScenarioRollbackRestorePost(before, after, initialDeployment),
      {
        recoveryEvidence: (before, after) => {
          const ref = `${space}/hx-web-deployment`;
          return [rollbackEvidenceFromUnits(
            scenarioCheckpointMaps(before).units.get(ref),
            scenarioCheckpointMaps(after).units.get(ref),
            initialDeployment,
          )];
        },
      },
    );
    scenarioUpsert(
      transition,
      "prod-a-final-provenance",
      space,
      "hx-web-deployment",
      "hx-web/prod-a/hx-web-deployment/final",
    );
    scenarioApprove(transition, "prod-a-approve-rollback", space);
    scenarioPublish(transition, "prod-a-publish-rollback", space, "hx-web/prod-a/hx-web-deployment/final");
    const docs = parseDocs(readUnitData(space, "hx-web-deployment"));
    check(docs.find((doc) => doc.kind === "Deployment")?.spec?.replicas === 2, "prod-a rollback did not restore two replicas");
  });

  scenarioStep("staging-departure", (transition) => {
    scenarioUpsert(
      transition,
      "staging-sandbox-departure",
      "hx-web-staging",
      "hx-web-deployment",
      "hx-web/staging/hx-web-deployment/departure",
    );
    scenarioPublish(
      transition,
      "staging-publish-departure",
      "hx-web-staging",
      "hx-web/staging/hx-web-deployment/departure",
    );
  });

  scenarioStep("departure-survives-promotion", (transition) => {
    scenarioUpsert(transition, "base-v2", "hx-web-base", "hx-web-deployment", "hx-web/base/hx-web-deployment/v2");
    for (const [space, beforePayloadKey, finalPayloadKey] of [
      ["hx-web-dev", "hx-web/base/hx-web-deployment/v1", "hx-web/dev/hx-web-deployment/final"],
      ["hx-web-staging", "hx-web/staging/hx-web-deployment/departure", "hx-web/staging/hx-web-deployment/final"],
    ]) {
      scenarioPromote(transition, `${space}-promote-v2`, space, beforePayloadKey, finalPayloadKey);
      scenarioUpsert(transition, `${space}-final-provenance`, space, "hx-web-deployment", finalPayloadKey);
      scenarioPublish(transition, `${space}-publish-final`, space, finalPayloadKey);
    }
    const finalSteps = verifyHxWebFinalState(inputs);
    check(finalSteps.every((item) => item.result === "pass"), "hx-web final scenario verification failed");

    // The promotion transitions prove merge behavior before normalization.
    // Normalize every committed provenance field through individually
    // checkpointed transitions, then publish/reconcile the exact final state.
    for (const expected of desired.managedUnits.filter(
      (item) => item.space === "hx-web-base" || /^hx-web-(dev|staging|prod-a|prod-b)$/.test(item.space),
    )) {
      scenarioUpsert(
        transition,
        `final-normalize-${expected.space}-${expected.slug}`,
        expected.space,
        expected.slug,
        expected.payloadKey,
      );
    }
    for (const deployment of scenarioDeployments) {
      if (deployment.space.includes("prod-")) {
        scenarioApprove(transition, `final-approve-${deployment.space}`, deployment.space, { allowNoop: true });
      }
      scenarioPublish(
        transition,
        `final-publish-${deployment.space}`,
        deployment.space,
        `hx-web/${deployment.space.slice("hx-web-".length)}/hx-web-deployment/final`,
      );
    }
    verifyHxWebFinalState(inputs);
    for (const space of ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)]) {
      transition(
        `scenario-marker-${space}`,
        () => {
          const live = readSpaces().get(space);
          if (live?.Labels?.ScenarioVersion === SCENARIO_VERSION) return;
          cub(["space", "update", "--patch", space, "--label", `ScenarioVersion=${SCENARIO_VERSION}`, "--quiet"]);
          recordAction(state, "scenario-marker", space, SCENARIO_VERSION);
        },
        (before, after) => assertScenarioMarkerPost(before, after, space),
      );
    }
  });

  scenarioJournal = completeScenarioJournal();
  state.scenarioJournal = scenarioJournal;
  state.scenario.operationEvidence = [...scenarioJournal.operationEvidence];
}

function reconcileScenarioMarkers(state) {
  let markedSpaces = readSpaces();
  for (const slug of ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)]) {
    if (markedSpaces.get(slug)?.Labels?.ScenarioVersion === SCENARIO_VERSION) continue;
    cub(["space", "update", "--patch", slug, "--label", `ScenarioVersion=${SCENARIO_VERSION}`, "--quiet"]);
    recordAction(state, "scenario-marker", slug, SCENARIO_VERSION);
    markedSpaces = readSpaces();
  }
}

function hxWebUnitMatchesPayload(inputs, space, slug, payloadKey) {
  const payload = inputs.payloads.get(payloadKey);
  check(payload, `${space}/${slug}: reviewed hx-web payload ${payloadKey} is missing`);
  return sameUnitData(
    "Kubernetes/YAML",
    readUnitData(space, slug),
    payload.value,
  );
}

function assertHxWebSpacePayloads(inputs, desired, space, deploymentPayloadKey) {
  for (const expected of desired.managedUnits.filter((item) => item.space === space)) {
    const payloadKey = expected.slug === "hx-web-deployment"
      ? deploymentPayloadKey
      : expected.payloadKey;
    check(
      hxWebUnitMatchesPayload(inputs, space, expected.slug, payloadKey),
      `${space}/${expected.slug}: live data is not the exact reviewed payload ${payloadKey}`,
    );
  }
}

function observeReleaseGateBeforeApproval(space, state, sourcePayloadKeys = {}) {
  const opening = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "required" });
  const gatedHeads = readUnitRows(space)
    .filter(hasApprovalGate)
    .map((unit) => ({
      ref: `${space}/${unit.Slug}`,
      id: unit.UnitID,
      headRevisionNum: unit.HeadRevisionNum,
      dataHash: unit.DataHash,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  check(gatedHeads.length > 0, `${space}: no exact gated heads exist before approval`);
  // `cub release publish` has no revision/CAS precondition. A live negative
  // publish test could race with an external approval and publish after our
  // check. Retain the product evidence as two stable authoritative reads of
  // the exact gated heads, and approve those numeric revisions next.
  const closing = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "required" });
  assertReleaseBoundaryTransition(space, opening, closing, { publicationAttempted: false });
  const closingHeads = closing.units
    .filter((unit) => gatedHeads.some((item) => item.ref === `${space}/${unit.slug}`))
    .map((unit) => ({
      ref: `${space}/${unit.slug}`,
      id: unit.id,
      headRevisionNum: unit.headRevisionNum,
      dataHash: unit.dataHash,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  check(
    stableJson(closingHeads) === stableJson(gatedHeads),
    `${space}: gated heads changed across the stable read-only gate observation`,
  );
  recordStructuredAction(state, {
    type: "approval-gate-observed",
    ref: space,
    observationMode: "read-only-authoritative-gate",
    detail: "exact gated heads observed twice; unsafe non-CAS negative publish intentionally omitted",
    gatedHeads,
  });
}

function verifyHxWebFinalState(inputs) {
  const checks = [];
  const expectedBase = inputs.payloads.get("hx-web/base/hx-web-deployment/v2").value;
  const baseData = readUnitData("hx-web-base", "hx-web-deployment");
  checks.push({
    id: "base-at-promotion-v2",
    result: sameUnitData("Kubernetes/YAML", baseData, expectedBase) ? "pass" : "fail",
  });
  for (const item of FLEET) {
    const space = `hx-web-${item.suffix}`;
    const actual = readUnitData(space, "hx-web-deployment");
    const expected = inputs.payloads.get(`hx-web/${item.suffix}/hx-web-deployment/final`).value;
    checks.push({
      id: `${item.suffix}-final-state`,
      result: sameUnitData("Kubernetes/YAML", actual, expected) ? "pass" : "fail",
      departure: item.suffix === "staging"
        ? "SANDBOX_URL"
        : item.suffix === "prod-a"
          ? "replicas=2 rollback"
          : "none",
    });
  }
  check(checks.every((item) => item.result === "pass"), `hx-web final scenario drift:\n${stableJson(checks)}`);
  return checks;
}

function exactHeadApprovalArgs(space, unit) {
  check(space && unit?.Slug, "exact-head approval requires a Space and Unit slug");
  check(Number.isInteger(Number(unit.HeadRevisionNum)) && Number(unit.HeadRevisionNum) > 0, `${space}/${unit.Slug}: approval head revision is invalid`);
  // ConfigHub v0.2.11 rejects an explicit numeric value even when it equals
  // HeadRevisionNum. Use the server's HeadRevisionNum selector, bracketed by
  // exact Unit/DataHash reads under the serial lock, and verify the numeric
  // head did not move after approval.
  return [
    "unit", "approve", "--space", space, unit.Slug,
    "--revision", "HeadRevisionNum",
    "--wait", "--quiet",
  ];
}

function approveOutstanding(space, state) {
  const rows = readUnitRows(space);
  const outstanding = rows.filter(hasApprovalGate);
  if (outstanding.length === 0) return;
  const approvedHeads = [];
  for (const unit of outstanding) {
    check(Number.isInteger(Number(unit.HeadRevisionNum)) && Number(unit.HeadRevisionNum) > 0, `${space}/${unit.Slug}: approval head revision is invalid`);
    const before = readUnitRows(space).find((candidate) => candidate.UnitID === unit.UnitID);
    check(
      before?.Slug === unit.Slug
        && Number(before.HeadRevisionNum) === Number(unit.HeadRevisionNum)
        && before.DataHash === unit.DataHash
        && hasApprovalGate(before),
      `${space}/${unit.Slug}: exact gated head changed before server-head approval`,
    );
    cub(exactHeadApprovalArgs(space, unit));
    const current = readUnitRows(space).find((candidate) => candidate.UnitID === unit.UnitID);
    check(current?.Slug === unit.Slug, `${space}/${unit.Slug}: Unit identity changed during approval`);
    check(
      Number(current.HeadRevisionNum) === Number(unit.HeadRevisionNum)
        && current.DataHash === unit.DataHash,
      `${space}/${unit.Slug}: approved head revision or DataHash changed during approval`,
    );
    check(!hasApprovalGate(current), `${space}/${unit.Slug}: approval gate remained after exact-head approval`);
    check(
      approvalCount(current.ApprovedBy) === approvalCount(unit.ApprovedBy) + 1,
      `${space}/${unit.Slug}: exact-head approval count did not advance once`,
    );
    approvedHeads.push({
      ref: `${space}/${unit.Slug}`,
      id: unit.UnitID,
      headRevisionNum: unit.HeadRevisionNum,
      dataHash: unit.DataHash,
      approvalCountBefore: approvalCount(unit.ApprovedBy),
      approvalCountAfter: approvalCount(current.ApprovedBy),
    });
  }
  recordStructuredAction(state, {
    type: "unit-approve",
    ref: space,
    detail: `${outstanding.length} Unit(s)`,
    approvedHeads: approvedHeads.sort((left, right) => left.ref.localeCompare(right.ref)),
  });
}

function hasApprovalGate(unit) {
  return Object.keys(unit?.ApplyGates ?? {}).some(
    (key) => key.includes("require-approval") || key === APPROVAL_GATE,
  );
}

function approvalCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value ? 1 : 0;
}

function deployOne(deployment, state, { sourcePayloadKeys = {} } = {}) {
  ensureDeliveryRootPublished(deployment, state);
  if (deployment.space.includes("prod-")) approveOutstanding(deployment.space, state);
  const release = publishRelease(deployment.space, state, { sourcePayloadKeys });
  if (deployment.cluster === "hx-app-dev" && state.performancePhases.length === 0) markFirstDevConvergenceStart();
  convergeDeploymentApplication(
    deployment,
    state,
    releaseManifestDigest(release),
    releaseIdentity({ latestPublishedRelease: release }),
    sourcePayloadKeys,
  );
}

function ensureDeliveryRootPublished(deployment, state) {
  if (state.deliveryRootReleases.has(deployment.cluster)) return;
  const release = publishDeliveryRoot(deployment, state);
  state.deliveryRootReleases.set(deployment.cluster, validatedPublishedRelease(
    deployment.appSpace,
    release,
    "cluster delivery-root release",
  ));
}

function assertPublishedDeliveryRootsRemainCurrent(state) {
  for (const fleetItem of FLEET) {
    const appSpace = `${fleetItem.cluster}-argo-apps`;
    check(state.deliveryRootReleases.has(fleetItem.cluster), `${fleetItem.cluster}: delivery-root release evidence is missing`);
    check(!spaceHasUnreleasedHeads(appSpace), `${appSpace}: Application metadata changed after authoritative cluster-root selection/publication`);
  }
}

function publishDeliveryRoot(deployment, state) {
  let bootstrap = state.fleetBootstrapJournal;
  if (bootstrap?.state !== "started" || bootstrap.rootActivatedClusters.includes(deployment.cluster)) {
    const release = publishRelease(deployment.appSpace, state);
    const root = deliveryRootDeployment(deployment.cluster);
    convergeDeploymentApplication(
      root,
      state,
      releaseManifestDigest(release),
      releaseIdentity({ latestPublishedRelease: release }),
    );
    return release;
  }
  const expectedCluster = bootstrap.expectedClusters[bootstrap.rootActivatedClusters.length];
  check(
    expectedCluster === deployment.cluster,
    `${deployment.cluster}: first delivery-root activation is out of order; expected ${expectedCluster ?? "none"}`,
  );
  const sourceSpaces = plan.deployments
    .filter((item) => item.cluster === deployment.cluster)
    .map((item) => item.space)
    .filter((slug, index, all) => all.indexOf(slug) === index)
    .sort();
  const liveSpaces = readSpaces();
  for (const slug of sourceSpaces) {
    check(liveSpaces.has(slug), `${deployment.cluster}: source Space ${slug} is missing before first root activation`);
    check(
      !hasRelease(slug),
      `${deployment.cluster}: refusing first root activation because ${slug} already has a published :latest`,
    );
  }
  const root = deliveryRootDeployment(deployment.cluster);
  const liveRoot = readLiveArgoApplication(root);
  assertDeliveryRootApplicationContract(liveRoot, root);
  const rootOperationPhase = liveRoot.status?.operationState?.phase ?? "Unknown";
  check(
    !liveRoot.operation && !["Running", "Terminating"].includes(rootOperationPhase),
    `${deployment.cluster}/${deployment.appSpace}: live root has an active operation before first governed activation`,
  );
  if (!bootstrap.preparedRootCluster) {
    // `cub cluster up` and `cub variant create --target` publish intermediate
    // apps-Space releases as part of their normal topology construction. They
    // are retained history, not activation authority: the live root was fenced
    // before variant creation, every source Space is still release-empty, and
    // publishRelease below will reuse or create only a complete strict no-auto
    // delivery-root boundary before recording its exact digest.
    bootstrap = prepareFleetRootActivation(deployment.cluster);
    state.fleetBootstrapJournal = bootstrap;
  } else {
    check(
      bootstrap.preparedRootCluster === deployment.cluster,
      `${deployment.cluster}: another first root activation is prepared: ${bootstrap.preparedRootCluster}`,
    );
  }
  const release = publishRelease(deployment.appSpace, state);
  bootstrap = checkpointFleetRootActivation(deployment.cluster, release);
  state.fleetBootstrapJournal = bootstrap;
  recordAction(state, "fleet-root-activate", deployment.appSpace, `manifest=${releaseManifestDigest(release)}`);
  convergeDeploymentApplication(
    root,
    state,
    releaseManifestDigest(release),
    releaseIdentity({ latestPublishedRelease: release }),
  );
  return release;
}

function kubernetesResourceNotFound(output) {
  return /Error from server \(NotFound\):[\s\S]+\bnot found\b/i.test(String(output ?? ""));
}

function readLiveArgoApplication(deployment, { allowNotFound = false } = {}) {
  const result = kubectlTry(deployment.cluster, [
    "get", "application", deployment.space, "-n", "argocd", "-o", "json",
  ], { expectedFailure: allowNotFound });
  if (!result.ok && allowNotFound && kubernetesResourceNotFound(result.output)) return null;
  check(result.ok, `${deployment.cluster}/${deployment.space}: Argo Application is unavailable before sync`);
  return JSON.parse(result.output);
}

function waitForArgoApplicationContract(deployment) {
  let app = null;
  let contractError = "Application not observed";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    app = readLiveArgoApplication(deployment, { allowNotFound: true });
    if (!app) {
      command("sleep", ["2"], { waitReason: "argo-application-contract" });
      continue;
    }
    try {
      assertArgoApplicationContract(app, deployment, {
        allowAutomated: deployment.deliveryRoot === true,
      });
      return app;
    } catch (error) {
      contractError = error.message;
      command("sleep", ["2"], { waitReason: "argo-application-contract" });
    }
  }
  check(false, `${deployment.cluster}/${deployment.space}: live Argo Application contract did not converge: ${contractError}`);
}

function deploymentApplicationAccepted(app, deployment, expectedRevision) {
  return app.status?.sync?.status === "Synced"
    && deployment.acceptedHealth.includes(app.status?.health?.status ?? "Unknown")
    && app.status?.sync?.revision === expectedRevision;
}

function argoConvergenceState(app, deployment, expectedRevision) {
  const phase = app.status?.operationState?.phase ?? "Unknown";
  if (app.operation || ["Running", "Terminating"].includes(phase)) return "active-operation";
  if (deploymentApplicationAccepted(app, deployment, expectedRevision)) return "accepted";
  if (
    ["Failed", "Error"].includes(phase)
      && operationStateRevision(app) === expectedRevision
  ) return "retryable";
  if (
    app.status?.sync?.status === "Synced"
      && app.status?.sync?.revision === expectedRevision
  ) return "health-pending";
  return "retryable";
}

function argoObservation(app) {
  return {
    sync: app.status?.sync?.status ?? "Unknown",
    health: app.status?.health?.status ?? "Unknown",
    phase: app.status?.operationState?.phase ?? "Unknown",
    revision: app.status?.sync?.revision ?? "Unknown",
    startedAt: app.status?.operationState?.startedAt ?? null,
    finishedAt: app.status?.operationState?.finishedAt ?? null,
    message: app.status?.operationState?.message
      ?? app.status?.conditions?.map((item) => item.message).join("; ")
      ?? "",
  };
}

function observedTimestamp(value, fallback, observedAt = fallback) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= observedAt
    ? parsed
    : fallback;
}

function operationStateRevision(app) {
  return app.status?.operationState?.syncResult?.revision ?? "";
}

function expectedRevisionTimestamp(app, expectedRevision, field, fallback, observedAt = fallback) {
  const statusRevision = operationStateRevision(app);
  if (statusRevision !== expectedRevision) return fallback;
  return observedTimestamp(app.status?.operationState?.[field], fallback, observedAt);
}

function convergencePhaseStartedAt(app, expectedRevision, field, firstObservedAt, previousStartedAt, observedAt) {
  const controllerStartedAt = expectedRevisionTimestamp(
    app,
    expectedRevision,
    field,
    firstObservedAt,
    observedAt,
  );
  return Math.max(firstObservedAt, previousStartedAt ?? firstObservedAt, controllerStartedAt);
}

function withinDeadline(startedAt, observedAt, timeout) {
  return Number.isFinite(startedAt)
    && Number.isFinite(observedAt)
    && Number.isFinite(timeout)
    && timeout >= 0
    && observedAt >= startedAt
    && observedAt - startedAt <= timeout;
}

function convergenceJournalKey(deployment, expectedRevision) {
  return `${deployment.cluster}/${deployment.space}@${expectedRevision}`;
}

function convergenceJournalEntry(deployment, expectedRevision, now, existing = null) {
  const key = convergenceJournalKey(deployment, expectedRevision);
  if (existing) {
    check(existing.application === `${deployment.cluster}/${deployment.space}`, `${key}: convergence journal Application drifted`);
    check(existing.expectedRevision === expectedRevision, `${key}: convergence journal revision drifted`);
    check(Number.isInteger(existing.syncReservations) && existing.syncReservations >= 0, `${key}: convergence journal sync reservation count is invalid`);
    check(Number.isFinite(Date.parse(existing.startedAt)), `${key}: convergence journal start time is invalid`);
    return existing;
  }
  return {
    application: `${deployment.cluster}/${deployment.space}`,
    expectedRevision,
    startedAt: new Date(now).toISOString(),
    syncReservations: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

function beginConvergenceJournal(deployment, expectedRevision) {
  const key = convergenceJournalKey(deployment, expectedRevision);
  const now = Date.now();
  const journal = updateOperationJournal((current) => {
    current.convergence[key] = convergenceJournalEntry(
      deployment,
      expectedRevision,
      now,
      current.convergence[key],
    );
  });
  return { key, ...journal.convergence[key] };
}

function reserveConvergenceSync(key) {
  let reserved = 0;
  updateOperationJournal((journal) => {
    const entry = journal.convergence[key];
    check(entry, `${key}: convergence journal entry is missing before sync reservation`);
    check(entry.syncReservations < ARGO_MAX_SYNC_REQUESTS, `${key}: convergence journal exhausted sync reservations`);
    entry.syncReservations += 1;
    entry.updatedAt = new Date().toISOString();
    reserved = entry.syncReservations;
  });
  return reserved;
}

function releaseUnusedConvergenceSyncReservation(key, reservation) {
  let remaining = null;
  updateOperationJournal((journal) => {
    const entry = journal.convergence[key];
    check(entry, `${key}: convergence journal entry is missing before unused sync reservation release`);
    check(
      entry.syncReservations === reservation && reservation > 0,
      `${key}: convergence journal sync reservation changed before a confirmed no-side-effect release`,
    );
    entry.syncReservations -= 1;
    entry.updatedAt = new Date().toISOString();
    remaining = entry.syncReservations;
  });
  return remaining;
}

function clearConvergenceJournalEntry(journal, key) {
  delete journal.convergence[key];
}

function clearConvergenceJournal(key) {
  updateOperationJournal((journal) => {
    clearConvergenceJournalEntry(journal, key);
  });
}

function argoTrackingID(deployment, migration, namespace) {
  const group = migration.apiVersion.split("/")[0];
  return `${deployment.space}:${group}/${migration.kind}:${namespace}/${migration.name}`;
}

function hostNetworkBindings(workload) {
  const podSpec = workload.spec?.template?.spec ?? {};
  const bindings = [];
  for (const container of [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])]) {
    for (const port of container.ports ?? []) {
      const protocol = port.protocol ?? "TCP";
      if (Number(port.hostPort) > 0) bindings.push(`${protocol}/${port.hostPort}`);
      if (podSpec.hostNetwork === true && Number(port.containerPort) > 0) {
        bindings.push(`${protocol}/${port.containerPort}`);
      }
    }
  }
  return [...new Set(bindings)].sort();
}

function trackedOrigin(workload) {
  try {
    return JSON.parse(workload.metadata?.annotations?.["confighub.com/origin"] ?? "{}");
  } catch {
    return {};
  }
}

function trackedOriginSpace(workload) {
  return trackedOrigin(workload).spaceSlug ?? "";
}

function retryableKubernetesCompareAndSet(output) {
  return /test failed|conflict|object has been modified|not[\s_-]*found/i.test(String(output ?? ""));
}

function deleteAppsWorkloadWithPreconditions(cluster, resourcePlural, namespace, name, uid, resourceVersion) {
  check(["daemonsets", "deployments", "statefulsets"].includes(resourcePlural), `${cluster}: unsupported precondition-delete resource ${resourcePlural}`);
  const config = readYaml(clusterKubeconfig(cluster));
  const contextName = `kind-${cluster}`;
  const context = (config.contexts ?? []).find((item) => item.name === contextName)?.context;
  check(context?.cluster && context?.user, `${cluster}: kubeconfig context ${contextName} is incomplete`);
  const clusterConfig = (config.clusters ?? []).find((item) => item.name === context.cluster)?.cluster;
  const userConfig = (config.users ?? []).find((item) => item.name === context.user)?.user;
  check(clusterConfig?.server && clusterConfig?.["certificate-authority-data"], `${cluster}: kubeconfig cluster TLS data is incomplete`);
  const server = new URL(clusterConfig.server);
  check(
    server.protocol === "https:"
      && ["127.0.0.1", "localhost", "::1"].includes(server.hostname),
    `${cluster}: namespace-move precondition delete is restricted to a loopback kind API server`,
  );
  check(
    userConfig?.["client-certificate-data"] && userConfig?.["client-key-data"],
    `${cluster}: namespace-move precondition delete requires the declared kind client-certificate kubeconfig`,
  );
  const temp = mkdtempSync(join(tmpdir(), "helm-expt-kubara-delete-"));
  try {
    const caPath = join(temp, "ca.crt");
    const certPath = join(temp, "client.crt");
    const keyPath = join(temp, "client.key");
    writeFileSync(caPath, Buffer.from(clusterConfig["certificate-authority-data"], "base64"), { mode: 0o600 });
    writeFileSync(certPath, Buffer.from(userConfig["client-certificate-data"], "base64"), { mode: 0o600 });
    writeFileSync(keyPath, Buffer.from(userConfig["client-key-data"], "base64"), { mode: 0o600 });
    const endpoint = `${server.toString().replace(/\/$/, "")}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${resourcePlural}/${encodeURIComponent(name)}`;
    return tryCommand("curl", [
      "--silent", "--show-error", "--fail-with-body",
      "--connect-timeout", "10", "--max-time", "120",
      "--request", "DELETE",
      "--header", "Content-Type: application/json",
      "--cacert", caPath,
      "--cert", certPath,
      "--key", keyPath,
      "--data", JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid, resourceVersion },
        propagationPolicy: "Background",
      }),
      endpoint,
    ], { timeout: 130_000 });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function deleteDaemonSetWithPreconditions(cluster, namespace, name, uid, resourceVersion) {
  return deleteAppsWorkloadWithPreconditions(
    cluster,
    "daemonsets",
    namespace,
    name,
    uid,
    resourceVersion,
  );
}

function writeNamespaceMoveAttempt(item) {
  updateOperationJournal((journal) => {
    const existing = journal.namespaceMove;
    check(!existing || (existing.ref === item.ref && existing.uid === item.uid), "refusing to replace a different namespace-move journal attempt");
    journal.namespaceMove = item;
  });
}

function namespaceMoveCurrentObject(deployment, migration) {
  const result = kubectlTry(deployment.cluster, [
    "get", migration.resource, migration.name,
    "-n", migration.fromNamespace, "-o", "json",
  ], { expectedFailure: true });
  if (!result.ok && kubernetesResourceNotFound(result.output)) return null;
  check(result.ok, `${deployment.cluster}: failed to inspect namespace-move journal resource`);
  return JSON.parse(result.output);
}

function completeNamespaceMoveAttempt(state, attempt, outcome) {
  const completed = {
    ...attempt,
    source: undefined,
    state: "observed-gone",
    evidenceScope: "historical-migration-event",
    revisionAtDeletion: attempt.expectedRevision,
    outcome,
    observedGoneAt: new Date().toISOString(),
  };
  delete completed.source;
  delete completed.expectedRevision;
  writeNamespaceMoveAttempt(completed);
  state.namespaceMoveAttempts.set(completed.ref, { ...completed, source: "journal" });
  if (!state.namespaceMoveEvidence.some((item) => item.ref === completed.ref && item.uid === completed.uid)) {
    state.namespaceMoveEvidence.push(completed);
  }
  return completed;
}

function recoverNamespaceMoveAttempt(deployment, migration, state) {
  const ref = `${deployment.cluster}/${migration.kind}/${migration.fromNamespace}/${migration.name}`;
  const attempt = state.namespaceMoveAttempts.get(ref);
  if (!attempt || attempt.source !== "journal") return null;
  const current = namespaceMoveCurrentObject(deployment, migration);
  if (attempt.state === "observed-gone") {
    check(current?.metadata?.uid !== attempt.uid, `${ref}: a UID recorded gone reappeared`);
    return attempt;
  }
  if (current?.metadata?.uid === attempt.uid) {
    return attempt;
  }
  const outcome = current
    ? `original-uid-gone-replaced-by-${current.metadata?.uid ?? "unknown"}`
    : "original-uid-gone";
  const completed = completeNamespaceMoveAttempt(state, attempt, outcome);
  recordAction(state, "argo-namespace-move-recovery", ref, `uid=${attempt.uid}; ${outcome}`);
  return completed;
}

function waitForNamespaceMoveUIDGone(deployment, migration, uid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = namespaceMoveCurrentObject(deployment, migration);
    if (!current || current.metadata?.uid !== uid) {
      return current?.metadata?.uid
        ? `original-uid-gone-replaced-by-${current.metadata.uid}`
        : "original-uid-gone";
    }
    command("sleep", ["1"], { waitReason: "namespace-move-uid-gone" });
  }
  check(false, `${deployment.cluster}: namespace-move UID ${uid} was not deleted within 2 minutes`);
}

function activeOperationMatchesExpectedRevision(app, expectedRevision) {
  const phase = app.status?.operationState?.phase ?? "Unknown";
  if (app.operation) return app.operation?.sync?.revision === expectedRevision;
  if (!["Running", "Terminating"].includes(phase)) return true;
  return operationStateRevision(app) === expectedRevision;
}

function pruneDeclaredNamespaceMoveBlockers(deployment, state, app, expectedRevision) {
  let changed = false;
  for (const migration of deployment.namespaceMovePrunes ?? []) {
    const ref = `${deployment.cluster}/${migration.kind}/${migration.fromNamespace}/${migration.name}`;
    const beforeRecovery = state.namespaceMoveAttempts.get(ref)?.state ?? "";
    const recovered = recoverNamespaceMoveAttempt(deployment, migration, state);
    if (recovered?.state === "observed-gone" && beforeRecovery !== "observed-gone") changed = true;
    if (
      app.status?.sync?.revision !== expectedRevision
        || !activeOperationMatchesExpectedRevision(app, expectedRevision)
    ) continue;
    const group = migration.apiVersion.split("/")[0];
    const staleStatus = (app.status?.resources ?? []).find(
      (item) => item.group === group
        && item.kind === migration.kind
        && item.namespace === migration.fromNamespace
        && item.name === migration.name
        && item.requiresPruning === true,
    );
    if (!staleStatus) continue;

    const obsoleteResult = kubectlTry(deployment.cluster, [
      "get", migration.resource, migration.name,
      "-n", migration.fromNamespace, "-o", "json",
    ], { expectedFailure: true });
    if (!obsoleteResult.ok && kubernetesResourceNotFound(obsoleteResult.output)) continue;
    check(obsoleteResult.ok, `${deployment.cluster}: failed to inspect declared namespace-move blocker ${migration.fromNamespace}/${migration.name}`);

    const desiredStatus = (app.status?.resources ?? []).find(
      (item) => item.group === group
        && item.kind === migration.kind
        && item.namespace === deployment.destinationNamespace
        && item.name === migration.name
        && item.requiresPruning !== true,
    );
    if (!desiredStatus) continue;
    const desiredResult = kubectlTry(deployment.cluster, [
      "get", migration.resource, migration.name,
      "-n", deployment.destinationNamespace, "-o", "json",
    ], { expectedFailure: true });
    if (!desiredResult.ok && kubernetesResourceNotFound(desiredResult.output)) continue;
    check(desiredResult.ok, `${deployment.cluster}: failed to inspect desired namespace-move replacement ${deployment.destinationNamespace}/${migration.name}`);

    const obsolete = JSON.parse(obsoleteResult.output);
    const desired = JSON.parse(desiredResult.output);
    check(obsolete.apiVersion === migration.apiVersion && obsolete.kind === migration.kind, `${deployment.cluster}: obsolete namespace-move blocker identity drifted`);
    check(desired.apiVersion === migration.apiVersion && desired.kind === migration.kind, `${deployment.cluster}: desired namespace-move replacement identity drifted`);
    check(
      obsolete.metadata?.name === migration.name
        && obsolete.metadata?.namespace === migration.fromNamespace
        && UUID_PATTERN.test(obsolete.metadata?.uid ?? ""),
      `${deployment.cluster}: obsolete namespace-move blocker metadata identity drifted`,
    );
    check(
      desired.metadata?.name === migration.name
        && desired.metadata?.namespace === deployment.destinationNamespace
        && UUID_PATTERN.test(desired.metadata?.uid ?? ""),
      `${deployment.cluster}: desired namespace-move replacement metadata identity drifted`,
    );
    check(
      obsolete.metadata?.annotations?.["argocd.argoproj.io/tracking-id"]
        === argoTrackingID(deployment, migration, migration.fromNamespace),
      `${deployment.cluster}: obsolete namespace-move blocker is not tracked by ${deployment.space}`,
    );
    check(
      desired.metadata?.annotations?.["argocd.argoproj.io/tracking-id"]
        === argoTrackingID(deployment, migration, deployment.destinationNamespace),
      `${deployment.cluster}: desired namespace-move replacement is not tracked by ${deployment.space}`,
    );
    check(
      trackedOriginSpace(obsolete) === deployment.space
        && trackedOriginSpace(desired) === deployment.space,
      `${deployment.cluster}: namespace-move resources do not share ConfigHub origin ${deployment.space}`,
    );
    const obsoleteBindings = hostNetworkBindings(obsolete);
    const desiredBindings = hostNetworkBindings(desired);
    const conflicts = obsoleteBindings.filter((binding) => desiredBindings.includes(binding));
    check(
      stableJson(conflicts) === stableJson(migration.conflictingBindings),
      `${deployment.cluster}: declared namespace-move blocker binding drifted from ${migration.conflictingBindings.join(",")}`,
    );

    const priorAttempt = state.namespaceMoveAttempts.get(ref);
    if (priorAttempt) {
      check(priorAttempt.source === "journal" && priorAttempt.uid === obsolete.metadata.uid && priorAttempt.state !== "observed-gone", `${ref}: declared one-time namespace-move blocker was already consumed or replaced`);
      check(priorAttempt.migrationID === migration.migrationID, `${ref}: prepared migration identity drifted`);
      check(priorAttempt.expectedRevision === expectedRevision, `${ref}: prepared migration OCI revision drifted`);
      check(priorAttempt.resourceVersion === obsolete.metadata.resourceVersion, `${ref}: prepared migration resourceVersion changed before deletion`);
    }
    check(obsolete.metadata?.resourceVersion, `${ref}: resourceVersion missing before precondition delete`);
    let attempt = {
      ...(priorAttempt ?? {}),
      migrationID: migration.migrationID,
      ref,
      uid: obsolete.metadata.uid,
      resourceVersion: obsolete.metadata.resourceVersion,
      application: `${deployment.cluster}/${deployment.space}`,
      expectedRevision,
      apiVersion: migration.apiVersion,
      kind: migration.kind,
      name: migration.name,
      fromNamespace: migration.fromNamespace,
      toNamespace: deployment.destinationNamespace,
      conflictingBindings: conflicts,
      reason: migration.reason,
      state: "prepared",
      preparedAt: priorAttempt?.preparedAt ?? new Date().toISOString(),
    };
    delete attempt.source;
    writeNamespaceMoveAttempt(attempt);
    state.namespaceMoveAttempts.set(ref, { ...attempt, source: "journal" });
    const deleted = deleteDaemonSetWithPreconditions(
      deployment.cluster,
      migration.fromNamespace,
      migration.name,
      obsolete.metadata.uid,
      obsolete.metadata.resourceVersion,
    );
    if (!deleted.ok && retryableKubernetesCompareAndSet(deleted.output)) {
      const current = namespaceMoveCurrentObject(deployment, migration);
      if (!current || current.metadata?.uid !== obsolete.metadata.uid) {
        const outcome = current?.metadata?.uid
          ? `original-uid-gone-replaced-by-${current.metadata.uid}`
          : "original-uid-gone";
        attempt = completeNamespaceMoveAttempt(state, attempt, outcome);
        recordAction(state, "argo-namespace-move-recovery", ref, `uid=${attempt.uid}; ${outcome}`);
        changed = true;
      }
      continue;
    }
    check(deleted.ok, `${ref}: UID/resourceVersion-preconditioned namespace-move deletion failed`);
    attempt = {
      ...attempt,
      state: "delete-returned",
      deleteReturnedAt: new Date().toISOString(),
    };
    writeNamespaceMoveAttempt(attempt);
    state.namespaceMoveAttempts.set(ref, { ...attempt, source: "journal" });
    const outcome = waitForNamespaceMoveUIDGone(deployment, migration, obsolete.metadata.uid);
    attempt = completeNamespaceMoveAttempt(state, attempt, outcome);
    recordAction(
      state,
      "argo-namespace-move-prune",
      ref,
      `uid=${obsolete.metadata.uid}; outcome=${outcome}; ${deployment.destinationNamespace}/${migration.name}; bindings=${conflicts.join(",")}; ${migration.reason}`,
    );
    changed = true;
  }
  return changed;
}

function immutableSelectorReplacementRef(deployment, migration) {
  return `${deployment.cluster}/${migration.kind}/${migration.namespace}/${migration.name}`;
}

function writeImmutableSelectorReplacementAttempt(item) {
  updateOperationJournal((journal) => {
    journal.immutableSelectorReplacements ??= {};
    const existing = journal.immutableSelectorReplacements[item.migrationID];
    check(
      !existing || existing.uid === item.uid,
      `${item.migrationID}: refusing to replace a different immutable-selector workload UID`,
    );
    journal.immutableSelectorReplacements[item.migrationID] = item;
  });
}

function immutableSelectorCurrentObject(deployment, migration) {
  const result = kubectlTry(deployment.cluster, [
    "get", migration.resource, migration.name,
    "-n", migration.namespace, "-o", "json",
  ], { expectedFailure: true });
  if (!result.ok && kubernetesResourceNotFound(result.output)) return null;
  check(result.ok, `${deployment.cluster}: failed to inspect immutable-selector ${migration.kind}/${migration.namespace}/${migration.name}`);
  return JSON.parse(result.output);
}

function assertImmutableSelectorOwnedObject(deployment, migration, workload, selector, prefix) {
  check(workload?.apiVersion === migration.apiVersion && workload?.kind === migration.kind, `${prefix}: apiVersion/kind drifted`);
  check(
    workload.metadata?.name === migration.name
      && workload.metadata?.namespace === migration.namespace
      && UUID_PATTERN.test(workload.metadata?.uid ?? "")
      && /^\d+$/.test(String(workload.metadata?.resourceVersion ?? "")),
    `${prefix}: Kubernetes identity is incomplete`,
  );
  check(
    workload.metadata?.annotations?.["argocd.argoproj.io/tracking-id"]
      === `${deployment.space}:apps/${migration.kind}:${migration.namespace}/${migration.name}`,
    `${prefix}: Argo tracking identity drifted`,
  );
  const origin = trackedOrigin(workload);
  check(
    origin.spaceSlug === deployment.space
      && origin.unitSlug === migration.unitSlug
      && UUID_PATTERN.test(origin.unitId ?? ""),
    `${prefix}: ConfigHub origin Space/Unit identity drifted`,
  );
  check(stableJson(workload.spec?.selector?.matchLabels ?? {}) === stableJson(selector), `${prefix}: selector drifted`);
  check(
    stableJson(workload.spec?.template?.metadata?.labels ?? {}) === stableJson(selector),
    `${prefix}: pod-template labels do not exactly match the selector`,
  );
  if ((migration.retainedPVCNames ?? []).length > 0) {
    check(
      workload.kind === "StatefulSet"
        && workload.spec?.serviceName === migration.serviceName
        && (workload.spec?.persistentVolumeClaimRetentionPolicy?.whenDeleted ?? "Retain") === "Retain"
        && (workload.spec?.persistentVolumeClaimRetentionPolicy?.whenScaled ?? "Retain") === "Retain",
      `${prefix}: StatefulSet service or PVC-retention contract drifted`,
    );
  }
}

function assertImmutableSelectorReviewedPayload(deployment, migration) {
  const data = readUnitData(deployment.space, migration.unitSlug);
  const workloads = parseDocs(data).filter(
    (doc) => doc.apiVersion === migration.apiVersion
      && doc.kind === migration.kind
      && doc.metadata?.name === migration.name
      && doc.metadata?.namespace === migration.namespace,
  );
  check(workloads.length === 1, `${migration.migrationID}: authoritative ConfigHub Unit does not contain exactly one reviewed workload`);
  const workload = workloads[0];
  check(
    stableJson(workload.spec?.selector?.matchLabels ?? {}) === stableJson(migration.toSelector),
    `${migration.migrationID}: authoritative ConfigHub Unit selector drifted`,
  );
  check(
    stableJson(workload.spec?.template?.metadata?.labels ?? {}) === stableJson(migration.toSelector),
    `${migration.migrationID}: authoritative ConfigHub Unit pod-template labels drifted`,
  );
}

function retainedPVCObservations(deployment, migration) {
  const names = migration.retainedPVCNames ?? [];
  if (names.length === 0) return [];
  check(migration.kind === "StatefulSet", `${migration.migrationID}: only a StatefulSet may declare retained PVCs`);
  return names.map((name) => {
    const result = kubectlTry(deployment.cluster, [
      "get", "persistentvolumeclaim", name,
      "-n", migration.namespace, "-o", "json",
    ]);
    check(result.ok, `${migration.migrationID}: retained PVC ${name} is absent`);
    const pvc = JSON.parse(result.output);
    check(
      pvc.metadata?.name === name
        && pvc.metadata?.namespace === migration.namespace
        && UUID_PATTERN.test(pvc.metadata?.uid ?? "")
        && pvc.status?.phase === "Bound",
      `${migration.migrationID}: retained PVC ${name} identity or binding drifted`,
    );
    check((pvc.metadata?.ownerReferences ?? []).length === 0, `${migration.migrationID}: retained PVC ${name} unexpectedly has a workload owner`);
    return {
      name,
      uid: pvc.metadata.uid,
      volumeName: pvc.spec?.volumeName ?? "",
      phase: pvc.status.phase,
    };
  });
}

function assertRetainedPVCsUnchanged(deployment, migration, expected, prefix) {
  const current = retainedPVCObservations(deployment, migration);
  check(stableJson(current) === stableJson(expected ?? []), `${prefix}: retained PVC identity or volume binding changed`);
  return current;
}

function immutableSelectorFailureMessage(item) {
  if (/spec\.selector[\s\S]*field is immutable/i.test(item.message ?? "")) return true;
  return item.kind === "StatefulSet"
    && /updates to statefulset spec[\s\S]*forbidden/i.test(item.message ?? "");
}

function immutableSelectorFailureRow(app, migration) {
  if (app.operation) return null;
  if (!["Failed", "Error"].includes(app.status?.operationState?.phase)) return null;
  if (app.status?.sync?.revision !== operationStateRevision(app)) return null;
  return (app.status?.operationState?.syncResult?.resources ?? []).find(
    (item) => item.group === "apps"
      && item.kind === migration.kind
      && item.namespace === migration.namespace
      && item.name === migration.name
      && item.status === "SyncFailed"
      && item.hookPhase === "Failed"
      && immutableSelectorFailureMessage(item),
  ) ?? null;
}

function immutableSelectorFailureEvidence(app, failure) {
  const evidence = {
    phase: app.status.operationState.phase,
    syncRevision: app.status.sync.revision,
    operationRevision: operationStateRevision(app),
    resource: {
      group: failure.group,
      kind: failure.kind,
      namespace: failure.namespace,
      name: failure.name,
      status: failure.status,
      hookPhase: failure.hookPhase,
      message: failure.message,
    },
  };
  return {
    ...evidence,
    sha256: `sha256:${sha256(stableJson(evidence))}`,
  };
}

function immutableSelectorResourceFailures(app) {
  return (app.status?.operationState?.syncResult?.resources ?? []).filter(
    (item) => item.status === "SyncFailed"
      && item.hookPhase === "Failed"
      && immutableSelectorFailureMessage(item),
  );
}

function markImmutableSelectorOldUIDGone(state, attempt, outcome) {
  const updated = {
    ...attempt,
    source: undefined,
    state: "old-uid-gone",
    outcome,
    oldUIDGoneAt: new Date().toISOString(),
  };
  delete updated.source;
  writeImmutableSelectorReplacementAttempt(updated);
  state.immutableSelectorAttempts.set(updated.migrationID, { ...updated, source: "journal" });
  return updated;
}

function recoverImmutableSelectorReplacement(deployment, migration, state) {
  const attempt = state.immutableSelectorAttempts.get(migration.migrationID);
  if (!attempt) return null;
  const current = immutableSelectorCurrentObject(deployment, migration);
  if (attempt.state === "replacement-healthy") {
    check(current?.metadata?.uid === attempt.replacementUID, `${migration.migrationID}: completed replacement UID drifted`);
    assertImmutableSelectorOwnedObject(
      deployment,
      migration,
      current,
      migration.toSelector,
      `${migration.migrationID}: completed replacement`,
    );
    assertRetainedPVCsUnchanged(deployment, migration, attempt.retainedPVCs, `${migration.migrationID}: completed replacement`);
    return attempt;
  }
  if (attempt.state === "old-uid-gone") {
    check(current?.metadata?.uid !== attempt.uid, `${migration.migrationID}: old workload UID reappeared`);
    if (current) {
      assertImmutableSelectorOwnedObject(
        deployment,
        migration,
        current,
        migration.toSelector,
        `${migration.migrationID}: replacement candidate`,
      );
      assertRetainedPVCsUnchanged(deployment, migration, attempt.retainedPVCs, `${migration.migrationID}: replacement candidate`);
    }
    return attempt;
  }
  check(["prepared", "delete-returned"].includes(attempt.state), `${migration.migrationID}: immutable-selector journal state is invalid`);
  if (current?.metadata?.uid === attempt.uid) return attempt;
  const outcome = current?.metadata?.uid
    ? `old-uid-gone-replaced-by-${current.metadata.uid}`
    : "old-uid-gone";
  const updated = markImmutableSelectorOldUIDGone(state, attempt, outcome);
  recordAction(state, "argo-immutable-selector-recovery", immutableSelectorReplacementRef(deployment, migration), `uid=${attempt.uid}; ${outcome}`);
  return updated;
}

function waitForImmutableSelectorOldUIDGone(deployment, migration, uid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = immutableSelectorCurrentObject(deployment, migration);
    if (!current || current.metadata?.uid !== uid) {
      return current?.metadata?.uid
        ? `old-uid-gone-replaced-by-${current.metadata.uid}`
        : "old-uid-gone";
    }
    command("sleep", ["1"], { waitReason: "immutable-selector-old-uid-gone" });
  }
  check(false, `${deployment.cluster}: immutable-selector workload UID ${uid} was not deleted within 2 minutes`);
}

function replaceDeclaredImmutableSelector(
  deployment,
  migration,
  state,
  app,
  expectedRevision,
  expectedReleaseIdentity,
  sourcePayloadKeys,
) {
  const recovered = recoverImmutableSelectorReplacement(deployment, migration, state);
  if (recovered?.state === "replacement-healthy" || recovered?.state === "old-uid-gone") return false;
  check(!app.operation && !["Running", "Terminating"].includes(app.status?.operationState?.phase), `${migration.migrationID}: refusing immutable-selector replacement during an active Argo operation`);
  const current = immutableSelectorCurrentObject(deployment, migration);
  if (!current) {
    if (recovered) {
      markImmutableSelectorOldUIDGone(state, recovered, "old-uid-gone");
      return true;
    }
    return false;
  }
  if (stableJson(current.spec?.selector?.matchLabels ?? {}) === stableJson(migration.toSelector)) {
    assertImmutableSelectorOwnedObject(deployment, migration, current, migration.toSelector, `${migration.migrationID}: current Deployment`);
    check(!recovered, `${migration.migrationID}: replacement exists while a nonterminal old UID is journaled`);
    return false;
  }
  assertImmutableSelectorOwnedObject(deployment, migration, current, migration.fromSelector, `${migration.migrationID}: legacy workload`);
  assertImmutableSelectorReviewedPayload(deployment, migration);
  const retainedPVCs = retainedPVCObservations(deployment, migration);
  assertReleaseStreamStillCurrent(
    deployment.space,
    expectedReleaseIdentity,
    expectedRevision,
    sourcePayloadKeys,
  );
  const failure = immutableSelectorFailureRow(app, migration);
  if (!failure) {
    check(!recovered, `${migration.migrationID}: prepared replacement lost its exact resource-level immutable-selector failure`);
    return false;
  }
  check(
    app.status?.sync?.revision === expectedRevision
      && operationStateRevision(app) === expectedRevision,
    `${migration.migrationID}: immutable-selector failure is not bound to the exact expected OCI revision`,
  );
  const trigger = "recovered-resource-level-immutable-selector-failure";
  if (recovered) {
    check(recovered.uid === current.metadata.uid, `${migration.migrationID}: prepared workload UID changed`);
    check(recovered.resourceVersion === current.metadata.resourceVersion, `${migration.migrationID}: prepared Deployment resourceVersion changed`);
    check(recovered.expectedRevision === expectedRevision, `${migration.migrationID}: prepared OCI revision changed`);
  }
  let attempt = {
    ...(recovered ?? {}),
    migrationID: migration.migrationID,
    ref: immutableSelectorReplacementRef(deployment, migration),
    uid: current.metadata.uid,
    resourceVersion: current.metadata.resourceVersion,
    application: `${deployment.cluster}/${deployment.space}`,
    expectedRevision,
    apiVersion: migration.apiVersion,
    kind: migration.kind,
    name: migration.name,
    namespace: migration.namespace,
    fromSelector: migration.fromSelector,
    toSelector: migration.toSelector,
    retainedPVCs,
    reason: migration.reason,
    trigger,
    failureEvidencePolicy: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY,
    failureEvidence: immutableSelectorFailureEvidence(app, failure),
    state: "prepared",
    preparedAt: recovered?.preparedAt ?? new Date().toISOString(),
  };
  delete attempt.source;
  writeImmutableSelectorReplacementAttempt(attempt);
  state.immutableSelectorAttempts.set(attempt.migrationID, { ...attempt, source: "journal" });
  const deleted = deleteAppsWorkloadWithPreconditions(
    deployment.cluster,
    migration.resourcePlural,
    migration.namespace,
    migration.name,
    attempt.uid,
    attempt.resourceVersion,
  );
  if (!deleted.ok && retryableKubernetesCompareAndSet(deleted.output)) {
    const after = immutableSelectorCurrentObject(deployment, migration);
    if (!after || after.metadata?.uid !== attempt.uid) {
      const outcome = after?.metadata?.uid
        ? `old-uid-gone-replaced-by-${after.metadata.uid}`
        : "old-uid-gone";
      attempt = markImmutableSelectorOldUIDGone(state, attempt, outcome);
      recordAction(state, "argo-immutable-selector-recovery", attempt.ref, `uid=${attempt.uid}; ${outcome}`);
      return true;
    }
    return false;
  }
  check(deleted.ok, `${attempt.ref}: UID/resourceVersion-preconditioned immutable-selector deletion failed`);
  attempt = {
    ...attempt,
    state: "delete-returned",
    deleteReturnedAt: new Date().toISOString(),
  };
  writeImmutableSelectorReplacementAttempt(attempt);
  state.immutableSelectorAttempts.set(attempt.migrationID, { ...attempt, source: "journal" });
  const outcome = waitForImmutableSelectorOldUIDGone(deployment, migration, attempt.uid);
  attempt = markImmutableSelectorOldUIDGone(state, attempt, outcome);
  recordAction(
    state,
    "argo-immutable-selector-replace",
    attempt.ref,
    `uid=${attempt.uid}; outcome=${outcome}; trigger=${trigger}; ${migration.reason}`,
  );
  return true;
}

function completeDeclaredImmutableSelectorReplacement(deployment, migration, state, app, expectedRevision) {
  const attempt = recoverImmutableSelectorReplacement(deployment, migration, state);
  if (!attempt || attempt.state === "replacement-healthy") return true;
  check(attempt.state === "old-uid-gone", `${migration.migrationID}: accepted Argo state preceded old UID deletion`);
  check(app.status?.sync?.revision === expectedRevision, `${migration.migrationID}: replacement acceptance revision drifted`);
  const replacement = immutableSelectorCurrentObject(deployment, migration);
  check(replacement && replacement.metadata?.uid !== attempt.uid, `${migration.migrationID}: replacement workload UID is missing or unchanged`);
  assertImmutableSelectorOwnedObject(deployment, migration, replacement, migration.toSelector, `${migration.migrationID}: healthy replacement`);
  const retainedPVCs = assertRetainedPVCsUnchanged(
    deployment,
    migration,
    attempt.retainedPVCs,
    `${migration.migrationID}: healthy replacement`,
  );
  if (Number(replacement.status?.availableReplicas ?? replacement.status?.readyReplicas ?? 0) <= 0) return false;
  const slices = kubectlTry(deployment.cluster, [
    "get", "endpointslice", "-n", migration.namespace,
    "-l", `kubernetes.io/service-name=${migration.serviceName}`, "-o", "json",
  ]);
  check(slices.ok, `${migration.migrationID}: failed to inspect Service EndpointSlices`);
  const readyEndpoints = (JSON.parse(slices.output).items ?? []).flatMap((item) => item.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready !== false).length;
  if (readyEndpoints <= 0) return false;
  const completed = {
    ...attempt,
    source: undefined,
    state: "replacement-healthy",
    revisionAtReplacement: expectedRevision,
    replacementUID: replacement.metadata.uid,
    replacementResourceVersion: replacement.metadata.resourceVersion,
    readyEndpoints,
    retainedPVCs,
    completedAt: new Date().toISOString(),
  };
  delete completed.source;
  delete completed.expectedRevision;
  writeImmutableSelectorReplacementAttempt(completed);
  state.immutableSelectorAttempts.set(completed.migrationID, { ...completed, source: "journal" });
  state.immutableSelectorEvidence.push(completed);
  recordAction(state, "argo-immutable-selector-replacement-healthy", completed.ref, `oldUID=${completed.uid}; replacementUID=${completed.replacementUID}; readyEndpoints=${readyEndpoints}`);
  return true;
}

function writeProtectedNamespaceAttempt(item) {
  updateOperationJournal((journal) => {
    journal.protectedNamespaceDetachments ??= {};
    const existing = journal.protectedNamespaceDetachments[item.migrationID];
    check(
      !existing || existing.uid === item.uid,
      `${item.migrationID}: refusing to replace a different protected Namespace UID`,
    );
    journal.protectedNamespaceDetachments[item.migrationID] = item;
  });
}

function protectedNamespacePayloadContract(deployment, contract) {
  const unit = plan.managedUnits.find(
    (item) => item.space === deployment.space && item.slug === contract.unitSlug,
  );
  check(unit?.payloadKey, `${contract.migrationID}: deployment payload Unit is missing`);
  const payload = inputs.payloads.get(unit.payloadKey);
  check(payload, `${contract.migrationID}: deployment payload ${unit.payloadKey} is missing`);
  const namespaces = parseDocs(payload.value).filter((doc) => doc.apiVersion === "v1" && doc.kind === "Namespace");
  check(
    !namespaces.some((doc) => doc.metadata?.name === contract.retainedNamespace),
    `${contract.migrationID}: current payload still contains protected Namespace/${contract.retainedNamespace}`,
  );
  check(
    namespaces.filter((doc) => doc.metadata?.name === contract.replacementNamespace).length === 1,
    `${contract.migrationID}: current payload does not contain exactly one Namespace/${contract.replacementNamespace}`,
  );
}

function readProtectedNamespace(cluster, name) {
  const result = kubectlTry(
    cluster,
    ["get", "namespace", name, "-o", "json"],
    { expectedFailure: true },
  );
  if (!result.ok && kubernetesResourceNotFound(result.output)) return null;
  check(result.ok, `${cluster}: failed to inspect protected Namespace/${name}`);
  return JSON.parse(result.output);
}

function protectedNamespaceArgoStatus(app, name) {
  return (app.status?.resources ?? []).find(
    (item) => !item.group && item.kind === "Namespace" && item.name === name,
  ) ?? null;
}

function retainProtectedNamespaceEvidence(state, item) {
  state.protectedNamespaceAttempts.set(item.migrationID, { ...item, source: "journal" });
  const index = state.protectedNamespaceEvidence.findIndex(
    (existing) => existing.migrationID === item.migrationID,
  );
  if (index >= 0) state.protectedNamespaceEvidence[index] = item;
  else state.protectedNamespaceEvidence.push(item);
}

function completeProtectedNamespaceDetachment(state, attempt, retained, replacement, outcome) {
  const completed = {
    ...attempt,
    state: "observed-detached",
    outcome,
    evidenceScope: "historical-migration-event",
    resourceVersionAfter: retained.metadata.resourceVersion,
    replacementResourceVersionObserved: replacement.metadata.resourceVersion,
    observedDetachedAt: new Date().toISOString(),
  };
  delete completed.source;
  writeProtectedNamespaceAttempt(completed);
  retainProtectedNamespaceEvidence(state, completed);
  return completed;
}

function detachDeclaredProtectedNamespaceOwnership(deployment, state, app, expectedRevision) {
  if (!deployment.protectedNamespaceOwnershipDetachment) return false;
  const contract = protectedNamespaceContract(deployment.protectedNamespaceOwnershipDetachment);
  check(
    contract.cluster === deployment.cluster && contract.application === deployment.space,
    `${contract.migrationID}: protected Namespace contract does not match the deployment`,
  );
  if (
    app.status?.sync?.revision !== expectedRevision
      || !activeOperationMatchesExpectedRevision(app, expectedRevision)
  ) return false;

  protectedNamespacePayloadContract(deployment, contract);
  const replacementStatus = protectedNamespaceArgoStatus(app, contract.replacementNamespace);
  if (!replacementStatus || replacementStatus.requiresPruning === true || replacementStatus.status !== "Synced") {
    return false;
  }
  const retained = readProtectedNamespace(deployment.cluster, contract.retainedNamespace);
  const replacement = readProtectedNamespace(deployment.cluster, contract.replacementNamespace);
  check(retained, `${contract.migrationID}: protected Namespace/${contract.retainedNamespace} is missing`);
  if (!replacement) return false;
  const classification = classifyProtectedNamespaceOwnership(contract, retained, replacement);
  const prior = state.protectedNamespaceAttempts.get(contract.migrationID);

  if (prior?.state === "observed-detached") {
    validateProtectedNamespaceDetached(contract, prior.uid, retained, replacement);
    return false;
  }

  if (classification.state === "already-detached") {
    if (prior) {
      check(
        prior.source === "journal" && ["prepared", "patch-returned"].includes(prior.state),
        `${contract.migrationID}: incomplete ownership attempt has an invalid source or state`,
      );
      check(prior.uid === retained.metadata.uid, `${contract.migrationID}: retained Namespace UID changed during recovery`);
      check(prior.expectedRevision === expectedRevision, `${contract.migrationID}: recovery OCI revision drifted`);
    }
    const now = new Date().toISOString();
    const attempt = prior ?? {
      migrationID: contract.migrationID,
      cluster: contract.cluster,
      application: `${contract.cluster}/${contract.application}`,
      namespace: contract.retainedNamespace,
      replacementNamespace: contract.replacementNamespace,
      uid: retained.metadata.uid,
      replacementUID: replacement.metadata.uid,
      resourceVersionObserved: retained.metadata.resourceVersion,
      expectedRevision,
      state: "prepared",
      preparedAt: now,
    };
    const outcome = prior ? "detached-by-reconciler" : "already-detached";
    const completed = completeProtectedNamespaceDetachment(
      state,
      attempt,
      retained,
      replacement,
      outcome,
    );
    recordAction(
      state,
      prior ? "protected-namespace-detach-recovery" : "protected-namespace-already-detached",
      `${contract.cluster}/Namespace/${contract.retainedNamespace}`,
      `${contract.migrationID}; uid=${completed.uid}; outcome=${outcome}`,
    );
    return true;
  }

  const staleStatus = protectedNamespaceArgoStatus(app, contract.retainedNamespace);
  if (!staleStatus?.requiresPruning) return false;
  let attempt = prior;
  if (attempt) {
    check(attempt.source === "journal", `${contract.migrationID}: incomplete ownership attempt is not journal-owned`);
    check(attempt.uid === retained.metadata.uid, `${contract.migrationID}: retained Namespace UID changed before patch`);
    check(attempt.expectedRevision === expectedRevision, `${contract.migrationID}: prepared OCI revision drifted`);
    check(
      attempt.resourceVersionObserved === retained.metadata.resourceVersion,
      `${contract.migrationID}: protected Namespace resourceVersion changed before guarded patch`,
    );
    check(attempt.state === "prepared", `${contract.migrationID}: patch-returned state still has legacy ownership fields`);
  } else {
    attempt = {
      migrationID: contract.migrationID,
      cluster: contract.cluster,
      application: `${contract.cluster}/${contract.application}`,
      namespace: contract.retainedNamespace,
      replacementNamespace: contract.replacementNamespace,
      uid: retained.metadata.uid,
      replacementUID: replacement.metadata.uid,
      resourceVersionObserved: retained.metadata.resourceVersion,
      expectedRevision,
      state: "prepared",
      preparedAt: new Date().toISOString(),
      legacyTrackingID: contract.legacyTrackingID,
      legacyOrigin: classification.legacyOrigin,
    };
    writeProtectedNamespaceAttempt(attempt);
    state.protectedNamespaceAttempts.set(contract.migrationID, { ...attempt, source: "journal" });
  }

  const patched = kubectlTry(deployment.cluster, [
    "patch", "namespace", contract.retainedNamespace,
    "--type=json",
    "-p", JSON.stringify(protectedNamespaceDetachPatch(contract, classification)),
  ]);
  if (!patched.ok && retryableKubernetesCompareAndSet(patched.output)) {
    const current = readProtectedNamespace(deployment.cluster, contract.retainedNamespace);
    check(current, `${contract.migrationID}: protected Namespace disappeared during patch recovery`);
    const recovered = validateProtectedNamespaceDetached(contract, attempt.uid, current, replacement);
    const completed = completeProtectedNamespaceDetachment(
      state,
      attempt,
      current,
      replacement,
      "detached-by-reconciler",
    );
    recordAction(
      state,
      "protected-namespace-detach-recovery",
      `${contract.cluster}/Namespace/${contract.retainedNamespace}`,
      `${contract.migrationID}; uid=${completed.uid}; resourceVersion=${recovered.retainedResourceVersion}`,
    );
    return true;
  }
  check(patched.ok, `${contract.migrationID}: guarded protected Namespace ownership patch failed: ${patched.output}`);
  attempt = {
    ...attempt,
    state: "patch-returned",
    patchReturnedAt: new Date().toISOString(),
  };
  writeProtectedNamespaceAttempt(attempt);
  state.protectedNamespaceAttempts.set(contract.migrationID, { ...attempt, source: "journal" });
  const current = readProtectedNamespace(deployment.cluster, contract.retainedNamespace);
  check(current, `${contract.migrationID}: protected Namespace disappeared after patch`);
  validateProtectedNamespaceDetached(contract, attempt.uid, current, replacement);
  const completed = completeProtectedNamespaceDetachment(
    state,
    attempt,
    current,
    replacement,
    "detached-by-reconciler",
  );
  recordAction(
    state,
    "protected-namespace-ownership-detach",
    `${contract.cluster}/Namespace/${contract.retainedNamespace}`,
    `${contract.migrationID}; uid=${completed.uid}; four reviewed metadata fields removed; Namespace retained`,
  );
  return true;
}

function convergeDeploymentApplication(
  deployment,
  state,
  expectedRevision,
  expectedReleaseIdentity,
  sourcePayloadKeys = {},
) {
  check(deployment, "internal error: deployment definition missing during Argo convergence");
  check(/^sha256:[0-9a-f]{64}$/.test(expectedRevision), `${deployment.space}: invalid expected ConfigHub revision ${expectedRevision}`);
  let firstApp = waitForArgoApplicationContract(deployment);
  const convergenceJournal = beginConvergenceJournal(deployment, expectedRevision);
  const firstObservedAt = Date.parse(convergenceJournal.startedAt);
  const convergenceStartedAt = firstObservedAt;
  let activeWaitStartedAt = null;
  let healthWaitStartedAt = null;
  let syncRequests = convergenceJournal.syncReservations;
  let last = { sync: "Unknown", health: "Unknown", phase: "Unknown", revision: "Unknown", message: "not observed" };
  while (true) {
    let app = firstApp ?? readLiveArgoApplication(deployment);
    firstApp = null;
    assertArgoApplicationContract(app, deployment, {
      allowAutomated: deployment.deliveryRoot === true,
    });
    if (!deployment.deliveryRoot && detachDeclaredProtectedNamespaceOwnership(deployment, state, app, expectedRevision)) {
      command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "protected-namespace-settle" });
      app = readLiveArgoApplication(deployment);
      assertArgoApplicationContract(app, deployment);
    }
    if (!deployment.deliveryRoot && pruneDeclaredNamespaceMoveBlockers(deployment, state, app, expectedRevision)) {
      command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "namespace-move-uid-gone" });
      app = readLiveArgoApplication(deployment);
      assertArgoApplicationContract(app, deployment);
    }
    let immutableSelectorChanged = false;
    if (!deployment.deliveryRoot) {
      for (const migration of immutableSelectorMigrationsFor(deployment)) {
        immutableSelectorChanged = replaceDeclaredImmutableSelector(
          deployment,
          migration,
          state,
          app,
          expectedRevision,
          expectedReleaseIdentity,
          sourcePayloadKeys,
        ) || immutableSelectorChanged;
      }
    }
    if (immutableSelectorChanged) {
      command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "immutable-selector-settle" });
      app = readLiveArgoApplication(deployment);
      assertArgoApplicationContract(app, deployment);
    }
    const immutableFailures = immutableSelectorResourceFailures(app);
    const unaccountedImmutableFailures = immutableFailures.filter((failure) => {
      const migration = immutableSelectorMigrationsFor(deployment).find(
        (item) => item.kind === failure.kind
          && item.namespace === failure.namespace
          && item.name === failure.name,
      );
      return !migration || state.immutableSelectorAttempts.get(migration.migrationID)?.state !== "old-uid-gone";
    });
    check(
      unaccountedImmutableFailures.length === 0,
      `${deployment.cluster}/${deployment.space}: deterministic immutable-selector failure is not covered by an active exact replacement contract: ${stableJson(unaccountedImmutableFailures.map((item) => ({ group: item.group, kind: item.kind, namespace: item.namespace, name: item.name, message: item.message })))}`,
    );
    last = argoObservation(app);
    const disposition = argoConvergenceState(app, deployment, expectedRevision);
    if (disposition === "accepted") {
      // The one-time root migration may be read while its old self-managed
      // revision still has automation. Acceptance is only valid after the
      // exact new root digest has removed that authority from the live object.
      assertArgoApplicationContract(app, deployment);
      let immutableSelectorReplacementsReady = true;
      if (!deployment.deliveryRoot) {
        for (const migration of immutableSelectorMigrationsFor(deployment)) {
          immutableSelectorReplacementsReady = completeDeclaredImmutableSelectorReplacement(
            deployment,
            migration,
            state,
            app,
            expectedRevision,
          ) && immutableSelectorReplacementsReady;
        }
      }
      if (!immutableSelectorReplacementsReady) {
        const now = Date.now();
        const convergenceElapsed = now - convergenceStartedAt;
        check(
          withinDeadline(convergenceStartedAt, now, ARGO_CONVERGENCE_TIMEOUT_MS),
          `${deployment.cluster}/${deployment.space}: immutable-selector replacement readiness exceeded the overall ${ARGO_CONVERGENCE_TIMEOUT_MS / 60000}-minute convergence deadline; expected revision ${expectedRevision}, got ${stableJson({ ...last, elapsedSeconds: Math.floor(convergenceElapsed / 1000), syncRequests })}`,
        );
        healthWaitStartedAt = convergencePhaseStartedAt(
          app,
          expectedRevision,
          "finishedAt",
          firstObservedAt,
          healthWaitStartedAt,
          now,
        );
        const healthElapsed = now - healthWaitStartedAt;
        check(
          withinDeadline(healthWaitStartedAt, now, ARGO_HEALTH_TIMEOUT_MS),
          `${deployment.cluster}/${deployment.space}: replacement workloads or Service endpoints did not become ready within ${ARGO_HEALTH_TIMEOUT_MS / 60000} minutes; no resync was submitted`,
        );
        command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "argo-health-pending" });
        continue;
      }
      clearConvergenceJournal(convergenceJournal.key);
      if (!deployment.deliveryRoot && deployment.cluster === "hx-app-dev" && state.performancePhases.length === 0) {
        markFirstDevAccepted();
        const phase = performancePhaseEvidence(
          "apply-start-to-first-argo-convergence",
          state.performancePhaseStart,
        );
        state.performancePhases.push(phase);
        if (activeReconcilePerformance) activeReconcilePerformance.phases.push(phase);
      }
      return last;
    }

    const now = Date.now();
    const convergenceElapsed = now - convergenceStartedAt;
    check(
      withinDeadline(convergenceStartedAt, now, ARGO_CONVERGENCE_TIMEOUT_MS),
      `${deployment.cluster}/${deployment.space}: overall Argo convergence exceeded ${ARGO_CONVERGENCE_TIMEOUT_MS / 60000} minutes; expected revision ${expectedRevision}, got ${stableJson({ ...last, elapsedSeconds: Math.floor(convergenceElapsed / 1000), syncRequests })}`,
    );
    if (disposition === "active-operation") {
      healthWaitStartedAt = null;
      activeWaitStartedAt = convergencePhaseStartedAt(
        app,
        expectedRevision,
        "startedAt",
        firstObservedAt,
        activeWaitStartedAt,
        now,
      );
      const elapsed = now - activeWaitStartedAt;
      check(
        withinDeadline(activeWaitStartedAt, now, ARGO_OPERATION_TIMEOUT_MS),
        `${deployment.cluster}/${deployment.space}: active Argo operation exceeded ${ARGO_OPERATION_TIMEOUT_MS / 60000} minutes without takeover; expected revision ${expectedRevision}, got ${stableJson({ ...last, elapsedSeconds: Math.floor(elapsed / 1000), syncRequests })}`,
      );
      command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "argo-active-operation" });
      continue;
    }

    activeWaitStartedAt = null;
    if (disposition === "health-pending") {
      healthWaitStartedAt = convergencePhaseStartedAt(
        app,
        expectedRevision,
        "finishedAt",
        firstObservedAt,
        healthWaitStartedAt,
        now,
      );
      const elapsed = now - healthWaitStartedAt;
      check(
        withinDeadline(healthWaitStartedAt, now, ARGO_HEALTH_TIMEOUT_MS),
        `${deployment.cluster}/${deployment.space}: exact-revision health did not settle within ${ARGO_HEALTH_TIMEOUT_MS / 60000} minutes; no resync was submitted; expected health ${deployment.acceptedHealth.join("|")}, got ${stableJson({ ...last, elapsedSeconds: Math.floor(elapsed / 1000), syncRequests })}`,
      );
      command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "argo-health-pending" });
      continue;
    }

    healthWaitStartedAt = null;
    check(
      syncRequests < ARGO_MAX_SYNC_REQUESTS,
      `${deployment.cluster}/${deployment.space}: exhausted ${ARGO_MAX_SYNC_REQUESTS} actual Argo sync requests; expected revision ${expectedRevision}, Synced, and health ${deployment.acceptedHealth.join("|")}, got ${stableJson(last)}`,
    );
    syncRequests = reserveConvergenceSync(convergenceJournal.key);
    const submitted = requestArgoSyncIfNeeded(
      deployment,
      state,
      syncRequests,
      expectedRevision,
      expectedReleaseIdentity,
      sourcePayloadKeys,
    );
    if (!submitted) {
      // The request helper returns false only after proving that no operation
      // was submitted (state changed before CAS, or Kubernetes rejected a
      // tested UID/resourceVersion). Unknown transport outcomes throw and keep
      // the durable reservation fail-closed across restart.
      syncRequests = releaseUnusedConvergenceSyncReservation(
        convergenceJournal.key,
        syncRequests,
      );
    }
    command("sleep", [String(ARGO_OBSERVE_SECONDS)], { waitReason: "argo-retry-backoff" });
  }
}

function requestArgoSyncIfNeeded(
  deployment,
  state,
  syncAttempt,
  expectedRevision,
  expectedReleaseIdentity,
  sourcePayloadKeys,
) {
  let app = waitForArgoApplicationContract(deployment);
  if (argoConvergenceState(app, deployment, expectedRevision) !== "retryable") return false;

  kubectl(deployment.cluster, [
    "annotate", "application", deployment.space, "-n", "argocd",
    "argocd.argoproj.io/refresh=hard", "--overwrite",
  ]);
  recordAction(state, "argo-hard-refresh", `${deployment.cluster}/${deployment.space}`, `sync attempt ${syncAttempt}`);
  let refreshProcessed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    app = readLiveArgoApplication(deployment);
    if (!app.metadata?.annotations?.["argocd.argoproj.io/refresh"]) {
      refreshProcessed = true;
      break;
    }
    command("sleep", ["2"], { waitReason: "argo-refresh-ack" });
  }
  check(refreshProcessed, `${deployment.cluster}/${deployment.space}: Argo hard refresh was not processed`);
  assertArgoApplicationContract(app, deployment, {
    allowAutomated: deployment.deliveryRoot === true,
  });
  if (argoConvergenceState(app, deployment, expectedRevision) !== "retryable") return false;

  assertReleaseStreamStillCurrent(
    deployment.space,
    expectedReleaseIdentity,
    expectedRevision,
    sourcePayloadKeys,
  );

  const operation = {
    initiatedBy: { username: "helm-expt-kubara-mini-idp" },
    sync: {
      revision: expectedRevision,
      prune: deployment.deliveryRoot ? false : true,
      syncOptions: applicationSyncOptions(deployment),
    },
    retry: applicationRetryPolicy(),
  };
  check(app.metadata?.uid && app.metadata?.resourceVersion, `${deployment.cluster}/${deployment.space}: Application UID/resourceVersion missing before sync compare-and-set`);
  const submitted = kubectlTry(deployment.cluster, [
    "patch", "application", deployment.space, "-n", "argocd",
    "--type=json", "--patch", JSON.stringify([
      { op: "test", path: "/metadata/uid", value: app.metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: app.metadata.resourceVersion },
      { op: "add", path: "/operation", value: operation },
    ]),
  ]);
  if (!submitted.ok && retryableKubernetesCompareAndSet(submitted.output)) return false;
  check(submitted.ok, `${deployment.cluster}/${deployment.space}: failed to submit compare-and-set Argo sync operation`);
  recordArgoSyncRequest();
  recordAction(state, "argo-sync-request", `${deployment.cluster}/${deployment.space}`, `sync attempt ${syncAttempt}; Kubara prune semantics`);
  return true;
}

function assertReleaseStreamStillCurrent(
  space,
  expectedIdentity,
  expectedRevision,
  sourcePayloadKeys = {},
) {
  check(expectedIdentity, `${space}: expected release identity is missing before Argo compare-and-set`);
  check(!activeSourceReleaseBoundarySnapshot, `${space}: pre-Argo dependency snapshot overlaps another release boundary`);
  if (activeAuthoritativeReleaseReuseBatch) {
    // A release selected from the frozen no-write batch needs its complete,
    // source-specific dependency closure refreshed before a side effect. This
    // path stays out of accepted no-op runs because an already-converged Argo
    // Application never requests a sync.
    const boundary = assertReleaseBoundary(space, {
      sourcePayloadKeys,
      approvalMode: "clear",
    });
    const latest = validatedPublishedRelease(
      space,
      boundary.latestPublishedRelease,
      "dependency-refreshed pre-Argo published release",
    );
    check(
      stableJson(releaseIdentity(boundary)) === stableJson(expectedIdentity)
        && latest.ManifestDigest === expectedRevision,
      `${space}: dependency-refreshed release changed before Argo compare-and-set`,
    );
    return;
  }

  // A newly published stream already passed a complete opening and closing
  // dependency boundary. Immediately before the Kubernetes CAS, refresh only
  // the two authority-bearing rows: exact Unit heads and Published Release.
  const units = fetchUnitRows(space).sort((left, right) => left.Slug.localeCompare(right.Slug));
  check(units.length > 0, `${space}: authoritative pre-Argo Unit stream is empty`);
  for (const unit of units) {
    decodeBulkUnitData(unit, `${space}/${unit.Slug}`);
    check(
      Number(unit.HeadRevisionNum) === Number(unit.LastAppliedRevisionNum),
      `${space}/${unit.Slug}: Unit head changed after release selection and before Argo compare-and-set`,
    );
  }
  const latest = validatedPublishedRelease(
    space,
    fetchPublishedReleases(space)[0],
    "authoritative pre-Argo published release",
  );
  assertPublishedReleaseUnitCount(space, latest, units.length, "authoritative pre-Argo published release");
  const currentIdentity = releaseIdentity({ latestPublishedRelease: latest });
  check(
    stableJson(currentIdentity) === stableJson(expectedIdentity)
      && latest.ManifestDigest === expectedRevision,
    `${space}: latest published release changed after selection and before Argo compare-and-set`,
  );
}

function spaceHasUnreleasedHeads(space) {
  const units = readUnitRows(space);
  check(units.length > 0, `${space}: cannot determine release currency without Units`);
  return units.some(
    (unit) => Number(unit.HeadRevisionNum ?? 0) !== Number(unit.LastAppliedRevisionNum ?? 0),
  );
}

function hasRelease(space) {
  return Boolean(latestRelease(space));
}

function publishRelease(space, state, { sourcePayloadKeys = {} } = {}) {
  const cachedSnapshot = activeAuthoritativeReleaseReuseBatch
    ? withAuthoritativeReleaseReuseBatch(
        space,
        () => assertReleaseBoundaryFromCurrentReadView(space, {
          sourcePayloadKeys,
          approvalMode: "clear",
        }),
      )
    : assertReleaseBoundaryFromCurrentReadView(space, {
        sourcePayloadKeys,
        approvalMode: "clear",
      });
  if (releasePublicationDecision({
    hasUnreleasedHeads: releaseBoundaryHasUnreleasedHeads(space, cachedSnapshot),
    hasPublishedRelease: Boolean(cachedSnapshot.latestPublishedRelease),
    publishedUnitCountMatches: releaseBoundaryPublishedUnitCountMatches(cachedSnapshot),
  }) === "reuse") {
    if (!activeAuthoritativeReleaseReuseBatch) {
      const authoritative = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "clear" });
      check(
        !releaseBoundaryHasUnreleasedHeads(space, authoritative)
          && authoritative.latestPublishedRelease,
        `${space}: cached release reuse was not confirmed by the authoritative boundary`,
      );
      assertReleaseBoundaryTransition(space, cachedSnapshot, authoritative, { publicationAttempted: false });
      state.changedSpaces.delete(space);
      return validatedPublishedRelease(
        space,
        authoritative.latestPublishedRelease,
        "authoritatively revalidated published release",
      );
    }
    state.changedSpaces.delete(space);
    return validatedPublishedRelease(
      space,
      cachedSnapshot.latestPublishedRelease,
      "dependency-closed batch-pinned existing published release",
    );
  }

  // A cached decision may only lead to a write after a direct authoritative
  // boundary revalidates the exact Units, topology, and latest release.
  const boundarySnapshot = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "clear" });
  if (releasePublicationDecision({
    hasUnreleasedHeads: releaseBoundaryHasUnreleasedHeads(space, boundarySnapshot),
    hasPublishedRelease: Boolean(boundarySnapshot.latestPublishedRelease),
    publishedUnitCountMatches: releaseBoundaryPublishedUnitCountMatches(boundarySnapshot),
  }) === "reuse") {
    state.changedSpaces.delete(space);
    return validatedPublishedRelease(space, boundarySnapshot.latestPublishedRelease, "authoritatively revalidated published release");
  }
  const result = cubTry(
    ["release", "publish", space, "-o", "json"],
    { timeout: 1_200_000 },
  );
  if (!result.ok) {
    check(
      isUnchangedReleaseResponse(result),
      `cub release publish ${space} failed: ${result.output}`,
    );
    classifyLatestMutationFailureAsExpected("cub.release.publish");
    const closing = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "clear" });
    const reused = closing.latestPublishedRelease;
    check(reused, `${space}: ConfigHub reported an unchanged bundle but no published release exists`);
    state.changedSpaces.delete(space);
    assertReleaseBoundaryTransition(
      space,
      boundarySnapshot,
      closing,
      { publicationAttempted: true },
    );
    return validatedPublishedRelease(space, reused, "unchanged published release");
  }
  const value = JSON.parse(result.output);
  const commandRelease = unwrapEntity(value, "Release");
  const closing = assertReleaseBoundary(space, { sourcePayloadKeys, approvalMode: "clear" });
  const authoritativeRelease = closing.latestPublishedRelease;
  check(authoritativeRelease, `${space}: successful publish has no authoritative closing release`);
  const releaseIdentityFields = ["ReleaseID", "TagID", "ReleaseNum", "UnitCount", "Digest", "ManifestDigest"];
  for (const field of releaseIdentityFields) {
    check(
      commandRelease?.[field] !== undefined
        && stableJson(commandRelease[field]) === stableJson(authoritativeRelease[field]),
      `${space}: publish response ${field} does not match the authoritative closing release`,
    );
  }
  const bundleDigest = authoritativeRelease.Digest ?? "";
  const manifestDigest = authoritativeRelease.ManifestDigest ?? "";
  check(/^sha256:[0-9a-f]{64}$/.test(bundleDigest), `${space}: published bundle content digest is missing or invalid`);
  check(/^sha256:[0-9a-f]{64}$/.test(manifestDigest), `${space}: published OCI manifest digest is missing or invalid`);
  recordAction(state, "release-publish", space, `manifest=${manifestDigest}; bundle=${bundleDigest}`);
  state.published.set(space, { manifestDigest, bundleDigest });
  state.changedSpaces.delete(space);
  assertReleaseBoundaryTransition(
    space,
    boundarySnapshot,
    closing,
    { publicationAttempted: true, requireNewRelease: true },
  );
  return {
    ...authoritativeRelease,
  };
}

function assertReleaseBoundary(space, { sourcePayloadKeys = {}, approvalMode = "clear" } = {}) {
  const expectedManagedUnits = plan.managedUnits.filter((item) => item.space === space);
  if (expectedManagedUnits.length > 0) {
    return withSourceReleaseBoundarySnapshot(
      space,
      expectedManagedUnits,
      () => assertReleaseBoundaryFromCurrentReadView(space, { sourcePayloadKeys, approvalMode }),
    );
  }
  const fleetItem = FLEET.find((item) => `${item.cluster}-argo-apps` === space);
  check(fleetItem, `${space}: release publication is outside the managed mini-IDP Space inventory`);
  return withDeliveryRootReleaseBoundarySnapshot(
    fleetItem,
    () => assertReleaseBoundaryFromCurrentReadView(space, { sourcePayloadKeys, approvalMode }),
  );
}

function assertReleaseBoundaryFromCurrentReadView(
  space,
  { sourcePayloadKeys = {}, approvalMode = "clear" } = {},
) {
  const expectedManagedUnits = plan.managedUnits.filter((item) => item.space === space);
  if (expectedManagedUnits.length > 0) {
    assertUnitAllowlist(space, expectedManagedUnits.map((item) => item.slug));
    const unexpectedOverrides = Object.keys(sourcePayloadKeys)
      .filter((slug) => !expectedManagedUnits.some((item) => item.slug === slug));
    check(
      unexpectedOverrides.length === 0,
      `${space}: release payload override names unknown Units: ${unexpectedOverrides.join(", ")}`,
    );
    for (const expected of expectedManagedUnits) {
      assertManagedSourceUnitContract(
        expected,
        sourcePayloadKeys[expected.slug] ?? expected.payloadKey,
      );
    }
    const liveUnits = readUnitRows(space);
    const gated = liveUnits.filter(hasApprovalGate);
    if (approvalMode === "required") {
      check(gated.length > 0, `${space}: expected an exact approval gate before the refused publication`);
    } else {
      check(gated.length === 0, `${space}: successful publication still has ${gated.length} approval-gated head(s)`);
    }
    assertManagedSourceSpaceContract(space, expectedManagedUnits);
    return releaseBoundarySnapshot(space);
  }
  const fleetItem = FLEET.find((item) => `${item.cluster}-argo-apps` === space);
  check(fleetItem, `${space}: release publication is outside the managed mini-IDP Space inventory`);
  {
    assertUnitAllowlist(space, expectedArgoApplicationSlugs(plan, fleetItem));
    assertDeliveryTopology(readSpaces(), plan, {
      fleet: [fleetItem],
      requireAllApplications: true,
      requireApplicationMetadata: true,
    });
    for (const deployment of plan.deployments.filter((item) => item.cluster === fleetItem.cluster)) {
      const docs = parseDocs(readUnitData(deployment.appSpace, deployment.appUnit));
      check(docs.length === 1 && docs[0].kind === "Application", `${deployment.appSpace}/${deployment.appUnit}: expected one release-boundary Application`);
      const app = docs[0];
      assertNoStoredApplicationOperation(app, `${deployment.appSpace}/${deployment.appUnit}: release-boundary Application`);
      assertArgoApplicationContract(app, deployment);
      check(
        stableJson(app.spec?.syncPolicy) === stableJson(applicationSyncPolicy(deployment)),
        `${deployment.appSpace}/${deployment.appUnit}: sync policy drifted before fleet-root publication`,
      );
      const expectedIgnoreDifferences = deployment.ignoreInjectedCertificateData
        ? certificateIgnoreDifferences()
        : undefined;
      check(
        stableJson(app.spec?.ignoreDifferences) === stableJson(expectedIgnoreDifferences),
        `${deployment.appSpace}/${deployment.appUnit}: ignoreDifferences drifted before fleet-root publication`,
      );
    }
    return releaseBoundarySnapshot(space);
  }
}

function assertManagedSourceSpaceContract(space, expectedUnits) {
  const expectedSpace = plan.spaces.find((item) => item.slug === space);
  check(expectedSpace, `${space}: managed source Space is absent from the plan`);
  const liveSpace = readSpaces().get(space);
  check(liveSpace, `${space}: managed source Space is missing`);
  if (expectedSpace.target) {
    const target = readTarget(expectedSpace.target.split("/")[0]);
    check(target?.TargetID, `${space}: expected release target ${expectedSpace.target} is missing`);
    check(liveSpace.ReleaseTargetID === target.TargetID, `${space}: Space release target drifted`);
  } else {
    check(!liveSpace.ReleaseTargetID, `${space}: untargeted definition Space gained a release target`);
  }

  const expectedUpgrade = new Map(expectedUnits
    .filter((unit) => unit.upstream)
    .map((unit) => [`upgrade-${unit.slug}`, unit]));
  const allowedNeedsProvides = new Set(plan.links.filter((link) => link.space === space).map((link) => link.slug));
  const liveLinks = readLinks(space);
  const unexpected = liveLinks.filter(
    (link) => !expectedUpgrade.has(link.Slug) && !allowedNeedsProvides.has(link.Slug),
  );
  check(unexpected.length === 0, `${space}: unexpected Link(s) at release boundary: ${unexpected.map((item) => item.Slug).join(", ")}`);
  for (const [slug, unit] of expectedUpgrade) {
    const link = liveLinks.find((item) => item.Slug === slug);
    check(link, `${space}/${slug}: required UpgradeUnit Link is missing at release boundary`);
    const downstream = readUnit(space, unit.slug);
    const [upstreamSpace, upstreamSlug] = unit.upstream.split("/");
    const upstream = readUnit(upstreamSpace, upstreamSlug);
    check(link.UpdateType === "UpgradeUnit" && link.AutoUpdate !== true, `${space}/${slug}: UpgradeUnit policy drifted`);
    check(link.FromUnitID === downstream?.UnitID && link.ToUnitID === upstream?.UnitID, `${space}/${slug}: UpgradeUnit endpoints drifted`);
  }
}

function assertManagedSourceUnitContract(expected, payloadKey) {
  const ref = `${expected.space}/${expected.slug}`;
  const payload = inputs.payloads.get(payloadKey);
  check(payload, `${ref}: reviewed release-boundary payload ${payloadKey} is missing`);
  const live = readUnit(expected.space, expected.slug);
  check(live, `${ref}: managed source Unit is missing at the release boundary`);
  check(live.ToolchainType === expected.toolchain, `${ref}: toolchain drifted at the release boundary`);
  check(
    (live.ProviderType ?? null) === (expected.provider ?? null),
    `${ref}: provider drifted at the release boundary`,
  );
  check(
    sameUnitData(
      expected.toolchain,
      readUnitData(expected.space, expected.slug),
      payload.value,
    ),
    `${ref}: data is not the exact reviewed release-boundary payload ${payloadKey}`,
  );
  if (expected.target) {
    const target = readTarget(expected.target.split("/")[0]);
    check(target?.TargetID, `${ref}: expected target ${expected.target} is missing`);
    check(live.TargetID === target.TargetID, `${ref}: target drifted at the release boundary`);
  } else {
    check(!live.TargetID, `${ref}: untargeted source Unit gained a target at the release boundary`);
  }
  if (expected.upstream) {
    const [upstreamSpace, upstreamSlug] = expected.upstream.split("/");
    const upstream = readUnit(upstreamSpace, upstreamSlug);
    check(upstream?.UnitID, `${ref}: expected upstream ${expected.upstream} is missing`);
    check(live.UpstreamUnitID === upstream.UnitID, `${ref}: upstream drifted at the release boundary`);
  } else {
    check(!live.UpstreamUnitID, `${ref}: definition Unit gained an upstream at the release boundary`);
  }
  check(
    mapMatches(live.Labels, expected.labels)
      && staleOwnedUnitLabels(live.Labels, expected.labels).length === 0,
    `${ref}: owned identity labels drifted at the release boundary`,
  );
  const expectedAnnotations = {
    ...sourceAnnotation(payload.value, payload.sourcePaths, payload.transform),
    ...(expected.annotations ?? {}),
  };
  check(
    mapMatches(live.Annotations, expectedAnnotations)
      && staleOwnedPublicAnnotations(live.Annotations, expectedAnnotations).length === 0,
    `${ref}: owned provenance annotations drifted at the release boundary`,
  );
  if (expected.prodProtected) {
    check(
      gateEnabled(live.DeleteGates, PROD_SAFETY_GATE)
        && gateEnabled(live.DestroyGates, PROD_SAFETY_GATE),
      `${ref}: production delete/destroy protection drifted at the release boundary`,
    );
  } else {
    check(
      !gateEnabled(live.DeleteGates, PROD_SAFETY_GATE)
        && !gateEnabled(live.DestroyGates, PROD_SAFETY_GATE),
      `${ref}: non-production Unit gained the owned production safety gate`,
    );
  }
}

function releaseBoundarySnapshot(space) {
  const units = readUnitRows(space).map((unit) => ({
      slug: unit.Slug,
      id: unit.UnitID,
      headRevisionNum: unit.HeadRevisionNum,
      lastAppliedRevisionNum: unit.LastAppliedRevisionNum,
      dataHash: unit.DataHash,
      targetID: unit.TargetID ?? null,
      upstreamUnitID: unit.UpstreamUnitID ?? null,
      toolchain: unit.ToolchainType,
      provider: unit.ProviderType ?? null,
      ownedLabels: Object.fromEntries([...OWNED_UNIT_LABELS]
        .filter((key) => unit.Labels?.[key] !== undefined)
        .sort()
        .map((key) => [key, unit.Labels[key]])),
    })).sort((left, right) => left.slug.localeCompare(right.slug));
  const latestPublishedRelease = latestRelease(space);
  if (latestPublishedRelease) {
    validatedReleaseEnvelope(
      space,
      latestPublishedRelease,
      "release-boundary published release",
      { allowEmpty: true },
    );
  }
  return { units, latestPublishedRelease };
}

function releaseBoundaryHasUnreleasedHeads(space, snapshot) {
  check(snapshot?.units?.length > 0, `${space}: cannot determine release currency without Units`);
  return snapshot.units.some(
    (unit) => Number(unit.headRevisionNum ?? 0) !== Number(unit.lastAppliedRevisionNum ?? 0),
  );
}

function releaseBoundaryPublishedUnitCountMatches(snapshot) {
  return Boolean(
    snapshot?.latestPublishedRelease
      && Number(snapshot.latestPublishedRelease.UnitCount) === snapshot?.units?.length,
  );
}

function releaseBoundaryStableShape(snapshot) {
  return snapshot.units.map(({ lastAppliedRevisionNum: _lastAppliedRevisionNum, ...unit }) => unit);
}

function releaseIdentity(snapshot) {
  const release = snapshot?.latestPublishedRelease;
  return release ? {
    id: release.ReleaseID ?? null,
    tagID: release.TagID ?? null,
    releaseNum: release.ReleaseNum ?? null,
    unitCount: release.UnitCount ?? null,
    digest: release.Digest ?? null,
    manifestDigest: release.ManifestDigest ?? null,
  } : null;
}

function assertReleaseBoundaryTransition(
  space,
  opening,
  closing,
  { publicationAttempted, requireNewRelease = false },
) {
  check(
    stableJson(releaseBoundaryStableShape(closing)) === stableJson(releaseBoundaryStableShape(opening)),
    `${space}: release boundary changed ${publicationAttempted ? "while publishing" : "while reusing the published release"}`,
  );
  if (publicationAttempted) {
    check(
      !releaseBoundaryHasUnreleasedHeads(space, closing),
      `${space}: release publication did not advance every Unit to its current head`,
    );
    check(
      releaseBoundaryPublishedUnitCountMatches(closing),
      `${space}: release publication did not capture the exact ${closing.units.length}-Unit boundary`,
    );
    if (requireNewRelease) {
      const openingIdentity = releaseIdentity(opening);
      const closingRelease = validatedPublishedRelease(
        space,
        closing.latestPublishedRelease,
        "successful publication's authoritative closing release",
      );
      const closingIdentity = releaseIdentity(closing);
      check(
        !openingIdentity
          || (
            closingIdentity.id !== openingIdentity.id
            && Number(closingIdentity.releaseNum) > Number(openingIdentity.releaseNum)
          ),
        `${space}: successful publication did not create a new authoritative Release identity and advance ReleaseNum`,
      );
      check(
        stableJson(closingIdentity) !== stableJson(openingIdentity),
        `${space}: successful publication reused the prior authoritative release identity`,
      );
      validatedPublishedRelease(space, closingRelease, "new authoritative published release");
    }
  } else {
    check(
      stableJson(closing.units) === stableJson(opening.units)
        && stableJson(releaseIdentity(closing)) === stableJson(releaseIdentity(opening))
        && releaseBoundaryPublishedUnitCountMatches(closing),
      `${space}: release currency changed while reusing the published release`,
    );
  }
}

function validatedPublishedRelease(space, release, description) {
  return validatedReleaseEnvelope(space, release, description);
}

function validatedReleaseEnvelope(space, release, description, { allowEmpty = false } = {}) {
  check(release, `${space}: ${description} is missing`);
  check(UUID_PATTERN.test(release.ReleaseID ?? ""), `${space}: ${description} ReleaseID is invalid`);
  check(UUID_PATTERN.test(release.TagID ?? ""), `${space}: ${description} TagID is invalid`);
  check(Number.isInteger(Number(release.ReleaseNum)) && Number(release.ReleaseNum) > 0, `${space}: ${description} ReleaseNum is invalid`);
  check(
    Number.isInteger(Number(release.UnitCount))
      && Number(release.UnitCount) >= (allowEmpty ? 0 : 1),
    `${space}: ${description} UnitCount is invalid`,
  );
  check(/^sha256:[0-9a-f]{64}$/.test(release.Digest ?? ""), `${space}: ${description} bundle digest is invalid`);
  releaseManifestDigest(release);
  return release;
}

function assertPublishedReleaseUnitCount(space, release, expectedUnitCount, description) {
  check(
    Number(release?.UnitCount) === expectedUnitCount,
    `${space}: ${description} UnitCount ${release?.UnitCount ?? "missing"} does not match the exact ${expectedUnitCount}-Unit release boundary`,
  );
}

function releasePublicationDecision({
  hasUnreleasedHeads,
  hasPublishedRelease,
  publishedUnitCountMatches = false,
}) {
  return !hasUnreleasedHeads && hasPublishedRelease && publishedUnitCountMatches
    ? "reuse"
    : "publish";
}

function isUnchangedReleaseResponse(result) {
  return result?.ok === false && String(result.output ?? "").includes(UNCHANGED_RELEASE_ERROR);
}

function selfTestReleaseRecovery() {
  check(
    releasePublicationDecision({ hasUnreleasedHeads: false, hasPublishedRelease: true, publishedUnitCountMatches: true }) === "reuse",
    "metadata-only changes must reuse the current published release",
  );
  for (const scenario of [
    { hasUnreleasedHeads: true, hasPublishedRelease: true },
    { hasUnreleasedHeads: false, hasPublishedRelease: false },
  ]) {
    check(releasePublicationDecision(scenario) === "publish", `release decision should publish: ${stableJson(scenario)}`);
  }
  check(
    releasePublicationDecision({
      hasUnreleasedHeads: false,
      hasPublishedRelease: true,
      publishedUnitCountMatches: false,
    }) === "publish",
    "an incomplete latest release must be repaired even when every surviving Unit head appears current",
  );
  check(
    !releaseBoundaryPublishedUnitCountMatches({
      units: [{ slug: "fixture" }],
      latestPublishedRelease: { UnitCount: 0 },
    }),
    "an empty latest release must remain repairable but may never satisfy exact reuse",
  );
  check(
    isUnchangedReleaseResponse({ ok: false, output: `HTTP 400: ${UNCHANGED_RELEASE_ERROR}` }),
    "the exact ConfigHub unchanged-bundle response must be recoverable",
  );
  check(
    !isUnchangedReleaseResponse({ ok: false, output: "HTTP 500: registry unavailable" })
      && !isUnchangedReleaseResponse({ ok: true, output: UNCHANGED_RELEASE_ERROR }),
    "unrelated failures or successful output must not be classified as unchanged-bundle recovery",
  );
  const openingUnits = [{
    slug: "fixture",
    id: "11111111-1111-4111-8111-111111111111",
    headRevisionNum: 2,
    lastAppliedRevisionNum: 1,
    dataHash: "a".repeat(64),
  }];
  const publishedUnits = [{ ...openingUnits[0], lastAppliedRevisionNum: 2 }];
  const release = { ReleaseID: "22222222-2222-4222-8222-222222222222", TagID: "44444444-4444-4444-8444-444444444444", ReleaseNum: 1, UnitCount: 1, Digest: `sha256:${"b".repeat(64)}`, ManifestDigest: `sha256:${"c".repeat(64)}` };
  const opening = { units: openingUnits, latestPublishedRelease: release };
  const nextRelease = {
    ReleaseID: "33333333-3333-4333-8333-333333333333",
    TagID: "55555555-5555-4555-8555-555555555555",
    ReleaseNum: 2,
    UnitCount: 1,
    Digest: `sha256:${"d".repeat(64)}`,
    ManifestDigest: `sha256:${"e".repeat(64)}`,
  };
  const published = { units: publishedUnits, latestPublishedRelease: nextRelease };
  check(releaseBoundaryHasUnreleasedHeads("fixture", opening), "fixture opening release must have an unreleased head");
  check(!releaseBoundaryHasUnreleasedHeads("fixture", published), "fixture published release must be current");
  assertReleaseBoundaryTransition("fixture", opening, published, {
    publicationAttempted: true,
    requireNewRelease: true,
  });
  assertReleaseBoundaryTransition("fixture", published, published, { publicationAttempted: false });
  let staleSuccessFailure = null;
  try {
    assertReleaseBoundaryTransition(
      "fixture",
      opening,
      { units: publishedUnits, latestPublishedRelease: release },
      { publicationAttempted: true, requireNewRelease: true },
    );
  } catch (error) {
    staleSuccessFailure = error;
  }
  check(
    staleSuccessFailure?.message.includes("did not create a new authoritative Release identity"),
    "successful publication must reject a rediscovered prior release",
  );
  let incompleteReleaseFailure = null;
  try {
    assertPublishedReleaseUnitCount("fixture", { ...nextRelease, UnitCount: 0 }, 1, "self-test release");
  } catch (error) {
    incompleteReleaseFailure = error;
  }
  check(
    incompleteReleaseFailure?.message.includes("does not match the exact 1-Unit release boundary"),
    "release reuse must reject an incomplete UnitCount even when every surviving Unit head appears current",
  );
  let driftFailure = null;
  try {
    assertReleaseBoundaryTransition(
      "fixture",
      opening,
      { ...published, units: [{ ...published.units[0], dataHash: "b".repeat(64) }] },
      { publicationAttempted: true },
    );
  } catch (error) {
    driftFailure = error;
  }
  check(driftFailure?.message.includes("release boundary changed"), "release-boundary content drift must fail closed");
  console.log("Kubara mini-IDP release recovery self-test passed");
}

function selfTestScenarioOperationEvidence() {
  const refA = "hx-web-prod-a/hx-web-deployment";
  const refB = "hx-web-prod-b/hx-web-deployment";
  const idA = "11111111-1111-4111-8111-111111111111";
  const idB = "22222222-2222-4222-8222-222222222222";
  const hashInitial = "a".repeat(64);
  const hashPromoted = "b".repeat(64);
  const unit = (ref, id, headRevisionNum, dataHash, approvalCount = 0) => ({
    ref,
    id,
    headRevisionNum,
    lastAppliedRevisionNum: headRevisionNum,
    dataHash,
    approvalCount,
    applyGates: {},
  });
  const facts = (units) => ({
    sourceFingerprint: `sha256:${"c".repeat(64)}`,
    units,
    releases: [],
    upgradeLinks: [],
    spaceMarkers: [],
  });
  const scenario = {
    checkpoints: [
      { id: "initial-rollout", facts: facts([unit(refA, idA, 10, hashInitial, 1)]) },
      {
        id: "prod-approval",
        facts: facts([
          unit(refA, idA, 20, hashPromoted, 1),
          unit(refB, idB, 30, hashPromoted, 1),
        ]),
      },
      {
        id: "prod-a-rollback",
        facts: facts([
          unit(refA, idA, 22, hashInitial, 1),
          unit(refB, idB, 30, hashPromoted, 1),
        ]),
      },
    ],
    operationEvidence: [
      {
        type: "approval-gate-observed",
        ref: "hx-web-prod-a",
        transitionID: "base-promotion/hx-web-prod-a-approval-gate-observation",
        observationMode: "read-only-authoritative-gate",
        gatedHeads: [{ ref: refA, id: idA, headRevisionNum: 20, dataHash: hashPromoted }],
      },
      {
        type: "approval-gate-observed",
        ref: "hx-web-prod-b",
        transitionID: "base-promotion/hx-web-prod-b-approval-gate-observation",
        observationMode: "read-only-authoritative-gate",
        gatedHeads: [{ ref: refB, id: idB, headRevisionNum: 30, dataHash: hashPromoted }],
      },
      {
        type: "unit-approve",
        ref: "hx-web-prod-a",
        transitionID: "prod-approval/hx-web-prod-a-approve-v1",
        approvedHeads: [{
          ref: refA,
          id: idA,
          headRevisionNum: 20,
          dataHash: hashPromoted,
          approvalCountBefore: 0,
          approvalCountAfter: 1,
        }],
      },
      {
        type: "unit-approve",
        ref: "hx-web-prod-b",
        transitionID: "prod-approval/hx-web-prod-b-approve-v1",
        approvedHeads: [{
          ref: refB,
          id: idB,
          headRevisionNum: 30,
          dataHash: hashPromoted,
          approvalCountBefore: 0,
          approvalCountAfter: 1,
        }],
      },
      {
        type: "rollback",
        ref: refA,
        transitionID: "prod-a-rollback/prod-a-restore-previous",
        unitID: idA,
        restoredRevisionNum: 10,
        restoredDataHash: hashInitial,
        sourceHeadRevisionNum: 20,
        sourceDataHash: hashPromoted,
        resultHeadRevisionNum: 21,
        resultDataHash: hashInitial,
      },
    ],
  };
  check(scenarioOperationProofValid(scenario), "valid exact approval and rollback evidence was rejected");
  const approvalTriggerDelta = JSON.parse(JSON.stringify(scenario));
  approvalTriggerDelta.checkpoints
    .find((item) => item.id === "prod-a-rollback")
    .facts.units.find((item) => item.ref === refA).headRevisionNum = 23;
  approvalTriggerDelta.operationEvidence.push({
    type: "unit-approve",
    ref: "hx-web-prod-a",
    transitionID: "prod-a-rollback/prod-a-approve-rollback",
    approvedHeads: [{
      ref: refA,
      id: idA,
      headRevisionNum: 23,
      dataHash: hashInitial,
      approvalCountBefore: 0,
      approvalCountAfter: 1,
    }],
  });
  check(scenarioOperationProofValid(approvalTriggerDelta), "exact approval-bound two-revision rollback delta was rejected");
  approvalTriggerDelta.operationEvidence.pop();
  check(!scenarioOperationProofValid(approvalTriggerDelta), "unbound two-revision rollback delta was accepted");
  const drifted = JSON.parse(JSON.stringify(scenario));
  drifted.operationEvidence.find((item) => item.type === "rollback").restoredRevisionNum = 9;
  check(!scenarioOperationProofValid(drifted), "rollback evidence not bound to the initial-rollout revision was accepted");
  const mismatchedApproval = JSON.parse(JSON.stringify(scenario));
  mismatchedApproval.operationEvidence.find(
    (item) => item.transitionID === "prod-approval/hx-web-prod-a-approve-v1",
  ).approvedHeads[0].headRevisionNum = 19;
  check(!scenarioOperationProofValid(mismatchedApproval), "approval evidence not bound to the gated head was accepted");
  console.log("Kubara mini-IDP scenario evidence self-test passed");
}

function selfTestReceiptLinkEvidence(desired) {
  const rows = desired.links.map((expected, index) => ({
    ref: `${expected.space}/${expected.slug}`,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    from: `${expected.space}/${expected.fromUnit}`,
    to: `${expected.toSpace}/${expected.toUnit}`,
    updateType: expected.updateType,
    autoUpdate: expected.autoUpdate,
    reason: expected.reason,
    labels: expected.labels,
  }));
  assertReceiptLinkEvidence(rows, desired.links);

  const expectRefusal = (mutate, pattern, description) => {
    const candidate = JSON.parse(JSON.stringify(rows));
    mutate(candidate);
    let error = null;
    try {
      assertReceiptLinkEvidence(candidate, desired.links);
    } catch (caught) {
      error = caught;
    }
    check(error && pattern.test(error.message), `${description}: expected ${pattern}, got ${error?.message ?? "success"}`);
  };
  const workloadRef = "hx-web-dev/needs-platform-binding";
  const platformCertRef = "hx-web-platform-dev/needs-cert-manager";
  const platformIngressRef = "hx-web-platform-dev/needs-traefik";
  expectRefusal(
    (candidate) => { candidate.find((row) => row.ref === workloadRef).from = "hx-web-dev/wrong-workload"; },
    /downstream endpoint drifted/,
    "receipt workload-to-platform downstream endpoint mutation",
  );
  expectRefusal(
    (candidate) => { candidate.find((row) => row.ref === platformCertRef).to = "hx-traefik-dev/hx-traefik"; },
    /upstream endpoint drifted/,
    "receipt platform-to-cert-manager endpoint mutation",
  );
  expectRefusal(
    (candidate) => { candidate.find((row) => row.ref === platformIngressRef).reason = "generic dependency"; },
    /reason drifted/,
    "receipt platform-to-traefik reason mutation",
  );
  expectRefusal(
    (candidate) => { candidate[1] = { ...candidate[0], id: candidate[1].id }; },
    /duplicate Link/,
    "receipt duplicate Link mutation",
  );
  console.log("Kubara mini-IDP receipt Link evidence self-test passed");
}

function selfTestArgoConvergence() {
  const expectAuthorityFailure = (run, expectedMessage, label) => {
    let failure = null;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    check(failure?.message.includes(expectedMessage), `${label}: expected ${expectedMessage}, got ${failure?.message ?? "success"}`);
  };
  assertBootstrapAutomatedPolicy(undefined, "root", false, "self-test/root");
  assertBootstrapAutomatedPolicy({ selfHeal: true }, "root", true, "self-test/root");
  assertBootstrapAutomatedPolicy({ selfHeal: true, allowEmpty: true }, "argobot-test", true, "self-test/argobot");
  expectAuthorityFailure(
    () => assertBootstrapAutomatedPolicy({ selfHeal: true }, "root", false, "self-test/root"),
    "neither absent nor the exact one-time",
    "strict post-fence legacy automation",
  );
  expectAuthorityFailure(
    () => assertBootstrapAutomatedPolicy({ selfHeal: true, prune: true }, "root", true, "self-test/root"),
    "neither absent nor the exact one-time",
    "unknown legacy automation",
  );
  assertNoStoredApplicationOperation({}, "self-test/Application");
  expectAuthorityFailure(
    () => assertNoStoredApplicationOperation({ operation: { sync: {} } }, "self-test/Application"),
    "must not contain an executable operation",
    "stored Application operation",
  );
  assertNoMultipleSources({ spec: {} }, "self-test/Application");
  expectAuthorityFailure(
    () => assertNoMultipleSources({ spec: { sources: {} } }, "self-test/Application"),
    "must not define spec.sources",
    "non-array multiple-source field",
  );
  expectAuthorityFailure(
    () => assertExactObjectKeys(
      { repoURL: "oci://example", targetRevision: "latest", path: ".", plugin: {} },
      ["path", "repoURL", "targetRevision"],
      "self-test/Application source",
    ),
    "expected exact keys",
    "extra source plugin",
  );
  const expectedRevision = `sha256:${"a".repeat(64)}`;
  const olderRevision = `sha256:${"b".repeat(64)}`;
  const deployment = {
    space: "test-app",
    acceptedHealth: ["Healthy"],
  };
  check(
    kubernetesResourceNotFound('Error from server (NotFound): applications.argoproj.io "test-app" not found')
      && !kubernetesResourceNotFound("Unable to connect to the server: connection refused")
      && !kubernetesResourceNotFound("the server could not find the requested resource"),
    "the clean-room waiter must retry only an exact Kubernetes object NotFound",
  );
  const fingerprintA = `sha256:${"d".repeat(64)}`;
  const fingerprintB = `sha256:${"e".repeat(64)}`;
  check(
    operationJournalFingerprintDisposition({ executionFingerprint: fingerprintA, convergence: {}, namespaceMove: null }, fingerprintB) === "rotate"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: { state: "observed-gone" },
      }, fingerprintB) === "rotate"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: { active: {} },
        namespaceMove: null,
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: { state: "prepared" },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        immutableSelectorReplacements: { one: { state: "prepared" } },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        immutableSelectorReplacements: { one: { state: "old-uid-gone" } },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        immutableSelectorReplacements: { one: { state: "replacement-healthy" } },
      }, fingerprintB) === "rotate"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        protectedNamespaceDetachments: { one: { state: "prepared" } },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        protectedNamespaceDetachments: { one: { state: "patch-returned" } },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        protectedNamespaceDetachments: { one: { state: "observed-detached" } },
      }, fingerprintB) === "rotate"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        scenario: { state: "started" },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        scenario: { state: "completed" },
      }, fingerprintB) === "rotate"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        scenario: null,
        fleetBootstrap: { state: "started" },
      }, fingerprintB) === "blocked"
      && operationJournalFingerprintDisposition({
        executionFingerprint: fingerprintA,
        convergence: {},
        namespaceMove: null,
        scenario: null,
        fleetBootstrap: { state: "completed" },
      }, fingerprintB) === "rotate",
    "operation-journal fingerprints must rotate only when no operation is in flight",
  );
  const app = ({
    sync = "OutOfSync",
    health = "Progressing",
    phase = "Failed",
    revision = olderRevision,
    operationStateRevision = revision,
    operation = false,
  } = {}) => ({
    ...(operation ? { operation: { sync: {} } } : {}),
    status: {
      sync: { status: sync, revision },
      health: { status: health },
      operationState: { phase, syncResult: { revision: operationStateRevision } },
    },
  });
  const acceptedApp = app({ sync: "Synced", health: "Healthy", phase: "Succeeded", revision: expectedRevision });
  check(
    argoConvergenceState(acceptedApp, deployment, expectedRevision) === "accepted",
    "exact-revision healthy Argo state must be accepted",
  );
  const selectorMigration = {
    kind: "Deployment",
    namespace: "demo",
    name: "web",
  };
  const selectorFailureApp = (syncRevision, operationRevision, resources = [], phase = "Failed", operation = false) => ({
    ...(operation ? { operation: { sync: { revision: operationRevision } } } : {}),
    status: {
      sync: { status: "OutOfSync", revision: syncRevision },
      operationState: {
        phase,
        syncResult: { revision: operationRevision, resources },
      },
    },
  });
  const selectorFailure = {
    group: "apps",
    kind: "Deployment",
    namespace: "demo",
    name: "web",
    status: "SyncFailed",
    hookPhase: "Failed",
    message: "Deployment.apps web is invalid: spec.selector: field is immutable",
  };
  check(
    immutableSelectorFailureRow(selectorFailureApp(expectedRevision, expectedRevision), selectorMigration) === null
      && immutableSelectorFailureRow(selectorFailureApp(expectedRevision, olderRevision, [selectorFailure]), selectorMigration) === null
      && immutableSelectorFailureRow(selectorFailureApp(expectedRevision, expectedRevision, [selectorFailure], "Succeeded"), selectorMigration) === null
      && immutableSelectorFailureRow(selectorFailureApp(expectedRevision, expectedRevision, [selectorFailure], "Unknown"), selectorMigration) === null
      && immutableSelectorFailureRow(selectorFailureApp(expectedRevision, expectedRevision, [selectorFailure], "Failed", true), selectorMigration) === null
      && immutableSelectorFailureRow(selectorFailureApp(expectedRevision, expectedRevision, [selectorFailure]), selectorMigration) === selectorFailure,
    "immutable-selector replacement authorization must require the exact resource-level failure from an operation at the current revision",
  );
  const selectorFailureEvidence = immutableSelectorFailureEvidence(
    selectorFailureApp(expectedRevision, expectedRevision, [selectorFailure]),
    selectorFailure,
  );
  const { sha256: selectorFailureDigest, ...selectorFailureCanonical } = selectorFailureEvidence;
  check(
    selectorFailureEvidence.phase === "Failed"
      && selectorFailureEvidence.syncRevision === expectedRevision
      && selectorFailureEvidence.operationRevision === expectedRevision
      && selectorFailureEvidence.resource.name === selectorMigration.name
      && selectorFailureDigest === `sha256:${sha256(stableJson(selectorFailureCanonical))}`,
    "immutable-selector failure evidence must be canonical and digest-bound",
  );
  const [{ deployment: rebindDeployment, migration: rebindMigration }] = allImmutableSelectorReplacements();
  const rebindFailure = {
    group: "apps",
    kind: rebindMigration.kind,
    namespace: rebindMigration.namespace,
    name: rebindMigration.name,
    status: "SyncFailed",
    hookPhase: "Failed",
    message: `${rebindMigration.kind} is invalid: spec.selector: field is immutable`,
  };
  const rebindApp = selectorFailureApp(expectedRevision, expectedRevision, [rebindFailure]);
  assertImmutableSelectorReplacementEvidence({
    migrationID: rebindMigration.migrationID,
    ref: immutableSelectorReplacementRef(rebindDeployment, rebindMigration),
    uid: "00000000-0000-4000-8000-000000000001",
    resourceVersion: "1",
    application: `${rebindDeployment.cluster}/${rebindDeployment.space}`,
    expectedRevision,
    apiVersion: rebindMigration.apiVersion,
    kind: rebindMigration.kind,
    name: rebindMigration.name,
    namespace: rebindMigration.namespace,
    fromSelector: rebindMigration.fromSelector,
    toSelector: rebindMigration.toSelector,
    retainedPVCs: [],
    reason: rebindMigration.reason,
    trigger: "recovered-resource-level-immutable-selector-failure",
    failureEvidencePolicy: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY,
    failureEvidence: immutableSelectorFailureEvidence(rebindApp, rebindFailure),
    state: "prepared",
    preparedAt: "2026-08-05T19:31:00.000Z",
  }, "self-test prepared rebind", { requireComplete: false });
  check(
    argoConvergenceState(app({
      sync: "Synced",
      health: "Healthy",
      phase: "Succeeded",
      revision: expectedRevision,
      operation: true,
    }), deployment, expectedRevision) === "active-operation",
    "an active operation must take precedence over stale accepted sync and health status",
  );
  check(
    argoConvergenceState(app({ phase: "Running" }), deployment, expectedRevision) === "active-operation"
      && argoConvergenceState(app({ phase: "Terminating" }), deployment, expectedRevision) === "active-operation"
      && argoConvergenceState(app({ phase: "Unknown", operation: true }), deployment, expectedRevision) === "active-operation",
    "running, terminating, or submitted Argo operations must be observed without replacement",
  );
  check(
    argoConvergenceState(app({ sync: "Synced", health: "Progressing", phase: "Succeeded", revision: expectedRevision }), deployment, expectedRevision) === "health-pending",
    "exact-revision health settling must not trigger a resync",
  );
  check(
    argoConvergenceState(app({ sync: "OutOfSync", phase: "Failed", revision: expectedRevision }), deployment, expectedRevision) === "retryable"
      && argoConvergenceState(app({ sync: "Synced", health: "Progressing", phase: "Failed", revision: expectedRevision }), deployment, expectedRevision) === "retryable"
      && argoConvergenceState(app({ sync: "Synced", health: "Progressing", phase: "Error", revision: expectedRevision }), deployment, expectedRevision) === "retryable"
      && argoConvergenceState(app({ sync: "Synced", health: "Healthy", phase: "Succeeded", revision: olderRevision }), deployment, expectedRevision) === "retryable",
    "inactive terminal failure, OutOfSync, or wrong-revision states must be retryable",
  );
  check(
    argoConvergenceState(app({
      sync: "Synced",
      health: "Progressing",
      phase: "Failed",
      revision: expectedRevision,
      operationStateRevision: olderRevision,
    }), deployment, expectedRevision) === "health-pending",
    "a historical failed operation must not resync a current exact revision that is only waiting for health",
  );
  const progressAccepted = { ...deployment, acceptedHealth: ["Healthy", "Progressing"] };
  check(
    argoConvergenceState(app({ sync: "Synced", health: "Progressing", phase: "Succeeded", revision: expectedRevision }), progressAccepted, expectedRevision) === "accepted",
    "declared Progressing acceptance must remain immediate",
  );
  const oldStart = "2026-08-04T20:00:00Z";
  const firstObservation = Date.parse("2026-08-04T20:30:00Z");
  const secondObservation = Date.parse("2026-08-04T20:45:00Z");
  const validLaterStart = "2026-08-04T20:40:00Z";
  const futureStart = "2026-08-04T21:00:00Z";
  check(
    observedTimestamp(oldStart, firstObservation) === Date.parse(oldStart)
      && observedTimestamp(futureStart, firstObservation) === firstObservation
      && observedTimestamp(validLaterStart, firstObservation, secondObservation) === Date.parse(validLaterStart)
      && observedTimestamp(futureStart, firstObservation, secondObservation) === firstObservation
      && observedTimestamp("not-a-date", firstObservation) === firstObservation,
    "Argo controller timestamps must be bounded by their observation and reject future or invalid values",
  );
  const operationAt = (revision, timestamp) => ({
    status: {
      operationState: {
        startedAt: timestamp,
        finishedAt: timestamp,
        syncResult: { revision },
      },
    },
  });
  const wrongRevisionOperation = operationAt(olderRevision, oldStart);
  const oldOperation = operationAt(expectedRevision, oldStart);
  const laterOperation = operationAt(expectedRevision, validLaterStart);
  const futureOperation = operationAt(expectedRevision, futureStart);
  check(
    expectedRevisionTimestamp(wrongRevisionOperation, expectedRevision, "startedAt", firstObservation) === firstObservation
      && expectedRevisionTimestamp(oldOperation, expectedRevision, "startedAt", firstObservation) === Date.parse(oldStart)
      && expectedRevisionTimestamp(laterOperation, expectedRevision, "startedAt", firstObservation, secondObservation) === Date.parse(validLaterStart)
      && expectedRevisionTimestamp(futureOperation, expectedRevision, "startedAt", firstObservation, secondObservation) === firstObservation,
    "Argo controller timestamps must be accepted only for the expected revision and at or before the current observation",
  );
  const phaseStart = (state, previous = null, field = "startedAt") => convergencePhaseStartedAt(
    state, expectedRevision, field, firstObservation, previous, secondObservation,
  );
  const firstPhaseStart = phaseStart(oldOperation);
  const laterPhaseStart = phaseStart(laterOperation, firstPhaseStart);
  check(
    firstPhaseStart === firstObservation
      && laterPhaseStart === Date.parse(validLaterStart)
      && phaseStart(futureOperation, laterPhaseStart) === laterPhaseStart
      && phaseStart(wrongRevisionOperation, laterPhaseStart) === laterPhaseStart
      && phaseStart(laterOperation, null, "finishedAt") === Date.parse(validLaterStart),
    "phase clocks must not predate persisted observation or move for future and wrong-revision controller timestamps",
  );
  const journalDeployment = { cluster: "test-cluster", space: "test-app" };
  const firstJournalEntry = convergenceJournalEntry(journalDeployment, expectedRevision, firstObservation);
  const restartedJournalEntry = convergenceJournalEntry(
    journalDeployment,
    expectedRevision,
    secondObservation,
    { ...firstJournalEntry, syncReservations: 2, updatedAt: new Date(secondObservation).toISOString() },
  );
  const persistedStartedAt = Date.parse(restartedJournalEntry.startedAt);
  check(
    Date.parse(firstJournalEntry.startedAt) === firstObservation
      && Date.parse(firstJournalEntry.startedAt) !== Date.parse(oldStart)
      && persistedStartedAt === firstObservation
      && restartedJournalEntry.syncReservations === 2,
    "convergence journals must start at first reconciler observation and retain that clock and reservations across restarts",
  );
  check(
    withinDeadline(persistedStartedAt, persistedStartedAt + ARGO_CONVERGENCE_TIMEOUT_MS, ARGO_CONVERGENCE_TIMEOUT_MS)
      && !withinDeadline(persistedStartedAt, persistedStartedAt + ARGO_CONVERGENCE_TIMEOUT_MS + 1, ARGO_CONVERGENCE_TIMEOUT_MS)
      && !withinDeadline(persistedStartedAt, persistedStartedAt - 1, ARGO_CONVERGENCE_TIMEOUT_MS)
      && withinDeadline(firstPhaseStart, secondObservation, ARGO_OPERATION_TIMEOUT_MS),
    "persisted convergence and phase deadlines must include the exact boundary and fail closed beyond it",
  );
  const acceptedKey = convergenceJournalKey(journalDeployment, expectedRevision);
  const survivorKey = "survivor";
  const acceptedCleanupJournal = {
    convergence: {
      [acceptedKey]: { ...firstJournalEntry, startedAt: new Date(firstObservation - ARGO_CONVERGENCE_TIMEOUT_MS - 1).toISOString() },
      [survivorKey]: { application: "test-cluster/survivor" },
    },
  };
  check(
    argoConvergenceState(acceptedApp, deployment, expectedRevision) === "accepted"
      && !withinDeadline(
        Date.parse(acceptedCleanupJournal.convergence[acceptedKey].startedAt),
        firstObservation,
        ARGO_CONVERGENCE_TIMEOUT_MS,
      ),
    "accepted exact state must remain recognizable even after its persisted deadline",
  );
  clearConvergenceJournalEntry(acceptedCleanupJournal, acceptedKey);
  check(
    !Object.hasOwn(acceptedCleanupJournal.convergence, acceptedKey)
      && Object.hasOwn(acceptedCleanupJournal.convergence, survivorKey),
    "accepted-state cleanup must remove only its exact convergence journal entry",
  );
  check(
    activeOperationMatchesExpectedRevision({
      operation: { sync: { revision: expectedRevision } },
      status: { operationState: { phase: "Running", syncResult: { revision: olderRevision } } },
    }, expectedRevision) === true
      && activeOperationMatchesExpectedRevision({
        operation: { sync: { revision: olderRevision } },
        status: { sync: { revision: expectedRevision }, operationState: { phase: "Running", syncResult: { revision: expectedRevision } } },
      }, expectedRevision) === false
      && activeOperationMatchesExpectedRevision({
        operation: { sync: {} },
        status: { sync: { revision: expectedRevision }, operationState: { phase: "Running", syncResult: { revision: expectedRevision } } },
      }, expectedRevision) === false,
    "namespace-move authorization must require the explicit active operation revision rather than historical sync status",
  );
  const workload = (namespace) => ({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { namespace },
    spec: { template: { spec: { hostNetwork: true, containers: [{ ports: [{ protocol: "TCP", containerPort: 9100 }] }] } } },
  });
  check(
    stableJson(hostNetworkBindings(workload("default"))) === stableJson(["TCP/9100"])
      && hostNetworkBindings(workload("default")).some((binding) => hostNetworkBindings(workload("monitoring")).includes(binding)),
    "namespace-move pruning must prove an exact shared host-network binding",
  );
  const runtimeFixture = {
    items: [...new Set(ARGO_CD_RUNTIME_CONTAINER_PAIRS.map(([name]) => name))].map((name) => ({
      metadata: { name },
      spec: {
        template: {
          spec: {
            containers: ARGO_CD_RUNTIME_CONTAINER_PAIRS
              .filter(([workloadName]) => workloadName === name)
              .map(([, container]) => ({ name: container, image: ARGO_CD_RUNTIME_IMAGE })),
          },
        },
      },
    })),
  };
  const runtimeObservation = validateClusterLocalArgoRuntime("self-test", runtimeFixture);
  check(
    stableJson(runtimeObservation.references.map((row) => [row.workload, row.container]))
      === stableJson(ARGO_CD_RUNTIME_CONTAINER_PAIRS),
    "cluster-local Argo runtime evidence must retain the exact reviewed workload/container pairs",
  );
  const wrongRegistryFixture = JSON.parse(JSON.stringify(runtimeFixture));
  wrongRegistryFixture.items
    .find((item) => item.metadata.name === "argocd-repo-server")
    .spec.template.spec.containers
    .find((container) => container.name === "copyutil").image = "example.invalid/argocd:v3.4.6";
  let wrongRegistryError = null;
  try {
    validateClusterLocalArgoRuntime("self-test", wrongRegistryFixture);
  } catch (error) {
    wrongRegistryError = error;
  }
  check(
    wrongRegistryError?.message.includes("argocd-repo-server/copyutil")
      && wrongRegistryError.message.includes(ARGO_CD_RUNTIME_IMAGE),
    "cluster-local Argo runtime evidence must refuse a named container that drifts outside the expected registry",
  );
  const promotionBefore = {
    metadata: { annotations: {}, labels: { app: "hx-web" } },
    spec: { replicas: 2, selector: { matchLabels: { app: "hx-web" } } },
  };
  const promotionAfter = {
    metadata: { annotations: { revision: "v1" }, labels: { app: "hx-web" } },
    spec: { replicas: 3, selector: { matchLabels: { app: "hx-web" } } },
  };
  const reviewedBlend = {
    metadata: { annotations: { revision: "v1" }, labels: { app: "hx-web" } },
    spec: { replicas: 2, selector: { matchLabels: { app: "hx-web" } } },
  };
  const escapedBlend = structuredClone(reviewedBlend);
  escapedBlend.spec.replicas = 99;
  check(
    promotionBlendDifference(reviewedBlend, promotionBefore, promotionAfter) === null
      && promotionBlendDifference(escapedBlend, promotionBefore, promotionAfter)?.includes("replicas"),
    "promotion recovery must accept only pathwise values from the reviewed before/after payload pair",
  );
  console.log("Kubara mini-IDP Argo convergence self-test passed");
}

function releaseManifestDigest(release) {
  const bundleDigest = release?.Digest ?? release?.Release?.Digest ?? "";
  const manifestDigest = release?.ManifestDigest ?? release?.Release?.ManifestDigest ?? "";
  check(
    /^sha256:[0-9a-f]{64}$/.test(bundleDigest),
    `ConfigHub bundle content digest is missing or invalid: ${bundleDigest || "empty"}`,
  );
  check(
    /^sha256:[0-9a-f]{64}$/.test(manifestDigest),
    `ConfigHub OCI manifest digest is missing or invalid: ${manifestDigest || "empty"}`,
  );
  return manifestDigest;
}

function readPublishedReleaseRows(space) {
  if (activeVerificationReadSnapshot) {
    activeVerificationReadSnapshot.evidenceByResource.get("release").servedReads += 1;
    return [...(activeVerificationReadSnapshot.releasesBySpace.get(space) ?? [])];
  }
  if (activeSourceReleaseBoundarySnapshot) {
    check(
      activeSourceReleaseBoundarySnapshot.releasesBySpace.has(space),
      `${space}: authoritative release boundary did not preload published releases`,
    );
    return [...activeSourceReleaseBoundarySnapshot.releasesBySpace.get(space)];
  }
  if (activeApplyReadSnapshot) {
    const evidence = applyReadResourceEvidence("release");
    evidence.servedReads += 1;
    if (!activeApplyReadSnapshot.releasesBySpace.has(space)) {
      activeApplyReadSnapshot.releasesBySpace.set(
        space,
        applyReadLoader("releases", fetchPublishedReleases, space),
      );
      evidence.mutationRefreshCalls += 1;
    }
    return [...activeApplyReadSnapshot.releasesBySpace.get(space)];
  }
  return fetchPublishedReleases(space);
}

function latestRelease(space) {
  return readPublishedReleaseRows(space)[0] ?? null;
}

function kubectl(cluster, args, options = {}) {
  return command("kubectl", [
    "--kubeconfig", clusterKubeconfig(cluster),
    "--context", `kind-${cluster}`,
    ...args,
  ], options);
}

function kubectlTry(cluster, args, options = {}) {
  return tryCommand("kubectl", [
    "--kubeconfig", clusterKubeconfig(cluster),
    "--context", `kind-${cluster}`,
    ...args,
  ], options);
}

function observeClusterLocalArgoRuntime(cluster) {
  const workloads = JSON.parse(kubectl(cluster, [
    "get", "deployment,statefulset", "-n", "argocd", "-o", "json",
  ]));
  return validateClusterLocalArgoRuntime(cluster, workloads);
}

function validateClusterLocalArgoRuntime(cluster, workloads) {
  const allContainers = [];
  for (const item of workloads.items ?? []) {
    for (const container of [
      ...(item.spec?.template?.spec?.initContainers ?? []),
      ...(item.spec?.template?.spec?.containers ?? []),
    ]) {
      allContainers.push({
        workload: item.metadata?.name,
        container: container.name,
        image: container.image,
      });
    }
  }
  const expectedWorkloads = [...new Set(ARGO_CD_RUNTIME_CONTAINER_PAIRS.map(([workload]) => workload))].sort();
  const observedWorkloads = [...new Set((workloads.items ?? []).map((item) => item.metadata?.name))].sort();
  check(
    stableJson(observedWorkloads) === stableJson(expectedWorkloads),
    `${cluster}: Argo CD workload inventory drifted: ${observedWorkloads.join(", ")}`,
  );
  const containersByPair = new Map();
  for (const item of allContainers) {
    const key = `${item.workload}/${item.container}`;
    check(!containersByPair.has(key), `${cluster}: duplicate Argo CD workload/container pair ${key}`);
    containersByPair.set(key, item);
  }
  const expectedPairKeys = new Set(ARGO_CD_RUNTIME_CONTAINER_PAIRS.map(([workload, container]) => `${workload}/${container}`));
  const references = ARGO_CD_RUNTIME_CONTAINER_PAIRS.map(([workload, container]) => {
    const key = `${workload}/${container}`;
    const item = containersByPair.get(key);
    check(item, `${cluster}: expected Argo CD workload/container pair ${key} is missing`);
    check(item.image === ARGO_CD_RUNTIME_IMAGE, `${cluster}: ${key} is ${item.image ?? "missing"}, expected ${ARGO_CD_RUNTIME_IMAGE}`);
    return item;
  });
  const unexpectedRuntimePairs = allContainers
    .filter((item) => String(item.image ?? "").startsWith("quay.io/argoproj/argocd:")
      && !expectedPairKeys.has(`${item.workload}/${item.container}`));
  check(
    unexpectedRuntimePairs.length === 0,
    `${cluster}: unexpected Argo CD runtime workload/container pairs: ${unexpectedRuntimePairs.map((item) => `${item.workload}/${item.container}`).join(", ")}`,
  );
  return {
    cluster,
    installedBy: "cub cluster up",
    version: ARGO_CD_RUNTIME_VERSION,
    image: ARGO_CD_RUNTIME_IMAGE,
    references,
  };
}

function waitForSpecialPrerequisite(deployment) {
  if (deployment.space === "hx-eso-store-dev") {
    kubectl(DEV.cluster, ["wait", "--for=condition=Ready", "clustersecretstore/hx-app-dev-dev", "--timeout=5m"]);
  }
  if (deployment.space === "hx-eso-grafana-es-dev") {
    kubectl(DEV.cluster, ["wait", "--for=condition=Ready", "externalsecret/grafana-admin-credentials-es", "-n", "kube-prometheus-stack", "--timeout=5m"]);
    const secret = JSON.parse(kubectl(DEV.cluster, ["get", "secret", "grafana-admin-credentials", "-n", "kube-prometheus-stack", "-o", "json"]));
    check(
      (secret.metadata?.ownerReferences ?? []).some(
        (owner) => owner.apiVersion === "external-secrets.io/v1"
          && owner.kind === "ExternalSecret"
          && owner.name === "grafana-admin-credentials-es"
          && owner.controller === true,
      ),
      "Grafana credentials Secret is not owned by the expected ExternalSecret",
    );
  }
}

function reconcileLinks(desired, state) {
  for (const expected of desired.links) {
    const existing = readLinks(expected.space).find((item) => item.Slug === expected.slug);
    if (!existing) {
      cub([
        "link", "create", "--space", expected.space,
        expected.slug, expected.fromUnit, expected.toUnit, expected.toSpace,
        "--update-type", "NeedsProvides",
        "--make-current",
        "--no-auto-update",
        "--annotation", `${LINK_REASON_ANNOTATION}=${expected.reason}`,
        ...labelsArgs(expected.labels),
        "--wait", "--quiet",
      ]);
      recordAction(state, "link-create", `${expected.space}/${expected.slug}`, `${expected.toSpace}/${expected.toUnit}`);
      continue;
    }
    const from = readUnit(expected.space, expected.fromUnit);
    const to = readUnit(expected.toSpace, expected.toUnit);
    const toSpace = readSpaces().get(expected.toSpace);
    check(from && to, `${expected.space}/${expected.slug}: endpoint Unit missing`);
    if (
      existing.FromUnitID !== from.UnitID
      || existing.ToUnitID !== to.UnitID
      || existing.ToSpaceID !== toSpace.SpaceID
      || existing.UpdateType !== "NeedsProvides"
      || existing.AutoUpdate === true
      || !mapMatches(existing.Labels, expected.labels)
      || staleOwnedLinkLabels(existing.Labels, expected.labels).length > 0
      || existing.Annotations?.[LINK_REASON_ANNOTATION] !== expected.reason
    ) {
      cub([
        "link", "update", "--space", expected.space,
        expected.slug, expected.fromUnit, expected.toUnit, expected.toSpace,
        "--update-type", "NeedsProvides",
        "--make-current",
        "--no-auto-update",
        "--annotation", `${LINK_REASON_ANNOTATION}=${expected.reason}`,
        ...labelsArgs(expected.labels),
        ...staleOwnedLinkLabels(existing.Labels, expected.labels)
          .flatMap((key) => ["--label", `${key}=-`]),
        "--wait", "--quiet",
      ]);
      recordAction(state, "link-update", `${expected.space}/${expected.slug}`, `${expected.toSpace}/${expected.toUnit}`);
    }
  }
}

function verifyLive(inputs, desired, { state = null } = {}) {
  // Apply already pinned the named ConfigHub context and every write re-pins
  // it. Standalone verification still performs the full organization check.
  if (!state) assertKubaraOrganization();
  const findings = [];
  const spaces = readSpaces();
  const verificationReadSnapshot = beginVerificationReadSnapshot(spaces);
  try {
  assertAuthoritativeReleaseReuseFinalOpening(state?.applyReadCacheEvidence, verificationReadSnapshot);
  assertExactManagedTargetInventory(verificationReadSnapshot, "live verification ConfigHub Target inventory");
  const controlSpace = spaces.get(CONTROL_SPACE);
  check(controlSpace, `${CONTROL_SPACE}: control Space is missing from the authoritative verification snapshot`);
  check(controlSpace.OrganizationID === ORGANIZATION_ENTITY_ID, `${CONTROL_SPACE}: organization entity ID drifted from the pinned Kubara org`);
  assertSpaceAllowlist(spaces, desired, { requireAll: true });
  assertDeliveryTopology(spaces, desired, {
    requireAllApplications: true,
    requireApplicationMetadata: true,
  });
  assertManagedLinkInventory(desired, { requireNeedsProvides: true });
  const preservedControlUnits = assertPreservedFaithfulControlUnits();
  const localClusters = new Set(kindClusters());
  const targets = new Map();
  const deliveryRuntimes = [];
  const argobotAuthority = [];
  const applicationSets = [];
  const liveApplicationsByCluster = new Map();
  for (const item of FLEET) {
    if (!localClusters.has(item.cluster)) findings.push(`${item.cluster}: kind cluster missing`);
    if (!existsSync(clusterKubeconfig(item.cluster))) findings.push(`${item.cluster}: kubeconfig missing`);
    if (!existsSync(clusterEnv(item.cluster))) findings.push(`${item.cluster}: env file missing`);
    if (localClusters.has(item.cluster) && existsSync(clusterKubeconfig(item.cluster))) {
      try {
        deliveryRuntimes.push(observeClusterLocalArgoRuntime(item.cluster));
        argobotAuthority.push(assertLiveArgobotRefreshOnlyRuntime(item.cluster));
        const applicationSetItems = JSON.parse(kubectl(item.cluster, [
          "get", "applicationsets.argoproj.io", "-A", "-o", "json",
        ])).items ?? [];
        applicationSets.push({
          cluster: item.cluster,
          count: applicationSetItems.length,
          refs: applicationSetItems.map((applicationSet) => `${applicationSet.metadata?.namespace ?? ""}/${applicationSet.metadata?.name ?? "unknown"}`).sort(),
        });
        if (applicationSetItems.length > 0) findings.push(`${item.cluster}: adapted lane contains ${applicationSetItems.length} ApplicationSet(s)`);
        liveApplicationsByCluster.set(item.cluster, readApplicationInventory(item.cluster));
      } catch (error) {
        findings.push(error.message);
      }
    }
    const targetEntity = readTarget(item.cluster);
    if (!targetEntity) findings.push(`${item.cluster}/target: missing`);
    else targets.set(item.cluster, targetEntity);
  }

  const spaceRows = [];
  for (const expected of desired.spaces) {
    const live = spaces.get(expected.slug);
    if (!live) {
      findings.push(`${expected.slug}: Space missing`);
      continue;
    }
    for (const [key, value] of Object.entries(expected.labels)) {
      if (live.Labels?.[key] !== value) findings.push(`${expected.slug}: label ${key}=${JSON.stringify(live.Labels?.[key])}, expected ${JSON.stringify(value)}`);
    }
    for (const key of staleOwnedLabels(live.Labels, expected.labels)) findings.push(`${expected.slug}: stale owned label ${key}`);
    const expectedAnnotations = expected.annotations ?? {};
    for (const [key, value] of Object.entries(expectedAnnotations)) {
      if (live.Annotations?.[key] !== value) findings.push(`${expected.slug}: annotation ${key} drifted`);
    }
    for (const key of staleOwnedPublicAnnotations(live.Annotations, expectedAnnotations)) findings.push(`${expected.slug}: stale owned navigation annotation ${key}`);
    spaceRows.push({
      slug: expected.slug,
      id: live.SpaceID,
      type: expected.type,
      labels: expected.labels,
      annotations: expectedAnnotations,
      releaseTargetID: live.ReleaseTargetID ?? null,
      triggerFilterID: live.TriggerFilterID ?? null,
    });
  }

  const unitRows = [];
  const expectedUnitsBySpace = new Map();
  for (const expected of desired.managedUnits) {
    if (!expected.payloadKey) {
      findings.push(`${expected.space}/${expected.slug}: planned payload missing`);
      continue;
    }
    if (!expectedUnitsBySpace.has(expected.space)) expectedUnitsBySpace.set(expected.space, []);
    expectedUnitsBySpace.get(expected.space).push(expected.slug);
    const live = readUnit(expected.space, expected.slug);
    if (!live) {
      findings.push(`${expected.space}/${expected.slug}: Unit missing`);
      continue;
    }
    const payload = inputs.payloads.get(expected.payloadKey);
    if (!payload) {
      findings.push(`${expected.space}/${expected.slug}: payload ${expected.payloadKey} missing`);
      continue;
    }
    if (live.ToolchainType !== expected.toolchain) findings.push(`${expected.space}/${expected.slug}: toolchain ${live.ToolchainType}, expected ${expected.toolchain}`);
    if ((live.ProviderType ?? null) !== (expected.provider ?? null)) findings.push(`${expected.space}/${expected.slug}: provider ${live.ProviderType ?? "default"}, expected ${expected.provider ?? "default"}`);
    if (!mapMatches(live.Labels, expected.labels)) findings.push(`${expected.space}/${expected.slug}: labels drifted`);
    for (const key of staleOwnedUnitLabels(live.Labels, expected.labels)) findings.push(`${expected.space}/${expected.slug}: stale owned label ${key}`);
    const annotations = {
      ...sourceAnnotation(payload.value, payload.sourcePaths, payload.transform),
      ...(expected.annotations ?? {}),
    };
    if (!mapMatches(live.Annotations, annotations)) findings.push(`${expected.space}/${expected.slug}: source annotations drifted`);
    for (const key of staleOwnedPublicAnnotations(live.Annotations, annotations)) findings.push(`${expected.space}/${expected.slug}: stale owned navigation annotation ${key}`);
    const liveData = readUnitData(expected.space, expected.slug);
    if (!sameUnitData(expected.toolchain, liveData, payload.value)) findings.push(`${expected.space}/${expected.slug}: data drifted from ${expected.payloadKey}`);
    if (expected.target) {
      const cluster = expected.target.split("/")[0];
      if (live.TargetID !== targets.get(cluster)?.TargetID) findings.push(`${expected.space}/${expected.slug}: target drifted`);
    } else if (live.TargetID) {
      findings.push(`${expected.space}/${expected.slug}: base/control Unit unexpectedly has a target`);
    }
    if (expected.upstream) {
      const [upstreamSpace, upstreamSlug] = expected.upstream.split("/");
      const upstream = readUnit(upstreamSpace, upstreamSlug);
      if (!upstream || live.UpstreamUnitID !== upstream.UnitID) findings.push(`${expected.space}/${expected.slug}: upstream link is not ${expected.upstream}`);
    }
    if (expected.prodProtected) {
      if (!gateEnabled(live.DeleteGates, PROD_SAFETY_GATE)) findings.push(`${expected.space}/${expected.slug}: delete gate missing`);
      if (!gateEnabled(live.DestroyGates, PROD_SAFETY_GATE)) findings.push(`${expected.space}/${expected.slug}: destroy gate missing`);
    }
    unitRows.push({
      ref: `${expected.space}/${expected.slug}`,
      id: live.UnitID,
      role: expected.role,
      toolchain: live.ToolchainType,
      provider: live.ProviderType ?? null,
      targetID: live.TargetID ?? null,
      upstreamUnitID: live.UpstreamUnitID ?? null,
      headRevisionNum: live.HeadRevisionNum,
      dataHash: live.DataHash,
      sourceSha256: `sha256:${payload.sha256}`,
      labels: expected.labels,
      navigationAnnotations: expected.annotations ?? {},
    });
  }
  for (const [space, expectedSlugs] of expectedUnitsBySpace) {
    const actual = readUnitRows(space).map((item) => item.Slug).sort();
    const allowedSlugs = space === CONTROL_SPACE
      ? [...expectedSlugs, ...PRESERVED_FAITHFUL_CONTROL_UNITS.map((item) => item.slug)].sort()
      : expectedSlugs.sort();
    if (stableJson(actual) !== stableJson(allowedSlugs)) findings.push(`${space}: unexpected managed Unit inventory ${actual.join(", ")}`);
  }

  const policy = verifyPolicy(desired, findings, spaces);
  const linkRows = verifyLinks(desired, findings);
  const releases = [];
  const applications = [];
  for (const deployment of desired.deployments) {
    const release = latestRelease(deployment.space);
    const bundleDigest = release?.Digest ?? "";
    const manifestDigest = release?.ManifestDigest ?? "";
    const expectedReleaseUnitCount = readUnitRows(deployment.space).length;
    const expectedRevision = manifestDigest;
    if (!release || !/^sha256:[0-9a-f]{64}$/.test(bundleDigest)) {
      findings.push(`${deployment.space}: published bundle content digest missing`);
    } else if (!/^sha256:[0-9a-f]{64}$/.test(manifestDigest)) {
      findings.push(`${deployment.space}: published OCI manifest digest missing`);
    } else if (Number(release.UnitCount) !== expectedReleaseUnitCount) {
      findings.push(`${deployment.space}: published release UnitCount=${release.UnitCount}, expected ${expectedReleaseUnitCount}`);
    } else {
      releases.push({
        space: deployment.space,
        id: release.ReleaseID,
        tagID: release.TagID,
        releaseNum: release.ReleaseNum,
        unitCount: release.UnitCount,
        expectedUnitCount: expectedReleaseUnitCount,
        bundleDigest,
        manifestDigest,
        createdAt: release.CreatedAt,
      });
    }
    const appUnit = readUnit(deployment.appSpace, deployment.appUnit);
    if (!appUnit) {
      findings.push(`${deployment.appSpace}/${deployment.appUnit}: Argo Application Unit missing`);
      continue;
    }
    if (appUnit.TargetID !== targets.get(deployment.cluster)?.TargetID) {
      findings.push(`${deployment.appSpace}/${deployment.appUnit}: target drifted`);
    }
    const appDocs = parseDocs(readUnitData(deployment.appSpace, deployment.appUnit));
    const app = appDocs[0];
    try {
      assertNoStoredApplicationOperation(app, `${deployment.appSpace}/${deployment.appUnit}: final release Application`);
      assertArgoApplicationContract(app, deployment);
    } catch (error) {
      findings.push(error.message);
    }
    const options = app?.spec?.syncPolicy?.syncOptions ?? [];
    if (options.some((item) => String(item).startsWith("Replace="))) findings.push(`${deployment.appSpace}/${deployment.appUnit}: Replace sync option remains`);
    const expectedOptions = applicationSyncOptions(deployment);
    if (stableJson(options) !== stableJson(expectedOptions)) findings.push(`${deployment.appSpace}/${deployment.appUnit}: sync options drifted from ${stableJson(expectedOptions)}`);
    const expectedSyncPolicy = applicationSyncPolicy(deployment);
    if (stableJson(app?.spec?.syncPolicy) !== stableJson(expectedSyncPolicy)) findings.push(`${deployment.appSpace}/${deployment.appUnit}: automated sync policy drifted`);
    const expectedDestination = {
      server: "https://kubernetes.default.svc",
      namespace: deployment.destinationNamespace,
    };
    if (stableJson(app?.spec?.destination) !== stableJson(expectedDestination)) findings.push(`${deployment.appSpace}/${deployment.appUnit}: destination contract drifted`);
    const ignoreDifferences = app?.spec?.ignoreDifferences ?? [];
    if (deployment.ignoreInjectedCertificateData && stableJson(ignoreDifferences) !== stableJson(certificateIgnoreDifferences())) findings.push(`${deployment.appSpace}/${deployment.appUnit}: certificate ignoreDifferences drifted`);
    if (!deployment.ignoreInjectedCertificateData && ignoreDifferences.length !== 0) findings.push(`${deployment.appSpace}/${deployment.appUnit}: unexpected ignoreDifferences`);
    const observed = readApplication(
      deployment.cluster,
      deployment.space,
      liveApplicationsByCluster.get(deployment.cluster) ?? new Map(),
    );
    if (!observed.exists) {
      findings.push(`${deployment.cluster}/${deployment.space}: Argo Application missing`);
    } else {
      if (observed.sync !== "Synced") findings.push(`${deployment.cluster}/${deployment.space}: sync=${observed.sync}`);
      if (!deployment.acceptedHealth.includes(observed.health)) findings.push(`${deployment.cluster}/${deployment.space}: health=${observed.health}, expected ${deployment.acceptedHealth.join("|")}`);
      if (observed.revision !== expectedRevision) findings.push(`${deployment.cluster}/${deployment.space}: revision=${observed.revision}, expected ${expectedRevision}`);
    }
    applications.push({
      cluster: deployment.cluster,
      name: deployment.space,
      destinationNamespace: deployment.destinationNamespace,
      expectedRevision,
      observedRevision: observed.revision,
      syncState: observed.sync,
      healthState: observed.health,
      acceptedHealth: deployment.acceptedHealth,
      targetRevision: observed.targetRevision,
      automatedSyncDisabled: observed.automatedSyncDisabled,
      activeOperation: observed.activeOperation,
      operationPhase: observed.operationPhase,
      applicationSetOwnerAbsent: observed.applicationSetOwnerAbsent,
      conditions: observed.conditions,
    });
  }

  const deploymentAuthority = [];
  for (const fleetItem of FLEET) {
    const appSpace = `${fleetItem.cluster}-argo-apps`;
    const contracts = [
      {
        cluster: fleetItem.cluster,
        name: appSpace,
        sourceSpace: appSpace,
        unitRef: `${appSpace}/root`,
        acceptedHealth: ["Healthy"],
        role: "DeliveryRoot",
      },
      {
        cluster: fleetItem.cluster,
        name: `argobot-${fleetItem.cluster}`,
        sourceSpace: `argobot-${fleetItem.cluster}`,
        unitRef: `${appSpace}/argobot-${fleetItem.cluster}`,
        acceptedHealth: ["Healthy"],
        role: "RefreshHelper",
      },
      ...desired.deployments
        .filter((deployment) => deployment.cluster === fleetItem.cluster)
        .map((deployment) => ({
          cluster: deployment.cluster,
          name: deployment.space,
          sourceSpace: deployment.space,
          unitRef: `${deployment.appSpace}/${deployment.appUnit}`,
          acceptedHealth: deployment.acceptedHealth,
          role: deployment.type === "platform" ? "PlatformComponent" : "Application",
        })),
    ];
    const inventory = liveApplicationsByCluster.get(fleetItem.cluster) ?? new Map();
    const expectedNames = new Set(contracts.map((contract) => contract.name));
    for (const name of [...inventory.keys()].filter((candidate) => !expectedNames.has(candidate)).sort()) {
      findings.push(`${fleetItem.cluster}/${name}: live Application is outside the exact adapted-lane allowlist`);
    }
    for (const contract of contracts) {
      const observed = readApplication(fleetItem.cluster, contract.name, inventory);
      const raw = inventory.get(contract.name);
      const [unitSpace, unitSlug] = contract.unitRef.split("/");
      const desiredApplication = parseDocs(readUnitData(unitSpace, unitSlug))[0];
      if (!observed.exists || !raw) {
        findings.push(`${fleetItem.cluster}/${contract.name}: managed live Application is missing`);
      } else {
        if (stableJson(raw.spec) !== stableJson(desiredApplication?.spec)) findings.push(`${fleetItem.cluster}/${contract.name}: live spec differs from exact ConfigHub Application Unit ${contract.unitRef}`);
        if (observed.repoURL !== `${CONFIGHUB_OCI_SPACE_PREFIX}${contract.sourceSpace}`) findings.push(`${fleetItem.cluster}/${contract.name}: live source is not ${contract.sourceSpace}`);
        if (observed.targetRevision !== "latest") findings.push(`${fleetItem.cluster}/${contract.name}: targetRevision is not discovery-only latest`);
        if (!observed.automatedSyncDisabled) findings.push(`${fleetItem.cluster}/${contract.name}: automated sync remains enabled`);
        if (observed.activeOperation) findings.push(`${fleetItem.cluster}/${contract.name}: active Argo operation phase=${observed.operationPhase}`);
        if (!observed.applicationSetOwnerAbsent) findings.push(`${fleetItem.cluster}/${contract.name}: ApplicationSet ownership can regenerate this Application`);
      }
      const release = latestRelease(contract.sourceSpace);
      const expectedUnitCount = readUnitRows(contract.sourceSpace).length;
      let expectedRevision = null;
      try {
        validatedPublishedRelease(contract.sourceSpace, release, "final deployment-authority release");
        assertPublishedReleaseUnitCount(
          contract.sourceSpace,
          release,
          expectedUnitCount,
          "final deployment-authority release",
        );
        expectedRevision = release.ManifestDigest;
      } catch (error) {
        findings.push(error.message);
      }
      if (observed.exists) {
        if (observed.sync !== "Synced") findings.push(`${fleetItem.cluster}/${contract.name}: authority sync=${observed.sync}`);
        if (!contract.acceptedHealth.includes(observed.health)) findings.push(`${fleetItem.cluster}/${contract.name}: authority health=${observed.health}, expected ${contract.acceptedHealth.join("|")}`);
        if (observed.revision !== expectedRevision) findings.push(`${fleetItem.cluster}/${contract.name}: authority revision=${observed.revision}, expected ${expectedRevision}`);
      }
      deploymentAuthority.push({
        cluster: fleetItem.cluster,
        name: contract.name,
        role: contract.role,
        sourceSpace: contract.sourceSpace,
        sourceUnit: contract.unitRef,
        releaseID: release?.ReleaseID ?? null,
        releaseTagID: release?.TagID ?? null,
        releaseNum: release?.ReleaseNum ?? null,
        releaseUnitCount: release?.UnitCount ?? null,
        expectedUnitCount,
        expectedRevision,
        observedRevision: observed.revision,
        targetRevision: observed.targetRevision,
        automatedSyncDisabled: observed.automatedSyncDisabled,
        activeOperation: observed.activeOperation,
        operationPhase: observed.operationPhase,
        applicationSetOwnerAbsent: observed.applicationSetOwnerAbsent,
        syncState: observed.sync,
        healthState: observed.health,
        acceptedHealth: contract.acceptedHealth,
        syncSubmissionAuthority: "ConfigHub-revalidated-ManifestDigest-Kubernetes-UID-resourceVersion-CAS",
      });
    }
  }

  const protectedNamespaces = observeProtectedNamespacePostconditions(findings);
  const kindTraefik = observeKindTraefikLive(findings);

  let scenario = [];
  try {
    for (const slug of ["hx-web-base", ...FLEET.map((item) => `hx-web-${item.suffix}`)]) {
      if (spaces.get(slug)?.Labels?.ScenarioVersion !== SCENARIO_VERSION) findings.push(`${slug}: scenario marker ${SCENARIO_VERSION} missing`);
    }
    scenario = verifyHxWebFinalState(inputs);
  } catch (error) {
    findings.push(error.message);
  }
  const secretWiring = observeGrafanaSecretWiring(findings);
  const liveMatrix = observeLiveMatrix(inputs, desired, applications, deliveryRuntimes);
  for (const row of liveMatrix.rows.filter((item) => item.deliveryState === "delivered")) {
    if (row.syncState !== "Synced") findings.push(`matrix ${row.cluster}/${row.component}: sync=${row.syncState}`);
    if (row.readiness?.result === "fail") findings.push(`matrix ${row.cluster}/${row.component}: workloads not ready`);
  }

  const bulkSnapshots = finishVerificationReadSnapshot(captureOrganizationReadSnapshot, fetchSpaces, desired);
  const measuredPerformance = performanceEvidence(
    `${mode === "--apply" ? "apply" : "verify"}-process-through-live-verification`,
    bulkSnapshots,
  );
  measuredPerformance.phases = state?.performancePhases ?? [];
  if (state?.applyReadCacheEvidence) measuredPerformance.applyReadCache = state.applyReadCacheEvidence;
  check(findings.length === 0, `Kubara mini-IDP verification failed:\n- ${findings.join("\n- ")}`);
  return {
    organizationID: controlSpace.OrganizationID,
    spaces: spaceRows,
    units: unitRows,
    preservedControlUnits,
    links: linkRows,
    policy,
    releases,
    applications,
    deploymentAuthority: deploymentAuthority.sort((left, right) => `${left.cluster}/${left.name}`.localeCompare(`${right.cluster}/${right.name}`)),
    argobotAuthority: argobotAuthority.sort((left, right) => left.cluster.localeCompare(right.cluster)),
    applicationSets: applicationSets.sort((left, right) => left.cluster.localeCompare(right.cluster)),
    protectedNamespaces,
    kindTraefik,
    deliveryRuntimes,
    scenario,
    secretWiring,
    liveMatrix,
    finalConfigHubFingerprint: bulkSnapshots.canonicalFingerprint,
    performance: measuredPerformance,
    clusters: FLEET.map((item) => ({
      name: item.cluster,
      environment: item.environment,
      region: item.region,
      kind: localClusters.has(item.cluster),
      kubeconfig: existsSync(clusterKubeconfig(item.cluster)),
      targetID: targets.get(item.cluster)?.TargetID ?? null,
      spaceID: spaces.get(item.cluster)?.SpaceID ?? null,
      appsSpaceID: spaces.get(`${item.cluster}-argo-apps`)?.SpaceID ?? null,
    })),
    actionCount: state?.actions.length ?? 0,
  };
  } finally {
    if (activeVerificationReadSnapshot === verificationReadSnapshot) activeVerificationReadSnapshot = null;
  }
}

function observeProtectedNamespacePostconditions(findings) {
  const rows = [];
  const observedAt = new Date().toISOString();
  for (const contract of PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS) {
    try {
      const retained = readProtectedNamespace(contract.cluster, contract.retainedNamespace);
      const replacement = readProtectedNamespace(contract.cluster, contract.replacementNamespace);
      check(retained, `${contract.migrationID}: protected Namespace/${contract.retainedNamespace} is missing`);
      check(replacement, `${contract.migrationID}: replacement Namespace/${contract.replacementNamespace} is missing`);
      const classification = classifyProtectedNamespaceOwnership(contract, retained, replacement);
      check(
        classification.state === "already-detached",
        `${contract.migrationID}: obsolete Kubara ownership still claims protected Namespace/${contract.retainedNamespace}`,
      );
      const row = {
        migrationID: contract.migrationID,
        cluster: contract.cluster,
        application: `${contract.cluster}/${contract.application}`,
        namespace: contract.retainedNamespace,
        replacementNamespace: contract.replacementNamespace,
        sourceUnit: `${contract.spaceSlug}/${contract.unitSlug}`,
        uid: classification.retainedUID,
        replacementUID: classification.replacementUID,
        state: "retained-clean",
        phase: retained.status?.phase,
        ownershipFieldsAbsent: true,
        replacementTrackingID: contract.replacementTrackingID,
        replacementOriginRevision: classification.replacementOrigin.revisionNum,
        observedAt,
      };
      assertProtectedNamespaceCurrentObservation(
        row,
        contract,
        `${contract.migrationID}: live protected Namespace postcondition`,
      );
      rows.push(row);
    } catch (error) {
      findings.push(error.message);
    }
  }
  return rows;
}

function observeKindTraefikLive(findings) {
  let dockerByCluster = new Map();
  try {
    dockerByCluster = new Map(
      observeKindTraefikDockerBindings().map((item) => [item.cluster, item]),
    );
  } catch (error) {
    findings.push(error.message);
  }
  const rows = [];
  const observedAt = new Date().toISOString();
  for (const contract of KIND_TRAEFIK_CONTRACTS) {
    try {
      const result = kubectlTry(contract.cluster, [
        "get",
        "service,deployment,ingress.networking.k8s.io,certificate.cert-manager.io",
        "-A", "-o", "json",
      ]);
      check(result.ok, `${contract.cluster}: cannot read the live Traefik/application endpoint contract: ${result.output}`);
      const liveObjects = JSON.parse(result.output);
      const evidence = assertKindTraefikLiveObjects(contract, liveObjects);
      const argocdServer = assertArgocdServerNodePortEvidence(contract, liveObjects);
      const docker = dockerByCluster.get(contract.cluster);
      check(docker, `${contract.cluster}: Docker NodePort evidence is missing`);
      const probes = evidence.applications.map((application) => {
        const host = `${application.id}.local`;
        const url = `http://127.0.0.1:${contract.httpNodePort}/`;
        const probe = tryCommand("curl", [
          "--noproxy", "*",
          "--silent", "--show-error", "--fail",
          "--connect-timeout", "3", "--max-time", "15",
          "--output", "/dev/null", "--write-out", "%{http_code}",
          "--header", `Host: ${host}`,
          url,
        ], { timeout: 20_000 });
        check(probe.ok, `${contract.cluster}/${application.id}: NodePort probe failed: ${probe.output}`);
        const statusCode = probe.output.trim();
        check(statusCode === "200", `${contract.cluster}/${application.id}: NodePort probe returned HTTP ${statusCode || "unknown"}`);
        return { application: application.id, hostHeader: host, url, statusCode: 200 };
      });
      rows.push({ ...evidence, argocdServer, docker, probes, observedAt });
    } catch (error) {
      findings.push(error.message);
    }
  }
  return rows;
}

function assertArgocdServerNodePortEvidence(contract, resources) {
  return assertArgocdServerNodePortEvidenceShape(contract, resources, { requireReserved: true });
}

function assertArgocdServerNodePortEvidenceShape(contract, resources, { requireReserved = false } = {}) {
  const objects = Array.isArray(resources?.items) ? resources.items : Array.isArray(resources) ? resources : [];
  const matches = objects.filter((item) => item?.apiVersion === "v1"
    && item?.kind === "Service"
    && item?.metadata?.namespace === "argocd"
    && item?.metadata?.name === "argocd-server");
  check(matches.length === 1, `${contract.cluster}: expected one live argocd/argocd-server Service, found ${matches.length}`);
  const service = matches[0];
  check(service.spec?.type === "NodePort", `${contract.cluster}: argocd-server Service is not NodePort`);
  check(UUID_PATTERN.test(service.metadata?.uid ?? ""), `${contract.cluster}: argocd-server Service UID is invalid`);
  check(/^\d+$/.test(service.metadata?.resourceVersion ?? ""), `${contract.cluster}: argocd-server Service resourceVersion is invalid`);
  const ports = (service.spec?.ports ?? []).map((port) => ({
    name: port.name ?? null,
    protocol: port.protocol ?? "TCP",
    port: port.port ?? null,
    targetPort: port.targetPort ?? null,
    nodePort: port.nodePort ?? null,
  }));
  check(ports.length === 1, `${contract.cluster}: argocd-server Service must expose exactly one port`);
  check(
    ports[0].name === "http"
      && ports[0].protocol === "TCP"
      && ports[0].port === 80
      && Number(ports[0].targetPort) === 8080,
    `${contract.cluster}: argocd-server Service port shape drifted`,
  );
  check(Number.isInteger(ports[0].nodePort) && ports[0].nodePort >= 30000 && ports[0].nodePort <= 32767, `${contract.cluster}: argocd-server first NodePort is invalid`);
  if (requireReserved) {
    check(
      ports[0].nodePort === contract.reservedArgocdServerNodePort,
      `${contract.cluster}: argocd-server first NodePort ${ports[0].nodePort ?? "missing"} does not own reserved port ${contract.reservedArgocdServerNodePort}`,
    );
  }
  const assignedNodePorts = ports.map((port) => port.nodePort).filter(Number.isInteger);
  check(new Set(assignedNodePorts).size === assignedNodePorts.length, `${contract.cluster}: argocd-server has duplicate NodePorts`);
  check(
    assignedNodePorts.every((nodePort) => ![contract.httpNodePort, contract.httpsNodePort].includes(nodePort)),
    `${contract.cluster}: argocd-server collides with a Traefik NodePort`,
  );
  return {
    namespace: "argocd",
    name: "argocd-server",
    uid: service.metadata.uid,
    resourceVersion: service.metadata.resourceVersion,
    type: service.spec.type,
    reservedFirstNodePort: contract.reservedArgocdServerNodePort,
    ports,
  };
}

function observeGrafanaSecretWiring(findings) {
  const read = (args, ref) => {
    const result = kubectlTry(DEV.cluster, [...args, "-o", "json"]);
    if (!result.ok) {
      findings.push(`${ref}: missing (${result.output.slice(0, 300)})`);
      return null;
    }
    return JSON.parse(result.output);
  };
  const ready = (resource) => (resource?.status?.conditions ?? []).some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  const store = read(["get", "clustersecretstore", "hx-app-dev-dev"], "ClusterSecretStore/hx-app-dev-dev");
  const externalSecret = read(
    ["get", "externalsecret", "grafana-admin-credentials-es", "-n", "kube-prometheus-stack"],
    "ExternalSecret/kube-prometheus-stack/grafana-admin-credentials-es",
  );
  const secret = read(
    ["get", "secret", "grafana-admin-credentials", "-n", "kube-prometheus-stack"],
    "Secret/kube-prometheus-stack/grafana-admin-credentials",
  );
  const owner = (secret?.metadata?.ownerReferences ?? []).find(
    (item) => item.apiVersion === "external-secrets.io/v1"
      && item.kind === "ExternalSecret"
      && item.name === "grafana-admin-credentials-es"
      && item.controller === true,
  );
  if (store && !ready(store)) findings.push("ClusterSecretStore/hx-app-dev-dev: Ready is not True");
  if (externalSecret && !ready(externalSecret)) findings.push("ExternalSecret/kube-prometheus-stack/grafana-admin-credentials-es: Ready is not True");
  if (externalSecret?.spec?.secretStoreRef?.kind !== "ClusterSecretStore" || externalSecret?.spec?.secretStoreRef?.name !== "hx-app-dev-dev") {
    findings.push("ExternalSecret/kube-prometheus-stack/grafana-admin-credentials-es: store reference drifted");
  }
  if (externalSecret?.spec?.target?.name !== "grafana-admin-credentials" || externalSecret?.spec?.target?.creationPolicy !== "Owner") {
    findings.push("ExternalSecret/kube-prometheus-stack/grafana-admin-credentials-es: target contract drifted");
  }
  if (secret && !owner) findings.push("Secret/kube-prometheus-stack/grafana-admin-credentials: ESO owner reference missing");
  for (const key of ["admin-user", "admin-password"]) {
    if (secret && !secret.data?.[key]) findings.push(`Secret/kube-prometheus-stack/grafana-admin-credentials: ${key} data missing`);
  }
  return {
    cluster: DEV.cluster,
    store: { name: "hx-app-dev-dev", ready: ready(store) },
    externalSecret: {
      namespace: "kube-prometheus-stack",
      name: "grafana-admin-credentials-es",
      ready: ready(externalSecret),
      storeRef: externalSecret?.spec?.secretStoreRef ?? null,
      target: externalSecret?.spec?.target?.name ?? null,
    },
    secret: {
      namespace: "kube-prometheus-stack",
      name: "grafana-admin-credentials",
      ownerKind: owner?.kind ?? null,
      ownerName: owner?.name ?? null,
      keysPresent: ["admin-user", "admin-password"].filter((key) => Boolean(secret?.data?.[key])).sort(),
    },
  };
}

function verifyPolicy(desired, findings, authoritativeSpaces = readSpaces()) {
  const triggerResult = cubTry(["trigger", "get", "--space", CONTROL_SPACE, APPROVAL_TRIGGER, "-o", "json"]);
  const filterResult = cubTry(["filter", "get", "--space", CONTROL_SPACE, APPROVAL_FILTER, "-o", "json"]);
  if (!triggerResult.ok) findings.push(`${CONTROL_SPACE}/${APPROVAL_TRIGGER}: Trigger missing`);
  if (!filterResult.ok) findings.push(`${CONTROL_SPACE}/${APPROVAL_FILTER}: Filter missing`);
  if (!triggerResult.ok || !filterResult.ok) return {};
  const trigger = unwrapEntity(JSON.parse(triggerResult.output), "Trigger");
  const filter = unwrapEntity(JSON.parse(filterResult.output), "Filter");
  const triggerArgumentsExact = stableJson(trigger.Arguments ?? []) === stableJson([
    { ParameterName: "num-approvers", Value: "1" },
  ]);
  if (
    trigger.FunctionName !== "vet-approvedby"
    || trigger.Event !== "Mutation"
    || trigger.ToolchainType !== "Kubernetes/YAML"
    || !triggerArgumentsExact
    || trigger.Disabled === true
    || trigger.Validating !== true
    || Number(trigger.FailOpenAfter ?? 0) !== 0
  ) findings.push(`${CONTROL_SPACE}/${APPROVAL_TRIGGER}: Trigger definition drifted`);
  if (filter.From !== "Trigger" || filter.Where !== "Space.Slug = 'hx-platform' AND FunctionName = 'vet-approvedby'") findings.push(`${CONTROL_SPACE}/${APPROVAL_FILTER}: Filter definition drifted`);
  const productionSpaces = desired.spaces.filter((item) => item.prodProtected).map((item) => item.slug).sort();
  for (const slug of productionSpaces) {
    const space = authoritativeSpaces.get(slug);
    if (!space) {
      findings.push(`${slug}: production Space missing from authoritative snapshot`);
      continue;
    }
    if (space.TriggerFilterID !== filter.FilterID) findings.push(`${slug}: production approval Filter not attached`);
    if (stableJson([...(space.TriggerIDs ?? [])].sort()) !== stableJson([trigger.TriggerID])) findings.push(`${slug}: approval Trigger selection is not exact`);
  }
  return {
    trigger: {
      ref: `${CONTROL_SPACE}/${APPROVAL_TRIGGER}`,
      id: trigger.TriggerID,
      function: trigger.FunctionName,
      arguments: trigger.Arguments,
    },
    filter: {
      ref: `${CONTROL_SPACE}/${APPROVAL_FILTER}`,
      id: filter.FilterID,
      where: filter.Where,
    },
    productionSpaces,
    gate: APPROVAL_GATE,
    deleteDestroyGate: PROD_SAFETY_GATE,
  };
}

function verifyLinks(desired, findings) {
  const rows = [];
  const spacesForLinkVerification = readSpaces();
  for (const expected of desired.links) {
    const live = readLinks(expected.space).find((item) => item.Slug === expected.slug);
    if (!live) {
      findings.push(`${expected.space}/${expected.slug}: NeedsProvides Link missing`);
      continue;
    }
    const from = readUnit(expected.space, expected.fromUnit);
    const to = readUnit(expected.toSpace, expected.toUnit);
    const toSpace = spacesForLinkVerification.get(expected.toSpace);
    if (!from || !to || !toSpace || live.FromUnitID !== from.UnitID || live.ToUnitID !== to.UnitID || live.ToSpaceID !== toSpace.SpaceID) findings.push(`${expected.space}/${expected.slug}: Link endpoint drifted`);
    if (live.UpdateType !== "NeedsProvides") findings.push(`${expected.space}/${expected.slug}: UpdateType=${live.UpdateType}`);
    if (live.AutoUpdate === true) findings.push(`${expected.space}/${expected.slug}: AutoUpdate must be false`);
    if (!mapMatches(live.Labels, expected.labels)) findings.push(`${expected.space}/${expected.slug}: semantic Link labels drifted`);
    for (const key of staleOwnedLinkLabels(live.Labels, expected.labels)) findings.push(`${expected.space}/${expected.slug}: stale owned Link label ${key}`);
    if (live.Annotations?.[LINK_REASON_ANNOTATION] !== expected.reason) findings.push(`${expected.space}/${expected.slug}: wiring reason drifted`);
    rows.push({
      ref: `${expected.space}/${expected.slug}`,
      id: live.LinkID,
      from: `${expected.space}/${expected.fromUnit}`,
      to: `${expected.toSpace}/${expected.toUnit}`,
      updateType: live.UpdateType,
      autoUpdate: live.AutoUpdate === true,
      reason: expected.reason,
      labels: expected.labels,
    });
  }
  return rows;
}

function readApplicationInventory(cluster) {
  const payload = JSON.parse(kubectl(cluster, [
    "get", "applications.argoproj.io", "-A", "-o", "json",
  ]));
  const applications = payload.items ?? [];
  const foreignNamespaceApplications = applications
    .filter((app) => app.metadata?.namespace !== "argocd")
    .map((app) => `${app.metadata?.namespace ?? "missing"}/${app.metadata?.name ?? "unknown"}`)
    .sort();
  check(
    foreignNamespaceApplications.length === 0,
    `${cluster}: managed authority forbids Application CRs outside argocd; observed ${foreignNamespaceApplications.join(", ")}`,
  );
  const inventory = new Map();
  for (const app of applications) {
    const name = app.metadata?.name;
    check(name && !inventory.has(name), `${cluster}/argocd/${name ?? "unknown"}: duplicate Application identity in cluster-wide inventory`);
    inventory.set(name, app);
  }
  return inventory;
}

function readApplication(cluster, name, inventory = null) {
  let value = inventory?.get(name) ?? null;
  if (!value && !inventory) {
    const result = kubectlTry(cluster, ["get", "application", name, "-n", "argocd", "-o", "json"]);
    if (!result.ok) return { exists: false, sync: "Unknown", health: "Unknown", revision: "Unknown", targetRevision: null, automatedSyncDisabled: false, activeOperation: false, operationPhase: "Unknown", applicationSetOwnerAbsent: false, conditions: [result.output.slice(0, 500)] };
    value = JSON.parse(result.output);
  }
  if (!value) return { exists: false, sync: "Unknown", health: "Unknown", revision: "Unknown", targetRevision: null, automatedSyncDisabled: false, activeOperation: false, operationPhase: "Unknown", applicationSetOwnerAbsent: false, conditions: ["Application missing from exact cluster inventory"] };
  const operationPhase = value.status?.operationState?.phase ?? "Unknown";
  return {
    exists: true,
    sync: value.status?.sync?.status ?? "Unknown",
    health: value.status?.health?.status ?? "Unknown",
    revision: value.status?.sync?.revision ?? "Unknown",
    repoURL: value.spec?.source?.repoURL ?? null,
    targetRevision: value.spec?.source?.targetRevision ?? null,
    automatedSyncDisabled: !value.spec?.syncPolicy?.automated,
    activeOperation: Boolean(value.operation) || ["Running", "Terminating"].includes(operationPhase),
    operationPhase,
    applicationSetOwnerAbsent: !(value.metadata?.ownerReferences ?? []).some((owner) => owner?.kind === "ApplicationSet"),
    conditions: (value.status?.conditions ?? []).map((item) => ({ type: item.type, message: item.message })),
  };
}

function observeLiveMatrix(inputs, desired, applicationRows, deliveryRuntimeRows = []) {
  const applicationsByRef = new Map(applicationRows.map((item) => [`${item.cluster}/${item.name}`, item]));
  const deliveryRuntimeByCluster = new Map(deliveryRuntimeRows.map((item) => [item.cluster, item]));
  const componentDefinitions = [
    matrixComponent("argo-cd", EXPECTED_VERSIONS["argo-cd"], FLEET, [], { departure: "configHub-owned-argo-substitutes-kubara-wrapper", appNames: () => [], runtimeObserved: true }),
    matrixComponent("cert-manager", EXPECTED_VERSIONS["cert-manager"], FLEET, ["hx-cm"], { releaseInstance: "cert-manager", departure: "kind-self-signed-cluster-issuer" }),
    matrixComponent("external-secrets", EXPECTED_VERSIONS["external-secrets"], [DEV], ["hx-eso", "hx-eso-store", "hx-eso-grafana-es"], { releaseInstance: "external-secrets", departure: "kind-fake-provider-target-fact" }),
    matrixComponent("homer-dashboard", EXPECTED_VERSIONS["homer-dashboard"], [DEV], ["hx-homer"], { releaseInstance: "homer-dashboard" }),
    matrixComponent("kube-prometheus-stack", `${EXPECTED_VERSIONS["kube-prometheus-stack"]} + blackbox ${EXPECTED_VERSIONS["prometheus-blackbox-exporter"]}`, [DEV], ["hx-kps-crds", "hx-eso-grafana-es", "hx-kps-main"], { releaseInstance: "kube-prometheus-stack", departure: "crds-and-eso-secret-wiring-are-explicit-spaces" }),
    matrixComponent("metrics-server", EXPECTED_VERSIONS["metrics-server"], [DEV], ["hx-metrics"], { releaseInstance: "metrics-server" }),
    matrixComponent("traefik", EXPECTED_VERSIONS.traefik, FLEET, ["hx-traefik"], { releaseInstance: "traefik", departure: "kind-nodeport-with-configured-ingress-status" }),
    matrixComponent("hx-web", "digest-pinned fixture", FLEET, ["hx-web"], { namespace: "hx-web", departureFor: (item) => item.suffix === "staging" ? "staging-sandbox-url" : item.suffix === "prod-a" ? "one-target-rollback-replicas-2" : "none" }),
    matrixComponent("cubbychat", readYaml(absolute(paths.appSourceLock)).spec?.cubbychat?.upstream?.commit ?? "digest-pinned fixture", FLEET, ["hx-cubbychat"], { namespace: "cubbychat" }),
  ];
  const rows = [];
  for (const fleetItem of FLEET) {
    const workloads = clusterWorkloads(fleetItem.cluster);
    for (const component of componentDefinitions) {
      const selected = component.targets.some((item) => item.cluster === fleetItem.cluster);
      if (!selected) {
        rows.push({
          cluster: fleetItem.cluster,
          environment: fleetItem.environment,
          region: fleetItem.region,
          component: component.name,
          desiredVersion: component.desiredVersion,
          observedVersion: null,
          deliveryState: "not-selected",
          syncState: "NotApplicable",
          healthState: "NotApplicable",
          readiness: { result: "not-applicable", ready: 0, desired: 0 },
          departure: { id: "kubara-config-disabled", reason: "service is disabled for this cluster in the committed Kubara contract" },
          unknownReason: null,
        });
        continue;
      }
      const appNames = component.appNames
        ? component.appNames(fleetItem)
        : component.spacePrefixes.map((prefix) => `${prefix}-${fleetItem.suffix}`);
      const appStates = appNames.map((name) => applicationsByRef.get(`${fleetItem.cluster}/${name}`) ?? (name === "root" ? readApplication(fleetItem.cluster, name) : null)).filter(Boolean);
      const selectedWorkloads = selectComponentWorkloads(workloads, component);
      const readiness = readinessSummary(selectedWorkloads);
      const runtime = component.runtimeObserved ? deliveryRuntimeByCluster.get(fleetItem.cluster) : null;
      const syncState = component.runtimeObserved
        ? runtime?.installedBy === "cub cluster up"
          && runtime.version === ARGO_CD_RUNTIME_VERSION
          && runtime.image === ARGO_CD_RUNTIME_IMAGE
          ? "Synced"
          : "Unknown"
        : appStates.length && appStates.every((item) => item.syncState === "Synced" || item.sync === "Synced")
          ? "Synced"
          : distinct(appStates.map((item) => item.syncState ?? item.sync ?? "Unknown")).join("+") || "Unknown";
      const healthValues = appStates.map((item) => item.healthState ?? item.health ?? "Unknown");
      const healthState = component.runtimeObserved
        ? readiness.result === "pass" ? "Healthy" : readiness.result === "fail" ? "Degraded" : "Unknown"
        : healthValues.length && healthValues.every((item) => item === "Healthy")
          ? "Healthy"
          : distinct(healthValues).join("+") || "Unknown";
      const versions = observedWorkloadVersions(selectedWorkloads);
      const observedVersion = component.runtimeObserved && runtime?.version
        ? runtime.version
        : versions.length ? versions.join(" + ") : null;
      const departureId = component.departureFor?.(fleetItem) ?? component.departure ?? "none";
      const unknownReasons = [];
      if (!observedVersion) unknownReasons.push("selected version is pinned in ConfigHub provenance but not exposed by live workload labels");
      if (readiness.result === "unknown") unknownReasons.push("no matching Deployment, StatefulSet, or DaemonSet exposed readiness for this component");
      rows.push({
        cluster: fleetItem.cluster,
        environment: fleetItem.environment,
        region: fleetItem.region,
        component: component.name,
        desiredVersion: component.desiredVersion,
        observedVersion,
        deliveryState: "delivered",
        syncState,
        healthState,
        readiness,
        departure: departureId === "none" ? null : { id: departureId, reason: departureReason(departureId) },
        unknownReason: unknownReasons.length ? unknownReasons.join("; ") : null,
        evidence: {
          applications: appNames,
          workloadRefs: selectedWorkloads.map(workloadRef),
          ...(runtime ? {
            runtime: {
              installedBy: runtime.installedBy,
              version: runtime.version,
              image: runtime.image,
              references: runtime.references,
            },
          } : {}),
        },
      });
    }
  }
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPLiveMatrixObservation",
    desiredSource: paths.componentArtifacts,
    observationMode: "kubectl-and-confighub-live-read",
    rowCount: rows.length,
    rows,
  };
}

function matrixComponent(name, desiredVersion, targets, spacePrefixes, extra = {}) {
  return { name, desiredVersion, targets, spacePrefixes, ...extra };
}

function clusterWorkloads(cluster) {
  const result = kubectlTry(cluster, ["get", "deployment,statefulset,daemonset", "-A", "-o", "json"]);
  check(result.ok, `${cluster}: unable to read workload readiness: ${result.output}`);
  return JSON.parse(result.output).items ?? [];
}

function selectComponentWorkloads(workloads, component) {
  if (component.namespace) return workloads.filter((item) => item.metadata?.namespace === component.namespace);
  if (component.name === "argo-cd") return workloads.filter((item) => item.metadata?.namespace === "argocd");
  const instance = component.releaseInstance;
  if (!instance) return [];
  return workloads.filter((item) => {
    const labels = {
      ...(item.spec?.template?.metadata?.labels ?? {}),
      ...(item.metadata?.labels ?? {}),
    };
    return labels["app.kubernetes.io/instance"] === instance
      || labels.release === instance
      || labels["app.kubernetes.io/name"] === instance;
  });
}

function readinessSummary(workloads) {
  const statuses = workloads.map((item) => {
    if (item.kind === "Deployment") {
      const desired = item.spec?.replicas ?? 1;
      const ready = item.status?.availableReplicas ?? 0;
      return { ref: workloadRef(item), desired, ready, result: ready >= desired ? "pass" : "fail" };
    }
    if (item.kind === "StatefulSet") {
      const desired = item.spec?.replicas ?? 1;
      const ready = item.status?.readyReplicas ?? 0;
      return { ref: workloadRef(item), desired, ready, result: ready >= desired ? "pass" : "fail" };
    }
    const desired = item.status?.desiredNumberScheduled ?? 0;
    const ready = item.status?.numberReady ?? 0;
    return { ref: workloadRef(item), desired, ready, result: desired > 0 && ready >= desired ? "pass" : "fail" };
  });
  return {
    result: statuses.length === 0 ? "unknown" : statuses.every((item) => item.result === "pass") ? "pass" : "fail",
    ready: statuses.reduce((sum, item) => sum + item.ready, 0),
    desired: statuses.reduce((sum, item) => sum + item.desired, 0),
    workloads: statuses,
  };
}

function workloadRef(item) {
  return `${item.kind}/${item.metadata?.namespace ?? ""}/${item.metadata?.name ?? ""}`;
}

function observedWorkloadVersions(workloads) {
  const labels = [];
  for (const item of workloads) {
    const workloadLabels = {
      ...(item.spec?.template?.metadata?.labels ?? {}),
      ...(item.metadata?.labels ?? {}),
    };
    if (workloadLabels["helm.sh/chart"]) labels.push(workloadLabels["helm.sh/chart"]);
    else if (workloadLabels["app.kubernetes.io/version"]) labels.push(workloadLabels["app.kubernetes.io/version"]);
  }
  if (labels.length) return distinct(labels).sort();
  return distinct(workloads.flatMap((item) => [
    ...(item.spec?.template?.spec?.initContainers ?? []),
    ...(item.spec?.template?.spec?.containers ?? []),
  ].map((container) => container.image))).sort();
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

function departureReason(id) {
  return {
    "configHub-owned-argo-substitutes-kubara-wrapper": `ConfigHub takes the hub role; each cluster keeps its local bootstrap Argo ${ARGO_CD_RUNTIME_VERSION}, explicitly separate from Kubara chart ${EXPECTED_VERSIONS["argo-cd"]} and its ${KUBARA_ARGO_RUNTIME_VERSION} render.`,
    "kind-self-signed-cluster-issuer": "The reproducible kind lane uses a self-signed ClusterIssuer instead of public ACME.",
    "kind-fake-provider-target-fact": "The demo uses ESO's fake provider; production must select a real backend without changing the wiring contract.",
    "crds-and-eso-secret-wiring-are-explicit-spaces": "CRD lifecycle and Grafana secret production are separately governed and visibly linked.",
    "kind-nodeport-with-configured-ingress-status": "The reproducible kind lane uses declared NodePorts and Traefik's configured cluster hostname, so Ingress status and Argo health converge without a cloud LoadBalancer controller.",
    "staging-sandbox-url": "Staging keeps its SANDBOX_URL departure through the second upstream promotion.",
    "one-target-rollback-replicas-2": "prod-a is intentionally rolled back to two replicas while prod-b remains at three.",
  }[id] ?? id;
}

function sourceEvidence() {
  return Object.fromEntries(Object.entries(paths).map(([name, relative]) => [name, {
    path: relative,
    sha256: existsSync(absolute(relative)) ? `sha256:${sha256File(absolute(relative))}` : null,
  }]));
}

function priorReceiptMatchesCurrentExecution(previous, currentSourceEvidence, observation) {
  if (
    previous?.kind !== "ConfigHubKubaraMiniIDPReconcileReceipt"
      || previous.spec?.organization?.name !== ORGANIZATION
      || previous.spec?.organization?.externalID !== ORGANIZATION_EXTERNAL_ID
      || previous.spec?.organization?.entityID !== observation.organizationID
      || previous.spec?.organization?.serverURL !== CONFIGHUB_SERVER_URL
      || previous.spec?.rolloutScenario?.sourceFingerprint !== scenarioSourceFingerprint()
  ) return false;
  for (const [name, evidence] of Object.entries(currentSourceEvidence)) {
    const stored = previous.spec?.source?.files?.[name];
    if (stored?.path !== evidence.path || stored?.sha256 !== evidence.sha256) return false;
  }
  const previousSpaces = new Map((previous.spec?.spaces ?? []).map((space) => [space.slug, space.id]));
  return observation.spaces.every((space) => previousSpaces.get(space.slug) === space.id)
    && previousSpaces.size === observation.spaces.length;
}

function assertKindTraefikEvidence(rows, prefix = "kind Traefik evidence") {
  check(rows.length === KIND_TRAEFIK_CONTRACTS.length, `${prefix}: four-cluster evidence is incomplete`);
  const byCluster = new Map(rows.map((item) => [item.cluster, item]));
  check(byCluster.size === rows.length, `${prefix}: cluster rows are duplicated`);
  for (const contract of KIND_TRAEFIK_CONTRACTS) {
    const row = byCluster.get(contract.cluster);
    check(row, `${prefix}: ${contract.cluster} row is missing`);
    check(row.hostname === contract.hostname, `${prefix}: ${contract.cluster} hostname drifted`);
    check(row.httpNodePort === contract.httpNodePort, `${prefix}: ${contract.cluster} HTTP NodePort drifted`);
    check(row.httpsNodePort === contract.httpsNodePort, `${prefix}: ${contract.cluster} HTTPS NodePort drifted`);
    check(
      row.argocdServer?.namespace === "argocd"
        && row.argocdServer?.name === "argocd-server"
        && row.argocdServer?.type === "NodePort",
      `${prefix}: ${contract.cluster} argocd-server Service identity drifted`,
    );
    check(UUID_PATTERN.test(row.argocdServer?.uid ?? ""), `${prefix}: ${contract.cluster} argocd-server Service UID is invalid`);
    check(/^\d+$/.test(row.argocdServer?.resourceVersion ?? ""), `${prefix}: ${contract.cluster} argocd-server resourceVersion is invalid`);
    check(
      row.argocdServer?.reservedFirstNodePort === contract.reservedArgocdServerNodePort
        && row.argocdServer?.ports?.[0]?.nodePort === contract.reservedArgocdServerNodePort,
      `${prefix}: ${contract.cluster} argocd-server does not own its reserved first NodePort`,
    );
    check(
      (row.argocdServer?.ports ?? []).every((port) => ![contract.httpNodePort, contract.httpsNodePort].includes(port.nodePort)),
      `${prefix}: ${contract.cluster} argocd-server collides with Traefik`,
    );
    check(row.service?.namespace === contract.namespace && row.service?.name === contract.serviceName, `${prefix}: ${contract.cluster} Service identity drifted`);
    check(row.service?.type === "NodePort", `${prefix}: ${contract.cluster} Service type drifted`);
    check(UUID_PATTERN.test(row.service?.uid ?? ""), `${prefix}: ${contract.cluster} Service UID is invalid`);
    check(typeof row.service?.clusterIP === "string" && row.service.clusterIP.length > 0, `${prefix}: ${contract.cluster} Service clusterIP is missing`);
    check(stableJson(row.service?.ports) === stableJson(contract.ports), `${prefix}: ${contract.cluster} Service ports drifted`);
    check(stableJson(row.service?.loadBalancerIngress) === "[]", `${prefix}: ${contract.cluster} stale LoadBalancer status remains`);
    check(row.deployment?.namespace === contract.namespace && row.deployment?.name === contract.deploymentName, `${prefix}: ${contract.cluster} Deployment identity drifted`);
    check(UUID_PATTERN.test(row.deployment?.uid ?? ""), `${prefix}: ${contract.cluster} Deployment UID is invalid`);
    check(row.deployment?.endpointArgument === contract.endpointArgument, `${prefix}: ${contract.cluster} endpoint argument drifted`);
    check(stableJson(row.deployment?.publishedServiceArguments) === "[]", `${prefix}: ${contract.cluster} publishedService remains`);
    const applications = new Map((row.applications ?? []).map((item) => [item.id, item]));
    check(applications.size === contract.applications.length, `${prefix}: ${contract.cluster} application endpoint evidence is incomplete`);
    for (const expected of contract.applications) {
      const application = applications.get(expected.id);
      check(application, `${prefix}: ${contract.cluster}/${expected.id} evidence is missing`);
      check(application.ingress?.hostname === contract.hostname, `${prefix}: ${contract.cluster}/${expected.id} Ingress status hostname drifted`);
      check(UUID_PATTERN.test(application.ingress?.uid ?? ""), `${prefix}: ${contract.cluster}/${expected.id} Ingress UID is invalid`);
      check(application.certificate?.ready === true, `${prefix}: ${contract.cluster}/${expected.id} Certificate is not Ready`);
      check(UUID_PATTERN.test(application.certificate?.uid ?? ""), `${prefix}: ${contract.cluster}/${expected.id} Certificate UID is invalid`);
    }
    check(
      stableJson(row.docker?.ports?.map((item) => [item.containerPort, item.hostPort]))
        === stableJson([
          [contract.reservedArgocdServerNodePort, contract.reservedArgocdServerNodePort],
          [contract.httpNodePort, contract.httpNodePort],
          [contract.httpsNodePort, contract.httpsNodePort],
        ]),
      `${prefix}: ${contract.cluster} Docker port bindings drifted`,
    );
    check(row.docker?.node === `${contract.cluster}-control-plane`, `${prefix}: ${contract.cluster} Docker node identity drifted`);
    check(
      row.docker.ports.every((item) => ["0.0.0.0", "127.0.0.1"].includes(item.hostIP)),
      `${prefix}: ${contract.cluster} Docker host binding is not reachable through loopback`,
    );
    const probes = new Map((row.probes ?? []).map((item) => [item.application, item]));
    check(probes.size === contract.applications.length, `${prefix}: ${contract.cluster} application probes are incomplete`);
    for (const expected of contract.applications) {
      const probe = probes.get(expected.id);
      check(
        probe?.hostHeader === `${expected.id}.local`
          && probe.url === `http://127.0.0.1:${contract.httpNodePort}/`
          && probe.statusCode === 200,
        `${prefix}: ${contract.cluster}/${expected.id} probe drifted`,
      );
    }
    check(Number.isFinite(Date.parse(row.observedAt ?? "")), `${prefix}: ${contract.cluster} observedAt is invalid`);
  }
}

function buildReceipt(inputs, desired, observation, state) {
  assertPerformanceEvidence(observation.performance, "live verification performance evidence");
  check(
    /^sha256:[0-9a-f]{64}$/.test(observation.finalConfigHubFingerprint ?? "")
      && observation.finalConfigHubFingerprint === observation.performance.bulkSnapshots.canonicalFingerprint,
    "live verification final ConfigHub fingerprint is missing or performance-unbound",
  );
  check(
    observation.performance.phases.length === 1,
    "live apply performance evidence must include the exact pre-Argo phase",
  );
  assertKindTraefikEvidence(observation.kindTraefik, "live kind Traefik evidence");
  const previous = readPriorReceipt();
  const attemptLedger = readApplyAttemptLedger({ allowMissing: false });
  const applyAttempt = state.applyAttempt;
  const durableAttempt = attemptLedger.attempts.at(-1);
  check(
    applyAttempt
      && durableAttempt?.sequence === applyAttempt.sequence
      && durableAttempt.id === applyAttempt.id
      && durableAttempt.result === "active",
    "refusing receipt construction without the exact active durable apply attempt",
  );
  const currentSourceEvidence = sourceEvidence();
  const trustedPrevious = priorReceiptMatchesCurrentExecution(previous, currentSourceEvidence, observation);
  const currentExecutionFingerprint = operationExecutionFingerprint();
  const previousRuns = trustedPrevious
    ? (previous.spec?.reconcileRuns ?? []).filter(
        (item) => item.executionFingerprint === currentExecutionFingerprint
          && Number.isInteger(item.attemptSequence)
          && UUID_PATTERN.test(item.attemptID ?? "")
          && /^sha256:[0-9a-f]{64}$/.test(item.finalConfigHubFingerprint ?? "")
          && item.performance?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION
          && item.performance?.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID,
      )
    : [];
  const run = {
    observedAt: new Date().toISOString(),
    attemptSequence: applyAttempt.sequence,
    attemptID: applyAttempt.id,
    executionFingerprint: currentExecutionFingerprint,
    actionCount: state.actions.length,
    result: "pass",
    idempotentNoop: state.actions.length === 0,
    finalConfigHubFingerprint: observation.finalConfigHubFingerprint,
    performance: state.runPerformance,
  };
  // Only measured schema-v2 runs belong in reconcileRuns. An operation journal
  // can recover semantic rollout history, but it cannot reconstruct timings or
  // command counts and therefore must never be promoted into performance proof.
  const reconcileRuns = distinctRuns([...previousRuns, run]).slice(-5);
  const [pairChanged, pairNoop] = reconcileRuns.slice(-2);
  const idempotentRerunProven = Boolean(
    pairChanged
      && pairNoop
      && pairChanged.result === "pass"
      && pairNoop.result === "pass"
      && pairChanged.idempotentNoop === false
      && pairChanged.actionCount > 0
      && pairNoop.idempotentNoop === true
      && pairNoop.actionCount === 0
      && pairChanged.executionFingerprint === currentExecutionFingerprint
      && pairNoop.executionFingerprint === currentExecutionFingerprint
      && pairChanged.finalConfigHubFingerprint === pairNoop.finalConfigHubFingerprint
      && pairNoop.finalConfigHubFingerprint === observation.finalConfigHubFingerprint
      && pairChanged.performance?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION
      && pairNoop.performance?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION
      && pairChanged.performance?.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID
      && pairNoop.performance?.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID
      && prospectiveAttemptPairValid(reconcileRuns, attemptLedger, applyAttempt)
      && pairChanged.performance?.runClass === "changed-apply"
      && pairNoop.performance?.runClass === "idempotent-apply"
      && Number.isFinite(Date.parse(pairChanged.observedAt ?? ""))
      && Number.isFinite(Date.parse(pairNoop.observedAt ?? ""))
      && Date.parse(pairChanged.observedAt) < Date.parse(pairNoop.observedAt)
  );
  const deterministicProofMode = idempotentRerunProven
    ? "immediate-changed-then-zero-action-rerun"
    : "pending-immediate-changed-noop-pair";
  const priorScenario = trustedPrevious
    && previous.spec?.rolloutScenario?.version === SCENARIO_VERSION
    && previous.spec?.rolloutScenario?.sourceFingerprint === scenarioSourceFingerprint()
    ? previous.spec.rolloutScenario
    : null;
  const operationSteps = state.scenario.mode === "retained-proven-history" && priorScenario?.steps?.length
    ? priorScenario.steps
    : state.scenario.steps;
  const operationEvidence = state.scenario.mode === "retained-proven-history" && priorScenario?.operationEvidence?.length
    ? priorScenario.operationEvidence
    : state.scenario.operationEvidence ?? state.actions.filter((item) => [
        "variant-promote",
        "approval-gate-observed",
        "unit-approve",
        "rollback",
      ].includes(item.type));
  const scenarioCheckpoints = state.scenarioJournal?.checkpoints ?? priorScenario?.checkpoints ?? [];
  check(
    scenarioOperationProofValid({ checkpoints: scenarioCheckpoints, operationEvidence }),
    "refusing to write a receipt without exact gate observation, approval, and rollback evidence bound to scenario checkpoints",
  );
  const lastChangedActions = state.actions.length > 0
    ? state.actions
    : trustedPrevious ? previous.spec?.lastChangedActions ?? [] : [];
  const namespaceMoveEvidence = [];
  const seenNamespaceMoveUIDs = new Set();
  for (const item of state.namespaceMoveEvidence) {
    const key = `${item.ref ?? ""}/${item.uid ?? ""}`;
    if (seenNamespaceMoveUIDs.has(key)) continue;
    seenNamespaceMoveUIDs.add(key);
    namespaceMoveEvidence.push(item);
  }
  check(namespaceMoveEvidence.length <= 1, "more than one namespace-move DaemonSet prune was retained");
  const immutableSelectorEvidenceByMigration = new Map();
  for (const item of state.immutableSelectorEvidence) {
    const prior = immutableSelectorEvidenceByMigration.get(item.migrationID);
    check(
      !prior || prior.uid === item.uid,
      `${item.migrationID}: retained immutable-selector evidence disagrees on the old workload UID`,
    );
    immutableSelectorEvidenceByMigration.set(item.migrationID, item);
  }
  const immutableSelectorEvidence = allImmutableSelectorReplacements(desired)
    .map(({ migration }) => {
      const migrationID = migration.migrationID;
      const item = immutableSelectorEvidenceByMigration.get(migrationID);
      check(item, `${migrationID}: completed immutable-selector replacement evidence is missing`);
      assertImmutableSelectorReplacementEvidence(item, `${migrationID}: retained immutable-selector replacement`);
      return item;
    });
  const protectedNamespaceEvidenceByMigration = new Map();
  for (const item of state.protectedNamespaceEvidence) {
    const prior = protectedNamespaceEvidenceByMigration.get(item.migrationID);
    check(
      !prior || prior.uid === item.uid,
      `${item.migrationID}: retained protected Namespace evidence disagrees on the Namespace UID`,
    );
    protectedNamespaceEvidenceByMigration.set(item.migrationID, item);
  }
  const protectedNamespaceEvidence = PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.map((contract) => {
    const item = protectedNamespaceEvidenceByMigration.get(contract.migrationID);
    check(item, `${contract.migrationID}: completed ownership-detachment evidence is missing`);
    assertProtectedNamespaceDetachmentEvidence(item, contract);
    const current = observation.protectedNamespaces.find((row) => row.migrationID === contract.migrationID);
    check(current, `${contract.migrationID}: current protected Namespace postcondition is missing`);
    check(current.uid === item.uid, `${contract.migrationID}: retained Namespace UID changed after ownership detachment`);
    return item;
  });
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "ConfigHubKubaraMiniIDPReconcileReceipt",
    metadata: { name: "kubara-v0-13-0-confighub-mini-idp" },
    spec: {
      organization: {
        name: ORGANIZATION,
        externalID: ORGANIZATION_EXTERNAL_ID,
        entityID: observation.organizationID,
        serverURL: CONFIGHUB_SERVER_URL,
      },
      source: {
        kubaraVersion: KUBARA_VERSION,
        catalogVersion: CATALOG_VERSION,
        exactVersionPolicy: "fail-if-missing",
        retentionPolicy: "additive-only",
        files: currentSourceEvidence,
      },
      execution: {
        deterministic: true,
        aiRequired: false,
        mutationGuardConsulted: false,
        destructiveOperations: [ARGO_PRUNE_POLICY, ARGO_NAMESPACE_MOVE_POLICY, IMMUTABLE_SELECTOR_REPLACEMENT_POLICY],
        persistentClustersPreserved: FLEET.map((item) => item.cluster),
        partialClusterStatePolicy: "fail-except-exact-journaled-prefix",
        serialLiveParityLock: true,
        unexpectedSpacePolicy: "fail-outside-exact-55-space-allowlist",
        unexpectedManagedUnitOrLinkPolicy: "fail",
        preservedControlUnitPolicy: "exact-receipt-bound-faithful-proof-units",
        interruptedScenarioPolicy: INTERRUPTED_SCENARIO_POLICY,
        interruptedReleasePolicy: INTERRUPTED_RELEASE_POLICY,
        publishedReleaseSelectionPolicy: PUBLISHED_RELEASE_SELECTION_POLICY,
        deliveryRootPublicationPolicy: DELIVERY_ROOT_PUBLICATION_POLICY,
        receiptRequiresZeroActionRerun: true,
        performance: observation.performance,
        cub: cachedCubVersions,
        delivery: `ConfigHub variant/OCI -> ConfigHub cluster-bootstrap Argo CD ${ARGO_CD_RUNTIME_VERSION}/argobot`,
        argoApplicationContract: "allowlisted ConfigHub OCI source -> cluster-local API + Kubara destination namespace",
        argoRetryPolicy: ARGO_RETRY_POLICY,
        argoPrunePolicy: ARGO_PRUNE_POLICY,
        argoNamespaceMovePolicy: ARGO_NAMESPACE_MOVE_POLICY,
        immutableSelectorReplacementPolicy: IMMUTABLE_SELECTOR_REPLACEMENT_POLICY,
        immutableSelectorFailureEvidencePolicy: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY,
        immutableSelectorFailureEvidenceEffectiveAt: IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_EFFECTIVE_AT,
        protectedNamespaceOwnershipPolicy: PROTECTED_NAMESPACE_OWNERSHIP_POLICY,
        kindTraefikPolicy: KIND_TRAEFIK_POLICY,
        argoRevisionPolicy: ARGO_REVISION_POLICY,
        guiIdentityPolicy: GUI_IDENTITY_POLICY,
        topologyClaim: "ConfigHub takes the hub role; every cluster keeps a local reconciler",
      },
      finalConfigHubSnapshot: {
        canonicalization: "stable-recursive-key-order-and-entity-row-order",
        fingerprintAlgorithm: "sha256",
        resources: [...FINAL_CONFIGHUB_FINGERPRINT_RESOURCES],
        fingerprint: run.finalConfigHubFingerprint,
        sourceRunAttemptID: run.attemptID,
        sourceRunClass: run.idempotentNoop ? "idempotent-apply" : "changed-apply",
      },
      counts: {
        spaces: observation.spaces.length,
        managedUnits: observation.units.length,
        preservedFaithfulControlUnits: observation.preservedControlUnits.length,
        deployments: desired.deployments.length,
        deliveryApplicationUnits: desired.deployments.length + (FLEET.length * 2),
        deploymentAuthorityApplications: observation.deploymentAuthority.length,
        protectedNamespaceOwnershipDetachments: protectedNamespaceEvidence.length,
        immutableSelectorReplacements: immutableSelectorEvidence.length,
        kindTraefikContracts: observation.kindTraefik.length,
        releases: observation.releases.length,
        needsProvidesLinks: observation.links.length,
        liveMatrixRows: observation.liveMatrix.rowCount,
      },
      clusters: observation.clusters,
      controls: observation.units.filter((item) => item.ref.startsWith(`${CONTROL_SPACE}/`)),
      preservedControlUnits: observation.preservedControlUnits,
      namespaceMovePrunes: namespaceMoveEvidence,
      immutableSelectorReplacements: immutableSelectorEvidence,
      protectedNamespaceOwnershipDetachments: protectedNamespaceEvidence,
      protectedNamespaceOwnershipCurrent: observation.protectedNamespaces,
      kindTraefik: observation.kindTraefik,
      spaces: observation.spaces,
      units: observation.units,
      releases: observation.releases,
      applications: observation.applications,
      deploymentAuthority: {
        scope: "managed-automated-path; privileged human or external-controller Argo sync remains outside this proof unless separately constrained by RBAC or admission",
        policy: "targetRevision latest is discovery-only; automated sync absent; no active operation; no ApplicationSet regeneration; ConfigHub revalidates the exact release and submits operation.sync.revision=ManifestDigest with Kubernetes UID/resourceVersion CAS",
        applications: observation.deploymentAuthority,
        argobot: observation.argobotAuthority,
        applicationSets: observation.applicationSets,
      },
      deliveryRuntimes: observation.deliveryRuntimes,
      deliveryApplicationUnits: plannedDeliveryApplicationIdentity(desired),
      guiNavigation: {
        scope: "identity-and-navigation-only",
        startHereSpace: CONTROL_SPACE,
        startHereControlUnits: [...START_HERE_CONTROL_UNITS].sort(),
        publicURLs: PUBLIC_NAVIGATION_ANNOTATIONS,
        ownedSpaceLabels: [...OWNED_SPACE_LABELS].sort(),
        ownedUnitLabels: [...OWNED_UNIT_LABELS].sort(),
        ownedLinkLabels: [...OWNED_LINK_LABELS].sort(),
        declaredNeedsProvidesLinks: observation.links.length,
        completeWiringGraphClaim: false,
        liveHealthClaim: false,
      },
      wiring: {
        sourceLedger: paths.wiring,
        updateType: "NeedsProvides",
        autoUpdate: false,
        links: observation.links,
        grafanaSecret: observation.secretWiring,
      },
      policy: observation.policy,
      rolloutScenario: {
        version: SCENARIO_VERSION,
        sourceFingerprint: scenarioSourceFingerprint(),
        mode: state.scenario.mode,
        steps: operationSteps,
        operationEvidence,
        checkpoints: scenarioCheckpoints,
        finalChecks: observation.scenario,
        claims: {
          basePromotion: "pass",
          productionApproval: "pass",
          oneProductionRollback: "pass",
          stagingDepartureSurvivedPromotion: "pass",
        },
      },
      liveMatrix: observation.liveMatrix,
      reconcileRuns,
      deterministicProofMode,
      lastActions: state.actions,
      lastChangedActions,
    },
    status: {
      result: idempotentRerunProven ? "pass" : "pending-idempotence",
      observedAt: run.observedAt,
      cleanRoomReproducible: false,
      cleanRoomClaim: "not asserted from this retained-org run; offline clean-room ordering is gated separately",
      deterministicReconciliationProven: idempotentRerunProven,
      idempotentRerunProven,
      fullCurrentSelectionDelivered: true,
      applicationsDelivered: ["hx-web", "cubbychat"],
      historicalCatalogRootsPreserved: true,
      limits: [
        "This is the adapted ConfigHub lane. The separate faithful-lane receipt proves Kubara's one-hub Argo topology against a spoke.",
        `ConfigHub cluster-bootstrap Argo CD ${ARGO_CD_RUNTIME_VERSION} and argobot replace Kubara's selected Argo chart ${EXPECTED_VERSIONS["argo-cd"]} (runtime ${KUBARA_ARGO_RUNTIME_VERSION}) in the adapted lane; the cluster-local reconciliation shape remains.`,
        "The kind proof uses a self-signed issuer and ESO's fake provider with demo credentials. Production adoption must select public/private PKI and a real secret backend.",
        "cub cluster up rolls back returned failures, but an abrupt process or host termination inside that multi-system command is fail-closed rather than automatically repaired; the reconciler resumes only fully complete journaled cluster prefixes and never deletes a partial persistent cluster.",
        "The reconciler replays promotion/rollback/departure history only for a clean or unmarked hx-web tree; marked reruns verify and reconcile the deterministic final state.",
      ],
    },
  };
}

function distinctRuns(runs) {
  const seen = new Set();
  return runs.filter((run) => {
    const key = `${run.attemptSequence ?? ""}/${run.attemptID ?? ""}/${run.executionFingerprint ?? ""}/${run.finalConfigHubFingerprint ?? ""}/${run.observedAt ?? ""}/${run.actionCount ?? ""}/${run.idempotentNoop ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertReceiptLinkEvidence(rows, expectedLinks) {
  check(rows.length === expectedLinks.length, "receipt Link rows are incomplete");
  const rowsByRef = new Map();
  for (const row of rows) {
    check(!rowsByRef.has(row.ref), `${row.ref}: receipt contains a duplicate Link`);
    rowsByRef.set(row.ref, row);
  }
  for (const expected of expectedLinks) {
    const ref = `${expected.space}/${expected.slug}`;
    const row = rowsByRef.get(ref);
    check(row, `receipt is missing Link ${ref}`);
    check(UUID_PATTERN.test(row.id ?? ""), `${ref}: receipt Link ID missing`);
    check(row.updateType === "NeedsProvides" && row.autoUpdate === false, `${ref}: receipt Link semantics drifted`);
    check(row.from === `${expected.space}/${expected.fromUnit}`, `${ref}: receipt downstream endpoint drifted`);
    check(row.to === `${expected.toSpace}/${expected.toUnit}`, `${ref}: receipt upstream endpoint drifted`);
    check(row.reason === expected.reason, `${ref}: receipt wiring reason drifted`);
    check(stableJson(row.labels) === stableJson(expected.labels), `${ref}: receipt Link identity labels drifted`);
  }

  for (const item of FLEET) {
    const workload = rowsByRef.get(`hx-web-${item.suffix}/needs-platform-binding`);
    check(
      workload?.from === `hx-web-${item.suffix}/hx-web-deployment`
        && workload.to === `hx-web-platform-${item.suffix}/hx-web-platform`,
      `${item.cluster}: receipt must visibly bind hx-web to its reviewed platform Certificate/Ingress Unit`,
    );
    const certificate = rowsByRef.get(`hx-web-platform-${item.suffix}/needs-cert-manager`);
    check(
      certificate?.from === `hx-web-platform-${item.suffix}/hx-web-platform`
        && certificate.to === `hx-cm-${item.suffix}/hx-cm`,
      `${item.cluster}: receipt must visibly bind hx-web platform wiring to cert-manager`,
    );
    const ingress = rowsByRef.get(`hx-web-platform-${item.suffix}/needs-traefik`);
    check(
      ingress?.from === `hx-web-platform-${item.suffix}/hx-web-platform`
        && ingress.to === `hx-traefik-${item.suffix}/hx-traefik`,
      `${item.cluster}: receipt must visibly bind hx-web platform wiring to traefik`,
    );
  }
}

function verifyReceipt(inputs, desired) {
  check(existsSync(RECEIPT_PATH), `${relativeRepo(RECEIPT_PATH)} is missing; run --apply after all live prerequisites pass`);
  const receipt = readYaml(RECEIPT_PATH);
  assertAttemptLedgerCurrentForReceipt(receipt);
  check(receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", "mini-IDP receipt kind drifted");
  check(receipt.spec?.organization?.name === ORGANIZATION, "mini-IDP receipt organization drifted");
  check(receipt.spec?.organization?.externalID === ORGANIZATION_EXTERNAL_ID, "mini-IDP receipt organization external ID drifted");
  check(receipt.spec?.organization?.entityID === ORGANIZATION_ENTITY_ID, "mini-IDP receipt organization entity ID drifted");
  check(receipt.spec?.organization?.serverURL === CONFIGHUB_SERVER_URL, "mini-IDP receipt ConfigHub server drifted");
  check(receipt.spec?.source?.kubaraVersion === KUBARA_VERSION, "mini-IDP receipt Kubara version drifted");
  check(receipt.spec?.source?.catalogVersion === CATALOG_VERSION, "mini-IDP receipt catalog version drifted");
  check(receipt.spec?.source?.exactVersionPolicy === "fail-if-missing", "mini-IDP exact-version policy drifted");
  check(receipt.spec?.source?.retentionPolicy === "additive-only", "mini-IDP retention policy drifted");
  for (const [name, evidence] of Object.entries(sourceEvidence())) {
    const stored = receipt.spec?.source?.files?.[name];
    check(stored?.path === evidence.path, `mini-IDP receipt source path ${name} drifted`);
    check(stored?.sha256 === evidence.sha256, `mini-IDP receipt source digest ${name} is stale`);
  }
  check(
    !Object.values(receipt.spec?.source?.files ?? {}).some((item) => item?.path === MATRIX_PUBLICATION_PATH),
    `mini-IDP receipt must not source-digest receipt-derived publication ${MATRIX_PUBLICATION_PATH}`,
  );
  check(receipt.spec?.execution?.deterministic === true, "mini-IDP receipt must declare deterministic execution");
  check(receipt.spec?.execution?.aiRequired === false, "AI must not be required for mini-IDP reconciliation");
  check(receipt.spec?.execution?.mutationGuardConsulted === false, "mutation guard should remain outside this explicitly authorized reconciler");
  assertPerformanceEvidence(receipt.spec?.execution?.performance, "mini-IDP receipt performance evidence");
  const finalConfigHubSnapshot = receipt.spec?.finalConfigHubSnapshot ?? {};
  check(
    finalConfigHubSnapshot.canonicalization === "stable-recursive-key-order-and-entity-row-order"
      && finalConfigHubSnapshot.fingerprintAlgorithm === "sha256"
      && stableJson(finalConfigHubSnapshot.resources) === stableJson(FINAL_CONFIGHUB_FINGERPRINT_RESOURCES)
      && /^sha256:[0-9a-f]{64}$/.test(finalConfigHubSnapshot.fingerprint ?? "")
      && finalConfigHubSnapshot.fingerprint === receipt.spec.execution.performance.bulkSnapshots.canonicalFingerprint,
    "mini-IDP receipt final ConfigHub snapshot is missing or performance-unbound",
  );
  check(
    receipt.spec.execution.performance.phases.length === 1,
    "mini-IDP receipt must retain the exact apply-start-to-first-Argo-convergence performance phase",
  );
  check(
    stableJson(receipt.spec?.execution?.destructiveOperations)
      === stableJson([ARGO_PRUNE_POLICY, ARGO_NAMESPACE_MOVE_POLICY, IMMUTABLE_SELECTOR_REPLACEMENT_POLICY]),
    "mini-IDP receipt Argo prune boundary drifted",
  );
  check(receipt.spec?.execution?.argoPrunePolicy === ARGO_PRUNE_POLICY, "mini-IDP receipt Argo prune policy drifted");
  check(receipt.spec?.execution?.argoNamespaceMovePolicy === ARGO_NAMESPACE_MOVE_POLICY, "mini-IDP receipt Argo namespace-move policy drifted");
  check(
    receipt.spec?.execution?.immutableSelectorReplacementPolicy === IMMUTABLE_SELECTOR_REPLACEMENT_POLICY,
    "mini-IDP receipt immutable-selector replacement policy drifted",
  );
  check(
    receipt.spec?.execution?.immutableSelectorFailureEvidencePolicy === IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_POLICY
      && receipt.spec?.execution?.immutableSelectorFailureEvidenceEffectiveAt === IMMUTABLE_SELECTOR_FAILURE_EVIDENCE_EFFECTIVE_AT,
    "mini-IDP receipt immutable-selector failure-evidence policy drifted",
  );
  check(
    receipt.spec?.execution?.protectedNamespaceOwnershipPolicy === PROTECTED_NAMESPACE_OWNERSHIP_POLICY,
    "mini-IDP receipt protected Namespace ownership policy drifted",
  );
  check(receipt.spec?.execution?.kindTraefikPolicy === KIND_TRAEFIK_POLICY, "mini-IDP receipt kind Traefik policy drifted");
  check(receipt.spec?.execution?.argoRetryPolicy === ARGO_RETRY_POLICY, "mini-IDP receipt Argo retry policy drifted");
  check(receipt.spec?.execution?.argoRevisionPolicy === ARGO_REVISION_POLICY, "mini-IDP receipt Argo revision policy drifted");
  check(receipt.spec?.execution?.guiIdentityPolicy === GUI_IDENTITY_POLICY, "mini-IDP receipt GUI identity policy drifted");
  check(stableJson(receipt.spec?.execution?.persistentClustersPreserved) === stableJson(FLEET.map((item) => item.cluster)), "persistent cluster allowlist drifted");
  check(
    receipt.spec?.execution?.partialClusterStatePolicy === "fail-except-exact-journaled-prefix",
    "mini-IDP receipt no longer limits partial fleet recovery to an exact journaled prefix",
  );
  check(receipt.spec?.execution?.serialLiveParityLock === true, "mini-IDP receipt no longer records the shared serial live-parity lock");
  check(receipt.spec?.execution?.unexpectedSpacePolicy === "fail-outside-exact-55-space-allowlist", "mini-IDP receipt no longer enforces the exact Space allowlist");
  check(receipt.spec?.execution?.unexpectedManagedUnitOrLinkPolicy === "fail", "mini-IDP receipt no longer rejects unexpected managed Units or Links");
  check(
    receipt.spec?.execution?.preservedControlUnitPolicy === "exact-receipt-bound-faithful-proof-units",
    "mini-IDP receipt no longer binds its preserved faithful proof Units exactly",
  );
  check(receipt.spec?.execution?.receiptRequiresZeroActionRerun === true, "mini-IDP receipt no longer requires a zero-action rerun");
  check(
    receipt.spec?.execution?.interruptedReleasePolicy === INTERRUPTED_RELEASE_POLICY,
    "mini-IDP receipt no longer proves restart-safe release publication",
  );
  check(
    receipt.spec?.execution?.interruptedScenarioPolicy === INTERRUPTED_SCENARIO_POLICY,
    "mini-IDP receipt no longer proves checkpoint-bound scenario recovery",
  );
  check(
    receipt.spec?.execution?.publishedReleaseSelectionPolicy === PUBLISHED_RELEASE_SELECTION_POLICY,
    "mini-IDP receipt no longer excludes withdrawn releases server-side",
  );
  check(
    receipt.spec?.execution?.deliveryRootPublicationPolicy === DELIVERY_ROOT_PUBLICATION_POLICY,
    "mini-IDP receipt no longer binds one complete delivery-root publication per cluster",
  );
  check(receipt.spec?.execution?.cub?.minimum === `v${MIN_CUB_VERSION}`, "mini-IDP receipt cub minimum-version contract drifted");
  check(versionAtLeast(String(receipt.spec?.execution?.cub?.client ?? "").replace(/^v/, ""), MIN_CUB_VERSION), "mini-IDP receipt cub client is too old");
  check(versionAtLeast(String(receipt.spec?.execution?.cub?.server ?? "").replace(/^v/, ""), MIN_CUB_VERSION), "mini-IDP receipt ConfigHub server is too old");

  const counts = receipt.spec?.counts ?? {};
  check(counts.spaces === desired.spaces.length, `receipt has ${counts.spaces} Spaces, expected ${desired.spaces.length}`);
  check(counts.managedUnits === desired.managedUnits.length, `receipt has ${counts.managedUnits} Units, expected ${desired.managedUnits.length}`);
  check(
    counts.preservedFaithfulControlUnits === PRESERVED_FAITHFUL_CONTROL_UNITS.length,
    `receipt has ${counts.preservedFaithfulControlUnits} preserved faithful Units, expected ${PRESERVED_FAITHFUL_CONTROL_UNITS.length}`,
  );
  check(counts.deployments === desired.deployments.length, `receipt has ${counts.deployments} deployments, expected ${desired.deployments.length}`);
  check(
    counts.deliveryApplicationUnits === desired.deployments.length + (FLEET.length * 2),
    "receipt delivery Application Unit count drifted",
  );
  check(
    counts.deploymentAuthorityApplications === desired.deployments.length + (FLEET.length * 2),
    "receipt deployment-authority Application count drifted",
  );
  check(
    counts.protectedNamespaceOwnershipDetachments === PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
    "receipt protected Namespace ownership-detachment count drifted",
  );
  check(counts.immutableSelectorReplacements === allImmutableSelectorReplacements(desired).length, "receipt immutable-selector replacement count drifted");
  check(counts.kindTraefikContracts === KIND_TRAEFIK_CONTRACTS.length, "receipt kind Traefik contract count drifted");
  check(counts.releases === desired.deployments.length, `receipt has ${counts.releases} releases, expected ${desired.deployments.length}`);
  check(counts.needsProvidesLinks === desired.links.length, `receipt has ${counts.needsProvidesLinks} Links, expected ${desired.links.length}`);
  check(counts.liveMatrixRows === FLEET.length * 9, `receipt live matrix has ${counts.liveMatrixRows} rows, expected ${FLEET.length * 9}`);

  const deliveryRuntimes = receipt.spec?.deliveryRuntimes ?? [];
  check(deliveryRuntimes.length === FLEET.length, "receipt cluster-local Argo runtime observations are incomplete");
  for (const item of FLEET) {
    const runtime = deliveryRuntimes.find((row) => row.cluster === item.cluster);
    check(runtime?.installedBy === "cub cluster up", `${item.cluster}: receipt Argo installer provenance drifted`);
    check(runtime?.version === ARGO_CD_RUNTIME_VERSION, `${item.cluster}: receipt Argo runtime version drifted`);
    check(runtime?.image === ARGO_CD_RUNTIME_IMAGE, `${item.cluster}: receipt Argo runtime image drifted`);
    check(
      stableJson((runtime?.references ?? []).map((row) => [row.workload, row.container]))
        === stableJson(ARGO_CD_RUNTIME_CONTAINER_PAIRS)
        && runtime.references.every((row) => row.image === ARGO_CD_RUNTIME_IMAGE),
      `${item.cluster}: receipt does not bind the exact eight reviewed Argo workload/container pairs to ${ARGO_CD_RUNTIME_IMAGE}`,
    );
  }

  const namespaceMoveEvidence = receipt.spec?.namespaceMovePrunes ?? [];
  check(namespaceMoveEvidence.length <= 1, "receipt retains more than one namespace-move DaemonSet prune");
  for (const item of namespaceMoveEvidence) {
    assertNamespaceMoveEvidenceRow(item, "receipt namespace-move prune");
  }

  const immutableSelectorEvidence = receipt.spec?.immutableSelectorReplacements ?? [];
  check(immutableSelectorEvidence.length === allImmutableSelectorReplacements(desired).length, "receipt immutable-selector replacement history is incomplete");
  check(new Set(immutableSelectorEvidence.map((item) => item.migrationID)).size === allImmutableSelectorReplacements(desired).length, "receipt duplicates immutable-selector replacement history");
  for (const item of immutableSelectorEvidence) {
    assertImmutableSelectorReplacementEvidence(item, "receipt immutable-selector replacement");
  }

  const protectedNamespaceEvidence = receipt.spec?.protectedNamespaceOwnershipDetachments ?? [];
  const protectedNamespaceCurrent = receipt.spec?.protectedNamespaceOwnershipCurrent ?? [];
  check(
    protectedNamespaceEvidence.length === PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
    "receipt protected Namespace ownership-detachment history is incomplete",
  );
  check(
    protectedNamespaceCurrent.length === PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.length,
    "receipt protected Namespace current postconditions are incomplete",
  );
  const historicalByMigration = new Map(protectedNamespaceEvidence.map((item) => [item.migrationID, item]));
  const currentByMigration = new Map(protectedNamespaceCurrent.map((item) => [item.migrationID, item]));
  check(historicalByMigration.size === protectedNamespaceEvidence.length, "receipt duplicates protected Namespace history");
  check(currentByMigration.size === protectedNamespaceCurrent.length, "receipt duplicates protected Namespace current evidence");
  for (const contract of PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS) {
    const historical = historicalByMigration.get(contract.migrationID);
    const current = currentByMigration.get(contract.migrationID);
    check(historical, `${contract.migrationID}: receipt ownership-detachment history is missing`);
    check(current, `${contract.migrationID}: receipt current protected Namespace evidence is missing`);
    assertProtectedNamespaceDetachmentEvidence(historical, contract);
    assertProtectedNamespaceCurrentObservation(current, contract, `${contract.migrationID}: receipt current postcondition`);
    check(current.uid === historical.uid, `${contract.migrationID}: receipt retained Namespace UID changed`);
  }
  assertKindTraefikEvidence(receipt.spec?.kindTraefik ?? [], "receipt kind Traefik evidence");

  const spaceRows = receipt.spec?.spaces ?? [];
  check(spaceRows.length === desired.spaces.length, "receipt Space rows are incomplete");
  const spacesBySlug = new Map(spaceRows.map((item) => [item.slug, item]));
  for (const expected of desired.spaces) {
    const row = spacesBySlug.get(expected.slug);
    check(row, `receipt is missing Space ${expected.slug}`);
    check(UUID_PATTERN.test(row.id ?? ""), `${expected.slug}: receipt Space ID missing`);
    check(stableJson(row.labels) === stableJson(expected.labels), `${expected.slug}: receipt labels drifted`);
    check(stableJson(row.annotations ?? {}) === stableJson(expected.annotations ?? {}), `${expected.slug}: receipt navigation annotations drifted`);
  }

  const unitRows = receipt.spec?.units ?? [];
  check(unitRows.length === desired.managedUnits.length, "receipt Unit rows are incomplete");
  const unitsByRef = new Map(unitRows.map((item) => [item.ref, item]));
  for (const expected of desired.managedUnits) {
    const ref = `${expected.space}/${expected.slug}`;
    const row = unitsByRef.get(ref);
    check(row, `receipt is missing Unit ${ref}`);
    check(UUID_PATTERN.test(row.id ?? ""), `${ref}: receipt Unit ID missing`);
    check(Number(row.headRevisionNum) > 0, `${ref}: receipt head revision missing`);
    const payload = inputs.payloads.get(expected.payloadKey);
    check(row.sourceSha256 === `sha256:${payload.sha256}`, `${ref}: receipt source digest drifted`);
    check(stableJson(row.labels) === stableJson(expected.labels), `${ref}: receipt Unit identity labels drifted`);
    check(
      stableJson(row.navigationAnnotations ?? {}) === stableJson(expected.annotations ?? {}),
      `${ref}: receipt Unit navigation annotations drifted`,
    );
  }

  const faithful = verifyFaithfulProof();
  const preservedRows = receipt.spec?.preservedControlUnits ?? [];
  check(
    preservedRows.length === PRESERVED_FAITHFUL_CONTROL_UNITS.length,
    "receipt preserved faithful control Unit rows are incomplete",
  );
  const preservedByRef = new Map(preservedRows.map((item) => [item.ref, item]));
  for (const expected of PRESERVED_FAITHFUL_CONTROL_UNITS) {
    const ref = `${CONTROL_SPACE}/${expected.slug}`;
    const evidence = faithful.spec?.configHub?.[expected.receiptKey];
    const row = preservedByRef.get(ref);
    check(row, `receipt is missing preserved faithful Unit ${ref}`);
    check(row.id === evidence?.unit?.id, `${ref}: preserved Unit ID is stale`);
    check(row.headRevisionNum === evidence?.unit?.headRevisionNum, `${ref}: preserved head revision is stale`);
    check(row.dataHash === evidence?.unit?.dataHash, `${ref}: preserved data hash is stale`);
    check(row.approvalCount === evidence?.approval?.recordedApprovals, `${ref}: preserved approval evidence is stale`);
    check(row.owner === "faithful-hub-spoke-proof" && row.policy === "preserved", `${ref}: preserved ownership policy drifted`);
  }

  const releaseRows = receipt.spec?.releases ?? [];
  check(releaseRows.length === desired.deployments.length, "receipt release rows are incomplete");
  for (const row of releaseRows) {
    check(UUID_PATTERN.test(row.id ?? "") && UUID_PATTERN.test(row.tagID ?? ""), `${row.space}: release or immutable Tag identity is invalid`);
    check(/^sha256:[0-9a-f]{64}$/.test(row.bundleDigest ?? ""), `${row.space}: bundle content digest missing`);
    check(/^sha256:[0-9a-f]{64}$/.test(row.manifestDigest ?? ""), `${row.space}: OCI manifest digest missing`);
    check(Number(row.unitCount) === Number(row.expectedUnitCount) && Number(row.unitCount) > 0, `${row.space}: receipt release UnitCount is incomplete`);
  }
  const releasesBySpace = new Map(releaseRows.map((row) => [row.space, row]));
  const appRows = receipt.spec?.applications ?? [];
  check(appRows.length === desired.deployments.length, "receipt Application rows are incomplete");
  const desiredApps = new Map(desired.deployments.map((item) => [`${item.cluster}/${item.space}`, item]));
  for (const row of appRows) {
    const expected = desiredApps.get(`${row.cluster}/${row.name}`);
    check(expected, `${row.cluster}/${row.name}: receipt Application is not in the desired plan`);
    check(row.destinationNamespace === expected.destinationNamespace, `${row.cluster}/${row.name}: receipt destination namespace drifted`);
    check(/^sha256:[0-9a-f]{64}$/.test(row.expectedRevision ?? ""), `${row.cluster}/${row.name}: receipt expected revision missing`);
    check(
      row.expectedRevision === releasesBySpace.get(row.name)?.manifestDigest,
      `${row.cluster}/${row.name}: receipt expected revision is not the release OCI ManifestDigest`,
    );
    check(row.observedRevision === row.expectedRevision, `${row.cluster}/${row.name}: receipt observed revision is not the expected ConfigHub release`);
    check(row.syncState === "Synced", `${row.cluster}/${row.name}: receipt sync is ${row.syncState}`);
    check((row.acceptedHealth ?? []).includes(row.healthState), `${row.cluster}/${row.name}: receipt health ${row.healthState} is outside accepted set`);
    check(
      row.targetRevision === "latest"
        && row.automatedSyncDisabled === true
        && row.activeOperation === false
        && !["Running", "Terminating"].includes(row.operationPhase)
        && row.applicationSetOwnerAbsent === true,
      `${row.cluster}/${row.name}: receipt Application authority is not fail-closed`,
    );
  }
  const authority = receipt.spec?.deploymentAuthority ?? {};
  check(
    authority.scope === "managed-automated-path; privileged human or external-controller Argo sync remains outside this proof unless separately constrained by RBAC or admission",
    "receipt deployment-authority scope overclaims exclusive Argo control",
  );
  check(
    authority.policy === "targetRevision latest is discovery-only; automated sync absent; no active operation; no ApplicationSet regeneration; ConfigHub revalidates the exact release and submits operation.sync.revision=ManifestDigest with Kubernetes UID/resourceVersion CAS",
    "receipt deployment-authority policy drifted",
  );
  const authorityApplications = authority.applications ?? [];
  const expectedDeliveryUnitRefs = new Set(plannedDeliveryApplicationIdentity(desired).map((item) => item.ref));
  check(authorityApplications.length === expectedDeliveryUnitRefs.size, "receipt does not retain all 35 Application authority rows");
  check(new Set(authorityApplications.map((row) => row.sourceUnit)).size === expectedDeliveryUnitRefs.size, "receipt deployment-authority source Units are duplicated");
  for (const row of authorityApplications) {
    check(expectedDeliveryUnitRefs.has(row.sourceUnit), `${row.cluster}/${row.name}: deployment-authority row is outside the exact delivery Unit set`);
    check(UUID_PATTERN.test(row.releaseID ?? "") && UUID_PATTERN.test(row.releaseTagID ?? "") && Number(row.releaseNum) > 0, `${row.cluster}/${row.name}: authoritative release/Tag identity is invalid`);
    check(Number(row.releaseUnitCount) === Number(row.expectedUnitCount) && Number(row.releaseUnitCount) > 0, `${row.cluster}/${row.name}: authoritative release UnitCount is incomplete`);
    check(/^sha256:[0-9a-f]{64}$/.test(row.expectedRevision ?? "") && row.observedRevision === row.expectedRevision, `${row.cluster}/${row.name}: exact ManifestDigest observation is missing`);
    check(
      row.targetRevision === "latest"
        && row.automatedSyncDisabled === true
        && row.activeOperation === false
        && !["Running", "Terminating"].includes(row.operationPhase)
        && row.applicationSetOwnerAbsent === true
        && row.syncSubmissionAuthority === "ConfigHub-revalidated-ManifestDigest-Kubernetes-UID-resourceVersion-CAS",
      `${row.cluster}/${row.name}: managed deployment authority is not fail-closed`,
    );
    check(row.syncState === "Synced" && (row.acceptedHealth ?? []).includes(row.healthState), `${row.cluster}/${row.name}: authority row is not converged`);
  }
  const applicationSetRows = authority.applicationSets ?? [];
  check(applicationSetRows.length === FLEET.length, "receipt ApplicationSet inventory is incomplete");
  for (const row of applicationSetRows) {
    check(FLEET.some((item) => item.cluster === row.cluster) && row.count === 0 && stableJson(row.refs) === "[]", `${row.cluster}: adapted lane retains an ApplicationSet regeneration path`);
  }
  const argobotRows = authority.argobot ?? [];
  check(argobotRows.length === FLEET.length, "receipt argobot authority inventory is incomplete");
  for (const row of argobotRows) {
    check(FLEET.some((item) => item.cluster === row.cluster) && row.version === ARGOBOT_VERSION, `${row.cluster}: argobot authority identity drifted`);
    const deployment = row.deployment ?? {};
    check(
      deployment.image === ARGOBOT_IMAGE
        && deployment.syncMode === "kubernetes"
        && deployment.applicationNamespace === "argocd"
        && deployment.refreshType === "hard"
        && deployment.restSyncEnvironmentAbsent === true
        && deployment.commandOverrideAbsent === true
        && deployment.oneContainerNoInit === true
        && deployment.duplicateEnvironmentAbsent === true
        && deployment.selectorExact === true
        && deployment.rolloutCurrent === true,
      `${row.cluster}: argobot Deployment is not exact refresh-only authority`,
    );
    check((row.pods ?? []).length === deployment.replicas && deployment.replicas > 0, `${row.cluster}: argobot Pod authority inventory is incomplete`);
    for (const pod of row.pods) {
      check(
        UUID_PATTERN.test(pod.uid ?? "")
          && pod.runningReady === true
          && pod.image === ARGOBOT_IMAGE
          && pod.syncMode === "kubernetes"
          && pod.applicationNamespace === "argocd"
          && pod.refreshType === "hard"
          && pod.restSyncEnvironmentAbsent === true
          && pod.commandOverrideAbsent === true
          && pod.oneContainerNoInit === true
          && pod.duplicateEnvironmentAbsent === true,
        `${row.cluster}/${pod.name}: argobot Pod is not exact refresh-only authority`,
      );
    }
  }
  check(
    stableJson(receipt.spec?.deliveryApplicationUnits ?? [])
      === stableJson(plannedDeliveryApplicationIdentity(desired)),
    "receipt delivery Application Unit identity metadata drifted",
  );

  const links = receipt.spec?.wiring?.links ?? [];
  assertReceiptLinkEvidence(links, desired.links);
  const guiNavigation = receipt.spec?.guiNavigation ?? {};
  check(guiNavigation.scope === "identity-and-navigation-only", "receipt GUI navigation scope overclaims evidence");
  check(guiNavigation.startHereSpace === CONTROL_SPACE, "receipt GUI start Space drifted");
  check(
    stableJson(guiNavigation.startHereControlUnits) === stableJson([...START_HERE_CONTROL_UNITS].sort()),
    "receipt GUI start Unit set drifted",
  );
  check(stableJson(guiNavigation.publicURLs) === stableJson(PUBLIC_NAVIGATION_ANNOTATIONS), "receipt public GUI URLs drifted");
  check(guiNavigation.declaredNeedsProvidesLinks === desired.links.length, "receipt declared GUI Link count drifted");
  check(guiNavigation.completeWiringGraphClaim === false, "receipt must not claim a complete GUI wiring graph");
  check(guiNavigation.liveHealthClaim === false, "receipt GUI metadata must not claim live health");
  const grafanaSecret = receipt.spec?.wiring?.grafanaSecret;
  check(grafanaSecret?.store?.name === "hx-app-dev-dev" && grafanaSecret.store.ready === true, "receipt does not prove the Grafana ClusterSecretStore ready");
  check(
    grafanaSecret?.externalSecret?.name === "grafana-admin-credentials-es"
      && grafanaSecret.externalSecret.ready === true
      && grafanaSecret.externalSecret.storeRef?.kind === "ClusterSecretStore"
      && grafanaSecret.externalSecret.storeRef?.name === "hx-app-dev-dev"
      && grafanaSecret.externalSecret.target === "grafana-admin-credentials",
    "receipt does not prove the Grafana ExternalSecret wiring ready",
  );
  check(
    grafanaSecret?.secret?.ownerKind === "ExternalSecret"
      && grafanaSecret.secret.ownerName === "grafana-admin-credentials-es"
      && stableJson(grafanaSecret.secret.keysPresent) === stableJson(["admin-password", "admin-user"]),
    "receipt does not prove the Grafana Secret is ESO-owned with both credential keys",
  );

  const scenario = receipt.spec?.rolloutScenario ?? {};
  check(scenario.version === SCENARIO_VERSION, "receipt rollout scenario version drifted");
  check(scenario.sourceFingerprint === scenarioSourceFingerprint(), "receipt rollout scenario source fingerprint drifted");
  for (const id of ["initial-rollout", "base-promotion", "prod-approval", "prod-a-rollback", "staging-departure", "departure-survives-promotion"]) {
    check((scenario.steps ?? []).some((item) => item.id === id && item.result === "pass"), `receipt rollout step ${id} is missing`);
  }
  for (const space of ["hx-web-prod-a", "hx-web-prod-b"]) {
    const gateObservation = (scenario.operationEvidence ?? []).find(
      (item) => item.type === "approval-gate-observed" && item.ref === space,
    );
    check(gateObservation?.gatedHeads?.length > 0, `receipt lacks exact pre-approval gated heads for ${space}`);
    check(gateObservation.observationMode === "read-only-authoritative-gate", `${space}: gate observation mode is not read-only authoritative evidence`);
    for (const head of gateObservation.gatedHeads) {
      check(UUID_PATTERN.test(head.id ?? "") && Number(head.headRevisionNum) > 0 && /^[a-f0-9]{64}$/.test(head.dataHash ?? ""), `${head.ref}: gated-head evidence is invalid`);
    }
  }
  check(
    scenarioOperationProofValid(scenario),
    "receipt lacks exact gate observation, approval, or rollback evidence bound to its rollout checkpoints",
  );
  const checkpoints = scenario.checkpoints ?? [];
  for (const id of ["materialized", "base-promotion", "prod-approval", "prod-a-rollback", "final-normalized"]) {
    const checkpoint = checkpoints.find((item) => item.id === id)?.facts;
    check(checkpoint?.sourceFingerprint === scenario.sourceFingerprint, `receipt rollout checkpoint ${id} is missing or source-unbound`);
    check(Array.isArray(checkpoint.units) && checkpoint.units.length > 0, `receipt rollout checkpoint ${id} lacks Unit facts`);
    check(Array.isArray(checkpoint.releases) && checkpoint.releases.length === FLEET.length, `receipt rollout checkpoint ${id} lacks release facts`);
    check(Array.isArray(checkpoint.upgradeLinks) && checkpoint.upgradeLinks.length > 0, `receipt rollout checkpoint ${id} lacks UpgradeUnit merge-base facts`);
    for (const unit of checkpoint.units) {
      check(UUID_PATTERN.test(unit.id ?? ""), `receipt rollout checkpoint ${id}/${unit.ref} Unit ID is invalid`);
      check(Number(unit.headRevisionNum) > 0 && /^[a-f0-9]{64}$/.test(unit.dataHash ?? ""), `receipt rollout checkpoint ${id}/${unit.ref} revision or data hash is invalid`);
    }
  }
  for (const [name, value] of Object.entries(scenario.claims ?? {})) check(value === "pass", `rollout claim ${name} is not pass`);
  check((scenario.finalChecks ?? []).length === 5 && scenario.finalChecks.every((item) => item.result === "pass"), "receipt final rollout checks are incomplete");

  const liveMatrix = receipt.spec?.liveMatrix;
  check(liveMatrix?.kind === "KubaraMiniIDPLiveMatrixObservation", "receipt live matrix kind drifted");
  check(liveMatrix?.observationMode === "kubectl-and-confighub-live-read", "receipt live matrix is not live evidence");
  check(liveMatrix?.rows?.length === FLEET.length * 9, "receipt live matrix row count drifted");
  for (const row of liveMatrix.rows) {
    check(FLEET.some((item) => item.cluster === row.cluster), `matrix row has unknown cluster ${row.cluster}`);
    check(typeof row.desiredVersion === "string" && row.desiredVersion, `${row.cluster}/${row.component}: desired version missing`);
    check(["delivered", "not-selected"].includes(row.deliveryState), `${row.cluster}/${row.component}: delivery state invalid`);
    if (row.deliveryState === "delivered") {
      check(row.syncState === "Synced", `${row.cluster}/${row.component}: matrix sync is ${row.syncState}`);
      check(row.readiness?.result !== "fail", `${row.cluster}/${row.component}: matrix readiness failed`);
      check(row.observedVersion !== undefined, `${row.cluster}/${row.component}: observedVersion field missing`);
      check(row.unknownReason !== undefined, `${row.cluster}/${row.component}: unknownReason field missing`);
    }
  }

  const runs = receipt.spec?.reconcileRuns ?? [];
  check(runs.length >= 2 && runs.every((item) => item.result === "pass"), "receipt must contain an immediate changed reconciliation and zero-action rerun");
  check(
    runs.every((item) => Number.isInteger(item.attemptSequence) && UUID_PATTERN.test(item.attemptID ?? "")),
    "receipt reconcile runs are not bound to durable apply attempts",
  );
  check(runs.every((item) => item.executionFingerprint === operationExecutionFingerprint()), "receipt reconcile runs do not share the current execution fingerprint");
  check(
    runs.every((item) => /^sha256:[0-9a-f]{64}$/.test(item.finalConfigHubFingerprint ?? "")),
    "receipt reconcile runs lack canonical final ConfigHub fingerprints",
  );
  const [changed, noop] = runs.slice(-2);
  check(noop.attemptSequence === changed.attemptSequence + 1, "receipt reconcile runs are not consecutive apply attempts");
  check(changed.idempotentNoop === false && changed.actionCount > 0, "receipt penultimate reconcile run is not a changed apply");
  check(noop.idempotentNoop === true && noop.actionCount === 0, "receipt latest reconcile run is not an idempotent no-op");
  check(
    changed.finalConfigHubFingerprint === noop.finalConfigHubFingerprint
      && noop.finalConfigHubFingerprint === finalConfigHubSnapshot.fingerprint
      && finalConfigHubSnapshot.sourceRunAttemptID === noop.attemptID
      && finalConfigHubSnapshot.sourceRunClass === "idempotent-apply",
    "receipt changed/no-op runs and final ConfigHub snapshot do not prove the same state",
  );
  check(
    changed.performance?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION
      && noop.performance?.schemaVersion === RECONCILE_PERFORMANCE_SCHEMA_VERSION
      && changed.performance?.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID
      && noop.performance?.fixtureID === RECONCILE_PERFORMANCE_FIXTURE_ID
      && changed.performance?.runClass === "changed-apply"
      && noop.performance?.runClass === "idempotent-apply",
    "receipt immediate reconcile pair is not measured by the schema-v2 fixture",
  );
  check(
    Number.isFinite(Date.parse(changed.observedAt ?? ""))
      && Number.isFinite(Date.parse(noop.observedAt ?? ""))
      && Date.parse(changed.observedAt) < Date.parse(noop.observedAt),
    "receipt immediate reconcile pair timestamps are invalid or unordered",
  );
  check(
    receipt.spec?.deterministicProofMode === "immediate-changed-then-zero-action-rerun",
    "receipt deterministic proof mode does not match its run evidence",
  );
  check(receipt.status?.result === "pass", "mini-IDP receipt status is not pass");
  check(receipt.status?.cleanRoomReproducible === false, "retained-org receipt must not overclaim clean-room reproduction");
  check(receipt.status?.deterministicReconciliationProven === true, "mini-IDP receipt deterministic reconciliation proof is missing");
  check(receipt.status?.idempotentRerunProven === true, "mini-IDP receipt does not prove a zero-action rerun");
  check(receipt.status?.fullCurrentSelectionDelivered === true, "mini-IDP receipt does not claim the full current selection");
  check((receipt.status?.limits ?? []).length >= 5, "mini-IDP receipt limits are incomplete");
  console.log(`verified ${relativeRepo(RECEIPT_PATH)}: ${counts.spaces} Spaces, ${counts.managedUnits} Units, ${counts.releases} releases, ${counts.liveMatrixRows} live matrix rows`);
}
