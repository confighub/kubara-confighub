#!/usr/bin/env node

// Publish only the ten additive Kubara package versions. This wrapper exists
// so the release runbook never relies on the unscoped all-catalog publisher.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { check, cubEnv, listFiles, readYaml, repoRoot, sha256File } from "./lib/proof-common.mjs";
import { installerOciRefForPackagePath } from "./lib/installer-oci.mjs";
import {
  KUBARA_CATALOG_ADDITIONS,
  KUBARA_CATALOG_BASELINE,
  KUBARA_OCI_PACKAGES,
  KUBARA_PROMOTION_RECEIPTS,
} from "./lib/kubara-catalog-release.mjs";
import {
  KUBARA_CATALOG_1_1_ADDITIONS,
  KUBARA_CATALOG_1_1_BASELINE,
  KUBARA_CATALOG_1_1_FINAL,
} from "./lib/kubara-catalog-1-1-full-coverage.mjs";

const mode = process.argv[2] ?? "--dry-run";
if (!["--dry-run", "--publish", "--verify"].includes(mode)) {
  console.error(`Usage:
  node scripts/publish-kubara-catalog-additions.mjs --dry-run
  node scripts/publish-kubara-catalog-additions.mjs --publish
  node scripts/publish-kubara-catalog-additions.mjs --verify`);
  process.exit(2);
}

const packages = [...KUBARA_OCI_PACKAGES];
const promotionReceipts = [...KUBARA_PROMOTION_RECEIPTS];

verifyStaticScope();

if (mode === "--dry-run") {
  for (const packagePath of packages) {
    const destination = join(repoRoot, packagePath);
    console.log(`${existsSync(join(destination, "installer.yaml")) ? "ready" : "awaiting-promotion"} ${packagePath} -> ${installerOciRefForPackagePath(packagePath)}`);
  }
  const gates = promotionReceipts.map((path) => `${existsSync(join(repoRoot, path)) ? "present" : "missing"} ${path}`);
  console.log(gates.join("\n"));
  console.log("dry-run complete; no package, registry, receipt, or catalog state changed");
} else if (mode === "--publish") {
  verifyPromotionGates();
  for (const packagePath of packages) {
    const receipt = publicationReceiptPath(packagePath);
    if (existsSync(receipt)) {
      verifyPublication(packagePath);
      console.log(`already published and receipt-verified ${packagePath}`);
      continue;
    }
    execFileSync(process.execPath, [
      "scripts/publish-installer-oci-packages.mjs",
      "--package",
      packagePath,
      "--idempotent",
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      maxBuffer: 1024 * 1024 * 200,
    });
    verifyPublication(packagePath);
  }
  execFileSync(process.execPath, ["scripts/generate-installer-oci-catalog.mjs", "--generate"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  verifyAll();
  console.log("published and receipt-verified the ten additive Kubara installer packages");
} else {
  verifyAll();
  console.log("verified publication receipts for the ten additive Kubara installer packages");
}

function verifyAll() {
  verifyPromotionGates();
  for (const packagePath of packages) verifyPublication(packagePath);
  verifyReceiptInventory();
  execFileSync(process.execPath, ["scripts/generate-installer-oci-catalog.mjs", "--verify"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const catalog = JSON.parse(readFileSync(join(repoRoot, "data/installer-oci-packages/packages.json"), "utf8"));
  const rows = new Map((catalog.packages ?? []).map((row) => [`packages/${row.chart}/${row.version}`, row]));
  for (const packagePath of packages) {
    const row = rows.get(packagePath);
    check(row, `${packagePath}: installer OCI catalog row is missing`);
    check(row.publication_status === "published-receipt", `${packagePath}: installer OCI catalog is not published-receipt`);
    check(row.installer_oci_ref === installerOciRefForPackagePath(packagePath), `${packagePath}: installer OCI ref changed`);
  }
}

function verifyPromotionGates() {
  for (const args of [["--verify"], ["--verify", "--current"]]) {
    execFileSync(process.execPath, ["scripts/promote-kubara-catalog-candidates.mjs", ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      maxBuffer: 1024 * 1024 * 300,
    });
  }
  for (const path of promotionReceipts) {
    const absolute = join(repoRoot, path);
    check(existsSync(absolute), `${path} is missing; OCI publication requires both additive root promotions`);
    const receipt = readYaml(absolute);
    check(receipt.kind === "KubaraCatalogRootPromotionReceipt", `${path}: promotion receipt kind changed`);
    check(receipt.status?.result === "pass", `${path}: promotion receipt did not pass`);
    check(receipt.status?.immutableBaselinePreserved === true, `${path}: immutable 110-version baseline was not recorded preserved`);
    check(receipt.status?.historicalRootsPreserved === true, `${path}: historical roots were not recorded preserved`);
    check(receipt.status?.candidatesPreserved === true, `${path}: immutable candidates were not recorded preserved`);
  }
}

function verifyPublication(packagePath) {
  const packageRoot = join(repoRoot, packagePath);
  check(existsSync(join(packageRoot, "installer.yaml")), `${packagePath}/installer.yaml is missing`);
  const path = publicationReceiptPath(packagePath);
  check(existsSync(path), `${relativePath(path)} is missing`);
  const receipt = readYaml(path);
  check(receipt.kind === "InstallerPackagePublicationReceipt", `${relativePath(path)}: receipt kind changed`);
  check(receipt.spec?.package?.path === packagePath, `${relativePath(path)}: package path changed`);
  check(receipt.spec?.ref === installerOciRefForPackagePath(packagePath), `${relativePath(path)}: OCI ref changed`);
  check(/^[0-9a-f]{64}$/.test(receipt.spec?.package?.sha256 ?? ""), `${relativePath(path)}: archive SHA is invalid`);
  check(receipt.spec?.package?.sourceTreeSHA256 === treeDigest(packageRoot), `${relativePath(path)}: local package source tree changed after publication`);
  check(["pushed-new", "reused-existing-exact-artifact"].includes(receipt.spec?.publicationAction), `${relativePath(path)}: publication action is invalid`);
  const manifestDigest = receipt.spec?.outputs?.manifestDigest ?? pushDigest(receipt.spec?.outputs?.push, "manifest");
  const layerDigest = receipt.spec?.outputs?.layerDigest ?? pushDigest(receipt.spec?.outputs?.push, "layer");
  check(/^sha256:[0-9a-f]{64}$/.test(manifestDigest), `${relativePath(path)}: manifest digest is invalid`);
  check(layerDigest === `sha256:${receipt.spec.package.sha256}`, `${relativePath(path)}: remote layer and deterministic package SHA differ`);
  check(/^[0-9a-f]{64}$/.test(receipt.spec?.outputs?.inspectJSONSHA256 ?? ""), `${relativePath(path)}: inspect receipt SHA is invalid`);
  check(/^[0-9a-f]{64}$/.test(receipt.spec?.outputs?.inspectJSONCanonicalSHA256 ?? ""), `${relativePath(path)}: canonical inspect receipt SHA is invalid`);
  verifyDeterministicArchive(packagePath, receipt.spec.package.sha256);
  const inspectOutput = execFileSync("cub", ["installer", "inspect", receipt.spec.ref, "--json"], {
    cwd: repoRoot,
    env: cubEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 200,
  });
  const inspected = JSON.parse(inspectOutput);
  check(inspected.ManifestDigest === manifestDigest, `${relativePath(path)}: remote manifest digest changed`);
  check(inspected.Config?.bundle?.layerDigest === layerDigest, `${relativePath(path)}: remote package layer changed`);
  check(canonicalJsonSHA256(inspectOutput) === receipt.spec.outputs.inspectJSONCanonicalSHA256, `${relativePath(path)}: current remote inspect content differs from the publication receipt`);
}

function verifyStaticScope() {
  check(packages.length === 10, `Kubara OCI scope must contain exactly ten packages, found ${packages.length}`);
  check(new Set(packages).size === packages.length, "Kubara OCI package scope contains duplicates");
  check(stableJson(packages) === stableJson(KUBARA_CATALOG_ADDITIONS.map((path) => `packages/${path}`)), "Kubara OCI package scope differs from the additive root contract");
  const refs = packages.map(installerOciRefForPackagePath);
  check(new Set(refs).size === refs.length, "Kubara OCI package scope maps two packages to the same ref");
  for (const rootName of ["recipes", "packages"]) {
    const marker = rootName === "recipes" ? "recipe.yaml" : "installer.yaml";
    const roots = listFiles(join(repoRoot, rootName))
      .filter((path) => basename(path) === marker)
      .map((path) => relativePath(path).replace(new RegExp(`/${marker.replace(".", "\\.")}$`), ""))
      .sort();
    const additions = new Set(KUBARA_CATALOG_ADDITIONS.map((path) => `${rootName}/${path}`));
    const fullCoverageAdditions = new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => `${rootName}/${item.canonicalIdentity}/${item.version}`));
    const baselineRoots = roots.filter((path) => !additions.has(path) && !fullCoverageAdditions.has(path));
    check(baselineRoots.length === KUBARA_CATALOG_BASELINE.versionCount, `${rootName}: immutable baseline root count changed`);
    const expectedDigest = rootName === "recipes" ? KUBARA_CATALOG_BASELINE.recipesTreeSHA256 : KUBARA_CATALOG_BASELINE.packagesTreeSHA256;
    check(treeSetDigest(baselineRoots) === expectedDigest, `${rootName}: an immutable baseline root was removed or changed`);
    const retained120 = roots.filter((path) => !fullCoverageAdditions.has(path));
    const expected120 = rootName === "recipes"
      ? KUBARA_CATALOG_1_1_BASELINE.recipesTreeSHA256
      : KUBARA_CATALOG_1_1_BASELINE.packagesTreeSHA256;
    check(
      retained120.length === KUBARA_CATALOG_1_1_BASELINE.versionCount
        && treeSetDigest(retained120) === expected120,
      `${rootName}: the immutable 120-root intermediate Catalog changed`,
    );
    const declared = new Set([...baselineRoots, ...additions, ...fullCoverageAdditions]);
    check(roots.every((path) => declared.has(path)), `${rootName}: undeclared retained version root exists`);
    check(roots.length <= KUBARA_CATALOG_1_1_FINAL.versionCount, `${rootName}: release scope exceeds ${KUBARA_CATALOG_1_1_FINAL.versionCount} retained versions`);
  }
}

function verifyReceiptInventory() {
  const rootPackages = listFiles(join(repoRoot, "packages"))
    .filter((path) => basename(path) === "installer.yaml")
    .map((path) => relativePath(path).replace(/\/installer\.yaml$/, ""))
    .sort();
  const fullCoveragePackageRoots = new Set(KUBARA_CATALOG_1_1_ADDITIONS.map((item) => item.packagePath));
  const retained120 = rootPackages.filter((path) => !fullCoveragePackageRoots.has(path));
  check(retained120.length === KUBARA_CATALOG_1_1_BASELINE.versionCount, `expected the immutable 120-package intermediate Catalog, found ${retained120.length}`);
  check(rootPackages.length <= KUBARA_CATALOG_1_1_FINAL.versionCount, `retained package inventory exceeds ${KUBARA_CATALOG_1_1_FINAL.versionCount} declared versions`);
  const receiptPaths = listFiles(join(repoRoot, "runs", "installer-oci"))
    .filter((path) => path.endsWith("installer-package-publication-receipt.yaml"));
  const receipts = receiptPaths.map((path) => readYaml(path));
  const receiptPackages = receipts.map((receipt) => receipt.spec?.package?.path).sort();
  const receiptRefs = receipts.map((receipt) => receipt.spec?.ref);
  check(new Set(receiptPackages).size === receiptPackages.length, "publication receipts contain duplicate package paths");
  check(new Set(receiptRefs).size === receiptRefs.length, "publication receipts contain duplicate OCI refs");
  check(receiptPackages.every((path) => rootPackages.includes(path)), "publication receipt exists for an undeclared retained package root");
  check(retained120.every((path) => receiptPackages.includes(path)), "the immutable 120-package Catalog is missing a publication receipt");
}

function verifyDeterministicArchive(packagePath, expectedSHA256) {
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-oci-verify-"));
  try {
    const archivePath = join(tempRoot, `${basename(packagePath)}.tgz`);
    execFileSync("cub", ["installer", "package", join(repoRoot, packagePath), "-o", archivePath], {
      cwd: repoRoot,
      env: cubEnv(),
      stdio: ["ignore", "ignore", "inherit"],
      maxBuffer: 1024 * 1024 * 200,
    });
    check(sha256File(archivePath) === expectedSHA256, `${packagePath}: deterministic package bytes differ from the published layer`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function treeDigest(root) {
  const hash = createHash("sha256");
  for (const path of listFiles(root)) {
    hash.update(`${relative(root, path).replaceAll("\\", "/")}\0`);
    hash.update(`${sha256File(path)}\n`);
  }
  return hash.digest("hex");
}

function treeSetDigest(roots) {
  const hash = createHash("sha256");
  for (const root of [...roots].sort()) {
    hash.update(`${root}\0`);
    for (const path of listFiles(join(repoRoot, root))) {
      hash.update(`${relativePath(path)}\0`);
      hash.update(`${sha256File(path)}\n`);
    }
  }
  return hash.digest("hex");
}

function pushDigest(output, label) {
  return String(output ?? "").match(new RegExp(`${label}:\\s+(sha256:[0-9a-f]{64})`))?.[1] ?? "";
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonSHA256(value) {
  return sha256Text(JSON.stringify(sortDeep(JSON.parse(value))));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortDeep(nested)]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function publicationReceiptPath(packagePath) {
  const ref = installerOciRefForPackagePath(packagePath).replace(/^oci:\/\//, "");
  const [slug, tag = "latest"] = (ref.split("/").at(-1) ?? "").split(":");
  return join(repoRoot, "runs", "installer-oci", slug, tag, "installer-package-publication-receipt.yaml");
}

function relativePath(path) {
  return path.slice(repoRoot.length + 1).replaceAll("\\", "/");
}
