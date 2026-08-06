#!/usr/bin/env node

// Build deterministic effective-render corpora for Kubara fixtures. The
// current v0.13.0 four-cluster fixture is the default and primary output. The
// historical v0.12.0 one-cluster fixture is retained only under an explicitly
// historical path.
//
// `--generate` is the only online mode: exact dependencies are downloaded into
// a temporary tree, reviewed archive digests are checked, and every instance
// is rendered twice. `--verify` is offline and checks source/output checksums.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  check,
  listFiles,
  normalizeYaml,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  sha256File,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--generate";
const profileArg = option("--profile") ?? "current";
const requestedProfiles = process.argv.includes("--all") ? ["current", "historical-v0.12.0"] : [profileArg];
const CURRENT_API_VERSIONS = [
  "argoproj.io/v1alpha1",
  "argoproj.io/v1alpha1/Application",
  "argoproj.io/v1alpha1/ApplicationSet",
  "cert-manager.io/v1",
  "cert-manager.io/v1/Certificate",
  "cert-manager.io/v1/ClusterIssuer",
  "external-secrets.io/v1",
  "external-secrets.io/v1/ClusterExternalSecret",
  "external-secrets.io/v1/ClusterSecretStore",
  "external-secrets.io/v1/ExternalSecret",
  "monitoring.coreos.com/v1",
  "monitoring.coreos.com/v1/PodMonitor",
  "monitoring.coreos.com/v1/PrometheusRule",
  "monitoring.coreos.com/v1/ServiceMonitor",
  "traefik.io/v1alpha1",
  "traefik.io/v1alpha1/IngressRoute",
  "traefik.io/v1alpha1/Middleware",
];
const HISTORICAL_API_VERSIONS = ["cert-manager.io/v1", "external-secrets.io/v1", "monitoring.coreos.com/v1"];

const PROFILE_DEFINITIONS = {
  current: {
    id: "current-platform",
    role: "primary-current",
    fixtureRoot: join(repoRoot, "examples", "kubara", "current-platform"),
    sourceLock: "source-lock.yaml",
    artifactIndex: "component-artifacts.yaml",
    config: join("source", "config.yaml"),
    generated: "generated",
    outputRoot: join(repoRoot, "data", "kubara-effective-renders", "current-platform"),
    apiVersions: CURRENT_API_VERSIONS,
  },
  "historical-v0.12.0": {
    id: "historical-v0.12.0",
    role: "secondary-historical",
    fixtureRoot: join(repoRoot, "examples", "kubara", "local-platform"),
    sourceLock: "source-lock.yaml",
    artifactIndex: "catalog-alignment.yaml",
    config: join("source", "config.yaml"),
    generated: "generated",
    outputRoot: join(repoRoot, "data", "kubara-effective-renders", "historical-v0.12.0", "test-cluster"),
    apiVersions: HISTORICAL_API_VERSIONS,
  },
};

if (["--generate", "--verify"].includes(mode)) {
  for (const profileName of requestedProfiles) {
    const profile = loadProfile(profileName);
    if (mode === "--generate") generate(profile);
    else verify(profile);
  }
} else {
  console.log(`Usage:
  node scripts/generate-kubara-effective-renders.mjs --generate [--profile current|historical-v0.12.0|--all]
  node scripts/generate-kubara-effective-renders.mjs --verify   [--profile current|historical-v0.12.0|--all]

The default profile is current. Generate uses Helm/network; verify is offline.`);
}

function loadProfile(name) {
  const definition = PROFILE_DEFINITIONS[name];
  check(definition, `unknown Kubara effective-render profile ${name}`);
  const profile = {
    ...definition,
    sourceLockPath: join(definition.fixtureRoot, definition.sourceLock),
    artifactIndexPath: join(definition.fixtureRoot, definition.artifactIndex),
    configPath: join(definition.fixtureRoot, definition.config),
    generatedRoot: join(definition.fixtureRoot, definition.generated),
  };
  for (const path of [profile.sourceLockPath, profile.artifactIndexPath, profile.configPath]) {
    check(existsSync(path), `${relativeRepo(path)} is missing`);
  }
  profile.sourceLockDocument = readYaml(profile.sourceLockPath);
  profile.artifactIndexDocument = readYaml(profile.artifactIndexPath);
  profile.configDocument = readYaml(profile.configPath);
  profile.kubaraVersion = profile.sourceLockDocument.spec?.kubara?.version ?? profile.sourceLockDocument.spec?.source?.version ?? "unknown";
  profile.kubaraCommit = profile.sourceLockDocument.spec?.kubara?.commit ?? profile.sourceLockDocument.spec?.source?.commit ?? "unknown";
  profile.catalogVersion = profile.sourceLockDocument.spec?.catalogs?.version ?? "built-in";
  profile.kubeVersion = String(profile.sourceLockDocument.spec?.generation?.helmKubeVersion ?? "1.34.0");
  profile.componentRoot = join(profile.generatedRoot, "platform-components", "helm");
  profile.configRoot = join(profile.generatedRoot, "platform-configs");
  return profile;
}

function generate(profile) {
  check(existsSync(profile.componentRoot), `${relativeRepo(profile.componentRoot)} is missing; run the ${profile.id} example generator first`);
  check(existsSync(profile.configRoot), `${relativeRepo(profile.configRoot)} is missing; run the ${profile.id} example generator first`);
  const instances = discoverInstances(profile);
  const sourceChecksums = buildSourceChecksums(profile, instances);
  const expectedArtifacts = artifactDigestsByService(profile);
  const helmVersion = helm(["version", "--template", "{{.Version}}"]).trim();
  const tempRoot = mkdtempSync(join(tmpdir(), `kubara-${profile.id}-renders-`));
  const tempComponents = join(tempRoot, "components");
  const dependencyPackages = new Map();
  const results = [];

  try {
    cpSync(profile.componentRoot, tempComponents, { recursive: true });
    for (const component of [...new Set(instances.map((entry) => entry.component))].sort()) {
      const chartDir = join(tempComponents, component);
      check(existsSync(join(chartDir, "Chart.yaml")), `generated wrapper ${relativeRepo(join(profile.componentRoot, component, "Chart.yaml"))} is missing`);
      helm(["dependency", "build", chartDir, "--skip-refresh"]);
      dependencyPackages.set(component, reviewedDependencyPackages(chartDir, expectedArtifacts.get(component) ?? []));
    }

    for (const instance of instances) {
      const chartDir = join(tempComponents, instance.component);
      const args = renderArgs(profile, instance, chartDir);
      const first = normalizeYaml(helm(args));
      const second = normalizeYaml(helm(args));
      check(first === second, `${instance.cluster}/${instance.component} did not render byte-identically twice`);
      const docs = parseDocs(first).filter(isKubernetesObject);
      const output = join(profile.outputRoot, instance.cluster, `${instance.component}.yaml`);
      write(output, first);
      results.push({
        cluster: instance.cluster,
        stage: instance.stage,
        clusterType: instance.clusterType,
        component: instance.component,
        kubaraService: instance.kubaraService,
        releaseName: instance.releaseName,
        namespace: instance.namespace,
        values: instance.values.map(relativeRepo),
        output: relativeRepo(output),
        sha256: sha256(first),
        objectCount: docs.length,
        kinds: countKinds(docs),
        deterministicDoubleRender: true,
        dependencyPackages: dependencyPackages.get(instance.component),
      });
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  results.sort(compareInstances);
  const sourceChecksumsPath = join(profile.outputRoot, "source-checksums.txt");
  const renderChecksumsPath = join(profile.outputRoot, "render-checksums.txt");
  const receiptPath = join(profile.outputRoot, "receipt.yaml");
  const readmePath = join(profile.outputRoot, "README.md");
  write(sourceChecksumsPath, sourceChecksums);
  const renderChecksums = results.map((entry) => `${entry.sha256}  ${entry.output}`).sort().join("\n") + "\n";
  write(renderChecksumsPath, renderChecksums);
  writeYaml(receiptPath, {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraEffectiveRenderReceipt",
    metadata: { name: `${profile.id}-${profile.kubaraVersion.replace(/^v/, "v")}` },
    spec: {
      profile: { id: profile.id, role: profile.role },
      source: {
        kubaraVersion: profile.kubaraVersion,
        kubaraCommit: profile.kubaraCommit,
        catalogVersion: profile.catalogVersion,
        fixture: relativeRepo(profile.fixtureRoot),
        sourceLock: relativeRepo(profile.sourceLockPath),
        artifactIndex: relativeRepo(profile.artifactIndexPath),
        config: relativeRepo(profile.configPath),
        sourceChecksums: relativeRepo(sourceChecksumsPath),
        sourceChecksumsSha256: sha256(sourceChecksums),
      },
      renderProfile: {
        kubeVersion: profile.kubeVersion,
        helmVersion,
        includeCrds: true,
        includeHooks: true,
        skipTests: true,
        apiVersions: profile.apiVersions,
      },
      clusters: clusterSummary(profile),
      instances: results,
      renderChecksums: relativeRepo(renderChecksumsPath),
      renderChecksumsSha256: sha256(renderChecksums),
      claimBoundary: [
        "These are offline Helm renders of committed Kubara-generated wrappers and per-cluster values.",
        "API versions are declared explicitly so cross-component custom resources appear in each cluster's aggregate desired-state corpus.",
        "A rendered object is desired-state evidence, not proof that a controller created it or that a live cluster reconciled it.",
      ],
    },
    status: { result: "offline-render-pass", liveReconciliation: "not-observed-by-this-receipt" },
  });
  write(readmePath, renderReadme(profile, results, helmVersion));
  console.log(`wrote ${results.length} ${profile.role} Kubara effective renders -> ${relativeRepo(profile.outputRoot)}`);
}

function verify(profile) {
  const receiptPath = join(profile.outputRoot, "receipt.yaml");
  const sourceChecksumsPath = join(profile.outputRoot, "source-checksums.txt");
  const renderChecksumsPath = join(profile.outputRoot, "render-checksums.txt");
  const readmePath = join(profile.outputRoot, "README.md");
  for (const path of [receiptPath, sourceChecksumsPath, renderChecksumsPath, readmePath]) {
    check(existsSync(path), `${relativeRepo(path)} is missing; generate profile ${profile.id}`);
  }
  const receipt = readYaml(receiptPath);
  check(receipt.spec?.profile?.role === profile.role, `${relativeRepo(receiptPath)} has the wrong profile role`);
  const instances = discoverInstances(profile);
  const sourceChecksums = buildSourceChecksums(profile, instances);
  check(readFileSync(sourceChecksumsPath, "utf8") === sourceChecksums, `${relativeRepo(sourceChecksumsPath)} is stale`);
  check(receipt.spec?.source?.sourceChecksumsSha256 === sha256(sourceChecksums), `${profile.id} source checksum receipt is stale`);

  const results = receipt.spec?.instances ?? [];
  check(results.length === instances.length, `${profile.id} expected ${instances.length} instance renders, found ${results.length}`);
  const renderLines = [];
  for (const instance of results) {
    const output = join(repoRoot, instance.output);
    check(existsSync(output), `${instance.output} is missing`);
    const text = readFileSync(output, "utf8");
    const docs = parseDocs(text).filter(isKubernetesObject);
    check(sha256(text) === instance.sha256, `${instance.output} digest does not match its receipt`);
    check(docs.length === instance.objectCount, `${instance.output} object count does not match its receipt`);
    check(sameCounts(countKinds(docs), instance.kinds), `${instance.output} kind inventory does not match its receipt`);
    check(instance.deterministicDoubleRender === true, `${instance.cluster}/${instance.component} has no double-render assertion`);
    renderLines.push(`${instance.sha256}  ${instance.output}`);
  }
  const renderChecksums = renderLines.sort().join("\n") + "\n";
  check(readFileSync(renderChecksumsPath, "utf8") === renderChecksums, `${relativeRepo(renderChecksumsPath)} is stale`);
  check(receipt.spec?.renderChecksumsSha256 === sha256(renderChecksums), `${profile.id} render checksum receipt is stale`);
  check(readFileSync(readmePath, "utf8") === renderReadme(profile, results, receipt.spec?.renderProfile?.helmVersion ?? "unknown"), `${relativeRepo(readmePath)} is stale`);
  console.log(`verified ${results.length} committed ${profile.role} Kubara effective renders offline`);
}

function discoverInstances(profile) {
  const instances = [];
  for (const cluster of profile.configDocument.clusters ?? []) {
    const enabled = Object.entries(cluster.services ?? {}).filter(([, value]) => value?.status === "enabled").map(([name]) => normalizeComponent(name));
    if (cluster.argocd?.selfManaged === "enabled" || enabled.includes("argo-cd")) enabled.push("argo-cd");
    for (const component of [...new Set(enabled)].sort()) {
      const valueDir = join(profile.configRoot, cluster.name, "helm", component);
      check(existsSync(valueDir), `${relativeRepo(valueDir)} is missing for enabled ${cluster.name}/${component}`);
      const values = orderedValues(valueDir);
      check(values.some((path) => basename(path) === "values.generated.yaml"), `${relativeRepo(valueDir)} has no values.generated.yaml`);
      instances.push({
        cluster: cluster.name,
        stage: cluster.stage ?? "unknown",
        clusterType: cluster.type ?? "unknown",
        component,
        kubaraService: component === "argo-cd" && profile.id === "historical-v0.12.0" ? "argocd" : component,
        releaseName: component === "argo-cd" && profile.id === "historical-v0.12.0" ? "argocd" : component,
        namespace: component === "argo-cd" ? "argocd" : component,
        values,
      });
    }
  }
  return instances.sort(compareInstances);
}

function orderedValues(dir) {
  const files = listFiles(dir).filter((file) => dirname(file) === dir && /(?:^values(?:[.-].*)?\.ya?ml$|^additional-values\.ya?ml$)/.test(basename(file)));
  const rank = (file) => basename(file) === "values.generated.yaml" ? 0 : basename(file) === "additional-values.yaml" ? 1 : 2;
  return files.sort((left, right) => rank(left) - rank(right) || basename(left).localeCompare(basename(right)));
}

function renderArgs(profile, instance, chartDir) {
  const args = ["template", instance.releaseName, chartDir, "--namespace", instance.namespace, "--kube-version", profile.kubeVersion, "--include-crds", "--skip-tests"];
  for (const apiVersion of profile.apiVersions) args.push("--api-versions", apiVersion);
  for (const values of instance.values) args.push("--values", values);
  return args;
}

function buildSourceChecksums(profile, instances) {
  const files = new Set([profile.sourceLockPath, profile.artifactIndexPath, profile.configPath]);
  for (const component of new Set(instances.map((entry) => entry.component))) {
    for (const file of listFiles(join(profile.componentRoot, component))) if (!file.includes("/charts/") && !file.endsWith("/.DS_Store")) files.add(file);
  }
  const library = join(profile.componentRoot, "template-library");
  if (existsSync(library)) for (const file of listFiles(library)) if (!file.includes("/charts/") && !file.endsWith("/.DS_Store")) files.add(file);
  for (const instance of instances) for (const file of instance.values) files.add(file);
  return [...files].sort((left, right) => relativeRepo(left).localeCompare(relativeRepo(right))).map((file) => `${sha256File(file)}  ${relativeRepo(file)}`).join("\n") + "\n";
}

function artifactDigestsByService(profile) {
  const result = new Map();
  if (profile.artifactIndexDocument.kind === "KubaraComponentArtifactSet") {
    for (const row of profile.artifactIndexDocument.spec?.artifacts ?? []) addArtifact(result, normalizeComponent(row.service), row.canonicalIdentity, row.sha256);
  } else {
    for (const row of profile.artifactIndexDocument.spec?.components ?? []) {
      const digest = row.kubara?.artifact?.sha256 ?? String(row.kubara?.artifact?.chartLayerDigest ?? "").replace(/^sha256:/, "");
      addArtifact(result, normalizeComponent(row.kubara?.service), row.canonicalIdentity, digest);
    }
  }
  return result;
}

function addArtifact(result, service, identity, digest) {
  if (!service || !digest) return;
  if (!result.has(service)) result.set(service, []);
  result.get(service).push({ identity, digest: String(digest).replace(/^sha256:/, "") });
}

function reviewedDependencyPackages(chartDir, expected) {
  const packages = listFiles(join(chartDir, "charts")).filter((file) => file.endsWith(".tgz")).map((file) => ({ file: basename(file), sha256: sha256File(file) })).sort((left, right) => left.file.localeCompare(right.file));
  for (const artifact of expected) {
    check(packages.some((entry) => entry.sha256 === artifact.digest), `${basename(chartDir)} did not download reviewed artifact ${artifact.identity} (${artifact.digest})`);
  }
  return packages.map((entry) => {
    const reviewedArtifact = expected.some((artifact) => artifact.digest === entry.sha256);
    check(reviewedArtifact || entry.file.startsWith("template-library-"), `${entry.file} is neither reviewed upstream nor the local template-library`);
    return {
      file: entry.file,
      sha256: reviewedArtifact ? entry.sha256 : undefined,
      reviewedArtifact,
      source: reviewedArtifact ? "reviewed-upstream-archive" : "local-file-dependency; source tree covered by source-checksums.txt",
    };
  });
}

function clusterSummary(profile) {
  return (profile.configDocument.clusters ?? []).map((cluster) => ({
    name: cluster.name,
    stage: cluster.stage ?? "unknown",
    type: cluster.type ?? "unknown",
    argoSelfManaged: cluster.argocd?.selfManaged ?? (cluster.services?.argocd?.status === "enabled" ? "enabled" : "unspecified"),
  }));
}

function renderReadme(profile, results, helmVersion) {
  const rows = results.map((entry) => `| ${entry.cluster} | ${entry.component} | ${entry.namespace} | ${entry.objectCount} | \`${entry.sha256.slice(0, 12)}\` |`).join("\n");
  return `# Kubara Effective Render Corpus — ${profile.role}

This directory is the ${profile.role === "primary-current" ? "primary" : "secondary historical"} offline
desired-state input to the Kubara wiring extractor. It covers Kubara
${profile.kubaraVersion}${profile.catalogVersion === "built-in" ? " with its built-in catalog" : ` with catalogs ${profile.catalogVersion}`}.
It is not a live-health receipt.

| Cluster | Component | Render namespace | Objects | SHA-256 prefix |
| --- | --- | --- | ---: | --- |
${rows}

Render profile: Kubernetes ${profile.kubeVersion}, Helm ${helmVersion}, CRDs and
hooks included, tests skipped, and cross-component API versions listed in
[receipt.yaml](receipt.yaml).

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --generate --profile ${profile.id === "current-platform" ? "current" : "historical-v0.12.0"}
node scripts/generate-kubara-effective-renders.mjs --verify --profile ${profile.id === "current-platform" ? "current" : "historical-v0.12.0"}
~~~

Generation builds dependencies in a temporary directory, checks every reviewed
upstream archive against the committed artifact index, and requires two
successive renders to be byte-identical. Verification is offline.
`;
}

function helm(args) {
  return execFileSync("helm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 300,
    env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
  });
}

function countKinds(docs) {
  const counts = docs.reduce((map, doc) => map.set(doc.kind, (map.get(doc.kind) ?? 0) + 1), new Map());
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sameCounts(left, right) {
  const keys = [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
  return keys.every((key) => left?.[key] === right?.[key]);
}

function isKubernetesObject(doc) {
  return Boolean(doc && typeof doc === "object" && doc.apiVersion && doc.kind && doc.metadata?.name);
}

function compareInstances(left, right) {
  return left.cluster.localeCompare(right.cluster) || left.component.localeCompare(right.component);
}

function normalizeComponent(value) {
  return value === "argocd" ? "argo-cd" : value;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
