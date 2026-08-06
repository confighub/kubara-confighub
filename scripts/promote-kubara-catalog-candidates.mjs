#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  check,
  listFiles,
  readYaml,
  repoRoot,
  sha256File,
  writeYaml,
} from "./lib/proof-common.mjs";
import {
  KUBARA_CATALOG_ADDITIONS,
  KUBARA_CATALOG_BASELINE,
  KUBARA_CURRENT_ADDITIONS,
  KUBARA_HISTORICAL_ADDITIONS,
} from "./lib/kubara-catalog-release.mjs";
import {
  KUBARA_CATALOG_1_1_ADDITIONS,
  KUBARA_CATALOG_1_1_BASELINE,
  KUBARA_CATALOG_1_1_FINAL,
} from "./lib/kubara-catalog-1-1-full-coverage.mjs";

const mode = process.argv[2] ?? "--help";
const current = process.argv.includes("--current");
const alignmentRelative = current
  ? "examples/kubara/current-platform/component-artifacts.yaml"
  : "examples/kubara/local-platform/catalog-alignment.yaml";
const candidateSetRelative = current
  ? "data/kubara-catalog-refresh/current-candidates/candidate-set.yaml"
  : "data/kubara-catalog-refresh/candidates/candidate-set.yaml";
const liveReceiptRelative = current
  ? "runs/kubara-current-live-qualification/receipt.yaml"
  : "runs/kubara-live-qualification/receipt.yaml";
const promotionReceiptRelative = current
  ? "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml"
  : "data/kubara-catalog-refresh/root-promotion/receipt.yaml";
const defaultStageRelative = current
  ? ".tmp/kubara-current-catalog-root-promotion"
  : ".tmp/kubara-catalog-root-promotion";
const stageRelative = validateStageRelative(optionValue("--stage-root") ?? defaultStageRelative);
const stageRoot = join(repoRoot, stageRelative);
const promotionReadyRelative = `${stageRelative}/.promotion-ready`;
const promotionReadyRoot = join(repoRoot, promotionReadyRelative);

// These files are deterministic catalog views generated after root promotion.
// The immutable promotion boundary is the recipe/proof source beneath them;
// their own generators and the final release acceptance gate verify the views.
const derivedRecipeFiles = new Set([
  "CATALOG.md",
  "artifact-index.yaml",
  "catalog-status.yaml",
  "helm-pain-report.yaml",
  "inheritance-graph.yaml",
  "weirdness-and-mitigations.md",
]);

const historicalDefinitions = [
  component("helm:argo-cd/argo-cd", "scripts/argo-cd-proof.mjs", ["default", "no-crds"], ["argo-cd-no-crds", "argo-cd-default"]),
  component("helm:jetstack/cert-manager", "scripts/cert-manager-proof.mjs", ["default", "crds-enabled"], ["cert-manager-default", "cert-manager-crds-enabled"]),
  component("helm:external-secrets/external-secrets", "scripts/external-secrets-proof.mjs", ["default", "no-crds"], ["external-secrets-default", "external-secrets-no-crds"]),
  component(
    "helm:prometheus-community/kube-prometheus-stack",
    "scripts/kube-prometheus-stack-proof.mjs",
    ["default", "no-crds", "existing-secret"],
    ["kps-default", "kps-no-crds", "kps-existing-secret"],
    { lifecycle: true },
  ),
  component(
    "helm:prometheus-community/prometheus-blackbox-exporter",
    "scripts/kubara-generic-chart-proof.mjs",
    ["default"],
    ["blackbox-default"],
    { genericCandidate: "prometheus-blackbox-exporter" },
  ),
  component("helm:metrics-server/metrics-server", "scripts/metrics-server-proof.mjs", ["default", "external-tls-ca"], ["metrics-default", "metrics-external-tls-ca"]),
  component(
    "helm:traefik/traefik",
    "scripts/kubara-generic-chart-proof.mjs",
    ["default"],
    ["traefik-default"],
    { genericCandidate: "traefik" },
  ),
];
const currentDefinitions = [
  component("helm:argo-cd/argo-cd", "scripts/argo-cd-proof.mjs", ["default", "no-crds"], ["argo-cd-no-crds", "argo-cd-default"], { recipeRoot: "recipes/argo-cd/argo-cd" }),
  component("helm:external-secrets/external-secrets", "scripts/external-secrets-proof.mjs", ["default", "no-crds"], ["external-secrets-default", "external-secrets-no-crds"], { recipeRoot: "recipes/external-secrets/external-secrets" }),
  component(
    "helm:prometheus-community/kube-prometheus-stack",
    "scripts/kube-prometheus-stack-proof.mjs",
    ["default", "no-crds", "existing-secret"],
    ["kps-default", "kps-no-crds", "kps-existing-secret"],
    { lifecycle: true, recipeRoot: "recipes/prometheus-community/kube-prometheus-stack" },
  ),
];
const definitions = current ? currentDefinitions : historicalDefinitions;

const historicalExpectedLanes = [
  lane("blackbox-default", "helm:prometheus-community/prometheus-blackbox-exporter", "11.15.1", "default"),
  lane("metrics-default", "helm:metrics-server/metrics-server", "3.13.1", "default"),
  lane("metrics-external-tls-ca", "helm:metrics-server/metrics-server", "3.13.1", "external-tls-ca"),
  lane("cert-manager-default", "helm:jetstack/cert-manager", "v1.21.0", "default"),
  lane("cert-manager-crds-enabled", "helm:jetstack/cert-manager", "v1.21.0", "crds-enabled"),
  lane("external-secrets-default", "helm:external-secrets/external-secrets", "2.7.0", "default"),
  lane("external-secrets-no-crds", "helm:external-secrets/external-secrets", "2.7.0", "no-crds"),
  lane("argo-cd-no-crds", "helm:argo-cd/argo-cd", "10.1.3", "no-crds"),
  lane("argo-cd-default", "helm:argo-cd/argo-cd", "10.1.3", "default"),
  lane("kps-default", "helm:prometheus-community/kube-prometheus-stack", "87.15.1", "default"),
  lane("kps-no-crds", "helm:prometheus-community/kube-prometheus-stack", "87.15.1", "no-crds"),
  lane("kps-existing-secret", "helm:prometheus-community/kube-prometheus-stack", "87.15.1", "existing-secret"),
  lane("traefik-default", "helm:traefik/traefik", "41.0.2", "default"),
];
const currentExpectedLanes = [
  lane("blackbox-default", "helm:prometheus-community/prometheus-blackbox-exporter", "11.15.1", "default"),
  lane("metrics-default", "helm:metrics-server/metrics-server", "3.13.1", "default"),
  lane("metrics-external-tls-ca", "helm:metrics-server/metrics-server", "3.13.1", "external-tls-ca"),
  lane("cert-manager-default", "helm:jetstack/cert-manager", "v1.21.0", "default"),
  lane("cert-manager-crds-enabled", "helm:jetstack/cert-manager", "v1.21.0", "crds-enabled"),
  lane("external-secrets-default", "helm:external-secrets/external-secrets", "2.8.0", "default"),
  lane("external-secrets-no-crds", "helm:external-secrets/external-secrets", "2.8.0", "no-crds"),
  lane("argo-cd-no-crds", "helm:argo-cd/argo-cd", "10.2.1", "no-crds"),
  lane("argo-cd-default", "helm:argo-cd/argo-cd", "10.2.1", "default"),
  lane("kps-default", "helm:prometheus-community/kube-prometheus-stack", "87.19.2", "default"),
  lane("kps-no-crds", "helm:prometheus-community/kube-prometheus-stack", "87.19.2", "no-crds"),
  lane("kps-existing-secret", "helm:prometheus-community/kube-prometheus-stack", "87.19.2", "existing-secret"),
  lane("traefik-default", "helm:traefik/traefik", "41.0.2", "default"),
];
const expectedLanes = current ? currentExpectedLanes : historicalExpectedLanes;

if (mode === "--dry-run") dryRun();
else if (mode === "--stage") stage();
else if (mode === "--verify-stage") verifyStage();
else if (mode === "--clean-stage") cleanStage();
else if (mode === "--promote") promote();
else if (mode === "--verify") verifyPromotion();
else if (mode === "--self-test") selfTest();
else usage();

function component(identity, script, variants, liveLanes, extra = {}) {
  return { identity, script, variants, liveLanes, ...extra };
}

function lane(id, canonicalIdentity, version, base) {
  return { id, canonicalIdentity, version, base };
}

function usage() {
  console.log(`Usage:
  node scripts/promote-kubara-catalog-candidates.mjs --dry-run [--stage-root .tmp/<path>]
  node scripts/promote-kubara-catalog-candidates.mjs --stage [--stage-root .tmp/<path>]
  node scripts/promote-kubara-catalog-candidates.mjs --verify-stage [--stage-root .tmp/<path>]
  node scripts/promote-kubara-catalog-candidates.mjs --clean-stage [--stage-root .tmp/<path>]
  node scripts/promote-kubara-catalog-candidates.mjs --promote [--stage-root .tmp/<path>]
  node scripts/promote-kubara-catalog-candidates.mjs --verify
  node scripts/promote-kubara-catalog-candidates.mjs --self-test

Promotion is deliberately separate from staging. --promote requires the committed
13-lane live receipt to pass. It fills missing files, accepts only byte-identical
retry residue, and refuses every conflicting pre-existing byte.
Add --current to stage or promote only the three versions added by Kubara
v0.13.0 / catalogs 1.1.0 after the historical seven-version promotion.`);
}

function loadComponents() {
  if (current) return loadCurrentComponents();
  const alignment = readYaml(join(repoRoot, alignmentRelative));
  check(alignment.kind === "KubaraCatalogAlignment", "Kubara catalog alignment kind changed");
  const aligned = new Map(
    (alignment.spec?.components ?? []).map((item) => [item.canonicalIdentity, item]),
  );
  return definitions.map((definition) => {
    const item = aligned.get(definition.identity);
    check(item, `${definition.identity}: alignment entry is missing`);
    const version = String(item.kubara?.selectedVersion ?? "");
    const artifactURL = item.kubara?.artifact?.url ?? "";
    const artifactSHA256 = String(
      item.kubara?.artifact?.sha256
      ?? item.kubara?.artifact?.chartLayerDigest
      ?? "",
    ).replace(/^sha256:/, "");
    const recipeBase = item.configHubCatalog?.recipeRoot ?? "";
    check(version, `${definition.identity}: selected version is missing`);
    check(artifactURL, `${definition.identity}: exact artifact URL is missing`);
    check(/^[0-9a-f]{64}$/.test(artifactSHA256), `${definition.identity}: exact artifact SHA is invalid`);
    check(recipeBase.startsWith("recipes/"), `${definition.identity}: recipe root is invalid`);
    const packageBase = recipeBase.replace(/^recipes\//, "packages/");
    const candidateRecipe = `data/kubara-catalog-refresh/candidates/${recipeBase}/${version}`;
    const candidatePackage = `data/kubara-catalog-refresh/candidates/${packageBase}/${version}`;
    const stageRecipe = `${stageRelative}/${recipeBase}/${version}`;
    const stagePackage = `${stageRelative}/${packageBase}/${version}`;
    const rootRecipe = `${recipeBase}/${version}`;
    const rootPackage = `${packageBase}/${version}`;
    const lifecycleExtra = definition.lifecycle
      ? {
          stage: `${stageRelative}/config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`,
          root: `config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`,
        }
      : null;
    const retainedVersions = (item.configHubCatalog?.retainedVersions ?? []).map(String);
    return {
      ...definition,
      version,
      artifactURL,
      artifactSHA256,
      retainedVersions,
      historicalVersions: retainedVersions.filter((retained) => retained !== version),
      candidateRecipe,
      candidatePackage,
      stageRecipe,
      stagePackage,
      rootRecipe,
      rootPackage,
      lifecycleExtra,
      rootRecipeBase: recipeBase,
      rootPackageBase: packageBase,
    };
  });
}

function loadCurrentComponents() {
  const artifactSet = readYaml(join(repoRoot, alignmentRelative));
  check(artifactSet.kind === "KubaraComponentArtifactSet", "current Kubara artifact set kind changed");
  const artifacts = new Map(
    (artifactSet.spec?.artifacts ?? []).map((item) => [item.canonicalIdentity, item]),
  );
  return definitions.map((definition) => {
    const artifact = artifacts.get(definition.identity);
    check(artifact, `${definition.identity}: current artifact entry is missing`);
    const version = String(artifact.version ?? "");
    const artifactURL = artifact.url ?? "";
    const artifactSHA256 = String(artifact.sha256 ?? "").replace(/^sha256:/, "");
    const recipeBase = definition.recipeRoot;
    check(version, `${definition.identity}: current selected version is missing`);
    check(artifactURL, `${definition.identity}: current exact artifact URL is missing`);
    check(/^[0-9a-f]{64}$/.test(artifactSHA256), `${definition.identity}: current exact artifact SHA is invalid`);
    check(recipeBase?.startsWith("recipes/"), `${definition.identity}: current recipe root is invalid`);
    const packageBase = recipeBase.replace(/^recipes\//, "packages/");
    const candidateRecipe = `data/kubara-catalog-refresh/current-candidates/${recipeBase}/${version}`;
    const candidatePackage = `data/kubara-catalog-refresh/current-candidates/${packageBase}/${version}`;
    const stageRecipe = `${stageRelative}/${recipeBase}/${version}`;
    const stagePackage = `${stageRelative}/${packageBase}/${version}`;
    const rootRecipe = `${recipeBase}/${version}`;
    const rootPackage = `${packageBase}/${version}`;
    const lifecycleExtra = definition.lifecycle
      ? {
          stage: `${stageRelative}/config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`,
          root: `config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`,
        }
      : null;
    const retainedVersions = versionDirectories(join(repoRoot, recipeBase));
    return {
      ...definition,
      version,
      artifactURL,
      artifactSHA256,
      retainedVersions,
      historicalVersions: retainedVersions.filter((retained) => retained !== version),
      candidateRecipe,
      candidatePackage,
      stageRecipe,
      stagePackage,
      rootRecipe,
      rootPackage,
      lifecycleExtra,
      rootRecipeBase: recipeBase,
      rootPackageBase: packageBase,
    };
  });
}

function versionDirectories(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function dryRun() {
  verifyOfflineCandidates();
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  if (current) {
    try {
      verifyHistoricalRoots(components);
      console.log("historical promotion gate: pass");
    } catch (error) {
      console.log(`historical promotion gate: blocked (${error.message})`);
    }
  } else {
    verifyHistoricalRoots(components);
  }
  console.log(`stage root: ${stageRelative}`);
  for (const item of components) {
    const destinations = [item.rootRecipe, item.rootPackage, item.lifecycleExtra?.root].filter(Boolean);
    console.log(`${item.identity}@${item.version}`);
    console.log(`  generator: ${item.script} (exact URL + sha256:${item.artifactSHA256})`);
    console.log(`  variants: ${item.variants.join(", ")}`);
    console.log(`  additive destinations: ${destinations.join(", ")}`);
    console.log(`  destination state: ${destinations.every((path) => !existsRepo(path)) ? "available" : "present (exact retry residue is accepted; any conflicting byte is refused)"}`);
  }
  if (!existsRepo(liveReceiptRelative)) {
    console.log(`live gate: blocked until ${liveReceiptRelative} exists and all 13 exact-artifact lanes pass`);
  } else {
    try {
      verifyLiveReceipt(components);
      console.log(`live gate: pass (${liveReceiptRelative})`);
    } catch (error) {
      console.log(`live gate: blocked (${error.message})`);
    }
  }
  console.log("dry-run complete; no staged, root, alignment, candidate, or OCI state was changed");
}

function stage() {
  verifyOfflineCandidates();
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  verifyHistoricalRoots(components);
  resetStageRoot();
  for (const item of components) {
    console.log(`staging root-ready ${item.identity}@${item.version}`);
    runProof(item, "--generate-proof", stageRelative);
    if (item.lifecycle) runLifecycle(item, "--generate", stageRelative);
    runProof(item, "--generate-package", stageRelative);
  }
  verifyStage();
  console.log(`staged ${components.length} exact Kubara versions under ${stageRelative}; root Catalog is unchanged`);
}

function verifyStage() {
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  check(existsSync(stageRoot), `${stageRelative} is missing; run --stage first`);
  for (const item of components) {
    runProof(item, "--verify-proof", stageRelative);
    if (item.lifecycle) runLifecycle(item, "--verify", stageRelative);
    runProof(item, "--verify-package", stageRelative);
    verifyReadyTrees(item, "stage");
  }
  console.log(`verified ${components.length} staged root-ready Kubara component versions and ${components.reduce((sum, item) => sum + item.variants.length, 0)} candidate-parity variants`);
}

function cleanStage() {
  check(stageRelative.startsWith(".tmp/"), "stage cleanup is restricted to .tmp/<path>");
  rmSync(stageRoot, { recursive: true, force: true });
  console.log(`removed disposable Kubara promotion stage ${stageRelative}`);
}

function promote() {
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  if (existsRepo(promotionReceiptRelative)) {
    verifyPromotion();
    console.log(`${promotionReceiptRelative} already exists and verifies; additive promotion is already complete`);
    return;
  }
  verifyStage();
  const liveReceipt = verifyLiveReceipt(components);
  verifyHistoricalRoots(components);
  verifyPrePromotionAdditionState();
  const candidateBefore = candidateDigests(components);
  const candidateEntriesBefore = candidateEntriesDigest();
  const historicalBefore = historicalRootDigests(components);
  const promotionTrees = preparePromotionTrees(components);
  for (const tree of promotionTrees) {
    mergeNewTree(tree.source, tree.destination, tree.digest, tree.allowedExtraFiles);
  }
  // Lifecycle generation receipts record their routed file paths. A staged
  // receipt therefore cannot be copied byte-for-byte into the retained root:
  // its `.tmp/...` routes would be stale. Regenerate only the newly added KPS
  // lifecycle route at its final location before computing the promotion
  // receipt. All other generated lifecycle files remain content-locked by the
  // subsequent proof and tree verification.
  for (const item of components) {
    if (item.lifecycle) runLifecycle(item, "--generate", ".");
  }
  verifyRequiredAdditions(current ? KUBARA_CATALOG_ADDITIONS : KUBARA_HISTORICAL_ADDITIONS);
  check(
    stableJson(candidateDigests(components)) === stableJson(candidateBefore),
    "immutable Kubara candidate trees changed during root promotion",
  );
  check(
    candidateEntriesDigest() === candidateEntriesBefore,
    "immutable Kubara candidate-set entries changed during root promotion",
  );
  check(
    stableJson(historicalRootDigests(components)) === stableJson(historicalBefore),
    "historical Kubara roots changed during additive promotion",
  );
  // Do not emit a promotion receipt until every final-root generator and
  // package verifier passes. This keeps an interrupted or invalid merge
  // retryable without leaving a success-shaped receipt behind.
  for (const item of components) {
    runProof(item, "--verify-proof", ".");
    if (item.lifecycle) runLifecycle(item, "--verify", ".");
    runProof(item, "--verify-package", ".");
    verifyReadyTrees(item, "root");
  }
  const receipt = promotionReceipt(components, liveReceipt);
  writeYaml(join(repoRoot, promotionReceiptRelative), receipt);
  verifyPromotion();
  console.log(`promoted ${components.length} exact Kubara versions additively; no OCI publication was performed`);
}

function verifyPromotion() {
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  verifyRequiredAdditions(current ? KUBARA_CATALOG_ADDITIONS : KUBARA_HISTORICAL_ADDITIONS);
  verifyHistoricalRoots(components);
  const liveReceipt = verifyLiveReceipt(components);
  for (const item of components) {
    runProof(item, "--verify-proof", ".");
    if (item.lifecycle) runLifecycle(item, "--verify", ".");
    runProof(item, "--verify-package", ".");
    verifyReadyTrees(item, "root");
  }
  check(existsRepo(promotionReceiptRelative), `${promotionReceiptRelative} is missing`);
  const actual = readYaml(join(repoRoot, promotionReceiptRelative));
  const expected = promotionReceipt(components, liveReceipt);
  check(stableJson(actual) === stableJson(expected), "Kubara root-promotion receipt is stale");
  console.log(`verified additive Kubara root promotion for ${components.length} components`);
}

function runProof(item, command, outputRelative) {
  const env = {
    ...process.env,
    HELM_EXPT_CHART_VERSION: item.version,
    HELM_EXPT_PROOF_OUTPUT_ROOT: outputRelative,
    HELM_EXPT_PROOF_SCRIPT_PREFIX: "kubara-catalog-promotion",
    HELM_EXPT_PROOF_COMMANDS: [
      "npm run kubara-catalog-promotion:stage",
      "npm run kubara-catalog-promotion:stage:verify",
      "npm run kubara-catalog-promotion:dry-run",
    ].join("\n"),
    HELM_EXPT_CHART_ARTIFACT_URL: item.artifactURL,
    HELM_EXPT_CHART_ARTIFACT_SHA256: item.artifactSHA256,
  };
  delete env.HELM_EXPT_PROOF_OFFLINE_CANDIDATE;
  if (item.lifecycle) {
    env.HELM_EXPT_KPS_PACKAGE_EXTRAS_ROOT = `${outputRelative}/config-catalog/package-extras/prometheus-community/kube-prometheus-stack`;
  }
  if (item.genericCandidate) {
    env.HELM_EXPT_KUBARA_CANDIDATE = item.genericCandidate;
    env.HELM_EXPT_KUBARA_ROOT_READY = "1";
  }
  execFileSync(process.execPath, [item.script, command], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}

function runLifecycle(item, command, outputRelative) {
  const env = {
    ...process.env,
    HELM_EXPT_PROOF_OUTPUT_ROOT: outputRelative,
    HELM_EXPT_CHART_ARTIFACT_URL: item.artifactURL,
    HELM_EXPT_CHART_ARTIFACT_SHA256: item.artifactSHA256,
  };
  delete env.HELM_EXPT_PROOF_OFFLINE_CANDIDATE;
  execFileSync(
    process.execPath,
    ["scripts/generate-kps-packaged-lifecycle.mjs", command, "--version", item.version],
    { cwd: repoRoot, env, stdio: "inherit", maxBuffer: 1024 * 1024 * 300 },
  );
}

function verifyReadyTrees(item, location) {
  const recipeRelative = location === "stage" ? item.stageRecipe : item.rootRecipe;
  const packageRelative = location === "stage" ? item.stagePackage : item.rootPackage;
  const lifecycleRelative = location === "stage" ? item.lifecycleExtra?.stage : item.lifecycleExtra?.root;
  const recipePath = join(repoRoot, recipeRelative);
  const packagePath = join(repoRoot, packageRelative);
  check(existsSync(recipePath), `${recipeRelative} is missing`);
  check(existsSync(packagePath), `${packageRelative} is missing`);
  const sourceLock = readYaml(join(recipePath, "source-lock.yaml"));
  check(sourceLock.spec?.version === item.version, `${item.identity}: ${location} source-lock version mismatch`);
  check(sourceLock.spec?.exactArtifact?.url === item.artifactURL, `${item.identity}: ${location} exact artifact URL mismatch`);
  check(sourceLock.spec?.exactArtifact?.sha256 === item.artifactSHA256, `${item.identity}: ${location} exact artifact SHA mismatch`);
  check(sourceLock.spec?.packageSHA256 === item.artifactSHA256, `${item.identity}: ${location} package SHA mismatch`);
  const sourceEvidence = sourceLock.spec?.evidence?.exactArtifactRenderReceipt;
  check(Boolean(sourceEvidence), `${item.identity}: ${location} exact-artifact render evidence is missing`);
  check(existsSync(join(recipePath, sourceEvidence)), `${item.identity}: ${location} exact-artifact render evidence does not resolve`);
  check(sourceLock.spec?.evidence?.harnessReceipt == null, `${item.identity}: ${location} source lock claims stale harness evidence`);
  check(!existsSync(join(recipePath, "evaluation")), `${item.identity}: ${location} retained candidate evaluation residue`);
  const receiptPath = join(recipePath, "publication", "installer-package-receipt.yaml");
  check(existsSync(receiptPath), `${item.identity}: ${location} publication receipt is missing`);
  const publication = readYaml(receiptPath);
  check(publication.spec?.package?.path === packageRelative, `${item.identity}: ${location} publication path mismatch`);
  for (const variant of item.variants) {
    const candidateRender = join(repoRoot, item.candidateRecipe, "revisions", variant, "r001", "rendered", "release-objects.yaml");
    const readyRender = join(recipePath, "revisions", variant, "r001", "rendered", "release-objects.yaml");
    check(existsSync(candidateRender), `${item.identity}: immutable candidate ${variant} render is missing`);
    check(existsSync(readyRender), `${item.identity}: ${location} ${variant} render is missing`);
    check(sha256File(readyRender) === sha256File(candidateRender), `${item.identity}: ${location} ${variant} differs from exact candidate render`);
    for (const file of ["kustomization.yaml", "upstream.yaml"]) {
      compareCandidateFile(item, join("bases", variant, file), packagePath, location);
    }
  }
  compareCandidateFile(item, "installer.yaml", packagePath, location);
  if (lifecycleRelative) check(existsRepo(lifecycleRelative), `${lifecycleRelative} is missing`);
  rejectOfflineResidue(recipePath, `${item.identity} ${location} recipe`);
  rejectOfflineResidue(packagePath, `${item.identity} ${location} package`);
  if (lifecycleRelative) rejectOfflineResidue(join(repoRoot, lifecycleRelative), `${item.identity} ${location} lifecycle extras`);
}

function compareCandidateFile(item, file, readyPackagePath, location) {
  const candidate = join(repoRoot, item.candidatePackage, file);
  const ready = join(readyPackagePath, file);
  check(existsSync(candidate), `${item.identity}: candidate package file ${file} is missing`);
  check(existsSync(ready), `${item.identity}: ${location} package file ${file} is missing`);
  check(sha256File(candidate) === sha256File(ready), `${item.identity}: ${location} package ${file} differs from immutable candidate`);
}

function rejectOfflineResidue(root, label) {
  const residue = /offline(?:[- ]candidate|[- ]only|[- ]local[- ]evaluation)|root-catalog-promotion|live qualification has not run|Kubara ServiceDefinition, wrapper, defaults, and additions compatibility is incomplete/i;
  for (const path of listFiles(root)) {
    const text = readFileSync(path, "utf8");
    check(!residue.test(text), `${label}: offline candidate residue remains in ${relativeRepo(path)}`);
    if (path.endsWith("install-gate.yaml")) {
      const gate = readYaml(path);
      check(gate.spec?.decision !== "blocked", `${label}: blocked offline install gate remains in ${relativeRepo(path)}`);
      check(!(gate.spec?.allowedScopes ?? []).includes("offline-local-evaluation"), `${label}: offline allowed scope remains in ${relativeRepo(path)}`);
      check(!(gate.spec?.blockedScopes ?? []).includes("root-catalog-promotion"), `${label}: root promotion remains blocked in ${relativeRepo(path)}`);
    }
  }
}

function verifyLiveReceipt(components) {
  const path = join(repoRoot, liveReceiptRelative);
  check(existsSync(path), `${liveReceiptRelative} is missing`);
  const receipt = readYaml(path);
  validateLiveReceipt(receipt, components);
  return receipt;
}

function validateLiveReceipt(receipt, components) {
  check(receipt.kind === "KubaraLiveQualificationSetReceipt", "Kubara live qualification receipt kind changed");
  check(receipt.spec?.sourceCandidateSet === candidateSetRelative, "Kubara live receipt uses a different candidate set");
  check(receipt.spec?.execution === "serial", "Kubara live qualification was not serial");
  check(receipt.spec?.exactArtifactRequired === true, "Kubara live qualification did not require exact artifacts");
  check(receipt.spec?.laneCount === 13, "Kubara live qualification must contain 13 lanes");
  check(receipt.spec?.componentCount === 7, "Kubara live qualification must contain seven components");
  check(receipt.status?.result === "pass", "Kubara live qualification set did not pass");
  const rows = receipt.spec?.lanes ?? [];
  check(rows.length === expectedLanes.length, `expected ${expectedLanes.length} live lanes, found ${rows.length}`);
  check(stableJson(rows.map(laneIdentity)) === stableJson(expectedLanes), "Kubara live lane identities, versions, bases, or order changed");
  const byIdentity = liveArtifactMap(components);
  for (const row of rows) {
    const item = byIdentity.get(row.canonicalIdentity);
    check(item, `${row.id}: live lane component is unknown`);
    check(row.result === "pass", `${row.id}: live lane did not pass`);
    check(Boolean(row.observedAt), `${row.id}: live lane lacks observedAt`);
    check(row.cleanup?.clusterLifecycle === "cleaned-up", `${row.id}: cluster was not cleaned up`);
    check(row.cleanup?.result === "pass", `${row.id}: cleanup did not pass`);
    for (const leg of ["regularHelm", "configHubKubectlApply", "configHubOciArgo"]) {
      check(row.legs?.[leg] === "pass", `${row.id}: ${leg} did not pass`);
    }
    const source = row.sourceArtifact ?? {};
    check(source.result === "pass", `${row.id}: exact source artifact did not pass`);
    check(source.resolution === "artifact-addressed", `${row.id}: source was not artifact-addressed`);
    check(source.url === item.artifactURL, `${row.id}: exact artifact URL mismatch`);
    check(source.expectedSHA256 === item.artifactSHA256, `${row.id}: expected exact artifact SHA mismatch`);
    check(source.observedSHA256 === item.artifactSHA256, `${row.id}: observed exact artifact SHA mismatch`);
  }
}

function liveArtifactMap(components) {
  if (!current) return new Map(components.map((item) => [item.identity, item]));
  const artifactSet = readYaml(join(repoRoot, alignmentRelative));
  return new Map((artifactSet.spec?.artifacts ?? []).map((item) => [
    item.canonicalIdentity,
    {
      identity: item.canonicalIdentity,
      artifactURL: item.url,
      artifactSHA256: String(item.sha256 ?? "").replace(/^sha256:/, ""),
    },
  ]));
}

function laneIdentity(row) {
  return {
    id: row.id,
    canonicalIdentity: row.canonicalIdentity,
    version: String(row.version),
    base: row.base,
  };
}

function verifyOfflineCandidates() {
  execFileSync(
    process.execPath,
    [
      current
        ? "scripts/run-kubara-current-catalog-candidates.mjs"
        : "scripts/run-kubara-catalog-candidates.mjs",
      "--verify",
    ],
    {
    cwd: repoRoot,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
    },
  );
}

function verifyHistoricalRoots(components) {
  if (current) {
    verifyPriorHistoricalPromotion();
  }
  for (const item of components) {
    for (const version of item.historicalVersions) {
      check(existsRepo(`${item.rootRecipeBase}/${version}`), `${item.identity}: historical recipe ${version} is missing`);
      check(existsRepo(`${item.rootPackageBase}/${version}`), `${item.identity}: historical package ${version} is missing`);
      if (item.lifecycle) {
        check(
          existsRepo(`config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`),
          `${item.identity}: historical lifecycle extras ${version} are missing`,
        );
      }
    }
  }
}

function verifyPriorHistoricalPromotion() {
  const receiptRelative = "data/kubara-catalog-refresh/root-promotion/receipt.yaml";
  check(existsRepo(receiptRelative), "current promotion requires the additive v0.12 exact-pin promotion first");
  const receipt = readYaml(join(repoRoot, receiptRelative));
  check(receipt.kind === "KubaraCatalogRootPromotionReceipt", `${receiptRelative}: kind changed`);
  check(receipt.spec?.retentionMode === "additive-only-non-overwrite", `${receiptRelative}: retention mode changed`);
  check(receipt.spec?.additionWave === "historical-7", `${receiptRelative}: historical addition wave changed`);
  check(receipt.spec?.additionCount === KUBARA_HISTORICAL_ADDITIONS.length, `${receiptRelative}: historical addition count changed`);
  check(stableJson(receipt.spec?.immutableBaseline ?? {}) === stableJson({
    versionCount: KUBARA_CATALOG_BASELINE.versionCount,
    recipesTreeSHA256: KUBARA_CATALOG_BASELINE.recipesTreeSHA256,
    packagesTreeSHA256: KUBARA_CATALOG_BASELINE.packagesTreeSHA256,
  }), `${receiptRelative}: immutable baseline lock changed`);
  check(receipt.status?.result === "pass", `${receiptRelative}: result did not pass`);
  check(receipt.status?.immutableBaselinePreserved === true, `${receiptRelative}: immutable baseline was not recorded preserved`);
  const components = receipt.spec?.components ?? [];
  check(components.length === KUBARA_HISTORICAL_ADDITIONS.length, `${receiptRelative}: expected seven promoted components`);
  const paths = components.map((item) => item.retainedRoot?.recipe?.replace(/^recipes\//, "")).sort();
  check(stableJson(paths) === stableJson([...KUBARA_HISTORICAL_ADDITIONS].sort()), `${receiptRelative}: promoted recipe scope changed`);
  for (const item of components) {
    const recipe = item.retainedRoot?.recipe;
    const packagePath = item.retainedRoot?.package;
    check(recipe && packagePath, `${receiptRelative}: retained root path is missing`);
    check(recipeCoreTreeDigest(join(repoRoot, recipe)) === item.retainedRoot.recipeCoreTreeSHA256, `${receiptRelative}: ${recipe} core bytes changed`);
    check(treeDigest(join(repoRoot, packagePath)) === item.retainedRoot.packageTreeSHA256, `${receiptRelative}: ${packagePath} bytes changed`);
  }
  const livePath = receipt.spec?.liveQualificationReceipt;
  check(livePath === "runs/kubara-live-qualification/receipt.yaml", `${receiptRelative}: historical live receipt path changed`);
  check(existsRepo(livePath), `${receiptRelative}: historical live receipt is missing`);
  check(sha256File(join(repoRoot, livePath)) === receipt.spec?.liveQualificationReceiptSHA256, `${receiptRelative}: historical live receipt bytes changed`);
}

function promotionReceipt(components, liveReceipt) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogRootPromotionReceipt",
    metadata: {
      name: current
        ? "kubara-v0-13-0-catalogs-v1-1-0-additions-root-promotion"
        : "kubara-v0-12-0-exact-pins-root-promotion",
    },
    spec: {
      sourceAlignment: alignmentRelative,
      sourceCandidateSet: candidateSetRelative,
      sourceCandidateEntriesSHA256: candidateEntriesDigest(),
      liveQualificationReceipt: liveReceiptRelative,
      liveQualificationReceiptSHA256: sha256File(join(repoRoot, liveReceiptRelative)),
      retentionMode: "additive-only-non-overwrite",
      immutableBaseline: {
        versionCount: KUBARA_CATALOG_BASELINE.versionCount,
        recipesTreeSHA256: KUBARA_CATALOG_BASELINE.recipesTreeSHA256,
        packagesTreeSHA256: KUBARA_CATALOG_BASELINE.packagesTreeSHA256,
      },
      additionWave: current ? "current-3-after-historical-7" : "historical-7",
      additionCount: components.length,
      rootVersionCountAfterWave: KUBARA_CATALOG_BASELINE.versionCount
        + KUBARA_HISTORICAL_ADDITIONS.length
        + (current ? KUBARA_CURRENT_ADDITIONS.length : 0),
      ociPublication: "not-performed",
      components: components.map((item) => ({
        canonicalIdentity: item.identity,
        version: item.version,
        exactArtifact: { url: item.artifactURL, sha256: item.artifactSHA256 },
        immutableCandidate: {
          recipe: item.candidateRecipe,
          recipeTreeSHA256: treeDigest(join(repoRoot, item.candidateRecipe)),
          package: item.candidatePackage,
          packageTreeSHA256: treeDigest(join(repoRoot, item.candidatePackage)),
        },
        retainedRoot: {
          recipe: item.rootRecipe,
          recipeCoreTreeSHA256: recipeCoreTreeDigest(join(repoRoot, item.rootRecipe)),
          package: item.rootPackage,
          packageTreeSHA256: treeDigest(join(repoRoot, item.rootPackage)),
          ...(item.lifecycleExtra
            ? {
                lifecycleExtras: item.lifecycleExtra.root,
                lifecycleExtrasTreeSHA256: treeDigest(join(repoRoot, item.lifecycleExtra.root)),
              }
            : {}),
        },
        historicalRoots: item.historicalVersions.map((version) => ({
          version,
          recipe: `${item.rootRecipeBase}/${version}`,
          recipeCoreTreeSHA256: recipeCoreTreeDigest(join(repoRoot, item.rootRecipeBase, version)),
          package: `${item.rootPackageBase}/${version}`,
          packageTreeSHA256: treeDigest(join(repoRoot, item.rootPackageBase, version)),
          ...(item.lifecycle
            ? {
                lifecycleExtras: `config-catalog/package-extras/prometheus-community/kube-prometheus-stack/${version}`,
                lifecycleExtrasTreeSHA256: treeDigest(join(
                  repoRoot,
                  "config-catalog/package-extras/prometheus-community/kube-prometheus-stack",
                  version,
                )),
              }
            : {}),
        })),
        liveQualificationLanes: item.liveLanes,
      })),
    },
    status: {
      result: "pass",
      componentCount: components.length,
      laneCount: liveReceipt.spec?.laneCount,
      immutableBaselinePreserved: true,
      historicalRootsPreserved: true,
      candidatesPreserved: true,
    },
  };
}

function candidateDigests(components) {
  return components.map((item) => ({
    identity: item.identity,
    recipe: treeDigest(join(repoRoot, item.candidateRecipe)),
    package: treeDigest(join(repoRoot, item.candidatePackage)),
  }));
}

function candidateEntriesDigest() {
  const candidateSet = readYaml(join(repoRoot, candidateSetRelative));
  check(candidateSet.kind === "KubaraCatalogCandidateSet", "Kubara candidate-set kind changed");
  const hash = createHash("sha256");
  hash.update(stableJson(candidateSet.spec?.candidates ?? []));
  return hash.digest("hex");
}

function historicalRootDigests(components) {
  return components.flatMap((item) => item.historicalVersions.map((version) => ({
    identity: item.identity,
    version,
    recipeCore: recipeCoreTreeDigest(join(repoRoot, item.rootRecipeBase, version)),
    package: treeDigest(join(repoRoot, item.rootPackageBase, version)),
    ...(item.lifecycle
      ? {
          lifecycleExtras: treeDigest(join(
            repoRoot,
            "config-catalog/package-extras/prometheus-community/kube-prometheus-stack",
            version,
          )),
        }
      : {}),
  })));
}

function recipeCoreTreeDigest(root) {
  return treeDigest(root, (path) => !derivedRecipeFiles.has(relative(root, path).replaceAll("\\", "/")));
}

function treeDigest(root, include = () => true) {
  check(existsSync(root), `${relativeRepo(root)} is missing`);
  const hash = createHash("sha256");
  for (const path of listFiles(root).filter(include)) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(sha256File(path));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function verifyReleaseScope(components) {
  const actual = components.map((item) => item.rootRecipe.replace(/^recipes\//, "")).sort();
  const expected = [...(current ? KUBARA_CURRENT_ADDITIONS : KUBARA_HISTORICAL_ADDITIONS)].sort();
  check(stableJson(actual) === stableJson(expected), `promotion scope must be exactly the declared ${expected.length}-version Kubara addition wave`);
  const destinations = components.flatMap((item) => [
    item.rootRecipe,
    item.rootPackage,
    item.lifecycleExtra?.root,
  ].filter(Boolean));
  check(new Set(destinations).size === destinations.length, "promotion destinations are not unique");
}

function verifyBaselineCatalogRoots() {
  for (const rootName of ["recipes", "packages"]) {
    const roots = catalogVersionRoots(rootName);
    const additions = new Set(KUBARA_CATALOG_ADDITIONS.map((path) => `${rootName}/${path}`));
    const fullCoverageAdditions = new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => `${rootName}/${item.canonicalIdentity}/${item.version}`));
    const baselineRoots = roots.filter((path) => !additions.has(path) && !fullCoverageAdditions.has(path));
    check(
      baselineRoots.length === KUBARA_CATALOG_BASELINE.versionCount,
      `${rootName}: expected ${KUBARA_CATALOG_BASELINE.versionCount} immutable baseline roots, found ${baselineRoots.length}`,
    );
    const expectedDigest = rootName === "recipes"
      ? KUBARA_CATALOG_BASELINE.recipesTreeSHA256
      : KUBARA_CATALOG_BASELINE.packagesTreeSHA256;
    check(catalogTreeSetDigest(baselineRoots) === expectedDigest, `${rootName}: an immutable baseline root was removed or changed`);
    const retained120 = roots.filter((path) => !fullCoverageAdditions.has(path));
    const expected120 = rootName === "recipes"
      ? KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256
      : KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256;
    check(
      retained120.length === KUBARA_CATALOG_1_1_BASELINE.versionCount
        && catalogTreeSetDigest(retained120) === expected120,
      `${rootName}: the immutable 120-root intermediate Catalog changed`,
    );
    const declared = new Set([...baselineRoots, ...additions, ...fullCoverageAdditions]);
    check(roots.every((path) => declared.has(path)), `${rootName}: undeclared catalog root exists`);
    check(roots.length <= KUBARA_CATALOG_1_1_FINAL.versionCount, `${rootName}: undeclared catalog roots exceed the ${KUBARA_CATALOG_1_1_FINAL.versionCount}-version release scope`);
  }
}

function catalogVersionRoots(rootName) {
  const roots = [];
  const root = join(repoRoot, rootName);
  for (const repository of versionDirectories(root)) {
    for (const chart of versionDirectories(join(root, repository))) {
      for (const version of versionDirectories(join(root, repository, chart))) {
        roots.push(`${rootName}/${repository}/${chart}/${version}`);
      }
    }
  }
  return roots.sort();
}

function catalogTreeSetDigest(roots) {
  const hash = createHash("sha256");
  for (const root of [...roots].sort()) {
    hash.update(`${root}\0`);
    for (const path of listFiles(join(repoRoot, root))) {
      hash.update(`${relative(repoRoot, path).replaceAll("\\", "/")}\0`);
      hash.update(`${sha256File(path)}\n`);
    }
  }
  return hash.digest("hex");
}

function presentAdditions(rootName) {
  const roots = new Set(catalogVersionRoots(rootName));
  return KUBARA_CATALOG_ADDITIONS.filter((path) => roots.has(`${rootName}/${path}`));
}

function verifyPrePromotionAdditionState() {
  const recipeAdditions = new Set(presentAdditions("recipes"));
  const packageAdditions = new Set(presentAdditions("packages"));
  if (current) {
    for (const path of KUBARA_HISTORICAL_ADDITIONS) {
      check(recipeAdditions.has(path), `recipes/${path}: current promotion requires all seven historical additions first`);
      check(packageAdditions.has(path), `packages/${path}: current promotion requires all seven historical additions first`);
    }
  } else {
    for (const path of KUBARA_CURRENT_ADDITIONS) {
      check(!recipeAdditions.has(path), `recipes/${path}: historical promotion must precede the current addition wave`);
      check(!packageAdditions.has(path), `packages/${path}: historical promotion must precede the current addition wave`);
    }
  }
}

function verifyRequiredAdditions(required) {
  for (const rootName of ["recipes", "packages"]) {
    const roots = new Set(catalogVersionRoots(rootName));
    for (const path of required) check(roots.has(`${rootName}/${path}`), `${rootName}/${path} is missing from the additive catalog root`);
  }
}

function preparePromotionTrees(components) {
  rmSync(promotionReadyRoot, { recursive: true, force: true });
  mkdirSync(promotionReadyRoot, { recursive: true });
  const trees = [];
  for (const item of components) {
    const readyRecipe = `${promotionReadyRelative}/${item.rootRecipe}`;
    copyNewTree(item.stageRecipe, readyRecipe);
    rewritePublicationReceipt(readyRecipe, item.stagePackage, item.rootPackage);
    trees.push({
      source: readyRecipe,
      destination: item.rootRecipe,
      digest: recipeCoreTreeDigest,
      allowedExtraFiles: derivedRecipeFiles,
    });
    trees.push({ source: item.stagePackage, destination: item.rootPackage, digest: treeDigest });
    if (item.lifecycleExtra) {
      trees.push({ source: item.lifecycleExtra.stage, destination: item.lifecycleExtra.root, digest: treeDigest });
    }
  }
  return trees;
}

function mergeNewTree(sourceRelative, destinationRelative, digest, allowedExtraFiles = new Set()) {
  const source = join(repoRoot, sourceRelative);
  const destination = join(repoRoot, destinationRelative);
  check(existsSync(source), `${sourceRelative} is missing`);
  mkdirSync(destination, { recursive: true });
  const sourceFiles = new Map(listFiles(source).map((path) => [relative(source, path).replaceAll("\\", "/"), path]));
  for (const [relativePath, sourcePath] of sourceFiles) {
    const destinationPath = join(destination, relativePath);
    if (existsSync(destinationPath)) {
      check(sha256File(destinationPath) === sha256File(sourcePath), `${destinationRelative}/${relativePath} already exists with different bytes; refusing overwrite`);
      continue;
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    const fileStageRoot = join(promotionReadyRoot, ".file-merge");
    mkdirSync(fileStageRoot, { recursive: true });
    const stagedFile = join(fileStageRoot, `${process.pid}-${createHash("sha256").update(destinationPath).digest("hex")}`);
    cpSync(sourcePath, stagedFile, { errorOnExist: true, force: false });
    try {
      linkSync(stagedFile, destinationPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      check(sha256File(destinationPath) === sha256File(sourcePath), `${destinationRelative}/${relativePath} appeared with different bytes; refusing overwrite`);
    } finally {
      if (existsSync(stagedFile)) unlinkSync(stagedFile);
    }
  }
  for (const destinationPath of listFiles(destination)) {
    const relativePath = relative(destination, destinationPath).replaceAll("\\", "/");
    check(sourceFiles.has(relativePath) || allowedExtraFiles.has(relativePath), `${destinationRelative}/${relativePath} is outside the additive promotion source; refusing adoption`);
  }
  check(digest(destination) === digest(source), `${destinationRelative}: retry-safe additive merge did not reproduce the staged tree`);
}

function resetStageRoot() {
  check(stageRelative.startsWith(".tmp/"), "stage reset is restricted to .tmp/<path>");
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
}

function copyNewTree(sourceRelative, destinationRelative) {
  const source = join(repoRoot, sourceRelative);
  const destination = join(repoRoot, destinationRelative);
  check(existsSync(source), `${sourceRelative} is missing`);
  check(!existsSync(destination), `${destinationRelative} already exists; refusing overwrite`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}

function rewritePublicationReceipt(recipeRelative, fromPackage, toPackage) {
  const path = join(repoRoot, recipeRelative, "publication", "installer-package-receipt.yaml");
  check(existsSync(path), `${relativeRepo(path)} is missing`);
  const current = readFileSync(path, "utf8");
  const rewritten = current.replaceAll(fromPackage, toPackage);
  check(rewritten !== current, `${relativeRepo(path)} did not contain staged package path ${fromPackage}`);
  writeFileSync(path, rewritten);
  const receipt = readYaml(path);
  check(receipt.spec?.package?.path === toPackage, `${relativeRepo(path)} root package path rewrite failed`);
}

function selfTest() {
  const components = loadComponents();
  verifyReleaseScope(components);
  verifyBaselineCatalogRoots();
  const temporaryRoot = join(repoRoot, ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const base = mkdtempSync(join(temporaryRoot, `kubara-catalog-promotion-self-test-${current ? "current" : "historical"}-`));
  try {
    const source = join(base, "source");
    const destination = join(base, "destination");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "proof.txt"), "root-ready\n");
    copyNewTree(relativeRepo(source), relativeRepo(destination));
    check(readFileSync(join(destination, "proof.txt"), "utf8") === "root-ready\n", "self-test additive copy failed");
    let overwriteRejected = false;
    try {
      copyNewTree(relativeRepo(source), relativeRepo(destination));
    } catch (error) {
      overwriteRejected = /already exists/.test(String(error.message));
    }
    check(overwriteRejected, "self-test did not reject overwrite");
    let residueRejected = false;
    writeFileSync(join(destination, "proof.txt"), "Offline candidate only.\n");
    try {
      rejectOfflineResidue(destination, "self-test");
    } catch (error) {
      residueRejected = /residue/.test(String(error.message));
    }
    check(residueRejected, "self-test did not reject offline residue");
    writeFileSync(join(destination, "proof.txt"), "root-ready\n");
    const first = treeDigest(destination);
    writeFileSync(join(destination, "proof.txt"), "tampered\n");
    check(treeDigest(destination) !== first, "self-test tree digest missed tampering");
    const mergeSource = join(base, "merge-source");
    const mergeDestination = join(base, "merge-destination");
    mkdirSync(join(mergeSource, "nested"), { recursive: true });
    mkdirSync(mergeDestination, { recursive: true });
    writeFileSync(join(mergeSource, "first.txt"), "first\n");
    writeFileSync(join(mergeSource, "nested", "second.txt"), "second\n");
    writeFileSync(join(mergeDestination, "first.txt"), "first\n");
    mergeNewTree(relativeRepo(mergeSource), relativeRepo(mergeDestination), treeDigest);
    mergeNewTree(relativeRepo(mergeSource), relativeRepo(mergeDestination), treeDigest);
    check(treeDigest(mergeDestination) === treeDigest(mergeSource), "self-test retry-safe merge did not converge");
    writeFileSync(join(mergeDestination, "first.txt"), "conflict\n");
    let mergeConflictRejected = false;
    try {
      mergeNewTree(relativeRepo(mergeSource), relativeRepo(mergeDestination), treeDigest);
    } catch (error) {
      mergeConflictRejected = /different bytes/.test(String(error.message));
    }
    check(mergeConflictRejected, "self-test did not reject a conflicting partial promotion");
    const componentByIdentity = liveArtifactMap(components);
    const liveReceipt = {
      kind: "KubaraLiveQualificationSetReceipt",
      spec: {
        sourceCandidateSet: candidateSetRelative,
        execution: "serial",
        exactArtifactRequired: true,
        laneCount: 13,
        componentCount: 7,
        lanes: expectedLanes.map((item) => {
          const component = componentByIdentity.get(item.canonicalIdentity);
          return {
            ...item,
            result: "pass",
            observedAt: "2026-08-04T00:00:00Z",
            sourceArtifact: {
              result: "pass",
              resolution: "artifact-addressed",
              url: component.artifactURL,
              expectedSHA256: component.artifactSHA256,
              observedSHA256: component.artifactSHA256,
            },
            legs: {
              regularHelm: "pass",
              configHubKubectlApply: "pass",
              configHubOciArgo: "pass",
            },
            cleanup: { clusterLifecycle: "cleaned-up", result: "pass" },
          };
        }),
      },
      status: { result: "pass" },
    };
    validateLiveReceipt(liveReceipt, components);
    liveReceipt.spec.lanes[0].sourceArtifact.observedSHA256 = "0".repeat(64);
    let liveTamperingRejected = false;
    try {
      validateLiveReceipt(liveReceipt, components);
    } catch (error) {
      liveTamperingRejected = /observed exact artifact SHA mismatch/.test(String(error.message));
    }
    check(liveTamperingRejected, "self-test did not reject live exact-artifact tampering");
    check(validateStageRelative(".tmp/kubara-safe") === ".tmp/kubara-safe", "self-test stage validation failed");
    for (const unsafe of ["/tmp/kubara", "../kubara", ".tmp/../recipes", ".tmp/.", ".tmp//kubara", "recipes/kubara"]) {
      let rejected = false;
      try {
        validateStageRelative(unsafe);
      } catch {
        rejected = true;
      }
      check(rejected, `self-test accepted unsafe stage root ${unsafe}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log("Kubara catalog promotion self-test passed: baseline lock, exact scope, retry-safe non-overwrite, residue rejection, live-gate tampering, digests, and stage-path safety");
}

function validateStageRelative(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  check(!normalized.startsWith("/"), "--stage-root must be relative");
  const parts = normalized.split("/");
  check(parts[0] === ".tmp" && parts.length >= 2, "--stage-root must be a repo-relative .tmp/<path>");
  check(parts.slice(1).every((part) => part && part !== "." && part !== ".."), "--stage-root must contain only named directories below .tmp");
  return normalized;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  check(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} requires a value`);
  return process.argv[index + 1];
}

function existsRepo(path) {
  return existsSync(join(repoRoot, path));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function relativeRepo(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}
