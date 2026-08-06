#!/usr/bin/env node

// Additive completion of every remote dependency selected by the pinned
// Kubara bootstrap/general catalogs 1.1.0 wrapper Chart.yaml files.
//
// Existing roots are an immutable 120-version baseline. The script generates
// ten exact-artifact candidates, proves their packages, promotes only missing
// roots, and publishes only the ten explicitly enumerated OCI refs. Existing
// external-dns and Traefik roots receive separate lock-registry supplements.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import {
  check,
  cubEnv,
  listFiles,
  readYaml,
  readYamlText,
  repoRoot,
  sha256File,
  toYaml,
} from "./lib/proof-common.mjs";
import { installerOciRefForPackagePath } from "./lib/installer-oci.mjs";
import {
  KUBARA_CATALOG_1_1_ADDITIONS,
  KUBARA_CATALOG_1_1_ARTIFACTS,
  KUBARA_CATALOG_1_1_BASELINE,
  KUBARA_CATALOG_1_1_FINAL,
  KUBARA_CATALOG_1_1_SUPPLEMENTS,
} from "./lib/kubara-catalog-1-1-full-coverage.mjs";

const mode = process.argv[2] ?? "--verify";
const dataRootRelative = "data/kubara-catalog-1.1-full-coverage";
const dataRoot = join(repoRoot, dataRootRelative);
const candidateRootRelative = `${dataRootRelative}/candidates`;
const snapshotRelative = "data/kubara-catalog-snapshots/kubara-catalogs-1.1.0-release/source";
const snapshotRoot = join(repoRoot, snapshotRelative);
const exactRegistryPath = join(dataRoot, "exact-artifact-registry.yaml");
const inventoryPath = join(dataRoot, "wrapper-dependency-inventory.yaml");
const matrixPath = join(dataRoot, "coverage-matrix.csv");
const publicationPlanPath = join(dataRoot, "publication-plan.yaml");
const preflightPath = join(dataRoot, "preflight-receipt.yaml");
const completionReceiptPath = join(dataRoot, "receipt.yaml");
const readmePath = join(dataRoot, "README.md");
const proofScript = "scripts/kubara-catalog-1-1-full-coverage-proof.mjs";

if (mode === "--generate") generate();
else if (mode === "--verify-candidates") verifyCandidates();
else if (mode === "--preflight") preflight();
else if (mode === "--promote") promote();
else if (mode === "--publish") publish();
else if (mode === "--verify") verifyFinal();
else if (mode === "--self-test") selfTest();
else usage();

function usage() {
  console.log(`Usage:
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --generate
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --verify-candidates
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --preflight
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --promote
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --publish
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --verify
  node scripts/complete-kubara-catalog-1-1-coverage.mjs --self-test

--publish is deliberately separate and serial. Existing refs are reused only
when their remote layer is byte-identical to the deterministic local package.`);
}

function generate() {
  verifyStaticContract();
  verifyBaselineRoots();
  const inventory = wrapperInventory();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    console.log(`generating exact Kubara 1.1.0 Catalog candidate ${item.canonicalIdentity}@${item.version}`);
    runProof(item, "--generate-proof");
    runProof(item, "--generate-package");
  }
  writeCoreOutputs(inventory);
  verifyCandidates();
  console.log(`generated ${KUBARA_CATALOG_1_1_ADDITIONS.length} exact additive candidates; retained roots and OCI state are unchanged`);
}

function verifyCandidates() {
  verifyStaticContract();
  verifyBaselineRoots();
  const inventory = wrapperInventory();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    runProof(item, "--verify-proof");
    runProof(item, "--verify-package");
    verifyCandidate(item);
  }
  verifySupplements();
  verifyCoreOutputs(inventory);
  console.log(`verified ${KUBARA_CATALOG_1_1_ADDITIONS.length} exact candidates, ${inventory.occurrences.length} wrapper dependency occurrences, and the immutable 120-root baseline`);
}

function preflight() {
  verifyCandidates();
  const artifactChecks = [];
  console.log("resolving all 18 exact Kubara catalogs 1.1.0 source artifacts serially");
  for (const item of KUBARA_CATALOG_1_1_ARTIFACTS) {
    artifactChecks.push(materializeAndVerifyArtifact(item));
  }
  const packageChecks = [];
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    const packageRelative = candidatePackageRelative(item);
    const packageSHA256 = deterministicPackageSHA256(packageRelative);
    const ref = installerOciRefForPackagePath(item.packagePath);
    const remote = inspectRemoteIfPresent(ref);
    if (remote) {
      check(remote.layerDigest === `sha256:${packageSHA256}`, `${ref}: remote layer conflicts with the exact candidate package; refusing publication`);
    }
    const rootState = rootAdditionState(item);
    packageChecks.push({
      canonicalIdentity: item.canonicalIdentity,
      version: item.version,
      candidatePackage: packageRelative,
      deterministicPackageSHA256: packageSHA256,
      retainedRoot: item.packagePath,
      retainedRootState: rootState,
      ref,
      remoteState: remote ? "present-byte-identical" : "absent",
      ...(remote ?? {}),
    });
  }
  const receipt = preflightReceipt(artifactChecks, packageChecks);
  writeText(preflightPath, yamlText(receipt));
  verifyPreflightReceipt();
  console.log(`preflight passed: 120 old roots preserved; ${packageChecks.length} additions are non-conflicting; no OCI write was performed`);
}

function promote() {
  verifyPreflightReceipt();
  verifyCandidates();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    mergeRootRecipe(item);
    mergeAdditiveTree(candidatePackageRelative(item), item.packagePath);
    verifyRootAddition(item);
  }
  verifyAllRoots();
  writeCoreOutputs(wrapperInventory());
  console.log(`promoted ${KUBARA_CATALOG_1_1_ADDITIONS.length} exact roots additively; no OCI write was performed`);
}

function publish() {
  verifyPreflightReceipt();
  verifyCandidates();
  verifyAllRoots();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    console.log(`publishing serially ${item.packagePath} -> ${installerOciRefForPackagePath(item.packagePath)}`);
    execFileSync(process.execPath, [
      "scripts/publish-installer-oci-packages.mjs",
      "--package",
      item.packagePath,
      "--idempotent",
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      maxBuffer: 1024 * 1024 * 200,
    });
    verifyPublication(item);
  }
  execFileSync(process.execPath, ["scripts/generate-installer-oci-catalog.mjs", "--generate"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 200,
  });
  execFileSync(process.execPath, ["scripts/generate-installer-oci-catalog.mjs", "--verify"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 200,
  });
  writeCoreOutputs(wrapperInventory());
  verifyFinal();
  console.log(`published and remotely verified ${KUBARA_CATALOG_1_1_ADDITIONS.length} exact packages; Catalog now contains 103 components and 130 retained versions`);
}

function verifyFinal() {
  verifyCandidates();
  verifyPreflightReceipt();
  verifyAllRoots();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    runRootProof(item, "--verify-proof");
    runRootProof(item, "--verify-package");
  }
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) verifyPublication(item);
  verifyInstallerCatalogRows();
  verifyCoreOutputs(wrapperInventory());
  const receipt = readYaml(completionReceiptPath);
  check(receipt.status?.result === "pass", "full Kubara 1.1.0 Catalog coverage receipt is not pass");
  check(receipt.status?.publishedPackageCount === 10, "full coverage receipt must contain ten published packages");
  console.log("verified full Kubara catalogs 1.1.0 coverage: 18 selections, 103 components, 130 versions, 10 exact OCI publications");
}

function verifyStaticContract() {
  check(KUBARA_CATALOG_1_1_ARTIFACTS.length === 18, "Kubara 1.1.0 unique artifact selection count must be 18");
  check(KUBARA_CATALOG_1_1_ADDITIONS.length === 10, "Kubara 1.1.0 additive root count must be ten");
  check(KUBARA_CATALOG_1_1_SUPPLEMENTS.length === 2, "Kubara 1.1.0 supplemental lock count must be two");
  check(new Set(KUBARA_CATALOG_1_1_ARTIFACTS.map(selectionKey)).size === 18, "Kubara artifact registry has duplicate selections");
  check(new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.recipePath)).size === 10, "Kubara addition recipe paths collide");
  check(new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.packagePath)).size === 10, "Kubara addition package paths collide");
  check(KUBARA_CATALOG_1_1_FINAL.versionCount === KUBARA_CATALOG_1_1_BASELINE.versionCount + 10, "final version count is not additive");
  check(KUBARA_CATALOG_1_1_FINAL.componentCount === KUBARA_CATALOG_1_1_BASELINE.componentCount + 3, "final component count is not additive");
  for (const item of KUBARA_CATALOG_1_1_ARTIFACTS) {
    check(/^[0-9a-f]{64}$/.test(item.sha256), `${selectionKey(item)}: invalid archive/layer SHA`);
    check(item.url.includes(item.version), `${selectionKey(item)}: exact artifact URL does not contain the selected version`);
    check(item.url.startsWith("https://") || item.url.startsWith("oci://"), `${selectionKey(item)}: artifact URL is not HTTPS or OCI`);
    if (item.url.startsWith("oci://")) {
      check(/^sha256:[0-9a-f]{64}$/.test(item.manifestDigest ?? ""), `${selectionKey(item)}: OCI manifest digest is missing`);
    } else {
      check(item.manifestDigest == null, `${selectionKey(item)}: HTTP chart must not invent an OCI manifest digest`);
    }
  }
}

function verifyBaselineRoots() {
  const additionRecipePaths = new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.recipePath));
  const additionPackagePaths = new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.packagePath));
  const recipeRoots = catalogVersionRoots("recipes").filter((item) => !additionRecipePaths.has(item));
  const packageRoots = catalogVersionRoots("packages").filter((item) => !additionPackagePaths.has(item));
  check(recipeRoots.length === 120, `immutable recipe baseline must contain 120 roots, found ${recipeRoots.length}`);
  check(packageRoots.length === 120, `immutable package baseline must contain 120 roots, found ${packageRoots.length}`);
  check(treeSetDigest(recipeRoots) === KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256, "an existing recipe root changed; refusing completion");
  check(treeSetDigest(packageRoots) === KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256, "an existing package root changed; refusing completion");
  check(componentCount(recipeRoots) === 100, "immutable recipe baseline component count changed");
  check(componentCount(packageRoots) === 100, "immutable package baseline component count changed");
}

function verifyAllRoots() {
  verifyBaselineRoots();
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) verifyRootAddition(item);
  const recipeRoots = catalogVersionRoots("recipes");
  const packageRoots = catalogVersionRoots("packages");
  check(recipeRoots.length === 130, `expected 130 recipe roots, found ${recipeRoots.length}`);
  check(packageRoots.length === 130, `expected 130 package roots, found ${packageRoots.length}`);
  check(componentCount(recipeRoots) === 103, `expected 103 recipe components, found ${componentCount(recipeRoots)}`);
  check(componentCount(packageRoots) === 103, `expected 103 package components, found ${componentCount(packageRoots)}`);
}

function wrapperInventory() {
  check(existsSync(snapshotRoot), `${snapshotRelative} is missing`);
  const registry = new Map(KUBARA_CATALOG_1_1_ARTIFACTS.map((item) => [selectionKey(item), item]));
  const occurrences = [];
  const wrapperFiles = listFiles(snapshotRoot)
    .filter((item) => basename(item) === "Chart.yaml")
    .sort();
  for (const wrapperFile of wrapperFiles) {
    const wrapper = readYaml(wrapperFile);
    for (const dependency of wrapper.dependencies ?? []) {
      if (String(dependency.repository ?? "").startsWith("file://")) continue;
      const key = `${canonicalIdentityForDependency(dependency)}@${String(dependency.version)}`;
      const artifact = registry.get(key);
      check(artifact, `${relativeRepoPath(wrapperFile)}: undeclared remote dependency ${key}`);
      occurrences.push({
        wrapper: relativeRepoPath(wrapperFile),
        wrapperName: wrapper.name,
        wrapperVersion: String(wrapper.version),
        dependencyName: dependency.name,
        dependencyRepository: dependency.repository,
        canonicalIdentity: artifact.canonicalIdentity,
        version: artifact.version,
      });
    }
  }
  occurrences.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  check(occurrences.length === 21, `expected 21 remote wrapper dependency occurrences, found ${occurrences.length}`);
  const selected = new Set(occurrences.map((item) => `${item.canonicalIdentity}@${item.version}`));
  check(selected.size === 18, `expected 18 unique remote wrapper selections, found ${selected.size}`);
  check(stableJson([...selected].sort()) === stableJson([...registry.keys()].sort()), "wrapper selections differ from the exact artifact registry");
  return { wrapperFiles, occurrences };
}

function canonicalIdentityForDependency(dependency) {
  const name = String(dependency.name ?? "");
  const repository = String(dependency.repository ?? "");
  const mappings = [
    [/argoproj\.github\.io\/argo-helm/, "argo-cd"],
    [/charts\.jetstack\.io/, "jetstack"],
    [/prometheus-community\.github\.io/, "prometheus-community"],
    [/charts\.external-secrets\.io/, "external-secrets"],
    [/grafana\.github\.io/, "grafana"],
    [/stakater\.github\.io/, "stakater"],
    [/kubernetes-sigs\.github\.io\/metrics-server/, "metrics-server"],
    [/oauth2-proxy\.github\.io/, "oauth2-proxy"],
    [/kyverno\.github\.io\/kyverno/, "kyverno"],
    [/kubernetes-sigs\.github\.io\/external-dns/, "external-dns"],
    [/vmware-tanzu\.github\.io/, "velero"],
    [/kyverno\.github\.io\/policy-reporter/, "policy-reporter"],
    [/charts\.longhorn\.io/, "longhorn"],
    [/metallb\.github\.io\/metallb/, "metallb"],
    [/ghcr\.io\/traefik\/helm/, "traefik"],
  ];
  const mapping = mappings.find(([pattern]) => pattern.test(repository));
  check(mapping, `unknown Kubara wrapper repository ${repository}`);
  return `${mapping[1]}/${name}`;
}

function verifyCandidate(item) {
  const recipeRoot = join(repoRoot, candidateRecipeRelative(item));
  const packageRoot = join(repoRoot, candidatePackageRelative(item));
  check(existsSync(recipeRoot), `${candidateRecipeRelative(item)} is missing`);
  check(existsSync(packageRoot), `${candidatePackageRelative(item)} is missing`);
  const lock = readYaml(join(recipeRoot, "source-lock.yaml"));
  check(lock.spec?.version === item.version, `${selectionKey(item)}: candidate source version changed`);
  check(lock.spec?.exactArtifact?.url === item.url, `${selectionKey(item)}: candidate exact URL changed`);
  check(lock.spec?.exactArtifact?.sha256 === item.sha256, `${selectionKey(item)}: candidate exact SHA changed`);
  check(lock.spec?.packageSHA256 === item.sha256, `${selectionKey(item)}: candidate package SHA differs from exact source`);
  const installer = readYaml(join(packageRoot, "installer.yaml"));
  check(installer.metadata?.version === item.version, `${selectionKey(item)}: installer version changed`);
  check(installer.spec?.bases?.length === 1, `${selectionKey(item)}: additive completion must expose exactly one reviewed base`);
  check(installer.spec.bases[0]?.name === "default" && installer.spec.bases[0]?.default === true, `${selectionKey(item)}: default base changed`);
}

function verifyRootAddition(item) {
  verifyCandidate(item);
  const candidateRecipe = join(repoRoot, candidateRecipeRelative(item));
  const candidatePackage = join(repoRoot, candidatePackageRelative(item));
  const rootRecipe = join(repoRoot, item.recipePath);
  const rootPackage = join(repoRoot, item.packagePath);
  check(existsSync(rootRecipe), `${item.recipePath} is missing`);
  check(existsSync(rootPackage), `${item.packagePath} is missing`);
  const receiptRelative = "publication/installer-package-receipt.yaml";
  const candidateFiles = new Map(listFiles(candidateRecipe).map((file) => [relative(candidateRecipe, file).replaceAll("\\", "/"), file]));
  const rootFiles = new Map(listFiles(rootRecipe).map((file) => [relative(rootRecipe, file).replaceAll("\\", "/"), file]));
  check(stableJson([...rootFiles.keys()].sort()) === stableJson([...candidateFiles.keys()].sort()), `${item.recipePath}: retained recipe file set differs from exact candidate`);
  for (const [relativePath, candidateFile] of candidateFiles) {
    if (relativePath === receiptRelative) continue;
    check(sha256File(rootFiles.get(relativePath)) === sha256File(candidateFile), `${item.recipePath}/${relativePath}: retained recipe differs from exact candidate`);
  }
  check(readFileSync(rootFiles.get(receiptRelative), "utf8") === rootReadyReceiptText(item), `${item.recipePath}: retained publication receipt does not bind the retained package root`);
  check(treeDigest(rootPackage) === treeDigest(candidatePackage), `${item.packagePath}: retained package differs from exact candidate`);
}

function verifySupplements() {
  const externalDNS = KUBARA_CATALOG_1_1_SUPPLEMENTS.find((item) => item.canonicalIdentity === "external-dns/external-dns");
  const traefik = KUBARA_CATALOG_1_1_SUPPLEMENTS.find((item) => item.canonicalIdentity === "traefik/traefik");
  check(externalDNS && traefik, "external-dns and Traefik supplements are required");
  const dnsLock = readYaml(join(repoRoot, externalDNS.recipePath, "source-lock.yaml"));
  check(dnsLock.spec?.packageSHA256 === externalDNS.sha256, "external-dns supplemental SHA differs from the immutable root lock");
  check(dnsLock.spec?.exactArtifact == null, "external-dns old root unexpectedly changed; exact URL must remain a separate supplement");
  const traefikLock = readYaml(join(repoRoot, traefik.recipePath, "source-lock.yaml"));
  check(traefikLock.spec?.exactArtifact?.url === traefik.url, "Traefik immutable root URL changed");
  check(traefikLock.spec?.exactArtifact?.sha256 === traefik.sha256, "Traefik immutable root layer SHA changed");
  check(traefikLock.spec?.exactArtifact?.manifestDigest == null, "Traefik old root unexpectedly changed; manifest digest must remain a separate supplement");
  check(/^sha256:[0-9a-f]{64}$/.test(traefik.manifestDigest), "Traefik supplemental manifest digest is invalid");
}

function runProof(item, command) {
  execFileSync(process.execPath, [proofScript, command], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HELM_EXPT_KUBARA_FULL_COVERAGE_CANDIDATE: item.candidate,
      HELM_EXPT_CHART_VERSION: item.version,
      HELM_EXPT_CHART_ARTIFACT_URL: item.url,
      HELM_EXPT_CHART_ARTIFACT_SHA256: item.sha256,
      HELM_EXPT_PROOF_OUTPUT_ROOT: candidateRootRelative,
      HELM_EXPT_PROOF_SCRIPT_PREFIX: "kubara-catalog-1.1-full-coverage",
    },
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}

function runRootProof(item, command) {
  execFileSync(process.execPath, [proofScript, command], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HELM_EXPT_KUBARA_FULL_COVERAGE_CANDIDATE: item.candidate,
      HELM_EXPT_CHART_VERSION: item.version,
      HELM_EXPT_CHART_ARTIFACT_URL: item.url,
      HELM_EXPT_CHART_ARTIFACT_SHA256: item.sha256,
      HELM_EXPT_PROOF_SCRIPT_PREFIX: "kubara-catalog-1.1-full-coverage",
    },
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}

function materializeAndVerifyArtifact(item) {
  const tempRoot = mkdtempSync(join(tmpdir(), "kubara-catalog-1-1-source-"));
  try {
    let archivePath;
    let resolvedManifestDigest;
    if (item.url.startsWith("https://")) {
      archivePath = join(tempRoot, `${item.chart}-${item.version}.tgz`);
      execFileSync("curl", ["--fail", "--location", "--retry", "3", "--silent", "--show-error", "--output", archivePath, item.url], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"],
      });
    } else {
      const withoutScheme = item.url.replace(/^oci:\/\//, "");
      resolvedManifestDigest = execFileSync("oras", ["resolve", withoutScheme], { cwd: repoRoot, encoding: "utf8" }).trim();
      check(resolvedManifestDigest === item.manifestDigest, `${selectionKey(item)}: upstream OCI manifest digest changed`);
      const suffix = `:${item.version}`;
      const chartRef = item.url.endsWith(suffix) ? item.url.slice(0, -suffix.length) : item.url;
      execFileSync("helm", ["pull", chartRef, "--version", item.version, "--destination", tempRoot], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"],
      });
      archivePath = listFiles(tempRoot).find((candidatePath) => candidatePath.endsWith(".tgz"));
    }
    check(archivePath && existsSync(archivePath), `${selectionKey(item)}: source retrieval produced no chart archive`);
    check(sha256File(archivePath) === item.sha256, `${selectionKey(item)}: source archive/layer SHA changed`);
    const chartMetadata = readYamlText(execFileSync("helm", ["show", "chart", archivePath], { cwd: repoRoot, encoding: "utf8" }));
    check(chartMetadata.name === item.chart, `${selectionKey(item)}: downloaded chart name is ${chartMetadata.name}`);
    check(String(chartMetadata.version) === item.version, `${selectionKey(item)}: downloaded chart version is ${chartMetadata.version}`);
    console.log(`verified source ${selectionKey(item)} sha256:${item.sha256}`);
    return {
      canonicalIdentity: item.canonicalIdentity,
      version: item.version,
      url: item.url,
      sha256: item.sha256,
      bytes: readFileSync(archivePath).length,
      ...(resolvedManifestDigest ? { manifestDigest: resolvedManifestDigest } : {}),
      result: "pass",
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function deterministicPackageSHA256(packageRelative) {
  const packageRoot = join(repoRoot, packageRelative);
  const tempRoot = mkdtempSync(join(tmpdir(), "kubara-catalog-1-1-package-"));
  try {
    const first = join(tempRoot, "first.tgz");
    const second = join(tempRoot, "second.tgz");
    for (const output of [first, second]) {
      execFileSync("cub", ["installer", "package", packageRoot, "-o", output], {
        cwd: repoRoot,
        env: cubEnv(),
        stdio: ["ignore", "ignore", "inherit"],
        maxBuffer: 1024 * 1024 * 200,
      });
    }
    check(readFileSync(first).equals(readFileSync(second)), `${packageRelative}: installer archive is not byte-deterministic`);
    return sha256File(first);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function inspectRemoteIfPresent(ref) {
  const result = spawnSync("cub", ["installer", "inspect", ref, "--json"], {
    cwd: repoRoot,
    env: cubEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/: not found\b/i.test(detail) || /manifest unknown/i.test(detail)) return null;
    throw new Error(`cannot safely inspect ${ref}; refusing publication\n${detail}`);
  }
  return inspectMetadata(result.stdout, ref);
}

function inspectMetadata(text, ref) {
  const parsed = JSON.parse(text);
  const manifestDigest = parsed.ManifestDigest ?? parsed.manifestDigest ?? "";
  const layerDigest = parsed.Config?.bundle?.layerDigest ?? parsed.config?.bundle?.layerDigest ?? "";
  check(/^sha256:[0-9a-f]{64}$/.test(manifestDigest), `${ref}: invalid remote manifest digest`);
  check(/^sha256:[0-9a-f]{64}$/.test(layerDigest), `${ref}: invalid remote layer digest`);
  return { manifestDigest, layerDigest };
}

function mergeAdditiveTree(sourceRelative, destinationRelative) {
  const source = sourceRelative.startsWith("/") ? sourceRelative : join(repoRoot, sourceRelative);
  const destination = destinationRelative.startsWith("/") ? destinationRelative : join(repoRoot, destinationRelative);
  check(existsSync(source), `${sourceRelative} is missing`);
  mkdirSync(destination, { recursive: true });
  const sourceFiles = new Map(listFiles(source).map((item) => [relative(source, item).replaceAll("\\", "/"), item]));
  for (const [relativePath, sourceFile] of sourceFiles) {
    const destinationFile = join(destination, relativePath);
    mkdirSync(dirname(destinationFile), { recursive: true });
    if (existsSync(destinationFile)) {
      check(sha256File(destinationFile) === sha256File(sourceFile), `${destinationRelative}/${relativePath}: conflicting byte exists; refusing overwrite`);
      continue;
    }
    try {
      copyFileSync(sourceFile, destinationFile, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      check(sha256File(destinationFile) === sha256File(sourceFile), `${destinationRelative}/${relativePath}: conflicting byte appeared; refusing overwrite`);
    }
  }
  for (const destinationFile of listFiles(destination)) {
    const relativePath = relative(destination, destinationFile).replaceAll("\\", "/");
    check(sourceFiles.has(relativePath), `${destinationRelative}/${relativePath}: undeclared file exists; refusing adoption`);
  }
  check(treeDigest(destination) === treeDigest(source), `${destinationRelative}: additive copy differs from exact candidate`);
}

function mergeRootRecipe(item) {
  const sourceRelative = candidateRecipeRelative(item);
  const destinationRelative = item.recipePath;
  const source = join(repoRoot, sourceRelative);
  const destination = join(repoRoot, destinationRelative);
  const receiptRelative = "publication/installer-package-receipt.yaml";
  check(existsSync(source), `${sourceRelative} is missing`);
  mkdirSync(destination, { recursive: true });
  const sourceFiles = new Map(listFiles(source).map((file) => [relative(source, file).replaceAll("\\", "/"), file]));
  for (const [relativePath, sourceFile] of sourceFiles) {
    if (relativePath === receiptRelative) continue;
    const destinationFile = join(destination, relativePath);
    mkdirSync(dirname(destinationFile), { recursive: true });
    if (existsSync(destinationFile)) {
      check(sha256File(destinationFile) === sha256File(sourceFile), `${destinationRelative}/${relativePath}: conflicting byte exists; refusing overwrite`);
      continue;
    }
    copyFileSync(sourceFile, destinationFile, constants.COPYFILE_EXCL);
  }
  const receiptPath = join(destination, receiptRelative);
  const candidateReceipt = readFileSync(join(source, receiptRelative), "utf8");
  const expectedReceipt = rootReadyReceiptText(item);
  if (existsSync(receiptPath)) {
    const existingReceipt = readFileSync(receiptPath, "utf8");
    check(
      existingReceipt === candidateReceipt || existingReceipt === expectedReceipt,
      `${destinationRelative}/${receiptRelative}: conflicting receipt exists; refusing overwrite`,
    );
  }
  writeText(receiptPath, expectedReceipt);
}

function rootReadyReceiptText(item) {
  const receipt = readYaml(join(repoRoot, candidateRecipeRelative(item), "publication", "installer-package-receipt.yaml"));
  const candidatePackage = candidatePackageRelative(item);
  check(receipt.spec?.package?.path === candidatePackage, `${selectionKey(item)}: candidate publication receipt package path changed`);
  receipt.spec.package.path = item.packagePath;
  receipt.spec.deterministicBundle.command = String(receipt.spec.deterministicBundle.command).replaceAll(candidatePackage, item.packagePath);
  for (const setup of receipt.spec.setupChecks ?? []) {
    setup.command = String(setup.command).replaceAll(candidatePackage, item.packagePath);
  }
  return yamlText(receipt);
}

function rootAdditionState(item) {
  const recipeExists = existsSync(join(repoRoot, item.recipePath));
  const packageExists = existsSync(join(repoRoot, item.packagePath));
  check(recipeExists === packageExists, `${selectionKey(item)}: partial recipe/package addition exists`);
  if (!recipeExists) return "absent";
  verifyRootAddition(item);
  return "present-byte-identical";
}

function verifyPreflightReceipt() {
  check(existsSync(preflightPath), `${relativeRepoPath(preflightPath)} is missing; run --preflight first`);
  verifyCandidates();
  const receipt = readYaml(preflightPath);
  check(receipt.kind === "KubaraCatalogFullCoveragePreflightReceipt", "Kubara full-coverage preflight kind changed");
  check(receipt.spec?.baseline?.versionCount === 120, "preflight baseline version count changed");
  check(receipt.spec?.baseline?.recipesTreeSHA256 === KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256, "preflight recipe baseline digest changed");
  check(receipt.spec?.baseline?.packagesTreeSHA256 === KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256, "preflight package baseline digest changed");
  check(receipt.spec?.sources?.length === 18 && receipt.spec.sources.every((item) => item.result === "pass"), "preflight must verify all 18 source artifacts");
  check(receipt.spec?.packages?.length === 10, "preflight must verify ten packages");
  for (const row of receipt.spec.packages) {
    const item = KUBARA_CATALOG_1_1_ADDITIONS.find((candidate) => selectionKey(candidate) === `${row.canonicalIdentity}@${row.version}`);
    check(item, `preflight contains unknown package ${row.canonicalIdentity}@${row.version}`);
    check(row.ref === installerOciRefForPackagePath(item.packagePath), `${selectionKey(item)}: preflight OCI ref changed`);
    check(/^[0-9a-f]{64}$/.test(row.deterministicPackageSHA256 ?? ""), `${selectionKey(item)}: preflight package SHA is invalid`);
    check(["absent", "present-byte-identical"].includes(row.retainedRootState), `${selectionKey(item)}: preflight root state is unsafe`);
    check(["absent", "present-byte-identical"].includes(row.remoteState), `${selectionKey(item)}: preflight remote state is unsafe`);
  }
  check(receipt.status?.result === "pass", "preflight did not pass");
}

function preflightReceipt(sources, packages) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogFullCoveragePreflightReceipt",
    metadata: { name: "kubara-catalogs-1-1-0-full-component-coverage" },
    spec: {
      sourceSnapshot: snapshotRelative,
      baseline: {
        componentCount: 100,
        versionCount: 120,
        recipesTreeSHA256: KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256,
        packagesTreeSHA256: KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256,
      },
      retentionMode: "additive-only-no-overwrite",
      publicationMode: "serial-idempotent-exact-layer-only",
      sources,
      packages,
      supplements: KUBARA_CATALOG_1_1_SUPPLEMENTS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        exactArtifact: exactArtifact(item),
        existingRootMutation: "none",
      })),
    },
    status: {
      result: "pass",
      oldRootsByteIdentical: true,
      sourceArtifactCount: 18,
      additivePackageCount: 10,
      remoteConflicts: 0,
      ociWritesPerformed: 0,
    },
  };
}

function verifyPublication(item) {
  const receiptPath = publicationReceiptPath(item);
  check(existsSync(receiptPath), `${relativeRepoPath(receiptPath)} is missing`);
  const receipt = readYaml(receiptPath);
  const ref = installerOciRefForPackagePath(item.packagePath);
  check(receipt.kind === "InstallerPackagePublicationReceipt", `${selectionKey(item)}: publication receipt kind changed`);
  check(receipt.spec?.package?.path === item.packagePath, `${selectionKey(item)}: publication package path changed`);
  check(receipt.spec?.ref === ref, `${selectionKey(item)}: publication ref changed`);
  check(receipt.spec?.package?.sourceTreeSHA256 === treeDigest(join(repoRoot, item.packagePath)), `${selectionKey(item)}: published source tree changed`);
  check(["pushed-new", "reused-existing-exact-artifact"].includes(receipt.spec?.publicationAction), `${selectionKey(item)}: publication action is invalid`);
  check(receipt.spec?.outputs?.layerDigest === `sha256:${receipt.spec?.package?.sha256}`, `${selectionKey(item)}: publication layer differs from package SHA`);
  const deterministicSHA = deterministicPackageSHA256(item.packagePath);
  check(deterministicSHA === receipt.spec?.package?.sha256, `${selectionKey(item)}: deterministic package differs from publication receipt`);
  const remoteOutput = execFileSync("cub", ["installer", "inspect", ref, "--json"], {
    cwd: repoRoot,
    env: cubEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 200,
  });
  const remote = inspectMetadata(remoteOutput, ref);
  check(remote.manifestDigest === receipt.spec?.outputs?.manifestDigest, `${selectionKey(item)}: remote manifest differs from receipt`);
  check(remote.layerDigest === receipt.spec?.outputs?.layerDigest, `${selectionKey(item)}: remote layer differs from receipt`);
  return { receipt, remote };
}

function verifyInstallerCatalogRows() {
  const catalogPath = join(repoRoot, "data", "installer-oci-packages", "packages.json");
  check(existsSync(catalogPath), "installer OCI package catalog is missing");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const rows = catalog.packages ?? [];
  check(rows.length === 130, `installer OCI package catalog must contain 130 versions, found ${rows.length}`);
  check(new Set(rows.map((row) => row.chart)).size === 103, "installer OCI package catalog must contain 103 components");
  const byKey = new Map(rows.map((row) => [`${row.chart}@${row.version}`, row]));
  for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
    const row = byKey.get(selectionKey(item));
    check(row, `${selectionKey(item)}: installer OCI catalog row is missing`);
    check(row.publication_status === "published-receipt", `${selectionKey(item)}: installer OCI catalog row is not published`);
    check(row.installer_oci_ref === installerOciRefForPackagePath(item.packagePath), `${selectionKey(item)}: installer OCI catalog ref changed`);
  }
}

function writeCoreOutputs(inventory) {
  mkdirSync(dataRoot, { recursive: true });
  const outputs = coreOutputs(inventory);
  for (const [outputPath, content] of outputs) writeText(outputPath, content);
}

function verifyCoreOutputs(inventory) {
  const outputs = coreOutputs(inventory);
  for (const [outputPath, expected] of outputs) {
    check(existsSync(outputPath), `${relativeRepoPath(outputPath)} is missing`);
    check(readFileSync(outputPath, "utf8") === expected, `${relativeRepoPath(outputPath)} is stale`);
  }
}

function coreOutputs(inventory) {
  const selectionOccurrences = new Map();
  for (const occurrence of inventory.occurrences) {
    const key = `${occurrence.canonicalIdentity}@${occurrence.version}`;
    if (!selectionOccurrences.has(key)) selectionOccurrences.set(key, []);
    selectionOccurrences.get(key).push(occurrence.wrapper);
  }
  const exactRegistry = {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraExactArtifactRegistry",
    metadata: { name: "kubara-catalogs-1-1-0-remote-dependencies" },
    spec: {
      sourceSnapshot: snapshotRelative,
      selectionCount: 18,
      exactVersionPolicy: "fail-if-missing",
      artifacts: KUBARA_CATALOG_1_1_ARTIFACTS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        catalogState: item.catalogState,
        exactArtifact: exactArtifact(item),
        recipePath: item.recipePath,
        packagePath: item.packagePath,
      })),
    },
  };
  const inventoryDocument = {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraWrapperDependencyInventory",
    metadata: { name: "kubara-catalogs-1-1-0-bootstrap-general" },
    spec: {
      sourceSnapshot: snapshotRelative,
      wrapperChartCount: inventory.wrapperFiles.length,
      remoteDependencyOccurrenceCount: 21,
      uniqueSelectionCount: 18,
      occurrences: inventory.occurrences,
    },
  };
  const publicationPlan = {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogPublicationPlan",
    metadata: { name: "kubara-catalogs-1-1-0-full-coverage" },
    spec: {
      mode: "serial-idempotent-exact-layer-only",
      packageCount: 10,
      packages: KUBARA_CATALOG_1_1_ADDITIONS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        packagePath: item.packagePath,
        ref: installerOciRefForPackagePath(item.packagePath),
      })),
      supplements: KUBARA_CATALOG_1_1_SUPPLEMENTS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        action: "separate-lock-registry-only",
        existingRootMutation: "none",
      })),
    },
  };
  const publications = KUBARA_CATALOG_1_1_ADDITIONS.map(publicationSummary);
  const published = publications.filter((item) => item.status === "published");
  const receipt = {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogFullCoverageReceipt",
    metadata: { name: "kubara-catalogs-1-1-0-full-component-coverage" },
    spec: {
      sourceSnapshot: snapshotRelative,
      sourceInventory: relativeRepoPath(inventoryPath),
      exactArtifactRegistry: relativeRepoPath(exactRegistryPath),
      preflightReceipt: relativeRepoPath(preflightPath),
      retentionMode: "additive-only-no-overwrite",
      baseline: {
        componentCount: 100,
        versionCount: 120,
        recipesTreeSHA256: KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256,
        packagesTreeSHA256: KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256,
      },
      finalCatalog: {
        componentCount: 103,
        versionCount: 130,
        addedComponentCount: 3,
        addedVersionCount: 10,
      },
      selections: KUBARA_CATALOG_1_1_ARTIFACTS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        wrapperOccurrences: selectionOccurrences.get(selectionKey(item))?.length ?? 0,
        catalogState: item.catalogState,
        exactArtifact: exactArtifact(item),
      })),
      additions: KUBARA_CATALOG_1_1_ADDITIONS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        recipePath: item.recipePath,
        recipeTreeSHA256: existsSync(join(repoRoot, item.recipePath)) ? treeDigest(join(repoRoot, item.recipePath)) : null,
        packagePath: item.packagePath,
        packageTreeSHA256: existsSync(join(repoRoot, item.packagePath)) ? treeDigest(join(repoRoot, item.packagePath)) : null,
        publication: publications.find((row) => row.canonicalIdentity === item.canonicalIdentity && row.version === item.version),
      })),
      supplements: KUBARA_CATALOG_1_1_SUPPLEMENTS.map((item) => ({
        canonicalIdentity: item.canonicalIdentity,
        version: item.version,
        exactArtifact: exactArtifact(item),
        existingRootMutation: "none",
      })),
    },
    status: {
      result: published.length === 10 && catalogRootStateComplete() ? "pass" : "pending",
      oldRootsByteIdentical: baselineRootStateValid(),
      wrapperDependencyOccurrences: 21,
      exactSelectionCount: 18,
      publishedPackageCount: published.length,
      finalComponentCount: catalogRootStateComplete() ? 103 : null,
      finalVersionCount: catalogRootStateComplete() ? 130 : null,
    },
  };
  return new Map([
    [exactRegistryPath, yamlText(exactRegistry)],
    [inventoryPath, yamlText(inventoryDocument)],
    [publicationPlanPath, yamlText(publicationPlan)],
    [matrixPath, coverageCsv(selectionOccurrences, publications)],
    [completionReceiptPath, yamlText(receipt)],
    [readmePath, coverageReadme(publications)],
  ]);
}

function publicationSummary(item) {
  const path = publicationReceiptPath(item);
  if (!existsSync(path)) {
    return {
      canonicalIdentity: item.canonicalIdentity,
      version: item.version,
      ref: installerOciRefForPackagePath(item.packagePath),
      status: "pending",
    };
  }
  const receipt = readYaml(path);
  return {
    canonicalIdentity: item.canonicalIdentity,
    version: item.version,
    ref: installerOciRefForPackagePath(item.packagePath),
    status: "published",
    action: receipt.spec?.publicationAction,
    manifestDigest: receipt.spec?.outputs?.manifestDigest,
    layerDigest: receipt.spec?.outputs?.layerDigest,
    receipt: relativeRepoPath(path),
  };
}

function coverageCsv(selectionOccurrences, publications) {
  const publicationMap = new Map(publications.map((item) => [`${item.canonicalIdentity}@${item.version}`, item]));
  const header = ["canonical_identity", "version", "wrapper_occurrences", "catalog_state", "exact_url", "archive_or_layer_sha256", "upstream_manifest_digest", "installer_oci_ref", "installer_manifest_digest", "installer_layer_digest"];
  const rows = KUBARA_CATALOG_1_1_ARTIFACTS.map((item) => {
    const publication = publicationMap.get(selectionKey(item));
    return [
      item.canonicalIdentity,
      item.version,
      String(selectionOccurrences.get(selectionKey(item))?.length ?? 0),
      item.catalogState,
      item.url,
      item.sha256,
      item.manifestDigest ?? "",
      item.catalogState === "additive-root" ? installerOciRefForPackagePath(item.packagePath) : "",
      publication?.manifestDigest ?? "",
      publication?.layerDigest ?? "",
    ].map(csvCell).join(",");
  });
  return `${header.join(",")}\n${rows.join("\n")}\n`;
}

function coverageReadme(publications) {
  const published = publications.filter((item) => item.status === "published").length;
  return `# Kubara catalogs 1.1.0 full component coverage

This receipt set inventories all 21 remote dependency occurrences and all 18
unique exact component/version selections in the pinned bootstrap and general
wrapper charts. ConfigHub retains ten missing version roots additively, taking
the component Catalog from 100 components / 120 versions to 103 components /
130 versions.

The existing external-dns 1.21.1 and Traefik 41.0.2 recipe/package roots remain
byte-identical. Their version-specific URL and upstream OCI manifest evidence is
recorded separately in \`exact-artifact-registry.yaml\`.

Published exact installer packages: ${published}/10.

The packages prove exact source bytes, deterministic render/package output, and
OCI retention. They do not by themselves claim Kubara wrapper equivalence,
target-specific live convergence, or production support.
`;
}

function selfTest() {
  verifyStaticContract();
  const tempRoot = mkdtempSync(join(tmpdir(), "kubara-catalog-1-1-self-test-"));
  try {
    const source = join(tempRoot, "source");
    const destination = join(tempRoot, "destination");
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, "same.txt"), "expected\n");
    writeFileSync(join(destination, "same.txt"), "conflict\n");
    let rejected = false;
    try {
      mergeAdditiveTree(relativeRepoPath(source), relativeRepoPath(destination));
    } catch (error) {
      rejected = /refusing overwrite/.test(String(error.message));
    }
    check(rejected, "additive merge self-test did not reject conflicting bytes");
    const manifestDigest = `sha256:${"1".repeat(64)}`;
    const layerDigest = `sha256:${"2".repeat(64)}`;
    const inspected = inspectMetadata(JSON.stringify({ ManifestDigest: manifestDigest, Config: { bundle: { layerDigest } } }), "oci://self-test/example:1");
    check(inspected.manifestDigest === manifestDigest && inspected.layerDigest === layerDigest, "remote digest parser self-test failed");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("Kubara full-coverage self-test passed: exact scope, collision refusal, and remote digest parsing");
}

function exactArtifact(item) {
  return {
    url: item.url,
    sha256: item.sha256,
    ...(item.manifestDigest ? { manifestDigest: item.manifestDigest } : {}),
  };
}

function selectionKey(item) {
  return `${item.canonicalIdentity}@${item.version}`;
}

function candidateRecipeRelative(item) {
  return `${candidateRootRelative}/recipes/${item.canonicalIdentity}/${item.version}`;
}

function candidatePackageRelative(item) {
  return `${candidateRootRelative}/packages/${item.canonicalIdentity}/${item.version}`;
}

function publicationReceiptPath(item) {
  const ref = installerOciRefForPackagePath(item.packagePath).replace(/^oci:\/\//, "");
  const [slug, tag = "latest"] = (ref.split("/").at(-1) ?? "").split(":");
  return join(repoRoot, "runs", "installer-oci", slug, tag, "installer-package-publication-receipt.yaml");
}

function catalogVersionRoots(rootName) {
  const root = join(repoRoot, rootName);
  const result = [];
  for (const repository of directoryNames(root)) {
    for (const chart of directoryNames(join(root, repository))) {
      for (const version of directoryNames(join(root, repository, chart))) {
        result.push(`${rootName}/${repository}/${chart}/${version}`);
      }
    }
  }
  return result.sort();
}

function directoryNames(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
}

function componentCount(roots) {
  return new Set(roots.map((item) => item.split("/").slice(1, 3).join("/"))).size;
}

function treeDigest(root) {
  check(existsSync(root), `${relativeRepoPath(root)} is missing`);
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(sha256File(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function treeSetDigest(roots) {
  const hash = createHash("sha256");
  for (const root of [...roots].sort()) {
    hash.update(`${root}\0`);
    for (const file of listFiles(join(repoRoot, root))) {
      hash.update(`${relativeRepoPath(file)}\0`);
      hash.update(`${sha256File(file)}\n`);
    }
  }
  return hash.digest("hex");
}

function baselineRootStateValid() {
  try {
    verifyBaselineRoots();
    return true;
  } catch {
    return false;
  }
}

function catalogRootStateComplete() {
  try {
    verifyAllRoots();
    return true;
  } catch {
    return false;
  }
}

function relativeRepoPath(absoluteOrRelative) {
  const absolute = absoluteOrRelative.startsWith("/")
    ? absoluteOrRelative
    : join(repoRoot, absoluteOrRelative);
  return relative(repoRoot, absolute).replaceAll("\\", "/");
}

function yamlText(value) {
  return `${toYaml(value)}\n`;
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stableJson(value) {
  return JSON.stringify(value);
}
