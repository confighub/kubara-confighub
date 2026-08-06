#!/usr/bin/env node

// One deterministic front door for the Kubara + ConfigHub release. The
// static lane is deliberately offline. The full lane additionally requires
// immutable promotions, serial live receipts, the faithful hub/spoke proof,
// the clean-room mini-IDP receipt, and a freshly generated public site.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  check,
  listFiles,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256File,
  writeYaml,
} from "./lib/proof-common.mjs";
import {
  evaluateKubaraSiteLiveEvidence,
  KUBARA_GUI_REQUIRED_HASH_FIELDS,
} from "./lib/kubara-site-live-evidence.mjs";
import {
  KUBARA_CATALOG_ADDITIONS,
  KUBARA_CATALOG_BASELINE,
  KUBARA_CURRENT_ADDITIONS,
  KUBARA_HISTORICAL_ADDITIONS,
  KUBARA_OCI_PACKAGES,
  KUBARA_PROMOTION_RECEIPTS,
} from "./lib/kubara-catalog-release.mjs";
import {
  KUBARA_CATALOG_1_1_ADDITIONS,
  KUBARA_CATALOG_1_1_BASELINE,
  KUBARA_CATALOG_1_1_FINAL,
} from "./lib/kubara-catalog-1-1-full-coverage.mjs";

const mode = process.argv[2] ?? "--verify-static";
if (!["--generate", "--verify-static", "--verify", "--verify-adoption-screenshots", "--verify-adoption-screenshots-current"].includes(mode)) {
  console.error(`Usage:
  node scripts/verify-kubara-release-acceptance.mjs --generate
  node scripts/verify-kubara-release-acceptance.mjs --verify-static
  node scripts/verify-kubara-release-acceptance.mjs --verify
  node scripts/verify-kubara-release-acceptance.mjs --verify-adoption-screenshots
  node scripts/verify-kubara-release-acceptance.mjs --verify-adoption-screenshots-current`);
  process.exit(2);
}

const contractRelative = "data/kubara-release-acceptance/contract.yaml";
const contractPath = join(repoRoot, contractRelative);
const baseline = {
  count: KUBARA_CATALOG_BASELINE.versionCount,
  recipesTreeSHA256: KUBARA_CATALOG_BASELINE.recipesTreeSHA256,
  packagesTreeSHA256: KUBARA_CATALOG_BASELINE.packagesTreeSHA256,
};
const historicalAdditions = [...KUBARA_HISTORICAL_ADDITIONS];
const currentAdditions = [...KUBARA_CURRENT_ADDITIONS];
const additions = [...KUBARA_CATALOG_ADDITIONS];
const fullCoverageAdditions = KUBARA_CATALOG_1_1_ADDITIONS.map((item) => `${item.canonicalIdentity}/${item.version}`);
const top100EvidenceComponentCount = 100;
const finalCatalogVersionCount = KUBARA_CATALOG_1_1_FINAL.versionCount;
const finalCatalogComponentCount = KUBARA_CATALOG_1_1_FINAL.componentCount;
const kubaraDeliveryAuthority = {
  releaseAuthority: "ConfigHub authoritative published release",
  argoRole: "cluster-local reconciler",
  managedApplicationInventory: "cluster-wide-exact-allowlist; namespace-argocd-only; ApplicationSets-zero",
  managedApplicationTargetRevision: "latest-discovery-only",
  managedApplicationAutomatedSync: "absent",
  argobot: {
    version: "v0.1.6",
    image: "ghcr.io/confighub/argobot:v0.1.6",
    environment: {
      ARGO_SYNC_MODE: "kubernetes",
      ARGO_NAMESPACE: "argocd",
      ARGO_REFRESH_TYPE: "hard",
    },
    authority: "hard-refresh-only-never-deploy",
  },
  syncOperation: {
    revision: "operation.sync.revision=<ManifestDigest>",
    compareAndSet: ["metadata.uid", "metadata.resourceVersion"],
    activeOperationPolicy: "wait-until-inactive-never-replace",
    preSubmitReleaseRevalidation: "exact-authoritative-confighub-release",
  },
  retainedReleaseTagHistory: "release-N identity and contiguity audited; tags are not deployment authority",
  publishRaceBoundary: "client opening/closing checks plus the no-auto fence prevent a rejected raced Release from deploying through the managed reconciler; atomic Release rejection requires server publish preconditions",
  claimBoundary: "managed automated delivery path only; privileged human or manual Argo sync requires separate RBAC or admission proof",
};
const kubaraArgoRevisionPolicy = "disable Argo automated sync for every managed Application; accept and submit only the exact authoritative ConfigHub OCI ManifestDigest with a Kubernetes UID/resourceVersion compare-and-set; targetRevision latest is discovery-only and argobot refreshes cannot deploy";
const kubaraDeliveryRootPublicationPolicy = "reconcile every declared Argo Application Unit with automated sync disabled; retain bootstrap and variant-created release history only behind a fenced no-auto root; select or publish one complete authoritative delivery-root release per cluster; compare-and-set that exact root ManifestDigest into Argo before any source release can converge; and forbid later Application Unit mutations in the run";
const kubaraBuyerJourneySources = {
  overview: "docs/demo/kubara/index.md",
  tutorial: "docs/demo/kubara/adoption.md",
  checkpoints: "docs/demo/kubara/checkpoints.md",
  guiTour: "docs/demo/kubara/gui-tour.md",
};
const kubaraAdoptionChapters = [
  { number: 1, path: "docs/demo/kubara/adoption-1-choose.md", previous: "index.md", next: "adoption-2-generate.md" },
  { number: 2, path: "docs/demo/kubara/adoption-2-generate.md", previous: "adoption-1-choose.md", next: "adoption-3-git.md" },
  { number: 3, path: "docs/demo/kubara/adoption-3-git.md", previous: "adoption-2-generate.md", next: "adoption-4-oci.md" },
  { number: 4, path: "docs/demo/kubara/adoption-4-oci.md", previous: "adoption-3-git.md", next: "adoption-5-confighub-org.md" },
  { number: 5, path: "docs/demo/kubara/adoption-5-confighub-org.md", previous: "adoption-4-oci.md", next: "adoption-6-apps.md" },
  { number: 6, path: "docs/demo/kubara/adoption-6-apps.md", previous: "adoption-5-confighub-org.md", next: "gui-tour.md" },
];
const kubaraMiniIdpReceiptRelative = "runs/kubara-mini-idp-reconcile/receipt.yaml";
const kubaraMeasuredNoOpDocs = [
  "docs/demo/kubara/index.md",
  "docs/demo/kubara/checkpoints.md",
  "docs/demo/kubara/gui-tour.md",
  "docs/demo/kubara/single-platform.md",
  "docs/demo/kubara/adoption-5-confighub-org.md",
  "docs/demo/kubara/reconciliation-performance.md",
];
const kubaraGuiEvidenceReceipt = "data/kubara-gui-evidence/receipt.yaml";
const kubaraAdoptionScreenshotContractRelative = "data/kubara-adoption-screenshots/contract.yaml";
const kubaraAdoptionScreenshotContractPath = join(repoRoot, kubaraAdoptionScreenshotContractRelative);
const kubaraAdoptionScreenshotReceipt = "data/kubara-adoption-screenshots/receipt.yaml";
const kubaraAdoptionScreenshotDirectory = "docs/images/kubara-adoption";
const kubaraAdoptionScreenshotFrames = [
  {
    step: 1,
    id: "native-config",
    chapter: "docs/demo/kubara/adoption-1-choose.md",
    imagePath: "docs/images/kubara-adoption/01-native-kubara-config.png",
    subject: "native Kubara config, component selection, cluster placement, and wiring",
    evidenceBindings: ["generationReceipt"],
  },
  {
    step: 2,
    id: "generation-parity",
    chapter: "docs/demo/kubara/adoption-2-generate.md",
    imagePath: "docs/images/kubara-adoption/02-kubara-generation-parity.png",
    subject: "Kubara generation result and path-and-byte catalog parity",
    evidenceBindings: ["generationReceipt", "catalogParityReceipt"],
  },
  {
    step: 3,
    id: "exact-git-revision",
    chapter: "docs/demo/kubara/adoption-3-git.md",
    imagePath: "docs/images/kubara-adoption/03-exact-git-revision.png",
    subject: "pushed exact Git revision and complete prepared hand-off tree",
    evidenceBindings: ["preparedHandoffReceipt"],
  },
  {
    step: 4,
    id: "oci-packages-index",
    chapter: "docs/demo/kubara/adoption-4-oci.md",
    imagePath: "docs/images/kubara-adoption/04-oci-packages-index.png",
    subject: "isolated deterministic importer proof of per-component and per-config OCI packages plus the digest-bound platform index",
    evidenceBindings: ["preparedHandoffReceipt", "importerImplementation", "releaseAcceptanceContract"],
  },
  {
    step: 5,
    id: "selected-org-topology",
    chapter: "docs/demo/kubara/adoption-5-confighub-org.md",
    imagePath: "docs/images/kubara-adoption/05-selected-org-topology.png",
    subject: "selected ConfigHub organization with recognizable faithful and adapted Kubara topology",
    evidenceBindings: ["faithfulReceipt", "miniIdpReceipt", "orphanReceipt"],
  },
  {
    step: 6,
    id: "app-governance-live",
    chapter: "docs/demo/kubara/adoption-6-apps.md",
    imagePath: "docs/images/kubara-adoption/06-app-governance-live.png",
    subject: "application approval, promotion, departure, rollback, exact release, and live result",
    evidenceBindings: ["miniIdpReceipt", "orphanReceipt", "matrix", "wiring"],
  },
];
const kubaraAdoptionScreenshotEvidence = [
  { id: "generationReceipt", path: "examples/kubara/current-platform/generation-receipt.yaml" },
  { id: "catalogParityReceipt", path: "examples/kubara/current-platform/catalog-parity-receipt.yaml" },
  { id: "preparedHandoffReceipt", path: "examples/kubara/prepared-current-platform/preparation-receipt.yaml" },
  { id: "importerImplementation", path: "scripts/import-kubara-git-revision.mjs" },
  { id: "appReleaseRunnerImplementation", path: "scripts/run-kubara-app-release.mjs" },
  { id: "releaseAcceptanceContract", path: "data/kubara-release-acceptance/contract.yaml" },
  { id: "faithfulReceipt", path: "runs/kubara-faithful-hub-spoke/receipt.yaml" },
  { id: "miniIdpReceipt", path: "runs/kubara-mini-idp-reconcile/receipt.yaml" },
  { id: "orphanReceipt", path: "runs/kubara-mini-idp-reconcile/orphan-audit.yaml" },
  { id: "matrix", path: "data/kubara-platform-matrix/matrix.json" },
  { id: "wiring", path: "data/kubara-wiring/graph.json" },
];

const packageCommands = {
  "kubara-catalog-promotion:dry-run": "node scripts/promote-kubara-catalog-candidates.mjs --dry-run",
  "kubara-catalog-promotion:stage": "node scripts/promote-kubara-catalog-candidates.mjs --stage",
  "kubara-catalog-promotion:stage:verify": "node scripts/promote-kubara-catalog-candidates.mjs --verify-stage",
  "kubara-catalog-promotion:promote": "node scripts/promote-kubara-catalog-candidates.mjs --promote",
  "kubara-catalog-candidates:verify": "node scripts/run-kubara-catalog-candidates.mjs --verify",
  "kubara-current-catalog-promotion:dry-run": "node scripts/promote-kubara-catalog-candidates.mjs --dry-run --current",
  "kubara-current-catalog-promotion:stage": "node scripts/promote-kubara-catalog-candidates.mjs --stage --current",
  "kubara-current-catalog-promotion:stage:verify": "node scripts/promote-kubara-catalog-candidates.mjs --verify-stage --current",
  "kubara-current-catalog-promotion:promote": "node scripts/promote-kubara-catalog-candidates.mjs --promote --current",
  "kubara-current-catalog-candidates:verify": "node scripts/run-kubara-current-catalog-candidates.mjs --verify",
  "kubara-catalog-adapter:verify": "node scripts/generate-kubara-catalog-adapter.mjs --verify",
  "kubara-current-example:verify": "node scripts/generate-kubara-current-example.mjs --verify",
  "kubara-git-handoff:verify-current": "node scripts/prepare-kubara-git-handoff.mjs --verify --request examples/kubara/git-import/current-platform.prepare.yaml --checkout .",
  "kubara-git-handoff:self-test": "node scripts/prepare-kubara-git-handoff.mjs --self-test",
  "kubara-git-import:self-test": "node scripts/import-kubara-git-revision.mjs --self-test",
  "kubara-selected-org:self-test": "node scripts/compile-kubara-selected-org-workflow.mjs --self-test",
  "kubara-app-release:self-test": "node scripts/compile-kubara-app-release.mjs --self-test",
  "kubara-app-release-runner:self-test": "node scripts/run-kubara-app-release.mjs --self-test",
  "kubara-adoption:self-test": "npm run kubara-git-import:self-test && npm run kubara-selected-org:self-test && npm run kubara-app-release:self-test && npm run kubara-app-release-runner:self-test",
  "kubara-effective-renders:verify": "node scripts/generate-kubara-effective-renders.mjs --verify --all",
  "kubara-wiring:verify": "node scripts/generate-kubara-wiring.mjs --verify --all",
  "kubara-platform-matrix:verify": "node scripts/generate-kubara-platform-matrix.mjs --verify --all",
  "kubara-platform-matrix:generate": "node scripts/generate-kubara-platform-matrix.mjs --generate --all",
  "kubara-catalog-promotion:verify": "node scripts/promote-kubara-catalog-candidates.mjs --verify",
  "kubara-current-catalog-promotion:verify": "node scripts/promote-kubara-catalog-candidates.mjs --verify --current",
  "kubara-catalog-oci:verify": "node scripts/publish-kubara-catalog-additions.mjs --verify",
  "kubara-catalog-oci:dry-run": "node scripts/publish-kubara-catalog-additions.mjs --dry-run",
  "kubara-catalog-oci:self-test": "node scripts/publish-installer-oci-packages.mjs --self-test && node scripts/publish-kubara-catalog-additions.mjs --dry-run",
  "kubara-catalog-oci:publish": "node scripts/publish-kubara-catalog-additions.mjs --publish",
  "kubara-catalog-full-coverage:generate": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --generate",
  "kubara-catalog-full-coverage:verify-candidates": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --verify-candidates",
  "kubara-catalog-full-coverage:preflight": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --preflight",
  "kubara-catalog-full-coverage:promote": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --promote",
  "kubara-catalog-full-coverage:publish": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --publish",
  "kubara-catalog-full-coverage:verify": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --verify",
  "kubara-catalog-full-coverage:self-test": "node scripts/complete-kubara-catalog-1-1-coverage.mjs --self-test",
  "kubara-catalog-release:generate": "node scripts/generate-kubara-catalog-release.mjs --generate",
  "kubara-catalog-release:verify": "node scripts/generate-kubara-catalog-release.mjs --verify",
  "kubara-live-qualification:verify": "node scripts/run-kubara-live-qualification.mjs --verify",
  "kubara-live-qualification:preflight": "node scripts/run-kubara-live-qualification.mjs --preflight",
  "kubara-live-qualification:run": "node scripts/run-kubara-live-qualification.mjs --run",
  "kubara-current-live-qualification:verify": "node scripts/run-kubara-live-qualification.mjs --verify --current",
  "kubara-current-live-qualification:preflight": "node scripts/run-kubara-live-qualification.mjs --preflight --current",
  "kubara-current-live-qualification:run": "node scripts/run-kubara-live-qualification.mjs --run --current",
  "kubara-faithful-hub-spoke:rehearse": "node scripts/run-kubara-faithful-hub-spoke-proof.mjs --rehearse",
  "kubara-faithful-hub-spoke:run": "node scripts/run-kubara-faithful-hub-spoke-proof.mjs --run",
  "kubara-faithful-hub-spoke:generate": "node scripts/run-kubara-faithful-hub-spoke-proof.mjs --generate",
  "kubara-faithful-hub-spoke:verify": "node scripts/run-kubara-faithful-hub-spoke-proof.mjs --verify",
  "kubara-mini-idp:plan": "node scripts/reconcile-kubara-mini-idp.mjs --plan",
  "kubara-mini-idp:apply": "node scripts/reconcile-kubara-mini-idp.mjs --apply",
  "kubara-mini-idp:verify": "node scripts/reconcile-kubara-mini-idp.mjs --verify",
  "kubara-mini-idp:receipt-verify": "node scripts/reconcile-kubara-mini-idp.mjs --receipt-verify",
  "kubara-mini-idp:performance-contract:verify": "node scripts/verify-kubara-mini-idp-performance.mjs --contract",
  "kubara-mini-idp:performance:self-test": "node scripts/verify-kubara-mini-idp-performance.mjs --self-test",
  "kubara-mini-idp:performance:receipt-verify": "node scripts/verify-kubara-mini-idp-performance.mjs --receipt-verify",
  "kubara-release:generate": "node scripts/verify-kubara-release-acceptance.mjs --generate",
  "kubara-release:verify-static": "node scripts/verify-kubara-release-acceptance.mjs --verify-static",
  "kubara-release:verify": "node scripts/verify-kubara-release-acceptance.mjs --verify",
};

const offlineCommands = [
  command("catalog-adapter", "scripts/generate-kubara-catalog-adapter.mjs", "--verify"),
  command("historical-candidates", "scripts/run-kubara-catalog-candidates.mjs", "--verify"),
  command("current-candidates", "scripts/run-kubara-current-catalog-candidates.mjs", "--verify"),
  command("catalog-oci-idempotency", "scripts/publish-installer-oci-packages.mjs", "--self-test"),
  command("catalog-oci-scope-dry-run", "scripts/publish-kubara-catalog-additions.mjs", "--dry-run"),
  command("catalog-full-coverage-self-test", "scripts/complete-kubara-catalog-1-1-coverage.mjs", "--self-test"),
  command("catalog-full-coverage-candidates", "scripts/complete-kubara-catalog-1-1-coverage.mjs", "--verify-candidates"),
  command("current-example", "scripts/generate-kubara-current-example.mjs", "--verify"),
  command("git-handoff-current", "scripts/prepare-kubara-git-handoff.mjs", "--verify", "--request", "examples/kubara/git-import/current-platform.prepare.yaml", "--checkout", "."),
  command("git-handoff-self-test", "scripts/prepare-kubara-git-handoff.mjs", "--self-test"),
  command("git-revision-import", "scripts/import-kubara-git-revision.mjs", "--self-test"),
  command("selected-org-workflow", "scripts/compile-kubara-selected-org-workflow.mjs", "--self-test"),
  command("app-release-workflow", "scripts/compile-kubara-app-release.mjs", "--self-test"),
  command("app-release-runner", "scripts/run-kubara-app-release.mjs", "--self-test"),
  command("historical-org-shape-retirement", "scripts/sync-kubara-org-shape.mjs", "--self-test"),
  command("effective-renders", "scripts/generate-kubara-effective-renders.mjs", "--verify", "--all"),
  command("wiring", "scripts/generate-kubara-wiring.mjs", "--verify", "--all"),
  command("wiring-self-test", "scripts/generate-kubara-wiring.mjs", "--self-test"),
  command("platform-matrix", "scripts/generate-kubara-platform-matrix.mjs", "--verify", "--all"),
  command("platform-matrix-self-test", "scripts/generate-kubara-platform-matrix.mjs", "--self-test"),
  command("mini-idp-performance-contract", "scripts/verify-kubara-mini-idp-performance.mjs", "--contract"),
  command("mini-idp-performance-self-test", "scripts/verify-kubara-mini-idp-performance.mjs", "--self-test"),
];

const finalCommands = [
  command("historical-live-qualification", "scripts/run-kubara-live-qualification.mjs", "--verify"),
  command("current-live-qualification", "scripts/run-kubara-live-qualification.mjs", "--verify", "--current"),
  command("historical-root-promotion", "scripts/promote-kubara-catalog-candidates.mjs", "--verify"),
  command("current-root-promotion", "scripts/promote-kubara-catalog-candidates.mjs", "--verify", "--current"),
  command("catalog-full-coverage", "scripts/complete-kubara-catalog-1-1-coverage.mjs", "--verify"),
  command("faithful-hub-spoke", "scripts/run-kubara-faithful-hub-spoke-proof.mjs", "--verify"),
  command("mini-idp", "scripts/reconcile-kubara-mini-idp.mjs", "--receipt-verify"),
  command("mini-idp-orphans", "scripts/audit-kubara-mini-idp-orphans.mjs", "--receipt-verify"),
  command("mini-idp-performance", "scripts/verify-kubara-mini-idp-performance.mjs", "--receipt-verify"),
  command("catalog-public-release", "scripts/generate-kubara-catalog-release.mjs", "--verify"),
];

if (mode === "--generate") {
  writeYaml(contractPath, expectedContract());
  writeYaml(kubaraAdoptionScreenshotContractPath, expectedKubaraAdoptionScreenshotContract());
  verifyStatic();
  console.log(`generated and verified ${contractRelative}`);
} else if (["--verify-adoption-screenshots", "--verify-adoption-screenshots-current"].includes(mode)) {
  check(existsSync(kubaraAdoptionScreenshotContractPath), `${kubaraAdoptionScreenshotContractRelative} is missing`);
  check(
    stableJson(readYaml(kubaraAdoptionScreenshotContractPath))
      === stableJson(expectedKubaraAdoptionScreenshotContract()),
    `${kubaraAdoptionScreenshotContractRelative} is stale`,
  );
  verifyKubaraAdoptionScreenshotContract({ requireCurrent: mode.endsWith("-current") });
  console.log(`verified ${mode.endsWith("-current") ? "current-live" : "offline"} Kubara six-step adoption screenshot contract`);
} else if (mode === "--verify-static") {
  verifyStatic();
  console.log("verified offline Kubara + ConfigHub release acceptance inputs");
} else {
  verifyStatic();
  verifyFinalState();
  for (const item of finalCommands) run(item);
  console.log("verified final Kubara + ConfigHub release acceptance");
}

function command(id, script, ...args) {
  return { id, script, args, display: ["node", script, ...args].join(" ") };
}

function expectedContract() {
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraConfigHubReleaseAcceptance",
    metadata: { name: "kubara-v0-13-0-confighub-mini-idp" },
    spec: {
      outcome: "ConfigHub simplifies Kubara without making it fundamentally different.",
      operatingModel: "Kubara composes; ConfigHub governs; Argo reconciles.",
      deliveryAuthority: kubaraDeliveryAuthority,
      adoption: {
        requiredAIRewrite: false,
        kubaraConfigAndOverridesRetained: true,
        catalogGenerationParity: "byte-for-byte",
        kubaraVersion: "v0.13.0",
        kubaraCatalogVersion: "1.1.0",
        clusters: 4,
        selectedPlatformRoles: 7,
        applications: ["hx-web", "cubbychat"],
        reconcilerPlan: {
          spaces: 55,
          managedUnits: 63,
          deployments: 27,
          needsProvidesLinks: 25,
          payloadsBeforeFaithfulEvidence: 55,
          payloadsReadyForApply: 56,
          orphanAuditAllowlist: {
            spaces: 55,
            units: 105,
            links: 64,
            targets: 4,
            currentReleaseStreams: 35,
            argoApplications: 35,
            completeConfigHubInventory: true,
            auditedKubernetesResourceTypes: ["deployments.apps", "statefulsets.apps", "daemonsets.apps", "cronjobs.batch", "jobs.batch", "four-protected-namespaces"],
            clusterWideKubernetesInventory: false,
          },
        },
        desiredMatrixRows: 36,
      },
      catalog: {
        role: "component-first",
        retention: "additive-only-non-overwrite",
        exactVersionPolicy: "fail-if-missing",
        baselineRootVersions: baseline.count,
        historicalAdditions: historicalAdditions.length,
        currentAdditions: currentAdditions.length,
        qualifiedIntermediateRootVersions: baseline.count + additions.length,
        fullCoverageAdditions: fullCoverageAdditions.length,
        expectedFinalRootVersions: finalCatalogVersionCount,
        expectedFinalComponents: finalCatalogComponentCount,
        baselineRecipesTreeSHA256: baseline.recipesTreeSHA256,
        baselinePackagesTreeSHA256: baseline.packagesTreeSHA256,
        historicalAdditionPaths: historicalAdditions,
        currentAdditionPaths: currentAdditions,
        fullCoverageAdditionPaths: fullCoverageAdditions,
        requiredOciPublicationPackages: [
          ...KUBARA_OCI_PACKAGES,
          ...KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.packagePath),
        ],
        promotionSafety: {
          baselineLock: "110 recipe roots and 110 package roots are byte-locked",
          ordering: "historical-7-then-current-3",
          overwritePolicy: "never-overwrite-existing-bytes",
          retryPolicy: "fill-missing-files-and-accept-only-byte-identical-residue",
          fullCoverageBaseline: `the ${KUBARA_CATALOG_1_1_BASELINE.versionCount}-root intermediate Catalog is byte-locked before the final additive wave`,
          requiredReceipts: [
            ...KUBARA_PROMOTION_RECEIPTS,
            "data/kubara-catalog-1.1-full-coverage/preflight-receipt.yaml",
            "data/kubara-catalog-1.1-full-coverage/receipt.yaml",
          ],
        },
        publicationSafety: {
          scope: "two explicitly enumerated ten-package additive waves",
          retryPolicy: "reuse-only-an-existing-identical-layer",
          conflictPolicy: "refuse-existing-different-layer",
          verification: "local-source-tree-and-archive-plus-remote-manifest-and-layer",
        },
      },
      orderedReleaseCommands: [
        "npm run kubara-release:verify-static",
        "npm run kubara-git-handoff:verify-current",
        "npm run kubara-git-handoff:self-test",
        "npm run kubara-git-import:self-test",
        "npm run kubara-live-qualification:preflight",
        "npm run kubara-live-qualification:run",
        "npm run kubara-live-qualification:verify",
        "npm run kubara-current-live-qualification:preflight",
        "npm run kubara-current-live-qualification:run",
        "npm run kubara-current-live-qualification:verify",
        "npm run kubara-catalog-promotion:dry-run",
        "npm run kubara-catalog-promotion:stage",
        "npm run kubara-catalog-promotion:stage:verify",
        "npm run kubara-catalog-promotion:promote",
        "npm run kubara-catalog-promotion:verify",
        "npm run kubara-current-catalog-promotion:dry-run",
        "npm run kubara-current-catalog-promotion:stage",
        "npm run kubara-current-catalog-promotion:stage:verify",
        "npm run kubara-current-catalog-promotion:promote",
        "npm run kubara-current-catalog-promotion:verify",
        "npm run kubara-catalog-oci:dry-run",
        "npm run kubara-catalog-oci:publish",
        "npm run kubara-catalog-oci:verify",
        "npm run kubara-catalog-full-coverage:generate",
        "npm run kubara-catalog-full-coverage:verify-candidates",
        "npm run kubara-catalog-full-coverage:preflight",
        "npm run kubara-catalog-full-coverage:promote",
        "npm run kubara-catalog-full-coverage:publish",
        "npm run kubara-catalog-full-coverage:verify",
        "npm run kubara-faithful-hub-spoke:rehearse",
        "npm run kubara-faithful-hub-spoke:run",
        "npm run kubara-faithful-hub-spoke:generate",
        "npm run kubara-faithful-hub-spoke:verify",
        "npm run kubara-mini-idp:plan",
        "npm run kubara-mini-idp:apply",
        "npm run kubara-mini-idp:apply",
        "npm run kubara-mini-idp:verify",
        "npm run kubara-mini-idp:receipt-verify",
        "npm run kubara-mini-idp:performance-contract:verify",
        "npm run kubara-mini-idp:performance:self-test",
        "npm run kubara-mini-idp:orphan-plan",
        "npm run kubara-mini-idp:orphan-audit:self-test",
        "npm run kubara-mini-idp:orphan-audit",
        "npm run kubara-mini-idp:orphan-audit:receipt-verify",
        "npm run kubara-mini-idp:performance:receipt-verify",
        "npm run kubara-platform-matrix:generate",
        "npm run kubara-platform-matrix:verify",
        "npm run kubara-catalog-release:generate",
        "npm run kubara-catalog-release:verify",
        "npm run kubara-release:verify",
      ],
      gates: [
        gate("catalog-alignment", "Immutable upstream snapshots, byte-preserving aligned exports, all 18 exact Kubara catalogs 1.1.0 selections, and an additive 103-component/130-version Catalog.", [
          "kubara-catalog-adapter:verify",
          "kubara-catalog-candidates:verify",
          "kubara-current-catalog-candidates:verify",
          "kubara-catalog-promotion:verify",
          "kubara-current-catalog-promotion:verify",
          "kubara-catalog-oci:self-test",
          "kubara-catalog-oci:verify",
          "kubara-catalog-full-coverage:self-test",
          "kubara-catalog-full-coverage:verify-candidates",
          "kubara-catalog-full-coverage:verify",
        ]),
        gate("current-example", "Kubara v0.13.0 generates the same 135 files from upstream and ConfigHub-aligned catalogs and yields 13 exact effective renders, including explicit healthy kind Traefik exposure.", [
          "kubara-current-example:verify",
          "kubara-effective-renders:verify",
        ]),
        gate("git-handoff-preparation", "One deterministic preparer converts an ordinary Kubara-generated worktree plus a reviewed exact artifact lock into a separate clean, importer-compatible Git subtree; the current 13-render fixture is committed and offline-verifiable.", [
          "kubara-git-handoff:verify-current",
          "kubara-git-handoff:self-test",
        ]),
        gate("git-revision-import", "One deterministic command path compiles an immutable Kubara Git revision, publishes component-first OCI packages, reconciles the exact user-selected ConfigHub organization and cluster-local Argo delivery Applications, and requires a second zero-action apply receipt without using AI.", [
          "kubara-git-import:self-test",
          "kubara-selected-org:self-test",
          "kubara-app-release:self-test",
          "kubara-app-release-runner:self-test",
          "kubara-adoption:self-test",
        ]),
        gate("live-qualification", "Historical and current exact chart selections each retain a serial 13-lane live qualification receipt.", [
          "kubara-live-qualification:verify",
          "kubara-current-live-qualification:verify",
        ]),
        gate("matrix-and-wiring", "Current and retained historical component-by-cluster and dependency views are reproducible generated data.", [
          "kubara-wiring:verify",
          "kubara-platform-matrix:verify",
        ]),
        gate("mini-idp", "One idempotent reconciler owns the four-cluster platform, hx-web, cubbychat, governance controls, matrix, and visible wiring evidence; ConfigHub selects the exact release, every managed Argo Application has automated sync disabled, and Argo reconciles only a revalidated ManifestDigest operation submitted with Kubernetes identity compare-and-set; its receipt requires an initial reconciliation followed by a zero-action rerun, plus exact ConfigHub inventory and zero residue in the declared Argo/workload audit scope.", [
          "kubara-mini-idp:receipt-verify",
          "kubara-mini-idp:orphan-audit:receipt-verify",
        ]),
        gate("mini-idp-performance", "The accepted live receipt ends with an adjacent changed apply and immediate zero-action apply under one execution fingerprint; both retain schema-v2 measurements within the four-cluster fixture budgets and the pair is backed by the scoped residue audit.", [
          "kubara-mini-idp:performance-contract:verify",
          "kubara-mini-idp:performance:self-test",
          "kubara-mini-idp:performance:receipt-verify",
        ]),
        gate("faithful-hub-spoke", "The unchanged Kubara hub Argo CD to registered spoke topology is retained as the faithful lane.", [
          "kubara-faithful-hub-spoke:verify",
        ]),
        gate("public-release", "The linear website path uses current v0.13 evidence while retaining v0.12 as historical compatibility evidence.", [
          "catalog:status:verify",
          "catalog:maps:verify",
          "catalog:index:verify",
          "catalog:review:verify",
          "installer-oci:catalog:verify",
          "npm-scripts:catalog:verify",
          "kubara-catalog-release:verify",
          "site:verify",
          "kubara-release:verify",
        ]),
      ],
      offlineVerification: [
        ...offlineCommands.map((item) => item.display),
        "node scripts/reconcile-kubara-mini-idp.mjs --plan",
      ],
      finalVerification: finalCommands.map((item) => item.display),
      requiredEvidence: {
        currentExample: "examples/kubara/current-platform/generation-receipt.yaml",
        preparedGitHandoff: "examples/kubara/prepared-current-platform/preparation-receipt.yaml",
        catalogParity: "examples/kubara/current-platform/catalog-parity-receipt.yaml",
        currentMatrix: "data/kubara-platform-matrix/matrix.json",
        currentWiring: "data/kubara-wiring/graph.json",
        faithfulLane: "runs/kubara-faithful-hub-spoke/receipt.yaml",
        miniIdp: "runs/kubara-mini-idp-reconcile/receipt.yaml",
        miniIdpOrphans: "runs/kubara-mini-idp-reconcile/orphan-audit.yaml",
        miniIdpPerformanceAcceptance: "data/kubara-mini-idp-performance/contract.yaml",
        historicalLiveQualification: "runs/kubara-live-qualification/receipt.yaml",
        currentLiveQualification: "runs/kubara-current-live-qualification/receipt.yaml",
        historicalPromotion: "data/kubara-catalog-refresh/root-promotion/receipt.yaml",
        currentPromotion: "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml",
        fullCatalogCoverage: "data/kubara-catalog-1.1-full-coverage/receipt.yaml",
        rootCatalog: "CATALOG.md",
        installerCatalog: "data/installer-oci-packages/packages.json",
        buyerPage: "site/kubara.html",
        adoptionTutorial: "site/d/docs/demo/kubara/adoption.html",
        evidenceCheckpoints: "site/d/docs/demo/kubara/checkpoints.html",
        guiTour: "site/d/docs/demo/kubara/gui-tour.html",
        technicalRunbook: "site/d/docs/demo/kubara/single-platform.html",
        adoptionScreenshotContract: kubaraAdoptionScreenshotContractRelative,
      },
      adoptionScreenshotEvidenceContract: {
        tutorialSource: kubaraBuyerJourneySources.tutorial,
        requiredFrames: kubaraAdoptionScreenshotFrames.length,
        publicationPolicy: "publish-only-after-all-six-steps-have-source-current-real-evidence",
        screenshotReceiptWhenPublished: kubaraAdoptionScreenshotReceipt,
        screenshotDirectoryWhenPublished: kubaraAdoptionScreenshotDirectory,
        staticVerificationRequiresScreenshots: false,
        finalVerificationRequiresScreenshots: true,
        finalCurrentVerificationRequiresScreenshots: true,
      },
      guiEvidenceContract: {
        tourSource: kubaraBuyerJourneySources.guiTour,
        requiredTourFrames: 6,
        publicationPolicy: "publish-only-after-source-current-faithful-mini-idp-idempotence-performance-health-and-orphan-receipts-pass",
        screenshotReceiptWhenPublished: kubaraGuiEvidenceReceipt,
        screenshotDirectoryWhenPublished: "docs/images/kubara",
        staticVerificationRequiresScreenshots: false,
        finalVerificationRequiresScreenshots: true,
        requiredSharedMetadata: [
          "sourceCommit",
          "organizationExternalID",
          "organizationInternalID",
          "faithfulReceiptSHA256",
          "miniIdpReceiptSHA256",
          "orphanReceiptSHA256",
          "matrixSHA256",
          "wiringSHA256",
        ],
        requiredPerImageMetadata: [
          "path",
          "sha256",
          "capturedAt",
          "visibleIdentities",
          "sensitiveValues",
          "caption",
          "claimBoundary",
        ],
      },
      claimBoundary: [
        "The static verifier proves deterministic committed inputs and generated outputs; it does not turn missing live receipts into passes.",
        "The full verifier fails until both live qualification sets, both additive promotions, the faithful lane, the mini-IDP reconciliation, and the public site verify.",
        "The first mini-IDP apply writes a pending-idempotence receipt; the immediately repeated apply must record zero actions before receipt and release verification can pass.",
        "The scoped residue audit is a separate receipt and must pass before the website can claim exact ConfigHub inventory or zero Argo-prunable and audited durable-workload residue; it is not a complete inventory of every Kubernetes resource type.",
        "A green website claim is derived only from mutually consistent faithful, mini-IDP, orphan, schema-v2 performance, matrix, wiring, and exactly six published GUI evidence hashes.",
        "The exact-digest authority contract controls the importer-managed automated delivery path; privileged human or manual Argo sync remains outside the claim unless separate RBAC or admission evidence proves otherwise.",
        "AI may propose future wiring, but no required adoption, generation, reconciliation, or verification step depends on AI.",
      ],
    },
  };
}

function expectedKubaraAdoptionScreenshotContract() {
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraConfigHubAdoptionScreenshotContract",
    metadata: { name: "kubara-config-hub-six-step-adoption" },
    spec: {
      tutorialSource: kubaraBuyerJourneySources.tutorial,
      requiredFrames: kubaraAdoptionScreenshotFrames.length,
      orderedFrames: kubaraAdoptionScreenshotFrames,
      screenshotDirectoryWhenPublished: kubaraAdoptionScreenshotDirectory,
      receiptWhenPublished: kubaraAdoptionScreenshotReceipt,
      staticVerificationRequiresScreenshots: false,
      finalVerificationRequiresScreenshots: true,
      finalCurrentVerificationRequiresScreenshots: true,
      publicationPolicy: "one-real-source-current-frame-per-adoption-step-after-that-step-machine-checkpoint-and-the-complete-live-gate-pass",
      imagePolicy: {
        format: "PNG",
        minimumWidth: 800,
        minimumHeight: 450,
        mockupsAllowed: false,
        crossRevisionCompositesAllowed: false,
      },
      sourceBinding: {
        repository: "https://github.com/confighub/helm-expt.git",
        selectedPath: "examples/kubara/prepared-current-platform",
        requiredFields: ["commit", "repositoryTree", "selectedPathTree"],
      },
      organizationBinding: {
        name: "Kubara",
        externalID: "58b23b85-9699-4384-bd57-80ef695a1d58",
        internalID: "12c33fa8-00b1-4011-ad3e-19d56458b29c",
        serverURL: "https://hub.confighub.com",
      },
      sharedEvidence: kubaraAdoptionScreenshotEvidence,
      receiptShape: {
        kind: "KubaraConfigHubAdoptionScreenshotReceipt",
        contractFields: ["path", "sha256"],
        sourceFields: ["repository", "commit", "repositoryTree", "selectedPath", "selectedPathTree"],
        organizationFields: ["name", "externalID", "internalID", "serverURL"],
        evidenceRecordFields: ["id", "path", "sha256"],
        status: { result: "pass", sourceCurrent: true, frameCount: kubaraAdoptionScreenshotFrames.length },
      },
      requiredPerImageMetadata: [
        "step",
        "id",
        "path",
        "sha256",
        "capturedAt",
        "visibleIdentities",
        "evidenceBindings",
        "sensitiveHandling",
        "caption",
        "claimBoundary",
      ],
      claimBoundary: [
        "A screenshot illustrates a machine-accepted step; it never replaces the machine checkpoint or evidence receipt.",
        "All six frames must bind the same exact source commit and Git trees.",
        "The OCI frame shows the deterministic isolated importer self-test and its fake OCI surface; it does not claim a live registry publication, ConfigHub materialization, or cluster health.",
        "The selected-organization frame proves visible topology, not workload convergence by itself.",
        "Only the application frame may illustrate the current governance and live-result claim, and it remains bound to mini-IDP, orphan, matrix, and wiring evidence.",
        "The six adoption frames are independent of the exactly-six-frame ConfigHub GUI tour contract.",
      ],
    },
  };
}

function gate(id, outcome, scripts) {
  return { id, outcome, packageScripts: scripts };
}

function verifyStatic() {
  check(existsSync(contractPath), `${contractRelative} is missing; run npm run kubara-release:generate`);
  check(stableJson(readYaml(contractPath)) === stableJson(expectedContract()), `${contractRelative} is stale`);
  check(
    existsSync(kubaraAdoptionScreenshotContractPath),
    `${kubaraAdoptionScreenshotContractRelative} is missing; run npm run kubara-release:generate`,
  );
  check(
    stableJson(readYaml(kubaraAdoptionScreenshotContractPath))
      === stableJson(expectedKubaraAdoptionScreenshotContract()),
    `${kubaraAdoptionScreenshotContractRelative} is stale`,
  );
  verifyPackageCommands();
  verifyBaselineRetention();
  verifyCandidateSets();
  verifyCurrentShape();
  verifyMiniIdpPlan();
  verifySiteConsumption();
  for (const item of offlineCommands) run(item);
}

function verifyPackageCommands() {
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ?? {};
  for (const [name, expected] of Object.entries(packageCommands)) {
    check(scripts[name] === expected, `package script ${name} must be exactly: ${expected}`);
  }
}

function verifyBaselineRetention() {
  const allDeclaredAdditions = new Set([...additions, ...fullCoverageAdditions]);
  const fullCoverageAdditionSet = new Set(fullCoverageAdditions);
  for (const rootName of ["recipes", "packages"]) {
    const roots = versionRoots(rootName);
    const relativeRoots = roots.map((path) => path.slice(rootName.length + 1));
    const legacy = roots.filter((path) => !allDeclaredAdditions.has(path.slice(rootName.length + 1)));
    check(legacy.length === baseline.count, `${rootName}: expected ${baseline.count} retained baseline versions, found ${legacy.length}`);
    const expected = rootName === "recipes" ? baseline.recipesTreeSHA256 : baseline.packagesTreeSHA256;
    check(treeSetDigest(legacy) === expected, `${rootName}: a retained baseline version was removed or changed`);
    const retained120 = roots.filter((path) => !fullCoverageAdditionSet.has(path.slice(rootName.length + 1)));
    const expected120 = rootName === "recipes"
      ? KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256
      : KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256;
    check(
      retained120.length === KUBARA_CATALOG_1_1_BASELINE.versionCount
        && treeSetDigest(retained120) === expected120,
      `${rootName}: the immutable 120-root Catalog baseline was removed or changed`,
    );
    check(relativeRoots.every((path) => legacy.includes(`${rootName}/${path}`) || allDeclaredAdditions.has(path)), `${rootName}: undeclared version root exists`);
    check(roots.length <= finalCatalogVersionCount, `${rootName}: release scope exceeds the declared ${finalCatalogVersionCount}-version acceptance set`);
  }
}

function verifyCandidateSets() {
  const historical = readYaml(join(repoRoot, "data/kubara-catalog-refresh/candidates/candidate-set.yaml"));
  const current = readYaml(join(repoRoot, "data/kubara-catalog-refresh/current-candidates/candidate-set.yaml"));
  check(historical.kind === "KubaraCatalogCandidateSet", "historical candidate-set kind changed");
  check(historical.spec?.candidates?.length === historicalAdditions.length, "historical candidate set must retain seven additions");
  check(current.kind === "KubaraCatalogCandidateSet", "current candidate-set kind changed");
  check(current.spec?.exactPublicArtifactCount === 7, "current candidate set must map seven exact public artifacts");
  check(current.spec?.additiveVersionCount === currentAdditions.length, "current candidate set must contain three additions");
  for (const relativePath of historicalAdditions) verifyCandidatePath("data/kubara-catalog-refresh/candidates", relativePath);
  for (const relativePath of currentAdditions) verifyCandidatePath("data/kubara-catalog-refresh/current-candidates", relativePath);
}

function verifyCandidatePath(root, relativePath) {
  for (const kind of ["recipes", "packages"]) {
    const path = join(repoRoot, root, kind, relativePath);
    check(existsSync(path), `${relativeRepo(path)} is missing`);
  }
}

function verifyCurrentShape() {
  const exampleRoot = join(repoRoot, "examples/kubara/current-platform");
  const lock = readYaml(join(exampleRoot, "source-lock.yaml"));
  const config = readYaml(join(exampleRoot, "source/config.yaml"));
  const generation = readYaml(join(exampleRoot, "generation-receipt.yaml"));
  const parity = readYaml(join(exampleRoot, "catalog-parity-receipt.yaml"));
  const apps = readYaml(join(exampleRoot, "apps/source-lock.yaml"));
  check(lock.spec?.kubara?.version === "v0.13.0", "current example Kubara version changed");
  check(String(lock.spec?.catalogs?.version) === "1.1.0", "current example catalog version changed");
  check(config.clusters?.length === 4, "current example must retain one hub and three spokes");
  check(config.clusters.filter((cluster) => cluster.type === "hub").length === 1, "current example must retain exactly one hub");
  check(config.clusters.filter((cluster) => cluster.type === "spoke").length === 3, "current example must retain exactly three spokes");
  const selectedServices = new Set(config.clusters.flatMap((cluster) => Object.entries(cluster.services ?? {}).filter(([, service]) => service.status === "enabled").map(([name]) => name)));
  check(selectedServices.size === 6 && config.clusters.some((cluster) => cluster.argocd?.selfManaged === "enabled"), "current example must retain seven selected platform roles including hub Argo CD");
  check(generation.spec?.outputs?.generatedFileCount === 135, "current example generated file count changed");
  check(generation.spec?.platform?.renderCount === 13, "current example effective render count changed");
  check(parity.status?.generatedTrees === "byte-for-byte-equal", "current example catalog generation parity is not byte-for-byte");
  check(apps.kind === "KubaraMiniIDPApplicationSourceLock", "mini-IDP application source lock kind changed");
  check(Boolean(apps.spec?.hxWeb?.image?.pinned), "hx-web image digest pin is missing");
  check(Boolean(apps.spec?.cubbychat?.upstream?.commit), "cubbychat source commit pin is missing");
  check(Object.keys(apps.spec?.cubbychat?.images ?? {}).length === 3, "cubbychat must retain three image digest pins");
  const appYaml = listFiles(join(exampleRoot, "apps")).filter((path) => path.endsWith(".yaml") && !path.endsWith("source-lock.yaml"));
  check(appYaml.length === 15, `expected 15 one-object mini-IDP app manifests, found ${appYaml.length}`);
}

function verifySiteConsumption() {
  const source = readFileSync(join(repoRoot, "scripts/generate-public-site.mjs"), "utf8");
  for (const needle of [
    "${catalog.installerOciPackages.length}",
    "retainedVersionPageHtml",
    "data-retained-version",
    "data-publication-receipt",
    "data-packaged-configurations",
    "publicCatalogComponents",
    "retained published package versions",
    "docs/demo/kubara/single-platform.md",
    "d/docs/demo/kubara/platform-evidence.html",
    "examples/kubara/current-platform",
    "examples/kubara/prepared-current-platform",
  ]) check(source.includes(needle), `public-site generator does not consume ${needle}`);
  for (const path of [
    "docs/demo/kubara/single-platform.md",
    "docs/demo/kubara/platform-evidence.md",
    "examples/kubara/git-import/README.md",
    "examples/kubara/git-import/request.example.yaml",
    "examples/kubara/git-import/current-platform.prepare.yaml",
    "examples/kubara/prepared-current-platform/preparation-receipt.yaml",
    "examples/kubara/prepared-current-platform/generation-receipt.yaml",
    "examples/kubara/prepared-current-platform/checksums.txt",
    "examples/kubara/prepared-current-platform/wiring/graph.json",
    "scripts/prepare-kubara-git-handoff.mjs",
    "scripts/import-kubara-git-revision.mjs",
    "data/kubara-platform-matrix/matrix.html",
    "data/kubara-platform-matrix/matrix.json",
    "data/kubara-wiring/graph.html",
    "data/kubara-wiring/graph.json",
  ]) check(existsSync(join(repoRoot, path)), `${path} is missing`);
  verifyKubaraPublicSourceContract();
  verifyKubaraSiteEvidenceGate({ requireCurrent: false });
}

function verifyKubaraPublicSourceContract() {
  verifyKubaraBuyerJourneySourceContract();
  const adoption = collapseWhitespace(readFileSync(join(repoRoot, "docs/demo/kubara/single-platform.md"), "utf8"));
  const evidence = collapseWhitespace(readFileSync(join(repoRoot, "docs/demo/kubara/platform-evidence.md"), "utf8"));
  const importerGuide = collapseWhitespace(readFileSync(join(repoRoot, "examples/kubara/git-import/README.md"), "utf8"));
  const importerRequest = readFileSync(join(repoRoot, "examples/kubara/git-import/request.example.yaml"), "utf8");
  const importerSource = readFileSync(join(repoRoot, "scripts/import-kubara-git-revision.mjs"), "utf8");
  const historicalRollout = collapseWhitespace(readFileSync(join(repoRoot, "docs/demo/kubara/app-rollout.md"), "utf8"));
  const matrix = JSON.parse(readFileSync(join(repoRoot, "data/kubara-platform-matrix/matrix.json"), "utf8"));
  const graph = JSON.parse(readFileSync(join(repoRoot, "data/kubara-wiring/graph.json"), "utf8"));
  const matrixHtml = readFileSync(join(repoRoot, "data/kubara-platform-matrix/matrix.html"), "utf8");
  const wiringHtml = readFileSync(join(repoRoot, "data/kubara-wiring/graph.html"), "utf8");
  const expected = expectedContract().spec.adoption;

  check(expected.desiredMatrixRows === 36, "Kubara public source contract must retain 36 current matrix cells");
  check(matrix.spec?.scope?.cells === expected.desiredMatrixRows, `current Kubara matrix must contain ${expected.desiredMatrixRows} cells`);
  check(matrix.spec?.rows?.length === expected.desiredMatrixRows, `current Kubara matrix must expose ${expected.desiredMatrixRows} rows`);
  check(expected.reconcilerPlan.needsProvidesLinks === 25, "Kubara public source contract must retain 25 curated GUI Links");
  check(graph.spec?.summary?.needs > expected.reconcilerPlan.needsProvidesLinks, "the full extracted wiring graph must remain larger than the curated GUI Link inventory");

  for (const app of ["hx-web", "cubbychat"]) {
    check(adoption.includes(app), `Kubara adoption source must name ${app}`);
    check(evidence.includes(app), `Kubara evidence source must name ${app}`);
  }
  for (const phrase of [
    "55 Spaces",
    "63 managed Units",
    "`component-catalog-coverage`",
    "`CatalogComponents=103`",
    "`CatalogVersions=130`",
    "`Component=argo-cd`",
    "`Component=argobot`",
    "`hx-argo-base`",
    "`hx-argo-runtime-base`",
    "v3.4.5",
    "v3.4.6",
    "`Lane=Faithful`",
    "`Lane=Adapted`",
    "`Relationship=NeedsProvides`",
    "`Environment=Prod`",
    "`DeliveryMode=ConfigHubOCI`",
    "`URL-Catalog`",
    "130 retained",
    "six adoption steps",
    "prepare-kubara-git-handoff.mjs",
    "current-platform.prepare.yaml",
    "`examples/kubara/prepared-current-platform`",
    "kubara-git-handoff:verify-current",
    "167 checked files",
    "--package",
    "--apply",
    "apply-receipt.json",
  ]) check(adoption.includes(phrase), `Kubara adoption source must expose the current GUI/import boundary: ${phrase}`);
  for (const phrase of [
    "prepare-kubara-git-handoff.mjs",
    "current-platform.prepare.yaml",
    "prepared-current-platform",
    "normal Kubara generation path",
    "--generate",
    "--compile",
    "--verify",
    "--package",
    "--apply",
    "apply-receipt.json",
    "cluster-local Argo",
    "zero-action",
  ]) check(importerGuide.includes(phrase), `Kubara importer guide must expose the linear adoption step: ${phrase}`);
  for (const phrase of [
    "context:",
    "organizationExternalID:",
    "organizationID:",
    "serverURL:",
    "spaceID:",
    "targetID:",
    "appsSpaceID:",
  ]) check(importerRequest.includes(phrase), `Kubara importer request must pin ${phrase}`);
  for (const [name, html] of [["matrix", matrixHtml], ["wiring", wiringHtml]]) {
    check(html.includes("https://confighub.github.io/helm-expt/site/kubara.html"), `${name} HTML must link back to the Kubara buyer and adoption journey`);
    check(html.includes("https://confighub.github.io/helm-expt/site/charts/"), `${name} HTML must link to the retained component-first Catalog`);
  }
  check(matrixHtml.includes("Argo sync") && !matrixHtml.includes("ConfigHub sync"), "current platform matrix must identify controller state as Argo sync, not ConfigHub sync");
  for (const stale of [
    "`--package` and `--apply` deliberately fail",
    "`--package` and `--apply` fail intentionally",
    "Generic OCI publication and organization apply are explicitly refused",
    "Publication and live reconciliation are intentionally not implemented here",
  ]) {
    check(!adoption.includes(stale), `Kubara adoption source retains obsolete importer wording: ${stale}`);
    check(!importerGuide.includes(stale), `Kubara importer guide retains obsolete importer wording: ${stale}`);
    check(!importerSource.includes(stale), `Kubara importer source retains obsolete implementation wording: ${stale}`);
  }
  for (const url of [
    "https://confighub.github.io/helm-expt/site/kubara.html",
    "https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html",
    "https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html",
  ]) {
    check(adoption.includes(url), `Kubara adoption source must retain public link ${url}`);
    check(evidence.includes(url), `Kubara evidence source must retain public link ${url}`);
  }
  check(adoption.includes("https://confighub.github.io/helm-expt/site/charts/"), "Kubara adoption source must link the full retained component Catalog");
  for (const phrase of [
    "desired-only matrix",
    "public matrix is regenerated from that desired state plus receipt evidence",
    "After an accepted live run, the ConfigHub GUI must show 25 curated",
    "operational `NeedsProvides` Links",
    "public graph is the complete evidence view",
    "one 90-minute overall convergence deadline",
    "durable write-ahead operation journal",
    "pins context/external organization ID `58b23b85-9699-4384-bd57-80ef695a1d58` and internal organization entity ID `12c33fa8-00b1-4011-ad3e-19d56458b29c`",
    "All delivery Application Units are materialized and identity-checked before the first fleet-root release",
    "checkpointed in the durable write-ahead operation journal",
    "exact UID/resourceVersion",
    "`spec.source.targetRevision: latest`",
    "`spec.syncPolicy.automated`",
    "`ghcr.io/confighub/argobot:v0.1.6`",
    "`ARGO_SYNC_MODE=kubernetes`",
    "`ARGO_NAMESPACE=argocd`",
    "`ARGO_REFRESH_TYPE=hard`",
    "`operation.sync.revision=<ManifestDigest>`",
    "managed automated delivery path",
    "privileged human or manual Argo sync",
  ]) check(adoption.includes(phrase), `Kubara adoption source must preserve boundary: ${phrase}`);
  for (const phrase of [
    "The mini-IDP contract calls for exactly 25",
    "exact live receipt and orphan audit decide whether those Links are current",
    "The receipt-aware public matrix and complete extracted",
    "contains 36 cells: seven deployable platform roles plus hx-web and cubbychat",
    "The full graph preserves every extracted",
  ]) check(evidence.includes(phrase), `Kubara evidence source must preserve boundary: ${phrase}`);
  check(!evidence.includes("contains 28 cells"), "Kubara evidence source must not retain the pre-application 28-cell matrix claim");
  for (const phrase of [
    "Delivery authority superseded",
    "The force-sync behavior below is accurate",
    "for this retained v0.12 proof",
    "`spec.syncPolicy.automated` absent",
    "`targetRevision: latest` as discovery-only",
    "submit only the exact",
    "revalidated release `ManifestDigest`",
  ]) check(historicalRollout.includes(phrase), `historical Kubara app rollout must label superseded force-sync authority: ${phrase}`);
}

// The buyer-facing no-op cost numbers are measurements, not editorial choices.
// Every surface must quote the accepted receipt, so the expected phrases are
// constructed from the receipt instead of being hand-pinned literals that
// drift on every live re-recording.
function acceptedNoOpPerformanceEvidence() {
  const receipt = readYaml(join(repoRoot, kubaraMiniIdpReceiptRelative));
  const noOpRun = (receipt?.spec?.reconcileRuns ?? []).at(-1);
  check(
    noOpRun?.idempotentNoop === true && noOpRun?.result === "pass" && Number(noOpRun?.actionCount) === 0,
    `${kubaraMiniIdpReceiptRelative} must end with a passing zero-action idempotent run`,
  );
  const performance = noOpRun.performance ?? {};
  const readCommands = performance.confighub?.reads?.commands;
  const readCommandsBeforeFirstDevAccepted = performance.confighub?.reads?.beforeFirstDevAcceptedCommands;
  const subprocessCalls = performance.subprocesses?.calls;
  const wallElapsedMs = performance.wallElapsedMs;
  for (const [field, value] of Object.entries({
    readCommands,
    readCommandsBeforeFirstDevAccepted,
    subprocessCalls,
    wallElapsedMs,
  })) {
    check(
      Number.isInteger(value) && value > 0,
      `${kubaraMiniIdpReceiptRelative} accepted no-op performance.${field} must be a recorded positive integer`,
    );
  }
  check(
    performance.confighub?.mutations?.attempts === 0,
    `${kubaraMiniIdpReceiptRelative} accepted no-op must record zero ConfigHub mutation attempts`,
  );
  check(
    performance.argo?.syncRequests === 0,
    `${kubaraMiniIdpReceiptRelative} accepted no-op must record zero Argo sync requests`,
  );
  return {
    readCommands,
    readCommandsBeforeFirstDevAccepted,
    subprocessCalls,
    wallSeconds: Math.round(wallElapsedMs / 1000),
  };
}

// Any doc that quotes a no-op measurement must quote the receipt-backed value.
// A phrase pattern with a different number is a stale hand-edited claim.
function verifyKubaraMeasuredNoOpQuotes(noOp) {
  const expectations = [
    { pattern: /\b(\d+) ConfigHub CLI read commands\b/g, expected: noOp.readCommands, label: "ConfigHub CLI read commands", required: true },
    { pattern: /\b(\d+) total subprocess calls\b/g, expected: noOp.subprocessCalls, label: "total subprocess calls", required: true },
    { pattern: /\babout (\d+) seconds\b/g, expected: noOp.wallSeconds, label: "no-op wall seconds", required: true },
    { pattern: /\bwithin (\d+) reads\b/g, expected: noOp.readCommandsBeforeFirstDevAccepted, label: "reads through the first accepted dev Application", required: false },
  ];
  for (const path of kubaraMeasuredNoOpDocs) {
    const text = collapseWhitespace(readFileSync(join(repoRoot, path), "utf8"));
    for (const { pattern, expected, label, required } of expectations) {
      const matches = [...text.matchAll(pattern)];
      if (required) check(matches.length > 0, `${path} must quote the measured no-op ${label} from ${kubaraMiniIdpReceiptRelative}`);
      for (const match of matches) {
        check(
          Number(match[1]) === expected,
          `${path} quotes "${match[0]}" but ${kubaraMiniIdpReceiptRelative} records ${expected} for the accepted no-op ${label}`,
        );
      }
    }
  }
}

function verifyKubaraBuyerJourneySourceContract() {
  const sourcePaths = [
    ...Object.values(kubaraBuyerJourneySources),
    ...kubaraAdoptionChapters.map((chapter) => chapter.path),
  ];
  for (const path of sourcePaths) check(existsSync(join(repoRoot, path)), `${path} is missing from the Kubara buyer journey`);

  const overviewRaw = readFileSync(join(repoRoot, kubaraBuyerJourneySources.overview), "utf8");
  const tutorialRaw = readFileSync(join(repoRoot, kubaraBuyerJourneySources.tutorial), "utf8");
  const checkpointsRaw = readFileSync(join(repoRoot, kubaraBuyerJourneySources.checkpoints), "utf8");
  const guiTourRaw = readFileSync(join(repoRoot, kubaraBuyerJourneySources.guiTour), "utf8");
  const overview = collapseWhitespace(overviewRaw);
  const tutorial = collapseWhitespace(tutorialRaw);
  const checkpoints = collapseWhitespace(checkpointsRaw);
  const guiTour = collapseWhitespace(guiTourRaw);
  const generator = collapseWhitespace(readFileSync(join(repoRoot, "scripts/generate-public-site.mjs"), "utf8"));

  for (const phrase of [
    "ConfigHub simplifies Kubara without making it fundamentally different.",
    "Kubara composes. ConfigHub governs. Argo CD reconciles.",
    "This is an adoption path, not an AI-led rewrite.",
    "Why a Kubara user should prefer this",
    "Honest boundaries",
    "Graduation to a dedicated repository",
    "github.com/confighub/kubara-confighub",
  ]) check(overview.includes(phrase), `${kubaraBuyerJourneySources.overview} must preserve the buyer promise: ${phrase}`);
  checkInOrder(overview, [
    "1. **Choose platform components and wiring in Kubara.**",
    "2. **Run Kubara to generate the platform, add-ons, ApplicationSets, overrides, and cluster wiring.**",
    "3. **Commit and push the complete reviewed hand-off to Git.**",
    "4. **Run the deterministic ConfigHub importer against that exact Git revision; verify and publish immutable OCI packages.**",
    "5. **Load the result into the organization selected by the user and materialize the familiar topology as governed ConfigHub objects.**",
    "6. **Add, promote, and deploy applications through ConfigHub while Argo CD remains the cluster reconciler.**",
  ], `${kubaraBuyerJourneySources.overview} six-step buyer journey`);
  check(!overview.includes("7. **"), `${kubaraBuyerJourneySources.overview} must not introduce a competing seventh adoption step`);

  for (const phrase of [
    "function kubaraHtml(catalog)",
    "evaluateKubaraSiteLiveEvidence({ root: repoRoot })",
    "ConfigHub simplifies Kubara without making it fundamentally different.",
    "Kubara composes; ConfigHub governs; Argo reconciles.",
    "Benefits with explicit acceptance evidence",
    "The status is generated from an exact evidence chain",
    "The honest boundaries",
    "The implementation graduates to a future <code>github.com/confighub/kubara-confighub</code> repository only after",
    "const currentLive = facts.currentLive",
    "data-kubara-live-evidence=",
    "live performance receipt required",
    "${facts.noOpReadCommands} ConfigHub CLI read commands",
    "${facts.noOpSubprocessCalls} total subprocess calls",
    "about ${Math.round(facts.noOpWallMs / 1000)} seconds",
    "Make latest discoverable, not deployable",
    "<code>targetRevision: latest</code>",
    "<code>spec.syncPolicy.automated</code>",
    "<code>ARGO_SYNC_MODE=kubernetes</code>",
    "<code>operation.sync.revision=&lt;ManifestDigest&gt;</code>",
    "managed automated path",
    "manual Argo sync",
    "Applications across the whole cluster",
    "zero ApplicationSets",
    "Retained <code>release-N</code> Tags",
    "server-side publish preconditions",
  ]) check(generator.includes(phrase), `public-site generator must preserve the Kubara sales landing contract: ${phrase}`);
  check(
    !/\d+ ConfigHub CLI read commands|\d+ total subprocess calls|about \d+ seconds/.test(generator),
    "public-site generator must derive every no-op cost number from the receipt facts, never a hard-coded literal",
  );
  checkInOrder(generator, kubaraAdoptionChapters.map((chapter) => `../${chapter.path}`), "public-site Kubara landing chapter links");

  for (const phrase of [
    "This tutorial follows one continuous path",
    "It preserves the six adoption steps exactly",
    "The current importer does not create or guess an organization, Target, or cluster-local delivery runtime.",
    "The self-test proves the importer contract without claiming that a fresh live organization has already completed the same path.",
    "This is not yet a fresh-organization acceptance test.",
    "`targetRevision: latest` is discovery-only",
    "every managed Application omits `spec.syncPolicy.automated`",
    "Pinned argobot v0.1.6",
    "`operation.sync.revision=<ManifestDigest>`",
    "Kubernetes UID/resourceVersion compare-and-set and no active Argo operation",
    "Publication alone does not deploy mutable `latest`",
  ]) check(tutorial.includes(phrase), `${kubaraBuyerJourneySources.tutorial} must preserve the linear adoption boundary: ${phrase}`);
  checkInOrder(tutorialRaw, [
    "## Step 1:",
    "## Step 2:",
    "## Step 3:",
    "## Step 4:",
    "## Step 5:",
    "## Step 6:",
  ], `${kubaraBuyerJourneySources.tutorial} chapter sequence`);
  check(!/^## Step 7:/m.test(tutorialRaw), `${kubaraBuyerJourneySources.tutorial} must stop at the six user adoption steps`);
  const tutorialChapterLinks = new Set(
    [...tutorialRaw.matchAll(/\((adoption-[^)]+\.md)\)/g)].map((match) => match[1]),
  );
  const expectedChapterLinks = kubaraAdoptionChapters.map((chapter) => chapter.path.split("/").at(-1)).sort();
  check(
    stableJson([...tutorialChapterLinks].sort()) === stableJson(expectedChapterLinks),
    `${kubaraBuyerJourneySources.tutorial} must link exactly the six detailed adoption chapters`,
  );

  for (const chapter of kubaraAdoptionChapters) verifyKubaraAdoptionChapter(chapter);
  verifyKubaraAdoptionScreenshotContract({ requireCurrent: false });

  const organizationChapter = collapseWhitespace(readFileSync(join(
    repoRoot,
    "docs/demo/kubara/adoption-5-confighub-org.md",
  ), "utf8"));
  const applicationChapter = collapseWhitespace(readFileSync(join(
    repoRoot,
    "docs/demo/kubara/adoption-6-apps.md",
  ), "utf8"));
  for (const phrase of [
    "`spec.source.targetRevision: latest`",
    "`spec.syncPolicy.automated` is absent from every managed Application",
    "`argobot` is pinned to v0.1.6",
    "`ARGO_SYNC_MODE=kubernetes`",
    "`ARGO_NAMESPACE=argocd`",
    "`ARGO_REFRESH_TYPE=hard`",
    "`operation.sync.revision=<ManifestDigest>`",
    "`metadata.uid` and `metadata.resourceVersion` compare-and-set tests",
    "privileged human cannot issue a manual Argo sync",
    "Application inventory is cluster-wide",
    "Retained `release-N` Tags",
    "server-side publish preconditions",
  ]) check(organizationChapter.includes(phrase), `${kubaraAdoptionChapters[4].path} must preserve deployment authority: ${phrase}`);
  for (const phrase of [
    "Publication makes the release discoverable; it does not authorize Argo to deploy mutable `latest`.",
    "no `spec.syncPolicy.automated` field",
    "argobot v0.1.6",
    "accepts no active Argo operation",
    "`operation.sync.revision=<ManifestDigest>`",
    "`metadata.uid`/`metadata.resourceVersion` compare-and-set",
    "Treat retained `release-N` Tags as navigable history",
    "Applications across every namespace",
  ]) check(applicationChapter.includes(phrase), `${kubaraAdoptionChapters[5].path} must preserve exact development release authority: ${phrase}`);

  for (const phrase of [
    "Make `latest` discoverable, not deployable",
    "removes `spec.syncPolicy.automated` from every managed Application",
    "Kubernetes UID/resourceVersion compare-and-set when no operation is active",
    "privileged humans cannot issue a manual Argo sync",
  ]) check(overview.includes(phrase), `${kubaraBuyerJourneySources.overview} must explain the governed departure: ${phrase}`);

  const noOpEvidence = acceptedNoOpPerformanceEvidence();
  for (const phrase of [
    "Current deterministic",
    "Current live",
    "Historical live",
    "Waiting for current live proof",
    "Passing them does not synthesize a live receipt.",
    "Current live release checkpoint",
    "the exact ConfigHub inventory and scoped cluster audit report zero",
    "the public website is regenerated from those artifacts",
    `${noOpEvidence.readCommands} ConfigHub CLI read commands for the complete no-op run`,
    `${noOpEvidence.subprocessCalls} total subprocess calls`,
    `about ${noOpEvidence.wallSeconds} seconds`,
    "CLI commands are not HTTP round trips",
    "not a raw-Kubara comparison",
    "fixture regression target is met",
    "keeps `latest` discovery-only, and omits automated sync",
    "No second Argo owner is hidden from the normal view",
    "Retained release history is complete without becoming deployment authority",
  ]) check(checkpoints.includes(phrase), `${kubaraBuyerJourneySources.checkpoints} must preserve the evidence boundary: ${phrase}`);
  verifyKubaraMeasuredNoOpQuotes(noOpEvidence);
  checkInOrder(checkpoints, [
    "faithful hub/spoke evidence is regenerated",
    "the adapted v0.13 mini-IDP applies successfully",
    "an immediate second apply reports zero actions",
    "every required platform and application workload converges",
    "every Argo Application observes the exact current ConfigHub release",
    "the exact ConfigHub inventory and scoped cluster audit report zero",
    "the 36-cell matrix is regenerated",
    "native GUI Components, Units, Links, approvals, history, and OCI digests are inspected",
    "the public website is regenerated",
  ], `${kubaraBuyerJourneySources.checkpoints} live release sequence`);

  verifyKubaraGuiEvidenceContract(guiTourRaw, guiTour);
  for (const phrase of [
    "`targetRevision: latest` labelled as discovery-only",
    "`spec.syncPolicy.automated` absent from every managed Application",
    "`ARGO_SYNC_MODE=kubernetes`",
    "`operation.sync.revision=<ManifestDigest>`",
    "Kubernetes UID/resourceVersion compare-and-set",
    "privileged human cannot issue a manual Argo sync",
  ]) check(guiTour.includes(phrase), `${kubaraBuyerJourneySources.guiTour} must make deployment authority visible: ${phrase}`);
}

function verifyKubaraAdoptionChapter(chapter) {
  const raw = readFileSync(join(repoRoot, chapter.path), "utf8");
  const normalized = collapseWhitespace(raw);
  check(new RegExp(`^# Step ${chapter.number}:`, "m").test(raw), `${chapter.path} must be Step ${chapter.number}`);
  check(/^## (Your goal|Goal)$/mi.test(raw), `${chapter.path} must state the user's goal`);
  check(/^## What (stays|remains) Kubara$/mi.test(raw), `${chapter.path} must state what remains Kubara`);
  check(/^## What ConfigHub adds$/mi.test(raw), `${chapter.path} must state what ConfigHub adds`);
  check(/^## Expected (artifacts|ConfigHub state|state and evidence)$/mi.test(raw), `${chapter.path} must state its expected artifacts or state`);
  check(/^## Machine checkpoint$/mi.test(raw), `${chapter.path} must expose a machine checkpoint`);
  check(/^## Screens?hot/im.test(raw), `${chapter.path} must expose a screenshot checkpoint`);
  check(/^## Troubleshooting$/mi.test(raw), `${chapter.path} must include troubleshooting`);
  check(/^## Safe to stop( here)?$/mi.test(raw), `${chapter.path} must state when it is safe to stop`);
  check(raw.includes(`(${chapter.previous})`), `${chapter.path} must link backward to ${chapter.previous}`);
  check(raw.includes(`(${chapter.next})`), `${chapter.path} must link forward to ${chapter.next}`);
  check(
    /No screenshot|Do not substitute|No GitHub screenshot|after the checkpoint passes|Do not publish a current screenshot|After the current receipts pass/i.test(normalized),
    `${chapter.path} must keep screenshots behind the chapter checkpoint`,
  );
  check(
    /not present yet|not.*live|does not.*live|has not.*live|waiting for current live proof|after.*receipt.*pass|after the checkpoint passes/i.test(normalized),
    `${chapter.path} must not turn its deterministic checkpoint into an unqualified live claim`,
  );
}

function verifyKubaraAdoptionScreenshotContract({ requireCurrent }) {
  const contract = expectedKubaraAdoptionScreenshotContract();
  const frames = contract.spec.orderedFrames;
  const publishedPaths = [];

  for (const frame of frames) {
    const chapterPath = join(repoRoot, frame.chapter);
    const raw = readFileSync(chapterPath, "utf8");
    const relativeImagePath = relative(join(repoRoot, "docs/demo/kubara"), join(repoRoot, frame.imagePath))
      .replaceAll("\\", "/");
    const hook = `<!-- kubara-adoption-screenshot step="${frame.step}" id="${frame.id}" path="${relativeImagePath}" -->`;
    check(raw.split(hook).length === 2, `${frame.chapter} must contain exactly one adoption screenshot hook: ${hook}`);

    const markdownImages = [...raw.matchAll(/!\[([^\]]+)\]\(([^)]+)\)/g)]
      .map((match) => ({ alt: match[1].trim(), path: match[2] }));
    const htmlImages = [...raw.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
      .map((match) => ({ alt: "html-image", path: match[1] }));
    const adoptionImages = [...markdownImages, ...htmlImages].filter((item) =>
      item.path.includes("images/kubara-adoption/"));
    check(adoptionImages.length <= 1, `${frame.chapter} must publish at most its one contracted adoption frame`);
    if (adoptionImages.length === 1) {
      check(adoptionImages[0].path === relativeImagePath, `${frame.chapter} published the wrong adoption frame path`);
      check(Boolean(adoptionImages[0].alt), `${frame.chapter} adoption frame must have descriptive alt text`);
      publishedPaths.push(frame.imagePath);
    }
  }

  if (publishedPaths.length === 0) {
    check(
      !existsSync(join(repoRoot, kubaraAdoptionScreenshotReceipt)),
      `${kubaraAdoptionScreenshotReceipt} must not exist before all six real adoption frames are published`,
    );
    check(
      !requireCurrent,
      `final current-live verification requires all ${frames.length} adoption frames and ${kubaraAdoptionScreenshotReceipt}`,
    );
    return;
  }

  check(
    stableJson(publishedPaths) === stableJson(frames.map((frame) => frame.imagePath)),
    `adoption screenshots must be published as the exact ordered ${frames.length}-frame set; partial sets are refused`,
  );
  check(
    existsSync(join(repoRoot, kubaraAdoptionScreenshotReceipt)),
    `${kubaraAdoptionScreenshotReceipt} is required when adoption frames are published`,
  );

  const receipt = readYaml(join(repoRoot, kubaraAdoptionScreenshotReceipt));
  check(receipt.kind === "KubaraConfigHubAdoptionScreenshotReceipt", `${kubaraAdoptionScreenshotReceipt} kind changed`);
  check(receipt.status?.result === "pass", `${kubaraAdoptionScreenshotReceipt} must pass`);
  check(receipt.status?.sourceCurrent === true, `${kubaraAdoptionScreenshotReceipt} must declare sourceCurrent`);
  check(receipt.status?.frameCount === frames.length, `${kubaraAdoptionScreenshotReceipt} frameCount changed`);
  check(
    receipt.spec?.contract?.path === kubaraAdoptionScreenshotContractRelative,
    `${kubaraAdoptionScreenshotReceipt} must identify its screenshot contract`,
  );
  check(
    receipt.spec?.contract?.sha256 === sha256File(kubaraAdoptionScreenshotContractPath),
    `${kubaraAdoptionScreenshotReceipt} screenshot contract digest is stale`,
  );

  const source = receipt.spec?.source ?? {};
  const gitObjectPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  check(source.repository === contract.spec.sourceBinding.repository, `${kubaraAdoptionScreenshotReceipt} source repository changed`);
  check(gitObjectPattern.test(source.commit ?? ""), `${kubaraAdoptionScreenshotReceipt} must pin an exact Git commit`);
  check(gitObjectPattern.test(source.repositoryTree ?? ""), `${kubaraAdoptionScreenshotReceipt} must pin the source commit's Git tree`);
  check(source.selectedPath === contract.spec.sourceBinding.selectedPath, `${kubaraAdoptionScreenshotReceipt} selected source path changed`);
  check(gitObjectPattern.test(source.selectedPathTree ?? ""), `${kubaraAdoptionScreenshotReceipt} must pin the selected hand-off Git tree`);
  const resolvedCommit = execFileSync("git", ["rev-parse", "--verify", `${source.commit}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  check(resolvedCommit === source.commit, `${kubaraAdoptionScreenshotReceipt} source commit is not the exact local Git object`);
  const resolvedRepositoryTree = execFileSync("git", ["rev-parse", "--verify", `${source.commit}^{tree}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  check(resolvedRepositoryTree === source.repositoryTree, `${kubaraAdoptionScreenshotReceipt} repositoryTree does not belong to source commit`);
  const resolvedSelectedPathTree = execFileSync("git", ["rev-parse", "--verify", `${source.commit}:${source.selectedPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  check(resolvedSelectedPathTree === source.selectedPathTree, `${kubaraAdoptionScreenshotReceipt} selectedPathTree does not belong to source commit`);
  for (const [name, objectID] of [["repositoryTree", source.repositoryTree], ["selectedPathTree", source.selectedPathTree]]) {
    const objectType = execFileSync("git", ["cat-file", "-t", objectID], { cwd: repoRoot, encoding: "utf8" }).trim();
    check(objectType === "tree", `${kubaraAdoptionScreenshotReceipt} ${name} is not a Git tree object`);
  }

  check(
    stableJson(receipt.spec?.organization) === stableJson(contract.spec.organizationBinding),
    `${kubaraAdoptionScreenshotReceipt} must bind the exact selected ConfigHub organization`,
  );

  const expectedEvidenceByID = new Map(contract.spec.sharedEvidence.map((item) => [item.id, item]));
  const receiptEvidence = receipt.spec?.evidence ?? [];
  check(receiptEvidence.length === expectedEvidenceByID.size, `${kubaraAdoptionScreenshotReceipt} evidence set is incomplete`);
  check(new Set(receiptEvidence.map((item) => item.id)).size === receiptEvidence.length, `${kubaraAdoptionScreenshotReceipt} duplicates an evidence ID`);
  for (const record of receiptEvidence) {
    const expected = expectedEvidenceByID.get(record.id);
    check(Boolean(expected), `${kubaraAdoptionScreenshotReceipt} contains undeclared evidence ${record.id}`);
    check(record.path === expected.path, `${kubaraAdoptionScreenshotReceipt} ${record.id} path changed`);
    const evidencePath = join(repoRoot, record.path);
    check(existsSync(evidencePath) && statSync(evidencePath).isFile(), `${record.path} is missing`);
    check(record.sha256 === sha256File(evidencePath), `${kubaraAdoptionScreenshotReceipt} ${record.id} digest is stale`);
  }

  const faithfulReceipt = readYaml(join(repoRoot, expectedEvidenceByID.get("faithfulReceipt").path));
  check(
    faithfulReceipt.spec?.source?.git?.commit === source.commit,
    `${kubaraAdoptionScreenshotReceipt} source commit differs from the faithful Kubara Git witness`,
  );
  const miniIdpReceipt = readYaml(join(repoRoot, expectedEvidenceByID.get("miniIdpReceipt").path));
  const orphanReceipt = readYaml(join(repoRoot, expectedEvidenceByID.get("orphanReceipt").path));
  const evidenceObservedAt = [
    faithfulReceipt.spec?.observedAt,
    miniIdpReceipt.status?.observedAt,
    orphanReceipt.spec?.observedAt,
  ].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  check(evidenceObservedAt.length === 3, `${kubaraAdoptionScreenshotReceipt} live evidence timestamps are incomplete`);
  const latestEvidenceObservedAt = Math.max(...evidenceObservedAt);

  const receiptImages = receipt.spec?.images ?? [];
  check(receiptImages.length === frames.length, `${kubaraAdoptionScreenshotReceipt} must describe exactly ${frames.length} frames`);
  check(new Set(receiptImages.map((item) => item.path)).size === receiptImages.length, `${kubaraAdoptionScreenshotReceipt} duplicates an image path`);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const record = receiptImages[index];
    check(record.step === frame.step && record.id === frame.id, `${kubaraAdoptionScreenshotReceipt} frame ${index + 1} is out of order`);
    check(record.path === frame.imagePath, `${kubaraAdoptionScreenshotReceipt} ${frame.id} path changed`);
    const imagePath = join(repoRoot, record.path);
    check(existsSync(imagePath) && statSync(imagePath).isFile(), `${record.path} is missing`);
    const imageBytes = readFileSync(imagePath);
    check(
      imageBytes.length >= 24
        && imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      `${record.path} must be a real PNG frame`,
    );
    check(
      imageBytes.readUInt32BE(16) >= contract.spec.imagePolicy.minimumWidth
        && imageBytes.readUInt32BE(20) >= contract.spec.imagePolicy.minimumHeight,
      `${record.path} is too small to be legible adoption evidence`,
    );
    check(record.sha256 === sha256File(imagePath), `${kubaraAdoptionScreenshotReceipt} ${frame.id} image digest is stale`);
    check(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(record.capturedAt ?? "")
        && Number.isFinite(Date.parse(record.capturedAt)),
      `${kubaraAdoptionScreenshotReceipt} ${frame.id} must record an exact UTC capturedAt`,
    );
    check(
      Date.parse(record.capturedAt) >= latestEvidenceObservedAt,
      `${kubaraAdoptionScreenshotReceipt} ${frame.id} predates the accepted live evidence set`,
    );
    check(
      Array.isArray(record.visibleIdentities)
        && record.visibleIdentities.length > 0
        && record.visibleIdentities.every((item) => typeof item === "string" && item.trim().length > 0),
      `${kubaraAdoptionScreenshotReceipt} ${frame.id} must record non-empty visibleIdentities`,
    );
    check(
      stableJson(record.evidenceBindings) === stableJson(frame.evidenceBindings),
      `${kubaraAdoptionScreenshotReceipt} ${frame.id} must bind its exact relevant evidence`,
    );
    check(
      ["absent", "redacted"].includes(record.sensitiveHandling?.mode)
        && Boolean(record.sensitiveHandling?.detail),
      `${kubaraAdoptionScreenshotReceipt} ${frame.id} must record whether sensitive values were absent or redacted and how`,
    );
    check(Boolean(record.caption), `${kubaraAdoptionScreenshotReceipt} ${frame.id} must record its caption`);
    check(Boolean(record.claimBoundary), `${kubaraAdoptionScreenshotReceipt} ${frame.id} must record its claim boundary`);
  }

  const live = evaluateKubaraSiteLiveEvidence({ root: repoRoot });
  for (const name of ["faithful", "miniIdp", "orphan", "matrix", "wiring"]) {
    check(live[name].current, `${kubaraAdoptionScreenshotReceipt} ${name} evidence is not source-current:\n- ${live[name].reasons.join("\n- ")}`);
  }
}

function verifyKubaraGuiEvidenceContract(guiTourRaw, guiTour) {
  checkInOrder(guiTourRaw, [
    "### 1. Start at the platform contract",
    "### 2. Browse components before platform instances",
    "### 3. Show the recognizable delivery shape",
    "### 4. Follow one application through four clusters",
    "### 5. Open the wiring",
    "### 6. Finish with the fleet matrix and clean inventory",
  ], `${kubaraBuyerJourneySources.guiTour} tour sequence`);
  for (const phrase of [
    "Do not use a screenshot as current evidence merely because the UI looks plausible.",
    "Capture and publish the screenshot set only after the",
    "Each image must be tied to the same source commit, organization, receipt, and capture date.",
    "Explain, but do not spend the demo running",
    "Screenshot evidence contract",
    "capture date and UTC time",
    "exact source commit",
    "ConfigHub organization external and internal IDs",
    "exact faithful, mini-IDP, and orphan receipt hashes",
    "exact public matrix and full wiring graph hashes",
    "the screenshot file's own SHA-256 digest",
    "whether sensitive values were absent or redacted",
    "states exactly what the image proves and does not prove",
    "The website generator should refuse to present the screenshot set as current",
  ]) check(guiTour.includes(phrase), `${kubaraBuyerJourneySources.guiTour} must preserve the GUI evidence contract: ${phrase}`);

  const markdownImages = [...guiTourRaw.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const htmlImages = [...guiTourRaw.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  const imagePaths = [...new Set([...markdownImages, ...htmlImages])];
  if (imagePaths.length === 0) {
    check(!existsSync(join(repoRoot, kubaraGuiEvidenceReceipt)), `${kubaraGuiEvidenceReceipt} must not exist without a published GUI screenshot set`);
    return;
  }

  check(existsSync(join(repoRoot, kubaraGuiEvidenceReceipt)), `${kubaraGuiEvidenceReceipt} is required only after GUI screenshots are embedded`);
  const receipt = readYaml(join(repoRoot, kubaraGuiEvidenceReceipt));
  check(receipt.kind === "KubaraConfigHubGuiEvidenceReceipt", `${kubaraGuiEvidenceReceipt} kind changed`);
  check(receipt.status?.result === "pass", `${kubaraGuiEvidenceReceipt} must pass before GUI screenshots are published`);
  check(receipt.status?.sourceCurrent === true, `${kubaraGuiEvidenceReceipt} must be source-current before GUI screenshots are published`);
  check(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(receipt.spec?.sourceCommit ?? ""), `${kubaraGuiEvidenceReceipt} must pin an exact Git sourceCommit`);
  check(/^[0-9a-f-]{36}$/.test(receipt.spec?.organizationExternalID ?? ""), `${kubaraGuiEvidenceReceipt} must pin organizationExternalID`);
  check(/^[0-9a-f-]{36}$/.test(receipt.spec?.organizationInternalID ?? ""), `${kubaraGuiEvidenceReceipt} must pin organizationInternalID`);
  for (const field of KUBARA_GUI_REQUIRED_HASH_FIELDS) check(/^[0-9a-f]{64}$/.test(receipt.spec?.[field] ?? ""), `${kubaraGuiEvidenceReceipt} must pin ${field}`);
  check(imagePaths.length === expectedContract().spec.guiEvidenceContract.requiredTourFrames, `${kubaraBuyerJourneySources.guiTour} must publish exactly ${expectedContract().spec.guiEvidenceContract.requiredTourFrames} GUI frames`);
  const receiptImages = receipt.spec?.images ?? [];
  check(receiptImages.length === imagePaths.length, `${kubaraGuiEvidenceReceipt} must describe every published GUI screenshot exactly once`);
  check(new Set(receiptImages.map((item) => item.path)).size === receiptImages.length, `${kubaraGuiEvidenceReceipt} must not duplicate GUI screenshot records`);
  for (const path of imagePaths) {
    check(!/^(?:[a-z]+:|\/)/i.test(path), `${kubaraBuyerJourneySources.guiTour} GUI screenshot must be a repository-relative local image: ${path}`);
    const absolute = join(repoRoot, "docs/demo/kubara", path);
    check(existsSync(absolute) && statSync(absolute).isFile(), `${path} is linked from the GUI tour but is missing`);
    check(relativeRepo(absolute).startsWith("docs/images/kubara/"), `${path} must live under docs/images/kubara`);
    const record = receiptImages.find((item) => item.path === relativeRepo(absolute));
    check(Boolean(record), `${kubaraGuiEvidenceReceipt} has no record for ${relativeRepo(absolute)}`);
    check(record.sha256 === sha256File(absolute), `${kubaraGuiEvidenceReceipt} ${record.path} screenshot digest is stale`);
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(record.capturedAt ?? ""), `${kubaraGuiEvidenceReceipt} ${record.path} must record an exact UTC capturedAt`);
    check(Array.isArray(record.visibleIdentities) && record.visibleIdentities.length > 0, `${kubaraGuiEvidenceReceipt} ${record.path} must record visibleIdentities`);
    for (const field of ["sensitiveValues", "caption", "claimBoundary"]) check(Boolean(record[field]), `${kubaraGuiEvidenceReceipt} ${record.path} must record ${field}`);
  }
  const live = evaluateKubaraSiteLiveEvidence({ root: repoRoot });
  check(live.gui.current, `${kubaraGuiEvidenceReceipt} is not mutually current with the faithful, mini-IDP, orphan, matrix, and wiring evidence:\n- ${live.gui.reasons.join("\n- ")}`);
}

function verifyKubaraSiteEvidenceGate({ requireCurrent }) {
  const evidence = evaluateKubaraSiteLiveEvidence({ root: repoRoot });
  const gates = [evidence.faithful, evidence.miniIdp, evidence.orphan, evidence.performance, evidence.matrix, evidence.wiring, evidence.gui];
  check(evidence.current === gates.every((item) => item.current), "Kubara website current-live aggregate disagrees with its exact evidence gates");
  if (requireCurrent) check(evidence.current, `Kubara website live evidence is missing, stale, or mutually inconsistent:\n- ${evidence.reasons.join("\n- ")}`);
  return evidence;
}

function checkInOrder(haystack, needles, label) {
  let offset = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, offset + 1);
    check(next >= 0, `${label} is missing or out of order at: ${needle}`);
    offset = next;
  }
}

function verifyKubaraPublicVisibility() {
  const paths = {
    buyer: "site/kubara.html",
    adoption: "site/d/docs/demo/kubara/single-platform.html",
    tutorial: "site/d/docs/demo/kubara/adoption.html",
    checkpoints: "site/d/docs/demo/kubara/checkpoints.html",
    gui: "site/d/docs/demo/kubara/gui-tour.html",
    evidence: "site/d/docs/demo/kubara/platform-evidence.html",
    importer: "site/d/examples/kubara/git-import/README.html",
    catalog: "site/charts/index.html",
    examples: "site/testing.html",
  };
  for (const path of Object.values(paths)) check(existsSync(join(repoRoot, path)), `${path} is missing from the generated public site`);
  const chapterPaths = kubaraAdoptionChapters.map((chapter) =>
    `site/d/${chapter.path.replace(/\.md$/, ".html")}`);
  for (const path of chapterPaths) check(existsSync(join(repoRoot, path)), `${path} is missing from the generated six-step tutorial`);

  const buyer = collapseWhitespace(readFileSync(join(repoRoot, paths.buyer), "utf8"));
  const adoption = collapseWhitespace(readFileSync(join(repoRoot, paths.adoption), "utf8"));
  const tutorial = collapseWhitespace(readFileSync(join(repoRoot, paths.tutorial), "utf8"));
  const checkpoints = collapseWhitespace(readFileSync(join(repoRoot, paths.checkpoints), "utf8"));
  const gui = collapseWhitespace(readFileSync(join(repoRoot, paths.gui), "utf8"));
  const evidence = collapseWhitespace(readFileSync(join(repoRoot, paths.evidence), "utf8"));
  const importer = collapseWhitespace(readFileSync(join(repoRoot, paths.importer), "utf8"));
  const catalog = collapseWhitespace(readFileSync(join(repoRoot, paths.catalog), "utf8"));
  const examples = collapseWhitespace(readFileSync(join(repoRoot, paths.examples), "utf8"));
  const publicCatalogJson = JSON.parse(readFileSync(join(repoRoot, "site/catalog.json"), "utf8"));
  const installerCatalog = JSON.parse(readFileSync(join(repoRoot, "data/installer-oci-packages/packages.json"), "utf8"));
  const retainedPackages = installerCatalog.packages ?? [];
  const matrix = JSON.parse(readFileSync(join(repoRoot, "data/kubara-platform-matrix/matrix.json"), "utf8"));
  const graph = JSON.parse(readFileSync(join(repoRoot, "data/kubara-wiring/graph.json"), "utf8"));
  const expected = expectedContract().spec.adoption;
  const liveEvidence = verifyKubaraSiteEvidenceGate({ requireCurrent: false });

  for (const phrase of [
    "ConfigHub simplifies Kubara without making it fundamentally different.",
    "Kubara composes; ConfigHub governs; Argo reconciles.",
    "Benefits with explicit acceptance evidence",
    "What stays Kubara, and what ConfigHub adds",
    "One adoption journey, in the user's order",
    "What we show in ConfigHub",
    "The honest boundaries",
    "Keep all the detail",
    "Make latest discoverable, not deployable",
    "<code>targetRevision: latest</code>",
    "<code>spec.syncPolicy.automated</code>",
    "<code>ARGO_SYNC_MODE=kubernetes</code>",
    "operation.sync.revision=&lt;ManifestDigest&gt;",
    "managed automated path",
    "manual Argo sync",
  ]) check(buyer.includes(phrase), `${paths.buyer} must preserve the sales and adoption promise: ${phrase}`);
  checkInOrder(buyer, kubaraAdoptionChapters.map((chapter) =>
    `d/docs/demo/kubara/${chapter.path.split("/").at(-1).replace(/\.md$/, ".html")}`), `${paths.buyer} six-step chapter links`);
  check(
    buyer.includes("The status is generated from an exact evidence chain")
      && (buyer.includes("receipt required") || buyer.includes("current live")),
    `${paths.buyer} must disclose receipt-derived live status`,
  );
  check(
    buyer.includes(`data-kubara-live-evidence="${liveEvidence.current ? "current" : "gated"}"`),
    `${paths.buyer} does not reflect the exact current-live evidence gate`,
  );
  check(
    liveEvidence.current
      ? buyer.includes("evidence set is source-current and mutually consistent")
      : buyer.includes("live and GUI claims remain gated"),
    `${paths.buyer} current-live explanation disagrees with its evidence receipts`,
  );
  checkInOrder(tutorial, kubaraAdoptionChapters.map((chapter) =>
    `adoption-${chapter.number}-${["choose", "generate", "git", "oci", "confighub-org", "apps"][chapter.number - 1]}.html`), `${paths.tutorial} six-step chapter links`);
  for (const phrase of [
    "targetRevision: latest",
    "spec.syncPolicy.automated",
    "argobot v0.1.6",
    "operation.sync.revision",
    "Kubernetes UID/resourceVersion compare-and-set",
    "Publication alone does not deploy mutable",
  ]) check(tutorial.includes(phrase), `${paths.tutorial} must publish the exact-digest authority boundary: ${phrase}`);
  for (const phrase of [
    "Current deterministic",
    "Current live",
    "Historical live",
    "Waiting for current live proof",
    "Passing them does not synthesize a live receipt.",
    "Current live release checkpoint",
  ]) check(checkpoints.includes(phrase), `${paths.checkpoints} must preserve the evidence status contract: ${phrase}`);
  checkInOrder(gui, [
    "1. Start at the platform contract",
    "2. Browse components before platform instances",
    "3. Show the recognizable delivery shape",
    "4. Follow one application through four clusters",
    "5. Open the wiring",
    "6. Finish with the fleet matrix and clean inventory",
    "Explain, but do not spend the demo running",
    "Screenshot evidence contract",
  ], `${paths.gui} receipt-bound GUI tour`);
  for (const [index, path] of chapterPaths.entries()) {
    const chapter = collapseWhitespace(readFileSync(join(repoRoot, path), "utf8"));
    for (const phrase of [
      `Step ${index + 1}:`,
      "What ConfigHub adds",
      "Machine checkpoint",
      "Screenshot",
      "Troubleshooting",
      "Safe to stop",
    ]) check(chapter.includes(phrase), `${path} must preserve the detailed chapter contract: ${phrase}`);
    const previous = kubaraAdoptionChapters[index].previous.replace(/\.md$/, ".html");
    const next = kubaraAdoptionChapters[index].next.replace(/\.md$/, ".html");
    check(chapter.includes(`href="${previous}"`), `${path} must link backward to ${previous}`);
    check(chapter.includes(`href="${next}"`), `${path} must link forward to ${next}`);
  }
  const renderedOrganizationChapter = collapseWhitespace(readFileSync(join(repoRoot, chapterPaths[4]), "utf8"));
  const renderedApplicationChapter = collapseWhitespace(readFileSync(join(repoRoot, chapterPaths[5]), "utf8"));
  for (const phrase of [
    "spec.source.targetRevision: latest",
    "spec.syncPolicy.automated",
    "ARGO_SYNC_MODE=kubernetes",
    "ARGO_NAMESPACE=argocd",
    "ARGO_REFRESH_TYPE=hard",
    "operation.sync.revision",
    "metadata.uid",
    "metadata.resourceVersion",
    "manual Argo sync",
  ]) check(renderedOrganizationChapter.includes(phrase), `${chapterPaths[4]} must publish the governed delivery authority: ${phrase}`);
  for (const phrase of [
    "does not authorize Argo to deploy mutable",
    "spec.syncPolicy.automated",
    "accepts no active Argo operation",
    "operation.sync.revision",
    "metadata.uid",
    "metadata.resourceVersion",
  ]) check(renderedApplicationChapter.includes(phrase), `${chapterPaths[5]} must publish exact app release authority: ${phrase}`);

  check(expected.desiredMatrixRows === 36, "Kubara public visibility contract must retain 36 current matrix cells");
  check(matrix.spec?.scope?.cells === expected.desiredMatrixRows, `current Kubara matrix must contain ${expected.desiredMatrixRows} cells`);
  check(matrix.spec?.rows?.length === expected.desiredMatrixRows, `current Kubara matrix must expose ${expected.desiredMatrixRows} rows`);
  check(
    evidence.includes(`contains ${expected.desiredMatrixRows} cells: seven deployable platform roles plus hx-web and cubbychat`),
    `${paths.evidence} must state that the current matrix contains ${expected.desiredMatrixRows} cells`,
  );
  check(!evidence.includes("contains 28 cells"), `${paths.evidence} must not retain the pre-application 28-cell matrix claim`);

  for (const app of ["hx-web", "cubbychat"]) {
    check(adoption.includes(app), `${paths.adoption} must name ${app}`);
    check(evidence.includes(app), `${paths.evidence} must name ${app}`);
    check(examples.includes(app), `${paths.examples} must name ${app}`);
  }
  for (const phrase of [
    "55 Spaces",
    "63 managed Units",
    "<code>component-catalog-coverage</code>",
    "<code>CatalogComponents=103</code>",
    "<code>CatalogVersions=130</code>",
    "<code>Component=argo-cd</code>",
    "<code>Component=argobot</code>",
    "<code>hx-argo-base</code>",
    "<code>hx-argo-runtime-base</code>",
    "v3.4.5",
    "v3.4.6",
    "<code>Lane=Faithful</code>",
    "<code>Lane=Adapted</code>",
    "<code>Relationship=NeedsProvides</code>",
    "<code>Environment=Prod</code>",
    "<code>DeliveryMode=ConfigHubOCI</code>",
    "<code>URL-Catalog</code>",
    "130 retained",
    "six adoption steps",
    "prepare-kubara-git-handoff.mjs",
    "current-platform.prepare.yaml",
    "<code>examples/kubara/prepared-current-platform</code>",
    "kubara-git-handoff:verify-current",
    "167 checked files",
    "--package",
    "--apply",
    "apply-receipt.json",
  ]) check(adoption.includes(phrase), `${paths.adoption} must expose the current GUI/import boundary: ${phrase}`);
  for (const phrase of [
    "prepare-kubara-git-handoff.mjs",
    "current-platform.prepare.yaml",
    "prepared-current-platform",
    "normal Kubara generation path",
    "--generate",
    "--compile",
    "--verify",
    "--package",
    "--apply",
    "apply-receipt.json",
    "zero-action",
    "cluster-local Argo",
  ]) {
    check(importer.includes(phrase), `${paths.importer} must expose the linear Git-import step: ${phrase}`);
  }
  for (const phrase of [
    "component-first",
    "Component Catalog",
    "all 130 retained published package versions",
    "103 components",
    "9.5.15",
    "10.1.3",
    "10.2.1",
    "v1.20.2",
    "v1.21.0",
    "2.5.0",
    "2.7.0",
    "2.8.0",
    "85.3.3",
    "86.1.0",
    "87.15.1",
    "87.19.2",
    "3.13.0",
    "3.13.1",
    "40.2.0",
    "41.0.2",
    "grafana/alloy",
    "grafana/loki",
    "kyverno/kyverno-policies",
    "kyverno/kyverno",
    "longhorn/longhorn",
    "metallb/metallb",
    "oauth2-proxy/oauth2-proxy",
    "policy-reporter/policy-reporter",
    "stakater/reloader",
    "velero/velero",
  ]) check(catalog.includes(phrase), `${paths.catalog} must expose the additive component-first Catalog: ${phrase}`);
  const componentRows = [...catalog.matchAll(/<tr data-chart-row\b/g)].length;
  const readinessComponentRows = [...catalog.matchAll(/data-evidence-surface="readiness-evidence"/g)].length;
  const publicationOnlyComponentRows = [...catalog.matchAll(/data-evidence-surface="publication-only"/g)].length;
  const retainedVersionLinks = [...catalog.matchAll(/data-retained-version="[^"]+"\s+href="\.\/[^\"]+\.html"/g)].length;
  const publicationReceiptLinks = [...catalog.matchAll(/data-publication-receipt="[^"]+"/g)].length;
  const packagedConfigurationRecords = [...catalog.matchAll(/data-packaged-configurations="[^"]+"/g)].length;
  check(componentRows === finalCatalogComponentCount, `${paths.catalog} must expose exactly ${finalCatalogComponentCount} component rows, found ${componentRows}`);
  check(readinessComponentRows === top100EvidenceComponentCount, `${paths.catalog} must retain exactly ${top100EvidenceComponentCount} richer Top-100 readiness rows, found ${readinessComponentRows}`);
  check(publicationOnlyComponentRows === finalCatalogComponentCount - top100EvidenceComponentCount, `${paths.catalog} must identify the ${finalCatalogComponentCount - top100EvidenceComponentCount} publication-only component rows honestly`);
  check(retainedVersionLinks === finalCatalogVersionCount, `${paths.catalog} must link all ${finalCatalogVersionCount} retained versions to local detail pages, found ${retainedVersionLinks}`);
  check(publicationReceiptLinks === finalCatalogVersionCount, `${paths.catalog} must expose all ${finalCatalogVersionCount} publication receipts, found ${publicationReceiptLinks}`);
  check(packagedConfigurationRecords === finalCatalogVersionCount, `${paths.catalog} must expose all ${finalCatalogVersionCount} per-version configuration inventories, found ${packagedConfigurationRecords}`);
  check(
    retainedPackages.length === finalCatalogVersionCount
      && new Set(retainedPackages.map((row) => row.chart)).size === finalCatalogComponentCount,
    `installer package inventory must retain ${finalCatalogVersionCount} versions grouped across ${finalCatalogComponentCount} components`,
  );
  check(
    publicCatalogJson.summary?.publicCatalogComponents === finalCatalogComponentCount
      && publicCatalogJson.summary?.retainedComponents === finalCatalogComponentCount
      && publicCatalogJson.summary?.retainedPublishedPackageVersions === finalCatalogVersionCount,
    `site/catalog.json must expose the component-first ${finalCatalogComponentCount}-component/${finalCatalogVersionCount}-version inventory`,
  );
  const expectedCatalogPages = new Set(retainedPackages.map(catalogVersionPageFileName));
  const actualCatalogPages = readdirSync(join(repoRoot, "site/charts"))
    .filter((name) => name.endsWith(".html") && name !== "index.html");
  check(
    actualCatalogPages.length === expectedCatalogPages.size
      && actualCatalogPages.every((name) => expectedCatalogPages.has(name)),
    `site/charts must contain exactly the ${expectedCatalogPages.size} retained package-version pages`,
  );
  let retainedOnlyPages = 0;
  for (const row of retainedPackages) {
    const identity = `${row.chart}@${row.version}`;
    const pageName = catalogVersionPageFileName(row);
    check(
      catalog.includes(`data-retained-version="${identity}" href="./${pageName}"`)
        && catalog.includes(`data-publication-receipt="${identity}"`)
        && catalog.includes(`data-packaged-configurations="${identity}"`),
      `${paths.catalog} does not preserve the local page, receipt, and configurations for ${identity}`,
    );
    const page = readFileSync(join(repoRoot, "site/charts", pageName), "utf8");
    if (page.includes("data-retained-only-version=")) retainedOnlyPages += 1;
    check(page.toLowerCase().includes("publication receipt"), `${pageName} does not expose its version-specific publication receipt`);
  }
  const expectedRetainedOnlyPages = finalCatalogVersionCount - top100EvidenceComponentCount;
  check(
    retainedOnlyPages === expectedRetainedOnlyPages,
    `expected ${expectedRetainedOnlyPages} retained-only human detail pages, found ${retainedOnlyPages}`,
  );

  check(
    examples.includes('href="./kubara.html"')
      && examples.includes('href="./d/docs/demo/kubara/adoption.html"')
      && examples.includes('href="./d/docs/demo/kubara/single-platform.html"'),
    `${paths.examples} must link the Kubara buyer journey, tutorial, and technical example`,
  );
  check(
    examples.includes('href="./d/docs/demo/kubara/platform-evidence.html"'),
    `${paths.examples} must link the Kubara matrix and wiring evidence guide`,
  );
  check(
    examples.includes('href="./d/examples/kubara/git-import/README.html"'),
    `${paths.examples} must link the reusable Kubara Git-revision importer`,
  );
  check(
    examples.includes("examples/kubara/prepared-current-platform")
      && examples.includes("examples/kubara/prepared-current-platform/preparation-receipt.yaml"),
    `${paths.examples} must link the prepared Kubara handoff and its receipt`,
  );
  check(
    adoption.includes('href="https://confighub.github.io/helm-expt/site/kubara.html"')
      && adoption.includes('href="https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html"')
      && adoption.includes('href="https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html"'),
    `${paths.adoption} must link the public adoption example, matrix, and full wiring graph`,
  );
  check(
    evidence.includes('href="https://confighub.github.io/helm-expt/site/kubara.html"')
      && evidence.includes('href="https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html"')
      && evidence.includes('href="https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html"'),
    `${paths.evidence} must link the public adoption example, matrix, and full wiring graph`,
  );

  const curatedLinkCount = expected.reconcilerPlan.needsProvidesLinks;
  check(curatedLinkCount === 25, "Kubara public visibility contract must retain 25 curated GUI Links");
  check(
    adoption.includes(`After an accepted live run, the ConfigHub GUI must show ${curatedLinkCount} curated`)
      && adoption.includes("operational <code>NeedsProvides</code> Links"),
    `${paths.adoption} must identify the ${curatedLinkCount} GUI-visible curated NeedsProvides Links`,
  );
  for (const phrase of [
    "one 90-minute overall convergence deadline",
    "durable write-ahead operation journal",
    "58b23b85-9699-4384-bd57-80ef695a1d58",
    "12c33fa8-00b1-4011-ad3e-19d56458b29c",
    "All delivery Application Units are materialized and identity-checked before the first fleet-root release",
    "exact UID/resourceVersion",
    "<code>spec.source.targetRevision: latest</code>",
    "<code>spec.syncPolicy.automated</code>",
    "ghcr.io/confighub/argobot:v0.1.6",
    "ARGO_SYNC_MODE=kubernetes",
    "ARGO_NAMESPACE=argocd",
    "ARGO_REFRESH_TYPE=hard",
    "operation.sync.revision",
    "managed automated delivery path",
    "privileged human or manual Argo sync",
  ]) check(adoption.includes(phrase), `${paths.adoption} must expose the restart-safe live contract: ${phrase}`);
  check(
    adoption.includes("ConfigHub governs the desired-only matrix")
      && adoption.includes("the public matrix is regenerated from that desired state plus receipt evidence"),
    `${paths.adoption} must distinguish the desired-only governed matrix from receipt-aware public evidence`,
  );
  check(
    adoption.includes("the public graph is the complete evidence view"),
    `${paths.adoption} must distinguish GUI-visible Links from their full extracted wiring source`,
  );
  check(
    graph.spec?.summary?.needs > curatedLinkCount,
    "the full extracted Kubara wiring graph must remain larger than the curated GUI Link inventory",
  );
  check(
    evidence.includes("The mini-IDP contract calls for exactly 25")
      && evidence.includes("exact live receipt and orphan audit decide whether those Links are current")
      && evidence.includes("The receipt-aware public matrix and complete extracted wiring graph are linked evidence views")
      && evidence.includes("they are not presented as native live ConfigHub observations"),
    `${paths.evidence} must preserve the GUI desired-state versus derived-evidence boundary`,
  );

  check(
    adoption.includes("The public 36-cell matrix is regenerated from that state and the exact live receipt")
      && adoption.includes("leaves current live fields")
      && adoption.includes("unless the receipt supplies them"),
    `${paths.adoption} must describe the matrix as receipt-derived live evidence`,
  );
  check(
    evidence.includes("The desired 36-cell contract is governed in ConfigHub")
      && evidence.includes("public files above are regenerated after the mini-IDP receipt")
      && evidence.includes("A missing observation remains <code>unknown</code>"),
    `${paths.evidence} must preserve the desired-state versus receipt-derived live-matrix boundary`,
  );
}

function verifyMiniIdpPlan() {
  const script = "scripts/reconcile-kubara-mini-idp.mjs";
  const scriptPath = join(repoRoot, script);
  check(existsSync(scriptPath), `${script} is missing`);
  const reconcilerSource = readFileSync(scriptPath, "utf8");
  const syncStart = reconcilerSource.indexOf("function requestArgoSyncIfNeeded(");
  const syncEnd = reconcilerSource.indexOf("\nfunction assertReleaseStreamStillCurrent(", syncStart);
  check(syncStart >= 0 && syncEnd > syncStart, "mini-IDP exact-digest Argo sync function is missing");
  const syncSource = reconcilerSource.slice(syncStart, syncEnd);
  check(
    syncSource.includes("app.metadata?.uid")
      && syncSource.includes('path: "/metadata/uid"')
      && syncSource.includes('path: "/metadata/resourceVersion"')
      && syncSource.includes('path: "/operation"')
      && syncSource.indexOf('path: "/metadata/uid"') < syncSource.indexOf('path: "/operation"')
      && syncSource.indexOf('path: "/metadata/resourceVersion"') < syncSource.indexOf('path: "/operation"'),
    "mini-IDP Argo submission must compare-and-set both Application UID and resourceVersion before adding the exact-digest operation",
  );
  const selfTest = execFileSync(process.execPath, [script, "--self-test"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  }).trim();
  const selfTestLines = selfTest.split("\n");
  check(
    selfTestLines[0]
      === "Kubara apply read cache self-test passed: 1792 repeated reads (including exact Unit Data) used five initial resource lists and zero refreshes; five mutation scenarios required 11 coalesced scoped refreshes"
      && selfTestLines.slice(1).join("\n") === [
      "Kubara mini-IDP performance instrumentation self-test passed",
      "Kubara mini-IDP release recovery self-test passed",
      "Kubara mini-IDP Argo convergence self-test passed",
      "Kubara mini-IDP scenario evidence self-test passed",
      "Kubara mini-IDP receipt Link evidence self-test passed",
    ].join("\n"),
    "mini-IDP read-cache, release, Argo convergence, scenario, and receipt-Link self-tests did not pass exactly",
  );
  const output = execFileSync(process.execPath, [script, "--plan"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  const plan = JSON.parse(output);
  check(plan.kind === "KubaraMiniIDPReconcilePlan", "mini-IDP plan kind changed");
  check(plan.spec?.organization === "Kubara", "mini-IDP plan organization changed");
  check(plan.spec?.execution?.organizationExternalID === "58b23b85-9699-4384-bd57-80ef695a1d58", "mini-IDP plan organization external ID is not pinned");
  check(plan.spec?.execution?.organizationEntityID === "12c33fa8-00b1-4011-ad3e-19d56458b29c", "mini-IDP plan organization entity ID is not pinned");
  check(plan.spec?.execution?.serverURL === "https://hub.confighub.com", "mini-IDP plan ConfigHub server is not pinned");
  check(plan.spec?.execution?.deterministic === true, "mini-IDP plan is not deterministic");
  check(plan.spec?.execution?.aiRequired === false, "mini-IDP plan requires AI");
  check(plan.spec?.execution?.mutationGuardConsulted === false, "mini-IDP plan consults the ignored mutation guard");
  check(
    plan.spec?.execution?.partialClusterStatePolicy === "fail-except-exact-journaled-prefix",
    "mini-IDP plan no longer limits partial fleet recovery to an exact journaled prefix",
  );
  check(plan.spec?.execution?.serialLiveParityLock === true, "mini-IDP plan does not require the shared serial live-parity lock");
  check(plan.spec?.execution?.unexpectedSpacePolicy === "fail-outside-exact-55-space-allowlist", "mini-IDP plan does not enforce the exact Space allowlist");
  check(plan.spec?.execution?.unexpectedManagedUnitOrLinkPolicy === "fail", "mini-IDP plan does not reject unexpected managed Units or Links");
  check(plan.spec?.execution?.receiptRequiresZeroActionRerun === true, "mini-IDP plan does not require a zero-action rerun receipt");
  check(
    plan.spec?.execution?.interruptedScenarioPolicy
      === "write ahead every ordered hx-web mutation as a nested transition with exact pre/post Unit, release, provenance, and UpgradeUnit checkpoints; bind approval to exact heads observed twice behind the gate and rollback to the exact initial-rollout revision; resume only an exact durable prefix and fail closed on every undeclared delta",
    "mini-IDP plan no longer binds scenario restart recovery to exact checkpoints",
  );
  check(
    plan.spec?.execution?.argoRetryPolicy
      === "persist one 90-minute convergence deadline and at most four sync-submission reservations per Application and OCI digest across restarts; observe an existing Argo operation without replacement for up to 60 minutes; wait for exact-revision health without resyncing for up to 30 minutes; reserve a new sync only after inactive terminal failure, OutOfSync, or wrong revision",
    "mini-IDP plan no longer separates active-operation observation, health settling, and actual retries",
  );
  check(
    plan.spec?.execution?.argoRevisionPolicy === kubaraArgoRevisionPolicy,
    "mini-IDP plan no longer makes latest discovery-only behind exact-digest ConfigHub release authority",
  );
  check(
    plan.spec?.execution?.deliveryRootPublicationPolicy === kubaraDeliveryRootPublicationPolicy,
    "mini-IDP plan no longer disables automated sync before exact delivery-root activation",
  );
  check(
    plan.spec?.execution?.argoNamespaceMovePolicy
      === "one declared tracked DaemonSet may be deleted with UID/resourceVersion preconditions from its obsolete namespace only at the exact expected OCI revision and after Argo marks it requiresPruning, the same desired workload exists in the Kubara namespace, both tracking IDs match, both ConfigHub origins match, and the reviewed TCP/9100 host-network binding conflicts",
    "mini-IDP plan no longer bounds the namespace-move deadlock recovery",
  );
  check(plan.spec?.execution?.minimumCubVersion === "v0.2.11", "mini-IDP plan cub minimum-version contract drifted");
  check(
    plan.spec?.execution?.publishedReleaseSelectionPolicy
      === "filter Published = true server-side before selecting the highest ReleaseNum; withdrawn releases never satisfy currency or drive Argo",
    "mini-IDP plan no longer excludes withdrawn releases server-side",
  );
  check(
    plan.spec?.execution?.interruptedReleasePolicy
      === "publish whenever any Unit head differs from its last applied revision; reuse the exact published release for metadata-only changes or ConfigHub's unchanged-bundle response; pass only the published OCI ManifestDigest to Argo",
    "mini-IDP plan no longer treats metadata-only and unchanged-bundle release attempts as idempotent reuse",
  );
  const expected = expectedContract().spec.adoption.reconcilerPlan;
  for (const name of ["spaces", "managedUnits", "deployments", "needsProvidesLinks"]) {
    check(plan.spec?.counts?.[name] === expected[name], `mini-IDP plan ${name} changed from ${expected[name]}`);
  }
  const faithfulReceipt = expectedContract().spec.requiredEvidence.faithfulLane;
  const faithfulEvidence = plan.spec?.source?.faithfulEvidence;
  check(
    faithfulEvidence?.path === faithfulReceipt
      && faithfulEvidence.retainedHistoricalReceipt === existsSync(join(repoRoot, faithfulReceipt))
      && typeof faithfulEvidence.sourceCurrent === "boolean"
      && faithfulEvidence.retentionPolicy === "retain-history-exclude-from-current-plan-until-source-current",
    "mini-IDP plan does not distinguish retained faithful history from source-current faithful evidence",
  );
  check(
    faithfulEvidence.sourceCurrent
      ? faithfulEvidence.status === "current-pass"
      : faithfulEvidence.status !== "current-pass",
    "mini-IDP faithful evidence status contradicts its source-current result",
  );
  const hasFaithfulEvidence = faithfulEvidence.sourceCurrent;
  const expectedPayloads = hasFaithfulEvidence
    ? expected.payloadsReadyForApply
    : expected.payloadsBeforeFaithfulEvidence;
  check(plan.spec?.counts?.payloads === expectedPayloads, `mini-IDP plan payloads changed from ${expectedPayloads}`);
  check(plan.spec?.spaces?.length === expected.spaces, "mini-IDP plan Space inventory is incomplete");
  check(plan.spec?.units?.length === expected.managedUnits, "mini-IDP plan Unit inventory is incomplete");
  check(plan.spec?.deployments?.length === expected.deployments, "mini-IDP plan deployment inventory is incomplete");
  check(plan.spec?.links?.length === expected.needsProvidesLinks, "mini-IDP plan Link inventory is incomplete");
  check(plan.spec?.payloads?.length === expectedPayloads, "mini-IDP plan payload inventory is incomplete");
  check(
    plan.spec.payloads.some((payload) => payload.key === "hx-platform/faithful-hub-spoke-receipt") === hasFaithfulEvidence,
    "mini-IDP plan current payload inventory does not match faithful evidence source currency",
  );
  check(
    plan.status?.missingApplyEvidence?.includes(faithfulReceipt) === !hasFaithfulEvidence,
    "mini-IDP plan readiness does not gate on source-current faithful evidence",
  );
  const componentSpaces = plan.spec.spaces.filter((space) => space.labels?.Component);
  check(
    componentSpaces.every((space) => space.labels.Owner && space.labels.Variant && space.labels.ComponentVersion),
    "every GUI-visible Component Space must expose Owner, Variant, and exact ComponentVersion",
  );
  check(
    new Set(componentSpaces.map((space) => [
      space.labels.Owner,
      space.labels.Component,
      space.labels.Lane ?? "Unspecified",
      space.labels.Variant,
    ].join("/"))).size
      === componentSpaces.length,
    "every GUI-visible Owner/Component/Lane/Variant card identity must be unique",
  );
  const ownersByComponentLane = new Map();
  for (const space of componentSpaces) {
    const componentLane = `${space.labels.Component}/${space.labels.Lane ?? "Unspecified"}`;
    if (!ownersByComponentLane.has(componentLane)) ownersByComponentLane.set(componentLane, new Set());
    ownersByComponentLane.get(componentLane).add(space.labels.Owner);
  }
  check(
    [...ownersByComponentLane.values()].every((owners) => owners.size === 1),
    "each GUI Component/Lane must remain in exactly one Owner catalog bucket",
  );
  const spacesBySlug = new Map(plan.spec.spaces.map((space) => [space.slug, space]));
  check(
    componentSpaces.filter((space) => space.upstreamSpace).every((space) =>
      spacesBySlug.get(space.upstreamSpace)?.labels?.Component === space.labels.Component),
    "every GUI Component deployment lineage must resolve to an upstream Space in the same Component",
  );
  check(
    !plan.spec.spaces.find((space) => space.slug === "hx-platform")?.labels?.Component
      && !plan.spec.spaces.some((space) => /^hx-app-(dev|staging|prod-a|prod-b)$/.test(space.slug)
        && space.labels?.Component),
    "pure control and ClusterTarget Spaces must not pollute the Components GUI",
  );
  const guideURL = "https://confighub.github.io/helm-expt/site/kubara.html";
  const adoptionURL = "https://confighub.github.io/helm-expt/site/d/docs/demo/kubara/adoption.html";
  const performanceURL = "https://confighub.github.io/helm-expt/site/d/docs/demo/kubara/reconciliation-performance.html";
  const catalogURL = "https://confighub.github.io/helm-expt/site/charts/";
  const catalogCoverageURL = "https://confighub.github.io/helm-expt/data/kubara-catalog-1.1-full-coverage/receipt.yaml";
  const matrixURL = "https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html";
  const wiringURL = "https://confighub.github.io/helm-expt/data/kubara-wiring/graph.html";
  const residueAuditURL = "https://confighub.github.io/helm-expt/runs/kubara-mini-idp-reconcile/orphan-audit.yaml";
  const controlSpace = spacesBySlug.get("hx-platform");
  check(
    controlSpace?.labels?.StartHere === "true"
      && stableJson(controlSpace.annotations) === stableJson({
        "URL-Guide": guideURL,
        "URL-Adoption": adoptionURL,
        "URL-Performance": performanceURL,
        "URL-Catalog": catalogURL,
        "URL-CatalogCoverage": catalogCoverageURL,
        "URL-Matrix": matrixURL,
        "URL-Wiring": wiringURL,
        "URL-ResidueAudit": residueAuditURL,
      }),
    "hx-platform must remain the exact StartHere GUI entry with guide, adoption, performance, catalog, matrix, wiring, and residue-audit links",
  );
  const expectedStartHereUnits = new Map(Object.entries({
    "component-catalog-coverage": { "URL-Guide": guideURL, "URL-Catalog": catalogURL, "URL-CatalogCoverage": catalogCoverageURL },
    "component-catalog-selection": { "URL-Guide": guideURL, "URL-Catalog": catalogURL },
    "faithful-hub-spoke-receipt": { "URL-Guide": guideURL },
    "platform-contract": { "URL-Guide": guideURL, "URL-Adoption": adoptionURL, "URL-Performance": performanceURL, "URL-Catalog": catalogURL, "URL-CatalogCoverage": catalogCoverageURL, "URL-Matrix": matrixURL, "URL-Wiring": wiringURL, "URL-ResidueAudit": residueAuditURL },
    "platform-matrix": { "URL-Guide": guideURL, "URL-Matrix": matrixURL },
    "wiring-ledger": { "URL-Guide": guideURL, "URL-Wiring": wiringURL },
  }));
  const actualStartHereUnits = plan.spec.units.filter(
    (unit) => unit.space === "hx-platform" && unit.labels?.StartHere === "true",
  );
  check(
    actualStartHereUnits.length === expectedStartHereUnits.size
      && actualStartHereUnits.every((unit) => stableJson(unit.annotations) === stableJson(expectedStartHereUnits.get(unit.slug))),
    "the six StartHere Units must preserve their exact public GUI navigation mapping, including the platform contract residue-audit link",
  );
  const argoDefinitionSpace = spacesBySlug.get("hx-argo-base");
  check(
    argoDefinitionSpace?.type === "component-definition"
      && argoDefinitionSpace.labels?.Component === "argo-cd"
      && argoDefinitionSpace.labels?.ComponentSurface === "argocd-delivery"
      && argoDefinitionSpace.labels?.Role === "ComponentDefinition"
      && argoDefinitionSpace.labels?.DefinitionScope === "Base"
      && argoDefinitionSpace.labels?.Variant === "base"
      && argoDefinitionSpace.labels?.ComponentVersion === "10.2.1"
      && argoDefinitionSpace.labels?.RuntimeVersion === "v3.4.5"
      && argoDefinitionSpace.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.5"
      && argoDefinitionSpace.labels?.Catalog === "KubaraBootstrap"
      && argoDefinitionSpace.labels?.Owner === "KubaraBootstrap"
      && argoDefinitionSpace.labels?.Lane === "Faithful",
    "Components GUI must expose the faithful Kubara argo-cd definition with exact chart/runtime provenance",
  );
  const argoRuntimeSpace = spacesBySlug.get("hx-argo-runtime-base");
  check(
    argoRuntimeSpace?.type === "delivery-runtime-definition"
      && argoRuntimeSpace.labels?.Component === "argo-cd"
      && argoRuntimeSpace.labels?.ComponentSurface === "argocd-delivery-runtime"
      && argoRuntimeSpace.labels?.Role === "DeliveryRuntimeDefinition"
      && argoRuntimeSpace.labels?.DefinitionScope === "Base"
      && argoRuntimeSpace.labels?.Variant === "base"
      && argoRuntimeSpace.labels?.ComponentVersion === "v3.4.6"
      && argoRuntimeSpace.labels?.RuntimeVersion === "v3.4.6"
      && argoRuntimeSpace.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.6"
      && argoRuntimeSpace.labels?.Catalog === "ConfigHubBootstrap"
      && argoRuntimeSpace.labels?.Owner === "ConfigHubBootstrap"
      && argoRuntimeSpace.labels?.Lane === "Adapted"
      && !argoRuntimeSpace.labels?.KubaraComponent,
    "Components GUI must expose adapted cluster-local Argo as a separate exact ConfigHubBootstrap runtime",
  );
  const argoDefinitionUnit = plan.spec.units.find(
    (unit) => unit.space === "hx-argo-base" && unit.slug === "argo-cd",
  );
  const argoEvidenceUnit = plan.spec.units.find(
    (unit) => unit.space === "hx-platform" && unit.slug === "kubara-argo-definition",
  );
  check(
    argoDefinitionUnit?.role === "ComponentDefinition"
      && argoDefinitionUnit.payloadKey === "hx-platform/kubara-argo-definition"
      && argoDefinitionUnit.toolchain === "Kubernetes/YAML"
      && argoDefinitionUnit.provider === null
      && argoDefinitionUnit.target === null
      && !argoDefinitionUnit.upstream
      && argoDefinitionUnit.labels?.Component === "argo-cd"
      && argoDefinitionUnit.labels?.ComponentSurface === "argocd-delivery"
      && argoDefinitionUnit.labels?.ComponentVersion === "10.2.1"
      && argoDefinitionUnit.labels?.RuntimeVersion === "v3.4.5"
      && argoDefinitionUnit.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.5"
      && argoDefinitionUnit.labels?.Catalog === "KubaraBootstrap"
      && argoDefinitionUnit.labels?.Owner === "KubaraBootstrap"
      && argoDefinitionUnit.labels?.Lane === "Faithful",
    "hx-argo-base/argo-cd must be the native, untargeted argo-cd definition Unit",
  );
  const argoRuntimeUnit = plan.spec.units.find(
    (unit) => unit.space === "hx-argo-runtime-base" && unit.slug === "argo-cd-runtime",
  );
  check(
    argoRuntimeUnit?.role === "DeliveryRuntimeDefinition"
      && argoRuntimeUnit.payloadKey === "hx-argo-runtime-base/argo-cd-runtime"
      && argoRuntimeUnit.toolchain === "AppConfig/YAML"
      && argoRuntimeUnit.provider === "None"
      && argoRuntimeUnit.target === null
      && !argoRuntimeUnit.upstream
      && argoRuntimeUnit.labels?.Component === "argo-cd"
      && argoRuntimeUnit.labels?.ComponentVersion === "v3.4.6"
      && argoRuntimeUnit.labels?.RuntimeVersion === "v3.4.6"
      && argoRuntimeUnit.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.6"
      && argoRuntimeUnit.labels?.Catalog === "ConfigHubBootstrap"
      && argoRuntimeUnit.labels?.Owner === "ConfigHubBootstrap"
      && argoRuntimeUnit.labels?.Lane === "Adapted"
      && !argoRuntimeUnit.labels?.KubaraComponent,
    "hx-argo-runtime-base/argo-cd-runtime must retain the separate adapted runtime contract",
  );
  check(
    argoEvidenceUnit?.role === "KubaraDeliveryDefinition"
      && argoEvidenceUnit.payloadKey === argoDefinitionUnit?.payloadKey
      && argoEvidenceUnit.labels?.Component === "argo-cd"
      && argoEvidenceUnit.labels?.Lane === "Faithful"
      && argoEvidenceUnit.labels?.SourceType === "CommittedEvidence",
    "hx-platform must retain the reviewed Kubara Argo evidence Unit and provenance",
  );
  const faithfulReceiptUnit = plan.spec.units.find(
    (unit) => unit.space === "hx-platform" && unit.slug === "faithful-hub-spoke-receipt",
  );
  check(
    faithfulReceiptUnit?.labels?.Lane === "Faithful"
      && faithfulReceiptUnit.labels?.StartHere === "true"
      && faithfulReceiptUnit.annotations?.["URL-Guide"]
        === "https://confighub.github.io/helm-expt/site/kubara.html",
    "the faithful lane must have a StartHere-linked GUI receipt",
  );
  const argoDefinitionPayload = plan.spec.payloads.find(
    (payload) => payload.key === "hx-platform/kubara-argo-definition",
  );
  check(
    stableJson(argoDefinitionPayload?.sourcePaths) === stableJson([
      "examples/kubara/current-platform/effective-renders/hx-app-dev/argo-cd/release-objects.yaml",
    ]),
    "the native argo-cd definition and retained control evidence must share the reviewed Kubara render",
  );
  const argoRuntimePayload = plan.spec.payloads.find(
    (payload) => payload.key === "hx-argo-runtime-base/argo-cd-runtime",
  );
  check(
    argoRuntimePayload?.toolchain === "AppConfig/YAML"
      && argoRuntimePayload.transform === "embedded-reviewed-runtime-contract"
      && stableJson(argoRuntimePayload.sourcePaths) === stableJson(["scripts/reconcile-kubara-mini-idp.mjs"]),
    "adapted cluster-local Argo must retain a distinct reviewed runtime contract payload",
  );
  const argoDeliverySpaces = plan.spec.spaces.filter(
    (space) => /^hx-app-(dev|staging|prod-a|prod-b)-argo-apps$/.test(space.slug),
  );
  check(
    argoDeliverySpaces.length === 4
      && argoDeliverySpaces.every((space) =>
        space.type === "delivery-instance"
          && space.labels?.Component === "argo-cd"
          && space.labels?.Role === "DeliveryInstance"
          && space.labels?.InstanceOf === "argo-cd-runtime"
          && space.labels?.DefinitionSpace === "hx-argo-runtime-base"
          && space.labels?.ComponentVersion === "v3.4.6"
          && space.labels?.RuntimeVersion === "v3.4.6"
          && space.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.6"
          && space.labels?.Catalog === "ConfigHubBootstrap"
          && space.labels?.Owner === "ConfigHubBootstrap"
          && !space.labels?.KubaraComponent
          && space.labels?.Lane === "Adapted"),
    "all four cluster-local Argo delivery Spaces must resolve only to the exact adapted runtime definition",
  );
  const argoRootApplications = plan.spec.deliveryApplicationUnits.filter(
    (unit) => unit.labels?.ApplicationKind === "ClusterRoot",
  );
  check(
    argoRootApplications.length === 4
      && argoRootApplications.every((unit) =>
        unit.labels?.Component === "argo-cd"
          && unit.labels?.InstanceOf === "argo-cd-runtime"
          && unit.labels?.DefinitionSpace === "hx-argo-runtime-base"
          && unit.labels?.ComponentVersion === "v3.4.6"
          && unit.labels?.RuntimeImage === "quay.io/argoproj/argocd:v3.4.6"
          && unit.labels?.Catalog === "ConfigHubBootstrap"
          && !unit.labels?.KubaraComponent
          && unit.labels?.Lane === "Adapted"),
    "all four cluster-root delivery Application Units must expose only the exact adapted Argo runtime lineage",
  );
  check(
    plan.spec.deliveryApplicationUnits.length === 35
      && plan.spec.deliveryApplicationUnits.every((unit) => unit.labels?.Lane === "Adapted"),
    "all 35 cluster-local delivery Application Units must be visible as Lane=Adapted",
  );
  for (const unit of plan.spec.deliveryApplicationUnits.filter(
    (row) => ["PlatformComponent", "Application"].includes(row.labels?.ApplicationKind),
  )) {
    const sourceSpace = spacesBySlug.get(unit.labels.SourceSpace);
    check(sourceSpace, `${unit.ref}: delivery source Space is missing`);
    check(
      unit.labels.DefinitionSpace === (sourceSpace.labels.DefinitionSpace ?? sourceSpace.upstreamSpace)
        && unit.labels.InstanceOf === (sourceSpace.labels.InstanceOf ?? sourceSpace.labels.Component)
        && unit.labels.PromotionUpstreamSpace === sourceSpace.upstreamSpace,
      `${unit.ref}: delivery GUI labels conflate reusable definition lineage with promotion upstream`,
    );
  }
  for (const [ref, promotionUpstream] of [
    ["hx-app-staging-argo-apps/hx-web-staging", "hx-web-dev"],
    ["hx-app-prod-a-argo-apps/hx-web-prod-a", "hx-web-staging"],
    ["hx-app-prod-b-argo-apps/hx-web-prod-b", "hx-web-staging"],
  ]) {
    const unit = plan.spec.deliveryApplicationUnits.find((row) => row.ref === ref);
    check(
      unit?.labels?.DefinitionSpace === "hx-web-base"
        && unit.labels.PromotionUpstreamSpace === promotionUpstream,
      `${ref}: GUI must show hx-web-base as the definition and ${promotionUpstream} as the promotion upstream`,
    );
  }
  check(
    plan.spec.spaces
      .filter((space) => space.labels?.Role?.endsWith("Instance") || space.labels?.Role === "ClusterTarget")
      .every((space) => space.labels?.Lane === "Adapted"),
    "all adapted cluster-target and instance Spaces must expose Lane=Adapted in the GUI",
  );
  const kubaraCatalogComponents = [...new Set(componentSpaces
    .filter((space) => space.labels.Owner === "KubaraGeneral")
    .map((space) => space.labels.Component))].sort();
  check(
    stableJson(kubaraCatalogComponents) === stableJson([
      "cert-manager",
      "external-secrets",
      "homer-dashboard",
      "kube-prometheus-stack",
      "metrics-server",
      "traefik",
    ]),
    "Components GUI must group the selected Kubara catalog components under KubaraGeneral",
  );
  check(
    stableJson([...new Set(componentSpaces
      .filter((space) => space.labels.Owner === "KubaraBootstrap")
      .map((space) => space.labels.Component))].sort()) === stableJson(["argo-cd"]),
    "Components GUI must expose the faithful argo-cd selection under KubaraBootstrap",
  );
  check(
    componentSpaces.filter((space) => space.labels.Component === "argo-cd").length === 6
      && stableJson([...new Set(componentSpaces
        .filter((space) => space.labels.Owner === "ConfigHubBootstrap")
        .map((space) => space.labels.Component))].sort()) === stableJson(["argo-cd"]),
    "Components GUI must separately expose the ConfigHubBootstrap Argo runtime definition and four instances",
  );
  const argobotSpaces = componentSpaces.filter((space) => space.labels.Component === "argobot");
  check(
    argobotSpaces.length === 5
      && argobotSpaces.every((space) =>
        space.labels.Owner === "ConfigHubDelivery"
          && space.labels.Catalog === "ConfigHubDelivery"
          && space.labels.ComponentVersion === "v0.1.6")
      && argobotSpaces.filter((space) => space.labels.Role === "DeliveryDefinition").length === 1
      && argobotSpaces.filter((space) => space.labels.Role === "DeliveryInstance" && space.labels.Lane === "Adapted").length === 4,
    "Components GUI must expose the exact v0.1.6 argobot delivery definition and four adapted instances",
  );
  check(
    componentSpaces.some((space) => space.labels.Component === "kube-prometheus-stack"
      && space.labels.BundledCatalogComponent === "prometheus-blackbox-exporter"
      && space.labels.BundledComponentVersion === "11.15.1"),
    "Components GUI metadata must expose the exact bundled blackbox exporter selection",
  );
  check(
    componentSpaces.some((space) => space.slug === "hx-web-platform-base"
      && space.labels.Component === "hx-web"
      && space.labels.ComponentSurface === "hx-web-platform")
      && componentSpaces.some((space) => space.labels.Component === "cubbychat"),
    "Components GUI must group hx-web's platform binding with hx-web and expose cubbychat",
  );
  check(
    componentSpaces.filter((space) => space.labels.Component === "hx-web").length === 10
      && componentSpaces.filter((space) => space.labels.Component === "cubbychat").length === 5
      && ["dev", "staging", "prod-a", "prod-b"].every((variant) =>
        componentSpaces.some((space) => space.labels.Component === "hx-web" && space.labels.Variant === variant)
          && componentSpaces.some((space) => space.labels.Component === "cubbychat" && space.labels.Variant === variant)),
    "Components GUI must expose the complete hx-web and cubbychat definition/target inventory",
  );
  const plannedUnitRefs = new Set(plan.spec.units.map((unit) => `${unit.space}/${unit.slug}`));
  check(
    plan.spec.links.length === 25
      && plan.spec.links.every((link) =>
        link.updateType === "NeedsProvides"
          && link.autoUpdate === false
          && link.labels?.Relationship === "NeedsProvides"
          && Boolean(link.labels?.ConsumerComponent)
          && Boolean(link.labels?.ProviderComponent)
          && Boolean(link.reason)
          && plannedUnitRefs.has(`${link.space}/${link.fromUnit}`)
          && plannedUnitRefs.has(`${link.toSpace}/${link.toUnit}`)),
    "all 25 GUI wiring Links must preserve manual NeedsProvides semantics, reasons, and exact endpoints",
  );
  for (const key of ["hx-platform/catalog-adapter-receipt", "hx-platform/catalog-root-promotion"]) {
    check(plan.spec.payloads.some((payload) => payload.key === key), `mini-IDP plan is missing governed evidence payload ${key}`);
  }
  check(
    plan.spec.payloads.some((payload) => payload.key === "hx-platform/faithful-hub-spoke-receipt") === hasFaithfulEvidence,
    "mini-IDP faithful-lane evidence payload does not match receipt availability",
  );
  check(plan.spec.deployments.filter((deployment) => deployment.type === "platform").length === 15, "mini-IDP plan must retain 15 platform deployments");
  check(plan.spec.deployments.filter((deployment) => deployment.type === "application").length === 12, "mini-IDP plan must retain all 12 application deployments");
  const namespaceMoveDeployments = plan.spec.deployments.filter(
    (deployment) => (deployment.namespaceMovePrunes ?? []).length > 0,
  );
  check(
    namespaceMoveDeployments.length === 1
      && namespaceMoveDeployments[0].space === "hx-kps-main-dev"
      && stableJson(namespaceMoveDeployments[0].namespaceMovePrunes) === stableJson([{
        migrationID: "hx-kps-main/node-exporter-default-to-kube-prometheus-stack/v1",
        apiVersion: "apps/v1",
        resource: "daemonset",
        kind: "DaemonSet",
        name: "kube-prometheus-stack-prometheus-node-exporter",
        fromNamespace: "default",
        conflictingBindings: ["TCP/9100"],
        reason: "hostNetwork TCP/9100 prevents the Kubara-namespace replacement from becoming healthy before PruneLast",
      }]),
    "mini-IDP plan namespace-move recovery must remain one exact KPS DaemonSet",
  );
  check(plan.spec.spaces.filter((space) => space.prodProtected).length === 10, "mini-IDP plan must protect all ten production app and system-service Spaces");
  check(plan.spec.units.filter((unit) => unit.prodProtected).length === 14, "mini-IDP plan must protect all fourteen production app and system-service Units");
  const deploymentBySpace = new Map(plan.spec.deployments.map((deployment) => [deployment.space, deployment]));
  check(
    deploymentBySpace.get("hx-kps-crds-dev")?.order < deploymentBySpace.get("hx-eso-grafana-es-dev")?.order
      && deploymentBySpace.get("hx-eso-grafana-es-dev")?.order < deploymentBySpace.get("hx-kps-main-dev")?.order,
    "mini-IDP plan must order KPS CRDs, Namespace/ExternalSecret wiring, then KPS workloads",
  );
  const secretPayload = plan.spec.payloads.find((payload) => payload.key === "hx-eso-grafana-es/dev");
  check(
    secretPayload?.objectCount === 2
      && secretPayload?.transform === "select-kind:Namespace/kube-prometheus-stack;ExternalSecret",
    "mini-IDP Grafana wiring payload must own exactly the Namespace and ExternalSecret",
  );
  const kpsMainPayload = plan.spec.payloads.find((payload) => payload.key === "hx-kps-main/dev");
  check(
    kpsMainPayload?.transform === "exclude-kinds:CustomResourceDefinition;ExternalSecret;Namespace/kube-prometheus-stack",
    "mini-IDP KPS main payload overlaps a lifecycle or secret-wiring prerequisite",
  );
  check(stableJson(plan.spec?.phases) === stableJson([
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
  ]), "mini-IDP plan phases are no longer the exact linear release sequence");
  const matrix = JSON.parse(readFileSync(join(repoRoot, "data/kubara-platform-matrix/desired-matrix.json"), "utf8"));
  check(matrix.kind === "KubaraPlatformMatrix", "desired mini-IDP matrix kind changed");
  check(matrix.spec?.rows?.length === expectedContract().spec.adoption.desiredMatrixRows, "desired mini-IDP matrix row count changed");
  const matrixUnit = plan.spec?.units?.find((unit) => unit.space === "hx-platform" && unit.slug === "platform-matrix");
  check(matrixUnit?.role === "PlatformMatrixDesired", "mini-IDP matrix Unit must remain desired-only");
  const matrixPayload = plan.spec?.payloads?.find((payload) => payload.key === "hx-platform/platform-matrix");
  check(stableJson(matrixPayload?.sourcePaths) === stableJson(["data/kubara-platform-matrix/desired-matrix.json"]), "mini-IDP matrix payload must not ingest its publication receipt");
}

function verifyFinalState() {
  verifyKubaraSiteEvidenceGate({ requireCurrent: true });
  verifyKubaraAdoptionScreenshotContract({ requireCurrent: true });
  verifyKubaraPublicVisibility();
  for (const rootName of ["recipes", "packages"]) {
    const roots = versionRoots(rootName);
    check(roots.length === finalCatalogVersionCount, `${rootName}: final additive total must be ${finalCatalogVersionCount}, found ${roots.length}`);
    for (const addition of additions) check(roots.includes(`${rootName}/${addition}`), `${rootName}/${addition} was not promoted`);
    for (const addition of fullCoverageAdditions) check(roots.includes(`${rootName}/${addition}`), `${rootName}/${addition} was not promoted`);
  }
  for (const path of Object.values(expectedContract().spec.requiredEvidence)) {
    check(existsSync(join(repoRoot, path)), `${path} is missing; final Kubara acceptance remains blocked`);
  }
  const installerCatalog = JSON.parse(readFileSync(join(repoRoot, "data/installer-oci-packages/packages.json"), "utf8"));
  check(installerCatalog.packages?.length === finalCatalogVersionCount, `installer OCI catalog must expose ${finalCatalogVersionCount} retained chart versions, found ${installerCatalog.packages?.length ?? 0}`);
  check(
    new Set(installerCatalog.packages.map((row) => row.chart)).size === finalCatalogComponentCount,
    `installer OCI catalog must group the ${finalCatalogVersionCount} retained package versions across exactly ${finalCatalogComponentCount} components`,
  );
}

function versionRoots(rootName) {
  const roots = [];
  const root = join(repoRoot, rootName);
  for (const repository of directoryNames(root)) {
    for (const chart of directoryNames(join(root, repository))) {
      for (const version of directoryNames(join(root, repository, chart))) {
        roots.push(`${rootName}/${repository}/${chart}/${version}`);
      }
    }
  }
  return roots.sort();
}

function directoryNames(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function catalogVersionPageFileName(row) {
  return `${row.chart}-${row.version}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") + ".html";
}

function treeSetDigest(roots) {
  const hash = createHash("sha256");
  for (const root of roots.sort()) {
    hash.update(`${root}\0`);
    for (const path of listFiles(join(repoRoot, root))) {
      hash.update(`${relative(repoRoot, path).replaceAll("\\", "/")}\0`);
      hash.update(`${sha256File(path)}\n`);
    }
  }
  return hash.digest("hex");
}

function run(item) {
  check(existsSync(join(repoRoot, item.script)), `${item.script} is missing for ${item.id}`);
  console.log(`acceptance: ${item.display}`);
  execFileSync(process.execPath, [item.script, ...item.args], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortDeep(nested)]));
  }
  return value;
}
