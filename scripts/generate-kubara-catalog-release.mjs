#!/usr/bin/env node

// Regenerate the catalog surfaces after both additive Kubara waves. Publication
// verification is first, so no derived file is changed unless the immutable
// 120-root intermediate Catalog, the ten full-coverage additions, and all exact
// remote OCI artifacts verify.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { check, repoRoot } from "./lib/proof-common.mjs";
import {
  KUBARA_CATALOG_ADDITIONS,
} from "./lib/kubara-catalog-release.mjs";
import {
  KUBARA_CATALOG_1_1_ADDITIONS,
  KUBARA_CATALOG_1_1_FINAL,
} from "./lib/kubara-catalog-1-1-full-coverage.mjs";

const mode = process.argv[2] ?? "--verify";
if (!["--generate", "--verify"].includes(mode)) {
  console.error(`Usage:
  node scripts/generate-kubara-catalog-release.mjs --generate
  node scripts/generate-kubara-catalog-release.mjs --verify`);
  process.exit(2);
}

verifyFinalRootScope();
run("scripts/publish-kubara-catalog-additions.mjs", "--verify");
run("scripts/complete-kubara-catalog-1-1-coverage.mjs", "--verify");

const derived = [
  "scripts/generate-catalog-status.mjs",
  "scripts/generate-helm-pain-reports.mjs",
  "scripts/generate-weirdness-notes.mjs",
  "scripts/generate-inheritance-graphs.mjs",
  "scripts/generate-chart-catalogs.mjs",
  "scripts/generate-root-catalog.mjs",
  "scripts/run-catalog-promotion-review.mjs",
  "scripts/generate-installer-oci-catalog.mjs",
  "scripts/generate-model-completeness.mjs",
  "scripts/generate-data-index.mjs",
  "scripts/generate-npm-script-catalog.mjs",
  "scripts/generate-public-site.mjs",
];

for (const script of derived) run(script, mode);
if (mode === "--verify") run("scripts/verify-site-ux-contract.mjs");

console.log(`${mode === "--generate" ? "generated" : "verified"} the ${KUBARA_CATALOG_1_1_FINAL.componentCount}-component/${KUBARA_CATALOG_1_1_FINAL.versionCount}-version additive Kubara catalog and public release surfaces`);

function verifyFinalRootScope() {
  for (const rootName of ["recipes", "packages"]) {
    const roots = versionRoots(rootName);
    const expectedCount = KUBARA_CATALOG_1_1_FINAL.versionCount;
    check(roots.length === expectedCount, `${rootName}: Kubara catalog release requires exactly ${expectedCount} retained version roots, found ${roots.length}`);
    for (const path of KUBARA_CATALOG_ADDITIONS) {
      check(roots.includes(`${rootName}/${path}`), `${rootName}/${path} is missing from the final additive release scope`);
    }
    for (const item of KUBARA_CATALOG_1_1_ADDITIONS) {
      const path = `${item.canonicalIdentity}/${item.version}`;
      check(roots.includes(`${rootName}/${path}`), `${rootName}/${path} is missing from the full Kubara catalogs 1.1.0 release scope`);
    }
  }
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

function run(script, ...args) {
  check(existsSync(join(repoRoot, script)), `${script} is missing`);
  console.log(`kubara catalog release: node ${script} ${args.join(" ")}`.trimEnd());
  execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}
