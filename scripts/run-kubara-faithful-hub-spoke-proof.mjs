#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  check,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  sha256File,
  toYaml,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const allowedModes = new Set(["--rehearse", "--run", "--generate", "--verify"]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-kubara-faithful-hub-spoke-proof.mjs --rehearse
  node scripts/run-kubara-faithful-hub-spoke-proof.mjs --run
  node scripts/run-kubara-faithful-hub-spoke-proof.mjs --generate
  node scripts/run-kubara-faithful-hub-spoke-proof.mjs --verify`);
  process.exit(2);
}

const expected = {
  kubaraVersion: "v0.13.0",
  catalogVersion: "1.1.0",
  hubLogicalName: "hx-app-dev",
  hubStage: "dev",
  spokeLogicalName: "hx-app-staging",
  spokeStage: "staging",
  selectedComponent: "cert-manager",
  selectedComponentVersion: "v1.21.0",
  projectName: "hx-app-dev-dev",
  organization: "Kubara",
  controlSpace: "hx-platform",
  planUnit: "faithful-hub-spoke-plan",
  attestationUnit: "faithful-hub-spoke-attestation",
  hubKindCluster: "hx-kubara-faithful-hub",
  spokeKindCluster: "hx-kubara-faithful-spoke",
  openBaoChartVersion: "0.28.3",
  openBaoChartUrl:
    "https://github.com/openbao/openbao-helm/releases/download/openbao-0.28.3/openbao-0.28.3.tgz",
  openBaoChartSha256:
    "8612ab52ca1383b61dbf54c0a40691aaeba2bb9f4e542134c9ad06fce15a907c",
  openBaoNamespace: "openbao",
  openBaoPod: "openbao-0",
  externalSecretsRole: "any-sa",
  externalSecretsPolicy: "read-access",
};

const exampleRoot = join(repoRoot, "examples", "kubara", "current-platform");
const sourceRoot = join(exampleRoot, "source");
const sourceConfigPath = join(sourceRoot, "config.yaml");
const sourceLockPath = join(exampleRoot, "source-lock.yaml");
const componentArtifactsPath = join(exampleRoot, "component-artifacts.yaml");
const committedGeneratedRoot = join(exampleRoot, "generated");
const catalogSnapshotRoot = join(
  repoRoot,
  "data",
  "kubara-catalog-snapshots",
  "kubara-catalogs-1.1.0-release",
  "source",
);
const bootstrapCatalogPath = join(catalogSnapshotRoot, "bootstrap");
const generalCatalogPath = join(catalogSnapshotRoot, "general");
const runRoot = join(repoRoot, "runs", "kubara-faithful-hub-spoke");
const receiptPath = join(runRoot, "receipt.yaml");
const stagePath = join(runRoot, "stage.txt");
const failurePath = join(runRoot, "failure.yaml");
const attemptPath = join(runRoot, "attempt.yaml");
const dataRoot = join(repoRoot, "data", "kubara-faithful-hub-spoke");
const summaryYamlPath = join(dataRoot, "summary.yaml");
const summaryMarkdownPath = join(dataRoot, "summary.md");
const receiptSchemaPath = join(dataRoot, "receipt.schema.json");
const summarySchemaPath = join(dataRoot, "summary.schema.json");
const contextArgs = process.env.CUB_CONTEXT
  ? ["--context", process.env.CUB_CONTEXT]
  : [];
let activeAttempt = null;

if (mode === "--rehearse") {
  const prepared = prepareSource();
  try {
    console.log(renderRehearsal(prepared));
  } finally {
    rmSync(prepared.workRoot, { recursive: true, force: true });
  }
} else if (mode === "--run") {
  runLiveProof();
} else if (mode === "--generate") {
  const receipt = loadAndVerifyReceipt();
  writeSummaries(receipt);
} else {
  const receipt = loadAndVerifyReceipt();
  verifySummaries(receipt);
  console.log("verified the faithful Kubara v0.13 hub-and-spoke proof");
}

function prepareSource() {
  phase("source-preflight");
  for (const path of [
    sourceConfigPath,
    sourceLockPath,
    componentArtifactsPath,
    bootstrapCatalogPath,
    generalCatalogPath,
  ]) {
    check(existsSync(path), `missing faithful-lane input: ${relativeRepo(path)}`);
  }

  const sourceLock = readYaml(sourceLockPath);
  check(
    sourceLock.spec?.kubara?.version === expected.kubaraVersion,
    `expected Kubara ${expected.kubaraVersion}`,
  );
  check(
    String(sourceLock.spec?.catalogs?.version) === expected.catalogVersion,
    `expected Kubara catalogs ${expected.catalogVersion}`,
  );
  check(
    resolve(repoRoot, sourceLock.spec?.catalogs?.pinnedSnapshot ?? "")
      === catalogSnapshotRoot,
    "current example does not point at the release catalog snapshot",
  );
  const componentArtifacts = readYaml(componentArtifactsPath);
  const selectedArtifact = componentArtifacts.spec?.artifacts?.find(
    (artifact) => artifact.service === expected.selectedComponent,
  );
  check(
    selectedArtifact?.canonicalIdentity === "helm:jetstack/cert-manager"
      && selectedArtifact.version === expected.selectedComponentVersion
      && /^[a-f0-9]{64}$/.test(selectedArtifact.sha256 ?? ""),
    `current example does not lock ${expected.selectedComponent}@${expected.selectedComponentVersion}`,
  );

  const kubaraBin = resolveKubaraBinary();
  const binaryVersion = command(kubaraBin, ["--version"]).output.trim();
  check(
    binaryVersion === `kubara version ${expected.kubaraVersion}`,
    `expected Kubara ${expected.kubaraVersion}, found ${binaryVersion}`,
  );
  const binarySha256 = sha256File(kubaraBin);
  const lockedBinarySha256 = sourceLock.spec?.kubara?.release?.extractedBinarySha256;
  const lockedPlatform = sourceLock.spec?.kubara?.release?.platform;
  const currentPlatform = `${process.platform}-${process.arch}`;
  const releasePlatform = lockedPlatform === "darwin-arm64"
    ? "darwin-arm64"
    : lockedPlatform;
  if (releasePlatform === currentPlatform) {
    check(
      binarySha256 === lockedBinarySha256,
      "Kubara binary digest does not match the current example source lock",
    );
  }

  const sourceConfig = readYaml(sourceConfigPath);
  check(sourceConfig.version === "v1alpha4", "current Kubara config is not v1alpha4");
  const hub = sourceConfig.clusters?.find(
    (cluster) => cluster.name === expected.hubLogicalName,
  );
  const spoke = sourceConfig.clusters?.find(
    (cluster) => cluster.name === expected.spokeLogicalName,
  );
  check(hub?.type === "hub" && hub.stage === expected.hubStage, "faithful hub entry changed");
  check(
    hub.argocd?.selfManaged === "enabled",
    "faithful hub must retain Kubara's self-managed Argo CD topology",
  );
  check(
    spoke?.type === "spoke" && spoke.stage === expected.spokeStage,
    "faithful spoke entry changed",
  );
  check(
    spoke.argocd?.selfManaged === "disabled",
    "faithful spoke must remain managed by the hub Argo CD instance",
  );
  check(
    spoke.services?.[expected.selectedComponent]?.status === "enabled",
    `${expected.selectedComponent} must be enabled on ${expected.spokeLogicalName}`,
  );

  const componentsRepo = hub.argocd?.repo?.https?.components;
  const configsRepo = hub.argocd?.repo?.https?.configs;
  check(componentsRepo?.url && configsRepo?.url, "hub Git source URLs are missing");
  check(componentsRepo.url === configsRepo.url, "faithful lane requires one unchanged Git repository");
  check(
    componentsRepo.targetRevision === configsRepo.targetRevision,
    "faithful lane requires one unchanged Git revision",
  );
  check(
    spoke.argocd?.repo?.https?.components?.url === componentsRepo.url
      && spoke.argocd?.repo?.https?.configs?.url === configsRepo.url
      && spoke.argocd?.repo?.https?.components?.targetRevision
        === componentsRepo.targetRevision
      && spoke.argocd?.repo?.https?.configs?.targetRevision
        === configsRepo.targetRevision,
    "faithful spoke Git contract differs from the hub Git contract",
  );

  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-faithful-"));
  try {
    const workConfigPath = join(workRoot, "config.yaml");
    const workEnvPath = join(workRoot, ".env");
    const workGeneratedRoot = workRoot;
    const configForClusterAdd = structuredClone(sourceConfig);
    configForClusterAdd.bootstrapCatalog = bootstrapCatalogPath;
    configForClusterAdd.clusters = [structuredClone(hub)];
    configForClusterAdd.clusters[0].catalogs = [generalCatalogPath];
    writeFileSync(workConfigPath, `${toYaml(configForClusterAdd)}\n`);
    writeFileSync(workEnvPath, renderEnv(hub, componentsRepo.url), { mode: 0o600 });

    phase("kubara-cluster-add");
    const clusterAddArgs = [
      "--work-dir", workRoot,
      "--config-file", workConfigPath,
      "--env-file", workEnvPath,
      "--catalog", generalCatalogPath,
      "cluster", "add", expected.spokeLogicalName,
    ];
    command(kubaraBin, clusterAddArgs, { inherit: true });
    const afterClusterAdd = readYaml(workConfigPath);
    const addedSpoke = afterClusterAdd.clusters?.find(
      (cluster) => cluster.name === expected.spokeLogicalName,
    );
    check(addedSpoke?.type === "spoke", "kubara cluster add did not create a spoke");
    check(
      addedSpoke.catalogs?.length === 1
        && resolve(addedSpoke.catalogs[0]) === generalCatalogPath,
      "kubara cluster add did not persist its catalog choice",
    );

    const restoredConfig = structuredClone(sourceConfig);
    restoredConfig.bootstrapCatalog = bootstrapCatalogPath;
    for (const cluster of restoredConfig.clusters) cluster.catalogs = [generalCatalogPath];
    writeFileSync(workConfigPath, `${toYaml(restoredConfig)}\n`);

    phase("kubara-generate");
    command(kubaraBin, [
      "--work-dir", workRoot,
      "--config-file", workConfigPath,
      "--env-file", workEnvPath,
      "generate", "--helm",
    ], {
      inherit: true,
      timeout: 1_200_000,
      env: isolatedHelmEnv(workRoot),
    });
    copyOverrides(join(sourceRoot, "overrides"), join(workRoot, "platform-configs"));

    const temporaryGenerated = generatedEvidence(workGeneratedRoot);
    const committedGenerated = generatedEvidence(committedGeneratedRoot);
    compareTreeEvidence(
      temporaryGenerated,
      committedGenerated,
      "Kubara release-snapshot generation differs from the committed current example",
    );
    const selectedWrapperChart = readYaml(join(
      workRoot,
      "platform-components",
      "helm",
      expected.selectedComponent,
      "Chart.yaml",
    ));
    const selectedDependency = selectedWrapperChart.dependencies?.find(
      (dependency) => dependency.name === expected.selectedComponent,
    );
    check(
      selectedDependency?.version === expected.selectedComponentVersion,
      `generated ${expected.selectedComponent} wrapper does not use ${expected.selectedComponentVersion}`,
    );

    const sourceContract = inspectSourceContract(workRoot, hub);
    const remote = fetchAndVerifyRemoteGit({
      workRoot,
      repoURL: componentsRepo.url,
      targetRevision: componentsRepo.targetRevision,
      committedGenerated,
    });

    return {
      workRoot,
      kubaraBin,
      binarySha256,
      binaryDigestCheck:
        releasePlatform === currentPlatform ? "pass" : "version-only-cross-platform",
      sourceLock,
      sourceConfig,
      hub,
      spoke,
      clusterAdd: {
        command:
          "kubara --catalog <kubara-catalogs-1.1.0-release/general> cluster add hx-app-staging",
        result: "pass",
        createdType: addedSpoke.type,
        persistedCatalogChoice: true,
        sourceEntryRestoredBeforeGeneration: true,
      },
      generated: committedGenerated,
      sourceContract,
      remote,
    };
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

function runLiveProof() {
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_KUBARA_FAITHFUL === "1",
    "set HELM_EXPT_ALLOW_LIVE_KUBARA_FAITHFUL=1 to confirm this live proof",
  );
  mkdirSync(runRoot, { recursive: true });
  activeAttempt = beginLiveAttempt();
  let lockPath;
  let prepared;
  let baseline = null;
  const cleanup = {
    hubCluster: "not-created",
    spokeCluster: "not-created",
    baselineRestored: false,
    localFiles: "not-created",
    configHubAttestations: "retained-as-proof",
  };
  const state = { hubCreationAttempted: false, spokeCreationAttempted: false };
  let currentStage = "starting";
  let receipt;
  let failure;

  try {
    currentStage = "acquire-live-lock";
    phase(currentStage);
    lockPath = acquireLiveLock();

    baseline = kindClusters();
    assertNoForeignLiveParityProcess(baseline);
    assertKubaraOrganization();
    for (const owned of [expected.hubKindCluster, expected.spokeKindCluster]) {
      check(!baseline.includes(owned), `refusing to reuse non-fresh kind cluster ${owned}`);
    }

    prepared = prepareSource();
    cleanup.localFiles = "created";

    currentStage = "confighub-plan-check-and-approval";
    phase(currentStage);
    const planDocument = buildPlanDocument(prepared);
    const planApproval = upsertAndApproveAttestation({
      slug: expected.planUnit,
      role: "FaithfulLanePlan",
      proofPhase: "Plan",
      document: planDocument,
      sourceDigest: prepared.generated.sha256,
    });
    check(
      planApproval.approval.recordedApprovals > 0,
      "ConfigHub did not record the faithful-lane plan approval",
    );

    currentStage = "create-fresh-kind-clusters";
    phase(currentStage);
    const hubKubeconfig = join(prepared.workRoot, "hub.kubeconfig");
    const spokeHostKubeconfig = join(prepared.workRoot, "spoke-host.kubeconfig");
    state.hubCreationAttempted = true;
    command("kind", [
      "create", "cluster",
      "--name", expected.hubKindCluster,
      "--kubeconfig", hubKubeconfig,
      "--wait", "300s",
    ], { inherit: true, timeout: 600_000 });
    state.spokeCreationAttempted = true;
    command("kind", [
      "create", "cluster",
      "--name", expected.spokeKindCluster,
      "--kubeconfig", spokeHostKubeconfig,
      "--wait", "300s",
    ], { inherit: true, timeout: 600_000 });

    currentStage = "rewrite-spoke-kubeconfig";
    phase(currentStage);
    const spokeRoute = rewriteSpokeKubeconfig({
      workRoot: prepared.workRoot,
      hubKubeconfig,
      spokeHostKubeconfig,
    });

    currentStage = "openbao-secret-route";
    phase(currentStage);
    const openBao = installAndConfigureOpenBao({
      workRoot: prepared.workRoot,
      hubKubeconfig,
    });
    const secretRoute = storeSpokeKubeconfig({
      hubKubeconfig,
      spokeKubeconfigPath: spokeRoute.rewrittenPath,
    });

    currentStage = "kubara-bootstrap";
    phase(currentStage);
    checkRemoteRevisionStillPinned(prepared.remote);
    const clusterSecretStorePath = writeClusterSecretStore(prepared.workRoot);
    command(prepared.kubaraBin, [
      "--work-dir", prepared.workRoot,
      "--config-file", join(prepared.workRoot, "config.yaml"),
      "--env-file", join(prepared.workRoot, ".env"),
      "--kubeconfig", hubKubeconfig,
      "bootstrap", expected.hubLogicalName,
      "--platform-components", join(prepared.workRoot, "platform-components"),
      "--platform-configs", join(prepared.workRoot, "platform-configs"),
      "--with-es-css-file", clusterSecretStorePath,
      "--timeout", "20m",
    ], {
      inherit: true,
      timeout: 1_500_000,
      env: isolatedHelmEnv(prepared.workRoot),
    });

    currentStage = "argo-register-and-reconcile-spoke";
    phase(currentStage);
    const observed = waitForFaithfulConvergence({
      hubKubeconfig,
      spokeHostKubeconfig,
      expectedRemoteCommit: prepared.remote.commit,
      expectedContract: prepared.sourceContract,
      expectedSpokeServer: spokeRoute.server,
    });

    currentStage = "confighub-observed-attestation";
    phase(currentStage);
    const observedDocument = buildObservedAttestationDocument({
      prepared,
      spokeRoute,
      secretRoute,
      observed,
    });
    const observedAttestation = upsertAndApproveAttestation({
      slug: expected.attestationUnit,
      role: "FaithfulLaneAttestation",
      proofPhase: "Observed",
      document: observedDocument,
      sourceDigest: prepared.generated.sha256,
    });

    receipt = {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "KubaraFaithfulHubSpokeProofReceipt",
      metadata: { name: "kubara-v0-13-0-faithful-hub-spoke" },
      spec: {
        observedAt: new Date().toISOString(),
        execution: "serial-live-lock",
        source: sourceReceipt(prepared),
        onboarding: {
          clusterAdd: prepared.clusterAdd,
          hub: {
            logicalName: expected.hubLogicalName,
            stage: expected.hubStage,
            kindCluster: expected.hubKindCluster,
          },
          spoke: {
            logicalName: expected.spokeLogicalName,
            stage: expected.spokeStage,
            kindCluster: expected.spokeKindCluster,
          },
        },
        configHub: {
          planCheckAndApproval: planApproval,
          observedAttestation,
          ordering: {
            planApprovedBeforeKindAndKubaraMutation: true,
            observedAttestationApprovedAfterConvergence: true,
          },
          githubStatus: {
            enforced: false,
            context: null,
            claim: "not-proven",
            detail:
              "This proof records ConfigHub Units and approvals. It neither creates nor claims an enforced GitHub commit status.",
          },
        },
        secretRoute: {
          backend: "OpenBao dev-mode local evaluation",
          operator: "External Secrets Operator",
          clusterSecretStore: `${expected.hubLogicalName}-${expected.hubStage}`,
          documentedRemotePath: secretRoute.remotePath,
          remoteProperty: "kubeconfig",
          rewrittenServer: spokeRoute.server,
          rewrittenKubeconfigSha256: spokeRoute.sha256,
          apiServerCertificateIncludesRewrittenIP:
            spokeRoute.apiServerCertificateIncludesRewrittenIP,
          hubNodeCanReachSpokeAPI: spokeRoute.hubNodeCanReachSpokeAPI,
          openBao,
          valueReadBackMatches: secretRoute.valueReadBackMatches,
          secretDataRecorded: false,
        },
        argo: observed,
        cleanup,
        limits: [
          "The proof uses Kubara's local-evaluation OpenBao pattern. Dev-mode OpenBao is not a production secret backend.",
          "ConfigHub approval is recorded on Provider None attestation Units; this receipt does not claim a server-side deployment gate or an enforced GitHub status.",
          "The two fresh kind clusters prove one hub and one registered spoke, not production scale or high availability.",
          "The selected downstream convergence witness is cert-manager; other enabled applications may still be reconciling when this proof completes.",
          "No kubeconfig, client key, bearer token, ConfigHub identity, or ConfigHub credential is stored in the receipt.",
        ],
      },
      status: {
        result: "pass",
        claim:
          "Kubara v0.13 generated and bootstrapped its unchanged Git/AppSet/AppProject topology, External Secrets materialized the documented OpenBao-backed spoke credential, the hub registered the spoke, and cert-manager became Synced and Healthy there after ConfigHub recorded plan approval.",
      },
    };
  } catch (error) {
    failure = error;
  }

  let failureStage = currentStage;
  currentStage = "cleanup";
  phase(currentStage);
  cleanup.spokeCluster = cleanupKindCluster({
    name: expected.spokeKindCluster,
    creationAttempted: state.spokeCreationAttempted,
    baseline,
  });
  cleanup.hubCluster = cleanupKindCluster({
    name: expected.hubKindCluster,
    creationAttempted: state.hubCreationAttempted,
    baseline,
  });
  const finalClusters = tryKindClusters();
  cleanup.baselineRestored = Array.isArray(baseline)
    && Array.isArray(finalClusters)
    && sameArray(finalClusters, baseline);
  if (prepared?.workRoot) {
    try {
      rmSync(prepared.workRoot, { recursive: true, force: true });
      cleanup.localFiles = existsSync(prepared.workRoot) ? "failed" : "pass";
    } catch {
      cleanup.localFiles = "failed";
    }
  } else {
    cleanup.localFiles = "not-created";
  }
  releaseLiveLock(lockPath);

  const cleanupPassed = cleanup.hubCluster === "pass"
    && cleanup.spokeCluster === "pass"
    && cleanup.baselineRestored
    && cleanup.localFiles === "pass";
  if (!failure && !cleanupPassed) {
    failure = new Error(`faithful-lane cleanup failed: ${JSON.stringify(cleanup)}`);
    failureStage = "cleanup";
  }

  if (failure) {
    const blocked = {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "KubaraFaithfulHubSpokeProofFailure",
      metadata: { name: "kubara-v0-13-0-faithful-hub-spoke" },
      spec: {
        attemptId: activeAttempt.spec.attemptId,
        attemptStartedAt: activeAttempt.spec.startedAt,
        observedAt: new Date().toISOString(),
        stage: failureStage,
        error: safeError(failure),
        cleanup,
      },
      status: { result: "blocked" },
    };
    writeDurableYaml(failurePath, blocked);
    verifyBlockedFailure(readYaml(failurePath), activeAttempt);
    clearLiveAttempt(activeAttempt);
    activeAttempt = null;
    throw failure;
  }

  verifyReceipt(receipt);
  writeYaml(receiptPath, receipt);
  const persistedReceipt = readYaml(receiptPath);
  verifyReceipt(persistedReceipt);
  writeSummaries(persistedReceipt);
  verifySummaries(persistedReceipt);
  rmSync(failurePath, { force: true });
  phase("complete");
  clearLiveAttempt(activeAttempt);
  activeAttempt = null;
  console.log(`wrote ${relativeRepo(receiptPath)}`);
}

function sourceReceipt(prepared) {
  return {
    kubara: {
      version: expected.kubaraVersion,
      commit: prepared.sourceLock.spec.kubara.commit,
      binarySha256: prepared.binarySha256,
      binaryDigestCheck: prepared.binaryDigestCheck,
    },
    catalogs: {
      version: expected.catalogVersion,
      commit: prepared.sourceLock.spec.catalogs.commit,
      snapshot: relativeRepo(catalogSnapshotRoot),
    },
    currentExample: {
      config: relativeRepo(sourceConfigPath),
      configSha256: sha256File(sourceConfigPath),
      generatedRoot: relativeRepo(committedGeneratedRoot),
      generatedFileCount: prepared.generated.fileCount,
      generatedSha256: prepared.generated.sha256,
    },
    git: prepared.remote,
    contract: prepared.sourceContract,
  };
}

function resolveKubaraBinary() {
  const configured = process.env.KUBARA_BIN?.trim();
  if (configured) {
    check(existsSync(configured), `KUBARA_BIN does not exist: ${configured}`);
    return resolve(configured);
  }
  const found = command("sh", ["-c", "command -v kubara"], { allowFailure: true });
  check(found.ok && found.output.trim(), "set KUBARA_BIN to a verified Kubara v0.13.0 binary");
  return resolve(found.output.trim());
}

function renderEnv(hub, repoURL) {
  return [
    `PROJECT_NAME=${JSON.stringify(hub.name)}`,
    `PROJECT_STAGE=${JSON.stringify(hub.stage)}`,
    'ARGOCD_WIZARD_ACCOUNT_PASSWORD="faithful-local-not-a-secret"',
    `ARGOCD_GIT_HTTPS_URL=${JSON.stringify(repoURL)}`,
    'ARGOCD_GIT_USERNAME=""',
    'ARGOCD_GIT_PAT_OR_PASSWORD=""',
    'ARGOCD_HELM_REPO_USERNAME=""',
    'ARGOCD_HELM_REPO_PASSWORD=""',
    'ARGOCD_HELM_REPO_URL=""',
    'DOCKERCONFIG_BASE64=""',
    "",
  ].join("\n");
}

function copyOverrides(fromRoot, toRoot) {
  if (!existsSync(fromRoot)) return;
  for (const source of listFiles(fromRoot)) {
    const destination = join(toRoot, relative(fromRoot, source));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
}

function generatedEvidence(root) {
  const components = join(root, "platform-components");
  const configs = join(root, "platform-configs");
  check(existsSync(components), `missing ${relativeRepo(components)}`);
  check(existsSync(configs), `missing ${relativeRepo(configs)}`);
  const files = [...listFiles(components), ...listFiles(configs)]
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const entries = files.map((path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: sha256File(path),
  }));
  return {
    root,
    fileCount: entries.length,
    sha256: sha256(JSON.stringify(entries)),
    entries,
  };
}

function compareTreeEvidence(left, right, message) {
  if (left.sha256 === right.sha256 && left.fileCount === right.fileCount) return;
  const leftByPath = new Map(left.entries.map((entry) => [entry.path, entry.sha256]));
  const rightByPath = new Map(right.entries.map((entry) => [entry.path, entry.sha256]));
  const differences = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])]
    .sort()
    .filter((path) => leftByPath.get(path) !== rightByPath.get(path))
    .slice(0, 12);
  throw new Error(`${message}: ${differences.join(", ") || "tree digest mismatch"}`);
}

function inspectSourceContract(generatedRoot, hub) {
  const valuesRoot = join(
    generatedRoot,
    "platform-configs",
    expected.hubLogicalName,
    "helm",
    "argo-cd",
  );
  const valuesFiles = listFiles(valuesRoot)
    .filter((path) => {
      const name = basename(path);
      return name === "values.generated.yaml"
        || name === "additional-values.yaml"
        || /^values-.*\.ya?ml$/.test(name);
    })
    .sort((left, right) => valuesOrder(left).localeCompare(valuesOrder(right)));
  check(valuesFiles.length > 0, "generated Argo values are missing");
  let merged = {};
  for (const path of valuesFiles) merged = deepMerge(merged, readYaml(path));

  const applicationSet = merged.bootstrapValues?.applicationSets?.[expected.projectName];
  const project = merged.bootstrapValues?.projects?.[expected.projectName];
  const generatedSpoke = merged.bootstrapValues?.cluster?.find(
    (cluster) => cluster.name === expected.spokeLogicalName,
  );
  check(applicationSet, `missing bootstrapValues.applicationSets.${expected.projectName}`);
  check(project, `missing bootstrapValues.projects.${expected.projectName}`);
  check(generatedSpoke, `missing generated spoke registration ${expected.spokeLogicalName}`);
  check(
    generatedSpoke.project === expected.projectName
      && generatedSpoke.secretStoreRef?.kind === "ClusterSecretStore"
      && generatedSpoke.secretStoreRef?.name === expected.projectName
      && generatedSpoke.remoteRef?.remoteKey
        === `${expected.hubLogicalName}/${expected.hubStage}/argocd/${expected.spokeLogicalName}-${expected.spokeStage}`
      && generatedSpoke.remoteRef?.remoteKeyProperty === "kubeconfig",
    "generated spoke credential route differs from Kubara v0.13's documented ExternalSecret contract",
  );

  const configComponents = hub.argocd.repo.https.components;
  const configConfigs = hub.argocd.repo.https.configs;
  const expectedComponentPath = "examples/kubara/current-platform/generated/platform-components/helm";
  const expectedConfigPath = "examples/kubara/current-platform/generated/platform-configs";
  check(
    applicationSet.platformComponents?.repoURL === configComponents.url
      && applicationSet.platformConfigs?.repoURL === configConfigs.url,
    "generated ApplicationSet repository URL was repointed",
  );
  check(
    applicationSet.platformComponents?.targetRevision === configComponents.targetRevision
      && applicationSet.platformConfigs?.targetRevision === configConfigs.targetRevision,
    "generated ApplicationSet revision was repointed",
  );
  check(
    applicationSet.platformComponents?.path === expectedComponentPath
      && applicationSet.platformConfigs?.path === expectedConfigPath,
    "generated ApplicationSet path was repointed",
  );
  const sourceRepos = [...new Set(project.sourceRepos ?? [])].sort();
  const expectedRepos = [...new Set([configComponents.url, configConfigs.url])].sort();
  check(
    expectedRepos.every((repo) => sourceRepos.includes(repo)),
    "generated AppProject does not allow the configured Git source",
  );

  const appSetTemplate = join(
    generatedRoot,
    "platform-components",
    "helm",
    "template-library",
    "templates",
    "argocd",
    "_argo.appset.tpl",
  );
  const projectTemplate = join(
    generatedRoot,
    "platform-components",
    "helm",
    "template-library",
    "templates",
    "argocd",
    "_argo.project.tpl",
  );
  const clusterExternalSecretTemplate = join(
    generatedRoot,
    "platform-components",
    "helm",
    "template-library",
    "templates",
    "external-secrets",
    "_externalSecret.es.argo.cluster.tpl",
  );
  for (const path of [appSetTemplate, projectTemplate, clusterExternalSecretTemplate]) {
    check(existsSync(path), `missing source contract: ${relativeRepo(path)}`);
  }
  return {
    zeroRepoint: true,
    gitRepository: configComponents.url,
    targetRevision: configComponents.targetRevision,
    platformComponentsPath: expectedComponentPath,
    platformConfigsPath: expectedConfigPath,
    project: expected.projectName,
    allowedSourceRepos: sourceRepos,
    valuesFiles: valuesFiles.map((path) => relative(generatedRoot, path).replaceAll("\\", "/")),
    applicationSetTemplateSha256: sha256File(appSetTemplate),
    appProjectTemplateSha256: sha256File(projectTemplate),
    clusterExternalSecretTemplateSha256: sha256File(clusterExternalSecretTemplate),
  };
}

function valuesOrder(path) {
  const name = basename(path);
  if (name === "values.generated.yaml") return `0-${name}`;
  if (name === "additional-values.yaml") return `1-${name}`;
  return `2-${name}`;
}

function deepMerge(left, right) {
  if (Array.isArray(right)) return structuredClone(right);
  if (!right || typeof right !== "object") return structuredClone(right);
  const result = left && typeof left === "object" && !Array.isArray(left)
    ? structuredClone(left)
    : {};
  for (const [key, value] of Object.entries(right)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

function fetchAndVerifyRemoteGit({ workRoot, repoURL, targetRevision, committedGenerated }) {
  const repository = githubRepository(repoURL);
  const commit = resolveRemoteCommit(repoURL, targetRevision);
  const archivePath = join(workRoot, "git-source.tar.gz");
  const extractRoot = join(workRoot, "git-source");
  mkdirSync(extractRoot, { recursive: true });
  command("curl", [
    "-fsSL", "--retry", "3", "--max-time", "600",
    `https://codeload.github.com/${repository}/tar.gz/${encodeURIComponent(commit)}`,
    "-o", archivePath,
  ], { timeout: 660_000 });
  command("tar", ["-xzf", archivePath, "-C", extractRoot], { timeout: 300_000 });
  const roots = readdirSync(extractRoot)
    .map((name) => join(extractRoot, name))
    .filter((path) => statSync(path).isDirectory());
  check(roots.length === 1, "Git source archive has an unexpected root layout");
  const remoteExampleRoot = join(roots[0], "examples", "kubara", "current-platform");
  check(
    existsSync(join(remoteExampleRoot, "generated", "platform-components")),
    `configured Git revision ${targetRevision} (${commit}) does not yet publish the current Kubara generated tree; publishing a different branch cannot satisfy the zero-repoint proof`,
  );
  const remoteGenerated = generatedEvidence(join(remoteExampleRoot, "generated"));
  compareTreeEvidence(
    committedGenerated,
    remoteGenerated,
    "configured Git revision does not contain the committed current example",
  );
  const exactBoundaryFiles = [
    "source/config.yaml",
    "source-lock.yaml",
    "component-artifacts.yaml",
  ];
  for (const boundaryFile of exactBoundaryFiles) {
    const localPath = join(exampleRoot, boundaryFile);
    const remotePath = join(remoteExampleRoot, boundaryFile);
    check(
      existsSync(remotePath),
      `configured Git revision is missing current-platform/${boundaryFile}`,
    );
    check(
      readFileSync(remotePath).equals(readFileSync(localPath)),
      `configured Git revision has a different current-platform/${boundaryFile}`,
    );
  }
  return {
    repository: repoURL,
    targetRevision,
    commit,
    currentExampleReachable: true,
    generatedSha256: remoteGenerated.sha256,
    generatedFileCount: remoteGenerated.fileCount,
    exactBoundaryFiles,
  };
}

function githubRepository(repoURL) {
  const match = String(repoURL).match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  check(match, `faithful proof currently supports public GitHub HTTPS sources, found ${repoURL}`);
  return match[1];
}

function resolveRemoteCommit(repoURL, targetRevision) {
  if (/^[a-f0-9]{40}$/i.test(targetRevision)) return targetRevision.toLowerCase();
  const result = command("git", [
    "ls-remote", repoURL,
    `refs/heads/${targetRevision}`,
    `refs/tags/${targetRevision}^{}`,
    `refs/tags/${targetRevision}`,
  ]);
  const refs = result.output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([commit, ref]) => /^[a-f0-9]{40}$/i.test(commit) && ref)
    .map(([commit, ref]) => ({ commit: commit.toLowerCase(), ref }));
  const branch = refs.find((entry) => entry.ref === `refs/heads/${targetRevision}`);
  const peeledTag = refs.find((entry) => entry.ref === `refs/tags/${targetRevision}^{}`);
  const tag = refs.find((entry) => entry.ref === `refs/tags/${targetRevision}`);
  const selected = branch ?? peeledTag ?? tag;
  check(selected, `Git revision is not reachable: ${targetRevision}`);
  return selected.commit;
}

function checkRemoteRevisionStillPinned(remote) {
  const current = resolveRemoteCommit(remote.repository, remote.targetRevision);
  check(
    current === remote.commit,
    `configured Git revision moved during preflight: ${remote.targetRevision} was ${remote.commit}, now ${current}`,
  );
}

function buildPlanDocument(prepared) {
  return {
    apiVersion: "confighub.com/v1alpha1",
    kind: "KubaraFaithfulHubSpokePlan",
    metadata: { name: "kubara-v0-13-0-faithful-hub-spoke" },
    spec: {
      kubaraVersion: expected.kubaraVersion,
      catalogVersion: expected.catalogVersion,
      topology: {
        hub: expected.hubLogicalName,
        spoke: expected.spokeLogicalName,
        selectedComponent: expected.selectedComponent,
      },
      sourceCheck: {
        result: "pass",
        generatedSha256: prepared.generated.sha256,
        remoteCommit: prepared.remote.commit,
        remoteGeneratedSha256: prepared.remote.generatedSha256,
        zeroRepoint: prepared.sourceContract.zeroRepoint,
        gitRepository: prepared.sourceContract.gitRepository,
        targetRevision: prepared.sourceContract.targetRevision,
        platformComponentsPath: prepared.sourceContract.platformComponentsPath,
        platformConfigsPath: prepared.sourceContract.platformConfigsPath,
        allowedSourceRepos: prepared.sourceContract.allowedSourceRepos,
      },
      ordering: { approvalRequiredBeforeLiveBootstrap: true },
      githubStatus: { enforced: false, claim: "not-proven" },
    },
    status: { phase: "check-complete" },
  };
}

function buildObservedAttestationDocument({ prepared, spokeRoute, secretRoute, observed }) {
  return {
    apiVersion: "confighub.com/v1alpha1",
    kind: "KubaraFaithfulHubSpokeAttestation",
    metadata: { name: "kubara-v0-13-0-faithful-hub-spoke" },
    spec: {
      source: {
        kubaraVersion: expected.kubaraVersion,
        catalogVersion: expected.catalogVersion,
        remoteCommit: prepared.remote.commit,
        generatedSha256: prepared.generated.sha256,
        zeroRepoint: true,
      },
      topology: {
        hub: expected.hubLogicalName,
        spoke: expected.spokeLogicalName,
      },
      secretRoute: {
        backend: "OpenBao",
        controller: "External Secrets Operator",
        remotePath: secretRoute.remotePath,
        remoteProperty: "kubeconfig",
        rewrittenServer: spokeRoute.server,
        rewrittenKubeconfigSha256: spokeRoute.sha256,
        secretDataRecorded: false,
      },
      application: {
        name: observed.application.name,
        component: expected.selectedComponent,
        version: expected.selectedComponentVersion,
        sync: observed.application.sync,
        health: observed.application.health,
        revisions: observed.application.revisions,
      },
      githubStatus: { enforced: false, claim: "not-proven" },
    },
    status: { result: "pass" },
  };
}

function upsertAndApproveAttestation({ slug, role, proofPhase, document, sourceDigest }) {
  const path = join(tmpdir(), `helm-expt-${slug}-${process.pid}.yaml`);
  writeFileSync(path, `${toYaml(document)}\n`, { mode: 0o600 });
  try {
    const labels = {
      ExampleCohort: "kubara-v0.13.0",
      KubaraVersion: expected.kubaraVersion,
      Role: role,
      Topology: "HubSpoke",
      ProofPhase: proofPhase,
    };
    const annotations = {
      "confighub.com/source-path": relativeRepo(sourceConfigPath),
      "confighub.com/generated-sha256": `sha256:${sourceDigest}`,
    };
    let unit = readConfigHubUnit(slug);
    let action = "reused";
    if (!unit) {
      cub([
        "unit", "create",
        "--space", expected.controlSpace,
        slug, path,
        "--toolchain", "AppConfig/YAML",
        "--provider", "None",
        ...metadataArgs("--label", labels),
        ...metadataArgs("--annotation", annotations),
        "--change-desc", `Record ${proofPhase.toLowerCase()} faithful Kubara hub-spoke evidence`,
        "--quiet",
      ]);
      action = "created";
    } else {
      check(unit.ToolchainType === "AppConfig/YAML", `${slug} has the wrong toolchain`);
      check(unit.ProviderType === "None" && unit.TargetID == null, `${slug} is target-applied`);
      const stored = storedUnitData(unit);
      const desired = normalized(readFileSync(path, "utf8"));
      if (normalized(stored) !== desired) {
        cub([
          "unit", "update",
          "--space", expected.controlSpace,
          slug, path,
          "--provider", "None",
          "--change-desc", `Refresh ${proofPhase.toLowerCase()} faithful Kubara hub-spoke evidence`,
          "--quiet",
        ]);
        action = "updated";
      }
      unit = readConfigHubUnit(slug);
      if (metadataDiffers(unit.Labels, labels) || metadataDiffers(unit.Annotations, annotations)) {
        cub([
          "unit", "update", "--patch",
          "--space", expected.controlSpace,
          slug,
          ...metadataArgs("--label", labels),
          ...metadataArgs("--annotation", annotations),
          "--change-desc", `Reconcile ${proofPhase.toLowerCase()} faithful evidence metadata`,
          "--quiet",
        ]);
        action = action === "reused" ? "metadata-reconciled" : action;
      }
    }

    unit = readConfigHubUnit(slug);
    check(unit, `ConfigHub Unit ${expected.controlSpace}/${slug} is missing after upsert`);
    check(
      normalized(storedUnitData(unit)) === normalized(readFileSync(path, "utf8")),
      `${slug} read-back differs from the checked attestation`,
    );
    check(
      unit.DataHash === sha256(readFileSync(path)),
      `${slug} DataHash differs from the checked attestation`,
    );
    let approvalAction = "reused-existing-head-approval";
    if (approvalCount(unit.ApprovedBy) === 0) {
      cub([
        "unit", "approve",
        "--space", expected.controlSpace,
        slug,
        "--wait", "--quiet",
      ], { timeout: 180_000 });
      approvalAction = "approved-head-revision";
    }
    unit = readConfigHubUnit(slug);
    check(approvalCount(unit.ApprovedBy) > 0, `${slug} head revision is not approved`);
    return {
      check: {
        result: "pass",
        readBackMatches: true,
        dataHashMatches: true,
      },
      unit: {
        ref: `${expected.controlSpace}/${slug}`,
        id: unit.UnitID,
        headRevisionNum: unit.HeadRevisionNum,
        dataHash: unit.DataHash,
        contentHash: unit.ContentHash,
        provider: unit.ProviderType,
        targetID: unit.TargetID ?? null,
        action,
      },
      approval: {
        revision: unit.HeadRevisionNum,
        recordedApprovals: approvalCount(unit.ApprovedBy),
        approverIdentityRecordedInReceipt: false,
        action: approvalAction,
      },
    };
  } finally {
    rmSync(path, { force: true });
  }
}

function assertKubaraOrganization() {
  const context = cub(["context", "get"]);
  check(
    new RegExp(`^Organization Name\\s+${expected.organization}\\s*$`, "m").test(context),
    `refusing to run outside the ${expected.organization} organization`,
  );
  const spaces = cubJson(["space", "list"]);
  check(
    spaces.some((entry) => (entry.Space ?? entry).Slug === expected.controlSpace),
    `missing ConfigHub control Space ${expected.controlSpace}`,
  );
}

function readConfigHubUnit(slug) {
  const rows = cubJson([
    "unit", "list",
    "--space", expected.controlSpace,
    "--where", `Slug = '${slug}'`,
  ]);
  if (rows.length === 0) return null;
  check(rows.length === 1, `found ${rows.length} ${slug} Units`);
  return rows[0].Unit ?? rows[0];
}

function cub(args, options = {}) {
  const result = command("cub", [...contextArgs, ...args], {
    env: { ...process.env, CONFIGHUB_AGENT: "1" },
    ...options,
  });
  return result.output;
}

function cubJson(args) {
  return JSON.parse(cub([...args, "-o", "json"]));
}

function metadataArgs(flag, values) {
  return Object.entries(values).flatMap(([key, value]) => [flag, `${key}=${value}`]);
}

function metadataDiffers(actual, expectedValues) {
  return Object.entries(expectedValues).some(([key, value]) => actual?.[key] !== value);
}

function storedUnitData(unit) {
  check(unit.Data, `${unit.Slug} has no stored data`);
  return Buffer.from(unit.Data, "base64").toString("utf8");
}

function approvalCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value ? 1 : 0;
}

function rewriteSpokeKubeconfig({ workRoot, hubKubeconfig, spokeHostKubeconfig }) {
  command("kubectl", ["--kubeconfig", spokeHostKubeconfig, "get", "namespace"]);
  const spokeIP = command("docker", [
    "inspect", "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    `${expected.spokeKindCluster}-control-plane`,
  ]).output.trim();
  check(/^\d+\.\d+\.\d+\.\d+$/.test(spokeIP), "could not discover the spoke control-plane IP");
  const cert = command("docker", [
    "exec", `${expected.spokeKindCluster}-control-plane`,
    "openssl", "x509",
    "-in", "/etc/kubernetes/pki/apiserver.crt",
    "-noout", "-ext", "subjectAltName",
  ]).output;
  const apiServerCertificateIncludesRewrittenIP = cert.includes(`IP Address:${spokeIP}`);
  check(
    apiServerCertificateIncludesRewrittenIP,
    `spoke API certificate does not include ${spokeIP}`,
  );
  const reachability = command("docker", [
    "exec", `${expected.hubKindCluster}-control-plane`,
    "curl", "-ksS", "--max-time", "10",
    `https://${spokeIP}:6443/livez`,
  ], { allowFailure: true });
  check(
    reachability.ok && reachability.output.trim() === "ok",
    "hub node cannot reach the spoke Kubernetes API",
  );

  const kubeconfig = readYaml(spokeHostKubeconfig);
  check(kubeconfig.clusters?.length === 1, "spoke kubeconfig has an unexpected cluster layout");
  check(kubeconfig.users?.length === 1, "spoke kubeconfig has an unexpected user layout");
  const server = `https://${spokeIP}:6443`;
  kubeconfig.clusters[0].cluster.server = server;
  const rewrittenPath = join(workRoot, "spoke-argo.kubeconfig");
  writeFileSync(rewrittenPath, `${toYaml(kubeconfig)}\n`, { mode: 0o600 });
  return {
    rewrittenPath,
    server,
    sha256: sha256File(rewrittenPath),
    apiServerCertificateIncludesRewrittenIP,
    hubNodeCanReachSpokeAPI: true,
  };
}

function installAndConfigureOpenBao({ workRoot, hubKubeconfig }) {
  const valuesPath = join(workRoot, "openbao-values.yaml");
  const chartPath = join(workRoot, `openbao-${expected.openBaoChartVersion}.tgz`);
  command("curl", [
    "-fsSL", "--retry", "3", "--max-time", "600",
    expected.openBaoChartUrl,
    "-o", chartPath,
  ], { timeout: 660_000 });
  check(
    sha256File(chartPath) === expected.openBaoChartSha256,
    `OpenBao ${expected.openBaoChartVersion} chart digest changed`,
  );
  writeFileSync(valuesPath, `server:
  dev:
    enabled: true
    devRootToken: root
  ha:
    enabled: false
  extraEnvironmentVars:
    BAO_DEV_LISTEN_ADDRESS: "0.0.0.0:8200"
injector:
  enabled: false
ui:
  enabled: true
`, { mode: 0o600 });
  command("helm", [
    "upgrade", "--install", "openbao", chartPath,
    "--namespace", expected.openBaoNamespace,
    "--create-namespace",
    "--kubeconfig", hubKubeconfig,
    "--values", valuesPath,
    "--wait", "--timeout", "10m",
  ], {
    inherit: true,
    timeout: 720_000,
    env: isolatedHelmEnv(workRoot),
  });
  kube(hubKubeconfig, [
    "-n", expected.openBaoNamespace,
    "wait", "--for=condition=Ready", `pod/${expected.openBaoPod}`,
    "--timeout=300s",
  ], { timeout: 360_000 });

  const bao = (args, options = {}) => kube(hubKubeconfig, [
    "-n", expected.openBaoNamespace,
    "exec", expected.openBaoPod,
    "--", "env", "BAO_TOKEN=root", "bao", ...args,
  ], options);
  const secretEngines = JSON.parse(bao(["secrets", "list", "-format=json"]).output);
  if (!secretEngines["kv/"]) bao(["secrets", "enable", "-path=kv", "kv-v2"]);
  const authMethods = JSON.parse(bao(["auth", "list", "-format=json"]).output);
  if (!authMethods["kubernetes/"]) bao(["auth", "enable", "kubernetes"]);
  bao([
    "write", "auth/kubernetes/config",
    "token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token",
    "kubernetes_host=https://kubernetes.default.svc:443",
    "kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  ]);
  const policy = `path "kv/data/*" {
  capabilities = ["read", "list"]
}

path "kv/metadata/*" {
  capabilities = ["read", "list"]
}
`;
  kube(hubKubeconfig, [
    "-n", expected.openBaoNamespace,
    "exec", "-i", expected.openBaoPod,
    "--", "env", "BAO_TOKEN=root", "bao", "policy", "write",
    expected.externalSecretsPolicy, "-",
  ], { input: policy });
  bao([
    "write", `auth/kubernetes/role/${expected.externalSecretsRole}`,
    "bound_service_account_names=*",
    "bound_service_account_namespaces=*",
    `policies=${expected.externalSecretsPolicy}`,
    "ttl=24h",
  ]);
  return {
    chart: "openbao/openbao",
    chartVersion: expected.openBaoChartVersion,
    chartUrl: expected.openBaoChartUrl,
    chartSha256: expected.openBaoChartSha256,
    namespace: expected.openBaoNamespace,
    mode: "dev",
    kubaraLocalPattern: true,
    broadEvaluationOnlyPolicy: true,
    rootTokenRecorded: false,
    result: "pass",
  };
}

function storeSpokeKubeconfig({ hubKubeconfig, spokeKubeconfigPath }) {
  const remotePath = `${expected.hubLogicalName}/${expected.hubStage}/argocd/${expected.spokeLogicalName}-${expected.spokeStage}`;
  const input = readFileSync(spokeKubeconfigPath, "utf8");
  kube(hubKubeconfig, [
    "-n", expected.openBaoNamespace,
    "exec", "-i", expected.openBaoPod,
    "--", "env", "BAO_TOKEN=root", "bao", "kv", "put",
    `kv/${remotePath}`, "kubeconfig=-",
  ], { input });
  const readBack = kube(hubKubeconfig, [
    "-n", expected.openBaoNamespace,
    "exec", expected.openBaoPod,
    "--", "env", "BAO_TOKEN=root", "bao", "kv", "get",
    "-field=kubeconfig", `kv/${remotePath}`,
  ]).output;
  check(sha256(normalized(readBack)) === sha256(normalized(input)), "OpenBao kubeconfig read-back differs");
  return {
    remotePath,
    valueReadBackMatches: true,
  };
}

function writeClusterSecretStore(workRoot) {
  const path = join(workRoot, "clustersecretstore.yaml");
  writeFileSync(path, `apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: ${expected.hubLogicalName}-${expected.hubStage}
spec:
  provider:
    vault:
      server: http://openbao.openbao.svc:8200
      path: kv
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: ${expected.externalSecretsRole}
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
`, { mode: 0o600 });
  return path;
}

function isolatedHelmEnv(workRoot) {
  const helmRoot = join(workRoot, ".helm-runtime");
  const configHome = join(helmRoot, "config");
  const cacheHome = join(helmRoot, "cache");
  const dataHome = join(helmRoot, "data");
  for (const path of [configHome, cacheHome, dataHome]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    ...process.env,
    HELM_CONFIG_HOME: configHome,
    HELM_CACHE_HOME: cacheHome,
    HELM_DATA_HOME: dataHome,
  };
}

function waitForFaithfulConvergence({
  hubKubeconfig,
  spokeHostKubeconfig,
  expectedRemoteCommit,
  expectedContract,
  expectedSpokeServer,
}) {
  waitFor("ClusterSecretStore ready", 180, 5_000, () => {
    const result = kubeTry(hubKubeconfig, [
      "get", "clustersecretstore", `${expected.hubLogicalName}-${expected.hubStage}`,
      "-o", "json",
    ]);
    if (!result.ok) return false;
    const resource = JSON.parse(result.output);
    return conditionTrue(resource, "Ready");
  });
  waitFor("spoke ExternalSecret ready", 180, 5_000, () => {
    const result = kubeTry(hubKubeconfig, [
      "-n", "argocd", "get", "externalsecret",
      `${expected.spokeLogicalName}-es`, "-o", "json",
    ]);
    if (!result.ok) return false;
    return conditionTrue(JSON.parse(result.output), "Ready");
  });

  const clusterSecret = JSON.parse(kube(hubKubeconfig, [
    "-n", "argocd", "get", "secret",
    `${expected.spokeLogicalName}-cluster-secret`, "-o", "json",
  ]).output);
  const decodedName = decodeSecretField(clusterSecret, "name");
  const decodedServer = decodeSecretField(clusterSecret, "server");
  const decodedProject = decodeSecretField(clusterSecret, "project");
  check(decodedName === expected.spokeLogicalName, "Argo cluster Secret has the wrong name");
  check(decodedProject === expected.projectName, "Argo cluster Secret has the wrong project");
  check(decodedServer === expectedSpokeServer, "Argo cluster Secret has the wrong API server");
  const decodedConfig = JSON.parse(decodeSecretField(clusterSecret, "config"));
  check(
    decodedConfig.bearerToken === ""
      && decodedConfig.tlsClientConfig?.insecure === false
      && typeof decodedConfig.tlsClientConfig?.caData === "string"
      && decodedConfig.tlsClientConfig.caData.length > 0
      && typeof decodedConfig.tlsClientConfig?.certData === "string"
      && decodedConfig.tlsClientConfig.certData.length > 0
      && typeof decodedConfig.tlsClientConfig?.keyData === "string"
      && decodedConfig.tlsClientConfig.keyData.length > 0,
    "Argo cluster Secret does not contain the expected client-certificate auth shape",
  );

  const applicationName = `${expected.spokeLogicalName}-${expected.selectedComponent}`;
  let application;
  waitFor(`${applicationName} Synced/Healthy`, 240, 5_000, () => {
    const result = kubeTry(hubKubeconfig, [
      "-n", "argocd", "get", "application", applicationName, "-o", "json",
    ]);
    if (!result.ok) return false;
    application = JSON.parse(result.output);
    return application.status?.sync?.status === "Synced"
      && application.status?.health?.status === "Healthy";
  });
  const revisions = application.status?.sync?.revisions
    ?? [application.status?.sync?.revision].filter(Boolean);
  check(revisions.length > 0, "Argo Application recorded no Git revision");
  check(
    revisions.every((revision) => revision === expectedRemoteCommit),
    `Argo reconciled a different Git commit: ${revisions.join(", ")}`,
  );

  const appSet = JSON.parse(kube(hubKubeconfig, [
    "-n", "argocd", "get", "applicationset", expected.selectedComponent,
    "-o", "json",
  ]).output);
  const actualSources = appSet.spec?.template?.spec?.sources ?? [];
  const valuesSource = actualSources.find((source) => source.ref === "valuesRepo");
  const componentSource = actualSources.find((source) => source.path);
  check(
    valuesSource?.repoURL === expectedContract.gitRepository
      && componentSource?.repoURL === expectedContract.gitRepository,
    "live ApplicationSet Git source was repointed",
  );
  check(
    valuesSource.targetRevision === expectedContract.targetRevision
      && componentSource.targetRevision === expectedContract.targetRevision,
    "live ApplicationSet revision was repointed",
  );
  check(
    componentSource.path
      === `${expectedContract.platformComponentsPath}/${expected.selectedComponent}`,
    "live ApplicationSet component path was repointed",
  );
  const expectedValuesPrefix =
    `$valuesRepo/${expectedContract.platformConfigsPath}/{{name}}/helm/${expected.selectedComponent}/`;
  const valueFiles = componentSource.helm?.valueFiles ?? [];
  check(
    valueFiles.includes(`${expectedValuesPrefix}values.generated.yaml`)
      && valueFiles.includes(`${expectedValuesPrefix}additional-values.yaml`)
      && valueFiles.includes(`${expectedValuesPrefix}values-*.yaml`),
    "live ApplicationSet platform-configs path was repointed",
  );

  const project = JSON.parse(kube(hubKubeconfig, [
    "-n", "argocd", "get", "appproject", expected.projectName, "-o", "json",
  ]).output);
  const sourceRepos = [...(project.spec?.sourceRepos ?? [])].sort();
  check(
    expectedContract.allowedSourceRepos.every((repo) => sourceRepos.includes(repo)),
    "live AppProject no longer allows the configured Git repository",
  );

  const deployments = JSON.parse(kube(spokeHostKubeconfig, [
    "-n", expected.selectedComponent, "get", "deployment", "-o", "json",
  ]).output).items ?? [];
  check(deployments.length > 0, "selected spoke component created no Deployments");
  const deploymentRows = deployments.map((deployment) => ({
    name: deployment.metadata.name,
    desired: Number(deployment.spec?.replicas ?? 1),
    available: Number(deployment.status?.availableReplicas ?? 0),
  }));
  check(
    deploymentRows.every((deployment) => deployment.available === deployment.desired),
    "selected spoke component Deployments are not all available",
  );

  return {
    registration: {
      result: "pass",
      mechanism: "Kubara-generated ExternalSecret -> Argo CD cluster Secret",
      externalSecret: `argocd/${expected.spokeLogicalName}-es`,
      clusterSecret: `argocd/${expected.spokeLogicalName}-cluster-secret`,
      registeredName: decodedName,
      registeredProject: decodedProject,
      registeredServer: decodedServer,
      secretConfigPresent: true,
      clientCertificateAuthMaterialPresent: true,
      secretDataRecorded: false,
    },
    sourceIntegrity: {
      result: "pass",
      zeroRepoint: true,
      applicationSet: expected.selectedComponent,
      appProject: expected.projectName,
      gitRepository: expectedContract.gitRepository,
      targetRevision: expectedContract.targetRevision,
      platformComponentsPath: expectedContract.platformComponentsPath,
      platformConfigsPath: expectedContract.platformConfigsPath,
      allowedSourceRepos: sourceRepos,
    },
    application: {
      name: applicationName,
      destinationName: application.spec?.destination?.name,
      sync: application.status.sync.status,
      health: application.status.health.status,
      revisions,
      component: expected.selectedComponent,
      version: expected.selectedComponentVersion,
    },
    workload: {
      namespace: expected.selectedComponent,
      deployments: deploymentRows,
      ready: true,
    },
  };
}

function conditionTrue(resource, type) {
  return (resource.status?.conditions ?? []).some(
    (condition) => condition.type === type && condition.status === "True",
  );
}

function decodeSecretField(secret, key) {
  check(secret.data?.[key], `Secret is missing ${key}`);
  return Buffer.from(secret.data[key], "base64").toString("utf8");
}

function waitFor(description, attempts, intervalMs, predicate) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    sleep(intervalMs);
  }
  throw new Error(
    `${description} did not converge${lastError ? `: ${safeError(lastError)}` : ""}`,
  );
}

function cleanupKindCluster({ name, creationAttempted, baseline }) {
  const before = tryKindClusters();
  if (!before) return "failed";
  if (!before.includes(name)) return creationAttempted ? "pass" : "not-created";
  if (!creationAttempted || !Array.isArray(baseline) || baseline.includes(name)) {
    return "refused-not-owned";
  }
  const result = command("kind", ["delete", "cluster", "--name", name], {
    allowFailure: true,
    inherit: true,
    timeout: 300_000,
  });
  if (!result.ok) return "failed";
  const after = tryKindClusters();
  return Array.isArray(after) && !after.includes(name) ? "pass" : "failed";
}

function beginLiveAttempt() {
  if (existsSync(attemptPath)) {
    const existing = readYaml(attemptPath);
    verifyAttemptMarker(existing);
    const ownerPid = existing.spec.pid;
    check(
      ownerPid === process.pid || !processAlive(ownerPid),
      `faithful live attempt ${existing.spec.attemptId} is still active as pid ${ownerPid}`,
    );
  }

  const startedAt = new Date().toISOString();
  const attempt = {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraFaithfulHubSpokeProofAttempt",
    metadata: { name: "kubara-v0-13-0-faithful-hub-spoke" },
    spec: {
      attemptId: `${startedAt}-${process.pid}-${randomUUID()}`,
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
      stage: "starting",
    },
    status: { result: "in-progress" },
  };
  writeDurableYaml(attemptPath, attempt);
  const persisted = readYaml(attemptPath);
  verifyAttemptMarker(persisted, attempt.spec.attemptId);
  return attempt;
}

function verifyAttemptMarker(attempt, expectedAttemptId = null) {
  check(
    attempt?.kind === "KubaraFaithfulHubSpokeProofAttempt"
      && attempt?.metadata?.name === "kubara-v0-13-0-faithful-hub-spoke"
      && attempt?.status?.result === "in-progress"
      && typeof attempt?.spec?.attemptId === "string"
      && attempt.spec.attemptId.length > 0
      && Number.isInteger(attempt.spec.pid)
      && typeof attempt.spec.startedAt === "string"
      && Number.isFinite(Date.parse(attempt.spec.startedAt))
      && typeof attempt.spec.updatedAt === "string"
      && Number.isFinite(Date.parse(attempt.spec.updatedAt))
      && typeof attempt.spec.stage === "string"
      && attempt.spec.stage.length > 0,
    `${relativeRepo(attemptPath)} is malformed; refusing to trust or replace it`,
  );
  if (expectedAttemptId !== null) {
    check(
      attempt.spec.attemptId === expectedAttemptId,
      `${relativeRepo(attemptPath)} ownership changed during the live proof`,
    );
  }
}

function updateLiveAttemptStage(name) {
  if (!activeAttempt) return;
  check(
    existsSync(attemptPath),
    `${relativeRepo(attemptPath)} disappeared during the live proof`,
  );
  verifyAttemptMarker(readYaml(attemptPath), activeAttempt.spec.attemptId);
  activeAttempt.spec.stage = name;
  activeAttempt.spec.updatedAt = new Date().toISOString();
  writeDurableYaml(attemptPath, activeAttempt);
}

function clearLiveAttempt(attempt) {
  check(attempt, "missing faithful live attempt ownership");
  check(
    existsSync(attemptPath),
    `${relativeRepo(attemptPath)} disappeared before the attempt was durably resolved`,
  );
  verifyAttemptMarker(readYaml(attemptPath), attempt.spec.attemptId);
  rmSync(attemptPath, { force: true });
  check(!existsSync(attemptPath), `could not clear ${relativeRepo(attemptPath)}`);
}

function verifyBlockedFailure(blocked, attempt) {
  check(
    blocked?.kind === "KubaraFaithfulHubSpokeProofFailure"
      && blocked?.metadata?.name === "kubara-v0-13-0-faithful-hub-spoke"
      && blocked?.status?.result === "blocked"
      && blocked?.spec?.attemptId === attempt.spec.attemptId
      && blocked?.spec?.attemptStartedAt === attempt.spec.startedAt
      && typeof blocked?.spec?.observedAt === "string"
      && Number.isFinite(Date.parse(blocked.spec.observedAt))
      && typeof blocked?.spec?.stage === "string"
      && blocked.spec.stage.length > 0,
    `${relativeRepo(failurePath)} did not durably record the blocked live attempt`,
  );
}

function writeDurableYaml(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${toYaml(value)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function acquireLiveLock() {
  const lockPath = process.env.HELM_EXPT_LIVE_PARITY_LOCK
    ? resolve(process.env.HELM_EXPT_LIVE_PARITY_LOCK)
    : join(homedir(), ".confighub", "locks", "helm-expt-live-parity.lock");
  const timeoutSeconds = Number(
    process.env.HELM_EXPT_LIVE_PARITY_LOCK_TIMEOUT_SECONDS ?? "7200",
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
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
      const ownerPath = join(lockPath, "owner.json");
      let owner = {};
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      } catch {
        // An incomplete owner file is treated as live until the timeout.
      }
      if (Number.isInteger(owner.pid) && !processAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      check(
        Date.now() < deadline,
        `live parity lane is locked at ${lockPath}${owner.pid ? ` by pid ${owner.pid}` : ""}`,
      );
      sleep(10_000);
    }
  }
}

function releaseLiveLock(lockPath) {
  if (!lockPath) return;
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    if (owner.pid === process.pid) rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Never remove a lock whose ownership cannot be proved.
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function assertNoForeignLiveParityProcess(clusters) {
  for (const pattern of [
    "tests/live-helm-confighub-parity-test",
    "scripts/run-kubara-live-qualification.mjs",
    "scripts/reconcile-kubara-mini-idp.mjs",
  ]) {
    const result = command("pgrep", ["-fl", pattern], { allowFailure: true });
    const foreign = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => Number(line.split(/\s+/, 1)[0]) !== process.pid);
    check(
      !result.ok || foreign.length === 0,
      `a conflicting live proof is still active (${pattern}): ${foreign.join("; ")}`,
    );
  }
  const leaked = clusters.filter((name) => name.startsWith("helm-expt-parity-"));
  check(
    leaked.length === 0,
    `refusing to overlap leaked live-parity clusters: ${leaked.join(", ")}`,
  );
}

function phase(name) {
  if (mode === "--run") {
    updateLiveAttemptStage(name);
    mkdirSync(dirname(stagePath), { recursive: true });
    writeFileSync(stagePath, `${name}\n`);
  }
  console.log(`==> ${name}`);
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 1024 * 1024 * 200,
  });
  const output = options.inherit ? "" : String(result.stdout ?? "");
  const error = options.inherit ? "" : String(result.stderr ?? "");
  const ok = result.status === 0 && !result.error;
  if (!ok && !options.allowFailure) {
    const detail = result.error ?? (error || output);
    throw new Error(
      `${binary} ${args.join(" ")} failed: ${safeError(detail)}`,
    );
  }
  return { ok, status: result.status, output, error };
}

function kube(kubeconfig, args, options = {}) {
  return command("kubectl", ["--kubeconfig", kubeconfig, ...args], options);
}

function kubeTry(kubeconfig, args, options = {}) {
  return kube(kubeconfig, args, { ...options, allowFailure: true });
}

function kindClusters() {
  const result = command("kind", ["get", "clusters"]);
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function tryKindClusters() {
  const result = command("kind", ["get", "clusters"], { allowFailure: true });
  if (!result.ok) return null;
  return result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) result.push(...listFiles(path));
    else if (stat.isFile()) result.push(path);
  }
  return result;
}

function normalized(text) {
  return `${String(text).trimEnd()}\n`;
}

function sleep(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function sameArray(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function safeError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/ch_[A-Za-z0-9_-]+/g, "<redacted-confighub-token>")
    .replace(/[A-Z0-9._%+-]+@confighub\.com/gi, "<redacted-confighub-identity>")
    .replace(/(client-key-data|client-certificate-data|certificate-authority-data):\s*\S+/gi, "$1: <redacted>")
    .replace(/bearerToken[^,}\n]*/gi, "bearerToken:<redacted>")
    .replace(/BAO_TOKEN=[^\s]+/gi, "BAO_TOKEN=<redacted>")
    .replace(/devRootToken:\s*[^\s]+/gi, "devRootToken: <redacted>")
    .replace(/faithful-local-not-a-secret/g, "<redacted-local-password>")
    .slice(0, 2_000);
}

function renderRehearsal(prepared) {
  return `PASS faithful Kubara hub-spoke rehearsal
- Kubara: ${expected.kubaraVersion}
- catalogs: ${expected.catalogVersion}
- cluster add: ${prepared.clusterAdd.result}
- generated files: ${prepared.generated.fileCount}
- generated sha256: ${prepared.generated.sha256}
- Git revision: ${prepared.remote.targetRevision} -> ${prepared.remote.commit}
- source/AppSet/AppProject repoint: none
- live mutation: not run`;
}

function loadAndVerifyReceipt() {
  check(
    !existsSync(attemptPath),
    `${relativeRepo(attemptPath)} records an active or interrupted attempt; do not publish the pass receipt`,
  );
  check(
    !existsSync(failurePath),
    `${relativeRepo(failurePath)} records a blocked newer attempt; do not publish the pass receipt`,
  );
  check(existsSync(receiptPath), `${relativeRepo(receiptPath)} is missing; run the live proof`);
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  check(
    !existsSync(attemptPath),
    `${relativeRepo(attemptPath)} appeared while verifying the pass receipt`,
  );
  check(
    !existsSync(failurePath),
    `${relativeRepo(failurePath)} appeared while verifying the pass receipt`,
  );
  return receipt;
}

function verifyReceipt(receipt) {
  for (const path of [receiptSchemaPath, summarySchemaPath]) {
    check(existsSync(path), `missing proof schema: ${relativeRepo(path)}`);
  }
  check(
    receipt.kind === "KubaraFaithfulHubSpokeProofReceipt",
    "faithful receipt kind changed",
  );
  check(receipt.status?.result === "pass", "faithful receipt is not a pass");
  check(receipt.spec?.execution === "serial-live-lock", "faithful receipt was not serial");
  check(
    receipt.spec?.source?.kubara?.version === expected.kubaraVersion
      && String(receipt.spec?.source?.catalogs?.version) === expected.catalogVersion,
    "faithful source version changed",
  );
  check(
    receipt.spec?.source?.currentExample?.configSha256 === sha256File(sourceConfigPath),
    "faithful receipt source config is stale",
  );
  const currentConfig = readYaml(sourceConfigPath);
  const currentHub = currentConfig.clusters?.find(
    (cluster) => cluster.name === expected.hubLogicalName,
  );
  const currentComponentsRepo = currentHub?.argocd?.repo?.https?.components;
  check(
    receipt.spec?.source?.git?.repository === currentComponentsRepo?.url
      && receipt.spec.source.git.targetRevision === currentComponentsRepo.targetRevision
      && receipt.spec.source.contract.gitRepository === currentComponentsRepo.url
      && receipt.spec.source.contract.targetRevision === currentComponentsRepo.targetRevision,
    "faithful receipt no longer matches the configured Git repository/revision",
  );
  const generated = generatedEvidence(committedGeneratedRoot);
  check(
    receipt.spec?.source?.currentExample?.generatedSha256 === generated.sha256
      && receipt.spec.source.currentExample.generatedFileCount === generated.fileCount,
    "faithful receipt generated tree is stale",
  );
  check(
    receipt.spec?.source?.git?.generatedSha256 === generated.sha256
      && receipt.spec.source.git.generatedFileCount === generated.fileCount
      && sameArray(receipt.spec.source.git.exactBoundaryFiles ?? [], [
        "source/config.yaml",
        "source-lock.yaml",
        "component-artifacts.yaml",
      ]),
    "faithful remote Git boundary is incomplete",
  );
  check(
    receipt.spec?.source?.contract?.zeroRepoint === true
      && receipt.spec?.argo?.sourceIntegrity?.zeroRepoint === true,
    "faithful receipt does not prove zero repoint",
  );
  check(
    receipt.spec?.onboarding?.clusterAdd?.result === "pass"
      && receipt.spec.onboarding.clusterAdd.persistedCatalogChoice === true,
    "faithful receipt does not record kubara cluster add",
  );
  const configHub = receipt.spec?.configHub;
  check(
    configHub?.planCheckAndApproval?.check?.result === "pass"
      && configHub.planCheckAndApproval.approval?.recordedApprovals > 0
      && configHub.observedAttestation?.check?.result === "pass"
      && configHub.observedAttestation.approval?.recordedApprovals > 0,
    "faithful ConfigHub check/approval/attestation is incomplete",
  );
  for (const [name, evidence] of [
    [expected.planUnit, configHub.planCheckAndApproval],
    [expected.attestationUnit, configHub.observedAttestation],
  ]) {
    check(
      evidence.unit?.ref === `${expected.controlSpace}/${name}`
        && evidence.unit.provider === "None"
        && evidence.unit.targetID === null
        && /^[a-f0-9]{64}$/.test(evidence.unit.dataHash ?? "")
        && Number.isInteger(evidence.unit.contentHash),
      `faithful ConfigHub evidence Unit ${name} is malformed or target-applied`,
    );
  }
  check(
    configHub.githubStatus?.enforced === false
      && configHub.githubStatus.context === null
      && configHub.githubStatus.claim === "not-proven",
    "faithful receipt overclaims GitHub status enforcement",
  );
  check(
    receipt.spec?.secretRoute?.documentedRemotePath
      === `${expected.hubLogicalName}/${expected.hubStage}/argocd/${expected.spokeLogicalName}-${expected.spokeStage}`
      && receipt.spec.secretRoute.remoteProperty === "kubeconfig"
      && receipt.spec.secretRoute.valueReadBackMatches === true
      && receipt.spec.secretRoute.secretDataRecorded === false,
    "faithful OpenBao/ExternalSecret route changed",
  );
  check(
    receipt.spec.secretRoute.openBao?.chartVersion === expected.openBaoChartVersion
      && receipt.spec.secretRoute.openBao.chartUrl === expected.openBaoChartUrl
      && receipt.spec.secretRoute.openBao.chartSha256 === expected.openBaoChartSha256
      && receipt.spec.secretRoute.openBao.kubaraLocalPattern === true
      && receipt.spec.secretRoute.openBao.broadEvaluationOnlyPolicy === true
      && receipt.spec.secretRoute.openBao.rootTokenRecorded === false,
    "faithful OpenBao artifact/safety boundary changed",
  );
  check(
    receipt.spec?.argo?.registration?.result === "pass"
      && receipt.spec.argo.registration.registeredName === expected.spokeLogicalName
      && receipt.spec.argo.registration.registeredServer
        === receipt.spec.secretRoute.rewrittenServer
      && receipt.spec.argo.registration.clientCertificateAuthMaterialPresent === true
      && receipt.spec.argo.registration.secretDataRecorded === false,
    "faithful Argo spoke registration is incomplete",
  );
  check(
    receipt.spec?.argo?.application?.name
      === `${expected.spokeLogicalName}-${expected.selectedComponent}`
      && receipt.spec.argo.application.sync === "Synced"
      && receipt.spec.argo.application.health === "Healthy"
      && receipt.spec.argo.application.version === expected.selectedComponentVersion
      && receipt.spec.argo.application.revisions.every(
        (revision) => revision === receipt.spec.source.git.commit,
      )
      && receipt.spec.argo.workload?.ready === true,
    "faithful selected component did not converge",
  );
  const cleanup = receipt.spec?.cleanup;
  check(
    cleanup?.hubCluster === "pass"
      && cleanup.spokeCluster === "pass"
      && cleanup.baselineRestored === true
      && cleanup.localFiles === "pass",
    "faithful cleanup is incomplete",
  );
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    "faithful-local-not-a-secret",
    "client-key-data",
    "client-certificate-data",
    "bearerToken",
    "BAO_TOKEN=root",
    "devRootToken: root",
    "@confighub.com",
    "ch_",
  ]) {
    check(!serialized.includes(forbidden), `faithful receipt contains forbidden secret/identity marker ${forbidden}`);
  }
}

function summaryFor(receipt) {
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraFaithfulHubSpokeProofSummary",
    metadata: { name: receipt.metadata.name },
    spec: {
      receipt: relativeRepo(receiptPath),
      observedAt: receipt.spec.observedAt,
      kubaraVersion: receipt.spec.source.kubara.version,
      catalogVersion: receipt.spec.source.catalogs.version,
      hub: receipt.spec.onboarding.hub.logicalName,
      spoke: receipt.spec.onboarding.spoke.logicalName,
      component: receipt.spec.argo.application.component,
      componentVersion: receipt.spec.argo.application.version,
      checks: {
        kubaraClusterAdd: receipt.spec.onboarding.clusterAdd.result,
        gitSourceUnchanged: receipt.spec.argo.sourceIntegrity.zeroRepoint ? "pass" : "blocked",
        configHubPlanApproval:
          receipt.spec.configHub.planCheckAndApproval.approval.recordedApprovals > 0 ? "pass" : "blocked",
        openBaoExternalSecretRoute: receipt.spec.argo.registration.result,
        argoSpokeRegistration: receipt.spec.argo.registration.result,
        applicationSync: receipt.spec.argo.application.sync,
        applicationHealth: receipt.spec.argo.application.health,
        cleanup: receipt.spec.cleanup.baselineRestored ? "pass" : "blocked",
      },
      githubStatusEnforced: false,
    },
    status: { result: receipt.status.result },
  };
}

function renderSummaryMarkdown(receipt) {
  const summary = summaryFor(receipt);
  const checks = summary.spec.checks;
  return `# Faithful Kubara hub-and-spoke proof

Kubara ${summary.spec.kubaraVersion} generated and bootstrapped the familiar hub-and-spoke
topology with catalog ${summary.spec.catalogVersion}. ConfigHub checked and approved the
exact source contract without repointing Kubara's Git repositories, generated
ApplicationSets, or AppProject. The hub registered ${summary.spec.spoke} through Kubara's
documented OpenBao → ExternalSecret → Argo cluster Secret route, then
${summary.spec.component}@${summary.spec.componentVersion} became Synced and Healthy.

| Check | Result |
| --- | --- |
| \`kubara cluster add\` onboarding | ${checks.kubaraClusterAdd} |
| Git/AppSet/AppProject source unchanged | ${checks.gitSourceUnchanged} |
| ConfigHub plan check + approval | ${checks.configHubPlanApproval} |
| OpenBao / External Secrets route | ${checks.openBaoExternalSecretRoute} |
| Argo spoke registration | ${checks.argoSpokeRegistration} |
| Selected Application sync | ${checks.applicationSync} |
| Selected Application health | ${checks.applicationHealth} |
| Exact cluster cleanup | ${checks.cleanup} |

ConfigHub approval is recorded on Provider None evidence Units. This proof does
not claim an enforced GitHub status or a server-side deployment gate.
`;
}

function writeSummaries(receipt) {
  writeYaml(summaryYamlPath, summaryFor(receipt));
  write(summaryMarkdownPath, renderSummaryMarkdown(receipt));
  console.log(`wrote ${relativeRepo(summaryYamlPath)}`);
  console.log(`wrote ${relativeRepo(summaryMarkdownPath)}`);
}

function verifySummaries(receipt) {
  for (const path of [summaryYamlPath, summaryMarkdownPath]) {
    check(existsSync(path), `${relativeRepo(path)} is missing; run --generate`);
  }
  check(
    normalized(readFileSync(summaryYamlPath, "utf8"))
      === normalized(`${toYaml(summaryFor(receipt))}\n`),
    `${relativeRepo(summaryYamlPath)} is stale`,
  );
  check(
    readFileSync(summaryMarkdownPath, "utf8") === renderSummaryMarkdown(receipt),
    `${relativeRepo(summaryMarkdownPath)} is stale`,
  );
}
