#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { check, readYaml, repoRoot, toYaml } from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--help";
const continueOnFail = process.argv.includes("--continue-on-fail");
const resume = process.argv.includes("--resume");
const current = process.argv.includes("--current");
const from = optionValue("--from");
const only = optionValue("--only");
const summaryPath = join(
  repoRoot,
  "runs",
  current ? "kubara-current-live-qualification" : "kubara-live-qualification",
  "receipt.yaml",
);

const historicalVersions = {
  argo: "10.1.3",
  certManager: "v1.21.0",
  externalSecrets: "2.7.0",
  kps: "87.15.1",
  blackbox: "11.15.1",
  metricsServer: "3.13.1",
  traefik: "41.0.2",
};
const currentVersions = {
  ...historicalVersions,
  argo: "10.2.1",
  externalSecrets: "2.8.0",
  kps: "87.19.2",
};
const versions = current ? currentVersions : historicalVersions;
const currentOnlyVersions = new Set([
  currentVersions.argo,
  currentVersions.externalSecrets,
  currentVersions.kps,
]);

const lanes = [
  lane("blackbox-default", "prometheus-community", "prometheus-blackbox-exporter", versions.blackbox, "default", `kub-bbe-${slugPart(versions.blackbox)}-d`),
  lane("metrics-default", "metrics-server", "metrics-server", versions.metricsServer, "default", `kub-met-${slugPart(versions.metricsServer)}-d`),
  lane("metrics-external-tls-ca", "metrics-server", "metrics-server", versions.metricsServer, "external-tls-ca", `kub-met-${slugPart(versions.metricsServer)}-tls`),
  lane("cert-manager-default", "jetstack", "cert-manager", versions.certManager, "default", `kub-cm-${slugPart(versions.certManager)}-d`),
  lane("cert-manager-crds-enabled", "jetstack", "cert-manager", versions.certManager, "crds-enabled", `kub-cm-${slugPart(versions.certManager)}-crd`),
  lane("external-secrets-default", "external-secrets", "external-secrets", versions.externalSecrets, "default", `kub-eso-${slugPart(versions.externalSecrets)}-d`),
  lane("external-secrets-no-crds", "external-secrets", "external-secrets", versions.externalSecrets, "no-crds", `kub-eso-${slugPart(versions.externalSecrets)}-nc`),
  lane("argo-cd-no-crds", "argo-cd", "argo-cd", versions.argo, "no-crds", `kub-argo-${slugPart(versions.argo)}-nc`),
  lane("argo-cd-default", "argo-cd", "argo-cd", versions.argo, "default", `kub-argo-${slugPart(versions.argo)}-d`),
  lane("kps-default", "prometheus-community", "kube-prometheus-stack", versions.kps, "default", `kub-kps-${slugPart(versions.kps)}-d`),
  lane("kps-no-crds", "prometheus-community", "kube-prometheus-stack", versions.kps, "no-crds", `kub-kps-${slugPart(versions.kps)}-nc`),
  lane("kps-existing-secret", "prometheus-community", "kube-prometheus-stack", versions.kps, "existing-secret", `kub-kps-${slugPart(versions.kps)}-es`),
  lane("traefik-default", "traefik", "traefik", versions.traefik, "default", `kub-tra-${slugPart(versions.traefik)}-d`, "kind-loadbalancer"),
];

if (mode === "--help" || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage:
  npm run kubara-live-qualification:preflight
  npm run kubara-live-qualification:run -- [--resume] [--from <id>] [--only <id>]
  npm run kubara-live-qualification:summary
  npm run kubara-live-qualification:verify

Add --current to operate on the Kubara v0.13.0 / catalogs 1.1.0 selection.

Runs all declared bases for the seven exact Kubara public chart pins.
Every lane is serialized, artifact-addressed, versioned, and must clean both its
owned kind cluster and its ephemeral ConfigHub Spaces before the next lane.`);
} else if (mode === "--preflight") {
  for (const item of selectedLanes()) runLane(item, "--preflight");
} else if (mode === "--run") {
  runAll();
} else if (mode === "--summary") {
  writeSummary();
} else if (mode === "--verify") {
  verifySummary();
} else {
  throw new Error(`unknown mode: ${mode}`);
}

function lane(id, repository, chart, version, base, slug, targetProfile = "none") {
  const candidateRoot = current && currentOnlyVersions.has(version)
    ? "data/kubara-catalog-refresh/current-candidates"
    : "data/kubara-catalog-refresh/candidates";
  const relative = `${repository}/${chart}/${version}`;
  return {
    id,
    repository,
    chart,
    canonicalIdentity: `helm:${repository}/${chart}`,
    version,
    base,
    slug,
    rig: `helm-expt-parity-${slug}`,
    recipe: `${candidateRoot}/recipes/${relative}`,
    package: `${candidateRoot}/packages/${relative}`,
    receipt: `runs/live-helm-confighub-compare/kubara-${chart}-${slugPart(version)}-${base}/receipt.yaml`,
    targetProfile,
  };
}

function selectedLanes() {
  let selected = [...lanes];
  if (from) {
    const index = selected.findIndex((item) => item.id === from);
    check(index >= 0, `unknown --from lane: ${from}`);
    selected = selected.slice(index);
  }
  if (only) {
    selected = selected.filter((item) => item.id === only);
    check(selected.length === 1, `unknown --only lane: ${only}`);
  }
  return selected;
}

function runAll() {
  const baseline = kindClusters();
  check(
    baseline.every((name) => !name.startsWith("helm-expt-parity-")),
    `refusing to start with a leaked parity cluster: ${baseline.join(", ")}`,
  );
  const failed = [];
  for (const item of selectedLanes()) {
    if (resume && receiptPasses(item)) {
      verifyCleanup(item, baseline);
      console.log(`skip ${item.id}: existing pass receipt and clean target`);
      continue;
    }
    runLane(item, "--preflight");
    const result = runLane(item, "--run", { allowReceiptResult: true });
    const receipt = loadReceipt(item);
    const passed = result.status === 0 && receipt.spec?.result === "pass";
    try {
      verifyCleanup(item, baseline);
    } catch (error) {
      failed.push(`${item.id}: ${error.message}`);
      if (!continueOnFail) throw error;
      continue;
    }
    if (!passed) {
      failed.push(`${item.id}: ${receipt.spec?.result ?? "missing result"}`);
      if (!continueOnFail) {
        writeSummary({ allowIncomplete: true });
        throw new Error(failed.at(-1));
      }
    }
  }
  writeSummary({ allowIncomplete: true });
  if (failed.length) throw new Error(`Kubara live qualification failures:\n- ${failed.join("\n- ")}`);
}

function runLane(item, commandMode, { allowReceiptResult = false } = {}) {
  const args = [
    "scripts/run-live-helm-confighub-parity.mjs",
    commandMode,
    "--recipe", item.recipe,
    "--package", item.package,
    "--base", item.base,
    "--slug", item.slug,
    "--rig", item.rig,
    "--out", item.receipt,
  ];
  if (item.targetProfile !== "none") args.push("--target-profile", item.targetProfile);
  console.log(`${commandMode === "--run" ? "run" : "preflight"} ${item.id}`);
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  check(result.status === 0, `${item.id}: ${commandMode} process failed with ${result.status}`);
  if (commandMode === "--run" && !allowReceiptResult) {
    check(loadReceipt(item).spec?.result === "pass", `${item.id}: live receipt did not pass`);
  }
  return result;
}

function receiptPasses(item) {
  return existsSync(join(repoRoot, item.receipt)) && loadReceipt(item).spec?.result === "pass";
}

function loadReceipt(item) {
  const path = join(repoRoot, item.receipt);
  check(existsSync(path), `${item.id}: receipt is missing at ${item.receipt}`);
  return readYaml(path);
}

function verifyCleanup(item, baseline) {
  const receipt = loadReceipt(item);
  check(receipt.spec?.run?.clusterLifecycle === "cleaned-up", `${item.id}: kind cluster was not cleaned up`);
  check(receipt.spec?.run?.cleanup?.result === "pass", `${item.id}: cleanup receipt did not pass`);
  const observed = kindClusters();
  check(JSON.stringify(observed) === JSON.stringify(baseline), `${item.id}: kind cluster baseline changed`);
  const clusters = command("cub", ["cluster", "list"]);
  const remains = clusters.split("\n").some((line) => line.split(/\s+/)[0] === item.rig);
  check(!remains, `${item.id}: ephemeral ConfigHub cluster config remains`);
}

function summary({ allowIncomplete = false } = {}) {
  const rows = [];
  for (const item of lanes) {
    const path = join(repoRoot, item.receipt);
    if (!existsSync(path)) {
      check(allowIncomplete, `${item.id}: missing live qualification receipt`);
      rows.push({ ...summaryIdentity(item), result: "not-run", receipt: item.receipt });
      continue;
    }
    const receipt = readYaml(path);
    rows.push({
      ...summaryIdentity(item),
      result: receipt.spec?.result,
      receipt: item.receipt,
      observedAt: receipt.spec?.observedAt,
      sourceArtifact: receipt.spec?.sourceArtifact,
      legs: Object.fromEntries(
        Object.entries(receipt.spec?.legs ?? {}).map(([name, leg]) => [name, leg.result]),
      ),
      cleanup: {
        clusterLifecycle: receipt.spec?.run?.clusterLifecycle,
        result: receipt.spec?.run?.cleanup?.result,
      },
    });
  }
  const result = rows.every((row) => row.result === "pass") ? "pass" : "incomplete";
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraLiveQualificationSetReceipt",
    metadata: {
      name: current
        ? "kubara-v0-13-0-catalogs-v1-1-0-exact-pins-all-bases"
        : "kubara-v0-12-0-exact-pins-all-bases",
    },
    spec: {
      sourceCandidateSet: current
        ? "data/kubara-catalog-refresh/current-candidates/candidate-set.yaml"
        : "data/kubara-catalog-refresh/candidates/candidate-set.yaml",
      execution: "serial",
      exactArtifactRequired: true,
      laneCount: rows.length,
      componentCount: new Set(rows.map((row) => row.canonicalIdentity)).size,
      lanes: rows,
    },
    status: { result },
  };
}

function summaryIdentity(item) {
  return {
    id: item.id,
    canonicalIdentity: item.canonicalIdentity,
    version: item.version,
    base: item.base,
    targetProfile: item.targetProfile,
  };
}

function writeSummary(options = {}) {
  const value = summary(options);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${toYaml(value)}\n`);
  console.log(`wrote ${summaryPath.slice(repoRoot.length + 1)} result=${value.status.result}`);
}

function verifySummary() {
  check(existsSync(summaryPath), "Kubara live qualification summary is missing");
  const expected = `${toYaml(summary())}\n`;
  const actual = readFileSync(summaryPath, "utf8");
  check(actual === expected, "Kubara live qualification summary is stale");
  console.log(`verified ${lanes.length} serial Kubara live qualification lanes`);
}

function kindClusters() {
  return command("kind", ["get", "clusters"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  check(result.status === 0, `${binary} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function slugPart(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "").toLowerCase();
}
