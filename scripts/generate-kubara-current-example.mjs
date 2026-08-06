#!/usr/bin/env node

// Reproduce the Kubara v0.13.0 four-cluster example from two catalog lanes:
// Kubara's pinned 1.1.0 release tree and the byte-preserving ConfigHub-aligned
// export. Generation is the only online mode. Verification is deliberately
// offline and checks every committed source/output byte against receipts.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import {
  check,
  listFiles,
  normalizeYaml,
  parseDocs,
  readYaml,
  repoRoot,
  sha256,
  sha256File,
  toYaml,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
if (!["--generate", "--verify"].includes(mode)) {
  console.error("Usage: node scripts/generate-kubara-current-example.mjs [--generate|--verify]");
  process.exit(1);
}

const exampleRoot = join(repoRoot, "examples", "kubara", "current-platform");
const sourceRoot = join(exampleRoot, "source");
const configPath = join(sourceRoot, "config.yaml");
const artifactSetPath = join(exampleRoot, "component-artifacts.yaml");
const sourceLockPath = join(exampleRoot, "source-lock.yaml");
const generatedRoot = join(exampleRoot, "generated");
const renderRoot = join(exampleRoot, "effective-renders");
const sourceChecksumsPath = join(exampleRoot, "source-checksums.txt");
const generatedChecksumsPath = join(exampleRoot, "generated-checksums.txt");
const renderChecksumsPath = join(exampleRoot, "effective-render-checksums.txt");
const parityReceiptPath = join(exampleRoot, "catalog-parity-receipt.yaml");
const generationReceiptPath = join(exampleRoot, "generation-receipt.yaml");
const readmePath = join(exampleRoot, "README.md");
const scriptPath = join(repoRoot, "scripts", "generate-kubara-current-example.mjs");

const releaseCatalogRoot = join(
  repoRoot,
  "data",
  "kubara-catalog-snapshots",
  "kubara-catalogs-1.1.0-release",
  "source",
);
const alignedCatalogRoot = join(
  repoRoot,
  "data",
  "kubara-catalog-adapter",
  "exports",
  "kubara-catalogs-1.1.0-release",
);

const EXPECTED = {
  kubaraVersion: "v0.13.0",
  kubaraVersionOutput: "kubara version v0.13.0",
  kubaraCommit: "096ed84d116e5316852537046cc61d15a1e1c304",
  kubaraBinarySha256: "72642ce49aa5e9d13aeb4441aebc4c4530c7427c0d0aacbcee7b97e249f57183",
  catalogVersion: "1.1.0",
  catalogCommit: "b451260636bba764ccdb0561d9f8f5ce414e2ee5",
  bootstrapReference: "oci://ghcr.io/kubara-io/catalogs/bootstrap:1.1.0",
  generalReference: "oci://ghcr.io/kubara-io/catalogs/general:1.1.0",
  repoURL: "https://github.com/confighub/helm-expt.git",
  kubeVersion: "1.35.0",
  clusters: ["hx-app-dev", "hx-app-staging", "hx-app-prod-a", "hx-app-prod-b"],
};

const SERVICE_KEYS = [
  "cert-manager",
  "external-dns",
  "external-secrets",
  "homer-dashboard",
  "kube-prometheus-stack",
  "kyverno",
  "kyverno-policies",
  "kyverno-policy-reporter",
  "loki",
  "longhorn",
  "metallb",
  "metrics-server",
  "oauth2-proxy",
  "reloader",
  "traefik",
  "velero",
];

const EXPECTED_ENABLED = new Map([
  ["hx-app-dev", ["cert-manager", "external-secrets", "homer-dashboard", "kube-prometheus-stack", "metrics-server", "traefik"]],
  ["hx-app-staging", ["cert-manager", "traefik"]],
  ["hx-app-prod-a", ["cert-manager", "traefik"]],
  ["hx-app-prod-b", ["cert-manager", "traefik"]],
]);

const KIND_TRAEFIK = new Map([
  ["hx-app-dev", { reservedArgocdServerNodePort: 30000, httpNodePort: 30002, httpsNodePort: 30003, hostname: "hx-app-dev.traefik.me" }],
  ["hx-app-staging", { reservedArgocdServerNodePort: 30010, httpNodePort: 30012, httpsNodePort: 30013, hostname: "hx-app-staging.traefik.me" }],
  ["hx-app-prod-a", { reservedArgocdServerNodePort: 30020, httpNodePort: 30022, httpsNodePort: 30023, hostname: "hx-app-prod-a.traefik.me" }],
  ["hx-app-prod-b", { reservedArgocdServerNodePort: 30030, httpNodePort: 30032, httpsNodePort: 30033, hostname: "hx-app-prod-b.traefik.me" }],
]);

// One hub Argo render + cert-manager and Traefik on four clusters + four
// additional hub services. That arithmetic is 13, despite an earlier planning
// note calling the same set "12".
const RENDER_CASES = [
  renderCase("hx-app-dev", "argo-cd", "argocd"),
  renderCase("hx-app-dev", "cert-manager", "cert-manager"),
  renderCase("hx-app-dev", "external-secrets", "external-secrets"),
  renderCase("hx-app-dev", "homer-dashboard", "homer-dashboard"),
  renderCase("hx-app-dev", "kube-prometheus-stack", "kube-prometheus-stack"),
  renderCase("hx-app-dev", "metrics-server", "metrics-server"),
  renderCase("hx-app-dev", "traefik", "traefik"),
  renderCase("hx-app-staging", "cert-manager", "cert-manager"),
  renderCase("hx-app-staging", "traefik", "traefik"),
  renderCase("hx-app-prod-a", "cert-manager", "cert-manager"),
  renderCase("hx-app-prod-a", "traefik", "traefik"),
  renderCase("hx-app-prod-b", "cert-manager", "cert-manager"),
  renderCase("hx-app-prod-b", "traefik", "traefik"),
];

const SOURCE_OVERRIDES = [
  {
    source: join(sourceRoot, "overrides", "hx-app-dev", "helm", "argo-cd", "values-repository-paths.yaml"),
    cluster: "hx-app-dev",
    service: "argo-cd",
  },
  {
    source: join(sourceRoot, "overrides", "hx-app-dev", "helm", "cert-manager", "values-kind.yaml"),
    cluster: "hx-app-dev",
    service: "cert-manager",
  },
  {
    source: join(sourceRoot, "overrides", "hx-app-dev", "helm", "homer-dashboard", "values-project-links.yaml"),
    cluster: "hx-app-dev",
    service: "homer-dashboard",
  },
  {
    source: join(sourceRoot, "overrides", "hx-app-dev", "helm", "metrics-server", "values-kind.yaml"),
    cluster: "hx-app-dev",
    service: "metrics-server",
  },
  ...["hx-app-staging", "hx-app-prod-a", "hx-app-prod-b"].map((cluster) => ({
    source: join(sourceRoot, "overrides", cluster, "helm", "cert-manager", "values-kind.yaml"),
    cluster,
    service: "cert-manager",
  })),
  ...[...KIND_TRAEFIK.keys()].map((cluster) => ({
    source: join(sourceRoot, "overrides", cluster, "helm", "traefik", "values-kind.yaml"),
    cluster,
    service: "traefik",
  })),
];

const API_VERSIONS = [
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

const EXPECTED_ARTIFACTS = [
  artifact("argo-cd", "argo-cd", "1.3.0", "10.2.1", "https://github.com/argoproj/argo-helm/releases/download/argo-cd-10.2.1/argo-cd-10.2.1.tgz", "27e930e366d22c999002008ad5ec7961bda00410a84287210d0fffbee8150885"),
  artifact("cert-manager", "cert-manager", "0.5.0", "v1.21.0", "https://charts.jetstack.io/charts/cert-manager-v1.21.0.tgz", "9c2c6fabf3cf8fe14dacb016f37c819b66bc2c79e8b7acde4573d45ec141fb97"),
  artifact("external-secrets", "external-secrets", "0.14.0", "2.8.0", "https://github.com/external-secrets/external-secrets/releases/download/helm-chart-2.8.0/external-secrets-2.8.0.tgz", "251e4615013c6d2f9ade5cedf1cd8615613f286bfc381e44fb005f197e611ecd"),
  artifact("kube-prometheus-stack", "kube-prometheus-stack", "2.5.0", "87.19.2", "https://github.com/prometheus-community/helm-charts/releases/download/kube-prometheus-stack-87.19.2/kube-prometheus-stack-87.19.2.tgz", "b846cc368aaafd122148c8eec9b361d3893c6068d6301ec20d41c8023dcd8c88"),
  artifact("kube-prometheus-stack", "prometheus-blackbox-exporter", "2.5.0", "11.15.1", "https://github.com/prometheus-community/helm-charts/releases/download/prometheus-blackbox-exporter-11.15.1/prometheus-blackbox-exporter-11.15.1.tgz", "4e8e45b8a6fbec4168d9b3e772a0219afec09b61c545af5f01395de363e30b5e"),
  artifact("metrics-server", "metrics-server", "0.1.0", "3.13.1", "https://github.com/kubernetes-sigs/metrics-server/releases/download/metrics-server-helm-chart-3.13.1/metrics-server-3.13.1.tgz", "084e6edb680cf4e2acc30bd496568c53fdf663cbacf6e17876b25785c35b7a13"),
  artifact("traefik", "traefik", "2.1.0", "41.0.2", "oci://ghcr.io/traefik/helm/traefik:41.0.2", "a84ec5eae9f5507c8f0632d58a7eb10c9b7fd2a277b77740ee7460c55ecde49a", "sha256:b64212403e056c14dbcac5bfd0030f89f0e08fccae370dd7cd96592ee745848e"),
];

if (mode === "--generate") generate();
verify();

function generate() {
  verifySourceContract();
  const kubaraBin = process.env.KUBARA_BIN;
  check(kubaraBin, "set KUBARA_BIN to the SHA-pinned Kubara v0.13.0 binary");
  check(existsSync(kubaraBin), `Kubara binary does not exist: ${kubaraBin}`);
  check(sha256File(kubaraBin) === EXPECTED.kubaraBinarySha256, "Kubara binary SHA-256 differs from source-lock.yaml");
  check(run(kubaraBin, ["--version"]).trim() === EXPECTED.kubaraVersionOutput, "Kubara binary version differs from v0.13.0");

  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-current-"));
  try {
    const releaseLane = generateLane(kubaraBin, "kubara-release-snapshot", releaseCatalogRoot, join(tempRoot, "release"));
    const alignedLane = generateLane(kubaraBin, "confighub-aligned-export", alignedCatalogRoot, join(tempRoot, "aligned"));
    const parity = compareTrees(releaseLane.generated, alignedLane.generated);
    check(parity.equal, `catalog generation lanes differ:\n${parity.differences.join("\n")}`);

    const artifactResults = materializeArtifacts(join(tempRoot, "artifacts"));
    const stagedGenerated = join(tempRoot, "committed-generated");
    cpSync(releaseLane.generated, stagedGenerated, { recursive: true });
    const renderResults = renderAll(stagedGenerated, artifactResults, join(tempRoot, "renders"));

    replaceDirectory(generatedRoot, stagedGenerated);
    replaceDirectory(renderRoot, join(tempRoot, "renders"));

    const sourceChecksums = buildSourceChecksums();
    const generatedChecksums = buildTreeChecksums(generatedRoot);
    const renderChecksums = buildTreeChecksums(renderRoot);
    write(sourceChecksumsPath, sourceChecksums);
    write(generatedChecksumsPath, generatedChecksums);
    write(renderChecksumsPath, renderChecksums);

    const generatedDigest = sha256(generatedChecksums);
    const catalogDigest = treeDigest(releaseCatalogRoot);
    writeYaml(parityReceiptPath, {
      apiVersion: "evidence.confighub.com/v1alpha1",
      kind: "KubaraCatalogGenerationParityReceipt",
      metadata: { name: "kubara-v0-13-0-catalogs-v1-1-0" },
      spec: {
        kubara: {
          version: EXPECTED.kubaraVersion,
          commit: EXPECTED.kubaraCommit,
          binarySha256: EXPECTED.kubaraBinarySha256,
        },
        sourceConfig: {
          path: relativeRepo(configPath),
          sha256: sha256File(configPath),
          committedReferences: [EXPECTED.bootstrapReference, EXPECTED.generalReference],
          generationSubstitution: "local-paths-in-temporary-config-only",
        },
        lanes: [
          laneReceipt("kubara-release-snapshot", releaseCatalogRoot, catalogDigest, generatedDigest, releaseLane.generated),
          laneReceipt("confighub-aligned-export", alignedCatalogRoot, treeDigest(alignedCatalogRoot), generatedDigest, alignedLane.generated),
        ],
        comparison: {
          mode: "path-and-byte-for-byte",
          fileCount: listFiles(generatedRoot).length,
          outputTreeSha256: generatedDigest,
          differences: [],
        },
      },
      status: {
        result: "pass",
        sourceCatalogTrees: "byte-for-byte-equal",
        generatedTrees: "byte-for-byte-equal",
      },
    });

    const helmVersion = run("helm", ["version", "--short"]).trim();
    writeYaml(generationReceiptPath, {
      apiVersion: "evidence.confighub.com/v1alpha1",
      kind: "KubaraCurrentPlatformGenerationReceipt",
      metadata: { name: "kubara-v0-13-0-four-cluster-platform" },
      spec: {
        source: {
          config: relativeRepo(configPath),
          sourceLock: relativeRepo(sourceLockPath),
          componentArtifacts: relativeRepo(artifactSetPath),
          sourceChecksums: relativeRepo(sourceChecksumsPath),
          sourceChecksumsSha256: sha256(sourceChecksums),
        },
        tools: {
          kubaraVersion: EXPECTED.kubaraVersion,
          kubaraBinarySha256: EXPECTED.kubaraBinarySha256,
          helmVersion,
          orasVersion: run("oras", ["version"]).split("\n")[0].trim(),
        },
        platform: {
          hub: "hx-app-dev",
          spokes: ["hx-app-staging", "hx-app-prod-a", "hx-app-prod-b"],
          enabledServices: Object.fromEntries(EXPECTED_ENABLED),
          renderCount: RENDER_CASES.length,
          renderArithmetic: "1 hub Argo + 2 shared services x 4 clusters + 4 additional hub services = 13",
        },
        catalogs: {
          parityReceipt: relativeRepo(parityReceiptPath),
          publicReferencesPreservedInSource: true,
          temporaryLocalSubstitutionOnly: true,
        },
        artifacts: artifactResults.map(({ path: _path, ...entry }) => entry),
        overrides: SOURCE_OVERRIDES.map((entry) => ({
          source: relativeRepo(entry.source),
          destination: relativeRepo(generatedValuesDir(generatedRoot, entry.cluster, entry.service)),
          sha256: sha256File(entry.source),
        })),
        outputs: {
          generatedRoot: relativeRepo(generatedRoot),
          generatedFileCount: listFiles(generatedRoot).length,
          generatedChecksums: relativeRepo(generatedChecksumsPath),
          generatedChecksumsSha256: sha256(generatedChecksums),
          effectiveRenderRoot: relativeRepo(renderRoot),
          effectiveRenderChecksums: relativeRepo(renderChecksumsPath),
          effectiveRenderChecksumsSha256: sha256(renderChecksums),
          renders: renderResults,
        },
        claimBoundary: [
          "Catalog parity is byte-for-byte generation evidence, not a live reconciliation claim.",
          "Effective renders are deterministic Helm desired state with exact chart archives; they are not workload-health evidence.",
          "The committed source retains Kubara's official OCI references; only clean temporary generation configs use the pinned local catalog trees.",
        ],
      },
      status: {
        result: "offline-generation-and-render-pass",
        kubaraGeneration: "pass",
        catalogParity: "pass",
        exactArtifactVerification: "pass",
        deterministicDoubleRender: "pass",
        liveReconciliation: "not-observed-by-this-receipt",
      },
    });
    write(readmePath, renderReadme(helmVersion));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verify() {
  verifySourceContract();
  for (const path of [
    generatedRoot,
    renderRoot,
    sourceChecksumsPath,
    generatedChecksumsPath,
    renderChecksumsPath,
    parityReceiptPath,
    generationReceiptPath,
    readmePath,
  ]) check(existsSync(path), `${relativeRepo(path)} is missing; run --generate`);

  const sourceChecksums = buildSourceChecksums();
  const generatedChecksums = buildTreeChecksums(generatedRoot);
  const renderChecksums = buildTreeChecksums(renderRoot);
  check(readFileSync(sourceChecksumsPath, "utf8") === sourceChecksums, "current example source checksums are stale");
  check(readFileSync(generatedChecksumsPath, "utf8") === generatedChecksums, "current example generated checksums are stale");
  check(readFileSync(renderChecksumsPath, "utf8") === renderChecksums, "current example effective-render checksums are stale");

  const parityReceipt = readYaml(parityReceiptPath);
  check(parityReceipt.kind === "KubaraCatalogGenerationParityReceipt", "catalog parity receipt kind changed");
  check(parityReceipt.status?.result === "pass", "catalog parity receipt must remain pass");
  check(parityReceipt.status?.sourceCatalogTrees === "byte-for-byte-equal", "catalog source trees are not recorded equal");
  check(parityReceipt.status?.generatedTrees === "byte-for-byte-equal", "generated trees are not recorded equal");
  check(parityReceipt.spec?.comparison?.differences?.length === 0, "catalog parity receipt contains differences");
  check(parityReceipt.spec?.comparison?.fileCount === listFiles(generatedRoot).length, "catalog parity file count changed");
  check(parityReceipt.spec?.comparison?.outputTreeSha256 === sha256(generatedChecksums), "catalog parity generated digest changed");
  check(parityReceipt.spec?.sourceConfig?.sha256 === sha256File(configPath), "catalog parity source config digest changed");
  for (const lane of parityReceipt.spec?.lanes ?? []) {
    check(lane.outputTreeSha256 === sha256(generatedChecksums), `${lane.name} output digest changed`);
    check(lane.catalogTreeSha256 === treeDigest(join(repoRoot, lane.catalogRoot)), `${lane.name} catalog digest changed`);
  }
  check((parityReceipt.spec?.lanes ?? []).length === 2, "catalog parity must contain two lanes");
  check(parityReceipt.spec.lanes[0]?.name === "kubara-release-snapshot", "first catalog parity lane changed");
  check(parityReceipt.spec.lanes[0]?.catalogRoot === relativeRepo(releaseCatalogRoot), "release catalog parity path changed");
  check(parityReceipt.spec.lanes[1]?.name === "confighub-aligned-export", "second catalog parity lane changed");
  check(parityReceipt.spec.lanes[1]?.catalogRoot === relativeRepo(alignedCatalogRoot), "aligned catalog parity path changed");

  const receipt = readYaml(generationReceiptPath);
  check(receipt.kind === "KubaraCurrentPlatformGenerationReceipt", "generation receipt kind changed");
  check(receipt.status?.result === "offline-generation-and-render-pass", "current example generation result must stay pass");
  check(receipt.status?.liveReconciliation === "not-observed-by-this-receipt", "offline receipt overstates live evidence");
  check(receipt.spec?.source?.sourceChecksumsSha256 === sha256(sourceChecksums), "source checksum receipt changed");
  check(receipt.spec?.outputs?.generatedChecksumsSha256 === sha256(generatedChecksums), "generated checksum receipt changed");
  check(receipt.spec?.outputs?.effectiveRenderChecksumsSha256 === sha256(renderChecksums), "render checksum receipt changed");
  check(receipt.spec?.platform?.renderCount === RENDER_CASES.length, "effective render count changed");

  const artifactSet = readYaml(artifactSetPath).spec?.artifacts ?? [];
  const artifactReceipts = receipt.spec?.artifacts ?? [];
  check(artifactReceipts.length === EXPECTED_ARTIFACTS.length, "exact artifact receipt count changed");
  for (const expectedArtifact of EXPECTED_ARTIFACTS) {
    const locked = artifactSet.find((entry) => entry.service === expectedArtifact.service && canonicalChartName(entry) === expectedArtifact.dependency);
    const recorded = artifactReceipts.find((entry) => entry.service === expectedArtifact.service && entry.dependency === expectedArtifact.dependency);
    check(locked?.sha256 === expectedArtifact.sha256, `${expectedArtifact.service}/${expectedArtifact.dependency} lock SHA changed`);
    check(recorded?.sha256 === expectedArtifact.sha256, `${expectedArtifact.service}/${expectedArtifact.dependency} verified SHA changed`);
    check(recorded?.result === "verified", `${expectedArtifact.service}/${expectedArtifact.dependency} is not recorded verified`);
    check(recorded?.sourceURL === locked.url, `${expectedArtifact.service}/${expectedArtifact.dependency} source URL changed`);
    if (expectedArtifact.manifestDigest) check(recorded?.manifestDigest === expectedArtifact.manifestDigest, "Traefik OCI manifest digest changed");
  }

  const renderReceipts = receipt.spec?.outputs?.renders ?? [];
  check(renderReceipts.length === RENDER_CASES.length, `expected ${RENDER_CASES.length} render receipts`);
  for (const expectedCase of RENDER_CASES) {
    const entry = renderReceipts.find((item) => item.cluster === expectedCase.cluster && item.service === expectedCase.service);
    check(entry, `missing render receipt for ${expectedCase.cluster}/${expectedCase.service}`);
    const output = join(repoRoot, entry.output);
    check(existsSync(output), `${entry.output} is missing`);
    const text = readFileSync(output, "utf8");
    const docs = kubernetesDocs(text);
    check(sha256(text) === entry.sha256, `${entry.output} SHA changed`);
    check(docs.length === entry.objectCount, `${entry.output} object count changed`);
    check(sameCounts(countKinds(docs), entry.kinds), `${entry.output} kind inventory changed`);
    check(entry.deterministicDoubleRender === true, `${entry.output} lacks a double-render assertion`);
    check(!portableViolation(text), `${entry.output} contains a workstation path, credential sentinel, or unresolved placeholder`);
    assertNoCredentialMaterial(docs, entry.output);
  }

  verifyArgoRepositoryAuthorization();
  verifyOverrideCopies();
  verifyPortableGeneratedTree();
  check(readFileSync(readmePath, "utf8") === renderReadme(receipt.spec?.tools?.helmVersion ?? "unknown"), "current example README is stale");
  console.log(
    `verified Kubara ${EXPECTED.kubaraVersion} current platform offline: 2 catalog lanes, 4 clusters, ${EXPECTED_ARTIFACTS.length} exact artifacts, ${RENDER_CASES.length} deterministic renders`,
  );
}

function verifySourceContract() {
  for (const path of [configPath, artifactSetPath, sourceLockPath, releaseCatalogRoot, alignedCatalogRoot, ...SOURCE_OVERRIDES.map((entry) => entry.source)]) {
    check(existsSync(path), `missing current example input: ${relativeRepo(path)}`);
  }
  const lock = readYaml(sourceLockPath);
  check(lock.spec?.kubara?.version === EXPECTED.kubaraVersion, "Kubara source-lock version changed");
  check(lock.spec?.kubara?.commit === EXPECTED.kubaraCommit, "Kubara source-lock commit changed");
  check(lock.spec?.kubara?.release?.extractedBinarySha256 === EXPECTED.kubaraBinarySha256, "Kubara binary SHA lock changed");
  check(lock.spec?.catalogs?.version === EXPECTED.catalogVersion, "Kubara catalog version changed");
  check(lock.spec?.catalogs?.commit === EXPECTED.catalogCommit, "Kubara catalog commit changed");
  check(lock.spec?.catalogs?.pinnedSnapshot === relativeRepo(releaseCatalogRoot), "pinned catalog path changed");
  check(lock.spec?.catalogs?.alignedExport === relativeRepo(alignedCatalogRoot), "aligned catalog path changed");
  check(String(lock.spec?.generation?.helmKubeVersion) === EXPECTED.kubeVersion, "Helm Kubernetes version changed");
  check(treeIndex(releaseCatalogRoot) === treeIndex(alignedCatalogRoot), "pinned Kubara catalog and ConfigHub-aligned export differ");

  const configText = readFileSync(configPath, "utf8");
  const config = readYaml(configPath);
  check(config.version === "v1alpha4", "current Kubara config must remain v1alpha4");
  check(config.bootstrapCatalog === EXPECTED.bootstrapReference, "committed config must retain the official bootstrap OCI reference");
  check(JSON.stringify(config.clusters?.map((cluster) => cluster.name)) === JSON.stringify(EXPECTED.clusters), "current Kubara cluster order or names changed");
  check(config.clusters?.filter((cluster) => cluster.type === "hub").length === 1, "current Kubara config must have one hub");
  check(config.clusters?.filter((cluster) => cluster.type === "spoke").length === 3, "current Kubara config must have three spokes");
  for (const cluster of config.clusters ?? []) {
    check(JSON.stringify(cluster.catalogs) === JSON.stringify([EXPECTED.generalReference]), `${cluster.name} must retain the official general catalog OCI reference`);
    check(cluster.argocd?.repo?.https?.configs?.url === EXPECTED.repoURL, `${cluster.name} config repository changed`);
    check(cluster.argocd?.repo?.https?.components?.url === EXPECTED.repoURL, `${cluster.name} component repository changed`);
    check(cluster.argocd?.repo?.https?.configs?.targetRevision === "main", `${cluster.name} config revision changed`);
    check(cluster.argocd?.repo?.https?.components?.targetRevision === "main", `${cluster.name} component revision changed`);
    check(JSON.stringify(Object.keys(cluster.services ?? {}).sort()) === JSON.stringify([...SERVICE_KEYS].sort()), `${cluster.name} service selection is not explicit`);
    const enabled = Object.entries(cluster.services ?? {}).filter(([, value]) => value.status === "enabled").map(([name]) => name).sort();
    check(JSON.stringify(enabled) === JSON.stringify([...EXPECTED_ENABLED.get(cluster.name)].sort()), `${cluster.name} enabled-service set changed`);
    check(Object.entries(cluster.services).every(([name, value]) => value.status === (EXPECTED_ENABLED.get(cluster.name).includes(name) ? "enabled" : "disabled")), `${cluster.name} contains an ambiguous service status`);
    const expectedTraefik = KIND_TRAEFIK.get(cluster.name);
    check(expectedTraefik, `${cluster.name} has no local-kind Traefik exposure contract`);
    check(
      expectedTraefik.httpNodePort === expectedTraefik.reservedArgocdServerNodePort + 2,
      `${cluster.name} Traefik HTTP NodePort overlaps cub's argocd-server reservation`,
    );
    check(cluster.dnsName === expectedTraefik.hostname, `${cluster.name} Traefik status hostname differs from config.yaml dnsName`);
    const traefikValuesPath = join(sourceRoot, "overrides", cluster.name, "helm", "traefik", "values-kind.yaml");
    const traefikValues = readYaml(traefikValuesPath).traefik;
    check(traefikValues?.service?.spec?.type === "NodePort", `${cluster.name} kind Traefik Service must use NodePort`);
    check(traefikValues?.ports?.web?.nodePort === expectedTraefik.httpNodePort, `${cluster.name} Traefik HTTP NodePort changed`);
    check(traefikValues?.ports?.websecure?.nodePort === expectedTraefik.httpsNodePort, `${cluster.name} Traefik HTTPS NodePort changed`);
    check(traefikValues?.providers?.kubernetesIngress?.publishedService?.enabled === false, `${cluster.name} Traefik publishedService must be disabled on kind`);
    check(traefikValues?.providers?.kubernetesIngress?.ingressEndpoint?.hostname === expectedTraefik.hostname, `${cluster.name} Traefik ingress hostname changed`);
  }
  check(config.clusters[0].argocd.selfManaged === "enabled", "hub self-managed Argo must remain enabled");
  check(config.clusters.slice(1).every((cluster) => cluster.argocd.selfManaged === "disabled"), "spoke self-managed Argo must remain disabled");
  check(configText.includes(EXPECTED.bootstrapReference) && configText.includes(EXPECTED.generalReference), "official catalog references disappeared from source config text");

  const artifactSet = readYaml(artifactSetPath);
  check(artifactSet.spec?.exactVersionPolicy === "fail-if-missing", "artifact policy must fail if an exact version is missing");
  check(artifactSet.spec?.retentionPolicy === "additive-only", "artifact retention must remain additive-only");
  check((artifactSet.spec?.artifacts ?? []).length === EXPECTED_ARTIFACTS.length, "selected artifact count changed");
  for (const expectedArtifact of EXPECTED_ARTIFACTS) {
    const entry = artifactSet.spec.artifacts.find((item) => item.service === expectedArtifact.service && canonicalChartName(item) === expectedArtifact.dependency);
    check(entry, `missing artifact lock for ${expectedArtifact.service}/${expectedArtifact.dependency}`);
    check(String(entry.wrapperVersion) === expectedArtifact.wrapperVersion, `${expectedArtifact.service} wrapper version changed`);
    check(String(entry.version) === expectedArtifact.version, `${expectedArtifact.service}/${expectedArtifact.dependency} version changed`);
    check(entry.url === expectedArtifact.url, `${expectedArtifact.service}/${expectedArtifact.dependency} exact source URL changed`);
    check(entry.sha256 === expectedArtifact.sha256, `${expectedArtifact.service}/${expectedArtifact.dependency} SHA changed`);
    check(entry.manifestDigest === expectedArtifact.manifestDigest, `${expectedArtifact.service}/${expectedArtifact.dependency} OCI manifest lock changed`);
  }
  const firstParty = artifactSet.spec?.firstParty ?? [];
  check(firstParty.find((entry) => entry.service === "homer-dashboard")?.wrapperVersion === "0.1.0", "Homer wrapper version changed");
  check(firstParty.find((entry) => entry.service === "shared-template-library")?.wrapperVersion === "0.2.0", "template-library version changed");
  verifyWrapperDependencies(releaseCatalogRoot, artifactSet);
  verifyWrapperDependencies(alignedCatalogRoot, artifactSet);
}

function generateLane(kubaraBin, name, catalogRoot, laneRoot) {
  mkdirSync(laneRoot, { recursive: true });
  const config = readYaml(configPath);
  config.bootstrapCatalog = join(catalogRoot, "bootstrap");
  for (const cluster of config.clusters) cluster.catalogs = [join(catalogRoot, "general")];
  writeFileSync(join(laneRoot, "config.yaml"), `${toYaml(config)}\n`);
  writeFileSync(
    join(laneRoot, ".env"),
    [
      'PROJECT_NAME="hx-app-dev"',
      'PROJECT_STAGE="dev"',
      'ARGOCD_WIZARD_ACCOUNT_PASSWORD="offline-generation-sentinel"',
      `ARGOCD_GIT_HTTPS_URL="${EXPECTED.repoURL}"`,
      'ARGOCD_GIT_USERNAME=""',
      'ARGOCD_GIT_PAT_OR_PASSWORD=""',
      'ARGOCD_HELM_REPO_USERNAME=""',
      'ARGOCD_HELM_REPO_PASSWORD=""',
      'ARGOCD_HELM_REPO_URL=""',
      'DOCKERCONFIG_BASE64=""',
      "",
    ].join("\n"),
  );
  run(kubaraBin, ["--work-dir", laneRoot, "--config-file", "config.yaml", "--env-file", ".env", "generate", "--helm"], { inherit: true });
  const generated = join(laneRoot, "generated");
  mkdirSync(generated, { recursive: true });
  cpSync(join(laneRoot, "platform-components"), join(generated, "platform-components"), { recursive: true });
  cpSync(join(laneRoot, "platform-configs"), join(generated, "platform-configs"), { recursive: true });
  for (const entry of SOURCE_OVERRIDES) {
    const destinationDir = join(generated, generatedValuesDir("", entry.cluster, entry.service));
    mkdirSync(destinationDir, { recursive: true });
    cpSync(entry.source, join(destinationDir, basename(entry.source)));
  }
  check(!listFiles(generated).some((path) => basename(path) === ".env"), `${name} copied its temporary credential file`);
  return { name, generated };
}

function materializeArtifacts(artifactRoot) {
  mkdirSync(artifactRoot, { recursive: true });
  const artifactSet = readYaml(artifactSetPath);
  const results = [];
  for (const entry of artifactSet.spec?.artifacts ?? []) {
    const dependency = canonicalChartName(entry);
    let archivePath;
    let resolvedManifest;
    if (entry.url.startsWith("oci://")) {
      const reference = entry.url.slice("oci://".length);
      resolvedManifest = run("oras", ["resolve", reference]).trim();
      check(resolvedManifest === entry.manifestDigest, `${entry.service}/${dependency} OCI manifest digest changed: ${resolvedManifest}`);
      const destination = join(artifactRoot, `${entry.service}-${dependency}`);
      mkdirSync(destination, { recursive: true });
      run("helm", ["pull", entry.url, "--destination", destination], { inherit: true });
      const archives = listFiles(destination).filter((path) => path.endsWith(".tgz"));
      check(archives.length === 1, `${entry.service}/${dependency} OCI pull returned ${archives.length} archives`);
      [archivePath] = archives;
    } else {
      archivePath = join(artifactRoot, `${entry.service}-${dependency}-${entry.version}.tgz`);
      run("curl", ["--fail", "--location", "--retry", "3", "--output", archivePath, entry.url], { inherit: true });
    }
    check(sha256File(archivePath) === entry.sha256, `${entry.service}/${dependency} archive SHA-256 changed`);
    results.push({
      service: entry.service,
      dependency,
      version: String(entry.version),
      sourceURL: entry.url,
      sha256: entry.sha256,
      manifestDigest: resolvedManifest,
      result: "verified",
      path: archivePath,
    });
  }
  return results;
}

function renderAll(stagedGenerated, artifacts, outputRoot) {
  const tempComponents = join(dirname(outputRoot), "render-components");
  cpSync(join(stagedGenerated, "platform-components", "helm"), tempComponents, { recursive: true });
  const templateLibrary = join(tempComponents, "template-library");
  check(existsSync(templateLibrary), "generated template-library component is missing");

  for (const service of [...new Set(RENDER_CASES.map((entry) => entry.service))]) {
    const chartRoot = join(tempComponents, service);
    check(existsSync(join(chartRoot, "Chart.yaml")), `generated wrapper is missing for ${service}`);
    const chartsRoot = join(chartRoot, "charts");
    rmSync(chartsRoot, { recursive: true, force: true });
    mkdirSync(chartsRoot, { recursive: true });
    cpSync(templateLibrary, join(chartsRoot, "template-library"), { recursive: true });
    for (const entry of artifacts.filter((item) => item.service === service)) {
      cpSync(entry.path, join(chartsRoot, basename(entry.path)));
    }
  }

  const results = [];
  for (const item of RENDER_CASES) {
    const chartRoot = join(tempComponents, item.service);
    const valuesRoot = join(stagedGenerated, generatedValuesDir("", item.cluster, item.service));
    const values = listFiles(valuesRoot)
      .filter((path) => /^values(?:-|\.)[^/]*\.ya?ml$/.test(basename(path)))
      .sort((left, right) => valuesOrder(left) - valuesOrder(right) || basename(left).localeCompare(basename(right)));
    check(values.some((path) => basename(path) === "values.generated.yaml"), `${item.cluster}/${item.service} has no generated values`);
    const args = [
      "template",
      item.service,
      chartRoot,
      "--namespace",
      item.namespace,
      "--kube-version",
      EXPECTED.kubeVersion,
      "--include-crds",
      "--skip-tests",
    ];
    for (const apiVersion of API_VERSIONS) args.push("--api-versions", apiVersion);
    for (const valuePath of values) args.push("--values", valuePath);
    const first = normalizeYaml(run("helm", args));
    const second = normalizeYaml(run("helm", args));
    check(first === second, `${item.cluster}/${item.service} is not byte-identical across two Helm renders`);
    check(
      !portableViolation(first),
      `${item.cluster}/${item.service} render contains a workstation path, credential sentinel, or unresolved placeholder: ${portabilityFindings(first).join(", ")}`,
    );
    const docs = kubernetesDocs(first);
    assertNoCredentialMaterial(docs, `${item.cluster}/${item.service} render`);
    const output = join(outputRoot, item.cluster, item.service, "release-objects.yaml");
    write(output, first);
    results.push({
      cluster: item.cluster,
      service: item.service,
      releaseName: item.service,
      namespace: item.namespace,
      values: values.map((path) => relative(stagedGenerated, path).replaceAll("\\", "/")),
      output: [relativeRepo(renderRoot), item.cluster, item.service, "release-objects.yaml"].join("/"),
      sha256: sha256(first),
      objectCount: docs.length,
      kinds: countKinds(docs),
      deterministicDoubleRender: true,
      exactArtifacts: artifacts.filter((entry) => entry.service === item.service).map((entry) => ({
        dependency: entry.dependency,
        version: entry.version,
        sha256: entry.sha256,
      })),
    });
  }
  return results;
}

function verifyWrapperDependencies(catalogRoot, artifactSet) {
  const roots = [join(catalogRoot, "bootstrap", "platform-components", "helm"), join(catalogRoot, "general", "platform-components", "helm")];
  for (const service of [...new Set(RENDER_CASES.map((entry) => entry.service))]) {
    const chartPath = roots.map((root) => join(root, service, "Chart.yaml")).find(existsSync);
    check(chartPath, `${relativeRepo(catalogRoot)} has no ${service} wrapper`);
    const chart = readYaml(chartPath);
    const expectedArtifacts = (artifactSet.spec?.artifacts ?? []).filter((entry) => entry.service === service);
    const expectedFirstParty = (artifactSet.spec?.firstParty ?? []).find((entry) => entry.service === service);
    const expectedWrapper = expectedArtifacts[0]?.wrapperVersion ?? expectedFirstParty?.wrapperVersion;
    check(String(chart.version) === String(expectedWrapper), `${service} wrapper Chart version changed`);
    const remoteDependencies = (chart.dependencies ?? []).filter((dependency) => !String(dependency.repository).startsWith("file://"));
    check(remoteDependencies.length === expectedArtifacts.length, `${service} remote dependency count changed`);
    for (const dependency of remoteDependencies) {
      const entry = expectedArtifacts.find((candidate) => canonicalChartName(candidate) === dependency.name);
      check(entry, `${service}/${dependency.name} is not locked in component-artifacts.yaml`);
      check(String(dependency.version) === String(entry.version), `${service}/${dependency.name} Chart version differs from the artifact lock`);
    }
    const localDependencies = (chart.dependencies ?? []).filter((dependency) => String(dependency.repository).startsWith("file://"));
    check(localDependencies.every((dependency) => dependency.name === "template-library" && String(dependency.version) === "0.2.0"), `${service} local dependency changed`);
  }
}

function verifyArgoRepositoryAuthorization() {
  const argoPath = join(renderRoot, "hx-app-dev", "argo-cd", "release-objects.yaml");
  const docs = kubernetesDocs(readFileSync(argoPath, "utf8"));
  const project = docs.find((doc) => doc.kind === "AppProject" && doc.metadata?.name === "hx-app-dev-dev");
  check(project, "rendered hub AppProject hx-app-dev-dev is missing");
  check(project.spec?.sourceRepos?.includes(EXPECTED.repoURL), "hub AppProject does not authorize the configured Git repository");
  const appSets = docs.filter((doc) => doc.kind === "ApplicationSet");
  check(appSets.length > 0, "hub Argo render contains no ApplicationSets");
  for (const appSet of appSets) {
    const sources = appSet.spec?.template?.spec?.sources ?? [];
    check(sources.filter((source) => source.repoURL === EXPECTED.repoURL).length === 2, `${appSet.metadata.name} does not use the configured repository for both source lanes`);
  }
  const serialized = JSON.stringify(appSets);
  check(serialized.includes("examples/kubara/current-platform/generated/platform-components/helm"), "ApplicationSets do not use the committed current component path");
  check(serialized.includes("examples/kubara/current-platform/generated/platform-configs"), "ApplicationSets do not use the committed current config path");
}

function verifyOverrideCopies() {
  for (const entry of SOURCE_OVERRIDES) {
    const destination = join(generatedRoot, generatedValuesDir("", entry.cluster, entry.service), basename(entry.source));
    check(existsSync(destination), `missing generated override ${relativeRepo(destination)}`);
    check(readFileSync(destination, "utf8") === readFileSync(entry.source, "utf8"), `${relativeRepo(destination)} differs from its source override`);
  }
  const metricsRender = readFileSync(join(renderRoot, "hx-app-dev", "metrics-server", "release-objects.yaml"), "utf8");
  check(metricsRender.includes("--kubelet-insecure-tls"), "Metrics Server kind TLS override is absent from effective desired state");
  const homerRender = readFileSync(join(renderRoot, "hx-app-dev", "homer-dashboard", "release-objects.yaml"), "utf8");
  check(homerRender.includes("ConfigHub Catalog"), "Homer effective desired state omits the ConfigHub Catalog link");
  check(homerRender.includes("Platform contract and catalog composer"), "Homer effective desired state omits the Kubara link");
  for (const cluster of EXPECTED.clusters) {
    const certRender = readFileSync(join(renderRoot, cluster, "cert-manager", "release-objects.yaml"), "utf8");
    const issuers = kubernetesDocs(certRender).filter((doc) => doc.kind === "ClusterIssuer");
    check(issuers.length === 1, `${cluster} cert-manager render must contain exactly one ClusterIssuer`);
    check(issuers[0].metadata?.name === "selfsigned-root-issuer", `${cluster} does not use the deterministic kind issuer`);
    check(Boolean(issuers[0].spec?.selfSigned), `${cluster} kind issuer is not self-signed`);
    check(!issuers[0].spec?.acme, `${cluster} effective cert-manager desired state still uses public ACME`);
    const traefikRender = readFileSync(join(renderRoot, cluster, "traefik", "release-objects.yaml"), "utf8");
    assertKindTraefikRender(cluster, kubernetesDocs(traefikRender));
  }
}

function assertKindTraefikRender(cluster, docs) {
  const expected = KIND_TRAEFIK.get(cluster);
  check(expected, `${cluster} has no expected kind Traefik exposure`);
  const services = docs.filter((doc) => doc.kind === "Service" && doc.metadata?.namespace === "traefik" && doc.metadata?.name === "traefik");
  check(services.length === 1, `${cluster} must render exactly one traefik/traefik Service`);
  const service = services[0];
  check(service.spec?.type === "NodePort", `${cluster} Traefik effective Service is not NodePort`);
  check(service.spec?.loadBalancerClass === undefined, `${cluster} Traefik kind Service must not declare loadBalancerClass`);
  const web = (service.spec?.ports ?? []).find((port) => port.name === "web");
  const websecure = (service.spec?.ports ?? []).find((port) => port.name === "websecure");
  check(web?.port === 80 && web?.nodePort === expected.httpNodePort, `${cluster} Traefik web port is not 80:${expected.httpNodePort}`);
  check(websecure?.port === 443 && websecure?.nodePort === expected.httpsNodePort, `${cluster} Traefik websecure port is not 443:${expected.httpsNodePort}`);
  const deployments = docs.filter((doc) => doc.kind === "Deployment" && doc.metadata?.namespace === "traefik" && doc.metadata?.name === "traefik");
  check(deployments.length === 1, `${cluster} must render exactly one traefik/traefik Deployment`);
  const args = deployments[0].spec?.template?.spec?.containers?.find((container) => container.name === "traefik")?.args ?? [];
  check(args.includes(`--providers.kubernetesingress.ingressendpoint.hostname=${expected.hostname}`), `${cluster} Traefik does not publish the configured ingress hostname`);
  check(!args.some((arg) => String(arg).toLowerCase().includes("publishedservice")), `${cluster} Traefik still derives ingress status from a LoadBalancer Service`);
}

function verifyPortableGeneratedTree() {
  check(!listFiles(exampleRoot).some((path) => basename(path) === ".env"), "current example contains a committed .env file");
  const knownUpstreamPlaceholder = join(
    generatedRoot,
    "platform-configs",
    "hx-app-dev",
    "helm",
    "homer-dashboard",
    "values.generated.yaml",
  );
  for (const path of [...listFiles(generatedRoot), ...listFiles(renderRoot)]) {
    const contents = readFileSync(path);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    check(!text.includes("/Users/"), `${relativeRepo(path)} contains a workstation path`);
    check(!text.includes("helm-expt-kubara-current-"), `${relativeRepo(path)} contains a temporary path`);
    check(!text.includes("offline-generation-sentinel"), `${relativeRepo(path)} contains the temporary environment sentinel`);
    if (path === knownUpstreamPlaceholder) {
      check((text.match(/https:\/\/replace-me-with-your-url/g) ?? []).length === 1, "the known Kubara Homer placeholder changed shape");
      continue;
    }
    check(!/replace-me|CHANGE_ME|<\.\.\.|<(?:your|insert|placeholder|changeme|change-me)[^>]*>/i.test(text), `${relativeRepo(path)} contains an unresolved placeholder`);
  }
  check(existsSync(knownUpstreamPlaceholder), "expected Kubara-generated Homer values are missing");
  const effectiveHomer = readFileSync(join(renderRoot, "hx-app-dev", "homer-dashboard", "release-objects.yaml"), "utf8");
  check(!/replace-me|CHANGE_ME/i.test(effectiveHomer), "the source override did not eliminate Kubara's upstream Homer placeholder from effective desired state");
}

function assertNoCredentialMaterial(docs, label) {
  const sensitiveKey = /(?:^|[-_.])(password|passwd|token|private[-_.]?key|client[-_.]?secret)(?:$|[-_.])/i;
  for (const doc of docs.filter((item) => item.kind === "Secret")) {
    for (const [key, value] of Object.entries({ ...(doc.data ?? {}), ...(doc.stringData ?? {}) })) {
      check(!(sensitiveKey.test(key) && String(value).length > 0), `${label} contains credential material in Secret ${doc.metadata?.name}/${key}`);
    }
  }
}

function buildSourceChecksums() {
  const paths = new Set([configPath, artifactSetPath, sourceLockPath, scriptPath, ...SOURCE_OVERRIDES.map((entry) => entry.source)]);
  for (const path of listFiles(releaseCatalogRoot)) paths.add(path);
  for (const path of listFiles(alignedCatalogRoot)) paths.add(path);
  return [...paths]
    .sort((left, right) => relativeRepo(left).localeCompare(relativeRepo(right)))
    .map((path) => `${sha256File(path)}  ${relativeRepo(path)}`)
    .join("\n") + "\n";
}

function buildTreeChecksums(root) {
  return listFiles(root)
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
    .map((path) => `${sha256File(path)}  ${relative(root, path).replaceAll("\\", "/")}`)
    .join("\n") + "\n";
}

function treeIndex(root) {
  return buildTreeChecksums(root);
}

function treeDigest(root) {
  return sha256(treeIndex(root));
}

function compareTrees(leftRoot, rightRoot) {
  const left = new Map(listFiles(leftRoot).map((path) => [relative(leftRoot, path).replaceAll("\\", "/"), sha256File(path)]));
  const right = new Map(listFiles(rightRoot).map((path) => [relative(rightRoot, path).replaceAll("\\", "/"), sha256File(path)]));
  const differences = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (!left.has(path)) differences.push(`only aligned export generated ${path}`);
    else if (!right.has(path)) differences.push(`only Kubara snapshot generated ${path}`);
    else if (left.get(path) !== right.get(path)) differences.push(`content differs: ${path}`);
  }
  return { equal: differences.length === 0, differences };
}

function replaceDirectory(destination, source) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function generatedValuesDir(prefix, cluster, service) {
  return join(prefix, "platform-configs", cluster, "helm", service);
}

function laneReceipt(name, catalogRoot, catalogTreeSha256, outputTreeSha256, generated) {
  return {
    name,
    catalogRoot: relativeRepo(catalogRoot),
    catalogTreeSha256,
    generatedFileCount: listFiles(generated).length,
    outputTreeSha256,
  };
}

function artifact(service, dependency, wrapperVersion, version, url, digest, manifestDigest = undefined) {
  return { service, dependency, wrapperVersion, version, url, sha256: digest, manifestDigest };
}

function renderCase(cluster, service, namespace) {
  return { cluster, service, namespace };
}

function canonicalChartName(entry) {
  return String(entry.canonicalIdentity ?? "").split("/").at(-1);
}

function valuesOrder(path) {
  const name = basename(path);
  if (name === "values.generated.yaml") return 0;
  if (name === "additional-values.yaml") return 1;
  return 2;
}

function kubernetesDocs(text) {
  return parseDocs(text).filter((doc) => doc?.apiVersion && doc?.kind && doc?.metadata?.name);
}

function countKinds(docs) {
  return Object.fromEntries(
    [...docs.reduce((counts, doc) => counts.set(doc.kind, (counts.get(doc.kind) ?? 0) + 1), new Map()).entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameCounts(left, right) {
  const keys = [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
  return keys.every((key) => left?.[key] === right?.[key]);
}

function portableViolation(text) {
  return portabilityFindings(text).length > 0;
}

function portabilityFindings(text) {
  const patterns = [
    ["workstation-path", /\/Users\//i],
    ["temporary-path", /helm-expt-kubara-current-/i],
    ["temporary-credential-sentinel", /offline-generation-sentinel/i],
    ["replace-me", /replace-me/i],
    ["change-me", /CHANGE_ME/i],
    ["ellipsis-placeholder", /<\.\.\./i],
    ["angle-placeholder", /<(?:your|insert|placeholder|changeme|change-me)[^>]*>/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 400,
    env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
  }) ?? "";
}

function relativeRepo(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function renderReadme(helmVersion) {
  return `# Kubara v0.13.0 four-cluster platform

This is the current, reproducible Kubara + ConfigHub mini-IDP source. Kubara
still owns the familiar platform selection and wiring model. ConfigHub reviews
and retains the exact component versions, configuration variants, change
history, and fleet state. Argo CD remains the small local reconciler in the hub.

The committed \`source/config.yaml\` deliberately retains Kubara's official
\`bootstrap:1.1.0\` and \`general:1.1.0\` OCI references. The generator rewrites
only clean temporary copies to two pinned local catalogs:

1. Kubara's immutable 1.1.0 release snapshot.
2. The ConfigHub-aligned, byte-preserving export of that snapshot.

Kubara v0.13.0 must generate the same paths and bytes from both. The
[catalog parity receipt](catalog-parity-receipt.yaml) binds that claim to every
generated file; no AI translation is part of the required path.

## Platform shape

| Cluster | Kubara role | Enabled platform services |
| --- | --- | --- |
| \`hx-app-dev\` | hub | Argo CD, cert-manager, External Secrets, Homer, kube-prometheus-stack, Metrics Server, Traefik |
| \`hx-app-staging\` | spoke | cert-manager, Traefik |
| \`hx-app-prod-a\` | spoke | cert-manager, Traefik |
| \`hx-app-prod-b\` | spoke | cert-manager, Traefik |

That is 13 deterministic service renders: one hub Argo render, cert-manager and
Traefik on four clusters, and four additional services on the hub. The rendered
objects are desired-state evidence, not a claim that a live cluster reconciled
them.

## Why the normal values overrides exist

- \`overrides/hx-app-dev/helm/argo-cd/values-repository-paths.yaml\` points ApplicationSets at this committed
  example and explicitly allows \`https://github.com/confighub/helm-expt.git\`
  in the \`hx-app-dev-dev\` AppProject. Kubara 1.1.0's generated project only
  adds \`argocd.helmRepo.url\`; this example uses Git for both source lanes, so
  the explicit \`sourceRepos\` entry is required or Argo CD rejects them.
- \`overrides/hx-app-dev/helm/homer-dashboard/values-project-links.yaml\` replaces the catalog's illustrative Secrets
  Manager URL with working Kubara and ConfigHub links.
- Each cluster's \`helm/cert-manager/values-kind.yaml\` selects a deterministic
  self-signed issuer for the local proof instead of contacting public ACME.
- \`overrides/hx-app-dev/helm/metrics-server/values-kind.yaml\` records the local-kind kubelet TLS
  departure rather than hiding it in a one-off command.
- Each cluster's \`helm/traefik/values-kind.yaml\` leaves the first mapped port in
  cub's NodePort window reserved for \`argocd-server\`, uses a separate HTTP/HTTPS
  pair two slots later, and publishes that cluster's existing \`dnsName\` into Ingress status.
  This makes the local apps reachable and keeps standard Argo health honest
  without adding a load-balancer controller. Production targets omit this
  kind-only override and retain their normal LoadBalancer configuration.

| Cluster | Reserved for Argo CD | Traefik HTTP | Traefik HTTPS | Ingress status hostname |
| --- | ---: | ---: | ---: | --- |
| \`hx-app-dev\` | 30000 | 30002 | 30003 | \`hx-app-dev.traefik.me\` |
| \`hx-app-staging\` | 30010 | 30012 | 30013 | \`hx-app-staging.traefik.me\` |
| \`hx-app-prod-a\` | 30020 | 30022 | 30023 | \`hx-app-prod-a.traefik.me\` |
| \`hx-app-prod-b\` | 30030 | 30032 | 30033 | \`hx-app-prod-b.traefik.me\` |

The mini-IDP preflight must reserve and verify these four cub port windows
before publishing the target-specific releases. For example, after
reconciliation:

~~~sh
curl -H 'Host: hx-web.local' http://127.0.0.1:30002/
curl --insecure --resolve cubbychat.local:30003:127.0.0.1 \\
  https://cubbychat.local:30003/
~~~

Use each cluster's corresponding port pair. \`--insecure\` is appropriate only
for this explicitly self-signed local proof.

\`source/overrides/<cluster>/helm/<service>/\` is the single canonical override
input hierarchy. The generator copies those files beside \`values.generated.yaml\`, exactly where
Kubara and Argo CD already load \`values-*.yaml\` customizations.

## Reproduce, in order

1. Verify or regenerate the byte-preserving catalog adapter:

   ~~~sh
   npm run kubara-catalog-adapter:verify
   ~~~

2. Download Kubara v0.13.0 for your platform. Verify its release archive and
   extracted binary against [source-lock.yaml](source-lock.yaml).

3. Generate both catalog lanes, fetch every exact chart archive, verify all
   seven SHA-256 locks (and the Traefik OCI manifest digest), and render the
   full four-cluster selection twice:

   ~~~sh
   KUBARA_BIN=/absolute/path/to/kubara \\
     node scripts/generate-kubara-current-example.mjs --generate
   ~~~

4. Run the network-free verifier:

   ~~~sh
   node scripts/generate-kubara-current-example.mjs --verify
   ~~~

Generation needs Kubara, Helm, curl, oras, and network access. Verification
needs none of the release binary, Helm, registry, catalog OCI endpoints, chart
repositories, or clusters. It validates the pinned catalog trees, official
references, four-cluster selection, exact dependency versions, every source and
output checksum, both parity lanes, AppProject source authorization, and all 13
effective renders. The recorded generation used ${helmVersion}.

The one illustrative URL still present in Kubara's raw generated Homer values
is preserved as upstream output and byte-covered by the parity receipt. The
normal values override replaces it, and the effective render verifier rejects
that placeholder (as well as credential material and workstation paths).
`;
}
