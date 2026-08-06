#!/usr/bin/env node

// Generate current and historical Kubara component-by-cluster evidence
// matrices. The primary view joins the v0.13 selection with committed effective
// renders and application fixtures. It overlays live fields only from a
// source-current mini-IDP reconciliation receipt. The deterministic desired
// matrix is emitted separately so the live receipt can attest it without a
// receipt -> publication -> receipt digest cycle. The secondary view joins the
// v0.12 selection with historical ConfigHub receipts. Missing observations stay
// explicitly Unknown.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { check, listFiles, readYaml, relativeRepo, repoRoot, sha256, sha256File, write } from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--generate";
const profileArg = option("--profile") ?? "current";
const requestedProfiles = process.argv.includes("--all") ? ["current", "historical-v0.12.0"] : [profileArg];
const historicalSources = {
  config: join(repoRoot, "examples", "kubara", "local-platform", "source", "config.yaml"),
  alignment: join(repoRoot, "examples", "kubara", "local-platform", "catalog-alignment.yaml"),
  single: join(repoRoot, "runs", "kubara-single-platform-proof", "receipt.yaml"),
  rollout: join(repoRoot, "runs", "kubara-app-rollout-proof", "receipt.yaml"),
};
const sources = historicalSources;
const currentSources = {
  config: join(repoRoot, "examples", "kubara", "current-platform", "source", "config.yaml"),
  sourceLock: join(repoRoot, "examples", "kubara", "current-platform", "source-lock.yaml"),
  artifacts: join(repoRoot, "examples", "kubara", "current-platform", "component-artifacts.yaml"),
  catalogParity: join(repoRoot, "examples", "kubara", "current-platform", "catalog-parity-receipt.yaml"),
  appSourceLock: join(repoRoot, "examples", "kubara", "current-platform", "apps", "source-lock.yaml"),
  effectiveRenders: join(repoRoot, "data", "kubara-effective-renders", "current-platform", "receipt.yaml"),
  faithfulReceipt: join(repoRoot, "runs", "kubara-faithful-hub-spoke", "receipt.yaml"),
  miniIdpReceipt: join(repoRoot, "runs", "kubara-mini-idp-reconcile", "receipt.yaml"),
  orphanReceipt: join(repoRoot, "runs", "kubara-mini-idp-reconcile", "orphan-audit.yaml"),
};
const orphanAuditor = join(repoRoot, "scripts", "audit-kubara-mini-idp-orphans.mjs");
const outputRoot = join(repoRoot, "data", "kubara-platform-matrix");

const COMPONENT_ORDER = [
  "argo-cd",
  "cert-manager",
  "external-secrets",
  "homer-dashboard",
  "kube-prometheus-stack",
  "metrics-server",
  "traefik",
  "hx-web",
  "cubbychat",
];
const PLATFORM_COMPONENTS = COMPONENT_ORDER.slice(0, 7);
const APPLICATION_COMPONENTS = COMPONENT_ORDER.slice(7);
const MINI_IDP_SOURCE_PATHS = {
  config: "examples/kubara/current-platform/source/config.yaml",
  sourceLock: "examples/kubara/current-platform/source-lock.yaml",
  componentArtifacts: "examples/kubara/current-platform/component-artifacts.yaml",
  generationReceipt: "examples/kubara/current-platform/generation-receipt.yaml",
  appSourceLock: "examples/kubara/current-platform/apps/source-lock.yaml",
  argoAppSetTemplate: "examples/kubara/current-platform/generated/platform-components/helm/template-library/templates/argocd/_argo.appset.tpl",
  argoValues: "examples/kubara/current-platform/generated/platform-configs/hx-app-dev/helm/argo-cd/values.generated.yaml",
  catalogFullCoverageReceipt: "data/kubara-catalog-1.1-full-coverage/receipt.yaml",
  adapterOutput: "data/kubara-catalog-adapter/adapter-output.yaml",
  adapterReceipt: "data/kubara-catalog-adapter/receipt.yaml",
  desiredMatrix: "data/kubara-platform-matrix/desired-matrix.json",
  wiring: "data/kubara-wiring/graph.json",
  effectiveReceipt: "data/kubara-effective-renders/current-platform/receipt.yaml",
  qualificationReceipt: "runs/kubara-current-live-qualification/receipt.yaml",
  promotionReceipt: "data/kubara-catalog-refresh/current-root-promotion/receipt.yaml",
  faithfulReceipt: "runs/kubara-faithful-hub-spoke/receipt.yaml",
};

if (["--generate", "--verify"].includes(mode)) {
  for (const profile of requestedProfiles) {
    check(["current", "historical-v0.12.0"].includes(profile), `unknown Kubara matrix profile ${profile}`);
    const report = profile === "current" ? buildCurrentReport() : buildHistoricalReport();
    if (profile === "current") {
      selfTestDesired(report.desiredDocument);
      selfTestCurrent(report.document);
      if (mode === "--verify") verifyCurrentLivePublication(report.document);
    }
    else selfTestHistorical(report.document);
    const outputs = outputPaths(profile);
    if (mode === "--generate") writeOutputs(report, outputs);
    else {
      for (const [name, path] of Object.entries(outputs)) {
        check(existsSync(path), `${relativeRepo(path)} is missing; generate matrix profile ${profile}`);
        check(readFileSync(path, "utf8") === report[name], `${relativeRepo(path)} is stale; generate matrix profile ${profile}`);
      }
    }
    console.log(`${mode === "--generate" ? "wrote" : "verified"} ${profile === "current" ? "primary-current" : "secondary-historical"} Kubara matrix: ${report.document.spec.rows.length} component×cluster cells`);
  }
} else if (mode === "--self-test") {
  const historical = buildHistoricalReport();
  selfTestHistorical(historical.document);
  if (existsSync(currentSources.effectiveRenders)) {
    const current = buildCurrentReport();
    selfTestDesired(current.desiredDocument);
    selfTestCurrent(current.document);
    selfTestFaithfulHashDomains();
    selfTestCurrentLivePublicationGate(current.document);
    selfTestMiniIdpReceiptValidation();
  }
  console.log("Kubara platform matrix self-tests passed");
} else {
  console.log(`Usage:
  node scripts/generate-kubara-platform-matrix.mjs --generate [--profile current|historical-v0.12.0|--all]
  node scripts/generate-kubara-platform-matrix.mjs --verify   [--profile current|historical-v0.12.0|--all]
  node scripts/generate-kubara-platform-matrix.mjs --self-test`);
}

function outputPaths(profile) {
  const root = profile === "current" ? outputRoot : join(outputRoot, "historical-v0.12.0");
  return profile === "current"
    ? { desiredJson: join(root, "desired-matrix.json"), json: join(root, "matrix.json"), csv: join(root, "matrix.csv"), summary: join(root, "summary.md"), html: join(root, "matrix.html") }
    : { json: join(root, "matrix.json"), csv: join(root, "matrix.csv"), summary: join(root, "summary.md"), html: join(root, "matrix.html") };
}

function buildCurrentReport(options = {}) {
  for (const [name, path] of Object.entries(currentSources).filter(([name]) => !["faithfulReceipt", "miniIdpReceipt", "orphanReceipt"].includes(name))) {
    check(existsSync(path), `${relativeRepo(path)} is missing; current matrix requires ${name}`);
  }
  const config = readYaml(currentSources.config);
  const sourceLock = readYaml(currentSources.sourceLock);
  const artifacts = readYaml(currentSources.artifacts);
  const appSourceLock = readYaml(currentSources.appSourceLock);
  const renderReceipt = readYaml(currentSources.effectiveRenders);
  const catalogParity = readYaml(currentSources.catalogParity);
  check(config?.clusters?.length === 4, `current Kubara fixture must have four clusters, found ${config?.clusters?.length ?? 0}`);
  check(artifacts?.kind === "KubaraComponentArtifactSet", "current component artifact index has unexpected kind");
  check(renderReceipt?.kind === "KubaraEffectiveRenderReceipt", "current effective-render receipt has unexpected kind");
  check(renderReceipt.spec?.profile?.role === "primary-current", "current effective-render receipt is not marked primary-current");

  check(appSourceLock?.kind === "KubaraMiniIDPApplicationSourceLock", "current application source lock has unexpected kind");
  const faithfulReceipt = existsSync(currentSources.faithfulReceipt) ? readYaml(currentSources.faithfulReceipt) : null;
  const faithfulEvaluation = evaluateFaithfulReceipt(faithfulReceipt, catalogParity);
  const components = currentComponents(artifacts, appSourceLock);
  const clusters = config.clusters.map((cluster) => ({
    name: cluster.name,
    environment: cluster.stage ?? "unknown",
    type: cluster.type ?? "unknown",
    argoSelfManaged: cluster.argocd?.selfManaged ?? "unspecified",
  }));
  const renderInstances = new Map((renderReceipt.spec?.instances ?? []).map((instance) => [`${instance.cluster}/${instance.component}`, instance]));
  const desiredEvaluation = receiptEvaluation("not-consumed-for-desired-artifact", "The desired matrix never consumes a live receipt.");
  const desiredOrphanEvaluation = {
    ...orphanReceiptEvaluation("not-consumed-for-desired-artifact", "The desired matrix never consumes an orphan receipt."),
    sha256: null,
  };
  const desiredDocument = currentDocument({ config, sourceLock, components, clusters, renderInstances, observations: new Map(), receipt: desiredEvaluation, faithfulEvaluation, orphanEvaluation: desiredOrphanEvaluation, desiredOnly: true });
  const desiredJson = `${JSON.stringify(desiredDocument, null, 2)}\n`;
  const miniIdpReceipt = options.miniIdpReceipt !== undefined
    ? options.miniIdpReceipt
    : existsSync(currentSources.miniIdpReceipt) ? readYaml(currentSources.miniIdpReceipt) : null;
  const evaluationOptions = {
    components,
    clusters,
    sourceDigest: options.sourceDigest ?? ((path, key) => key === "desiredMatrix" ? `sha256:${sha256(desiredJson)}` : localSourceDigest(path)),
    expectedSourcePaths: options.expectedSourcePaths ?? MINI_IDP_SOURCE_PATHS,
  };
  const receipt = validateMiniIdpReceipt(miniIdpReceipt, evaluationOptions);
  const orphanReceipt = options.orphanReceipt !== undefined
    ? options.orphanReceipt
    : existsSync(currentSources.orphanReceipt) ? readYaml(currentSources.orphanReceipt) : null;
  const orphanEvaluation = validateOrphanReceipt(orphanReceipt, miniIdpReceipt, options.verifyOrphanReceipt);
  const document = currentDocument({ config, sourceLock, components, clusters, renderInstances, observations: receipt.observations, receipt, faithfulEvaluation, orphanEvaluation, desiredOnly: false });
  return {
    desiredDocument,
    document,
    desiredJson,
    json: `${JSON.stringify(document, null, 2)}\n`,
    csv: currentCsvReport(document.spec.rows),
    summary: currentMarkdownReport(document),
    html: currentHtmlReport(document),
  };
}

function orphanReceiptEvaluation(status, ...reasons) {
  return {
    status,
    accepted: status === "accepted-current-scoped-residue-clean",
    reasons: reasons.filter(Boolean),
    path: relativeRepo(currentSources.orphanReceipt),
    name: null,
    observedAt: null,
    sha256: existsSync(currentSources.orphanReceipt) ? sha256File(currentSources.orphanReceipt) : null,
  };
}

function validateOrphanReceipt(receipt, miniIdpReceipt, verifyOverride) {
  if (!receipt) return orphanReceiptEvaluation("not-present", `${relativeRepo(currentSources.orphanReceipt)} is absent.`);
  const reasons = [];
  const rejectUnless = (condition, message) => { if (!condition) reasons.push(message); };
  rejectUnless(receipt.kind === "KubaraMiniIDPOrphanAuditReceipt", `kind is ${receipt.kind ?? "missing"}`);
  rejectUnless(receipt.metadata?.name === "kubara-v0-13-0-mini-idp-orphan-audit", `metadata.name is ${receipt.metadata?.name ?? "missing"}`);
  rejectUnless(receipt.status?.result === "pass", `result is ${receipt.status?.result ?? "missing"}`);
  rejectUnless(receipt.status?.zeroAuditedResidue === true, "zeroAuditedResidue is not true");
  rejectUnless(Number(receipt.status?.findingCount) === 0, `findingCount is ${receipt.status?.findingCount ?? "missing"}`);
  rejectUnless(Object.values(receipt.status?.orphanCounts ?? {}).length > 0 && Object.values(receipt.status?.orphanCounts ?? {}).every((value) => Number(value) === 0), "orphan counters are absent or non-zero");
  rejectUnless(receipt.spec?.organization?.externalID === miniIdpReceipt?.spec?.organization?.externalID, "organization differs from the mini-IDP receipt");
  rejectUnless(receipt.spec?.auditScope?.clusterWideOrphanFreeClaim === false, "receipt does not disclose its scoped, non-cluster-wide claim");
  rejectUnless(Date.parse(receipt.spec?.observedAt ?? "") >= Date.parse(miniIdpReceipt?.status?.observedAt ?? ""), "orphan observation predates the mini-IDP receipt");
  let verifierPassed = verifyOverride;
  if (verifierPassed === undefined) {
    try {
      execFileSync(process.execPath, [orphanAuditor, "--receipt-verify"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      verifierPassed = true;
    } catch {
      verifierPassed = false;
    }
  }
  rejectUnless(verifierPassed === true, "the canonical offline orphan receipt verifier rejected this receipt");
  if (reasons.length > 0) {
    return {
      ...orphanReceiptEvaluation("rejected", ...reasons),
      name: receipt.metadata?.name ?? null,
      observedAt: receipt.spec?.observedAt ?? null,
    };
  }
  return {
    ...orphanReceiptEvaluation("accepted-current-scoped-residue-clean", "The source-current canonical audit records zero findings and zero counters within its declared scope."),
    name: receipt.metadata.name,
    observedAt: receipt.spec.observedAt,
  };
}

function evaluateFaithfulReceipt(receipt, catalogParity) {
  if (!receipt) return { accepted: false, status: "not-present", reasons: ["faithful receipt is not present"] };
  const reasons = [];
  const expectedCount = Number(catalogParity?.spec?.comparison?.fileCount ?? 0);
  const generatedChecksumsPath = join(repoRoot, "examples", "kubara", "current-platform", "generated-checksums.txt");
  const expectedParityDigest = existsSync(generatedChecksumsPath) ? sha256File(generatedChecksumsPath) : null;
  const generated = currentGeneratedEvidence();
  const currentExample = receipt?.spec?.source?.currentExample ?? {};
  const remoteGit = receipt?.spec?.source?.git ?? {};
  if (receipt?.status?.result !== "pass") reasons.push(`receipt result is ${receipt?.status?.result ?? "missing"}`);
  if (catalogParity?.status?.result !== "pass") reasons.push("current catalog-parity receipt does not pass");
  if (catalogParity?.spec?.comparison?.outputTreeSha256 !== expectedParityDigest) reasons.push("catalog-parity digest does not match the current generated-checksums artifact in the catalog-parity hash domain");
  if (catalogParity?.spec?.sourceConfig?.sha256 !== sha256File(currentSources.config)) reasons.push("current catalog-parity source config digest is stale");
  if (generated.fileCount !== expectedCount) reasons.push(`current generated count ${generated.fileCount} does not match catalog-parity ${expectedCount}`);
  if (Number(currentExample.generatedFileCount ?? -1) !== expectedCount) reasons.push(`receipt generated count ${currentExample.generatedFileCount ?? "missing"} does not match current ${expectedCount}`);
  if (currentExample.generatedSha256 !== generated.sha256) reasons.push("receipt generated digest does not match the current generated tree in the faithful-proof hash domain");
  if (Number(remoteGit.generatedFileCount ?? -1) !== expectedCount) reasons.push(`remote-main generated count ${remoteGit.generatedFileCount ?? "missing"} does not match current ${expectedCount}`);
  if (remoteGit.generatedSha256 !== generated.sha256) reasons.push("remote-main generated digest does not match the current generated tree in the faithful-proof hash domain");
  if (currentExample.configSha256 !== catalogParity?.spec?.sourceConfig?.sha256) reasons.push("receipt config digest does not match the current catalog-parity source config");
  return {
    accepted: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : receipt?.status?.result === "pass" ? "stale-source" : "failed",
    reasons,
  };
}

function currentGeneratedEvidence() {
  const root = join(repoRoot, "examples", "kubara", "current-platform", "generated");
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
    fileCount: entries.length,
    sha256: sha256(JSON.stringify(entries)),
  };
}

function currentDocument({ config, sourceLock, components, clusters, renderInstances, observations, receipt, faithfulEvaluation, orphanEvaluation, desiredOnly }) {
  const rows = components.flatMap((component) => clusters.map((cluster) => currentMatrixCell(component, cluster, config, renderInstances, observations)));
  const statusCounts = countBy(rows, (row) => row.proofStatus);
  const unknowns = rows
    .filter((row) => row.presence !== "disabled-by-config" && (isUnknown(row.syncState) || isUnknown(row.observedVersion) || row.readiness?.result === "unknown"))
    .map((row) => ({ component: row.component, cluster: row.cluster, observedVersion: row.observedVersion, syncState: row.syncState, healthState: row.healthState, readiness: row.readiness?.result ?? "unknown", unknownReason: row.unknownReason, evidenceScope: row.evidenceScope }));
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraPlatformMatrix",
    metadata: { name: `kubara-v0.13.0-current-four-cluster${desiredOnly ? "-desired" : ""}` },
    spec: {
      profile: { id: "current-platform", role: "primary-current", evidenceLayer: desiredOnly ? "desired-only" : "optional-live-overlay" },
      evidence: {
        mode: receipt.accepted ? "current-config-plus-effective-render-plus-validated-mini-idp-live" : "current-config-plus-effective-render",
        kubaraVersion: sourceLock.spec?.kubara?.version ?? "unknown",
        catalogVersion: sourceLock.spec?.catalogs?.version ?? "unknown",
        sources: Object.fromEntries(Object.entries(currentSources).map(([name, path]) => [name, desiredOnly && ["faithfulReceipt", "miniIdpReceipt", "orphanReceipt"].includes(name) ? "not-consumed" : existsSync(path) ? relativeRepo(path) : "not-present"])),
        faithfulReceiptStatus: desiredOnly ? "not-consumed" : faithfulEvaluation.status,
        faithfulReceiptReasons: desiredOnly ? [] : faithfulEvaluation.reasons,
        miniIdpReceipt: {
          path: relativeRepo(currentSources.miniIdpReceipt),
          status: receipt.status,
          acceptedAsLive: receipt.accepted,
          reasons: receipt.reasons,
          observedAt: receipt.observedAt,
          sourceDigestsVerified: receipt.sourceDigestsVerified,
          parsedCells: receipt.observations.size,
        },
        orphanReceipt: {
          path: orphanEvaluation.path,
          status: orphanEvaluation.status,
          acceptedAsScopedResidueClean: orphanEvaluation.accepted,
          reasons: orphanEvaluation.reasons,
          name: orphanEvaluation.name,
          observedAt: orphanEvaluation.observedAt,
          sha256: orphanEvaluation.sha256,
        },
        parsedObservationCells: observations.size,
        liveReads: receipt.accepted ? ["The accepted receipt records kubectl and ConfigHub live reads; this generator performs no live read."] : [],
      },
      scope: {
        deliveryModel: receipt.accepted ? "ConfigHub-adapted mini-IDP with a local Argo reconciler on each cluster" : "Kubara-generated hub Argo CD with Git/ApplicationSets targeting three spokes",
        faithfulKubaraGitDelivery: !desiredOnly && faithfulEvaluation.accepted ? "source-current-receipt-pass-with-recorded-scope" : "not-proven-currently",
        components: components.length,
        platformComponents: PLATFORM_COMPONENTS.length,
        applications: APPLICATION_COMPONENTS.length,
        clusters: clusters.length,
        cells: rows.length,
      },
      vocabulary: {
        observed: "A source-current mini-IDP receipt records the exact ConfigHub release digest, Argo sync and health, and workload readiness for this cell.",
        watch: "Current live evidence exists, but controller sync or workload state is non-green.",
        "rendered-only": "The current Kubara config and effective render include this instance; no current live sync claim is made.",
        centralized: "No Argo CD instance is selected for this spoke; the current config assigns delivery to the hub Argo CD.",
        disabled: "The current Kubara config explicitly disables this component on this cluster.",
      },
      components,
      clusters,
      rows,
      unknowns,
      summary: { ...statusCounts, explicitUnknownCells: unknowns.length },
      claimBoundary: [
        "This is the primary current-platform matrix for Kubara v0.13.0 and catalogs 1.1.0.",
        "Rendered-only is desired-state evidence, not a live sync or workload assertion.",
        "The desired-matrix.json artifact never consumes live evidence and is the receipt's digest-pinned source-integrity base.",
        "The optional mini-IDP receipt is consumed only after current version, source digest, cardinality, and per-cell validation; absent or rejected evidence remains Unknown.",
        "The 36 cells include seven Kubara platform roles plus hx-web and cubbychat across four clusters.",
        "Spoke Argo CD cells are centralized, not silently treated as installed or disabled platform capability.",
        "The historical v0.12.0 adapted fleet matrix is retained separately and is not merged into current cells.",
      ],
    },
  };
}

function currentComponents(artifacts, appSourceLock) {
  const grouped = new Map();
  const rows = [
    ...(artifacts.spec?.artifacts ?? []),
    ...(artifacts.spec?.firstParty ?? []).filter((entry) => entry.deployable !== false).map((entry) => ({ ...entry, version: entry.wrapperVersion })),
  ];
  for (const row of rows) {
    const service = normalizeComponent(row.service);
    if (!grouped.has(service)) grouped.set(service, []);
    grouped.get(service).push({ identity: row.canonicalIdentity, selectedVersion: String(row.version ?? "unknown"), wrapperVersion: String(row.wrapperVersion ?? "unknown") });
  }
  const platform = PLATFORM_COMPONENTS.map((name) => {
    const selectedPackages = (grouped.get(name) ?? []).sort((left, right) => left.identity.localeCompare(right.identity));
    check(selectedPackages.length > 0, `current artifact index has no selected package for ${name}`);
    return {
      name,
      category: "platform-component",
      selectedPackages,
      selectedVersion: selectedPackages.map((entry) => `${shortIdentity(entry.identity)}@${entry.selectedVersion}`).join(" + "),
      wrapperVersion: selectedPackages[0].wrapperVersion,
      desiredVersion: receiptDesiredVersion(name, selectedPackages),
    };
  });
  const hxWebImage = appSourceLock.spec?.hxWeb?.image?.pinned;
  const cubbychat = appSourceLock.spec?.cubbychat;
  check(/^nginx@sha256:[0-9a-f]{64}$/.test(hxWebImage ?? ""), "hx-web source lock lacks its digest-pinned image");
  check(/^[0-9a-f]{40}$/.test(cubbychat?.upstream?.commit ?? ""), "cubbychat source lock lacks its exact upstream commit");
  check(Object.values(cubbychat?.images ?? {}).length === 3 && Object.values(cubbychat.images).every((value) => /@sha256:[0-9a-f]{64}$/.test(value)), "cubbychat source lock lacks three digest-pinned images");
  return [
    ...platform,
    {
      name: "hx-web",
      category: "application",
      selectedPackages: [{ identity: "app:hx-web", selectedVersion: hxWebImage, wrapperVersion: "not-applicable" }],
      selectedVersion: hxWebImage,
      wrapperVersion: "not-applicable",
      desiredVersion: "digest-pinned fixture",
    },
    {
      name: "cubbychat",
      category: "application",
      selectedPackages: [{ identity: "app:cubbychat", selectedVersion: cubbychat.upstream.commit, wrapperVersion: "not-applicable" }],
      selectedVersion: `commit ${cubbychat.upstream.commit}; 3 digest-pinned images`,
      wrapperVersion: "not-applicable",
      desiredVersion: cubbychat.upstream.commit,
    },
  ];
}

function currentMatrixCell(component, cluster, config, renderInstances, observations) {
  const clusterConfig = config.clusters.find((entry) => entry.name === cluster.name);
  const serviceConfig = clusterConfig.services?.[component.name];
  const application = component.category === "application";
  const argoAtHub = component.name === "argo-cd" && clusterConfig.argocd?.selfManaged === "enabled";
  const centralizedArgo = component.name === "argo-cd" && clusterConfig.argocd?.selfManaged === "disabled";
  const enabled = application || argoAtHub || serviceConfig?.status === "enabled";
  const disabled = !application && component.name !== "argo-cd" && serviceConfig?.status === "disabled";
  check(enabled || disabled || centralizedArgo, `current config has no explicit state for ${cluster.name}/${component.name}`);
  const key = `${cluster.name}/${component.name}`;
  const render = renderInstances.get(key);
  if (enabled && !application) check(render, `current effective-render receipt has no instance ${key}`);
  const observation = observations.get(key) ?? null;
  const overrides = declaredOverrides(cluster.name, component.name);
  const observedVersion = observation?.observedVersion ?? "Unknown";
  const syncState = observation?.syncState ?? "Unknown";
  const healthState = observation?.healthState ?? (disabled ? "NotApplicable" : "Unknown");
  const readiness = observation?.readiness ?? (disabled
    ? { result: "not-applicable", ready: 0, desired: 0, workloads: [] }
    : { result: "unknown", ready: null, desired: null, workloads: [] });
  const workloadState = readinessState(readiness);
  const presence = application ? "application-intent" : enabled ? "rendered-intent" : centralizedArgo ? "hub-managed" : "disabled-by-config";
  const proofStatus = currentProofStatus(presence, observation);
  const versionState = !enabled && !observation
    ? "not-applicable"
    : isUnknown(observedVersion)
      ? "selected-not-observed"
      : versionMatches(component, observedVersion) ? "matches-selection" : "recorded-departure";
  const departure = observation?.departure ?? null;
  const unknownReason = observation
    ? observation.unknownReason
    : disabled
      ? null
      : "No accepted source-current mini-IDP live observation exists for this cell.";
  const appEvidence = application
    ? [relativeRepo(currentSources.appSourceLock), ...listFiles(join(repoRoot, "examples", "kubara", "current-platform", "apps", component.name)).map(relativeRepo)]
    : [];
  return {
    component: component.name,
    category: component.category,
    cluster: cluster.name,
    environment: cluster.environment,
    clusterType: cluster.type,
    selectedVersion: component.selectedVersion,
    desiredVersion: observation?.desiredVersion ?? component.desiredVersion,
    observedVersion,
    versionState,
    presence,
    deliveryState: observation?.deliveryState ?? (disabled ? "not-selected" : "not-live-observed"),
    syncState,
    argoSyncState: syncState,
    healthState,
    readiness,
    workloadState,
    proofStatus,
    departure,
    departures: departure ? `${departure.id}: ${departure.reason}` : "none recorded",
    unknownReason,
    declaredOverrides: overrides,
    renderObjectCount: render?.objectCount ?? (application ? appEvidence.length - 1 : 0),
    renderSha256: render?.sha256 ?? "",
    evidenceScope: observation ? observation.evidenceScope : application ? "committed digest-pinned application fixture only" : enabled ? "committed current effective render only" : centralizedArgo ? "current hub/spoke config" : "current config disables component",
    evidence: [relativeRepo(currentSources.config), relativeRepo(currentSources.artifacts), ...appEvidence, ...(render ? [render.output, relativeRepo(currentSources.effectiveRenders)] : []), ...(observation ? [relativeRepo(currentSources.miniIdpReceipt)] : [])],
  };
}

function currentProofStatus(presence, observation) {
  if (presence === "disabled-by-config") return "disabled";
  if (!observation) return presence === "hub-managed" ? "centralized" : "rendered-only";
  if (observation.deliveryState !== "delivered") return "watch";
  if (observation.syncState === "Synced" && observation.healthState === "Healthy" && observation.readiness?.result === "pass") return "observed";
  return "watch";
}

function readinessState(readiness) {
  if (!readiness || readiness.result === "unknown") return "Unknown";
  if (readiness.result === "not-applicable") return "NotApplicable";
  return `${readiness.result} (${readiness.ready ?? "?"}/${readiness.desired ?? "?"} ready)`;
}

function versionMatches(component, observedVersion) {
  if (component.category === "application") {
    if (component.name === "hx-web") return String(observedVersion).includes("nginx") || String(observedVersion).includes("sha256:");
    return String(observedVersion).includes(component.desiredVersion) || String(observedVersion).includes("cubbychat");
  }
  return component.selectedPackages.every((entry) => normalizeVersion(observedVersion).includes(normalizeVersion(entry.selectedVersion)));
}

function declaredOverrides(cluster, component) {
  const root = join(repoRoot, "examples", "kubara", "current-platform", "source", "overrides", cluster, "helm", component);
  if (!existsSync(root)) return [];
  return listFiles(root).filter((path) => /\.ya?ml$/.test(path)).map(relativeRepo).sort();
}

function receiptDesiredVersion(name, selectedPackages) {
  if (name === "kube-prometheus-stack") {
    const stack = selectedPackages.find((entry) => entry.identity.endsWith("/kube-prometheus-stack"));
    const blackbox = selectedPackages.find((entry) => entry.identity.endsWith("/prometheus-blackbox-exporter"));
    check(stack && blackbox, "kube-prometheus-stack desired receipt identity is incomplete");
    return `${stack.selectedVersion} + blackbox ${blackbox.selectedVersion}`;
  }
  return selectedPackages[0].selectedVersion;
}

function localSourceDigest(path) {
  const absolutePath = join(repoRoot, path);
  return existsSync(absolutePath) ? `sha256:${sha256File(absolutePath)}` : null;
}

function receiptEvaluation(status, ...reasons) {
  return {
    status,
    accepted: status === "accepted-current-live",
    reasons: reasons.filter(Boolean),
    observedAt: null,
    sourceDigestsVerified: 0,
    observations: new Map(),
  };
}

function validateMiniIdpReceipt(receipt, { components, clusters, sourceDigest, expectedSourcePaths }) {
  if (!receipt) return receiptEvaluation("not-present", "runs/kubara-mini-idp-reconcile/receipt.yaml is absent; all live fields remain Unknown.");
  const reasons = [];
  const rejectUnless = (condition, message) => { if (!condition) reasons.push(message); };
  rejectUnless(receipt.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", `kind is ${receipt.kind ?? "missing"}`);
  rejectUnless(receipt.metadata?.name === "kubara-v0-13-0-confighub-mini-idp", `metadata.name is ${receipt.metadata?.name ?? "missing"}`);
  rejectUnless(receipt.spec?.source?.kubaraVersion === "v0.13.0", `Kubara version is ${receipt.spec?.source?.kubaraVersion ?? "missing"}, expected v0.13.0`);
  rejectUnless(receipt.spec?.source?.catalogVersion === "1.1.0", `catalog version is ${receipt.spec?.source?.catalogVersion ?? "missing"}, expected 1.1.0`);
  rejectUnless(receipt.spec?.source?.exactVersionPolicy === "fail-if-missing", "exact-version policy is not fail-if-missing");
  rejectUnless(receipt.spec?.source?.retentionPolicy === "additive-only", "retention policy is not additive-only");
  rejectUnless(receipt.status?.result === "pass", `receipt status is ${receipt.status?.result ?? "missing"}, expected pass`);
  rejectUnless(receipt.status?.fullCurrentSelectionDelivered === true, "receipt does not assert the full current selection was delivered");

  let sourceDigestsVerified = 0;
  const storedFiles = receipt.spec?.source?.files ?? {};
  for (const [key, path] of Object.entries(expectedSourcePaths)) {
    const stored = storedFiles[key];
    const actual = sourceDigest(path, key);
    rejectUnless(stored?.path === path, `source path ${key} is ${stored?.path ?? "missing"}, expected ${path}`);
    rejectUnless(/^sha256:[0-9a-f]{64}$/.test(stored?.sha256 ?? ""), `source digest ${key} is missing or malformed`);
    rejectUnless(actual !== null, `current source ${path} is absent`);
    if (stored?.path === path && stored?.sha256 === actual && actual !== null) sourceDigestsVerified += 1;
    else if (stored?.sha256 && actual) reasons.push(`source digest ${key} is stale`);
  }
  for (const key of Object.keys(storedFiles)) rejectUnless(Object.hasOwn(expectedSourcePaths, key), `receipt contains unexpected source key ${key}`);

  const matrix = receipt.spec?.liveMatrix;
  rejectUnless(matrix?.kind === "KubaraMiniIDPLiveMatrixObservation", `liveMatrix kind is ${matrix?.kind ?? "missing"}`);
  rejectUnless(matrix?.observationMode === "kubectl-and-confighub-live-read", `liveMatrix observation mode is ${matrix?.observationMode ?? "missing"}`);
  rejectUnless(matrix?.desiredSource === expectedSourcePaths.componentArtifacts, `liveMatrix desired source is ${matrix?.desiredSource ?? "missing"}`);
  const expectedCellCount = components.length * clusters.length;
  rejectUnless(matrix?.rowCount === expectedCellCount, `liveMatrix rowCount is ${matrix?.rowCount ?? "missing"}, expected ${expectedCellCount}`);
  rejectUnless(Array.isArray(matrix?.rows) && matrix.rows.length === expectedCellCount, `liveMatrix has ${matrix?.rows?.length ?? 0} rows, expected ${expectedCellCount}`);
  rejectUnless(receipt.spec?.counts?.liveMatrixRows === expectedCellCount, `receipt liveMatrixRows count is ${receipt.spec?.counts?.liveMatrixRows ?? "missing"}, expected ${expectedCellCount}`);

  const expectedByKey = new Map();
  for (const cluster of clusters) {
    for (const component of components) {
      expectedByKey.set(`${cluster.name}/${component.name}`, {
        component,
        deliveryState: expectedDeliveryState(component.name, cluster),
      });
    }
  }
  const rowsByKey = new Map();
  for (const row of matrix?.rows ?? []) {
    const key = `${row.cluster}/${normalizeComponent(row.component)}`;
    const expected = expectedByKey.get(key);
    rejectUnless(Boolean(expected), `liveMatrix contains unexpected cell ${key}`);
    rejectUnless(!rowsByKey.has(key), `liveMatrix duplicates cell ${key}`);
    if (!expected || rowsByKey.has(key)) continue;
    rowsByKey.set(key, row);
    rejectUnless(row.desiredVersion === expected.component.desiredVersion, `${key} desiredVersion is ${row.desiredVersion ?? "missing"}, expected ${expected.component.desiredVersion}`);
    rejectUnless(row.deliveryState === expected.deliveryState, `${key} deliveryState is ${row.deliveryState ?? "missing"}, expected ${expected.deliveryState}`);
    rejectUnless(typeof row.syncState === "string" && row.syncState.length > 0, `${key} syncState is missing`);
    rejectUnless(typeof row.healthState === "string" && row.healthState.length > 0, `${key} healthState is missing`);
    rejectUnless(row.readiness && ["pass", "fail", "unknown", "not-applicable"].includes(row.readiness.result), `${key} readiness is missing or invalid`);
    rejectUnless(Object.hasOwn(row, "observedVersion"), `${key} observedVersion field is missing`);
    rejectUnless(Object.hasOwn(row, "unknownReason"), `${key} unknownReason field is missing`);
    if (expected.deliveryState === "delivered") {
      rejectUnless(row.syncState === "Synced", `${key} delivered syncState is ${row.syncState}, expected Synced`);
      rejectUnless(row.readiness?.result !== "fail", `${key} delivered readiness failed`);
      if (row.observedVersion === null || row.readiness?.result === "unknown") rejectUnless(typeof row.unknownReason === "string" && row.unknownReason.length > 0, `${key} partial observation lacks an unknownReason`);
    } else {
      rejectUnless(row.syncState === "NotApplicable", `${key} not-selected syncState is ${row.syncState}, expected NotApplicable`);
      rejectUnless(row.healthState === "NotApplicable", `${key} not-selected healthState is ${row.healthState}, expected NotApplicable`);
      rejectUnless(row.readiness?.result === "not-applicable", `${key} not-selected readiness is ${row.readiness?.result}, expected not-applicable`);
    }
    if (row.departure !== null && row.departure !== undefined) {
      rejectUnless(typeof row.departure.id === "string" && row.departure.id.length > 0, `${key} departure id is missing`);
      rejectUnless(typeof row.departure.reason === "string" && row.departure.reason.length > 0, `${key} departure reason is missing`);
    }
  }
  for (const key of expectedByKey.keys()) rejectUnless(rowsByKey.has(key), `liveMatrix is missing cell ${key}`);
  if (reasons.length > 0) {
    return { ...receiptEvaluation("rejected", ...dedupe(reasons)), observedAt: receipt.status?.observedAt ?? null, sourceDigestsVerified };
  }

  const observations = new Map();
  for (const [key, row] of rowsByKey) {
    observations.set(key, {
      desiredVersion: row.desiredVersion,
      observedVersion: row.observedVersion === null || row.observedVersion === "" ? "Unknown" : String(row.observedVersion),
      deliveryState: row.deliveryState,
      syncState: row.syncState,
      healthState: row.healthState,
      readiness: normalizeReadiness(row.readiness),
      departure: row.departure ?? null,
      unknownReason: row.unknownReason ?? null,
      evidenceScope: "validated source-current liveMatrix row in runs/kubara-mini-idp-reconcile/receipt.yaml",
    });
  }
  return {
    status: "accepted-current-live",
    accepted: true,
    reasons: ["Kubara v0.13.0, all source digests, and all 36 liveMatrix cells validated."],
    observedAt: receipt.status?.observedAt ?? null,
    sourceDigestsVerified,
    observations,
  };
}

function expectedDeliveryState(component, cluster) {
  if (["argo-cd", "cert-manager", "traefik", ...APPLICATION_COMPONENTS].includes(component)) return "delivered";
  return cluster.environment === "dev" ? "delivered" : "not-selected";
}

function normalizeReadiness(value) {
  return {
    result: value.result,
    ready: value.ready ?? null,
    desired: value.desired ?? null,
    workloads: Array.isArray(value.workloads) ? value.workloads : [],
  };
}

function isUnknown(value) {
  return value === null || value === undefined || /^unknown$/i.test(String(value));
}

function dedupe(values) {
  return [...new Set(values)];
}

function currentCsvReport(rows) {
  const headers = ["component", "category", "cluster", "environment", "cluster_type", "selected_version", "desired_version", "observed_version", "version_state", "presence", "delivery_state", "argo_sync_state", "health_state", "readiness_result", "readiness_ready", "readiness_desired", "workload_state", "proof_status", "departure_id", "departure_reason", "unknown_reason", "declared_overrides", "render_object_count", "render_sha256", "evidence_scope", "evidence"];
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell({
    component: row.component, category: row.category, cluster: row.cluster, environment: row.environment, cluster_type: row.clusterType,
    selected_version: row.selectedVersion, desired_version: row.desiredVersion, observed_version: row.observedVersion, version_state: row.versionState,
    presence: row.presence, delivery_state: row.deliveryState, argo_sync_state: row.argoSyncState, health_state: row.healthState,
    readiness_result: row.readiness.result, readiness_ready: row.readiness.ready, readiness_desired: row.readiness.desired,
    workload_state: row.workloadState, proof_status: row.proofStatus, departure_id: row.departure?.id ?? "", departure_reason: row.departure?.reason ?? "",
    unknown_reason: row.unknownReason, declared_overrides: row.declaredOverrides.join(";"), render_object_count: row.renderObjectCount,
    render_sha256: row.renderSha256, evidence_scope: row.evidenceScope, evidence: row.evidence.join(";"),
  }[header])).join(",")).join("\n")}\n`;
}

function currentMarkdownReport(document) {
  const { components, clusters, rows, summary, evidence } = document.spec;
  const cell = (row) => `${currentStatusIcon(row.proofStatus)} **${row.proofStatus}**<br>Argo sync: ${escapeMd(row.syncState)}<br>health/ready: ${escapeMd(row.healthState)} / ${escapeMd(row.readiness.result)}<br>observed: ${escapeMd(row.observedVersion)}`;
  const gridRows = components.map((component) => `| ${component.name}<br>${escapeMd(component.selectedVersion)} | ${clusters.map((cluster) => cell(rows.find((row) => row.component === component.name && row.cluster === cluster.name))).join(" | ")} |`).join("\n");
  const unknownRows = document.spec.unknowns.map((row) => `| ${row.component} | ${row.cluster} | ${row.observedVersion} | ${escapeMd(row.syncState)} | ${escapeMd(row.healthState)} | ${escapeMd(row.readiness)} | ${escapeMd(row.unknownReason)} |`).join("\n") || "| — | — | — | — | — | — | — |";
  const overrideRows = rows.filter((row) => row.declaredOverrides.length > 0).map((row) => `| ${row.cluster} | ${row.component} | ${row.declaredOverrides.map((path) => `\`${path}\``).join("<br>")} |`).join("\n") || "| — | — | None. |";
  return `# Kubara Component × Cluster Matrix — primary current

This is the primary matrix for Kubara ${evidence.kubaraVersion} with official
catalogs ${evidence.catalogVersion}. It is generated from the four-cluster
current config, committed effective renders, and two digest-pinned app fixtures.
Historical v0.12.0 adapted
evidence is retained separately under [historical-v0.12.0](historical-v0.12.0/summary.md).

[Return to the Kubara buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html)
· [Browse the component-first Catalog](https://confighub.github.io/helm-expt/site/charts/)

Colored, accessible view: [matrix.html](matrix.html). Machine-readable forms:
[matrix.csv](matrix.csv) and [matrix.json](matrix.json).

## Matrix

| Component / selected version | ${clusters.map((cluster) => `${cluster.name}<br>${cluster.environment} / ${cluster.type}`).join(" | ")} |
| --- | ${clusters.map(() => "---").join(" | ")} |
${gridRows}

Status counts: ${Object.entries(summary).filter(([key]) => key !== "explicitUnknownCells").map(([key, value]) => `${key}=${value}`).join(", ")}.
Purple \`rendered-only\` means desired state is committed and mechanically
rendered but sync/workload state is unknown. Blue \`centralized\` records that
spokes are managed by hub Argo CD rather than pretending an Argo instance is
installed on each spoke.

Live overlay receipt: \`${evidence.miniIdpReceipt.path}\` (validation:
\`${evidence.miniIdpReceipt.status}\`; accepted as live:
\`${evidence.miniIdpReceipt.acceptedAsLive}\`; source digests verified:
${evidence.miniIdpReceipt.sourceDigestsVerified}; parsed cells:
${evidence.parsedObservationCells}). Validation notes:
${evidence.miniIdpReceipt.reasons.map((reason) => `- ${escapeMd(reason)}`).join("\n")}

Scoped residue audit: \`${evidence.orphanReceipt.path}\` (validation:
\`${evidence.orphanReceipt.status}\`; accepted:
\`${evidence.orphanReceipt.acceptedAsScopedResidueClean}\`; observed:
\`${evidence.orphanReceipt.observedAt ?? "not present"}\`; SHA-256:
\`${evidence.orphanReceipt.sha256 ?? "not present"}\`). It proves exact ConfigHub
inventory, zero Argo-prunable resources, and zero unclassified, dangling, or
UID-stale workloads among the five audited durable types. It does not claim a
complete inventory of every Kubernetes resource type.

The non-live [desired-matrix.json](desired-matrix.json) is generated first and
digest-pinned by the reconciliation receipt. The final matrix overlays that
base only after the receipt proves Kubara v0.13.0, all current source digests,
and all 36 component/application cells. The faithful-lane receipt remains
separate topology evidence (status: \`${evidence.faithfulReceiptStatus}\`).

## Explicit unknowns

| Component | Cluster | Observed version | Argo sync | Health | Readiness | Why Unknown |
| --- | --- | --- | --- | --- | --- | --- |
${unknownRows}

## Declared values overrides

These are normal Kubara input overlays, not silently reclassified as live
departures.

| Cluster | Component | Override file(s) |
| --- | --- | --- |
${overrideRows}

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --verify --profile current
node scripts/generate-kubara-platform-matrix.mjs --generate --profile current
node scripts/generate-kubara-platform-matrix.mjs --verify --profile current
node scripts/generate-kubara-platform-matrix.mjs --self-test
~~~
`;
}

function currentHtmlReport(document) {
  const { components, clusters, rows, evidence } = document.spec;
  const gridRows = components.map((component) => `<tr><th scope="row">${escapeHtml(component.name)}<span class="selected">selected: ${escapeHtml(component.selectedVersion)}</span></th>${clusters.map((cluster) => {
    const row = rows.find((entry) => entry.component === component.name && entry.cluster === cluster.name);
    const label = `${row.proofStatus}; Argo sync ${row.syncState}; health ${row.healthState}; readiness ${row.readiness.result}; observed version ${row.observedVersion}`;
    return `<td class="matrix-cell ${currentStatusClass(row.proofStatus)}" aria-label="${escapeHtml(label)}"><strong><span aria-hidden="true">${currentStatusGlyph(row.proofStatus)}</span> ${escapeHtml(row.proofStatus)}</strong><span>Argo sync: ${escapeHtml(row.syncState)}</span><span>health / ready: ${escapeHtml(row.healthState)} / ${escapeHtml(row.readiness.result)}</span><span>observed: ${escapeHtml(row.observedVersion)}</span></td>`;
  }).join("")}</tr>`).join("\n");
  const detailRows = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.component)}</th><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.cluster)}</td><td>${escapeHtml(row.presence)}</td><td>${escapeHtml(row.desiredVersion)}</td><td>${escapeHtml(row.observedVersion)}</td><td>${escapeHtml(row.syncState)}</td><td>${escapeHtml(row.healthState)}</td><td>${escapeHtml(row.workloadState)}</td><td class="status ${currentStatusClass(row.proofStatus)}">${currentStatusGlyph(row.proofStatus)} ${escapeHtml(row.proofStatus)}</td><td>${escapeHtml(row.departures)}</td><td>${escapeHtml(row.unknownReason ?? "")}</td><td>${row.declaredOverrides.map((path) => `<code>${escapeHtml(path)}</code>`).join("<br>") || "none"}</td><td>${escapeHtml(row.evidenceScope)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kubara current component by cluster matrix</title>
<style>:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.7rem;margin-bottom:.25rem}.lede,.boundary{max-width:95ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key,.status{border-radius:.25rem;padding:.3rem .5rem;font-weight:700}.observed{background:#d7f2df;color:#14532d}.watch{background:#fff0bd;color:#634b00}.rendered-only{background:#eadcff;color:#4a2573}.centralized{background:#dce9ff;color:#173b75}.disabled{background:#edf1f5;color:#344454}table{border-collapse:collapse;width:100%;margin:1.25rem 0;font-size:.84rem}caption{text-align:left;font-size:1rem;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.5rem;text-align:left;vertical-align:top}thead th{background:#edf1f5;color:#17212b;position:sticky;top:0}.matrix-cell{min-width:12rem}.matrix-cell span,.selected{display:block;font-weight:400;margin-top:.2rem}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede,.boundary{color:#c6d1dc}thead th{background:#25313d;color:#fff}.observed{background:#14532d;color:#fff}.watch{background:#634b00;color:#fff}.rendered-only{background:#4a2573;color:#fff}.centralized{background:#173b75;color:#fff}.disabled{background:#344454;color:#fff}}</style></head>
<body><main><h1>Kubara component × cluster matrix — primary current</h1>
<nav aria-label="Kubara example navigation"><a href="https://confighub.github.io/helm-expt/site/kubara.html">Kubara buyer journey</a> · <a href="https://confighub.github.io/helm-expt/site/charts/">Component Catalog</a></nav>
<p class="lede">Kubara ${escapeHtml(evidence.kubaraVersion)}, catalogs ${escapeHtml(evidence.catalogVersion)}. Seven platform roles and two applications across four clusters. Live overlay: ${escapeHtml(evidence.miniIdpReceipt.status)}; ${evidence.miniIdpReceipt.sourceDigestsVerified} source digests verified. Status is written as text and symbol, with color supplementary.</p>
<p class="lede"><strong>Scoped ConfigHub/Argo residue audit: ${evidence.orphanReceipt.acceptedAsScopedResidueClean ? "✓ pass" : "not accepted"}</strong>. Receipt: <code>${escapeHtml(evidence.orphanReceipt.name ?? "not present")}</code>; observed: ${escapeHtml(evidence.orphanReceipt.observedAt ?? "not present")}; SHA-256: <code>${escapeHtml(evidence.orphanReceipt.sha256 ?? "not present")}</code>. It proves exact ConfigHub inventory, no Argo-prunable resources, and no unclassified or UID-stale audited durable workloads; it is not a complete inventory of every Kubernetes resource type.</p>
<div class="legend" aria-label="Proof status legend"><span class="key observed">✓ observed</span><span class="key watch">! watch</span><span class="key rendered-only">◐ rendered-only</span><span class="key centralized">↔ centralized</span><span class="key disabled">– disabled</span></div>
<p class="boundary"><strong>Boundary:</strong> rendered-only is desired state, not live sync. Final cells consume the mini-IDP receipt only when its current Kubara version, source digests, and all 36 rows validate. Missing or partial observed fields stay Unknown with their reason. <a href="desired-matrix.json">desired-matrix.json</a> is the deterministic, non-live base.</p>
<table><caption>Current components by cluster</caption><thead><tr><th scope="col">Component / selection</th>${clusters.map((cluster) => `<th scope="col">${escapeHtml(cluster.name)}<br>${escapeHtml(cluster.environment)} / ${escapeHtml(cluster.type)}</th>`).join("")}</tr></thead><tbody>${gridRows}</tbody></table>
<table><caption>Current cell details</caption><thead><tr><th scope="col">Component</th><th scope="col">Category</th><th scope="col">Cluster</th><th scope="col">Presence</th><th scope="col">Desired</th><th scope="col">Observed</th><th scope="col">Argo sync</th><th scope="col">Health</th><th scope="col">Readiness</th><th scope="col">Status</th><th scope="col">Departure</th><th scope="col">Why Unknown</th><th scope="col">Declared overrides</th><th scope="col">Evidence scope</th></tr></thead><tbody>${detailRows}</tbody></table>
<p><a href="https://confighub.github.io/helm-expt/site/kubara.html">Return to the Kubara buyer journey</a> · <a href="https://confighub.github.io/helm-expt/site/charts/">Browse every retained component version</a></p>
</main></body></html>
`;
}

function currentStatusIcon(status) {
  return ({ observed: "✅", watch: "⚠️", "rendered-only": "🟣", centralized: "🔁", disabled: "➖" })[status] ?? "❔";
}

function currentStatusGlyph(status) {
  return ({ observed: "✓", watch: "!", "rendered-only": "◐", centralized: "↔", disabled: "–" })[status] ?? "?";
}

function currentStatusClass(status) {
  return ["observed", "watch", "rendered-only", "centralized", "disabled"].includes(status) ? status : "watch";
}

function buildHistoricalReport() {
  for (const path of Object.values(sources)) check(existsSync(path), `${relativeRepo(path)} is missing`);
  const config = readYaml(sources.config);
  const alignment = readYaml(sources.alignment);
  const single = readYaml(sources.single);
  const rollout = readYaml(sources.rollout);
  const inputs = { config, alignment, single, rollout };
  validateInputs(inputs);

  const components = selectedComponents(config, alignment);
  const clusters = fleetClusters(rollout);
  const departures = departureCatalog(single, rollout);
  const rows = components.flatMap((component) => clusters.map((cluster) => matrixCell(component, cluster, inputs, departures)));
  const statusCounts = countBy(rows, (row) => row.proofStatus);
  const unknownRows = rows.filter((row) => row.presence !== "not-delivered" && (row.observedVersion === "unknown" || row.syncState === "unknown" || row.syncState.startsWith("partial:")));
  const document = {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraPlatformMatrix",
    metadata: { name: "kubara-v0.12.0-adapted-confighub-fleet" },
    spec: {
      evidence: {
        mode: "committed-receipt-join",
        recordedAt: {
          singlePlatform: single.spec?.recordedAt ?? "unknown",
          appRollout: rollout.spec?.recordedAt ?? "unknown",
        },
        sources: Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, relativeRepo(path)])),
        liveReads: [],
      },
      scope: {
        kubaraVersion: alignment.metadata?.name?.includes("v0-12-0") ? "v0.12.0" : "unknown",
        deliveryModel: "adapted ConfigHub variant/OCI -> ConfigHub-owned Argo CD/argobot",
        faithfulKubaraGitDelivery: false,
        components: components.length,
        clusters: clusters.length,
        cells: rows.length,
      },
      vocabulary: {
        observed: "Workload and exact component sync evidence are both recorded for this cell.",
        watch: "The workload is observed, but controller sync is non-green or a material proof limit remains.",
        partial: "The workload is observed, but exact component sync and/or observed-version evidence is missing.",
        substituted: "The Kubara role is present through an explicitly recorded replacement, not its selected Kubara wrapper.",
        "not-delivered": "The receipt explicitly limits this component to another cluster; this is not an unknown deployment claim.",
      },
      components,
      clusters,
      departures,
      rows,
      unknowns: unknownRows.map((row) => ({
        component: row.component,
        cluster: row.cluster,
        observedVersion: row.observedVersion,
        syncState: row.syncState,
        evidenceScope: row.evidenceScope,
      })),
      summary: {
        ...statusCounts,
        explicitUnknownCells: unknownRows.length,
      },
      claimBoundary: [
        "This matrix joins historical committed receipts and does not query current ConfigHub, Argo CD, or Kubernetes state.",
        "The four-cluster proof uses ConfigHub-owned Argo CD and adapted per-cluster delivery; it is not the faithful Kubara Git/ApplicationSet lane.",
        "A selected package version is not reported as observed unless the receipt records the running version.",
        "Fleet-summary Argo states are repeated per cell with evidenceScope=fleet-summary; they are not represented as individually queried cluster states.",
      ],
    },
  };
  return {
    document,
    json: `${JSON.stringify(document, null, 2)}\n`,
    csv: csvReport(rows),
    summary: markdownReport(document),
    html: htmlReport(document),
  };
}

function writeOutputs(report, outputs) {
  for (const [name, path] of Object.entries(outputs)) write(path, report[name]);
}

function validateInputs({ config, alignment, single, rollout }) {
  check(config?.clusters?.length === 1, "Kubara source fixture must contain exactly one declared test cluster");
  check(alignment?.kind === "KubaraCatalogAlignment", "catalog alignment has unexpected kind");
  check(single?.kind === "ConfigHubKubaraSinglePlatformReceipt", "single-platform receipt has unexpected kind");
  check(rollout?.kind === "ConfigHubManagedArgoAppRolloutReceipt", "app-rollout receipt has unexpected kind");
  const singleClusters = [...(single.spec?.clusters ?? [])].sort();
  const rolloutClusters = [...(rollout.spec?.kubaraPlatform?.clusters ?? [])].sort();
  check(JSON.stringify(singleClusters) === JSON.stringify(rolloutClusters), "Kubara receipts describe different fleet cluster sets");
}

function selectedComponents(config, alignment) {
  const enabled = Object.entries(config.clusters?.[0]?.services ?? {})
    .filter(([, service]) => service?.status === "enabled")
    .map(([name]) => normalizeComponent(name));
  check(JSON.stringify(enabled.sort()) === JSON.stringify([...PLATFORM_COMPONENTS].sort()), "enabled Kubara service set differs from the expected seven-role fixture");

  const byService = new Map();
  for (const row of alignment.spec?.components ?? []) {
    const service = normalizeComponent(row.kubara?.service ?? "");
    if (!service) continue;
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service).push({
      identity: row.canonicalIdentity,
      selectedVersion: String(row.kubara?.selectedVersion ?? row.kubara?.wrapperVersion ?? "unknown"),
      wrapperVersion: String(row.kubara?.wrapperVersion ?? "unknown"),
    });
  }
  return PLATFORM_COMPONENTS.map((name) => {
    const packages = (byService.get(name) ?? []).sort((left, right) => left.identity.localeCompare(right.identity));
    check(packages.length > 0, `catalog alignment has no row for enabled Kubara service ${name}`);
    return {
      name,
      kubaraService: name === "argo-cd" ? "argocd" : name,
      selectedPackages: packages,
      selectedVersion: packages.map((entry) => `${shortIdentity(entry.identity)}@${entry.selectedVersion}`).join(" + "),
      wrapperVersion: packages[0].wrapperVersion,
    };
  });
}

function fleetClusters(rollout) {
  const topology = new Map((rollout.spec?.topology?.clusters ?? []).map((cluster) => [cluster.name, cluster]));
  return (rollout.spec?.kubaraPlatform?.clusters ?? []).map((name) => {
    const detail = topology.get(name) ?? {};
    return {
      name,
      environment: detail.role ?? environmentFromName(name),
      receiptKey: name.replace(/^hx-app-/, ""),
      region: detail.region ?? "",
      argoAppsSpace: detail.argoAppsSpace ?? "",
    };
  });
}

function matrixCell(component, cluster, inputs, departures) {
  const { single, rollout } = inputs;
  const devServices = new Map((single.spec?.platform?.services ?? []).map((service) => [normalizeComponent(service.name), service]));
  const fleetServices = new Map((rollout.spec?.kubaraPlatform?.servicesDelivered ?? []).map((service) => [normalizeComponent(service.name), service]));
  const isDev = cluster.environment === "dev";
  const fleetService = fleetServices.get(component.name);
  const devService = devServices.get(component.name);
  const isArgoSubstitute = component.name === "argo-cd";
  const present = isArgoSubstitute || Boolean(fleetService) || (isDev && Boolean(devService));

  if (!present) {
    return {
      component: component.name,
      cluster: cluster.name,
      environment: cluster.environment,
      region: cluster.region,
      selectedVersion: component.selectedVersion,
      observedVersion: "not-observed",
      versionState: "not-delivered",
      presence: "not-delivered",
      syncState: "not-applicable",
      workloadState: "not-delivered-in-receipt-scope",
      proofStatus: "not-delivered",
      departureIds: [],
      departures: "none; component is outside this cluster's recorded proof scope",
      evidenceScope: "explicit receipt scope limit",
      evidence: [relativeRepo(sources.single)],
    };
  }

  const observed = observedVersion(component.name, fleetService, devService);
  const versionState = versionStateFor(component, observed, isArgoSubstitute);
  const sync = syncEvidence(component.name, cluster, single, rollout);
  const workload = workloadEvidence(component.name, fleetService, devService, isArgoSubstitute);
  const departureIds = departures
    .filter((departure) => departure.components.includes(component.name) && departure.appliesTo.includes(cluster.name))
    .map((departure) => departure.id);
  const proofStatus = proofStatusFor(component.name, sync, workload, isArgoSubstitute);
  return {
    component: component.name,
    cluster: cluster.name,
    environment: cluster.environment,
    region: cluster.region,
    selectedVersion: component.selectedVersion,
    observedVersion: observed,
    versionState,
    presence: isArgoSubstitute ? "substituted" : "present",
    syncState: sync.state,
    workloadState: workload,
    proofStatus,
    departureIds,
    departures: departureIds.length > 0 ? departureIds.map((id) => departures.find((item) => item.id === id)?.summary).join("; ") : "none recorded",
    evidenceScope: sync.scope,
    evidence: [...new Set(sync.evidence)],
  };
}

function observedVersion(component, fleetService, devService) {
  if (component === "argo-cd") return "unknown";
  const value = fleetService?.version ?? devService?.version;
  if (!value) return "unknown";
  if (component === "kube-prometheus-stack") {
    const match = String(value).match(/^([^\s]+)/);
    return match ? `${match[1]} (kube-prometheus-stack); prometheus-blackbox-exporter unknown` : "unknown";
  }
  return String(value);
}

function versionStateFor(component, observed, substituted) {
  if (substituted) return "substituted-observed-version-unknown";
  if (observed === "unknown") return "unknown";
  const primarySelected = component.selectedPackages[0]?.selectedVersion ?? "unknown";
  const primaryObserved = observed.split(" ")[0];
  return normalizeVersion(primarySelected) === normalizeVersion(primaryObserved) ? "matches-selection" : "recorded-departure";
}

function syncEvidence(component, cluster, single, rollout) {
  const rolloutPath = relativeRepo(sources.rollout);
  const singlePath = relativeRepo(sources.single);
  if (component === "argo-cd") {
    const state = rollout.spec?.argobot?.[cluster.receiptKey] ?? "unknown";
    return { state: state === "unknown" ? "unknown" : `${state} (argobot delivery app)`, scope: "per-cluster argobot summary; Kubara argo-cd is substituted", evidence: [rolloutPath] };
  }
  if (["cert-manager", "traefik"].includes(component)) {
    const note = (rollout.spec?.kubaraPlatform?.argoStatusNotes ?? []).find((entry) => String(entry).startsWith(component));
    const match = String(note ?? "").match(/report\s+([^:]+):/);
    return { state: match?.[1] ?? "unknown", scope: "fleet-summary; not individually enumerated per cluster", evidence: [rolloutPath] };
  }
  if (component === "external-secrets" && cluster.environment === "dev") {
    const apps = Object.values(single.spec?.evidence?.hxAppDev?.externalSecretsApps ?? {});
    const states = [...new Set(apps.map((value) => String(value).split(";")[0]))];
    return { state: states.length === 1 ? `${states[0]} (${apps.length} split apps)` : `partial: ${states.join(", ") || "unknown"}`, scope: "per-application dev evidence", evidence: [singlePath] };
  }
  if (component === "kube-prometheus-stack" && cluster.environment === "dev") {
    const crds = single.spec?.evidence?.hxAppDev?.kpsCrds;
    const state = String(crds ?? "").split(" with ")[0] || "unknown";
    return { state: `partial: CRD app ${state}; main app sync unknown`, scope: "dev CRD app exact; main app not recorded", evidence: [singlePath] };
  }
  if (["homer-dashboard", "metrics-server"].includes(component) && cluster.environment === "dev") {
    return { state: "unknown", scope: "dev workload recorded; exact component Argo state not recorded", evidence: [singlePath] };
  }
  return { state: "unknown", scope: "no exact sync evidence", evidence: [singlePath] };
}

function workloadEvidence(component, fleetService, devService, substituted) {
  if (substituted) return "ConfigHub-owned Argo CD + argobot recorded; Argo workload version/readiness not separately recorded";
  return String(fleetService?.state ?? devService?.state ?? "unknown");
}

function proofStatusFor(component, sync, workload, substituted) {
  if (substituted) return "substituted";
  if (sync.state === "unknown" || sync.state.startsWith("partial:")) return "partial";
  if (sync.state === "Synced/Healthy" || sync.state.startsWith("Synced/Healthy (")) return "observed";
  if (workload !== "unknown") return "watch";
  return "partial";
}

function departureCatalog(single, rollout) {
  const clusters = rollout.spec?.kubaraPlatform?.clusters ?? [];
  const dev = clusters.filter((name) => name.endsWith("-dev"));
  const finding = (id) => {
    const value = (single.spec?.findings ?? []).find((item) => item.id === id);
    check(value, `single-platform receipt is missing finding ${id}`);
    return value.detail;
  };
  const rolloutService = (name) => {
    const value = (rollout.spec?.kubaraPlatform?.servicesDelivered ?? []).find((item) => item.name === name);
    check(value, `app-rollout receipt is missing service ${name}`);
    return value;
  };
  const limit = (pattern) => {
    const value = (rollout.status?.limits ?? []).find((item) => String(item).includes(pattern));
    check(value, `app-rollout receipt is missing limit containing ${pattern}`);
    return value;
  };
  const singleService = (name) => {
    const value = (single.spec?.platform?.services ?? []).find((item) => item.name === name);
    check(value, `single-platform receipt is missing service ${name}`);
    return value;
  };
  const allNonArgo = PLATFORM_COMPONENTS.filter((name) => name !== "argo-cd");
  return [
    departure("adapted-delivery", allNonArgo, clusters, "ConfigHub variant/OCI delivery replaces the native Kubara Git/ApplicationSet delivery path in this proof.", relativeRepo(sources.rollout), "spec.kubaraPlatform.source", rollout.spec?.kubaraPlatform?.source),
    departure("argo-owner-substitution", ["argo-cd"], clusters, "ConfigHub-owned Argo CD plus argobot replaces Kubara's selected argo-cd wrapper.", relativeRepo(sources.single), "spec.argoOwner", single.spec?.argoOwner),
    departure("cert-manager-cr-ordering", ["cert-manager"], clusters, "ClusterIssuer and ServiceMonitor were split from the controller render for CRD-before-CR ordering.", relativeRepo(sources.rollout), "spec.kubaraPlatform.servicesDelivered[cert-manager].note", rolloutService("cert-manager").note),
    departure("cert-manager-kind-issuer", ["cert-manager"], clusters, "The kind proof uses a self-signed issuer instead of Kubara's public Let's Encrypt ACME issuer.", relativeRepo(sources.rollout), "status.limits", limit("self-signed ClusterIssuer")),
    departure("traefik-monitoring-strip", ["traefik"], clusters, "ServiceMonitor was stripped in the adapted render; the Prometheus API was declared to satisfy the wrapper's render guard.", relativeRepo(sources.rollout), "spec.kubaraPlatform.servicesDelivered[traefik].note", rolloutService("traefik").note),
    departure("traefik-kind-loadbalancer", ["traefik"], clusters, "Traefik remains Progressing because its LoadBalancer has no MetalLB on kind, while its pod is serving.", relativeRepo(sources.rollout), "spec.kubaraPlatform.argoStatusNotes", (rollout.spec?.kubaraPlatform?.argoStatusNotes ?? []).find((item) => String(item).startsWith("traefik"))),
    departure("external-secrets-fake-provider", ["external-secrets"], dev, "The dev proof uses external-secrets' fake provider, not a production secret backend.", relativeRepo(sources.single), "spec.findings[external-secrets-fake-provider-contract]", finding("external-secrets-fake-provider-contract")),
    departure("external-secrets-namespace-adaptation", ["external-secrets"], dev, "A redundant Namespace/default object was removed after a shared-resource conflict.", relativeRepo(sources.single), "spec.findings[external-secrets-shared-namespace]", finding("external-secrets-shared-namespace")),
    departure("homer-namespace-adaptation", ["homer-dashboard"], dev, "The live Units were assigned a namespace because the wrapper render omitted it.", relativeRepo(sources.single), "spec.findings[render-omits-namespace]", finding("render-omits-namespace")),
    departure("kps-version-departure", ["kube-prometheus-stack"], dev, "The live proof used kube-prometheus-stack 87.19.0 because the selected 87.15.1 archive was unavailable from the repository index at run time.", relativeRepo(sources.single), "spec.findings[pinned-version-pruned]", finding("pinned-version-pruned")),
    departure("kps-crd-split-ssa", ["kube-prometheus-stack"], dev, "Large monitoring CRDs were split and reconciled with server-side apply.", relativeRepo(sources.single), "spec.findings[large-crd-annotation-limit]", finding("large-crd-annotation-limit")),
    departure("external-secrets-dev-scope", ["external-secrets"], dev, "External Secrets is evidenced on dev only in the committed platform receipt.", relativeRepo(sources.single), "spec.platform.services[external-secrets]", singleService("external-secrets").note),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function departure(id, components, appliesTo, summary, source, path, sourceExcerpt) {
  return { id, components: [...components].sort(), appliesTo: [...appliesTo].sort(), summary, evidence: { source, path, sourceExcerpt: String(sourceExcerpt ?? "") } };
}

function csvReport(rows) {
  const headers = ["component", "cluster", "environment", "region", "selected_version", "observed_version", "version_state", "presence", "sync_state", "workload_state", "proof_status", "departure_ids", "departures", "evidence_scope", "evidence"];
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell({
    component: row.component,
    cluster: row.cluster,
    environment: row.environment,
    region: row.region,
    selected_version: row.selectedVersion,
    observed_version: row.observedVersion,
    version_state: row.versionState,
    presence: row.presence,
    sync_state: row.syncState,
    workload_state: row.workloadState,
    proof_status: row.proofStatus,
    departure_ids: row.departureIds.join(";"),
    departures: row.departures,
    evidence_scope: row.evidenceScope,
    evidence: row.evidence.join(";"),
  }[header])).join(",")).join("\n")}\n`;
}

function markdownReport(document) {
  const { components, clusters, rows, departures, summary, evidence } = document.spec;
  const cell = (row) => `${statusIcon(row.proofStatus)} **${row.proofStatus}**<br>sync: ${escapeMd(row.syncState)}<br>observed: ${escapeMd(row.observedVersion)}`;
  const gridRows = components.map((component) => {
    const cells = clusters.map((cluster) => cell(rows.find((row) => row.component === component.name && row.cluster === cluster.name)));
    return `| ${component.name}<br>${escapeMd(component.selectedVersion)} | ${cells.join(" | ")} |`;
  }).join("\n");
  const unknownRows = document.spec.unknowns.map((row) => `| ${row.component} | ${row.cluster} | ${row.observedVersion} | ${escapeMd(row.syncState)} | ${escapeMd(row.evidenceScope)} |`).join("\n") || "| — | — | — | — | — |";
  const departureRows = departures.map((item) => `| \`${item.id}\` | ${item.components.join(", ")} | ${item.appliesTo.join(", ")} | ${escapeMd(item.summary)} | \`${item.evidence.source}\` → \`${item.evidence.path}\` |`).join("\n");
  return `# Kubara Component × Cluster Matrix

This generated matrix joins the committed single-platform and four-cluster app
rollout receipts. It is a historical evidence view, not a current live query.
The proof uses ConfigHub-owned Argo CD and adapted variant/OCI delivery, so it
must not be presented as faithful Kubara Git/ApplicationSet delivery.

Colored, accessible view: [matrix.html](matrix.html). Machine-readable forms:
[matrix.csv](matrix.csv) and [matrix.json](matrix.json).

Receipt times: single-platform \`${evidence.recordedAt.singlePlatform}\`;
app-rollout \`${evidence.recordedAt.appRollout}\`.

## Matrix

| Component / selected version | ${clusters.map((cluster) => `${cluster.name}<br>${cluster.environment}${cluster.region ? ` / ${cluster.region}` : ""}`).join(" | ")} |
| --- | ${clusters.map(() => "---").join(" | ")} |
${gridRows}

Status counts: ${Object.entries(summary).filter(([key]) => key !== "explicitUnknownCells").map(([key, value]) => `${key}=${value}`).join(", ")}. A green
\`observed\` cell requires both workload and exact component sync evidence.
Amber \`watch\` and purple \`partial\` cells are intentionally not promoted to
pass. Blue \`substituted\` means the role exists through a recorded replacement.

## Explicit unknowns in present cells

| Component | Cluster | Observed version | Sync state | Evidence scope |
| --- | --- | --- | --- | --- |
${unknownRows}

Selected versions remain visible in every cell, but they are not copied into
the observed-version field unless a receipt says what ran.

## Recorded departures

| ID | Components | Clusters | Compact description | Evidence |
| --- | --- | --- | --- | --- |
${departureRows}

Every present non-Argo cell includes \`adapted-delivery\`. The matrix therefore
shows what the existing ConfigHub proof established without turning it into a
claim that Kubara's native Git topology was exercised.

## Commands

~~~sh
node scripts/generate-kubara-platform-matrix.mjs --generate
node scripts/generate-kubara-platform-matrix.mjs --verify
node scripts/generate-kubara-platform-matrix.mjs --self-test
~~~
`;
}

function htmlReport(document) {
  const { components, clusters, rows, departures, evidence } = document.spec;
  const gridRows = components.map((component) => {
    const cells = clusters.map((cluster) => {
      const row = rows.find((entry) => entry.component === component.name && entry.cluster === cluster.name);
      const label = `${row.proofStatus}; sync ${row.syncState}; observed version ${row.observedVersion}; ${row.departureIds.length} departures`;
      return `<td class="matrix-cell ${statusClass(row.proofStatus)}" aria-label="${escapeHtml(label)}"><strong><span aria-hidden="true">${statusGlyph(row.proofStatus)}</span> ${escapeHtml(row.proofStatus)}</strong><span>sync: ${escapeHtml(row.syncState)}</span><span>observed: ${escapeHtml(row.observedVersion)}</span><span>departures: ${row.departureIds.length}</span></td>`;
    }).join("");
    return `<tr><th scope="row">${escapeHtml(component.name)}<span class="selected">selected: ${escapeHtml(component.selectedVersion)}</span></th>${cells}</tr>`;
  }).join("\n");
  const detailRows = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.component)}</th><td>${escapeHtml(row.cluster)}</td><td>${escapeHtml(row.selectedVersion)}</td><td>${escapeHtml(row.observedVersion)}</td><td>${escapeHtml(row.versionState)}</td><td>${escapeHtml(row.syncState)}</td><td>${escapeHtml(row.workloadState)}</td><td class="status ${statusClass(row.proofStatus)}">${statusGlyph(row.proofStatus)} ${escapeHtml(row.proofStatus)}</td><td>${escapeHtml(row.departures)}</td><td>${escapeHtml(row.evidenceScope)}</td></tr>`).join("\n");
  const departureRows = departures.map((item) => `<tr><th scope="row"><code>${escapeHtml(item.id)}</code></th><td>${escapeHtml(item.components.join(", "))}</td><td>${escapeHtml(item.appliesTo.join(", "))}</td><td>${escapeHtml(item.summary)}</td><td><code>${escapeHtml(item.evidence.source)}</code><br><code>${escapeHtml(item.evidence.path)}</code></td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kubara component by cluster matrix</title>
<style>
:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.7rem;margin-bottom:.25rem}.lede,.boundary{max-width:95ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key,.status{border-radius:.25rem;padding:.3rem .5rem;font-weight:700}.observed{background:#d7f2df;color:#14532d}.watch{background:#fff0bd;color:#634b00}.partial{background:#eadcff;color:#4a2573}.substituted{background:#dce9ff;color:#173b75}.not-delivered{background:#edf1f5;color:#344454}table{border-collapse:collapse;width:100%;margin:1.25rem 0;font-size:.84rem}caption{text-align:left;font-size:1rem;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.5rem;text-align:left;vertical-align:top}thead th{background:#edf1f5;color:#17212b;position:sticky;top:0}.matrix-cell{min-width:12rem}.matrix-cell span,.selected{display:block;font-weight:400;margin-top:.2rem}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede,.boundary{color:#c6d1dc}thead th{background:#25313d;color:#fff}.observed{background:#14532d;color:#fff}.watch{background:#634b00;color:#fff}.partial{background:#4a2573;color:#fff}.substituted{background:#173b75;color:#fff}.not-delivered{background:#344454;color:#fff}}
</style>
</head>
<body>
<main>
<h1>Kubara component × cluster matrix</h1>
<p class="lede">Historical receipt join. Single-platform receipt: ${escapeHtml(evidence.recordedAt.singlePlatform)}; app-rollout receipt: ${escapeHtml(evidence.recordedAt.appRollout)}. Status is written as text and symbol; color is supplementary.</p>
<div class="legend" aria-label="Proof status legend"><span class="key observed">✓ observed</span><span class="key watch">! watch</span><span class="key partial">◐ partial</span><span class="key substituted">↔ substituted</span><span class="key not-delivered">– not-delivered</span></div>
<p class="boundary"><strong>Boundary:</strong> ConfigHub-owned Argo CD and adapted variant/OCI delivery were used. This page is not current live state and is not proof of Kubara's native Git/ApplicationSet lane.</p>
<table>
<caption>Components by cluster</caption>
<thead><tr><th scope="col">Component / selection</th>${clusters.map((cluster) => `<th scope="col">${escapeHtml(cluster.name)}<br>${escapeHtml(cluster.environment)}${cluster.region ? ` / ${escapeHtml(cluster.region)}` : ""}</th>`).join("")}</tr></thead>
<tbody>${gridRows}</tbody>
</table>
<table>
<caption>Cell details</caption>
<thead><tr><th scope="col">Component</th><th scope="col">Cluster</th><th scope="col">Selected version</th><th scope="col">Observed version</th><th scope="col">Version state</th><th scope="col">Sync state</th><th scope="col">Workload evidence</th><th scope="col">Proof status</th><th scope="col">Departures</th><th scope="col">Evidence scope</th></tr></thead>
<tbody>${detailRows}</tbody>
</table>
<table>
<caption>Departure provenance</caption>
<thead><tr><th scope="col">ID</th><th scope="col">Components</th><th scope="col">Clusters</th><th scope="col">Description</th><th scope="col">Evidence</th></tr></thead>
<tbody>${departureRows}</tbody>
</table>
</main>
</body>
</html>
`;
}

function selfTestCurrent(document) {
  const { components, clusters, rows } = document.spec;
  check(document.spec.profile?.role === "primary-current", "current matrix is not marked primary-current");
  check(document.spec.profile?.evidenceLayer === "optional-live-overlay", "current matrix is not marked as the optional live overlay");
  check(document.spec.evidence?.kubaraVersion === "v0.13.0", `expected current Kubara v0.13.0, found ${document.spec.evidence?.kubaraVersion}`);
  check(components.length === 9, `expected 7 platform roles plus 2 applications, found ${components.length}`);
  check(clusters.length === 4, `expected 4 current clusters, found ${clusters.length}`);
  check(rows.length === 36, `expected 36 current component×cluster cells, found ${rows.length}`);
  const argo = rows.filter((row) => row.component === "argo-cd");
  check(argo.filter((row) => row.presence === "rendered-intent").length === 1, "current Argo CD must render on the hub only");
  check(argo.filter((row) => row.presence === "hub-managed").length === 3, "current spoke Argo cells must be centralized at the hub");
  const cert = rows.filter((row) => row.component === "cert-manager");
  check(cert.every((row) => row.presence === "rendered-intent"), "current cert-manager must be selected on all four clusters");
  const kps = rows.filter((row) => row.component === "kube-prometheus-stack");
  check(kps.filter((row) => row.presence === "rendered-intent").length === 1, "current kube-prometheus-stack must be selected on the hub only");
  for (const app of APPLICATION_COMPONENTS) check(rows.filter((row) => row.component === app && row.presence === "application-intent").length === 4, `${app} must be selected on all four clusters`);
  check(rows.every((row) => Object.hasOwn(row, "desiredVersion") && Object.hasOwn(row, "observedVersion") && Object.hasOwn(row, "healthState") && Object.hasOwn(row, "readiness") && Object.hasOwn(row, "unknownReason")), "current rows do not expose the full desired/live observation schema");
  const accepted = document.spec.evidence?.miniIdpReceipt?.acceptedAsLive === true;
  check(document.spec.evidence?.parsedObservationCells === (accepted ? 36 : 0), "current receipt acceptance and parsed cell count disagree");
  for (const row of rows.filter((item) => item.presence !== "disabled-by-config" && (isUnknown(item.observedVersion) || item.readiness?.result === "unknown"))) {
    check(typeof row.unknownReason === "string" && row.unknownReason.length > 0, `${row.cluster}/${row.component} lost its Unknown reason`);
  }
}

function verifyCurrentLivePublication(document) {
  const reasons = currentLivePublicationReasons(document);
  check(reasons.length === 0, `current matrix cannot publish passing live receipts as a desired-only or partial overlay:\n- ${reasons.join("\n- ")}`);
}

function currentLivePublicationReasons(document, options = {}) {
  const miniIdpReceipt = options.miniIdpReceipt !== undefined
    ? options.miniIdpReceipt
    : existsSync(currentSources.miniIdpReceipt) ? readYaml(currentSources.miniIdpReceipt) : null;
  const faithfulReceipt = options.faithfulReceipt !== undefined
    ? options.faithfulReceipt
    : existsSync(currentSources.faithfulReceipt) ? readYaml(currentSources.faithfulReceipt) : null;
  if (miniIdpReceipt?.status?.result !== "pass" || faithfulReceipt?.status?.result !== "pass") return [];

  const reasons = [];
  const evidence = document.spec?.evidence ?? {};
  if (evidence.faithfulReceiptStatus !== "pass") reasons.push(`faithful receipt status is ${evidence.faithfulReceiptStatus ?? "missing"}, expected pass`);
  if (evidence.miniIdpReceipt?.status !== "accepted-current-live") reasons.push(`mini-IDP overlay status is ${evidence.miniIdpReceipt?.status ?? "missing"}, expected accepted-current-live`);
  if (evidence.miniIdpReceipt?.acceptedAsLive !== true) reasons.push("mini-IDP overlay is not acceptedAsLive");
  if (Number(evidence.miniIdpReceipt?.sourceDigestsVerified) !== Object.keys(MINI_IDP_SOURCE_PATHS).length) reasons.push(`verified source count is ${evidence.miniIdpReceipt?.sourceDigestsVerified ?? "missing"}, expected ${Object.keys(MINI_IDP_SOURCE_PATHS).length}`);
  if (Number(evidence.miniIdpReceipt?.parsedCells) !== 36) reasons.push(`mini-IDP parsed cell count is ${evidence.miniIdpReceipt?.parsedCells ?? "missing"}, expected 36`);
  if (Number(evidence.parsedObservationCells) !== 36) reasons.push(`matrix parsed observation count is ${evidence.parsedObservationCells ?? "missing"}, expected 36`);
  if (evidence.orphanReceipt?.status !== "accepted-current-scoped-residue-clean") reasons.push(`orphan receipt status is ${evidence.orphanReceipt?.status ?? "missing"}, expected accepted-current-scoped-residue-clean`);
  if (evidence.orphanReceipt?.acceptedAsScopedResidueClean !== true) reasons.push("orphan receipt is not acceptedAsScopedResidueClean");
  if (document.spec?.scope?.faithfulKubaraGitDelivery !== "source-current-receipt-pass-with-recorded-scope") reasons.push("faithful Kubara Git delivery is not source-current");
  return reasons;
}

function selfTestCurrentLivePublicationGate(document) {
  const passingReceipts = {
    miniIdpReceipt: { status: { result: "pass" } },
    faithfulReceipt: { status: { result: "pass" } },
  };
  check(currentLivePublicationReasons(document, passingReceipts).length === 0, "current live matrix failed its publication gate");
  check(currentLivePublicationReasons(document, { miniIdpReceipt: null, faithfulReceipt: null }).length === 0, "absent live receipts disabled deterministic desired-only publication");

  const rejected = structuredClone(document);
  rejected.spec.evidence.miniIdpReceipt.acceptedAsLive = false;
  check(currentLivePublicationReasons(rejected, passingReceipts).some((reason) => reason.includes("acceptedAsLive")), "publication gate accepted a rejected mini-IDP overlay");

  const partial = structuredClone(document);
  partial.spec.evidence.miniIdpReceipt.parsedCells = 35;
  partial.spec.evidence.parsedObservationCells = 35;
  check(currentLivePublicationReasons(partial, passingReceipts).filter((reason) => reason.includes("cell") || reason.includes("observation")).length === 2, "publication gate accepted a partial live overlay");

  const staleFaithful = structuredClone(document);
  staleFaithful.spec.evidence.faithfulReceiptStatus = "stale-source";
  check(currentLivePublicationReasons(staleFaithful, passingReceipts).some((reason) => reason.includes("faithful receipt status")), "publication gate accepted stale faithful evidence");

  const staleOrphan = structuredClone(document);
  staleOrphan.spec.evidence.orphanReceipt.acceptedAsScopedResidueClean = false;
  check(currentLivePublicationReasons(staleOrphan, passingReceipts).some((reason) => reason.includes("acceptedAsScopedResidueClean")), "publication gate accepted stale orphan evidence");
}

function selfTestFaithfulHashDomains() {
  const catalogParity = readYaml(currentSources.catalogParity);
  const faithfulReceipt = readYaml(currentSources.faithfulReceipt);
  const generated = currentGeneratedEvidence();
  const parityDigest = catalogParity.spec?.comparison?.outputTreeSha256;
  check(generated.sha256 !== parityDigest, "faithful and catalog-parity digest fixtures unexpectedly use the same hash domain");
  check(evaluateFaithfulReceipt(faithfulReceipt, catalogParity).accepted, "source-current faithful receipt was rejected");

  const wrongDomain = structuredClone(faithfulReceipt);
  wrongDomain.spec.source.currentExample.generatedSha256 = parityDigest;
  wrongDomain.spec.source.git.generatedSha256 = parityDigest;
  check(!evaluateFaithfulReceipt(wrongDomain, catalogParity).accepted, "catalog-parity digest was accepted as a faithful-proof generated-tree digest");
}

function selfTestDesired(document) {
  check(document.metadata?.name === "kubara-v0.13.0-current-four-cluster-desired", "desired matrix name drifted");
  check(document.spec?.profile?.evidenceLayer === "desired-only", "desired matrix is not desired-only");
  check(document.spec?.evidence?.miniIdpReceipt?.status === "not-consumed-for-desired-artifact", "desired matrix consumed a live receipt");
  check(document.spec?.evidence?.parsedObservationCells === 0, "desired matrix contains live observations");
  check(document.spec?.rows?.length === 36, "desired matrix must contain all 36 component/application cells");
  check(document.spec.rows.every((row) => !row.evidence.includes(relativeRepo(currentSources.miniIdpReceipt))), "desired rows cite the live receipt");
  check(document.spec.rows.filter((row) => row.presence !== "disabled-by-config").every((row) => isUnknown(row.observedVersion)), "desired matrix promoted selected versions to observed versions");
}

function selfTestMiniIdpReceiptValidation() {
  const config = readYaml(currentSources.config);
  const components = currentComponents(readYaml(currentSources.artifacts), readYaml(currentSources.appSourceLock));
  const clusters = config.clusters.map((cluster) => ({
    name: cluster.name,
    environment: cluster.stage,
    type: cluster.type,
    argoSelfManaged: cluster.argocd?.selfManaged,
  }));
  const digest = `sha256:${"a".repeat(64)}`;
  const sourceDigest = () => digest;
  const options = { components, clusters, sourceDigest, expectedSourcePaths: MINI_IDP_SOURCE_PATHS };
  const absent = validateMiniIdpReceipt(null, options);
  check(absent.status === "not-present" && absent.observations.size === 0, "absent receipt became live evidence");

  const validReceipt = syntheticMiniIdpReceipt(components, clusters, digest);
  const valid = validateMiniIdpReceipt(validReceipt, options);
  check(valid.accepted && valid.observations.size === 36, `valid receipt was rejected: ${valid.reasons.join("; ")}`);
  check(valid.sourceDigestsVerified === Object.keys(MINI_IDP_SOURCE_PATHS).length, "valid receipt did not verify every source digest");

  const stale = structuredClone(validReceipt);
  stale.spec.source.files.config.sha256 = `sha256:${"b".repeat(64)}`;
  const staleResult = validateMiniIdpReceipt(stale, options);
  check(!staleResult.accepted && staleResult.status === "rejected" && staleResult.observations.size === 0 && staleResult.reasons.some((reason) => reason.includes("digest config is stale")), "stale receipt became live evidence");

  const mismatched = structuredClone(validReceipt);
  mismatched.spec.source.kubaraVersion = "v0.12.0";
  const mismatchedResult = validateMiniIdpReceipt(mismatched, options);
  check(!mismatchedResult.accepted && mismatchedResult.observations.size === 0 && mismatchedResult.reasons.some((reason) => reason.includes("expected v0.13.0")), "mismatched Kubara receipt became live evidence");

  const partial = structuredClone(validReceipt);
  const partialRow = partial.spec.liveMatrix.rows.find((row) => row.cluster === "hx-app-dev" && row.component === "cert-manager");
  partialRow.observedVersion = null;
  partialRow.readiness = { result: "unknown", ready: 0, desired: 0, workloads: [] };
  partialRow.unknownReason = "workload labels and readiness were unavailable in this read";
  const partialResult = validateMiniIdpReceipt(partial, options);
  const mappedPartial = partialResult.observations.get("hx-app-dev/cert-manager");
  check(partialResult.accepted && mappedPartial.observedVersion === "Unknown" && mappedPartial.readiness.result === "unknown" && mappedPartial.unknownReason === partialRow.unknownReason, "valid partial observation did not preserve Unknown fields and reason");
  const absentReport = buildCurrentReport({ miniIdpReceipt: null });
  const partialReport = buildCurrentReport({ miniIdpReceipt: partial, sourceDigest });
  const partialCell = partialReport.document.spec.rows.find((row) => row.cluster === "hx-app-dev" && row.component === "cert-manager");
  check(partialReport.document.spec.evidence.miniIdpReceipt.acceptedAsLive === true, "valid partial receipt was not accepted by the report builder");
  check(partialCell.desiredVersion === "v1.21.0" && partialCell.observedVersion === "Unknown" && partialCell.syncState === "Synced" && partialCell.healthState === "Healthy" && partialCell.readiness.result === "unknown" && partialCell.unknownReason === partialRow.unknownReason, "report cell did not map every partial live field exactly");
  check(absentReport.desiredJson === partialReport.desiredJson, "desired-matrix content changed when a live receipt was supplied");

  const incomplete = structuredClone(validReceipt);
  incomplete.spec.liveMatrix.rows.pop();
  incomplete.spec.liveMatrix.rowCount -= 1;
  incomplete.spec.counts.liveMatrixRows -= 1;
  const incompleteResult = validateMiniIdpReceipt(incomplete, options);
  check(!incompleteResult.accepted && incompleteResult.observations.size === 0, "incomplete receipt was partially trusted");
}

function syntheticMiniIdpReceipt(components, clusters, digest) {
  const rows = clusters.flatMap((cluster) => components.map((component) => {
    const deliveryState = expectedDeliveryState(component.name, cluster);
    return {
      cluster: cluster.name,
      environment: cluster.environment,
      region: cluster.environment === "prod" ? "test-region" : "local",
      component: component.name,
      desiredVersion: component.desiredVersion,
      observedVersion: deliveryState === "delivered" ? component.desiredVersion : null,
      deliveryState,
      syncState: deliveryState === "delivered" ? "Synced" : "NotApplicable",
      healthState: deliveryState === "delivered" ? "Healthy" : "NotApplicable",
      readiness: deliveryState === "delivered"
        ? { result: "pass", ready: 1, desired: 1, workloads: [`Deployment/test/${component.name}`] }
        : { result: "not-applicable", ready: 0, desired: 0 },
      departure: null,
      unknownReason: null,
    };
  }));
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "ConfigHubKubaraMiniIDPReconcileReceipt",
    metadata: { name: "kubara-v0-13-0-confighub-mini-idp" },
    spec: {
      source: {
        kubaraVersion: "v0.13.0",
        catalogVersion: "1.1.0",
        exactVersionPolicy: "fail-if-missing",
        retentionPolicy: "additive-only",
        files: Object.fromEntries(Object.entries(MINI_IDP_SOURCE_PATHS).map(([key, path]) => [key, { path, sha256: digest }])),
      },
      counts: { liveMatrixRows: rows.length },
      liveMatrix: {
        kind: "KubaraMiniIDPLiveMatrixObservation",
        desiredSource: MINI_IDP_SOURCE_PATHS.componentArtifacts,
        observationMode: "kubectl-and-confighub-live-read",
        rowCount: rows.length,
        rows,
      },
    },
    status: { result: "pass", observedAt: "2026-08-04T12:00:00.000Z", fullCurrentSelectionDelivered: true },
  };
}

function selfTestHistorical(document) {
  const { components, clusters, rows } = document.spec;
  check(components.length === 7, `expected 7 Kubara roles, found ${components.length}`);
  check(clusters.length === 4, `expected 4 fleet clusters, found ${clusters.length}`);
  check(rows.length === 28, `expected 28 component×cluster cells, found ${rows.length}`);
  const cert = rows.filter((row) => row.component === "cert-manager");
  check(cert.length === 4 && cert.every((row) => row.presence === "present" && row.proofStatus === "watch"), "cert-manager fleet evidence was overstated or lost");
  const kps = rows.filter((row) => row.component === "kube-prometheus-stack");
  check(kps.filter((row) => row.presence === "present").length === 1, "kube-prometheus-stack must be dev-only in this receipt");
  check(kps.find((row) => row.presence === "present")?.versionState === "recorded-departure", "kube-prometheus-stack version departure is missing");
  const argo = rows.filter((row) => row.component === "argo-cd");
  check(argo.every((row) => row.proofStatus === "substituted" && row.observedVersion === "unknown"), "Argo substitution must not become a Kubara argo-cd observation");
  check(document.spec.unknowns.length > 0, "matrix must preserve its explicit unknowns");
}

function countBy(items, keyFor) {
  const result = {};
  for (const item of items) {
    const key = keyFor(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function normalizeComponent(value) {
  return value === "argocd" ? "argo-cd" : value;
}

function normalizeVersion(value) {
  return String(value).replace(/^v/, "");
}

function shortIdentity(value) {
  return String(value).replace(/^helm:/, "").replace(/^kubara:/, "kubara/");
}

function environmentFromName(name) {
  if (name.endsWith("-prod-a") || name.endsWith("-prod-b")) return "prod";
  if (name.endsWith("-staging")) return "staging";
  if (name.endsWith("-dev")) return "dev";
  return "unknown";
}

function statusIcon(status) {
  return ({ observed: "✅", watch: "⚠️", partial: "🟣", substituted: "🔁", "not-delivered": "➖" })[status] ?? "❔";
}

function statusGlyph(status) {
  return ({ observed: "✓", watch: "!", partial: "◐", substituted: "↔", "not-delivered": "–" })[status] ?? "?";
}

function statusClass(status) {
  return ["observed", "watch", "partial", "substituted", "not-delivered"].includes(status) ? status : "partial";
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeMd(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
