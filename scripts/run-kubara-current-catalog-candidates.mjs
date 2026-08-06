#!/usr/bin/env node

// Build the ConfigHub candidate view for Kubara v0.13.0 / catalogs 1.1.0.
// Versions already captured by the v0.12 candidate set are referenced in
// place. Only changed versions are generated into current-candidates, so the
// upgrade is additive and no historical candidate tree is copied or replaced.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  check,
  parseObjects,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256File,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const currentRootRelative = "data/kubara-catalog-refresh/current-candidates";
const historicalRootRelative = "data/kubara-catalog-refresh/candidates";
const currentRoot = join(repoRoot, currentRootRelative);
const artifactSetPath = join(
  repoRoot,
  "examples",
  "kubara",
  "current-platform",
  "component-artifacts.yaml",
);
const sourceLockPath = join(
  repoRoot,
  "examples",
  "kubara",
  "current-platform",
  "source-lock.yaml",
);
const manifestPath = join(currentRoot, "candidate-set.yaml");
const statusPath = join(currentRoot, "candidate-status.csv");
const readmePath = join(currentRoot, "README.md");

const definitions = new Map([
  ["helm:argo-cd/argo-cd", definition("argo-cd", "argo-cd", "scripts/argo-cd-proof.mjs", ["default", "no-crds"], { changed: true })],
  ["helm:jetstack/cert-manager", definition("jetstack", "cert-manager", "scripts/cert-manager-proof.mjs", ["default", "crds-enabled"])],
  ["helm:external-secrets/external-secrets", definition("external-secrets", "external-secrets", "scripts/external-secrets-proof.mjs", ["default", "no-crds"], { changed: true })],
  ["helm:prometheus-community/kube-prometheus-stack", definition("prometheus-community", "kube-prometheus-stack", "scripts/kube-prometheus-stack-proof.mjs", ["default", "no-crds", "existing-secret"], { changed: true, lifecycle: true })],
  ["helm:prometheus-community/prometheus-blackbox-exporter", definition("prometheus-community", "prometheus-blackbox-exporter", "scripts/kubara-generic-chart-proof.mjs", ["default"], { genericCandidate: "prometheus-blackbox-exporter" })],
  ["helm:metrics-server/metrics-server", definition("metrics-server", "metrics-server", "scripts/metrics-server-proof.mjs", ["default", "external-tls-ca"])],
  ["helm:traefik/traefik", definition("traefik", "traefik", "scripts/kubara-generic-chart-proof.mjs", ["default"], { genericCandidate: "traefik" })],
]);

if (mode === "--generate") generate();
else if (mode === "--verify") verify();
else {
  console.log(`Usage:
  node scripts/run-kubara-current-catalog-candidates.mjs --generate
  node scripts/run-kubara-current-catalog-candidates.mjs --verify`);
}

function definition(repository, chart, script, variants, extra = {}) {
  return { repository, chart, script, variants, ...extra };
}

function candidates() {
  const artifactSet = readYaml(artifactSetPath);
  const sourceLock = readYaml(sourceLockPath);
  check(artifactSet.kind === "KubaraComponentArtifactSet", "current Kubara artifact set kind changed");
  check(sourceLock.kind === "KubaraCurrentExampleSourceLock", "current Kubara source lock kind changed");
  check(sourceLock.spec?.kubara?.version === "v0.13.0", "current candidate set must remain pinned to Kubara v0.13.0");
  check(sourceLock.spec?.catalogs?.version === "1.1.0", "current candidate set must remain pinned to catalogs 1.1.0");
  const rows = (artifactSet.spec?.artifacts ?? []).map((artifact) => {
    const declared = definitions.get(artifact.canonicalIdentity);
    check(declared, `${artifact.canonicalIdentity}: no reviewed proof declaration`);
    const version = String(artifact.version);
    const digest = String(artifact.sha256 ?? "").replace(/^sha256:/, "");
    check(/^[0-9a-f]{64}$/.test(digest), `${artifact.canonicalIdentity}: invalid exact artifact SHA`);
    const laneRoot = declared.changed ? currentRootRelative : historicalRootRelative;
    const relative = `${declared.repository}/${declared.chart}/${version}`;
    return {
      ...declared,
      service: artifact.service,
      canonicalIdentity: artifact.canonicalIdentity,
      version,
      artifactURL: artifact.url,
      artifactSHA256: digest,
      storageLane: declared.changed ? "current-addition" : "reused-identical-v0.12-candidate",
      laneRoot,
      recipe: `${laneRoot}/recipes/${relative}`,
      package: `${laneRoot}/packages/${relative}`,
    };
  });
  check(rows.length === definitions.size, `expected ${definitions.size} exact public artifacts, found ${rows.length}`);
  check(new Set(rows.map((row) => row.canonicalIdentity)).size === rows.length, "current artifact identities are not unique");
  check(rows.filter((row) => row.changed).length === 3, "expected exactly three catalogs 1.1.0 version additions");
  return rows;
}

function generate() {
  mkdirSync(currentRoot, { recursive: true });
  for (const item of candidates().filter((candidate) => candidate.changed)) {
    console.log(`generating current additive candidate ${item.canonicalIdentity}@${item.version}`);
    runProof(item, "--generate-proof");
    if (item.lifecycle) runLifecycle(item, "--generate");
    runProof(item, "--generate-package");
  }
  writeOutputs(inspect());
  verify();
  console.log("generated three additive versions and mapped all seven current public artifacts");
}

function verify() {
  const rows = inspect();
  check(existsSync(manifestPath), `${relativeRepo(manifestPath)} is missing`);
  check(existsSync(statusPath), `${relativeRepo(statusPath)} is missing`);
  check(existsSync(readmePath), `${relativeRepo(readmePath)} is missing`);
  check(stableJson(readYaml(manifestPath)) === stableJson(manifest(rows)), "current candidate-set manifest is stale");
  check(readFileSync(statusPath, "utf8") === statusCsv(rows), "current candidate CSV is stale");
  check(readFileSync(readmePath, "utf8") === readme(rows), "current candidate README is stale");
  console.log("verified all seven exact Kubara v0.13.0 public artifacts; three are additive current candidates");
}

function inspect() {
  return candidates().map((item) => {
    check(existsSync(join(repoRoot, item.recipe)), `${item.canonicalIdentity}: recipe is missing at ${item.recipe}`);
    check(existsSync(join(repoRoot, item.package)), `${item.canonicalIdentity}: package is missing at ${item.package}`);
    runProof(item, "--verify-proof");
    if (item.lifecycle) runLifecycle(item, "--verify");
    runProof(item, "--verify-package");
    const sourceLock = readYaml(join(repoRoot, item.recipe, "source-lock.yaml"));
    check(sourceLock.spec?.version === item.version, `${item.canonicalIdentity}: source-lock version mismatch`);
    check(sourceLock.spec?.exactArtifact?.url === item.artifactURL, `${item.canonicalIdentity}: exact artifact URL mismatch`);
    check(sourceLock.spec?.exactArtifact?.sha256 === item.artifactSHA256, `${item.canonicalIdentity}: exact artifact SHA mismatch`);
    const objectCounts = Object.fromEntries(item.variants.map((variant) => {
      const path = join(repoRoot, item.recipe, "revisions", variant, "r001", "rendered", "release-objects.yaml");
      check(existsSync(path), `${item.canonicalIdentity}: ${variant} render is missing`);
      return [variant, parseObjects(readFileSync(path, "utf8")).length];
    }));
    return {
      canonicalIdentity: item.canonicalIdentity,
      service: item.service,
      version: item.version,
      exactArtifact: { url: item.artifactURL, sha256: item.artifactSHA256 },
      storageLane: item.storageLane,
      recipe: item.recipe,
      package: item.package,
      variants: item.variants,
      objectCounts,
      sourceLockSHA256: sha256File(join(repoRoot, item.recipe, "source-lock.yaml")),
    };
  });
}

function runProof(item, command) {
  const env = {
    ...process.env,
    HELM_EXPT_CHART_VERSION: item.version,
    HELM_EXPT_PROOF_OUTPUT_ROOT: item.laneRoot,
    HELM_EXPT_PROOF_SCRIPT_PREFIX: item.changed
      ? "kubara-current-catalog-candidates"
      : "kubara-catalog-candidates",
    HELM_EXPT_PROOF_OFFLINE_CANDIDATE: "1",
    HELM_EXPT_CHART_ARTIFACT_URL: item.artifactURL,
    HELM_EXPT_CHART_ARTIFACT_SHA256: item.artifactSHA256,
  };
  if (item.lifecycle) {
    env.HELM_EXPT_KPS_PACKAGE_EXTRAS_ROOT = `${item.laneRoot}/config-catalog/package-extras/prometheus-community/kube-prometheus-stack`;
  }
  if (item.genericCandidate) env.HELM_EXPT_KUBARA_CANDIDATE = item.genericCandidate;
  execFileSync(process.execPath, [item.script, command], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 300,
  });
}

function runLifecycle(item, command) {
  execFileSync(
    process.execPath,
    ["scripts/generate-kps-packaged-lifecycle.mjs", command, "--version", item.version],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HELM_EXPT_PROOF_OUTPUT_ROOT: item.laneRoot,
        HELM_EXPT_PROOF_OFFLINE_CANDIDATE: "1",
        HELM_EXPT_CHART_ARTIFACT_URL: item.artifactURL,
        HELM_EXPT_CHART_ARTIFACT_SHA256: item.artifactSHA256,
      },
      stdio: "inherit",
      maxBuffer: 1024 * 1024 * 300,
    },
  );
}

function writeOutputs(rows) {
  writeYaml(manifestPath, manifest(rows));
  writeFileSync(statusPath, statusCsv(rows));
  writeFileSync(readmePath, readme(rows));
}

function manifest(rows) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogCandidateSet",
    metadata: { name: "kubara-v0-13-0-catalogs-v1-1-0-exact-pins" },
    spec: {
      source: {
        kubaraVersion: "v0.13.0",
        catalogVersion: "1.1.0",
        artifactSet: relativeRepo(artifactSetPath),
        sourceLock: relativeRepo(sourceLockPath),
      },
      retentionMode: "additive-only",
      qualification: "offline-only",
      exactPublicArtifactCount: rows.length,
      additiveVersionCount: rows.filter((row) => row.storageLane === "current-addition").length,
      candidates: rows.map((row) => ({
        canonicalIdentity: row.canonicalIdentity,
        service: row.service,
        version: row.version,
        status: row.storageLane === "current-addition"
          ? "offline-current-candidate-pass"
          : "reused-identical-offline-candidate-pass",
        storageLane: row.storageLane,
        exactArtifact: row.exactArtifact,
        recipe: row.recipe,
        package: row.package,
        variants: row.variants.map((name) => ({ name, objectCount: row.objectCounts[name] })),
        sourceLockSHA256: row.sourceLockSHA256,
      })),
      limits: [
        "candidate status does not imply retained root Catalog status",
        "three changed versions require serial live qualification before additive root promotion",
        "four byte-identical versions reuse their immutable v0.12 candidate trees rather than copying them",
      ],
    },
  };
}

function statusCsv(rows) {
  const header = "canonical_identity,service,version,storage_lane,variants,object_counts,recipe,package,artifact_sha256";
  const body = rows.map((row) => [
    row.canonicalIdentity,
    row.service,
    row.version,
    row.storageLane,
    row.variants.join(";"),
    row.variants.map((name) => `${name}:${row.objectCounts[name]}`).join(";"),
    row.recipe,
    row.package,
    row.exactArtifact.sha256,
  ].map(csvCell).join(","));
  return `${header}\n${body.join("\n")}\n`;
}

function readme(rows) {
  return `# Kubara v0.13.0 current catalog candidates

This is the component-first ConfigHub view of the seven exact public chart
artifacts selected by Kubara catalogs 1.1.0. Three changed versions are stored
as additive candidates here. Four unchanged versions reference the already
immutable v0.12 candidate trees. Nothing is replaced or discarded.

| Component | Version | Storage | Variants |
| --- | --- | --- | --- |
${rows.map((row) => `| \`${row.canonicalIdentity}\` | \`${row.version}\` | ${row.storageLane} | ${row.variants.map((name) => `\`${name}:${row.objectCounts[name]}\``).join("<br>")} |`).join("\n")}

Generate and verify offline:

\`\`\`sh
npm run kubara-current-catalog-candidates:generate
npm run kubara-current-catalog-candidates:verify
\`\`\`
`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
