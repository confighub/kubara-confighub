#!/usr/bin/env node

// Normalize an already generated Kubara work directory into the exact clean,
// deterministic Git handoff consumed by import-kubara-git-revision.mjs.
// Kubara remains the composer. This command does not run Kubara, inspect a
// cluster, resolve a mutable catalog, attest a secret scan, commit, or push.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  check,
  normalizeYaml,
  parseDocs,
  readYaml,
  repoRoot,
  sha256,
  toYaml,
} from "./lib/proof-common.mjs";

const CONTRACT_VERSION = "v1alpha1";
const SAFE_NONCREDENTIAL_SECRET_KEYS = new Set(["config", "name", "server", "alertmanager.yaml", "ca.crt", "tls.crt"]);
const SECRET_RESOURCE_REFERENCE_FIELDS = new Set([
  "existingSecret", "secretName", "secretRef", "secretKeyRef",
]);
const EXTERNAL_SECRET_REFERENCE_KINDS = new Set([
  "ClusterExternalSecret", "ExternalSecret", "PushSecret",
]);
const mode = process.argv[2] ?? "--help";

if (["--generate", "--verify"].includes(mode)) {
  const requestPath = resolve(requiredOption("--request"));
  const checkoutRoot = resolve(requiredOption("--checkout"));
  const kubaraBin = option("--kubara-bin");
  if (mode === "--generate") check(kubaraBin, "--kubara-bin is required for --generate");
  const resolvedKubaraBin = kubaraBin ? resolve(kubaraBin) : null;
  if (mode === "--generate") {
    const result = generatePreparation({ requestPath, checkoutRoot, kubaraBin: resolvedKubaraBin });
    console.log(`prepared clean Kubara Git handoff ${result.name}: ${result.renderCount} renders -> ${result.outputLabel}`);
  } else {
    const result = verifyPreparation({ requestPath, checkoutRoot, kubaraBin: resolvedKubaraBin });
    console.log(`verified clean Kubara Git handoff ${result.name}: ${result.renderCount} renders; offline zero-repository-write`);
  }
} else if (mode === "--self-test") {
  selfTest();
} else {
  console.log(`Usage:
  node scripts/prepare-kubara-git-handoff.mjs --generate --request <prepare.yaml> --checkout <git-root> --kubara-bin <sha-pinned-kubara>
  node scripts/prepare-kubara-git-handoff.mjs --verify   --request <prepare.yaml> --checkout <git-root> [--kubara-bin <sha-pinned-kubara>]
  node scripts/prepare-kubara-git-handoff.mjs --self-test

Run Kubara first. Generate is the only network/write mode and atomically
replaces only spec.output.path. Verify performs no repository write or network
access. A reviewed exact KubaraComponentArtifactSet is mandatory.`);
}

function generatePreparation({ requestPath, checkoutRoot, kubaraBin }, injected = {}) {
  const context = loadContext({ requestPath, checkoutRoot, kubaraBin, requireClean: false, toolProbe: injected.toolProbe });
  const lockPath = `${context.outputRoot}.prepare.lock`;
  check(!existsSync(lockPath), `${context.outputLabel}: another preparation lock exists`);
  const lockFd = openSync(lockPath, "wx", 0o600);
  let stageRoot = null;
  try {
    stageRoot = mkdtempSync(join(dirname(context.outputRoot), `.${basename(context.outputRoot)}.stage-`));
    materializeCleanInputs(context, stageRoot);
    const renderRows = renderPreparedInstances(context, stageRoot, injected);
    const generationReceipt = generationReceiptFor(context, renderRows);
    writeText(join(stageRoot, "generation-receipt.yaml"), `${toYaml(generationReceipt)}\n`);
    runPreparedWiring("--handoff-generate", context, stageRoot, injected);
    validateGraphInventory(stageRoot, renderRows);
    writePreparationEvidence(context, stageRoot, renderRows);
    if (injected.beforePromote) injected.beforePromote(stageRoot);
    assertPreparationInputsUnchanged(context);
    verifyStagedPreparation(context, stageRoot);
    promoteDirectoryAtomically(stageRoot, context.outputRoot);
    stageRoot = null;
    return { name: context.request.metadata.name, renderCount: renderRows.length, outputLabel: context.outputLabel };
  } finally {
    if (stageRoot && existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
    closeSync(lockFd);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function verifyPreparation({ requestPath, checkoutRoot, kubaraBin }, injected = {}) {
  const statusBefore = gitStatus(checkoutRoot);
  const context = loadContext({ requestPath, checkoutRoot, kubaraBin, requireClean: true, toolProbe: injected.toolProbe });
  check(existsSync(context.outputRoot), `${context.outputLabel} is missing; run --generate before the final commit`);
  rejectSymlinks(context.outputRoot);
  assertPreparedCopyLineage(context, context.outputRoot);
  const renderRows = observePreparedRenders(context);
  const expectedGeneration = `${toYaml(generationReceiptFor(context, renderRows))}\n`;
  check(readFileSync(join(context.outputRoot, "generation-receipt.yaml"), "utf8") === expectedGeneration, `${context.outputLabel}/generation-receipt.yaml is stale`);
  runPreparedWiring("--handoff-verify", context, context.outputRoot);
  validateGraphInventory(context.outputRoot, renderRows);
  rejectUnsafePreparedTree(context.outputRoot, context);
  verifyPreparationEvidence(context, context.outputRoot, renderRows);
  check(gitStatus(checkoutRoot) === statusBefore, "--verify changed repository state; zero-repository-write contract violated");
  return { name: context.request.metadata.name, renderCount: renderRows.length, outputLabel: context.outputLabel };
}

function loadContext({ requestPath, checkoutRoot, kubaraBin, requireClean, toolProbe = defaultToolProbe }) {
  check(existsSync(requestPath) && !lstatSync(requestPath).isSymbolicLink(), `preparation request must be an existing real file: ${requestPath}`);
  check(existsSync(checkoutRoot) && !lstatSync(checkoutRoot).isSymbolicLink(), `checkout must be an existing real directory: ${checkoutRoot}`);
  const top = git(checkoutRoot, ["rev-parse", "--show-toplevel"]);
  check(realpathSync(top) === realpathSync(checkoutRoot), `--checkout must be the Git worktree root (${top})`);
  check(isWithin(requestPath, checkoutRoot), "preparation request must be inside the selected Git worktree");
  assertNoSymlinkPath(checkoutRoot, requestPath, "preparation request");
  const request = readYaml(requestPath);
  validatePreparationRequest(request);
  const sourceRoot = safeJoin(checkoutRoot, request.spec.source.path, "spec.source.path");
  const outputRoot = safeJoin(checkoutRoot, request.spec.output.path, "spec.output.path");
  check(existsSync(sourceRoot), `Kubara work directory is missing: ${request.spec.source.path}`);
  check(relative(checkoutRoot, outputRoot).split(sep)[0] !== ".git", "spec.output.path cannot target .git");
  const outputParent = dirname(outputRoot);
  check(existsSync(outputParent) && statSync(outputParent).isDirectory(), "spec.output.path parent must be an existing real directory");
  assertNoSymlinkPath(checkoutRoot, sourceRoot, "spec.source.path");
  assertNoSymlinkPath(checkoutRoot, outputParent, "spec.output.path parent");
  if (existsSync(outputRoot)) assertNoSymlinkPath(checkoutRoot, outputRoot, "spec.output.path");

  const sourcePaths = Object.fromEntries(Object.entries(request.spec.source.layout).map(([key, value]) => [key, safeJoin(sourceRoot, value, `spec.source.layout.${key}`)]));
  for (const key of ["config", "components", "configs", "artifactLock", "sourceLock"]) check(existsSync(sourcePaths[key]), `${request.spec.source.layout[key]} is missing from the Kubara work directory`);
  for (const [key, path] of Object.entries(sourcePaths)) if (existsSync(path)) {
    assertNoSymlinkPath(sourceRoot, path, `spec.source.layout.${key}`);
    rejectSymlinks(path);
  }
  for (const [key, path] of Object.entries(sourcePaths)) {
    if (!existsSync(path)) continue;
    check(!pathsOverlap(outputRoot, path), `spec.output.path must be disjoint from spec.source.layout.${key}`);
  }
  check(!pathsOverlap(outputRoot, requestPath), "spec.output.path must be disjoint from the preparation request");
  check(!Object.values(sourcePaths).some((path) => isForbiddenPreparedBasename(basename(path))), "dotenv and target-fact files are never allowed prepared handoff inputs");
  rejectPreVendoredCharts(sourcePaths.components);

  const sourceLock = readYaml(sourcePaths.sourceLock);
  const expectedKubaraSha = sourceLock.spec?.kubara?.release?.extractedBinarySha256;
  const kubaraVersion = sourceLock.spec?.kubara?.version;
  const catalogVersion = String(sourceLock.spec?.catalogs?.version ?? "");
  check(/^[0-9a-f]{64}$/.test(expectedKubaraSha ?? ""), "source lock must pin spec.kubara.release.extractedBinarySha256");
  check(/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(kubaraVersion ?? ""), "source lock must pin an exact spec.kubara.version");
  check(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(catalogVersion), "source lock must pin an exact spec.catalogs.version");
  if (kubaraBin) {
    check(existsSync(kubaraBin) && !lstatSync(kubaraBin).isSymbolicLink() && statSync(kubaraBin).isFile(), "--kubara-bin must name an existing real file");
    check(sha256(readFileSync(kubaraBin)) === expectedKubaraSha, "Kubara binary SHA-256 differs from the exact source lock");
  }
  const tools = toolProbe(kubaraBin, { kubaraVersion, expectedKubaraSha });
  if (kubaraBin) check(tools.kubaraVersionOutput === `kubara version ${kubaraVersion}`, `Kubara binary version output differs from ${kubaraVersion}`);
  check(tools.helmVersion === request.spec.tools.helmVersion, `Helm version ${tools.helmVersion} differs from request-pinned ${request.spec.tools.helmVersion}`);
  check(String(sourceLock.spec?.generation?.helmKubeVersion) === request.spec.render.kubeVersion, "render kubeVersion differs from source-lock spec.generation.helmKubeVersion");

  const artifactSet = readYaml(sourcePaths.artifactLock);
  validateArtifactSet(artifactSet);
  const components = discoverComponentContracts(sourcePaths.components, artifactSet);
  const config = readYaml(sourcePaths.config);
  const instances = discoverInstances({ request, config, components, configRoot: sourcePaths.configs });
  const inputInventory = preparationInputInventory({ checkoutRoot, requestPath, sourcePaths });
  const requestText = readFileSync(requestPath, "utf8");
  const context = {
    request,
    requestPath,
    requestText,
    requestLabel: rel(checkoutRoot, requestPath),
    checkoutRoot,
    sourceRoot,
    outputRoot,
    outputLabel: rel(checkoutRoot, outputRoot),
    sourcePaths,
    sourceLock,
    artifactSet,
    components,
    instances,
    inputInventory,
    kubaraBin,
    kubaraVersion,
    catalogVersion,
    kubaraBinarySha256: expectedKubaraSha,
    helmVersion: tools.helmVersion,
  };
  if (requireClean) {
    const status = git(checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", request.spec.source.path, request.spec.output.path, context.requestLabel]);
    check(status === "", `--verify requires the request, raw Kubara inputs, and prepared handoff to be committed and clean:\n${status}`);
  }
  return context;
}

function validatePreparationRequest(request) {
  checkExactKeys(request, ["apiVersion", "kind", "metadata", "spec"], "preparation request");
  check(request.apiVersion === "import.confighub.com/v1alpha1" && request.kind === "KubaraGitHandoffPreparation", "preparation request apiVersion/kind is invalid");
  checkExactKeys(request.metadata, ["name"], "preparation request metadata");
  checkSlug(request.metadata.name, "metadata.name");
  checkExactKeys(request.spec, ["source", "output", "render", "tools"], "preparation request spec");
  checkExactKeys(request.spec.source, ["path", "layout"], "spec.source");
  checkSafeRelative(request.spec.source.path, "spec.source.path");
  checkObjectKeys(request.spec.source.layout, ["config", "components", "configs", "artifactLock", "sourceLock", "overrides"], ["config", "components", "configs", "artifactLock", "sourceLock"], "spec.source.layout");
  for (const [key, value] of Object.entries(request.spec.source.layout)) checkSafeRelative(value, `spec.source.layout.${key}`);
  checkExactKeys(request.spec.output, ["path"], "spec.output");
  checkSafeRelative(request.spec.output.path, "spec.output.path");
  checkExactKeys(request.spec.render, ["kubeVersion", "apiVersions", "services"], "spec.render");
  check(/^\d+\.\d+\.\d+$/.test(request.spec.render.kubeVersion ?? ""), "spec.render.kubeVersion must be exact");
  check(Array.isArray(request.spec.render.apiVersions) && request.spec.render.apiVersions.length > 0, "spec.render.apiVersions must be a nonempty pinned array");
  const apiVersions = request.spec.render.apiVersions;
  check(apiVersions.every((value) => /^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9.-]+)?$/.test(value)), "spec.render.apiVersions contains an invalid capability");
  check(stableJson(apiVersions) === stableJson([...new Set(apiVersions)].sort()), "spec.render.apiVersions must be unique and lexically sorted");
  check(request.spec.render.services && typeof request.spec.render.services === "object" && !Array.isArray(request.spec.render.services), "spec.render.services must explicitly map every enabled service");
  for (const [service, row] of Object.entries(request.spec.render.services)) {
    checkSlug(service, "spec.render.services key");
    checkExactKeys(row, ["releaseName", "namespace"], `spec.render.services.${service}`);
    checkSlug(row.releaseName, `spec.render.services.${service}.releaseName`);
    checkSlug(row.namespace, `spec.render.services.${service}.namespace`);
  }
  checkExactKeys(request.spec.tools, ["helmVersion"], "spec.tools");
  check(/^v\d+\.\d+\.\d+\+g[0-9a-f]{40}$/.test(request.spec.tools.helmVersion ?? ""), "spec.tools.helmVersion must pin the exact Helm version and full 40-hex Git commit");
}

function validateArtifactSet(value) {
  checkExactKeys(value, ["apiVersion", "kind", "metadata", "spec"], "component artifact lock");
  check(value.apiVersion === "catalog.confighub.com/v1alpha1" && value.kind === "KubaraComponentArtifactSet", "component artifact lock apiVersion/kind is invalid");
  checkExactKeys(value.metadata, ["name"], "component artifact lock metadata");
  checkSlug(value.metadata.name, "component artifact lock metadata.name");
  checkExactKeys(value.spec, ["exactVersionPolicy", "retentionPolicy", "artifacts", "firstParty"], "component artifact lock spec");
  check(value.spec.exactVersionPolicy === "fail-if-missing" && value.spec.retentionPolicy === "additive-only", "component artifact lock must be fail-if-missing and additive-only");
  check(Array.isArray(value.spec.artifacts) && Array.isArray(value.spec.firstParty), "component artifact lock rows must be arrays");
  for (const [index, row] of value.spec.artifacts.entries()) {
    const label = `component artifact lock artifacts[${index}]`;
    checkObjectKeys(row, ["service", "dependency", "canonicalIdentity", "wrapperVersion", "version", "url", "manifestDigest", "sha256"], ["service", "canonicalIdentity", "wrapperVersion", "version", "url", "sha256"], label);
    checkSlug(row.service, `${label}.service`);
    check(/^helm:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(row.canonicalIdentity ?? ""), `${label}.canonicalIdentity is invalid`);
    checkExactVersion(String(row.wrapperVersion ?? ""), `${label}.wrapperVersion`);
    checkExactVersion(String(row.version ?? ""), `${label}.version`);
    check(/^[0-9a-f]{64}$/.test(row.sha256 ?? ""), `${label}.sha256 must be exact`);
    validateArtifactURL(row.url, `${label}.url`);
    check(row.url.includes(String(row.version)) || row.url.includes(encodeURIComponent(String(row.version))), `${label}.url does not contain its exact version`);
    if (row.url.startsWith("oci://")) check(/^sha256:[0-9a-f]{64}$/.test(row.manifestDigest ?? ""), `${label}: OCI manifestDigest is mandatory and exact`);
    else check(row.manifestDigest === undefined, `${label}: manifestDigest is only valid for OCI`);
    if (row.dependency !== undefined) check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.dependency), `${label}.dependency is invalid`);
  }
  assertUnique(value.spec.artifacts, (row) => `${normalize(row.service)}\0${row.wrapperVersion}\0${row.canonicalIdentity}\0${row.version}`, "component artifact service/wrapper/canonical/version");
  for (const [index, row] of value.spec.firstParty.entries()) {
    const label = `component artifact lock firstParty[${index}]`;
    checkObjectKeys(row, ["service", "canonicalIdentity", "wrapperVersion", "deployable"], ["service", "canonicalIdentity", "wrapperVersion"], label);
    checkSlug(row.service, `${label}.service`);
    check(/^kubara:[A-Za-z0-9._-]+$/.test(row.canonicalIdentity ?? ""), `${label}.canonicalIdentity is invalid`);
    checkExactVersion(String(row.wrapperVersion ?? ""), `${label}.wrapperVersion`);
    if (row.deployable !== undefined) check(typeof row.deployable === "boolean", `${label}.deployable must be boolean`);
  }
  assertUnique(value.spec.firstParty, (row) => `${normalize(row.service)}\0${row.wrapperVersion}\0${row.canonicalIdentity}`, "first-party service/wrapper/canonical identity");
}

function discoverComponentContracts(componentRoot, artifactSet) {
  const dirs = readdirSync(componentRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  check(dirs.length > 0, "generated Kubara platform-components/helm has no chart directories");
  const contracts = dirs.map((service) => {
    checkSlug(service, "generated component directory");
    const path = join(componentRoot, service);
    const chart = readYaml(join(path, "Chart.yaml"));
    checkExactVersion(String(chart.version ?? ""), `${service} wrapper`);
    const dependencies = (chart.dependencies ?? []).map((dependency) => resolveDependencyContract({ service, chart, dependency, componentRoot, artifactSet }));
    const firstPartyMatches = artifactSet.spec.firstParty.filter((row) => String(row.wrapperVersion) === String(chart.version)
      && (normalize(row.service) === normalize(service) || row.canonicalIdentity === `kubara:${service}` || row.canonicalIdentity === `kubara:${chart.name}`));
    check(firstPartyMatches.length <= 1, `${service}@${chart.version}: ambiguous first-party compatibility profiles`);
    if (dependencies.every((row) => row.source === "local-library")) check(firstPartyMatches.length === 1, `${service}@${chart.version}: reviewed first-party compatibility profile is missing`);
    return {
      service,
      path,
      chartName: chart.name,
      chartType: chart.type ?? "application",
      wrapperVersion: String(chart.version),
      lifecycle: service === "bootstrap-crds",
      dependencies,
      firstParty: firstPartyMatches[0] ?? null,
    };
  });
  assertUnique(contracts, (row) => normalize(row.service), "normalized generated component service");
  return contracts;
}

function resolveDependencyContract({ service, chart, dependency, componentRoot, artifactSet }) {
  checkExactVersion(String(dependency.version ?? ""), `${service}/${dependency.name}`);
  const repository = String(dependency.repository ?? "");
  if (repository.startsWith("file://")) {
    check(repository === `file://../${dependency.name}`, `${service}/${dependency.name}: local dependency must use Kubara's exact sibling form file://../${dependency.name}`);
    const localPath = resolve(join(componentRoot, service), repository.slice("file://".length));
    check(isWithin(localPath, componentRoot) && existsSync(join(localPath, "Chart.yaml")), `${service}/${dependency.name}: local dependency escapes or is missing`);
    const localChart = readYaml(join(localPath, "Chart.yaml"));
    check(localChart.name === dependency.name, `${service}/${dependency.name}: local dependency Chart.yaml name differs`);
    check(String(localChart.version) === String(dependency.version), `${service}/${dependency.name}: local dependency version differs from Chart.yaml`);
    return { name: dependency.name, version: String(dependency.version), repository, source: "local-library", localService: dependency.name };
  }
  const lifecycle = service === "bootstrap-crds";
  const candidates = artifactSet.spec.artifacts.filter((row) => normalize(row.service) === normalize(lifecycle ? dependency.name : service)
    && (lifecycle || String(row.wrapperVersion) === String(chart.version))
    && (row.dependency === dependency.name || row.canonicalIdentity.endsWith(`/${dependency.name}`))
    && String(row.version) === String(dependency.version));
  check(candidates.length > 0, `${service}/${dependency.name}@${dependency.version}: no reviewed exact artifact mapping; add and qualify this Kubara service/version in the component-first Catalog`);
  const contracts = new Map(candidates.map((row) => [stableJson({ canonicalIdentity: row.canonicalIdentity, url: row.url, sha256: row.sha256, manifestDigest: row.manifestDigest ?? null }), row]));
  check(contracts.size === 1, `${service}/${dependency.name}@${dependency.version}: ambiguous or conflicting reviewed artifact mappings`);
  const artifact = [...contracts.values()][0];
  return { name: dependency.name, version: String(dependency.version), repository, source: "reviewed-external", artifact };
}

function discoverInstances({ request, config, components, configRoot }) {
  check(Array.isArray(config.clusters) && config.clusters.length > 0, "Kubara config has no clusters");
  assertUnique(config.clusters, (row) => String(row?.name ?? ""), "Kubara cluster name");
  const byService = new Map(components.map((row) => [normalize(row.service), row]));
  const instances = [];
  for (const cluster of config.clusters) {
    checkSlug(cluster.name, "Kubara cluster name");
    check(["hub", "spoke"].includes(cluster.type), `${cluster.name}: Kubara cluster type must be hub or spoke`);
    const enabled = Object.entries(cluster.services ?? {}).filter(([, row]) => row?.status === "enabled").map(([service]) => normalizeService(service));
    if (cluster.argocd?.selfManaged === "enabled") enabled.push("argo-cd");
    for (const service of [...new Set(enabled)].sort()) {
      const component = byService.get(normalize(service));
      check(component, `${cluster.name}/${service}: enabled service has no generated wrapper chart`);
      const render = request.spec.render.services[service];
      check(render, `${cluster.name}/${service}: spec.render.services must explicitly pin releaseName and namespace`);
      const valuesRoot = join(configRoot, cluster.name, "helm", component.service);
      check(existsSync(valuesRoot), `${cluster.name}/${component.service}: generated platform-configs directory is missing`);
      const values = orderedValues(valuesRoot);
      check(values.some((path) => basename(path) === "values.generated.yaml"), `${cluster.name}/${component.service}: values.generated.yaml is missing`);
      instances.push({ cluster: cluster.name, stage: String(cluster.stage ?? ""), clusterType: cluster.type, service: component.service, component, releaseName: render.releaseName, namespace: render.namespace, values });
    }
  }
  const expectedServices = [...new Set(instances.map((row) => row.service))].sort();
  check(stableJson(Object.keys(request.spec.render.services).sort()) === stableJson(expectedServices), `spec.render.services must exactly equal enabled generated services: ${expectedServices.join(", ")}`);
  return instances.sort((left, right) => left.cluster.localeCompare(right.cluster) || left.service.localeCompare(right.service));
}

function materializeCleanInputs(context, stageRoot) {
  writeText(join(stageRoot, "preparation-request.yaml"), context.requestText);
  copyExact(context.sourcePaths.config, join(stageRoot, "source", "config.yaml"));
  if (context.sourcePaths.overrides && existsSync(context.sourcePaths.overrides)) copyExact(context.sourcePaths.overrides, join(stageRoot, "source", "overrides"));
  copyExact(context.sourcePaths.components, join(stageRoot, "generated", "platform-components", "helm"));
  copyExact(context.sourcePaths.configs, join(stageRoot, "generated", "platform-configs"));
  copyExact(context.sourcePaths.artifactLock, join(stageRoot, "component-artifacts.yaml"));
  copyExact(context.sourcePaths.sourceLock, join(stageRoot, "source-lock.yaml"));
  rejectForbiddenNames(stageRoot);
}

function renderPreparedInstances(context, stageRoot, injected) {
  const externalRows = selectedExternalArtifacts(context.components);
  const artifacts = new Map();
  const artifactRoot = mkdtempSync(join(tmpdir(), "kubara-prepared-artifacts-"));
  const componentWork = mkdtempSync(join(tmpdir(), "kubara-prepared-components-"));
  try {
    for (const row of externalRows) {
      if (injected.artifactVerifier) injected.artifactVerifier(row);
      else {
        const output = join(artifactRoot, `${safeFilename(row.service)}-${safeFilename(row.dependency)}-${safeFilename(row.version)}.tgz`);
        fetchReviewedArtifact(row, output);
        artifacts.set(artifactKey(row), output);
      }
    }
    cpSync(join(stageRoot, "generated", "platform-components", "helm"), componentWork, { recursive: true });
    if (!injected.renderProvider) vendorDependencies(context, componentWork, artifacts);
    const rows = [];
    for (const instance of context.instances) {
      const first = normalizeYaml(injected.renderProvider ? injected.renderProvider(instance) : renderWithHelm(context, componentWork, stageRoot, instance));
      const second = normalizeYaml(injected.renderProvider ? injected.renderProvider(instance) : renderWithHelm(context, componentWork, stageRoot, instance));
      check(first === second, `${instance.cluster}/${instance.service}: effective render is not byte-identical across two runs`);
      const docs = parseDocs(first).filter(isKubernetesObject);
      check(docs.length > 0, `${instance.cluster}/${instance.service}: effective render contains no Kubernetes objects`);
      const output = join(stageRoot, "effective-renders", instance.cluster, instance.service, "release-objects.yaml");
      writeText(output, first);
      rows.push(renderRow(context, stageRoot, instance, first, docs));
    }
    return rows.sort(compareRenderRows);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(componentWork, { recursive: true, force: true });
  }
}

function selectedExternalArtifacts(components) {
  const rows = components.flatMap((component) => component.dependencies.filter((row) => row.source === "reviewed-external").map((row) => ({
    service: row.artifact.service,
    dependency: row.name,
    canonicalIdentity: row.artifact.canonicalIdentity,
    wrapperVersion: String(row.artifact.wrapperVersion),
    version: row.version,
    url: row.artifact.url,
    sha256: row.artifact.sha256,
    manifestDigest: row.artifact.manifestDigest ?? null,
  })));
  const unique = new Map();
  for (const row of rows) {
    const key = `${normalize(row.service)}\0${row.dependency}\0${row.version}`;
    const prior = unique.get(key);
    check(!prior || stableJson(prior) === stableJson(row), `${row.service}/${row.dependency}@${row.version}: selected artifact contract conflicts across wrappers`);
    unique.set(key, row);
  }
  return [...unique.values()].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
}

function vendorDependencies(context, componentWork, artifacts) {
  for (const component of context.components) {
    const chartRoot = join(componentWork, component.service);
    const chartsRoot = join(chartRoot, "charts");
    rmSync(chartsRoot, { recursive: true, force: true });
    mkdirSync(chartsRoot, { recursive: true });
    for (const dependency of component.dependencies) {
      if (dependency.source === "local-library") {
        copyExact(join(componentWork, dependency.localService), join(chartsRoot, dependency.name));
      } else {
        const row = {
          service: dependency.artifact.service,
          dependency: dependency.name,
          version: dependency.version,
        };
        const archive = artifacts.get(artifactKey(row));
        check(archive, `${component.service}/${dependency.name}: verified archive is missing`);
        copyExact(archive, join(chartsRoot, `${dependency.name}-${dependency.version}.tgz`));
      }
    }
  }
}

function renderWithHelm(context, componentWork, stageRoot, instance) {
  const chart = join(componentWork, instance.service);
  const args = ["template", instance.releaseName, chart, "--namespace", instance.namespace, "--kube-version", context.request.spec.render.kubeVersion, "--include-crds", "--skip-tests"];
  for (const apiVersion of context.request.spec.render.apiVersions) args.push("--api-versions", apiVersion);
  for (const rawValue of instance.values) {
    const relValue = relative(context.sourcePaths.configs, rawValue);
    args.push("--values", join(stageRoot, "generated", "platform-configs", relValue));
  }
  return command("helm", args, { cwd: context.checkoutRoot, label: `${instance.cluster}/${instance.service} Helm render` });
}

function fetchReviewedArtifact(row, output) {
  mkdirSync(dirname(output), { recursive: true });
  if (row.url.startsWith("https://")) {
    const result = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", "--output", output, row.url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_200_000 });
    check(result.status === 0, `${row.service}/${row.dependency}@${row.version}: exact HTTPS artifact fetch failed`);
  } else {
    const orasRef = row.url.replace(/^oci:\/\//, "");
    assertOCIManifest(orasRef, row.manifestDigest, `${row.service}/${row.dependency}@${row.version} before pull`);
    const lastSlash = row.url.lastIndexOf("/");
    const lastColon = row.url.lastIndexOf(":");
    const repository = row.url.slice(0, lastColon > lastSlash ? lastColon : row.url.length);
    const pullRoot = mkdtempSync(join(tmpdir(), "kubara-prepared-oci-"));
    try {
      command("helm", ["pull", repository, "--version", row.version, "--destination", pullRoot], { label: `${row.service}/${row.dependency} OCI Helm pull` });
      const archives = readdirSync(pullRoot).filter((name) => name.endsWith(".tgz"));
      check(archives.length === 1, `${row.service}/${row.dependency}@${row.version}: OCI Helm pull did not produce exactly one archive`);
      cpSync(join(pullRoot, archives[0]), output);
    } finally {
      rmSync(pullRoot, { recursive: true, force: true });
    }
    assertOCIManifest(orasRef, row.manifestDigest, `${row.service}/${row.dependency}@${row.version} after pull`);
  }
  check(sha256(readFileSync(output)) === row.sha256, `${row.service}/${row.dependency}@${row.version}: downloaded archive SHA-256 differs from reviewed lock`);
}

function assertOCIManifest(ref, expected, label) {
  const raw = command("oras", ["manifest", "fetch", "--descriptor", ref], { label: `${label} OCI descriptor` });
  let descriptor;
  try { descriptor = JSON.parse(raw); } catch { check(false, `${label}: OCI descriptor is not JSON`); }
  check(descriptor.digest === expected, `${label}: OCI manifest digest ${descriptor.digest ?? "missing"} differs from ${expected}`);
}

function renderRow(context, stageRoot, instance, text, docs) {
  return {
    cluster: instance.cluster,
    service: instance.service,
    releaseName: instance.releaseName,
    namespace: instance.namespace,
    values: instance.values.map((path) => `generated/platform-configs/${rel(context.sourcePaths.configs, path)}`),
    output: rel(stageRoot, join(stageRoot, "effective-renders", instance.cluster, instance.service, "release-objects.yaml")),
    sha256: sha256(text),
    objectCount: docs.length,
    kinds: countKinds(docs),
    deterministicDoubleRender: true,
    selectedVersions: selectedVersions(instance.component),
  };
}

function selectedVersions(component) {
  const external = component.dependencies.filter((row) => row.source === "reviewed-external").map((row) => ({ identity: row.artifact.canonicalIdentity, version: row.version }));
  if (external.length === 0 && component.firstParty) external.push({ identity: component.firstParty.canonicalIdentity, version: String(component.firstParty.wrapperVersion) });
  return external.sort((left, right) => left.identity.localeCompare(right.identity));
}

function generationReceiptFor(context, renderRows) {
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraPreparedGitHandoffGenerationReceipt",
    metadata: { name: context.request.metadata.name },
    spec: {
      contractVersion: CONTRACT_VERSION,
      source: {
        preparationRequest: "preparation-request.yaml",
        preparationRequestSHA256: sha256(context.requestText),
        rawInputInventory: context.inputInventory,
        rawInputTreeSHA256: digestRows(context.inputInventory.map((row) => `${row.sha256}  ${row.path}  ${row.size}`)),
        finalGitCommitBoundHere: false,
      },
      tools: {
        kubaraVersion: context.kubaraVersion,
        kubaraBinarySHA256: context.kubaraBinarySha256,
        catalogVersion: context.catalogVersion,
        helmVersion: context.helmVersion,
      },
      renderProfile: {
        kubeVersion: context.request.spec.render.kubeVersion,
        apiVersions: context.request.spec.render.apiVersions,
        includeCRDs: true,
        includeHooks: true,
        skipTests: true,
        deterministicDoubleRender: true,
      },
      artifacts: selectedExternalArtifacts(context.components).map((row) => ({
        service: row.service,
        dependency: row.dependency,
        version: row.version,
        sourceURL: row.url,
        sha256: row.sha256,
        ...(row.manifestDigest ? { manifestDigest: row.manifestDigest } : {}),
        result: "reviewed-lock-and-archive-verified-during-generate",
      })),
      outputs: { renders: renderRows },
      claimBoundary: [
        "Kubara generation ran before this command and remains the source of component selection, generated wrappers/configs, and topology.",
        "The preparer consumed an explicit reviewed exact artifact lock; it did not infer canonical identity or trust newly downloaded bytes as Catalog approval.",
        "Generate verified exact archives and rendered every enabled instance twice with pinned capabilities; offline verify checks committed bytes and regenerates wiring without network access.",
        "This receipt intentionally precedes the final Git commit, external credential scan, ConfigHub destination binding, OCI publication, apply, and cluster observation.",
      ],
    },
    status: {
      result: "pass",
      cleanHandoff: true,
      appsIncluded: false,
      targetFactsIncluded: false,
      credentialShapedMaterialDetected: false,
      externalCredentialScanRequired: true,
    },
  };
}

function observePreparedRenders(context) {
  return context.instances.map((instance) => {
    const output = join(context.outputRoot, "effective-renders", instance.cluster, instance.service, "release-objects.yaml");
    check(existsSync(output), `${rel(context.outputRoot, output)} is missing`);
    const text = readFileSync(output, "utf8");
    const docs = parseDocs(text).filter(isKubernetesObject);
    return renderRow(context, context.outputRoot, instance, text, docs);
  }).sort(compareRenderRows);
}

function runPreparedWiring(wiringMode, context, root, injected = {}) {
  if (injected.wiringProvider) {
    injected.wiringProvider(root);
    return;
  }
  const script = join(repoRoot, "scripts", "generate-kubara-wiring.mjs");
  command(process.execPath, [script, wiringMode, "--root", root, "--artifact-index", join(root, "component-artifacts.yaml"), "--output", join(root, "wiring", "graph.json"), "--name", context.request.metadata.name], { cwd: repoRoot, label: "prepared handoff wiring extraction" });
}

function validateGraphInventory(root, renderRows) {
  const graph = JSON.parse(readFileSync(join(root, "wiring", "graph.json"), "utf8"));
  check(graph.kind === "KubaraProvidesNeedsGraph" && graph.spec?.evidence?.mode === "offline-effective-render", "prepared wiring graph contract is invalid");
  const expected = renderRows.map((row) => ({ id: `component:${row.cluster}/${row.service}`, objectCount: row.objectCount, selectedVersions: row.selectedVersions })).sort((left, right) => left.id.localeCompare(right.id));
  const actual = (graph.spec?.components ?? []).map((row) => ({ id: row.id, objectCount: row.objectCount, selectedVersions: row.selectedVersions })).sort((left, right) => left.id.localeCompare(right.id));
  check(stableJson(actual) === stableJson(expected), "prepared wiring component/version/object inventory differs from generation receipt renders");
  check(Array.isArray(graph.spec?.evidence?.liveReads) && graph.spec.evidence.liveReads.length === 0, "prepared wiring graph mixed live reads into the Git handoff");
}

function writePreparationEvidence(context, stageRoot, renderRows) {
  const payloadRows = treeRows(stageRoot, new Set(["preparation-receipt.yaml", "checksums.txt"]));
  const receipt = preparationReceiptFor(context, renderRows, payloadRows);
  writeText(join(stageRoot, "preparation-receipt.yaml"), `${toYaml(receipt)}\n`);
  writeText(join(stageRoot, "checksums.txt"), checksumText(stageRoot));
}

function preparationReceiptFor(context, renderRows, payloadRows) {
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraPreparedGitHandoffReceipt",
    metadata: { name: context.request.metadata.name },
    spec: {
      contractVersion: CONTRACT_VERSION,
      cleanOutputLayout: {
        source: "source",
        config: "source/config.yaml",
        components: "generated/platform-components/helm",
        configs: "generated/platform-configs",
        renders: "effective-renders",
        artifactLock: "component-artifacts.yaml",
        generationReceipt: "generation-receipt.yaml",
        wiringGraph: "wiring/graph.json",
      },
      clusterCount: new Set(renderRows.map((row) => row.cluster)).size,
      renderCount: renderRows.length,
      payloads: payloadRows,
      payloadTreeSHA256: digestRows(payloadRows.map((row) => `${row.sha256}  ${row.path}  ${row.size}`)),
      notSelected: [".env", "apps", "target-facts", "Git commit/external-scan/destination facts"],
      refusedIfDetected: ["credential-shaped material detected by the built-in structural scan", "absolute workstation paths", "symlinks", "pre-vendored chart content"],
      nextSteps: ["commit and push the complete prepared output", "scan that exact commit and scope", "inspect the ConfigHub destination", "compile, verify, package, and apply twice"],
    },
    status: { result: "pass", deterministic: true, pathNeutral: true, finalGitCommitBound: false, externalCredentialScanRequired: true },
  };
}

function verifyPreparationEvidence(context, root, renderRows) {
  const payloadRows = treeRows(root, new Set(["preparation-receipt.yaml", "checksums.txt"]));
  const expectedReceipt = `${toYaml(preparationReceiptFor(context, renderRows, payloadRows))}\n`;
  check(readFileSync(join(root, "preparation-receipt.yaml"), "utf8") === expectedReceipt, "preparation-receipt.yaml is stale");
  check(readFileSync(join(root, "checksums.txt"), "utf8") === checksumText(root), "checksums.txt is stale");
}

function verifyStagedPreparation(context, stageRoot) {
  rejectUnsafePreparedTree(stageRoot, context);
  assertPreparedCopyLineage(context, stageRoot);
  const renderRows = context.instances.map((instance) => {
    const output = join(stageRoot, "effective-renders", instance.cluster, instance.service, "release-objects.yaml");
    const text = readFileSync(output, "utf8");
    return renderRow(context, stageRoot, instance, text, parseDocs(text).filter(isKubernetesObject));
  }).sort(compareRenderRows);
  check(readFileSync(join(stageRoot, "generation-receipt.yaml"), "utf8") === `${toYaml(generationReceiptFor(context, renderRows))}\n`, "staged generation receipt is not self-consistent");
  validateGraphInventory(stageRoot, renderRows);
  verifyPreparationEvidence(context, stageRoot, renderRows);
}

function assertPreparedCopyLineage(context, preparedRoot) {
  const mappings = [
    [context.requestPath, join(preparedRoot, "preparation-request.yaml"), "preparation request"],
    [context.sourcePaths.config, join(preparedRoot, "source", "config.yaml"), "Kubara config"],
    [context.sourcePaths.components, join(preparedRoot, "generated", "platform-components", "helm"), "generated component tree"],
    [context.sourcePaths.configs, join(preparedRoot, "generated", "platform-configs"), "generated config tree"],
    [context.sourcePaths.artifactLock, join(preparedRoot, "component-artifacts.yaml"), "reviewed component artifact lock"],
    [context.sourcePaths.sourceLock, join(preparedRoot, "source-lock.yaml"), "Kubara source lock"],
  ];
  if (context.sourcePaths.overrides && existsSync(context.sourcePaths.overrides)) {
    mappings.push([context.sourcePaths.overrides, join(preparedRoot, "source", "overrides"), "documented override tree"]);
  } else {
    check(!existsSync(join(preparedRoot, "source", "overrides")), "prepared output contains an override tree absent from the selected raw inputs");
  }
  for (const [source, destination, label] of mappings) assertExactPreparedCopy(source, destination, label);
}

function assertExactPreparedCopy(source, destination, label) {
  check(existsSync(destination), `${label}: prepared destination is missing`);
  rejectSymlinks(source);
  rejectSymlinks(destination);
  const sourceStat = lstatSync(source);
  const destinationStat = lstatSync(destination);
  check(sourceStat.isFile() === destinationStat.isFile() && sourceStat.isDirectory() === destinationStat.isDirectory(), `${label}: source and prepared destination types differ`);
  if (sourceStat.isFile()) {
    check(readFileSync(source).equals(readFileSync(destination)), `${label}: prepared bytes differ from the selected raw input`);
    return;
  }
  const sourceShape = exactTreeShape(source);
  const destinationShape = exactTreeShape(destination);
  check(stableJson(sourceShape) === stableJson(destinationShape), `${label}: prepared file/directory inventory differs from the selected raw input`);
  for (const row of sourceShape.filter((entry) => entry.type === "file")) {
    check(readFileSync(join(source, row.path)).equals(readFileSync(join(destination, row.path))), `${label}: prepared bytes differ at ${row.path}`);
  }
}

function exactTreeShape(root) {
  return walkEntries(root).map((path) => ({ path: rel(root, path), type: lstatSync(path).isDirectory() ? "directory" : "file" }));
}

function rejectUnsafePreparedTree(root, context) {
  rejectSymlinks(root);
  rejectForbiddenNames(root);
  const findings = [];
  for (const path of walkFiles(root)) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    const label = rel(root, path);
    for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) {
      const nearby = text.slice(match.index, match.index + 512);
      if (!/(?:<private-key>|REPLACE_ME|CHANGEME|redacted)/i.test(nearby)) findings.push(`${label}: PEM private key`);
    }
    if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) findings.push(`${rel(root, path)}: AWS-key-shaped value`);
    if (/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i.test(text)) findings.push(`${rel(root, path)}: credential-bearing URL`);
    if (/\.(?:env|toml|ini|conf|properties|sh|tmpl|tpl)$/i.test(path)) scanRawCredentialAssignments(text, label, findings);
    if (/\.json$/i.test(path)) {
      try {
        const value = JSON.parse(text);
        scanSensitiveMappings(value, label, findings);
        for (const doc of Array.isArray(value) ? value : [value]) scanSecretDocument(doc, label, findings);
      } catch { findings.push(`${label}: JSON input is invalid and cannot be structurally credential-scanned`); }
    } else if (/\.ya?ml$/i.test(path)) {
      let docs;
      try { docs = parseDocs(text); } catch { scanRawCredentialAssignments(text, label, findings); }
      for (const doc of docs ?? []) {
        if (["ClusterSecretStore", "SecretStore"].includes(doc?.kind)
          && doc.spec?.provider?.fake?.data?.some((row) => meaningfulSecretValue(row?.value) || meaningfulSecretValue(row?.valueMap))) {
          findings.push(`${label}: ${doc.kind} ${doc.metadata?.name ?? "unnamed"} embeds fake-provider values`);
        }
        if (doc?.kind === "Secret") scanSecretDocument(doc, label, findings);
        else if (doc?.kind !== "CustomResourceDefinition") scanSensitiveMappings(doc, label, findings);
      }
    }
    if (text.includes(context.checkoutRoot) || text.includes(context.sourceRoot) || (context.kubaraBin && text.includes(context.kubaraBin))) findings.push(`${label}: absolute workstation path`);
  }
  check(findings.length === 0, `prepared handoff contains credential-shaped or forbidden material:\n- ${[...new Set(findings)].join("\n- ")}`);
}

function credentialKeyTokens(key) {
  return String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveSecretKey(key) {
  const tokens = credentialKeyTokens(key);
  const joined = tokens.join("-");
  if (["password", "passwd", "token", "credential", "credentials"].some((token) => tokens.includes(token))) return true;
  if (joined === "auth") return true;
  return [
    /(?:^|-)(?:private|ssh|api|client|secret|access|encryption|signing)-key(?:-|$)/,
    /(?:^|-)(?:auth|bearer|access|refresh|api|client|github|gitlab|slack)-token(?:-|$)/,
    /(?:^|-)access-key-id(?:-|$)/,
    /(?:^|-)secret-access-key(?:-|$)/,
  ].some((pattern) => pattern.test(joined));
}

function nonemptyReference(value) {
  if (typeof value === "string") return /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["key", "name", "remoteKey", "property"].some((key) => typeof value[key] === "string" && value[key].length > 0);
}

function hasSiblingSecretResourceReference(parent) {
  return parent && typeof parent === "object" && [...SECRET_RESOURCE_REFERENCE_FIELDS].some((field) => nonemptyReference(parent[field]));
}

function isStructuredSecretReferenceField({ key, parent, root }) {
  const value = parent?.[key];
  const tokens = credentialKeyTokens(key);
  if (typeof value === "string" && ["file", "path"].includes(tokens.at(-1)) && /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)$/.test(value)) return true;
  if (key === "passwordKey") return hasSiblingSecretResourceReference(parent);
  if (key !== "secretKey") return false;
  if (hasSiblingSecretResourceReference(parent)) return true;
  return EXTERNAL_SECRET_REFERENCE_KINDS.has(root?.kind) && ["remoteRef", "sourceRef"].some((field) => nonemptyReference(parent?.[field]));
}

function scanSensitiveMappings(value, path, findings, trail = [], root = null) {
  const document = root ?? value;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) scanSensitiveMappings(item, path, findings, [...trail, String(index)], root ?? item);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.name === "string" && isSensitiveSecretKey(value.name) && Object.hasOwn(value, "value") && meaningfulSecretValue(value.value)) {
    findings.push(`${path}: literal credential-shaped environment value at ${[...trail, "value"].join(".")}`);
  }
  for (const [key, nested] of Object.entries(value)) {
    const nestedTrail = [...trail, key];
    if (!isStructuredSecretReferenceField({ key, parent: value, root: document }) && isSensitiveSecretKey(key) && typeof nested !== "object" && meaningfulCredentialValue(nested)) findings.push(`${path}: literal credential-shaped value at ${nestedTrail.join(".")}`);
    scanSensitiveMappings(nested, path, findings, nestedTrail, document);
  }
}

function scanRawCredentialAssignments(text, path, findings) {
  const assignment = /^[ \t]*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(.*?)[ \t]*[,;]?[ \t]*$/gm;
  for (const match of text.matchAll(assignment)) {
    if (!isSensitiveSecretKey(match[1])) continue;
    const value = String(match[2] ?? "").replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    if (/\.(?:tpl|tmpl)$/i.test(path) && /\{\{[\s\S]*\}\}/.test(value)) continue;
    if (meaningfulCredentialValue(value)) findings.push(`${path}: literal credential-shaped assignment for ${match[1]}`);
  }
}

function scanSecretDocument(doc, path, findings) {
  if (doc?.kind !== "Secret") return;
  const identity = `Secret ${doc.metadata?.namespace ?? "default"}/${doc.metadata?.name ?? "unnamed"}`;
  for (const field of ["data", "stringData"]) {
    for (const [key, value] of Object.entries(doc[field] ?? {})) {
      const decoded = field === "data" ? decodeBase64(String(value)) : String(value);
      const nested = [];
      scanRawCredentialAssignments(decoded, `${path}: ${identity} ${field}.${key}`, nested);
      if (!SAFE_NONCREDENTIAL_SECRET_KEYS.has(key) || containsCredentialMaterial(decoded) || isSensitiveSecretKey(key) || nested.length > 0) {
        if (meaningfulSecretValue(value)) findings.push(`${path}: ${identity} contains unexternalized ${field}.${key}`);
      }
    }
  }
}

function decodeBase64(value) {
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { return value; }
}

function containsCredentialMaterial(value) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i.test(value)
    || /"(?:password|token|apiKey|clientSecret|privateKey)"\s*:\s*"(?!<|\$\{|REPLACE_ME|CHANGEME|redacted)[^"]+"/i.test(value);
}

function meaningfulSecretValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return !/^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|REPLACE_ME|CHANGEME|redacted|null)$/i.test(String(value).trim());
}

function meaningfulCredentialValue(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return false;
  return meaningfulSecretValue(value) && !/^(?:false|true|none|disabled|enabled)$/i.test(String(value).trim());
}

function rejectForbiddenNames(root) {
  const forbidden = walkEntries(root).filter((path) => {
    const parts = rel(root, path).split("/");
    return parts.some((part) => isForbiddenPreparedBasename(part) || part === "target-facts" || part === "apps" || part === ".git");
  });
  check(forbidden.length === 0, `prepared handoff contains forbidden path(s): ${forbidden.map((path) => rel(root, path)).join(", ")}`);
}

function isForbiddenPreparedBasename(value) {
  return value === ".env" || value.startsWith(".env.") || /^target-facts\.(?:ya?ml|json)$/i.test(value);
}

function preparationInputInventory({ checkoutRoot, requestPath, sourcePaths }) {
  const files = new Set([requestPath]);
  for (const path of Object.values(sourcePaths)) if (existsSync(path)) {
    if (statSync(path).isDirectory()) for (const file of walkFiles(path)) files.add(file);
    else files.add(path);
  }
  return [...files].sort((left, right) => rel(checkoutRoot, left).localeCompare(rel(checkoutRoot, right))).map((path) => ({ path: rel(checkoutRoot, path), sha256: sha256(readFileSync(path)), size: statSync(path).size }));
}

function assertPreparationInputsUnchanged(context) {
  assertNoSymlinkPath(context.checkoutRoot, context.requestPath, "preparation request");
  assertNoSymlinkPath(context.checkoutRoot, context.sourceRoot, "spec.source.path");
  assertNoSymlinkPath(context.checkoutRoot, dirname(context.outputRoot), "spec.output.path parent");
  for (const [key, path] of Object.entries(context.sourcePaths)) if (existsSync(path)) {
    assertNoSymlinkPath(context.sourceRoot, path, `spec.source.layout.${key}`);
    rejectSymlinks(path);
  }
  check(readFileSync(context.requestPath, "utf8") === context.requestText, "preparation request changed while generate was running");
  const observed = preparationInputInventory({ checkoutRoot: context.checkoutRoot, requestPath: context.requestPath, sourcePaths: context.sourcePaths });
  check(stableJson(observed) === stableJson(context.inputInventory), "raw Kubara inputs changed while generate was running; staged output was not promoted");
}

function rejectPreVendoredCharts(componentRoot) {
  const forbidden = walkEntries(componentRoot).filter((path) => {
    const stat = lstatSync(path);
    return (stat.isDirectory() && basename(path) === "charts") || (stat.isFile() && /\.(?:tgz|tar\.gz)$/i.test(basename(path)));
  });
  check(forbidden.length === 0, `raw Kubara components contain pre-vendored chart content; remove it so only reviewed-lock artifacts enter the prepared handoff:\n- ${forbidden.map((path) => rel(componentRoot, path)).join("\n- ")}`);
}

function treeRows(root, excluded = new Set()) {
  return walkFiles(root).map((path) => ({ path: rel(root, path), sha256: sha256(readFileSync(path)), size: statSync(path).size })).filter((row) => !excluded.has(row.path)).sort((left, right) => left.path.localeCompare(right.path));
}

function checksumText(root) {
  return treeRows(root, new Set(["checksums.txt"])).map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
}

function promoteDirectoryAtomically(stageRoot, outputRoot) {
  const backup = `${outputRoot}.backup-${process.pid}`;
  check(!existsSync(backup), `stale exact preparation backup exists: ${backup}`);
  let movedOld = false;
  try {
    if (existsSync(outputRoot)) {
      renameSync(outputRoot, backup);
      movedOld = true;
    }
    renameSync(stageRoot, outputRoot);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(outputRoot) && movedOld && existsSync(backup)) renameSync(backup, outputRoot);
    throw error;
  }
}

function copyExact(source, destination) {
  rejectSymlinks(source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function orderedValues(root) {
  const files = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(root, entry.name)).filter((path) => /(?:^values(?:[.-].*)?\.ya?ml$|^additional-values\.ya?ml$)/.test(basename(path)));
  const rank = (path) => basename(path) === "values.generated.yaml" ? 0 : basename(path) === "additional-values.yaml" ? 1 : 2;
  return files.sort((left, right) => rank(left) - rank(right) || basename(left).localeCompare(basename(right)));
}

function validateArtifactURL(value, label) {
  check(typeof value === "string" && (value.startsWith("https://") || value.startsWith("oci://")), `${label} must be exact HTTPS or OCI`);
  check(!/[{}\s]/.test(value) && !/:\/\/[^/\s:]+:[^@\s]+@/.test(value), `${label} contains a placeholder, whitespace, or credentials`);
  if (value.startsWith("https://")) {
    const parsed = new URL(value);
    check(parsed.username === "" && parsed.password === "" && parsed.hash === "", `${label} must not contain credentials or a fragment`);
  }
}

function defaultToolProbe(kubaraBin, expected) {
  return {
    kubaraVersionOutput: kubaraBin ? command(kubaraBin, ["--version"], { label: "Kubara version" }).trim() : `kubara version ${expected.kubaraVersion}`,
    helmVersion: command("helm", ["version", "--template", "{{.Version}}+g{{.GitCommit}}"], { label: "Helm version" }).trim(),
  };
}

function command(executable, args, { cwd = repoRoot, label = executable } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"], timeout: 1_200_000, maxBuffer: 1024 * 1024 * 300 });
  check(result.status === 0, `${label} failed (exit ${Number.isInteger(result.status) ? result.status : "unavailable"})`);
  return result.stdout ?? "";
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitStatus(checkoutRoot) {
  return git(checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function safeJoin(root, child, label) {
  checkSafeRelative(child, label);
  const path = resolve(root, child);
  check(isWithin(path, root), `${label} escapes its declared root`);
  return path;
}

function assertNoSymlinkPath(root, target, label) {
  check(isWithin(target, root), `${label} escapes its declared root`);
  let cursor = resolve(root);
  for (const part of relative(cursor, resolve(target)).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    check(existsSync(cursor), `${label} path component is missing: ${cursor}`);
    check(!lstatSync(cursor).isSymbolicLink(), `${label} path component is a symbolic link: ${cursor}`);
  }
  check(isWithin(realpathSync(target), realpathSync(root)), `${label} resolves outside its declared real root`);
}

function checkSafeRelative(value, label) {
  check(typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"), `${label} must be a safe relative path`);
}

function isWithin(path, root) {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function rejectSymlinks(root) {
  const visit = (path) => {
    const stat = lstatSync(path);
    check(!stat.isSymbolicLink(), `${path}: symbolic links are refused`);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
    else check(stat.isFile(), `${path}: only regular files and directories are supported`);
  };
  visit(root);
}

function walkEntries(root) {
  const rows = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    rows.push(path);
    if (entry.isDirectory()) rows.push(...walkEntries(path));
  }
  return rows.sort();
}

function walkFiles(root) {
  return walkEntries(root).filter((path) => lstatSync(path).isFile());
}

function checkObjectKeys(value, allowed, required, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  const missing = required.filter((key) => !Object.hasOwn(value, key)).sort();
  check(unknown.length === 0 && missing.length === 0, `${label} fields differ; unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
}

function checkExactKeys(value, keys, label) {
  checkObjectKeys(value, keys, keys, label);
}

function checkSlug(value, label) {
  check(/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value ?? ""), `${label} must be a lowercase DNS-style slug`);
}

function checkExactVersion(value, label) {
  check(/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value), `${label} must be an exact version`);
}

function assertUnique(rows, keyFor, label) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyFor(row);
    check(key && !key.split("\0").some((part) => part === ""), `${label} has an incomplete semantic key`);
    check(!seen.has(key), `${label} has duplicate or conflicting semantic key ${key.replaceAll("\0", "/")}`);
    seen.add(key);
  }
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeService(value) {
  return value === "argocd" ? "argo-cd" : value;
}

function countKinds(docs) {
  const map = new Map();
  for (const doc of docs) map.set(doc.kind, (map.get(doc.kind) ?? 0) + 1);
  return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)));
}

function isKubernetesObject(value) {
  return Boolean(value && value.apiVersion && value.kind && value.metadata?.name);
}

function compareRenderRows(left, right) {
  return left.cluster.localeCompare(right.cluster) || left.service.localeCompare(right.service);
}

function artifactKey(row) {
  return `${normalize(row.service)}\0${row.dependency}\0${row.version}`;
}

function safeFilename(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function digestRows(rows) {
  return sha256([...rows].sort().join("\n") + "\n");
}

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortDeep(nested)]));
  return value;
}

function rel(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  check(index >= 0 && process.argv[index + 1], `${name} is required`);
  return process.argv[index + 1];
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function expectFailure(fn, pattern, label) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  check(error && pattern.test(error.message), `${label}: expected ${pattern}, got ${error?.message ?? "success"}`);
}

function expectFailureContainingAll(fn, fragments, label) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  const message = String(error?.message ?? "");
  check(error && fragments.every((fragment) => message.includes(fragment)), `${label}: expected ${fragments.join(", ")}, got ${message || "success"}`);
}

function selfTest() {
  // Implemented below after the core is loaded; kept in this file so the test
  // can inject offline artifact/render providers without weakening the CLI.
  runSelfTest();
}

function runSelfTest() {
  const testRoot = mkdtempSync(join(tmpdir(), "kubara-git-handoff-selftest-"));
  const currentFixture = join(repoRoot, "examples", "kubara", "current-platform");
  const renderFixture = join(currentFixture, "effective-renders");
  const fakeBinary = join(testRoot, "kubara");
  const fakeBinaryText = "#!/bin/sh\necho 'kubara version v0.13.0'\n";
  writeFileSync(fakeBinary, fakeBinaryText);
  chmodSync(fakeBinary, 0o755);
  const fakeSha = sha256(Buffer.from(fakeBinaryText));
  const toolProbe = () => ({ kubaraVersionOutput: "kubara version v0.13.0", helmVersion: "v4.1.4+g05fa37973dc9e42b76e1d2883494c87174b6074f" });
  const injected = {
    toolProbe,
    artifactVerifier: () => {},
    renderProvider: (instance) => readFileSync(join(renderFixture, instance.cluster, instance.service, "release-objects.yaml"), "utf8"),
  };
  try {
    credentialScannerSelfTest();
    console.log("self-test 1/6: generate at two absolute roots and compare bytes");
    const checkouts = ["absolute-a", "another-absolute-root-b"].map((name) => createSelfTestCheckout({ testRoot, name, currentFixture, fakeSha }));
    const results = checkouts.map((checkout) => generatePreparation({ requestPath: join(checkout, "prepare.yaml"), checkoutRoot: checkout, kubaraBin: fakeBinary }, injected));
    check(results.every((row) => row.renderCount === 13), "self-test expected exactly 13 Kubara component instances");
    const firstOutput = join(checkouts[0], "prepared");
    const secondOutput = join(checkouts[1], "prepared");
    check(stableJson(treeRows(firstOutput)) === stableJson(treeRows(secondOutput)), "prepared handoff is not byte-identical across different absolute checkout roots");
    assertCurrentRenderParity(firstOutput, renderFixture);
    const graph = JSON.parse(readFileSync(join(firstOutput, "wiring", "graph.json"), "utf8"));
    check(graph.spec.components.length === 13, "prepared wiring graph must contain exactly 13 component instances");
    check(graph.spec.evidence.kubaraVersion === "v0.13.0" && graph.spec.evidence.catalogVersion === "1.1.0", "prepared wiring graph did not bind exact Kubara and Catalog versions from the source lock");
    check(!walkEntries(firstOutput).some((path) => ["apps", "target-facts", ".env"].includes(basename(path))), "prepared output leaked an excluded path");

    const priorOutput = stableJson(treeRows(firstOutput));
    const fastInjected = {
      ...injected,
      wiringProvider: (root) => copyExact(join(firstOutput, "wiring", "graph.json"), join(root, "wiring", "graph.json")),
    };
    console.log("self-test 2/6: deterministic rerun, interruption, and input-race refusal");
    generatePreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: fakeBinary }, fastInjected);
    check(stableJson(treeRows(firstOutput)) === priorOutput, "deterministic rerun changed prepared bytes");
    expectFailure(
      () => generatePreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: fakeBinary }, { ...fastInjected, beforePromote: () => { throw new Error("injected interruption"); } }),
      /injected interruption/,
      "atomic interruption",
    );
    check(stableJson(treeRows(firstOutput)) === priorOutput, "atomic interruption did not preserve the prior output");

    const configPath = join(checkouts[0], "raw", "source", "config.yaml");
    const originalConfig = readFileSync(configPath, "utf8");
    expectFailure(
      () => generatePreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: fakeBinary }, {
        ...fastInjected,
        beforePromote: () => writeFileSync(configPath, `${originalConfig}\n# concurrent edit\n`),
      }),
      /raw Kubara inputs changed while generate was running/,
      "concurrent source mutation",
    );
    writeFileSync(configPath, originalConfig);
    check(stableJson(treeRows(firstOutput)) === priorOutput, "concurrent source mutation replaced prior output");
    const rawRoot = join(checkouts[0], "raw");
    const rawBackup = join(checkouts[0], "raw-before-ancestor-swap");
    const outsideSource = join(testRoot, "outside-source-after-load");
    mkdirSync(outsideSource);
    try {
      expectFailure(
        () => generatePreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: fakeBinary }, {
          ...fastInjected,
          beforePromote: () => {
            renameSync(rawRoot, rawBackup);
            symlinkSync(outsideSource, rawRoot);
          },
        }),
        /spec\.source\.path path component is a symbolic link/,
        "concurrent source ancestor symlink swap",
      );
    } finally {
      if (existsSync(rawRoot) && lstatSync(rawRoot).isSymbolicLink()) unlinkSync(rawRoot);
      if (existsSync(rawBackup)) renameSync(rawBackup, rawRoot);
    }
    check(stableJson(treeRows(firstOutput)) === priorOutput, "source ancestor swap replaced prior output");

    console.log("self-test 3/6: structural credential and secret refusals");
    const context = loadContext({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: fakeBinary, requireClean: false, toolProbe });
    runSecurityRefusalTests({ checkout: checkouts[0], fakeBinary, injected: fastInjected, priorOutput, context, testRoot });
    runArtifactContractRefusalTests(checkouts[0]);
    runFilesystemRefusalTests({ checkout: checkouts[0], fakeBinary, injected: fastInjected, priorOutput, testRoot });

    console.log("self-test 4/6: commit and offline zero-write verification");
    for (const checkout of checkouts) commitAll(checkout, "prepared Kubara Git handoff");
    const statusBefore = gitStatus(checkouts[0]);
    verifyPreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: null }, { toolProbe });
    check(gitStatus(checkouts[0]) === statusBefore, "offline verify changed repository state");
    runPreparedCopyLineageTamperRefusal({ checkout: checkouts[0], toolProbe });
    verifyPreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: null }, { toolProbe });
    writeFileSync(configPath, `${originalConfig}\n# dirty verify refusal\n`);
    expectFailure(
      () => verifyPreparation({ requestPath: join(checkouts[0], "prepare.yaml"), checkoutRoot: checkouts[0], kubaraBin: null }, { toolProbe }),
      /committed and clean/,
      "dirty verify",
    );
    writeFileSync(configPath, originalConfig);
    check(gitStatus(checkouts[0]) === "", "self-test failed to restore the clean checkout after dirty verify refusal");
    console.log("self-test 5/6: importer compile and verify the prepared subtree");
    runImporterContractTest(checkouts[0], testRoot);
    console.log("self-test 6/6: all checks passed");
    console.log("Kubara Git handoff preparer self-test passed: path-neutral, atomic, security-refusing, offline-verified, importer-compatible");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function createSelfTestCheckout({ testRoot, name, currentFixture, fakeSha }) {
  const checkout = join(testRoot, name, "checkout");
  mkdirSync(checkout, { recursive: true });
  cpSync(currentFixture, join(checkout, "raw"), { recursive: true });
  const sourceLockPath = join(checkout, "raw", "source-lock.yaml");
  const sourceLock = readYaml(sourceLockPath);
  sourceLock.spec.kubara.release.extractedBinarySha256 = fakeSha;
  writeFileSync(sourceLockPath, `${toYaml(sourceLock)}\n`);
  writeFileSync(join(checkout, "prepare.yaml"), `${toYaml(selfTestPreparationRequest())}\n`);
  gitInit(checkout);
  return checkout;
}

function selfTestPreparationRequest() {
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraGitHandoffPreparation",
    metadata: { name: "kubara-current-four-cluster" },
    spec: {
      source: {
        path: "raw",
        layout: {
          config: "source/config.yaml",
          components: "generated/platform-components/helm",
          configs: "generated/platform-configs",
          artifactLock: "component-artifacts.yaml",
          sourceLock: "source-lock.yaml",
          overrides: "source/overrides",
        },
      },
      output: { path: "prepared" },
      render: {
        kubeVersion: "1.35.0",
        apiVersions: [
          "argoproj.io/v1alpha1", "argoproj.io/v1alpha1/Application", "argoproj.io/v1alpha1/ApplicationSet",
          "cert-manager.io/v1", "cert-manager.io/v1/Certificate", "cert-manager.io/v1/ClusterIssuer",
          "external-secrets.io/v1", "external-secrets.io/v1/ClusterExternalSecret", "external-secrets.io/v1/ClusterSecretStore", "external-secrets.io/v1/ExternalSecret",
          "monitoring.coreos.com/v1", "monitoring.coreos.com/v1/PodMonitor", "monitoring.coreos.com/v1/PrometheusRule", "monitoring.coreos.com/v1/ServiceMonitor",
          "traefik.io/v1alpha1", "traefik.io/v1alpha1/IngressRoute", "traefik.io/v1alpha1/Middleware",
        ],
        services: {
          "argo-cd": { releaseName: "argo-cd", namespace: "argocd" },
          "cert-manager": { releaseName: "cert-manager", namespace: "cert-manager" },
          "external-secrets": { releaseName: "external-secrets", namespace: "external-secrets" },
          "homer-dashboard": { releaseName: "homer-dashboard", namespace: "homer-dashboard" },
          "kube-prometheus-stack": { releaseName: "kube-prometheus-stack", namespace: "monitoring" },
          "metrics-server": { releaseName: "metrics-server", namespace: "kube-system" },
          traefik: { releaseName: "traefik", namespace: "traefik" },
        },
      },
      tools: { helmVersion: "v4.1.4+g05fa37973dc9e42b76e1d2883494c87174b6074f" },
    },
  };
}

function assertCurrentRenderParity(outputRoot, renderFixture) {
  const expected = treeRows(renderFixture);
  const actual = treeRows(join(outputRoot, "effective-renders"));
  check(stableJson(actual) === stableJson(expected), "prepared effective renders are not byte-identical to the reviewed current fixture");
}

function credentialScannerSelfTest() {
  const legitimateReferences = [
    {
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: { name: "database" },
      spec: { data: [{ secretKey: "database-password", remoteRef: { key: "production/database", property: "password" } }] },
    },
    { grafana: { admin: { existingSecret: "grafana-admin-credentials", passwordKey: "admin-password" } } },
  ];
  for (const [index, value] of legitimateReferences.entries()) {
    const findings = [];
    scanSensitiveMappings(value, `legitimate-reference-${index}.yaml`, findings);
    check(findings.length === 0, `credential scanner rejected a structured secret reference: ${findings.join("; ")}`);
  }
  const literals = [
    { credentials: { secretKey: "literal-secret-key" } },
    { kind: "ConfigMap", credentials: { secretKey: "literal-despite-remote-ref", remoteRef: { key: "not-an-external-secret" } } },
    { grafana: { adminPassword: "literal-admin-password" } },
    { aws: { secretAccessKey: "literal-secret-access-key", accessKeyId: "literal-access-key-id" } },
    { oauth: { bearerToken: "literal-bearer-token" } },
    { env: [{ name: "databasePassword", value: "literal-environment-password" }] },
  ];
  for (const [index, value] of literals.entries()) {
    const findings = [];
    scanSensitiveMappings(value, `literal-credential-${index}.yaml`, findings);
    check(findings.length > 0, `credential scanner accepted literal camelCase credential fixture ${index}`);
  }
  const rawFindings = [];
  scanRawCredentialAssignments("adminPassword: literal-template-password\n", "literal-credential.tpl", rawFindings);
  check(rawFindings.length === 1, "credential scanner accepted a raw camelCase credential assignment");
  const templateFindings = [];
  scanRawCredentialAssignments('adminPassword: "{{ .Values.adminPassword }}"\n', "templated-reference.tpl", templateFindings);
  check(templateFindings.length === 0, "credential scanner rejected an unresolved Helm template expression as a literal");
}

function runSecurityRefusalTests({ checkout, fakeBinary, injected, priorOutput, context, testRoot }) {
  const root = join(checkout, "raw", "generated", "platform-configs", "hx-app-dev", "helm", "metrics-server");
  const cases = [
    ["unexternalized-secret.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: bad\nstringData:\n  password: definitely-secret\n", /credential-shaped or forbidden material/],
    ["fake-store.yaml", "apiVersion: external-secrets.io/v1\nkind: SecretStore\nmetadata:\n  name: fake\nspec:\n  provider:\n    fake:\n      data:\n        - key: token\n          value: definitely-secret\n", /embeds fake-provider values/],
    ["literal-token.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: bad\ndata:\n  api-token: definitely-secret\n", /literal credential-shaped value/],
    ["literal-secret-key.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: bad\ndata:\n  credentials:\n    secretKey: definitely-secret\n", /literal credential-shaped value/],
    ["literal-aws-keys.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: bad\ndata:\n  accessKeyId: example-access\n  secretAccessKey: definitely-secret\n", /literal credential-shaped value/],
  ];
  for (const [index, [name, text, pattern]] of cases.entries()) {
    const path = join(root, name);
    if (index === 0) {
      writeFileSync(path, text);
      expectFailure(() => generatePreparation({ requestPath: join(checkout, "prepare.yaml"), checkoutRoot: checkout, kubaraBin: fakeBinary }, injected), pattern, `security refusal ${name}`);
      unlinkSync(path);
      check(stableJson(treeRows(join(checkout, "prepared"))) === priorOutput, `${name} refusal replaced prior output`);
    } else {
      const candidate = mkdtempSync(join(testRoot, "security-candidate-"));
      try {
        cpSync(join(checkout, "prepared"), candidate, { recursive: true });
        const candidatePath = join(candidate, "generated", "platform-configs", "hx-app-dev", "helm", "metrics-server", name);
        writeFileSync(candidatePath, text);
        expectFailure(() => rejectUnsafePreparedTree(candidate, context), pattern, `security refusal ${name}`);
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
    }
  }
}

function runArtifactContractRefusalTests(checkout) {
  const components = join(checkout, "raw", "generated", "platform-components", "helm");
  const artifactPath = join(checkout, "raw", "component-artifacts.yaml");
  const artifactSet = readYaml(artifactPath);
  const missing = structuredClone(artifactSet);
  missing.spec.artifacts = missing.spec.artifacts.filter((row) => normalize(row.service) !== normalize("metrics-server"));
  expectFailure(() => discoverComponentContracts(components, missing), /no reviewed exact artifact mapping/, "missing reviewed artifact");
  const duplicate = structuredClone(artifactSet);
  duplicate.spec.artifacts.push({ ...duplicate.spec.artifacts[0], sha256: "f".repeat(64) });
  expectFailure(() => validateArtifactSet(duplicate), /duplicate or conflicting semantic key/, "ambiguous artifact");
  const oci = structuredClone(artifactSet);
  const ociRow = oci.spec.artifacts.find((row) => row.url.startsWith("oci://"));
  delete ociRow.manifestDigest;
  expectFailure(() => validateArtifactSet(oci), /OCI manifestDigest is mandatory/, "OCI manifest digest");
  const additiveOldVersion = structuredClone(artifactSet);
  additiveOldVersion.spec.artifacts.push({
    service: "unused-retained", canonicalIdentity: "helm:example/unused", wrapperVersion: "0.1.0", version: "1.0.0",
    url: "https://example.invalid/unused-1.0.0.tgz", sha256: "e".repeat(64),
  });
  validateArtifactSet(additiveOldVersion);
  discoverComponentContracts(components, additiveOldVersion);
  const argoChartPath = join(components, "argo-cd", "Chart.yaml");
  const originalArgoChart = readFileSync(argoChartPath, "utf8");
  const chart = readYaml(argoChartPath);
  const local = chart.dependencies.find((row) => String(row.repository).startsWith("file://"));
  local.repository = "file://../nested/template-library";
  writeFileSync(argoChartPath, `${toYaml(chart)}\n`);
  expectFailure(() => discoverComponentContracts(components, artifactSet), /exact sibling form/, "non-sibling local dependency");
  writeFileSync(argoChartPath, originalArgoChart);
}

function runFilesystemRefusalTests({ checkout, fakeBinary, injected, priorOutput, testRoot }) {
  const component = join(checkout, "raw", "generated", "platform-components", "helm", "metrics-server");
  const charts = join(component, "charts");
  mkdirSync(charts);
  writeFileSync(join(charts, "opaque.tgz"), "opaque");
  expectFailure(() => generatePreparation({ requestPath: join(checkout, "prepare.yaml"), checkoutRoot: checkout, kubaraBin: fakeBinary }, injected), /pre-vendored chart content/, "pre-vendored chart refusal");
  rmSync(charts, { recursive: true });
  const link = join(component, "linked-values.yaml");
  symlinkSync(join(component, "values.yaml"), link);
  expectFailure(() => generatePreparation({ requestPath: join(checkout, "prepare.yaml"), checkoutRoot: checkout, kubaraBin: fakeBinary }, injected), /symbolic links are refused/, "symlink refusal");
  unlinkSync(link);
  const selectedConfigRoot = join(checkout, "raw", "generated", "platform-configs", "hx-app-dev", "helm", "metrics-server");
  const dotenvPath = join(selectedConfigRoot, ".env.production");
  const targetFactsPath = join(selectedConfigRoot, "target-facts.yaml");
  writeFileSync(dotenvPath, "ADMIN_PASSWORD=literal-selected-input\n");
  writeFileSync(targetFactsPath, "apiVersion: evidence.confighub.com/v1alpha1\nkind: TargetFacts\n");
  try {
    expectFailureContainingAll(
      () => generatePreparation({ requestPath: join(checkout, "prepare.yaml"), checkoutRoot: checkout, kubaraBin: fakeBinary }, injected),
      [".env.production", "target-facts.yaml"],
      "dotenv and singular target-fact selected-input refusal",
    );
  } finally {
    if (existsSync(dotenvPath)) unlinkSync(dotenvPath);
    if (existsSync(targetFactsPath)) unlinkSync(targetFactsPath);
  }
  const baseRequest = selfTestPreparationRequest();
  const sourceAlias = join(checkout, "raw-alias");
  symlinkSync(join(checkout, "raw"), sourceAlias);
  const sourceAliasRequest = structuredClone(baseRequest);
  sourceAliasRequest.spec.source.path = "raw-alias";
  const sourceAliasRequestPath = join(checkout, "source-alias.prepare.yaml");
  writeFileSync(sourceAliasRequestPath, `${toYaml(sourceAliasRequest)}\n`);
  expectFailure(() => generatePreparation({ requestPath: sourceAliasRequestPath, checkoutRoot: checkout, kubaraBin: fakeBinary }, injected), /spec\.source\.path path component is a symbolic link/, "source ancestor symlink refusal");
  unlinkSync(sourceAliasRequestPath);
  unlinkSync(sourceAlias);
  const outside = join(testRoot, "outside-output-parent");
  mkdirSync(outside);
  const outputAlias = join(checkout, "output-alias");
  symlinkSync(outside, outputAlias);
  const outputAliasRequest = structuredClone(baseRequest);
  outputAliasRequest.spec.output.path = "output-alias/prepared";
  const outputAliasRequestPath = join(checkout, "output-alias.prepare.yaml");
  writeFileSync(outputAliasRequestPath, `${toYaml(outputAliasRequest)}\n`);
  expectFailure(() => generatePreparation({ requestPath: outputAliasRequestPath, checkoutRoot: checkout, kubaraBin: fakeBinary }, injected), /spec\.output\.path parent path component is a symbolic link/, "output ancestor symlink refusal");
  unlinkSync(outputAliasRequestPath);
  unlinkSync(outputAlias);
  check(stableJson(treeRows(join(checkout, "prepared"))) === priorOutput, "filesystem refusal replaced prior output");
}

function runPreparedCopyLineageTamperRefusal({ checkout, toolProbe }) {
  const requestPath = join(checkout, "prepare.yaml");
  const context = loadContext({ requestPath, checkoutRoot: checkout, kubaraBin: null, requireClean: true, toolProbe });
  const copiedConfig = join(context.outputRoot, "source", "config.yaml");
  const receiptPath = join(context.outputRoot, "preparation-receipt.yaml");
  const checksumsPath = join(context.outputRoot, "checksums.txt");
  const originals = new Map([copiedConfig, receiptPath, checksumsPath].map((path) => [path, readFileSync(path)]));
  let tamperCommitted = false;
  try {
    writeFileSync(copiedConfig, `${readFileSync(copiedConfig, "utf8")}\n# prepared-only tamper\n`);
    writePreparationEvidence(context, context.outputRoot, observePreparedRenders(context));
    commitAll(checkout, "self-consistent prepared copy tamper");
    tamperCommitted = true;
    expectFailure(
      () => verifyPreparation({ requestPath, checkoutRoot: checkout, kubaraBin: null }, { toolProbe }),
      /Kubara config: prepared bytes differ from the selected raw input/,
      "self-consistent prepared copy lineage tamper",
    );
  } finally {
    for (const [path, bytes] of originals) writeFileSync(path, bytes);
    if (tamperCommitted) commitAll(checkout, "restore exact prepared copy lineage");
  }
}

function runImporterContractTest(checkout, testRoot) {
  const commit = git(checkout, ["rev-parse", "HEAD"]);
  const request = readYaml(join(repoRoot, "examples", "kubara", "git-import", "request.example.yaml"));
  fillImporterInspectionPlaceholders(request);
  request.metadata.name = "prepared-self-test";
  request.spec.source.repository = "https://example.invalid/prepared-self-test.git";
  request.spec.source.commit = commit;
  request.spec.source.path = "prepared";
  request.spec.security.credentialScan.sourceCommit = commit;
  request.spec.security.credentialScan.scopePath = "prepared";
  request.spec.security.credentialScan.reportSHA256 = `sha256:${sha256(`external-scan:${commit}:prepared`)}`;
  const requestPath = join(checkout, "import.yaml");
  writeFileSync(requestPath, `${toYaml(request)}\n`);
  const output = join(testRoot, "compiled-import");
  const importer = join(repoRoot, "scripts", "import-kubara-git-revision.mjs");
  selfTestCommand(process.execPath, [importer, "--compile", "--request", requestPath, "--checkout", checkout, "--output", output], "prepared handoff importer compile");
  selfTestCommand(process.execPath, [importer, "--verify", "--request", requestPath, "--checkout", checkout, "--output", output], "prepared handoff importer verify");
  unlinkSync(requestPath);
}

function fillImporterInspectionPlaceholders(value) {
  if (Array.isArray(value)) {
    for (const item of value) fillImporterInspectionPlaceholders(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (["dataHash", "dataSHA256"].includes(key) && (typeof nested !== "string" || !/^[0-9a-f]{64}$/.test(nested))) value[key] = "0".repeat(64);
    else fillImporterInspectionPlaceholders(nested);
  }
}

function selfTestCommand(executable, args, label) {
  const result = spawnSync(executable, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_200_000, maxBuffer: 1024 * 1024 * 300 });
  check(result.status === 0, `${label} failed:\n${String(result.stderr || result.stdout).trim()}`);
}

function gitInit(checkout) {
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["config", "user.email", "selftest@example.invalid"]);
  git(checkout, ["config", "user.name", "Kubara handoff self-test"]);
  git(checkout, ["remote", "add", "origin", "https://example.invalid/prepared-self-test.git"]);
}

function commitAll(checkout, message) {
  git(checkout, ["add", "--all"]);
  git(checkout, ["commit", "--quiet", "-m", message]);
  return git(checkout, ["rev-parse", "HEAD"]);
}
