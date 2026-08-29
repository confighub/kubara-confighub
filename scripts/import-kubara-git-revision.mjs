#!/usr/bin/env node

// Compile one immutable Kubara Git revision into a deterministic ConfigHub
// import contract. This is a semantic bridge, not an AI migration:
//
//   Kubara config + generated charts/configs + exact locks + effective renders
//     -> component-first OCI plan
//     -> ConfigHub Spaces, Units, lineage, and NeedsProvides plan
//     -> target-fact boundary and app-ready handoff
//
// Publication and ConfigHub reconciliation are implemented as an exact,
// reuse-or-refuse boundary; OCI publication requires exclusive single-writer
// control of the selected repository base. Cluster convergence remains a separate observation:
// this importer will not turn a ConfigHub release receipt into a cluster claim.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  check,
  parseDocs,
  readYaml,
  sha256,
  toYaml,
} from "./lib/proof-common.mjs";

const MODES = new Set([
  "--plan",
  "--compile",
  "--verify",
  "--compile-portable",
  "--verify-portable",
  "--package-portable",
  "--bind",
  "--self-test",
  "--package",
  "--apply",
  "--inspect-destination",
]);
const MIN_CUB_VERSION = "0.2.11";
const IMPORTER_CONTRACT_VERSION = "v1.2.0";
const OCI_ARTIFACT_TYPE = "application/vnd.confighub.kubara.package.v1+json";
const OCI_LAYER_TYPE = "application/vnd.confighub.kubara.payload.v1+json";
const OCI_INDEX_ARTIFACT_TYPE = "application/vnd.confighub.kubara.index.v1+json";
const OCI_INDEX_LAYER_TYPE = "application/vnd.confighub.kubara.index.payload.v1+json";
const UNCHANGED_RELEASE_ERROR = "no changes were made since :latest bundle";
const PUBLIC_GUIDE_URL = "https://confighub.github.io/helm-expt/site/kubara.html";
const PUBLIC_CATALOG_URL = "https://confighub.github.io/helm-expt/site/charts/";
const FIXTURE_SPACE_RELEASE_OCI_BASE = "oci://oci.nonprod.example.invalid:5443/spaces";
const PUBLIC_NAVIGATION_ANNOTATIONS = Object.freeze({
  "URL-Guide": PUBLIC_GUIDE_URL,
  "URL-Catalog": PUBLIC_CATALOG_URL,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNED_SPACE_LABELS = new Set([
  "ManagedBy", "ImportName", "GitCommit", "PlatformDigest", "KubaraVersion", "CatalogVersion",
  "Cluster", "Environment", "Region", "Role", "Scope", "DefinitionScope", "Component",
  "ComponentSurface", "Owner", "KubaraComponent", "ComponentVersion", "WrapperVersion", "BundledVersions", "Layer", "SourceType",
  "Variant", "InstanceOf", "DefinitionSpace", "ClusterRole", "KubaraStage", "DeliveryMode",
  "Reconciler", "ControlPlane", "Catalog", "CatalogComponent", "StartHere", "KubaraTopologyRole", "Disposition", "Lane",
  "RuntimeVersion", "RuntimeImage",
]);
const OWNED_UNIT_LABELS = new Set([...OWNED_SPACE_LABELS, "ApplicationKind", "SourceSpace"]);
const PINNED_GUI_LABELS = new Set([...OWNED_UNIT_LABELS].filter((key) => !["ManagedBy", "ImportName", "GitCommit", "PlatformDigest"].includes(key)));
const OWNED_LINK_LABELS = new Set([
  "ManagedBy", "ImportName", "GitCommit", "PlatformDigest", "KubaraVersion", "CatalogVersion", "Role", "Relationship",
  "ConsumerComponent", "ProviderComponent",
]);
const OWNED_ANNOTATIONS = new Set([
  ...Object.keys(PUBLIC_NAVIGATION_ANNOTATIONS),
  "URL-Matrix",
  "URL-Wiring",
  "import.confighub.com/platform-digest",
  "import.confighub.com/source-repository",
  "import.confighub.com/source-commit",
  "import.confighub.com/source-path",
  "import.confighub.com/source-sha256",
  "import.confighub.com/oci-ref",
  "import.confighub.com/oci-manifest-digest",
  "import.confighub.com/oci-layer-digest",
  "import.confighub.com/reason",
]);
const SAFE_NONCREDENTIAL_SECRET_KEYS = new Set(["config", "name", "server", "alertmanager.yaml", "ca.crt", "tls.crt"]);
const SECRET_RESOURCE_REFERENCE_FIELDS = new Set([
  "existingSecret", "secretName", "secretRef", "secretKeyRef",
]);
const EXTERNAL_SECRET_REFERENCE_KINDS = new Set([
  "ClusterExternalSecret", "ExternalSecret", "PushSecret",
]);
const args = process.argv.slice(2);
validateCliArgs(args);
const selectedModes = args.filter((arg) => MODES.has(arg));

if (args.includes("--help") || selectedModes.length === 0) {
  usage();
  process.exit(selectedModes.length === 0 && !args.includes("--help") ? 1 : 0);
}
check(selectedModes.length === 1, `choose one mode: ${[...MODES].join(", ")}`);
const mode = selectedModes[0];

if (mode === "--self-test") {
  selfTest();
  process.exit(0);
}

if (mode === "--inspect-destination") {
  const requestPath = resolve(requiredOption("--request"));
  const outputPath = resolve(requiredOption("--output"));
  const context = requiredOption("--context");
  const credentialScanReportPath = resolve(requiredOption("--credential-scan-report"));
  const runtimeEvidence = optionValues("--runtime-evidence");
  inspectDestination({ requestPath, outputPath, context, credentialScanReportPath, runtimeEvidence });
  console.log(`inspected exact ConfigHub destination into ${outputPath}`);
  process.exit(0);
}

if (["--compile-portable", "--verify-portable", "--package-portable"].includes(mode)) {
  const requestPath = resolve(requiredOption("--request"));
  const checkoutRoot = resolve(requiredOption("--checkout"));
  const outputRoot = resolve(requiredOption("--output"));
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "portable compilation");
  const compiled = compilePortableRequest({ requestPath, checkoutRoot });
  if (mode === "--compile-portable") {
    writePortableOutputs(outputRoot, compiled);
    console.log(`compiled portable Kubara package set ${compiled.lock.spec.platformDigest} -> ${outputRoot}`);
  } else if (mode === "--verify-portable") {
    verifyPortableOutputs(outputRoot, compiled);
    console.log(`verified portable Kubara package set ${compiled.lock.spec.platformDigest} in ${outputRoot}`);
  } else {
    writePortableOutputs(outputRoot, compiled);
    const receipt = packageImport({ compiled, outputRoot });
    console.log(`published portable Kubara package set ${compiled.lock.spec.platformDigest}: ${receipt.spec.members.length} exact OCI member(s) plus one digest index`);
  }
  process.exit(0);
}

const requestPath = requiredOption("--request");
const checkoutRoot = resolve(requiredOption("--checkout"));
const outputRoot = mode === "--plan" ? "" : resolve(requiredOption("--output"));
const compiled = compileImport({ requestPath: resolve(requestPath), checkoutRoot });

if (mode === "--plan") {
  process.stdout.write(compiled.planText);
} else if (mode === "--compile") {
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "compilation");
  writeOutputs(outputRoot, compiled);
  console.log(`compiled Kubara Git import ${compiled.lock.spec.platformDigest} -> ${outputRoot}`);
} else if (mode === "--verify") {
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "verification");
  verifyOutputs(outputRoot, compiled);
  console.log(`verified Kubara Git import ${compiled.lock.spec.platformDigest} in ${outputRoot}`);
} else if (mode === "--package") {
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "packaging");
  writeOutputs(outputRoot, compiled);
  const receipt = packageImport({ compiled, outputRoot });
  console.log(`packaged Kubara Git import ${compiled.lock.spec.platformDigest}: ${receipt.spec.members.length} exact OCI member(s) plus one digest index`);
} else if (mode === "--bind") {
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "binding");
  const portableRoot = resolve(requiredOption("--portable"));
  check(portableRoot !== outputRoot, "--portable and --output must be separate directories");
  verifyPortableOutputs(portableRoot, compiled);
  assertBindOutputReplaySafe(outputRoot, compiled);
  writeOutputs(outputRoot, compiled);
  copyPortablePublication({ portableRoot, outputRoot, compiled });
  console.log(`bound portable Kubara package set ${compiled.lock.spec.platformDigest} to ${compiled.plan.spec.bindingDigest} -> ${outputRoot}`);
} else {
  assertOutputOutsideCheckout(outputRoot, checkoutRoot, "apply");
  verifyOutputs(outputRoot, compiled);
  const context = requiredOption("--context");
  const targetFactsPath = resolve(requiredOption("--target-facts"));
  const receiptOutputOption = optionValue("--receipt-output");
  const receiptOutputPath = receiptOutputOption
    ? prepareImmutableApplyReceiptEvidencePath({ outputRoot, path: resolve(receiptOutputOption) })
    : null;
  const previousApplyReceiptPath = optionValue("--previous-apply-receipt");
  const receipt = applyImport({ compiled, outputRoot, context, targetFactsPath, previousApplyReceiptPath: previousApplyReceiptPath ? resolve(previousApplyReceiptPath) : null });
  if (receiptOutputPath) writeImmutableApplyReceiptEvidence(receiptOutputPath, receipt);
  console.log(`applied Kubara Git import ${compiled.lock.spec.platformDigest}: ${receipt.status.lastActionCount} action(s); ${receipt.status.result}`);
}

function inspectDestination({ requestPath, outputPath, context, credentialScanReportPath, runtimeEvidence, inspector = null }) {
  check(existsSync(requestPath), `request template does not exist: ${requestPath}`);
  check(resolve(requestPath) !== resolve(outputPath), "destination inspection output must not overwrite its input template");
  check(existsSync(credentialScanReportPath) && !lstatSync(credentialScanReportPath).isSymbolicLink(), "credential scan report must be an existing real file");
  const request = readYaml(requestPath);
  check(request?.apiVersion === "import.confighub.com/v1alpha1" && request?.kind === "KubaraGitRevisionImport", "inspection request template apiVersion/kind is invalid");
  const evidenceFiles = new Map();
  for (const value of runtimeEvidence) {
    const separator = value.indexOf("=");
    check(separator > 0, `--runtime-evidence must use <cluster>=<observation.yaml>, got ${value}`);
    const cluster = value.slice(0, separator);
    const path = resolve(value.slice(separator + 1));
    checkSlug(cluster, "runtime-evidence cluster");
    check(!evidenceFiles.has(cluster), `${cluster}: duplicate --runtime-evidence`);
    check(existsSync(path) && !lstatSync(path).isSymbolicLink(), `${cluster}: runtime evidence must be an existing real file`);
    evidenceFiles.set(cluster, path);
  }
  const targetClusters = Object.keys(request.spec?.targets ?? {}).sort();
  check(stableJson([...evidenceFiles.keys()].sort()) === stableJson(targetClusters), "--runtime-evidence must provide exactly one file for every request target cluster");
  const client = inspector ?? createCubInspectionClient(context);
  const coordinate = client.context();
  check(coordinate.name === context, `cub context drifted from ${context} to ${coordinate.name || "unknown"}`);
  const organization = client.organization(coordinate.organizationExternalID);
  check(organization, `ConfigHub Organization ${coordinate.organizationExternalID} is missing`);
  request.spec.destination.context = context;
  request.spec.destination.organization = coordinate.organizationName;
  request.spec.destination.organizationExternalID = coordinate.organizationExternalID;
  request.spec.destination.organizationID = organization.OrganizationID;
  request.spec.destination.serverURL = coordinate.serverURL;
  request.spec.security.credentialScan.sourceCommit = request.spec.source.commit;
  request.spec.security.credentialScan.scopePath = request.spec.source.path;
  request.spec.security.credentialScan.reportSHA256 = `sha256:${sha256(readFileSync(credentialScanReportPath))}`;

  const exactSpace = (slug, label) => {
    const row = client.space(slug);
    check(row?.Slug === slug && UUID_PATTERN.test(row.SpaceID ?? ""), `${label} Space ${slug} is missing or lacks an exact ID`);
    check(row.OrganizationID === organization.OrganizationID, `${label} Space ${slug} belongs to another Organization entity`);
    return row;
  };
  const exactUnit = (space, slug, label) => {
    const row = client.unit(space, slug);
    check(row?.Slug === slug && UUID_PATTERN.test(row.UnitID ?? ""), `${label} Unit ${space}/${slug} is missing or lacks an exact ID`);
    const data = client.unitData(space, slug);
    return { row, data };
  };
  const destination = request.spec.destination;
  const baseSpace = exactSpace(destination.argobotBase.space, "argobot base");
  const baseUnit = exactUnit(destination.argobotBase.space, destination.argobotBase.unit, "argobot base");
  let externalSources;
  try { externalSources = JSON.parse(baseSpace.Annotations?.["confighub.com/external-source"] ?? "null"); } catch { check(false, `${destination.argobotBase.space}: external-source annotation is invalid JSON`); }
  check(Array.isArray(externalSources) && externalSources.length === 1, `${destination.argobotBase.space}: expected exactly one external-source ref/digest`);
  destination.argobotBase.spaceID = baseSpace.SpaceID;
  destination.argobotBase.unitID = baseUnit.row.UnitID;
  destination.argobotBase.componentVersion = baseUnit.row.Labels?.ComponentVersion;
  destination.argobotBase.sourceRef = externalSources[0].ref;
  destination.argobotBase.sourceDigest = externalSources[0].digest;
  destination.argobotBase.dataHash = baseUnit.row.DataHash;
  destination.argobotBase.dataSHA256 = sha256(baseUnit.data);

  for (const [cluster, target] of Object.entries(request.spec.targets).sort(([left], [right]) => left.localeCompare(right))) {
    const targetSpace = exactSpace(target.space, `${cluster} target`);
    const targetEntity = client.target(target.space, target.target);
    check(targetEntity?.Slug === target.target && UUID_PATTERN.test(targetEntity.TargetID ?? ""), `${cluster}: Target ${target.space}/${target.target} is missing or lacks an exact ID`);
    target.spaceID = targetSpace.SpaceID;
    target.targetID = targetEntity.TargetID;
    const appsSpace = exactSpace(target.delivery.appsSpace, `${cluster} apps root`);
    target.delivery.appsSpaceID = appsSpace.SpaceID;
    for (const [key, label] of [["root", "root Application"], ["argobotApplication", "argobot Application"]]) {
      const entity = target.delivery[key];
      const live = exactUnit(target.delivery.appsSpace, entity.unit, `${cluster} ${label}`);
      entity.unitID = live.row.UnitID;
      entity.dataHash = live.row.DataHash;
      entity.dataSHA256 = sha256(live.data);
    }
    const argobotSpace = exactSpace(target.delivery.argobot.space, `${cluster} argobot`);
    const argobot = exactUnit(target.delivery.argobot.space, target.delivery.argobot.unit, `${cluster} argobot`);
    target.delivery.argobot.spaceID = argobotSpace.SpaceID;
    target.delivery.argobot.unitID = argobot.row.UnitID;
    target.delivery.argobot.dataHash = argobot.row.DataHash;
    target.delivery.argobot.dataSHA256 = sha256(argobot.data);

    const evidencePath = evidenceFiles.get(cluster);
    const evidenceBytes = readFileSync(evidencePath);
    const evidence = readYaml(evidencePath);
    check(evidence?.apiVersion === "import.confighub.com/v1alpha1" && evidence?.kind === "KubaraArgoRuntimeObservation" && evidence?.status?.result === "pass", `${cluster}: runtime evidence apiVersion/kind/status is invalid`);
    check(evidence.spec?.cluster === cluster, `${cluster}: runtime evidence names another cluster`);
    checkExactVersion(String(evidence.spec?.componentVersion ?? ""), `${cluster} runtime evidence componentVersion`);
    validateRuntimeImage(evidence.spec?.image, `${cluster} runtime evidence image`);
    validateEvidenceReference(evidence.spec?.evidenceRef, `${cluster} runtime evidence reference`);
    check(!containsCredentialMaterial(evidenceBytes.toString("utf8")), `${cluster}: runtime evidence contains credential-shaped material`);
    target.delivery.reconciler = {
      componentVersion: String(evidence.spec.componentVersion),
      image: evidence.spec.image,
      evidenceRef: evidence.spec.evidenceRef,
      evidenceSHA256: `sha256:${sha256(evidenceBytes)}`,
    };

    for (const workload of target.delivery.workloadApplications ?? []) {
      const application = exactUnit(target.delivery.appsSpace, workload.unit, `${cluster} preserved workload`);
      const sourceSpace = exactSpace(workload.sourceSpace, `${cluster} preserved workload source`);
      const sourceUnit = exactUnit(workload.sourceSpace, workload.sourceUnit, `${cluster} preserved workload source`);
      const release = client.latestRelease(workload.sourceSpace);
      validatePublishedRelease(workload.sourceSpace, release, "preserved workload source release");
      check(Number(application.row.HeadRevisionNum ?? 0) === Number(application.row.LastReleasedRevisionNum ?? 0), `${target.delivery.appsSpace}/${workload.unit}: preserved workload head is not published`);
      workload.unitID = application.row.UnitID;
      workload.dataHash = application.row.DataHash;
      workload.dataSHA256 = sha256(application.data);
      workload.headRevisionNum = Number(application.row.HeadRevisionNum);
      workload.sourceSpaceID = sourceSpace.SpaceID;
      workload.sourceUnitID = sourceUnit.row.UnitID;
      workload.sourceReleaseManifestDigest = release.ManifestDigest;
    }
  }
  for (const row of request.spec.externalInfrastructure?.spaces ?? []) {
    const liveSpace = exactSpace(row.space, `external ${row.purpose}`);
    row.spaceID = liveSpace.SpaceID;
    for (const unit of row.units ?? []) unit.unitID = exactUnit(row.space, unit.slug, `external ${row.purpose}`).row.UnitID;
  }
  validateRequest(request);
  mkdirSync(dirname(outputPath), { recursive: true });
  check(!existsSync(outputPath) || !lstatSync(outputPath).isSymbolicLink(), "destination inspection output must not be a symbolic link");
  writeFileSync(outputPath, `${toYaml(request)}\n`);
  return request;
}

function createCubInspectionClient(context) {
  const contextArgs = ["--context", context];
  const jsonRows = (commandArgs, kind) => {
    const result = commandResult("cub", [...contextArgs, ...commandArgs]);
    check(result.ok, `cub ${commandArgs.join(" ")} failed\n${result.output}`);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error(`cub ${commandArgs.join(" ")} returned invalid JSON: ${error.message}`); }
    return unwrapRows(parsed, kind);
  };
  const one = (resource, space, slug, fields) => {
    const rows = jsonRows([
      resource, "list", ...(space ? ["--space", space] : []), "--where", `Slug = '${slug}'`, "--select", fields, "-o", "json",
    ], resource[0].toUpperCase() + resource.slice(1));
    check(rows.length <= 1, `${resource} ${space ? `${space}/` : ""}${slug}: narrow identity query returned ${rows.length} rows`);
    return rows[0] ?? null;
  };
  return {
    context() {
      const result = commandResult("cub", [...contextArgs, "context", "get"]);
      check(result.ok, `cub context get failed\n${result.output}`);
      return parseCubContext(result.stdout);
    },
    organization(externalID) {
      const rows = jsonRows(["organization", "list", "--where", `ExternalID = '${externalID}'`, "--select", "DisplayName,ExternalID,OrganizationID", "-o", "json"], "Organization");
      check(rows.length === 1, `expected exactly one Organization entity for ${externalID}`);
      return rows[0];
    },
    space(slug) { return one("space", "", slug, "Slug,SpaceID,OrganizationID,ReleaseTargetID,Labels,Annotations"); },
    unit(space, slug) { return one("unit", space, slug, "Slug,UnitID,DataHash,HeadRevisionNum,LastReleasedRevisionNum,TargetID,UpstreamUnitID,ToolchainType,ProviderType,Labels,Annotations"); },
    target(space, slug) { return one("target", space, slug, "Slug,TargetID,SpaceID,ProviderType,ToolchainType,Annotations"); },
    unitData(space, slug) {
      const result = commandResult("cub", [...contextArgs, "unit", "data", "--space", space, slug]);
      return unitDataCommandOutput(result, `cub unit data --space ${space} ${slug}`);
    },
    latestRelease(space) {
      const rows = jsonRows(["release", "list", "--space", space, "--where", "Published = true", "--select", "Digest,ManifestDigest,ReleaseNum,CreatedAt", "-o", "json"], "Release");
      return latestReleaseRow(rows);
    },
  };
}

function compilePortableRequest({ requestPath, checkoutRoot }) {
  check(existsSync(requestPath), `portable request does not exist: ${requestPath}`);
  const portable = readYaml(requestPath);
  validatePortableRequest(portable);
  const sourceRoot = safeJoin(checkoutRoot, portable.spec.source.path);
  const configPath = safeJoin(sourceRoot, portable.spec.layout.config);
  check(existsSync(configPath), `portable request Kubara config does not exist: ${configPath}`);
  assertNoSymlinkPath(checkoutRoot, configPath);
  const config = readYaml(configPath);
  check(Array.isArray(config?.clusters) && config.clusters.length > 0, "portable request Kubara config has no clusters");
  assertUniqueSemanticKeys(config.clusters, (row) => String(row?.name ?? ""), "portable Kubara config cluster name");
  const synthetic = portableCompileBinding(portable, config.clusters);
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-portable-request-"));
  try {
    const syntheticPath = join(tempRoot, "synthetic-destination-request.yaml");
    writeFileSync(syntheticPath, `${toYaml(synthetic)}\n`);
    const compiled = compileImport({ requestPath: syntheticPath, checkoutRoot });
    compiled.execution.portableRequest = portable;
    return compiled;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validatePortableRequest(request) {
  check(request?.apiVersion === "import.confighub.com/v1alpha1", "portable request apiVersion must be import.confighub.com/v1alpha1");
  check(request?.kind === "KubaraPortableGitRevision", "portable request kind must be KubaraPortableGitRevision");
  checkExactKeys(request, ["apiVersion", "kind", "metadata", "spec"], "portable request");
  checkExactKeys(request.metadata, ["name"], "portable request metadata");
  checkSlug(request.metadata?.name, "portable request metadata.name");
  checkExactKeys(request.spec, ["source", "layout", "security", "publication"], "portable request spec");
  checkExactKeys(request.spec.publication, ["catalogOCIBase"], "portable request spec.publication");
  validateOCIRepositoryBase(request.spec.publication.catalogOCIBase, "portable request catalogOCIBase");
  const sentinel = portableCompileBinding(request, [{ name: "portable-validation", stage: "Portable", type: "hub" }]);
  validateRequest(sentinel);
}

function portableCompileBinding(portable, clusters) {
  const digest = (label) => sha256(`portable-compilation-sentinel\0${portable.metadata.name}\0${label}`);
  const uuid = (label) => deterministicUUID(`portable-compilation-sentinel\0${portable.metadata.name}\0${label}`);
  const targets = {};
  for (const cluster of clusters) {
    checkSlug(cluster?.name, "portable Kubara cluster name");
    const name = cluster.name;
    const appsSpace = portableSentinelSlug("apps", name);
    const argobotSpace = portableSentinelSlug("argobot", name);
    const argobotApplication = portableSentinelSlug("argobot-app", name);
    const environment = String(cluster.stage || cluster.type || "Imported").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 63) || "Imported";
    targets[name] = {
      space: portableSentinelSlug("target", name),
      spaceID: uuid(`${name}:target-space`),
      target: "target",
      targetID: uuid(`${name}:target`),
      environment,
      region: "portable",
      delivery: {
        appsSpace,
        appsSpaceID: uuid(`${name}:apps-space`),
        root: {
          unit: "root",
          unitID: uuid(`${name}:root-unit`),
          dataHash: digest(`${name}:root-data`),
          dataSHA256: digest(`${name}:root-data`),
        },
        argobotApplication: {
          unit: argobotApplication,
          unitID: uuid(`${name}:argobot-application-unit`),
          dataHash: digest(`${name}:argobot-application-data`),
          dataSHA256: digest(`${name}:argobot-application-data`),
        },
        argobot: {
          space: argobotSpace,
          spaceID: uuid(`${name}:argobot-space`),
          unit: "argobot",
          unitID: uuid(`${name}:argobot-unit`),
          dataHash: digest(`${name}:argobot-data`),
          dataSHA256: digest(`${name}:argobot-data`),
        },
        reconciler: {
          componentVersion: "v0.0.1",
          image: "example.invalid/confighub/portable-argocd:v0.0.1",
          evidenceRef: `evidence://portable-compilation/${name}/argocd-runtime`,
          evidenceSHA256: `sha256:${digest(`${name}:argocd-runtime`)}`,
        },
        workloadApplications: [],
      },
    };
  }
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraGitRevisionImport",
    metadata: { name: portable.metadata.name },
    spec: {
      source: structuredClone(portable.spec.source),
      layout: structuredClone(portable.spec.layout),
      security: structuredClone(portable.spec.security),
      destination: {
        organization: "Portable compilation sentinel",
        context: "portable-compilation",
        organizationExternalID: uuid("organization-external"),
        organizationID: uuid("organization-entity"),
        serverURL: "https://portable-compilation.invalid",
        spaceReleaseOCIBase: "oci://portable-compilation.invalid/space",
        organizationPolicy: "require-bootstrap-only-or-importer-owned-identical",
        spacePrefix: "portable",
        deliveryMode: "confighub-managed-argo",
        catalogOCIBase: portable.spec.publication.catalogOCIBase,
        argobotBase: {
          space: "portable-argobot-base",
          spaceID: uuid("argobot-base-space"),
          unit: "argobot",
          unitID: uuid("argobot-base-unit"),
          componentVersion: "v0.1.6",
          sourceRef: "oci://portable-compilation.invalid/confighub/argobot",
          sourceDigest: `sha256:${digest("argobot-source")}`,
          dataHash: digest("argobot-data"),
          dataSHA256: digest("argobot-data"),
        },
      },
      targets,
    },
  };
}

function portableSentinelSlug(role, cluster) {
  const value = `portable-${role}-${cluster}`;
  if (value.length <= 63) return value;
  return `${value.slice(0, 50).replace(/[.-]+$/, "")}-${sha256(value).slice(0, 12)}`;
}

function compileImport({ requestPath, checkoutRoot }) {
  check(existsSync(requestPath), `request does not exist: ${requestPath}`);
  check(existsSync(checkoutRoot), `checkout does not exist: ${checkoutRoot}`);
  const request = readYaml(requestPath);
  validateRequest(request);
  const source = request.spec.source;
  const sourceRoot = safeJoin(checkoutRoot, source.path);
  check(existsSync(sourceRoot), `source path does not exist in checkout: ${source.path}`);
  assertNoSymlinkPath(checkoutRoot, sourceRoot);
  rejectSymlinks(sourceRoot, true);
  verifyGitRevision(checkoutRoot, source);

  const layout = request.spec.layout;
  const inputPaths = resolveInputs(sourceRoot, layout);
  const config = readYaml(inputPaths.config);
  const artifacts = readYaml(inputPaths.artifactLock);
  const components = discoverComponents(inputPaths.components, artifacts);
  const topology = discoverTopology(config, components, request.spec.targets);
  const instances = discoverInstances(inputPaths, topology, components, request.spec.destination.deliveryMode);
  const wiring = inputPaths.wiringGraph ? readJson(inputPaths.wiringGraph) : null;
  const wiringPlan = buildWiringPlan(wiring, instances);

  const selectedFiles = inventoryRevisionFiles(checkoutRoot, sourceRoot, inputPaths);
  check(selectedFiles.length > 0, "selected import scope is empty");
  verifyTrackedInputs(checkoutRoot, source.commit, source.path, selectedFiles);
  scanForSecretMaterial(selectedFiles);

  const sourceInventory = selectedFiles.map((path) => ({
    path: gitPath(checkoutRoot, path),
    sha256: sha256(readFileSync(path)),
    size: readFileSync(path).length,
  }));
  const sourceTreeSha256 = digestRows(sourceInventory.map((row) => `${row.path}\0${row.sha256}\0${row.size}`));
  const requestSemantic = semanticRequest(request);
  const requestSha256 = sha256(stableJson(requestSemantic));
  const componentPackageBuild = buildComponentPackagePlan(request, checkoutRoot, components);
  const configPackageBuild = buildConfigPackagePlan(request, checkoutRoot, instances);
  const componentPackages = componentPackageBuild.rows;
  const configPackages = configPackageBuild.rows;
  const spacesAndUnits = buildConfigHubPlan(request, components, instances, wiringPlan);
  const requestPinnedSpaces = new Set([
    ...Object.values(request.spec.targets).map((target) => target.space),
    ...deliveryInfrastructureSpaceRows(request).map((row) => row.space),
    ...externalInfrastructureSpaces(request).map((row) => row.space),
    ...workloadSourceSpaces(request).map((row) => row.space),
  ]);
  for (const row of spacesAndUnits.spaces.filter((item) => !item.externalBinding)) {
    check(!requestPinnedSpaces.has(row.slug), `${row.slug}: importer-managed Space collides with request-pinned target, delivery, or external infrastructure`);
  }
  const generationReceipt = readYaml(inputPaths.generationReceipt);
  const kubaraVersion = String(generationReceipt.spec?.tools?.kubaraVersion ?? "");
  check(/^v\d+\.\d+\.\d+$/.test(kubaraVersion), "generation receipt must attest an exact Kubara semantic version");
  const catalogVersion = exactOCIRefTag(config.bootstrapCatalog);
  for (const row of spacesAndUnits.spaces.filter((item) => !item.externalBinding)) row.labels = { KubaraVersion: kubaraVersion, CatalogVersion: catalogVersion, ...row.labels };
  for (const row of spacesAndUnits.units) row.labels = { KubaraVersion: kubaraVersion, CatalogVersion: catalogVersion, ...row.labels };
  for (const row of spacesAndUnits.links) row.labels = { KubaraVersion: kubaraVersion, CatalogVersion: catalogVersion, ...row.labels };

  const digestInput = {
    source: {
      repository: source.repository,
      commit: source.commit,
      path: source.path,
      sourceTreeSha256,
    },
    kubaraVersion,
    catalogVersion,
    topology: targetNeutralTopology(topology),
    componentPackages: targetNeutralComponentPackageRows(componentPackages),
    configPackages: targetNeutralConfigPackageRows(configPackages),
    wiringPlan,
    targetFacts: wiringPlan.targetFacts,
    importerMaterializationContract: importerMaterializationContract(),
  };
  const platformDigest = `sha256:${sha256(stableJson(digestInput))}`;
  const bindingDigest = `sha256:${sha256(stableJson({ platformDigest, requestSemanticSha256: requestSha256 }))}`;
  if (request.spec.transition) check(
    request.spec.transition.fromPlatformDigest !== platformDigest || request.spec.transition.fromBindingDigest !== bindingDigest,
    "spec.transition already names the compiled platform and destination binding digests",
  );
  const shortCommit = source.commit.slice(0, 12);
  const importLabels = {
    ManagedBy: "kubara-git-import",
    ImportName: request.metadata.name,
    GitCommit: shortCommit,
    PlatformDigest: platformDigest,
  };
  for (const row of spacesAndUnits.spaces.filter((item) => !item.externalBinding)) row.labels = { ...row.labels, ...importLabels };
  for (const row of spacesAndUnits.units) row.labels = { ...row.labels, ...importLabels };
  for (const row of spacesAndUnits.links) row.labels = { ...row.labels, ...importLabels };
  for (const row of spacesAndUnits.deliveryApplications) row.labels = { ...row.labels, ...importLabels };
  for (const row of spacesAndUnits.spaces.filter((item) => !item.externalBinding)) {
    row.annotations = {
      ...(row.annotations ?? {}),
      "import.confighub.com/platform-digest": platformDigest,
      "import.confighub.com/source-repository": source.repository,
      "import.confighub.com/source-commit": source.commit,
    };
  }
  for (const row of spacesAndUnits.units) {
    row.annotations = {
      ...(row.annotations ?? {}),
      "import.confighub.com/platform-digest": platformDigest,
      "import.confighub.com/source-path": row.source,
    };
  }
  for (const row of spacesAndUnits.links) {
    row.annotations = {
      ...(row.annotations ?? {}),
      "import.confighub.com/platform-digest": platformDigest,
    };
  }
  for (const row of spacesAndUnits.deliveryApplications) {
    row.annotations = {
      ...(row.annotations ?? {}),
      "import.confighub.com/platform-digest": platformDigest,
      "import.confighub.com/source-path": `generated:delivery-application/${row.sourceSpace}`,
    };
  }

  const lock = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraPlatformContentLock",
    metadata: { name: "kubara-platform-content" },
    spec: {
      platformDigest,
      source: {
        repository: source.repository,
        commit: source.commit,
        path: source.path,
        sourceTreeSha256,
        selectedFileCount: sourceInventory.length,
      },
      topologySha256: sha256(stableJson(targetNeutralTopology(topology))),
      componentPackagePlanSha256: sha256(stableJson(targetNeutralComponentPackageRows(componentPackages))),
      configPackagePlanSha256: sha256(stableJson(targetNeutralConfigPackageRows(configPackages))),
      wiringPlanSha256: sha256(stableJson(wiringPlan)),
      importerContractVersion: IMPORTER_CONTRACT_VERSION,
      importerMaterializationContractSHA256: importerMaterializationContractSHA256(),
      inventory: sourceInventory,
    },
    status: {
      result: "pass",
      mutableRefsAccepted: false,
      exactVersionsLocked: true,
      credentialShapedHeuristicScan: "pass",
      targetFactsIncludedInOCI: false,
      destinationBindingsIncluded: false,
      aiRequired: false,
    },
  };

  const plan = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraGitRevisionImportPlan",
    metadata: { name: request.metadata.name },
    spec: {
      platformDigest,
      bindingDigest,
      boundary: {
        kubaraRemainsSourceOf: ["platform selection", "hub/spoke topology", "generated component wrappers", "per-cluster configuration", "wiring intent"],
        configHubAdds: ["component-first retention", "exact OCI publication plan", "reviewable definitions and instances", "revision history", "promotion and approval surfaces", "visible NeedsProvides links"],
        aiRequired: false,
        flattenedFleetBundle: false,
        targetFactsInGitOrOCI: false,
        applicationMigrationIncluded: false,
        importerDeleteOperations: [],
        clusterReconcilerPrune: true,
        pruneEffect: "objects removed from a reviewed source release may be deleted from the cluster after Argo sync",
        configHubApplyConcurrency: "requires-exclusive-serialized-control-of-importer-managed-topology-and-request-pinned-bootstrap-or-workload-heads-during-apply",
      },
      source: lock.spec.source,
      destination: {
        ...request.spec.destination,
        organizationPrecondition: "bootstrap-only-exact-request-pinned-infrastructure-with-no-unexpected-spaces-or-importer-owned-identical-current-platform-digest-or-exact-prior-receipt-authorized-additive-transition",
        conflictingNonemptyOrganizationAction: "refuse",
        importerDeleteOperations: false,
        clusterReconcilerPrune: true,
      },
      topology,
      oci: {
        catalogPackages: componentPackages,
        configReleases: configPackages,
        aggregate: {
          type: "index-only",
          platformDigest,
          members: [...componentPackages, ...configPackages].map((row) => row.id).sort(),
          plannedOCIRef: `${request.spec.destination.catalogOCIBase.replace(/\/+$/, "")}/platforms/${request.metadata.name}:platform-${platformDigest.slice(7)}`,
          note: "The index preserves component boundaries; it is not an opaque deployable fleet blob.",
        },
      },
      configHub: spacesAndUnits,
      targetFacts: {
        placement: "target-bound-outside-git-and-oci",
        applyPrecondition: "resolve-required-and-target-prerequisite-rows-before-targeting-dependent-units",
        rows: wiringPlan.targetFacts,
      },
      handoff: {
        state: "platform-delivery-materialized-after-root-and-source-releases-publish; cluster-convergence-verification-required-before-workload-apps",
        clusterConvergenceClaim: false,
        platformDeliveryApplicationsMaterialized: true,
        platformDeliveryAuthority: "exact-source-release-manifest-digest-without-automated-sync",
        mutableLatestAcceptedAsAuthority: false,
        applicationsRemainSeparate: true,
        appUnitsMayUsePlatformNeedsProvidesLinks: true,
        nextStep: "verify each exact source release manifest digest converged through the request-pinned cluster-local Argo root, then create application definitions/variants and publish reviewed workload app releases",
      },
      phases: [
        "verify the exact clean Git revision and selected import path",
        "run the built-in credential-shaped heuristic scan and require the request-pinned external credential scanner attestation",
        "require bootstrap-only exact request-pinned infrastructure with no unexpected Spaces, an importer-owned identical current platform digest, or an exact prior-receipt-authorized additive transition",
        "publish component-first catalog packages without overwriting an existing different digest",
        "create the exact allowlisted Spaces and definition Units",
        "create per-cluster instance Units and UpgradeUnit lineage",
        "bind target facts outside Git and OCI, then target component instances",
        "create visible NeedsProvides links with auto-update disabled",
        "publish one immutable ConfigHub source Space release OCI per component instance",
        "replace each auto-created platform delivery Application with exact ManifestDigest authority and no automated sync",
        "publish each request-pinned cluster-local Argo apps root after exact-digest delivery Applications are materialized",
        "verify the platform digest and hand off exact delivery-root/source OCI manifest digests for separate cluster convergence verification",
      ],
      capabilities: {
        plan: "implemented-and-offline-verified",
        verify: "implemented-and-offline-verified",
        package: "implemented-deterministic-single-layer-oci-reuse-or-refuse-under-exclusive-single-writer-control",
        apply: "implemented-for-request-pinned-existing-org-context-and-pre-existing-targets-under-exclusive-serialized-managed-topology-control",
        createOrganization: "not-supported-use-an-explicit-pre-existing-context",
        createTarget: "not-supported-bind-explicit-pre-existing-space-and-target-ids",
        materializePlatformDeliveryApplications: "implemented-against-request-pinned-pre-existing-cluster-local-argo-root-and-argobot-contract",
        platformDeliveryAuthority: "exact-manifest-digest-no-automated-sync",
        deployApplications: "not-included-separate-app-ready-handoff",
      },
    },
  };

  const acceptance = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraGitImportAcceptance",
    metadata: { name: request.metadata.name },
    spec: {
      platformDigest,
      bindingDigest,
      checks: [
        pass("immutable-git-revision", source.commit),
        pass("clean-selected-path", source.path),
        pass("exact-component-locks", `${components.filter((row) => row.deployable).length} deployable definitions`),
        pass("credential-shaped-heuristic-scan", `${sourceInventory.length} files`),
        pass("external-credential-scan-attestation", `${request.spec.security.credentialScan.scanner}; ${request.spec.security.credentialScan.reportSHA256}`),
        pass("topology-preserved", `${topology.clusters.length} clusters; ${topology.hubs.length} hub(s); ${topology.spokes.length} spoke(s)`),
        pass("component-instance-boundaries", `${instances.length} instance release plans`),
        pass("needs-provides-plan", `${wiringPlan.links.length} visible cross-component links`),
        pass("target-fact-boundary", `${wiringPlan.targetFacts.length} rows excluded from Git/OCI publication`),
        pass("importer-no-delete-contract", `${request.spec.destination.organizationPolicy}; Argo prune disclosed separately`),
        pass("no-ai-required", "deterministic compiler"),
      ],
      claimBoundary: [
        "This compile receipt proves deterministic offline compilation and verification only.",
        "OCI publication is proven separately by oci-publication-receipt.json.",
        "Selected-organization reconciliation is proven separately by apply-receipt.json after a second zero-action run.",
        "The executor does not create organizations or targets and does not deploy applications.",
      ],
    },
    status: { result: "pass" },
  };

  const bindingLock = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraDestinationBindingLock",
    metadata: { name: request.metadata.name },
    spec: {
      platformDigest,
      bindingDigest,
      sourceCommit: source.commit,
      security: request.spec.security,
      destination: request.spec.destination,
      targets: request.spec.targets,
      externalInfrastructure: request.spec.externalInfrastructure ?? { spaces: [] },
      navigation: request.spec.navigation ?? {},
      transition: request.spec.transition ?? null,
      includedInOCI: false,
      secretValuesIncluded: false,
    },
  };
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const lockText = `${toYaml(lock)}\n`;
  const bindingLockText = `${toYaml(bindingLock)}\n`;
  const acceptanceText = `${JSON.stringify(acceptance, null, 2)}\n`;
  const targetFactsRequired = buildTargetFactsRequirement(request, platformDigest, bindingDigest, wiringPlan.targetFacts);
  const targetFactsRequiredText = `${toYaml(targetFactsRequired)}\n`;
  const checksumsText = outputChecksums({ planText, lockText, bindingLockText, acceptanceText, targetFactsRequiredText });
  const kubaraConfigText = readFileSync(inputPaths.config, "utf8");
  const wiringGraphText = readFileSync(inputPaths.wiringGraph, "utf8");
  verifyGitRevision(checkoutRoot, source);
  const finalSelectedFiles = inventoryRevisionFiles(checkoutRoot, sourceRoot, inputPaths);
  verifyTrackedInputs(checkoutRoot, source.commit, source.path, finalSelectedFiles);
  const finalInventory = finalSelectedFiles.map((path) => ({ path: gitPath(checkoutRoot, path), sha256: sha256(readFileSync(path)), size: readFileSync(path).length }));
  check(stableJson(finalInventory) === stableJson(sourceInventory), "selected Git bytes changed while the immutable import was being compiled; retry from a quiescent exact checkout");
  return {
    plan,
    lock,
    bindingLock,
    acceptance,
    planText,
    lockText,
    bindingLockText,
    acceptanceText,
    targetFactsRequired,
    targetFactsRequiredText,
    checksumsText,
    execution: {
      request,
      checkoutRoot,
      inputPaths,
      components,
      instances,
      kubaraConfigText,
      wiringGraphText,
      componentPayloads: componentPackageBuild.payloads,
      configPayloads: configPackageBuild.payloads,
    },
  };
}

function validateRequest(request) {
  check(request?.apiVersion === "import.confighub.com/v1alpha1", "request apiVersion must be import.confighub.com/v1alpha1");
  check(request?.kind === "KubaraGitRevisionImport", "request kind must be KubaraGitRevisionImport");
  checkObjectKeys(request, ["apiVersion", "kind", "metadata", "spec"], ["apiVersion", "kind", "metadata", "spec"], "request");
  checkObjectKeys(request.metadata, ["name"], ["name"], "metadata");
  checkSlug(request?.metadata?.name, "metadata.name");
  const spec = request.spec ?? {};
  checkObjectKeys(spec, ["source", "layout", "security", "destination", "navigation", "targets", "externalInfrastructure", "transition"], ["source", "layout", "security", "destination", "targets"], "spec");
  const source = spec.source ?? {};
  checkObjectKeys(source, ["repository", "commit", "path"], ["repository", "commit", "path"], "spec.source");
  validateGitURL(source.repository);
  check(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit ?? ""), "spec.source.commit must be a full lowercase Git object ID; mutable refs are refused");
  checkSafeRelative(source.path, "spec.source.path");
  const layout = spec.layout ?? {};
  checkObjectKeys(layout, ["source", "config", "components", "configs", "renders", "artifactLock", "generationReceipt", "wiringGraph"], ["source", "config", "components", "configs", "renders", "artifactLock", "generationReceipt", "wiringGraph"], "spec.layout");
  for (const key of ["source", "config", "components", "configs", "renders", "artifactLock", "generationReceipt", "wiringGraph"]) checkSafeRelative(layout[key], `spec.layout.${key}`);
  const credentialScan = spec.security?.credentialScan;
  checkExactKeys(spec.security, ["credentialScan"], "spec.security");
  checkExactKeys(credentialScan, ["status", "scanner", "reportSHA256", "sourceCommit", "scopePath", "opaqueFilesReviewed"], "spec.security.credentialScan");
  check(credentialScan.status === "pass", "spec.security.credentialScan.status must be pass");
  check(/^[a-z0-9][a-z0-9._-]*@v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(credentialScan.scanner ?? ""), "spec.security.credentialScan.scanner must include an exact tool version");
  check(/^sha256:[0-9a-f]{64}$/.test(credentialScan.reportSHA256 ?? ""), "spec.security.credentialScan.reportSHA256 must be exact");
  check(credentialScan.sourceCommit === source.commit && credentialScan.scopePath === source.path, "spec.security.credentialScan must attest the exact source commit and scope path");
  check(credentialScan.opaqueFilesReviewed === true, "spec.security.credentialScan.opaqueFilesReviewed must be true");
  const destination = spec.destination ?? {};
  checkObjectKeys(destination, ["organization", "context", "organizationExternalID", "organizationID", "serverURL", "spaceReleaseOCIBase", "organizationPolicy", "spacePrefix", "deliveryMode", "catalogOCIBase", "argobotBase"], ["organization", "context", "organizationExternalID", "organizationID", "serverURL", "spaceReleaseOCIBase", "organizationPolicy", "spacePrefix", "deliveryMode", "catalogOCIBase", "argobotBase"], "spec.destination");
  checkObjectKeys(destination.argobotBase, ["space", "spaceID", "unit", "unitID", "componentVersion", "sourceRef", "sourceDigest", "dataHash", "dataSHA256"], ["space", "spaceID", "unit", "unitID", "componentVersion", "sourceRef", "sourceDigest", "dataHash", "dataSHA256"], "spec.destination.argobotBase");
  check(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(destination.organization ?? ""), "spec.destination.organization is invalid");
  checkSlug(destination.context, "spec.destination.context");
  check(UUID_PATTERN.test(destination.organizationExternalID ?? ""), "spec.destination.organizationExternalID must be the exact ConfigHub external organization UUID");
  check(UUID_PATTERN.test(destination.organizationID ?? ""), "spec.destination.organizationID must be the exact ConfigHub Organization entity UUID");
  validateServerURL(destination.serverURL);
  validateOCIRepositoryBase(destination.spaceReleaseOCIBase, "spec.destination.spaceReleaseOCIBase");
  validateDeliveryEntity(destination.argobotBase, "spec.destination.argobotBase", { requireSpace: true });
  checkExactVersion(String(destination.argobotBase.componentVersion ?? ""), "spec.destination.argobotBase.componentVersion");
  validateOCIRepositoryRef(destination.argobotBase.sourceRef, "spec.destination.argobotBase.sourceRef");
  check(/^sha256:[0-9a-f]{64}$/.test(destination.argobotBase.sourceDigest ?? ""), "spec.destination.argobotBase.sourceDigest must pin the exact argobot source artifact");
  checkSlug(destination.spacePrefix, "spec.destination.spacePrefix");
  check(destination.organizationPolicy === "require-bootstrap-only-or-importer-owned-identical", "spec.destination.organizationPolicy must be require-bootstrap-only-or-importer-owned-identical");
  check(destination.deliveryMode === "confighub-managed-argo", "spec.destination.deliveryMode must be confighub-managed-argo; the faithful Kubara hub executor is a separate proof lane, not a generic import claim");
  validateOCIRepositoryBase(destination.catalogOCIBase, "spec.destination.catalogOCIBase");
  const navigation = spec.navigation ?? {};
  check(navigation && typeof navigation === "object" && !Array.isArray(navigation), "spec.navigation must be an object when present");
  const navigationKeys = new Set(["guideURL", "catalogURL", "matrixURL", "wiringURL"]);
  for (const key of Object.keys(navigation)) check(navigationKeys.has(key), `spec.navigation.${key} is not supported`);
  for (const [key, value] of Object.entries(navigation)) validateNavigationURL(value, `spec.navigation.${key}`);
  if (spec.transition !== undefined) {
    checkExactKeys(spec.transition, ["fromPlatformDigest", "fromBindingDigest", "previousApplyReceiptSHA256", "policy"], "spec.transition");
    check(/^sha256:[0-9a-f]{64}$/.test(spec.transition.fromPlatformDigest ?? ""), "spec.transition.fromPlatformDigest must be exact");
    check(/^sha256:[0-9a-f]{64}$/.test(spec.transition.fromBindingDigest ?? ""), "spec.transition.fromBindingDigest must be exact");
    check(/^sha256:[0-9a-f]{64}$/.test(spec.transition.previousApplyReceiptSHA256 ?? ""), "spec.transition.previousApplyReceiptSHA256 must be exact");
    check(spec.transition.policy === "additive-confighub-topology-importer-no-delete-argo-prune-disclosed", "spec.transition.policy must be additive-confighub-topology-importer-no-delete-argo-prune-disclosed");
  }
  check(spec.targets && typeof spec.targets === "object" && !Array.isArray(spec.targets), "spec.targets must map every Kubara cluster name");
  for (const [cluster, target] of Object.entries(spec.targets)) {
    checkObjectKeys(target, ["space", "spaceID", "target", "targetID", "environment", "region", "delivery"], ["space", "spaceID", "target", "targetID", "environment", "delivery"], `spec.targets.${cluster}`);
    checkSlug(cluster, `spec.targets key ${cluster}`);
    checkSlug(target?.space, `spec.targets.${cluster}.space`);
    checkSlug(target?.target, `spec.targets.${cluster}.target`);
    check(UUID_PATTERN.test(target?.spaceID ?? ""), `spec.targets.${cluster}.spaceID must be the exact pre-existing ConfigHub Space UUID`);
    check(UUID_PATTERN.test(target?.targetID ?? ""), `spec.targets.${cluster}.targetID must be the exact pre-existing ConfigHub Target UUID`);
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(target?.environment ?? ""), `spec.targets.${cluster}.environment is invalid`);
    if (target.region) check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(target.region), `spec.targets.${cluster}.region is invalid`);
    const delivery = target.delivery ?? {};
    checkObjectKeys(delivery, ["appsSpace", "appsSpaceID", "root", "argobotApplication", "argobot", "reconciler", "workloadApplications"], ["appsSpace", "appsSpaceID", "root", "argobotApplication", "argobot", "reconciler", "workloadApplications"], `spec.targets.${cluster}.delivery`);
    checkSlug(delivery.appsSpace, `spec.targets.${cluster}.delivery.appsSpace`);
    check(UUID_PATTERN.test(delivery.appsSpaceID ?? ""), `spec.targets.${cluster}.delivery.appsSpaceID must be an exact UUID`);
    validateDeliveryEntity(delivery.root, `spec.targets.${cluster}.delivery.root`);
    checkObjectKeys(delivery.root, ["unit", "unitID", "dataHash", "dataSHA256"], ["unit", "unitID", "dataHash", "dataSHA256"], `spec.targets.${cluster}.delivery.root`);
    validateDeliveryEntity(delivery.argobotApplication, `spec.targets.${cluster}.delivery.argobotApplication`);
    checkObjectKeys(delivery.argobotApplication, ["unit", "unitID", "dataHash", "dataSHA256"], ["unit", "unitID", "dataHash", "dataSHA256"], `spec.targets.${cluster}.delivery.argobotApplication`);
    validateDeliveryEntity(delivery.argobot, `spec.targets.${cluster}.delivery.argobot`, { requireSpace: true });
    checkObjectKeys(delivery.argobot, ["space", "spaceID", "unit", "unitID", "dataHash", "dataSHA256"], ["space", "spaceID", "unit", "unitID", "dataHash", "dataSHA256"], `spec.targets.${cluster}.delivery.argobot`);
    checkExactKeys(delivery.reconciler, ["componentVersion", "image", "evidenceRef", "evidenceSHA256"], `spec.targets.${cluster}.delivery.reconciler`);
    checkExactVersion(String(delivery.reconciler.componentVersion ?? ""), `spec.targets.${cluster}.delivery.reconciler.componentVersion`);
    validateRuntimeImage(delivery.reconciler.image, `spec.targets.${cluster}.delivery.reconciler.image`);
    validateEvidenceReference(delivery.reconciler.evidenceRef, `spec.targets.${cluster}.delivery.reconciler.evidenceRef`);
    check(/^sha256:[0-9a-f]{64}$/.test(delivery.reconciler.evidenceSHA256 ?? ""), `spec.targets.${cluster}.delivery.reconciler.evidenceSHA256 must be exact`);
    check(Array.isArray(delivery.workloadApplications ?? []), `spec.targets.${cluster}.delivery.workloadApplications must be an array`);
    const workloadSlugs = new Set([delivery.root.unit, delivery.argobotApplication.unit]);
    for (const [index, workload] of (delivery.workloadApplications ?? []).entries()) {
      const label = `spec.targets.${cluster}.delivery.workloadApplications[${index}]`;
      checkExactKeys(workload, ["unit", "unitID", "dataHash", "dataSHA256", "headRevisionNum", "sourceSpace", "sourceSpaceID", "sourceUnit", "sourceUnitID", "sourceReleaseManifestDigest"], label);
      validateDeliveryEntity(workload, label);
      check(!workloadSlugs.has(workload.unit), `${label}.unit collides with another apps-root Unit`);
      workloadSlugs.add(workload.unit);
      check(Number.isSafeInteger(workload.headRevisionNum) && workload.headRevisionNum > 0, `${label}.headRevisionNum must pin a positive published head`);
      checkSlug(workload.sourceSpace, `${label}.sourceSpace`);
      check(UUID_PATTERN.test(workload.sourceSpaceID ?? ""), `${label}.sourceSpaceID must be exact`);
      checkSlug(workload.sourceUnit, `${label}.sourceUnit`);
      check(UUID_PATTERN.test(workload.sourceUnitID ?? ""), `${label}.sourceUnitID must be exact`);
      check(/^sha256:[0-9a-f]{64}$/.test(workload.sourceReleaseManifestDigest ?? ""), `${label}.sourceReleaseManifestDigest must be exact`);
    }
  }
  const targetSpaceIDs = Object.values(spec.targets).map((target) => target.spaceID);
  const targetIDs = Object.values(spec.targets).map((target) => target.targetID);
  check(new Set(targetSpaceIDs).size === targetSpaceIDs.length, "spec.targets must use one exact Space ID per Kubara cluster");
  check(new Set(targetIDs).size === targetIDs.length, "spec.targets must use one exact Target ID per Kubara cluster");
  const externalSpaces = spec.externalInfrastructure?.spaces ?? [];
  if (spec.externalInfrastructure !== undefined) checkObjectKeys(spec.externalInfrastructure, ["spaces"], ["spaces"], "spec.externalInfrastructure");
  check(Array.isArray(externalSpaces), "spec.externalInfrastructure.spaces must be an array when present");
  const externalSlugs = new Set();
  const externalIDs = new Set();
  for (const [index, row] of externalSpaces.entries()) {
    checkObjectKeys(row, ["space", "spaceID", "purpose", "units"], ["space", "spaceID", "purpose", "units"], `spec.externalInfrastructure.spaces[${index}]`);
    checkSlug(row?.space, `spec.externalInfrastructure.spaces[${index}].space`);
    check(UUID_PATTERN.test(row?.spaceID ?? ""), `spec.externalInfrastructure.spaces[${index}].spaceID must be an exact UUID`);
    check(/^[A-Za-z][A-Za-z0-9.-]{2,62}$/.test(row?.purpose ?? ""), `spec.externalInfrastructure.spaces[${index}].purpose is invalid`);
    check(!externalSlugs.has(row.space) && !externalIDs.has(row.spaceID), `spec.externalInfrastructure.spaces[${index}] duplicates a Space`);
    externalSlugs.add(row.space);
    externalIDs.add(row.spaceID);
    check(Array.isArray(row.units ?? []), `spec.externalInfrastructure.spaces[${index}].units must be an array`);
    for (const [unitIndex, unit] of (row.units ?? []).entries()) {
      checkObjectKeys(unit, ["slug", "unitID"], ["slug", "unitID"], `spec.externalInfrastructure.spaces[${index}].units[${unitIndex}]`);
      checkSlug(unit?.slug, `spec.externalInfrastructure.spaces[${index}].units[${unitIndex}].slug`);
      check(UUID_PATTERN.test(unit?.unitID ?? ""), `spec.externalInfrastructure.spaces[${index}].units[${unitIndex}].unitID must be an exact UUID`);
    }
  }
  validateRequestEntityDisjointness(spec);
}

function validateRequestEntityDisjointness(spec) {
  const spaces = [
    { kind: "argobot-base", slug: spec.destination.argobotBase.space, id: spec.destination.argobotBase.spaceID },
    ...Object.entries(spec.targets).flatMap(([cluster, target]) => [
      { kind: `${cluster} target`, slug: target.space, id: target.spaceID },
      { kind: `${cluster} apps`, slug: target.delivery.appsSpace, id: target.delivery.appsSpaceID },
      { kind: `${cluster} argobot`, slug: target.delivery.argobot.space, id: target.delivery.argobot.spaceID },
    ]),
    ...(spec.externalInfrastructure?.spaces ?? []).map((row) => ({ kind: `external ${row.purpose}`, slug: row.space, id: row.spaceID })),
  ];
  const slugs = new Map();
  const ids = new Map();
  for (const row of spaces) {
    check(!slugs.has(row.slug), `${row.kind} Space slug ${row.slug} collides with ${slugs.get(row.slug) ?? "another request Space"}`);
    check(!ids.has(row.id), `${row.kind} Space ID ${row.id} collides with ${ids.get(row.id) ?? "another request Space"}`);
    slugs.set(row.slug, row.kind);
    ids.set(row.id, row.kind);
  }
  const unitIDs = [
    { kind: "argobot-base", id: spec.destination.argobotBase.unitID },
    ...Object.entries(spec.targets).flatMap(([cluster, target]) => [
      { kind: `${cluster} root`, id: target.delivery.root.unitID },
      { kind: `${cluster} argobot Application`, id: target.delivery.argobotApplication.unitID },
      { kind: `${cluster} argobot`, id: target.delivery.argobot.unitID },
      ...(target.delivery.workloadApplications ?? []).map((workload) => ({ kind: `${cluster} preserved workload ${workload.unit}`, id: workload.unitID })),
    ]),
    ...(spec.externalInfrastructure?.spaces ?? []).flatMap((space) => (space.units ?? []).map((unit) => ({ kind: `${space.space}/${unit.slug}`, id: unit.unitID }))),
  ];
  const seenUnitIDs = new Map();
  for (const row of unitIDs) {
    check(!seenUnitIDs.has(row.id), `${row.kind} Unit ID ${row.id} collides with ${seenUnitIDs.get(row.id) ?? "another request Unit"}`);
    seenUnitIDs.set(row.id, row.kind);
  }
  for (const [cluster, target] of Object.entries(spec.targets)) {
    check(target.delivery.root.unit !== target.delivery.argobotApplication.unit, `${cluster}: root and argobot Application Unit slugs must differ`);
  }
  const coreSpaceSlugs = new Set(spaces.map((row) => row.slug));
  const coreSpaceIDs = new Set(spaces.map((row) => row.id));
  const workloadSources = new Map();
  for (const [cluster, target] of Object.entries(spec.targets)) for (const workload of target.delivery.workloadApplications ?? []) {
    check(!coreSpaceSlugs.has(workload.sourceSpace) && !coreSpaceIDs.has(workload.sourceSpaceID), `${cluster}/${workload.unit}: workload source Space collides with target, delivery, or external infrastructure`);
    const prior = workloadSources.get(workload.sourceSpace);
    check(!prior || prior === workload.sourceSpaceID, `${workload.sourceSpace}: workload source Space ID differs across targets`);
    workloadSources.set(workload.sourceSpace, workload.sourceSpaceID);
  }
}

function validateDeliveryEntity(value, label, { requireSpace = false } = {}) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} is required`);
  if (requireSpace) {
    checkSlug(value.space, `${label}.space`);
    check(UUID_PATTERN.test(value.spaceID ?? ""), `${label}.spaceID must be an exact UUID`);
  }
  checkSlug(value.unit, `${label}.unit`);
  check(UUID_PATTERN.test(value.unitID ?? ""), `${label}.unitID must be an exact UUID`);
  check(/^[0-9a-f]{64}$/.test(value.dataHash ?? ""), `${label}.dataHash must be the exact existing ConfigHub Unit DataHash`);
  check(/^[0-9a-f]{64}$/.test(value.dataSHA256 ?? ""), `${label}.dataSHA256 must be the SHA-256 of the exact existing Unit bytes`);
}

function resolveInputs(sourceRoot, layout) {
  const result = {
    source: safeJoin(sourceRoot, layout.source),
    config: safeJoin(sourceRoot, layout.config),
    components: safeJoin(sourceRoot, layout.components),
    configs: safeJoin(sourceRoot, layout.configs),
    renders: safeJoin(sourceRoot, layout.renders),
    artifactLock: safeJoin(sourceRoot, layout.artifactLock),
    generationReceipt: safeJoin(sourceRoot, layout.generationReceipt),
    wiringGraph: safeJoin(sourceRoot, layout.wiringGraph),
  };
  for (const [name, path] of Object.entries(result)) if (path) check(existsSync(path), `layout input ${name} is missing: ${path}`);
  return result;
}

function verifyGitRevision(checkoutRoot, source) {
  const top = git(checkoutRoot, ["rev-parse", "--show-toplevel"]);
  check(realpathSync(top) === realpathSync(checkoutRoot), `--checkout must be the Git worktree root (${top})`);
  const head = git(checkoutRoot, ["rev-parse", "HEAD"]);
  check(head === source.commit, `checkout HEAD ${head} does not equal requested immutable commit ${source.commit}`);
  const remote = git(checkoutRoot, ["remote", "get-url", "origin"]);
  check(normalizeGitURL(remote) === normalizeGitURL(source.repository), `checkout origin ${remote} does not equal requested repository ${source.repository}`);
  git(checkoutRoot, ["cat-file", "-e", `${source.commit}^{commit}`]);
  const status = git(checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", source.path]);
  check(status === "", `selected Git path is dirty; commit every Kubara artifact before import:\n${status}`);
}

function discoverComponents(componentRoot, artifactSet) {
  checkObjectKeys(artifactSet, ["apiVersion", "kind", "metadata", "spec"], ["apiVersion", "kind", "metadata", "spec"], "artifact lock");
  check(artifactSet.apiVersion === "catalog.confighub.com/v1alpha1", "artifact lock apiVersion must be catalog.confighub.com/v1alpha1");
  check(artifactSet?.kind === "KubaraComponentArtifactSet", "artifact lock must be a KubaraComponentArtifactSet");
  checkObjectKeys(artifactSet.metadata, ["name"], ["name"], "artifact lock metadata");
  checkSlug(artifactSet.metadata.name, "artifact lock metadata.name");
  checkObjectKeys(artifactSet.spec, ["exactVersionPolicy", "retentionPolicy", "artifacts", "firstParty"], ["exactVersionPolicy", "retentionPolicy", "artifacts", "firstParty"], "artifact lock spec");
  check(artifactSet.spec?.exactVersionPolicy === "fail-if-missing", "artifact lock exactVersionPolicy must be fail-if-missing");
  check(artifactSet.spec?.retentionPolicy === "additive-only", "artifact lock retentionPolicy must be additive-only");
  const locked = artifactSet.spec?.artifacts ?? [];
  const firstParty = artifactSet.spec?.firstParty ?? [];
  check(Array.isArray(locked) && Array.isArray(firstParty), "artifact lock artifacts and firstParty must be arrays");
  for (const [index, row] of locked.entries()) {
    const label = `artifact lock spec.artifacts[${index}]`;
    checkObjectKeys(row, ["service", "dependency", "canonicalIdentity", "wrapperVersion", "version", "url", "manifestDigest", "sha256"], ["service", "canonicalIdentity", "wrapperVersion", "version", "url", "sha256"], label);
    checkSlug(row.service, `${label}.service`);
    if (row.dependency !== undefined) check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.dependency), `${label}.dependency is invalid`);
    check(/^helm:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(row.canonicalIdentity ?? ""), `${label}.canonicalIdentity must be an exact helm:<repository>/<component> identity`);
    checkExactVersion(String(row.wrapperVersion ?? ""), `${label}.wrapperVersion`);
    checkExactVersion(String(row.version ?? ""), `${label}.version`);
    check(/^[0-9a-f]{64}$/.test(row.sha256 ?? ""), `${label}.sha256 must be exact`);
    validateArtifactURL(row.url, `${label}.url`);
    check(row.url.includes(encodeURIComponent(String(row.version))) || row.url.includes(String(row.version)), `${label}.url does not contain its exact version`);
    if (row.url.startsWith("oci://")) check(/^sha256:[0-9a-f]{64}$/.test(row.manifestDigest ?? ""), `${label}.manifestDigest must pin an exact OCI manifest`);
    else check(row.manifestDigest === undefined, `${label}.manifestDigest is only valid for an OCI artifact`);
  }
  assertUniqueSemanticKeys(locked, (row) => `${normalize(row.service)}\0${String(row.wrapperVersion)}\0${row.canonicalIdentity}\0${String(row.version)}`, "artifact lock component identity/service/wrapper/upstream-version");
  for (const [index, row] of firstParty.entries()) {
    const label = `artifact lock spec.firstParty[${index}]`;
    checkObjectKeys(row, ["service", "canonicalIdentity", "wrapperVersion", "deployable"], ["service", "canonicalIdentity", "wrapperVersion"], label);
    checkSlug(row.service, `${label}.service`);
    check(/^kubara:[A-Za-z0-9._-]+$/.test(row.canonicalIdentity ?? ""), `${label}.canonicalIdentity must be an exact kubara:<component> identity`);
    checkExactVersion(String(row.wrapperVersion ?? ""), `${label}.wrapperVersion`);
    if (row.deployable !== undefined) check(typeof row.deployable === "boolean", `${label}.deployable must be boolean`);
  }
  assertUniqueSemanticKeys(firstParty, (row) => `${normalize(row.service)}\0${row.canonicalIdentity}\0${String(row.wrapperVersion)}`, "artifact lock first-party identity/service/version");
  const dirs = readdirSync(componentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  check(dirs.length > 0, "no Kubara component chart directories found");
  return dirs.map((service) => {
    checkSlug(service, "generated component directory");
    const root = join(componentRoot, service);
    const chartPath = join(root, "Chart.yaml");
    check(existsSync(chartPath), `${service}: Chart.yaml is missing`);
    const chart = readYaml(chartPath);
    checkExactVersion(String(chart.version ?? ""), `${service} wrapper`);
    const dependencies = (chart.dependencies ?? []).map((dependency) => {
      checkExactVersion(String(dependency.version ?? ""), `${service}/${dependency.name}`);
      const local = String(dependency.repository ?? "").startsWith("file://");
      if (local) return { name: dependency.name, version: String(dependency.version), repository: dependency.repository, source: "local-library" };
      const lifecycleAggregate = service === "bootstrap-crds";
      const candidates = locked.filter((row) => normalize(row.service) === normalize(lifecycleAggregate ? dependency.name : service)
        && (lifecycleAggregate || String(row.wrapperVersion) === String(chart.version))
        && (row.dependency === dependency.name || row.canonicalIdentity.endsWith(`/${dependency.name}`))
        && String(row.version) === String(dependency.version));
      check(candidates.length > 0, `${service}/${dependency.name}@${dependency.version}: exact ${lifecycleAggregate ? "lifecycle dependency-service" : "service/wrapper-bound"} artifact lock is missing`);
      const sourceContracts = new Map(candidates.map((row) => [stableJson({
        canonicalIdentity: row.canonicalIdentity,
        version: String(row.version),
        url: row.url,
        sha256: row.sha256,
        manifestDigest: row.manifestDigest ?? null,
      }), row]));
      check(sourceContracts.size === 1, `${service}/${dependency.name}@${dependency.version}: duplicate or ambiguous exact artifact locks are refused`);
      const match = [...sourceContracts.values()][0];
      check(/^[0-9a-f]{64}$/.test(match.sha256 ?? ""), `${service}/${dependency.name}@${dependency.version}: SHA-256 lock is missing`);
      check(typeof match.url === "string" && match.url.length > 0, `${service}/${dependency.name}@${dependency.version}: immutable source URL is missing`);
      validateArtifactURL(match.url, `${service}/${dependency.name}@${dependency.version}`);
      if (match.url.startsWith("oci://")) check(/^sha256:[0-9a-f]{64}$/.test(match.manifestDigest ?? ""), `${service}/${dependency.name}@${dependency.version}: OCI manifest digest is missing`);
      check(match.url.includes(encodeURIComponent(String(dependency.version))) || match.url.includes(String(dependency.version)), `${service}/${dependency.name}@${dependency.version}: source URL does not contain the exact version`);
      return {
        name: dependency.name,
        canonicalIdentity: match.canonicalIdentity,
        version: String(dependency.version),
        repository: dependency.repository,
        sourceURL: match.url,
        sourceSha256: match.sha256,
        manifestDigest: match.manifestDigest ?? null,
      };
    });
    const firstPartyMatches = firstParty.filter((row) => String(row.wrapperVersion) === String(chart.version)
      && (normalize(row.service) === normalize(service) || row.canonicalIdentity === `kubara:${service}` || row.canonicalIdentity === `kubara:${chart.name}`));
    check(firstPartyMatches.length <= 1, `${service}@${chart.version}: duplicate or ambiguous first-party artifact locks are refused`);
    const [firstPartyRow] = firstPartyMatches;
    if (dependencies.every((row) => row.source === "local-library")) check(firstPartyRow, `${service}@${chart.version}: first-party artifact lock is missing`);
    const role = chart.type === "library" ? "LibraryDefinition" : service === "bootstrap-crds" ? "LifecycleDefinition" : "ComponentDefinition";
    const deployable = chart.type !== "library" && service !== "bootstrap-crds";
    if (firstPartyRow) check(String(firstPartyRow.wrapperVersion) === String(chart.version), `${service}: first-party wrapper lock differs from Chart.yaml`);
    if (deployable && dependencies.some((row) => row.source !== "local-library")) {
      const wrapperLocks = locked.filter((row) => normalize(row.service) === normalize(service) && String(row.wrapperVersion) === String(chart.version));
      check(wrapperLocks.length > 0, `${service}: wrapper version is not exactly locked by its selected component artifacts`);
    }
    return {
      service,
      chartName: chart.name,
      wrapperVersion: String(chart.version),
      chartType: chart.type ?? "application",
      role,
      deployable,
      lifecycle: service === "bootstrap-crds",
      path: root,
      dependencies,
      firstParty: firstPartyRow ? { canonicalIdentity: firstPartyRow.canonicalIdentity, version: String(firstPartyRow.wrapperVersion) } : null,
    };
  });
}

function discoverTopology(config, components, targetMap) {
  check(Array.isArray(config.clusters) && config.clusters.length > 0, "Kubara config has no clusters");
  assertUniqueSemanticKeys(config.clusters, (row) => String(row?.name ?? ""), "Kubara config cluster name");
  assertUniqueSemanticKeys(components, (row) => normalize(row.service), "normalized generated component service");
  const componentByName = new Map(components.map((row) => [normalize(row.service), row]));
  const clusters = config.clusters.map((cluster) => {
    checkSlug(cluster.name, "Kubara cluster name");
    check(["hub", "spoke"].includes(cluster.type), `${cluster.name}: type must be hub or spoke`);
    const mapping = targetMap[cluster.name];
    check(mapping, `${cluster.name}: destination target mapping is missing`);
    const enabled = Object.entries(cluster.services ?? {}).filter(([, value]) => value?.status === "enabled").map(([name]) => name).sort();
    const disabled = Object.entries(cluster.services ?? {}).filter(([, value]) => value?.status === "disabled").map(([name]) => name).sort();
    if (cluster.argocd?.selfManaged === "enabled") enabled.unshift("argo-cd");
    const resolvedEnabled = enabled.map((service) => {
      const component = componentByName.get(normalize(service));
      check(component, `${cluster.name}: enabled Kubara service ${service} has no generated component chart`);
      return component.service;
    });
    return {
      name: cluster.name,
      stage: String(cluster.stage ?? ""),
      type: cluster.type,
      dnsName: cluster.dnsName ?? null,
      ingressClassName: cluster.ingressClassName ?? null,
      argoSelfManaged: cluster.argocd?.selfManaged ?? "disabled",
      enabledServices: [...new Set(resolvedEnabled)].sort(),
      disabledServices: [...new Set(disabled)].sort(),
      target: { ...mapping },
    };
  });
  const configured = new Set(clusters.map((row) => row.name));
  const extras = Object.keys(targetMap).filter((name) => !configured.has(name));
  check(extras.length === 0, `target mapping contains unknown clusters: ${extras.join(", ")}`);
  const hubs = clusters.filter((row) => row.type === "hub").map((row) => row.name);
  const spokes = clusters.filter((row) => row.type === "spoke").map((row) => row.name);
  check(hubs.length > 0, "Kubara topology must retain at least one hub");
  return { clusters, hubs, spokes, disabledSelectionsPreserved: true };
}

function discoverInstances(inputs, topology, components, deliveryMode) {
  const componentMap = new Map(components.map((row) => [row.service, row]));
  const generationReceipt = readYaml(inputs.generationReceipt);
  const receiptRenders = generationReceipt?.spec?.outputs?.renders ?? [];
  check(Array.isArray(receiptRenders) && receiptRenders.length > 0, "generation receipt has no effective-render inventory");
  const receiptArtifacts = generationReceipt?.spec?.artifacts ?? [];
  check(Array.isArray(receiptArtifacts), "generation receipt artifact inventory must be an array");
  assertUniqueSemanticKeys(receiptRenders, (row) => `${row?.cluster ?? ""}\0${row?.service ?? ""}`, "generation receipt render cluster/service");
  assertUniqueSemanticKeys(receiptArtifacts, (row) => `${normalize(row?.service)}\0${row?.dependency ?? ""}\0${String(row?.version ?? "")}`, "generation receipt artifact service/dependency/version");
  for (const component of components) {
    for (const dependency of component.dependencies.filter((row) => row.source !== "local-library")) {
      const receiptService = component.lifecycle ? dependency.name : component.service;
      const locked = receiptArtifacts.find((row) => normalize(row.service) === normalize(receiptService) && row.dependency === dependency.name && String(row.version) === dependency.version && row.sha256 === dependency.sourceSha256);
      check(locked, `${component.service}/${dependency.name}@${dependency.version}: generation receipt does not attest the exact artifact lock`);
    }
  }
  const instances = [];
  for (const cluster of topology.clusters) {
    for (const service of cluster.enabledServices) {
      const component = componentMap.get(service);
      const renderPath = join(inputs.renders, cluster.name, service, "release-objects.yaml");
      check(existsSync(renderPath), `${cluster.name}/${service}: effective render is missing`);
      const docs = parseDocs(readFileSync(renderPath, "utf8")).filter((doc) => doc?.apiVersion && doc?.kind && doc?.metadata?.name);
      check(docs.length > 0, `${cluster.name}/${service}: effective render contains no Kubernetes objects`);
      const renderSha256 = sha256(readFileSync(renderPath));
      const receiptRender = receiptRenders.find((row) => row.cluster === cluster.name && row.service === service);
      check(receiptRender, `${cluster.name}/${service}: generation receipt row is missing`);
      check(receiptRender.sha256 === renderSha256, `${cluster.name}/${service}: effective render differs from its generation receipt`);
      check(receiptRender.objectCount === docs.length, `${cluster.name}/${service}: object count differs from its generation receipt`);
      checkSlug(receiptRender.namespace, `${cluster.name}/${service} generation receipt namespace`);
      const configPath = join(inputs.configs, cluster.name, "helm", service);
      check(existsSync(configPath), `${cluster.name}/${service}: generated platform config directory is missing`);
      const retainedOnly = service === "argo-cd" && deliveryMode === "confighub-managed-argo";
      instances.push({
        id: `${cluster.name}/${service}`,
        cluster: cluster.name,
        service,
        stage: cluster.stage,
        topologyRole: cluster.type,
        componentRole: component.role,
        wrapperVersion: component.wrapperVersion,
        selectedVersions: component.dependencies.filter((row) => row.source !== "local-library").map((row) => ({
          identity: row.canonicalIdentity,
          version: row.version,
        })).concat(component.dependencies.every((row) => row.source === "local-library") && component.firstParty ? [{
          identity: component.firstParty.canonicalIdentity,
          version: component.firstParty.version,
        }] : []).sort((left, right) => left.identity.localeCompare(right.identity)),
        configPath,
        renderPath,
        renderSha256,
        objectCount: docs.length,
        destinationNamespace: receiptRender.namespace,
        target: retainedOnly ? null : `${cluster.target.space}/${cluster.target.target}`,
        disposition: retainedOnly ? "retained-faithful-kubara-hub-definition-not-targeted-in-adapted-lane" : "targeted-component-instance",
      });
    }
  }
  return instances.sort((left, right) => left.id.localeCompare(right.id));
}

function buildWiringPlan(graph, instances) {
  if (!graph) return { source: null, links: [], targetFacts: [] };
  check(graph.kind === "KubaraProvidesNeedsGraph", "wiring graph kind must be KubaraProvidesNeedsGraph");
  const instanceIds = new Set(instances.map((row) => row.id));
  check(graph.spec?.evidence?.mode === "offline-effective-render", "wiring graph must be mechanically derived from offline effective renders");
  check(Array.isArray(graph.spec?.evidence?.liveReads) && graph.spec.evidence.liveReads.length === 0, "wiring graph must not mix mutable live reads into the Git import contract");
  const graphComponentRows = graph.spec?.components ?? [];
  const graphEdges = graph.spec?.edges ?? [];
  check(Array.isArray(graphComponentRows) && Array.isArray(graphEdges), "wiring graph components and edges must be arrays");
  assertUniqueSemanticKeys(graphComponentRows, (row) => String(row?.id ?? "").replace(/^component:/, ""), "wiring graph component id");
  assertUniqueSemanticKeys(graphEdges, (row) => String(row?.id ?? ""), "wiring graph edge id");
  const graphComponents = new Map(graphComponentRows.map((row) => [String(row.id ?? "").replace(/^component:/, ""), row]));
  check(graphComponents.size === instanceIds.size && [...instanceIds].every((id) => graphComponents.has(id)), "wiring graph component inventory differs from the effective-render instance inventory");
  for (const instance of instances) {
    const graphComponent = graphComponents.get(instance.id);
    check(graphComponent?.objectCount === instance.objectCount, `${instance.id}: wiring graph object count differs from the generation receipt`);
    const graphVersions = [...(graphComponent.selectedVersions ?? [])].map((row) => ({ identity: row.identity, version: String(row.version) })).sort((left, right) => left.identity.localeCompare(right.identity));
    check(stableJson(graphVersions) === stableJson(instance.selectedVersions), `${instance.id}: wiring graph selected versions differ from the exact component locks`);
  }
  const links = new Map();
  const targetFacts = new Map();
  const instanceByID = new Map(instances.map((row) => [row.id, row]));
  for (const edge of graphEdges) {
    const allowedStatuses = edge.relation === "needs"
      ? new Set(["resolved-rendered", "resolved-runtime", "target-prerequisite", "external", "unresolved", "ambiguous", "optional-unprovided"])
      : edge.relation === "provides" ? new Set(["declared-runtime", "rendered"]) : null;
    check(allowedStatuses, `${edge.id ?? "wiring edge"}: unknown relation ${edge.relation ?? "missing"}`);
    check(allowedStatuses.has(edge.status), `${edge.id ?? "wiring edge"}: unknown ${edge.relation} status ${edge.status ?? "missing"}`);
    const consumer = String(edge.component ?? "");
    check(instanceIds.has(consumer), `${edge.id ?? "wiring edge"}: names unknown component ${consumer || "missing"}`);
    if (edge.relation === "provides") continue;
    const rawProviders = edge.providerComponents ?? [];
    check(Array.isArray(rawProviders), `${edge.id ?? consumer}: providerComponents must be an array`);
    if (["resolved-rendered", "resolved-runtime"].includes(edge.status)) {
      check(rawProviders.length > 0, `${edge.id ?? consumer}: resolved wiring edge has no provider component`);
      const unknownProviders = rawProviders.filter((provider) => !instanceIds.has(provider));
      check(unknownProviders.length === 0, `${edge.id ?? consumer}: resolved wiring edge names unknown provider component(s): ${unknownProviders.join(", ")}`);
      const providers = rawProviders.filter((provider) => provider !== consumer);
      for (const provider of providers) {
        const key = `${consumer}->${provider}`;
        if (!links.has(key)) links.set(key, { consumer, provider, statuses: new Set(), reasons: new Set(), facts: new Set() });
        const row = links.get(key);
        row.statuses.add(edge.status);
        row.reasons.add(edge.reason);
        row.facts.add(edge.to);
      }
      continue;
    }
    if (["target-prerequisite", "external", "unresolved", "ambiguous", "optional-unprovided"].includes(edge.status)) {
      const key = `${consumer}|${edge.to}|${edge.status}`;
      if (!targetFacts.has(key)) targetFacts.set(key, {
        cluster: consumer.split("/")[0],
        consumer,
        fact: edge.to,
        status: edge.status,
        reason: edge.reason,
        resolutionHint: edge.resolutionHint || null,
        includedInGitOrOCI: false,
        requiredBeforeApply: Boolean(instanceByID.get(consumer)?.target)
          && ["target-prerequisite", "external", "unresolved", "ambiguous"].includes(edge.status),
      });
    }
  }
  return {
    source: graph.spec?.evidence ?? null,
    links: [...links.values()].map((row) => ({
      consumer: row.consumer,
      provider: row.provider,
      statuses: [...row.statuses].sort(),
      reasons: [...row.reasons].sort(),
      facts: [...row.facts].sort(),
      updateType: "NeedsProvides",
      autoUpdate: false,
    })).sort((left, right) => `${left.consumer}->${left.provider}`.localeCompare(`${right.consumer}->${right.provider}`)),
    targetFacts: [...targetFacts.values()].sort((left, right) => `${left.consumer}|${left.fact}|${left.status}`.localeCompare(`${right.consumer}|${right.fact}|${right.status}`)),
  };
}

function buildComponentPackagePlan(request, checkoutRoot, components) {
  const base = request.spec.destination.catalogOCIBase.replace(/\/+$/, "");
  const payloads = new Map();
  const rows = components.map((component) => {
    const treeSha256 = digestTree(component.path);
    const payload = {
      apiVersion: "import.confighub.com/v1alpha1",
      kind: "KubaraComponentOCIPayload",
      metadata: { name: component.service, version: component.wrapperVersion },
      spec: {
        component: component.service,
        chartName: component.chartName,
        wrapperVersion: component.wrapperVersion,
        chartType: component.chartType,
        role: component.role,
        deployable: component.deployable,
        sourceTreeSha256: treeSha256,
        dependencies: component.dependencies,
        firstParty: component.firstParty,
        files: payloadFileRows(component.path),
      },
    };
    const payloadText = `${stableJson(payload)}\n`;
    const payloadSha256 = sha256(payloadText);
    const row = {
      id: `component:${component.service}@${component.wrapperVersion}`,
      service: component.service,
      role: component.role,
      deployable: component.deployable,
      wrapperVersion: component.wrapperVersion,
      sourcePath: gitPath(checkoutRoot, component.path),
      sourceTreeSha256: treeSha256,
      payloadSha256,
      dependencies: component.dependencies,
      firstParty: component.firstParty,
      plannedOCIRef: `${base}/components/${component.service}:payload-${payloadSha256}`,
      publicationPolicy: "exclusive-single-writer-required; push-new-or-reuse-identical-digest; refuse-observed-conflict",
    };
    payloads.set(row.id, { text: payloadText, sha256: payloadSha256, filename: `${component.service}-component.json` });
    return row;
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { rows, payloads };
}

function buildConfigPackagePlan(request, checkoutRoot, instances) {
  const base = request.spec.destination.catalogOCIBase.replace(/\/+$/, "");
  const spaceReleaseBase = request.spec.destination.spaceReleaseOCIBase;
  const payloads = new Map();
  const rows = instances.map((instance) => {
    const space = instanceSpace(request.spec.destination.spacePrefix, instance.cluster, instance.service);
    const payload = {
      apiVersion: "import.confighub.com/v1alpha1",
      kind: "KubaraConfigSetOCIPayload",
      metadata: { name: `${instance.service}-${instance.cluster}` },
      spec: {
        component: instance.service,
        cluster: instance.cluster,
        wrapperVersion: instance.wrapperVersion,
        selectedVersions: instance.selectedVersions,
        renderSha256: instance.renderSha256,
        objectCount: instance.objectCount,
        destinationNamespace: instance.destinationNamespace,
        disposition: instance.disposition,
        generatedConfigFiles: payloadFileRows(instance.configPath),
        effectiveRender: payloadFileRow(instance.renderPath, "release-objects.yaml"),
      },
    };
    const payloadText = `${stableJson(payload)}\n`;
    const payloadSha256 = sha256(payloadText);
    const row = {
      id: `config:${instance.id}@${payloadSha256}`,
      component: instance.service,
      cluster: instance.cluster,
      wrapperVersion: instance.wrapperVersion,
      selectedVersions: instance.selectedVersions,
      render: gitPath(checkoutRoot, instance.renderPath),
      renderSha256: instance.renderSha256,
      payloadSha256,
      objectCount: instance.objectCount,
      destinationNamespace: instance.destinationNamespace,
      target: instance.target,
      disposition: instance.disposition,
      releaseSpace: space,
      releaseUnit: instance.service,
      plannedOCIRef: `${base}/configs/${instance.service}:payload-${payloadSha256}`,
      plannedConfigHubReleaseRefTemplate: `${spaceReleaseBase}/{${space}.SpaceID}/${instance.service}:latest`,
      publicationPolicy: "exclusive-single-writer-required; publish generic immutable config payload by exact layer; ConfigHub publishes the governed Space release separately",
      lifecycleBoundary: "preserve full effective render; executor must prove CRD/lifecycle ordering before apply",
    };
    payloads.set(row.id, { text: payloadText, sha256: payloadSha256, filename: `${instance.service}-${instance.cluster}-config.json` });
    return row;
  });
  return { rows, payloads };
}

function componentVersionLabels(component) {
  check(component, "component version labels require a discovered component");
  const external = component.dependencies.filter((row) => row.source !== "local-library");
  const primary = external.find((row) => normalize(row.name) === normalize(component.service))
    ?? (external.length === 1 ? external[0] : null)
    ?? (component.firstParty ? { name: component.service, version: component.firstParty.version } : null);
  const bundled = component.dependencies.map((row) => ({ name: row.name, version: String(row.version) }));
  if (component.firstParty) bundled.push({ name: component.service, version: String(component.firstParty.version) });
  const uniqueBundled = dedupeBy(bundled, (row) => `${row.name}@${row.version}`)
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  check(uniqueBundled.length > 0, `${component.service}: no exact component or bundled version is available for GUI identity`);
  const componentVersion = String(primary?.version ?? uniqueBundled.map((row) => row.version).join("+"));
  return {
    ComponentVersion: componentVersion,
    WrapperVersion: component.wrapperVersion,
    BundledVersions: uniqueBundled.map((row) => `${row.name}@${row.version}`).join("+"),
  };
}

function buildConfigHubPlan(request, components, instances, wiringPlan) {
  const prefix = request.spec.destination.spacePrefix;
  const controlSpace = `${prefix}-platform`;
  const navigation = navigationAnnotations(request);
  const guideAndCatalog = selectKeys(navigation, ["URL-Guide", "URL-Catalog"]);
  const wiringNavigation = selectKeys(navigation, ["URL-Guide", "URL-Catalog", "URL-Wiring"]);
  const spaces = [{
    slug: controlSpace,
    role: "PlatformControl",
    labels: {
      Role: "PlatformControl", Layer: "Platform", Scope: "Fleet", SourceType: "Kubara+ConfigHub",
      ComponentSurface: "platform-control", CatalogComponent: "platform-control", ComponentVersion: "git-import",
      Variant: "base", ControlPlane: "ConfigHub", Catalog: "ConfigHubControl", Owner: "ConfigHubControl", StartHere: "true",
    },
    annotations: navigation,
  }];
  const units = [
    unit(controlSpace, "platform-lock", "PlatformLock", null, "AppConfig/YAML", "generated:platform-lock.yaml", {
      labels: { Role: "PlatformLock", Component: "platform-lock", ComponentSurface: "platform-control", CatalogComponent: "platform-control", Catalog: "ConfigHubControl", Owner: "ConfigHubControl", Variant: "base", ControlPlane: "ConfigHub", StartHere: "true" },
      annotations: navigation,
    }),
    unit(controlSpace, "kubara-config", "PlatformContract", null, "AppConfig/YAML", "source:config", {
      labels: { Role: "PlatformContract", Component: "kubara-config", ComponentSurface: "platform-control", CatalogComponent: "platform-control", Catalog: "ConfigHubControl", Owner: "ConfigHubControl", Variant: "base", ControlPlane: "ConfigHub", StartHere: "true" },
      annotations: guideAndCatalog,
    }),
    unit(controlSpace, "component-catalog-index", "ComponentCatalogSelection", null, "AppConfig/JSON", "generated:oci-publication-receipt.json", {
      labels: { Role: "ComponentCatalogSelection", Component: "component-catalog", ComponentSurface: "platform-control", CatalogComponent: "component-catalog", Catalog: "ConfigHubControl", Owner: "ConfigHubControl", Variant: "base", ControlPlane: "ConfigHub", StartHere: "true" },
      annotations: guideAndCatalog,
    }),
    unit(controlSpace, "wiring-ledger", "WiringDefinition", null, "AppConfig/JSON", "source:wiring-graph", {
      labels: { Role: "WiringDefinition", Component: "wiring-ledger", ComponentSurface: "platform-control", CatalogComponent: "platform-control", Catalog: "ConfigHubControl", Owner: "ConfigHubControl", Variant: "base", ControlPlane: "ConfigHub", StartHere: "true" },
      annotations: wiringNavigation,
    }),
  ];
  const componentsByService = new Map(components.map((component) => [component.service, component]));
  for (const component of components) {
    const space = definitionSpace(prefix, component.service);
    const catalog = component.service === "argo-cd" || component.role === "LifecycleDefinition" ? "KubaraBootstrap" : "KubaraGeneral";
    const componentSurface = component.service === "argo-cd" ? "argocd-delivery" : component.service;
    const versionLabels = componentVersionLabels(component);
    spaces.push({
      slug: space,
      role: component.role,
      labels: {
        Role: component.role, Layer: "Platform", Scope: "Fleet", DefinitionScope: "Base",
        Component: component.service, ComponentSurface: componentSurface, KubaraComponent: component.service,
        CatalogComponent: component.service, ...versionLabels,
        Variant: "base", ControlPlane: "ConfigHub", Catalog: catalog, Owner: catalog,
        Lane: component.service === "argo-cd" ? "Faithful" : "Adapted",
      },
    });
    const canonical = instances.find((row) => row.service === component.service);
    if (canonical) {
      units.push(unit(space, component.service, component.role, null, "Kubernetes/YAML", `config:${canonical.id}`, {
        canonicalInstance: canonical.id,
        labels: {
          Role: component.role, Component: component.service, ComponentSurface: componentSurface,
          KubaraComponent: component.service, CatalogComponent: component.service, ...versionLabels,
          Catalog: catalog, Owner: catalog, Variant: "base", ControlPlane: "ConfigHub",
          Lane: component.service === "argo-cd" ? "Faithful" : "Adapted",
        },
      }));
    } else {
      units.push(unit(space, `${component.service}-catalog-lock`, "ComponentCatalogLock", null, "AppConfig/YAML", `component:${component.service}@${component.wrapperVersion}`, {
        labels: {
          Role: "ComponentCatalogLock", Component: component.service, ComponentSurface: componentSurface,
          KubaraComponent: component.service, CatalogComponent: component.service, ...versionLabels,
          Catalog: catalog, Owner: catalog, Variant: "base", ControlPlane: "ConfigHub",
          Lane: component.service === "argo-cd" ? "Faithful" : "Adapted",
        },
      }));
    }
  }
  for (const instance of instances) {
    const space = instanceSpace(prefix, instance.cluster, instance.service);
    const targetMapping = request.spec.targets[instance.cluster];
    const retainedKubaraArgo = instance.service === "argo-cd" && !instance.target;
    const componentSurface = instance.service === "argo-cd" ? "argocd-delivery" : instance.service;
    const instanceRole = instance.service === "argo-cd" ? "DeliveryInstance" : "ComponentInstance";
    const versionLabels = componentVersionLabels(componentsByService.get(instance.service));
    spaces.push({
      slug: space,
      role: "ComponentInstance",
      labels: {
        Role: instanceRole,
        Layer: "Platform",
        Component: instance.service,
        ComponentSurface: componentSurface,
        KubaraComponent: instance.service,
        CatalogComponent: instance.service,
        ...versionLabels,
        Cluster: instance.cluster,
        Environment: targetMapping.environment,
        Region: targetMapping.region ?? "unspecified",
        KubaraTopologyRole: instance.topologyRole,
        ClusterRole: instance.topologyRole,
        KubaraStage: instance.stage || targetMapping.environment,
        Variant: instance.cluster,
        InstanceOf: instance.service,
        DefinitionSpace: definitionSpace(prefix, instance.service),
        DeliveryMode: retainedKubaraArgo ? "RetainedKubaraHub" : "ConfigHubOCI",
        Reconciler: retainedKubaraArgo ? "NotTargeted" : "ClusterLocalArgo",
        ControlPlane: retainedKubaraArgo ? "Kubara" : "ConfigHub",
        Lane: retainedKubaraArgo ? "Faithful" : "Adapted",
        SourceType: retainedKubaraArgo ? "RetainedKubaraDefinition" : "KubaraGeneratedConfig",
        ...(retainedKubaraArgo ? { Disposition: "RetainedNotTargeted" } : {}),
        Catalog: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
        Owner: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
      },
    });
    units.push(unit(space, instance.service, instanceRole, instance.target, "Kubernetes/YAML", `config:${instance.id}`, {
      upstream: `${definitionSpace(prefix, instance.service)}/${instance.service}`,
      disposition: instance.disposition,
      labels: {
        Role: instanceRole, Component: instance.service, ComponentSurface: componentSurface,
        KubaraComponent: instance.service, CatalogComponent: instance.service, ...versionLabels,
        Cluster: instance.cluster, Environment: targetMapping.environment, Region: targetMapping.region ?? "unspecified",
        ClusterRole: instance.topologyRole, KubaraStage: instance.stage || targetMapping.environment,
        Variant: instance.cluster, InstanceOf: instance.service, DefinitionSpace: definitionSpace(prefix, instance.service),
        DeliveryMode: retainedKubaraArgo ? "RetainedKubaraHub" : "ConfigHubOCI",
        Reconciler: retainedKubaraArgo ? "NotTargeted" : "ClusterLocalArgo",
        ControlPlane: retainedKubaraArgo ? "Kubara" : "ConfigHub",
        Lane: retainedKubaraArgo ? "Faithful" : "Adapted",
        SourceType: retainedKubaraArgo ? "RetainedKubaraDefinition" : "KubaraGeneratedConfig",
        ...(retainedKubaraArgo ? { Disposition: "RetainedNotTargeted" } : {}),
        Catalog: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
        Owner: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
      },
    }));
  }
  const runtimeDefinition = deliveryRuntimeDefinition(request);
  spaces.push({
    slug: runtimeDefinition.space,
    role: "DeliveryDefinition",
    labels: runtimeDefinition.labels,
  });
  units.push(unit(runtimeDefinition.space, runtimeDefinition.unit, "DeliveryDefinition", null, "AppConfig/YAML", "generated:argo-runtime-definition", {
    labels: runtimeDefinition.labels,
  }));
  for (const [cluster, target] of Object.entries(request.spec.targets).sort(([a], [b]) => a.localeCompare(b))) {
    spaces.push({
      slug: target.space,
      role: "ClusterTarget",
      externalBinding: true,
      create: false,
      expectedSpaceID: target.spaceID,
      expectedTarget: target.target,
      expectedTargetID: target.targetID,
      labels: {
        Role: "ClusterTarget",
        ComponentSurface: "cluster-target",
        CatalogComponent: "cluster-target",
        Cluster: cluster,
        Environment: target.environment,
        Region: target.region ?? "unspecified",
        Variant: cluster,
        Lane: "Adapted",
        DeliveryMode: "ConfigHubOCI",
        Reconciler: "ClusterLocalArgo",
        ControlPlane: "ConfigHub",
      },
    });
  }
  const links = [];
  for (const instance of instances) {
    links.push({
      space: instanceSpace(prefix, instance.cluster, instance.service),
      slug: `upgrade-${instance.service}`,
      fromUnit: instance.service,
      toSpace: definitionSpace(prefix, instance.service),
      toUnit: instance.service,
      updateType: "UpgradeUnit",
      autoUpdate: false,
      labels: { Role: "DefinitionInstanceLineage", Relationship: "UpgradeUnit", ConsumerComponent: instance.service, ProviderComponent: instance.service },
    });
  }
  for (const edge of wiringPlan.links) {
    const [consumerCluster, consumerService] = edge.consumer.split("/");
    const [providerCluster, providerService] = edge.provider.split("/");
    const consumerSpace = instanceSpace(prefix, consumerCluster, consumerService);
    links.push({
      space: consumerSpace,
      slug: uniqueLinkSlug(`needs-${providerService}`, links.filter((row) => row.space === consumerSpace)),
      fromUnit: consumerService,
      toSpace: instanceSpace(prefix, providerCluster, providerService),
      toUnit: providerService,
      updateType: "NeedsProvides",
      autoUpdate: false,
      makeCurrent: true,
      reasons: edge.reasons,
      facts: edge.facts,
      labels: { Role: "WiringInstance", Relationship: "NeedsProvides", ConsumerComponent: consumerService, ProviderComponent: providerService },
    });
  }
  const deliveryApplications = instances.filter((instance) => instance.target).map((instance) => {
    const sourceSpace = instanceSpace(prefix, instance.cluster, instance.service);
    const target = request.spec.targets[instance.cluster];
    const componentSurface = instance.service === "argo-cd" ? "argocd-delivery" : instance.service;
    const versionLabels = componentVersionLabels(componentsByService.get(instance.service));
    return {
      space: target.delivery.appsSpace,
      slug: sourceSpace,
      cluster: instance.cluster,
      sourceSpace,
      sourceRepoURL: spaceReleaseOCIRef(request.spec.destination.spaceReleaseOCIBase, sourceSpace),
      sourceUnit: instance.service,
      destinationNamespace: instance.destinationNamespace,
      target: instance.target,
      labels: {
        Role: "DeliveryApplication",
        Component: instance.service,
        ComponentSurface: componentSurface,
        KubaraComponent: instance.service,
        CatalogComponent: instance.service,
        ...versionLabels,
        Catalog: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
        Owner: instance.service === "argo-cd" ? "KubaraBootstrap" : "KubaraGeneral",
        Variant: instance.cluster,
        Cluster: instance.cluster,
        Environment: target.environment,
        Region: target.region ?? "unspecified",
        ClusterRole: instance.topologyRole,
        KubaraStage: instance.stage || target.environment,
        DeliveryMode: "ConfigHubOCI",
        Reconciler: "ClusterLocalArgo",
        ControlPlane: "ConfigHub",
        Lane: "Adapted",
        ApplicationKind: "PlatformComponent",
        SourceSpace: sourceSpace,
        InstanceOf: instance.service,
        DefinitionSpace: definitionSpace(prefix, instance.service),
      },
    };
  }).sort((left, right) => `${left.space}/${left.slug}`.localeCompare(`${right.space}/${right.slug}`));
  for (const row of spaces) checkSlug(row.slug, `generated Space ${row.slug}`);
  for (const row of units) checkSlug(row.slug, `generated Unit ${row.space}/${row.slug}`);
  for (const row of links) checkSlug(row.slug, `generated Link ${row.space}/${row.slug}`);
  for (const row of deliveryApplications) checkSlug(row.slug, `generated delivery Application ${row.space}/${row.slug}`);
  return {
    organization: request.spec.destination.organization,
    ownershipAnnotation: "import.confighub.com/platform-digest",
    conflictPolicy: "refuse-unexpected-space-unit-link-or-different-platform-digest",
    importerDeleteOperations: [],
    clusterReconcilerPrune: true,
    spaces: dedupeBy(spaces, (row) => row.slug).sort((left, right) => left.slug.localeCompare(right.slug)),
    units: units.sort((left, right) => `${left.space}/${left.slug}`.localeCompare(`${right.space}/${right.slug}`)),
    links: links.sort((left, right) => `${left.space}/${left.slug}`.localeCompare(`${right.space}/${right.slug}`)),
    deliveryInfrastructure: buildDeliveryInfrastructurePlan(request, componentsByService, instances),
    deliveryApplications,
  };
}

function buildDeliveryInfrastructurePlan(request, _componentsByService, instances) {
  const runtimeDefinition = deliveryRuntimeDefinition(request);
  const argobotVersions = {
    ComponentVersion: request.spec.destination.argobotBase.componentVersion,
    BundledVersions: `argobot@${request.spec.destination.argobotBase.componentVersion}`,
  };
  const deliveryIdentity = { Lane: "Adapted", DeliveryMode: "ConfigHubOCI", Reconciler: "ClusterLocalArgo", ControlPlane: "ConfigHub" };
  const argobotBaseLabels = {
    Role: "DeliveryDefinition", Component: "argobot", KubaraComponent: "argobot", CatalogComponent: "argobot",
    ComponentSurface: "argobot", Catalog: "ConfigHubDelivery", Owner: "ConfigHubDelivery", Variant: "base",
    Scope: "Fleet", DefinitionScope: "Base", ControlPlane: "ConfigHub", Lane: "Adapted", ...argobotVersions,
  };
  return {
    ownership: "pre-existing-request-pinned-cluster-local-argo-root",
    createOrRepair: false,
    reconcilerDefinition: runtimeDefinition,
    argobotBase: { ...request.spec.destination.argobotBase, labels: argobotBaseLabels, unitLabels: argobotBaseLabels },
    clusters: Object.entries(request.spec.targets).sort(([left], [right]) => left.localeCompare(right)).map(([cluster, target]) => ({
      ...(() => {
        const instance = instances.find((row) => row.cluster === cluster);
        check(instance, `${cluster}: no component instance is available for delivery metadata`);
        const clusterIdentity = {
          Cluster: cluster, Environment: target.environment, Region: target.region ?? "unspecified",
          ClusterRole: instance.topologyRole, KubaraStage: instance.stage || target.environment, Variant: cluster,
        };
        const reconciler = target.delivery.reconciler;
        const runtimeVersions = {
          ComponentVersion: reconciler.componentVersion,
          BundledVersions: `argo-cd@${reconciler.componentVersion}`,
          RuntimeVersion: reconciler.componentVersion,
          RuntimeImage: reconciler.image,
        };
        const appsLabels = {
          Role: "DeliveryInstance", Component: "argo-cd", CatalogComponent: "argo-cd",
          ComponentSurface: "argocd-delivery", Catalog: "ConfigHubBootstrap", Owner: "ConfigHubBootstrap",
          InstanceOf: "argo-cd-runtime", DefinitionSpace: runtimeDefinition.space, ...runtimeVersions, ...clusterIdentity, ...deliveryIdentity,
        };
        const argobotLabels = {
          Role: "DeliveryInstance", Component: "argobot", KubaraComponent: "argobot", CatalogComponent: "argobot",
          ComponentSurface: "argobot", Catalog: "ConfigHubDelivery", Owner: "ConfigHubDelivery",
          InstanceOf: "argobot", DefinitionSpace: request.spec.destination.argobotBase.space, ...argobotVersions, ...clusterIdentity, ...deliveryIdentity,
        };
        return {
          appsSpaceLabels: appsLabels,
          rootUnitLabels: { ...appsLabels, Role: "DeliveryApplication", ApplicationKind: "ClusterRoot", SourceSpace: target.delivery.appsSpace },
          argobotApplicationUnitLabels: { ...argobotLabels, Role: "DeliveryApplication", ApplicationKind: "Argobot", SourceSpace: target.delivery.argobot.space },
          argobotSpaceLabels: argobotLabels,
          argobotUnitLabels: argobotLabels,
        };
      })(),
      cluster,
      targetSpace: target.space,
      targetSpaceID: target.spaceID,
      target: target.target,
      targetID: target.targetID,
      ...target.delivery,
    })),
  };
}

function deliveryRuntimeDefinition(request) {
  const prefix = request.spec.destination.spacePrefix;
  const rows = Object.entries(request.spec.targets).sort(([left], [right]) => left.localeCompare(right)).map(([cluster, target]) => ({
    cluster,
    componentVersion: target.delivery.reconciler.componentVersion,
    image: target.delivery.reconciler.image,
    evidenceRef: target.delivery.reconciler.evidenceRef,
    evidenceSHA256: target.delivery.reconciler.evidenceSHA256,
  }));
  const versions = [...new Set(rows.map((row) => row.componentVersion))].sort();
  const images = [...new Set(rows.map((row) => row.image))].sort();
  const labels = {
    Role: "DeliveryDefinition",
    Component: "argo-cd",
    ComponentSurface: "argocd-delivery-runtime",
    CatalogComponent: "argo-cd",
    Catalog: "ConfigHubBootstrap",
    Owner: "ConfigHubBootstrap",
    Variant: "base",
    Scope: "Fleet",
    DefinitionScope: "Base",
    ControlPlane: "ConfigHub",
    Lane: "Adapted",
    ComponentVersion: versions.join("+"),
    BundledVersions: rows.map((row) => `${row.cluster}@${row.componentVersion}`).join("+"),
    RuntimeVersion: versions.join("+"),
    RuntimeImage: images.join("+"),
  };
  return {
    space: `${prefix}-argo-runtime-base`,
    unit: "argo-cd-runtime",
    labels,
    evidence: rows,
    claimBoundary: "This definition records request-pinned observations of the existing cluster-local delivery runtime; it is not the Kubara argo-cd chart definition and does not claim to install Argo CD.",
  };
}

function deliveryRuntimeDefinitionText() {
  return `${toYaml({
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "ConfigHubArgoDeliveryRuntimeContract",
    metadata: { name: "argo-cd-runtime" },
    spec: {
      identity: "argo-cd-runtime",
      lane: "adapted",
      owner: "ConfigHubBootstrap",
      evidencePlacement: "external-destination-binding-and-apply-receipt",
      requiredObservationFields: ["cluster", "componentVersion", "image", "evidenceRef", "evidenceSHA256"],
      claimBoundary: "This target-neutral definition describes the existing cluster-local delivery-runtime evidence contract. Per-cluster runtime observations are never embedded in component/config OCI.",
    },
  })}\n`;
}

function inventoryRevisionFiles(checkoutRoot, sourceRoot, inputs) {
  // The immutable source path is the security and provenance boundary, not
  // merely the handful of files that become deployable Units. This prevents a
  // caller from hiding credentials in an unselected sibling file in the same
  // claimed platform revision.
  rejectSymlinks(sourceRoot, true);
  const result = walkFiles(sourceRoot, true).map((path) => resolve(path)).sort();
  for (const path of result) {
    check(isWithin(path, sourceRoot), `${path}: selected file escapes source path`);
    check(isWithin(path, checkoutRoot), `${path}: selected file escapes checkout`);
  }
  const targetFactFiles = result.filter((path) => gitPath(sourceRoot, path).split("/").includes("target-facts"));
  check(targetFactFiles.length === 0, `target facts must be supplied at target-binding time, outside the imported Git/OCI path:\n- ${targetFactFiles.join("\n- ")}`);
  for (const required of [inputs.config, inputs.artifactLock, inputs.generationReceipt, inputs.wiringGraph]) {
    check(result.includes(resolve(required)), `${required}: required layout input is outside the revision inventory`);
  }
  return result;
}

function verifyTrackedInputs(checkoutRoot, commit, sourcePath, files) {
  const raw = execFileSync("git", ["-C", checkoutRoot, "ls-tree", "-r", "-z", "--full-tree", commit, "--", sourcePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const committed = raw.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/);
    check(match, `cannot parse exact Git tree entry without exposing selected file bytes`);
    const [, mode, type, , path] = match;
    check(type === "blob" && ["100644", "100755"].includes(mode), `${path}: selected Git path contains unsupported tracked entry ${mode}/${type}; regular committed files only`);
    return path;
  }).sort();
  const present = files.map((path) => gitPath(checkoutRoot, path)).sort();
  const committedSet = new Set(committed);
  const presentSet = new Set(present);
  const omitted = committed.filter((path) => !presentSet.has(path));
  const unexpected = present.filter((path) => !committedSet.has(path));
  check(
    omitted.length === 0 && unexpected.length === 0,
    `working-tree selected-path inventory differs from exact committed blob inventory at ${commit}; sparse, skip-worktree, missing, and uncommitted files are refused\nmissing from working tree:\n- ${omitted.join("\n- ") || "none"}\nnot in commit:\n- ${unexpected.join("\n- ") || "none"}`,
  );
}

function scanForSecretMaterial(files) {
  const findings = [];
  for (const path of files) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) {
      const nearby = text.slice(match.index, match.index + 512);
      if (!/(?:<private-key>|REPLACE_ME|CHANGEME|redacted)/i.test(nearby)) findings.push(`${path}: PEM private key`);
    }
    if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) findings.push(`${path}: AWS access-key-shaped value`);
    if (/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i.test(text)) findings.push(`${path}: credential-bearing connection URL`);
    if (/\.(?:env|toml|ini|conf|properties|sh|tmpl|tpl)$/i.test(path)) scanRawCredentialAssignments(text, path, findings);
    if (/\.json$/i.test(path)) {
      try {
        const value = JSON.parse(text);
        scanSensitiveMappings(value, path, findings);
        for (const doc of Array.isArray(value) ? value : [value]) scanSecretDocument(doc, path, findings);
      } catch { findings.push(`${path}: selected JSON input is invalid and cannot be structurally credential-scanned`); }
      continue;
    }
    if (!/\.ya?ml$/i.test(path)) continue;
    let docs;
    try {
      docs = parseDocs(text);
    } catch {
      scanRawCredentialAssignments(text, path, findings);
      continue; // Helm templates are not plain YAML; the raw high-confidence checks still ran.
    }
    for (const doc of docs) {
      if (["ClusterSecretStore", "SecretStore"].includes(doc?.kind) && doc.spec?.provider?.fake?.data?.some((row) => meaningfulSecretValue(row?.value))) {
        findings.push(`${path}: ${doc.kind} ${doc.metadata?.name ?? "unnamed"} embeds fake-provider values; bind them as target facts instead`);
      }
      if (doc?.kind === "Secret") {
        scanSecretDocument(doc, path, findings);
        continue;
      }
      if (doc?.kind !== "CustomResourceDefinition") scanSensitiveMappings(doc, path, findings);
    }
  }
  check(findings.length === 0, `credential-shaped material is forbidden in selected Git/OCI payloads:\n- ${findings.join("\n- ")}`);
}

function semanticRequest(request) {
  const { transition: _executionAuthority, ...bindingSpec } = request.spec;
  return {
    apiVersion: request.apiVersion,
    kind: request.kind,
    metadata: { name: request.metadata.name },
    spec: bindingSpec,
  };
}

function targetNeutralTopology(topology) {
  return {
    ...topology,
    clusters: topology.clusters.map(({ target: _target, ...cluster }) => cluster),
  };
}

function targetNeutralComponentPackageRows(rows) {
  return rows.map(({ plannedOCIRef: _plannedOCIRef, publicationPolicy: _publicationPolicy, ...row }) => row);
}

function targetNeutralConfigPackageRows(rows) {
  return rows.map(({
    target: _target,
    releaseSpace: _releaseSpace,
    releaseUnit: _releaseUnit,
    plannedOCIRef: _plannedOCIRef,
    plannedConfigHubReleaseRefTemplate: _plannedReleaseRef,
    publicationPolicy: _publicationPolicy,
    ...row
  }) => row);
}

function buildTargetFactsRequirement(request, platformDigest, bindingDigest, targetFacts) {
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraTargetFactAttestation",
    metadata: { name: request.metadata.name },
    spec: {
      platformDigest,
      bindingDigest,
      organization: {
        externalID: request.spec.destination.organizationExternalID,
        organizationID: request.spec.destination.organizationID,
      },
      bindings: Object.entries(request.spec.targets).sort(([left], [right]) => left.localeCompare(right)).map(([cluster, target]) => ({
        cluster,
        space: target.space,
        spaceID: target.spaceID,
        target: target.target,
        targetID: target.targetID,
        delivery: target.delivery,
        status: "pending-live-verification",
      })),
      resolutions: targetFacts.filter((row) => row.requiredBeforeApply).map((row) => ({
        consumer: row.consumer,
        fact: row.fact,
        sourceStatus: row.status,
        status: "pending-operator-attestation",
        evidenceRef: "<external-evidence-reference-without-secret-values>",
        evidenceSHA256: `<sha256-for-${sha256(`${row.consumer}\0${row.fact}`).slice(0, 12)}>` ,
      })),
      policy: {
        secretValuesIncluded: false,
        generatedTemplateIsAnAttestation: false,
        acceptedBindingStatus: "verified-present",
        acceptedResolutionStatuses: ["satisfied", "not-applicable-reviewed"],
      },
    },
  };
}

function writeOutputs(outputRoot, compiled) {
  ensureSafeOutputTree(outputRoot, { create: true });
  writeFileSync(join(outputRoot, "import-plan.json"), compiled.planText);
  writeFileSync(join(outputRoot, "platform-lock.yaml"), compiled.lockText);
  writeFileSync(join(outputRoot, "destination-binding-lock.yaml"), compiled.bindingLockText);
  writeFileSync(join(outputRoot, "acceptance.json"), compiled.acceptanceText);
  writeFileSync(join(outputRoot, "target-facts-required.yaml"), compiled.targetFactsRequiredText);
  writeFileSync(join(outputRoot, "checksums.txt"), compiled.checksumsText);
}

function verifyOutputs(outputRoot, compiled) {
  ensureSafeOutputTree(outputRoot);
  const expected = {
    "import-plan.json": compiled.planText,
    "platform-lock.yaml": compiled.lockText,
    "destination-binding-lock.yaml": compiled.bindingLockText,
    "acceptance.json": compiled.acceptanceText,
    "target-facts-required.yaml": compiled.targetFactsRequiredText,
    "checksums.txt": compiled.checksumsText,
  };
  for (const [name, text] of Object.entries(expected)) {
    const path = join(outputRoot, name);
    check(existsSync(path), `${path} is missing; compile the import first`);
    check(readFileSync(path, "utf8") === text, `${path} is stale or was modified; recompile from the exact Git revision`);
  }
}

function assertBindOutputReplaySafe(outputRoot, compiled) {
  if (!existsSync(outputRoot)) return;
  ensureSafeOutputTree(outputRoot);
  const applyReceiptPath = join(outputRoot, "apply-receipt.json");
  if (!existsSync(applyReceiptPath)) return;
  check(!lstatSync(applyReceiptPath).isSymbolicLink(), "existing apply receipt must not be a symbolic link");
  // Once a destination-bound output has advanced into apply, --bind may only
  // replay the byte-identical binding. Refuse before rewriting any control
  // artifact if the caller points the advanced directory at another binding.
  verifyOutputs(outputRoot, compiled);
}

function outputChecksums({ planText, lockText, bindingLockText, acceptanceText, targetFactsRequiredText }) {
  return [
    `${sha256(acceptanceText)}  acceptance.json`,
    `${sha256(planText)}  import-plan.json`,
    `${sha256(lockText)}  platform-lock.yaml`,
    `${sha256(bindingLockText)}  destination-binding-lock.yaml`,
    `${sha256(targetFactsRequiredText)}  target-facts-required.yaml`,
  ].sort().join("\n") + "\n";
}

function buildPortablePackageSet(compiled) {
  const members = [
    ...compiled.plan.spec.oci.catalogPackages.map((row) => ({ ...row, role: "component-definition" })),
    ...compiled.plan.spec.oci.configReleases.map((row) => ({ ...row, role: "effective-config-set" })),
  ].sort((left, right) => left.id.localeCompare(right.id)).map((row) => ({
    id: row.id,
    role: row.role,
    payloadSha256: row.payloadSha256,
    plannedOCIRef: row.plannedOCIRef,
    payloadPath: `payloads/${safeArtifactFilename(row.id)}-${row.payloadSha256}.json`,
  }));
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraPortablePackageSet",
    metadata: { name: compiled.plan.metadata.name },
    spec: {
      platformDigest: compiled.lock.spec.platformDigest,
      source: compiled.lock.spec.source,
      importerContractVersion: compiled.lock.spec.importerContractVersion,
      importerMaterializationContractSHA256: compiled.lock.spec.importerMaterializationContractSHA256,
      members,
      aggregate: {
        plannedOCIRef: compiled.plan.spec.oci.aggregate.plannedOCIRef,
        type: "target-neutral-index-published-after-member-manifest-digests-are-observed",
      },
      controlPayloads: [
        { id: "platform-lock", sha256: sha256(compiled.lockText) },
        { id: "kubara-config", sha256: sha256(compiled.execution.kubaraConfigText) },
        { id: "wiring-ledger", sha256: sha256(compiled.execution.wiringGraphText) },
        { id: "argo-cd-runtime", sha256: sha256(deliveryRuntimeDefinitionText()) },
      ],
      boundary: {
        destinationBindingsIncluded: false,
        targetFactsIncluded: false,
        secretValuesIncluded: false,
        mutableReferencesAccepted: false,
        organizationMayBeSelectedAfterCompilation: true,
      },
    },
    status: { result: "compiled-offline", liveRegistryPublicationClaimed: false, liveOrganizationBindingClaimed: false },
  };
}

function portableOutputRows(compiled) {
  const packageSet = buildPortablePackageSet(compiled);
  const packageSetText = `${JSON.stringify(packageSet, null, 2)}\n`;
  const rows = new Map([
    ["platform-lock.yaml", compiled.lockText],
    ["portable-package-set.json", packageSetText],
  ]);
  for (const member of packageSet.spec.members) {
    const payload = compiled.execution.componentPayloads.get(member.id) ?? compiled.execution.configPayloads.get(member.id);
    check(payload && payload.sha256 === member.payloadSha256 && sha256(payload.text) === member.payloadSha256, `${member.id}: portable payload differs from the target-neutral compile`);
    rows.set(member.payloadPath, payload.text);
  }
  const checksums = [...rows.entries()].map(([path, text]) => `${sha256(text)}  ${path}`).sort().join("\n") + "\n";
  rows.set("portable-checksums.txt", checksums);
  return rows;
}

function writePortableOutputs(outputRoot, compiled) {
  ensureSafeOutputTree(outputRoot, { create: true });
  const rows = portableOutputRows(compiled);
  for (const [path, text] of rows) {
    const destination = safeJoin(outputRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    check(!existsSync(destination) || !lstatSync(destination).isSymbolicLink(), `${destination}: refusing to replace a symbolic link`);
    writeFileSync(destination, text);
  }
  check(!existsSync(join(outputRoot, "destination-binding-lock.yaml")), "portable output must not contain a destination binding lock");
  check(!existsSync(join(outputRoot, "target-facts-required.yaml")), "portable output must not contain target-fact bindings");
}

function verifyPortableOutputs(outputRoot, compiled) {
  ensureSafeOutputTree(outputRoot);
  rejectSymlinks(outputRoot);
  const rows = portableOutputRows(compiled);
  for (const [path, text] of rows) {
    const actual = safeJoin(outputRoot, path);
    check(existsSync(actual), `${actual} is missing; compile the portable package set first`);
    check(readFileSync(actual, "utf8") === text, `${actual} is stale or differs from the exact target-neutral compile`);
  }
  check(!existsSync(join(outputRoot, "destination-binding-lock.yaml")), "portable output contains a destination binding lock");
  check(!existsSync(join(outputRoot, "target-facts-required.yaml")), "portable output contains target-fact bindings");
}

function copyPortablePublication({ portableRoot, outputRoot, compiled }) {
  const receiptPath = join(portableRoot, "oci-publication-receipt.json");
  const binding = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraPortableDestinationBindingReceipt",
    metadata: { name: compiled.plan.metadata.name },
    spec: {
      platformDigest: compiled.lock.spec.platformDigest,
      bindingDigest: compiled.plan.spec.bindingDigest,
      portablePackageSetSHA256: `sha256:${sha256(readFileSync(join(portableRoot, "portable-package-set.json")))}`,
      publicationReceiptSHA256: null,
      destinationBindingIncludedInPortableOCI: false,
    },
    status: { result: "bound-offline", portablePublicationCopied: false, liveApplyClaimed: false },
  };
  if (existsSync(receiptPath)) {
    check(!lstatSync(receiptPath).isSymbolicLink(), "portable OCI publication receipt must not be a symbolic link");
    const receipt = readJson(receiptPath);
    validatePortablePublicationLocal({ compiled, portableRoot, receipt });
    const sourceOci = join(portableRoot, "oci");
    check(existsSync(sourceOci), "portable OCI publication receipt exists without its local OCI payload directory");
    rejectSymlinks(sourceOci);
    const destinationOci = join(outputRoot, "oci");
    copyDirectoryReuseExact(sourceOci, destinationOci);
    const destinationReceipt = join(outputRoot, "oci-publication-receipt.json");
    const receiptBytes = readFileSync(receiptPath);
    if (existsSync(destinationReceipt)) {
      check(!lstatSync(destinationReceipt).isSymbolicLink(), "bound OCI publication receipt must not be a symbolic link");
      check(readFileSync(destinationReceipt).equals(receiptBytes), "bound OCI publication receipt differs from the exact portable receipt");
    } else writeFileSync(destinationReceipt, receiptBytes);
    binding.spec.publicationReceiptSHA256 = `sha256:${sha256(readFileSync(receiptPath))}`;
    binding.status.portablePublicationCopied = true;
  }
  writeJsonExact(join(outputRoot, "portable-binding-receipt.json"), binding);
}

function copyDirectoryReuseExact(source, destination) {
  if (existsSync(destination)) {
    check(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink(), `${destination}: bound OCI payload must be a real directory`);
    rejectSymlinks(destination);
    check(stableJson(directoryDigestRows(destination)) === stableJson(directoryDigestRows(source)), `${destination}: existing bound OCI payload directory differs from the portable publication`);
    return;
  }
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  check(!existsSync(temporary), `${temporary}: temporary OCI binding path already exists`);
  try {
    cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
    rejectSymlinks(temporary);
    check(stableJson(directoryDigestRows(temporary)) === stableJson(directoryDigestRows(source)), `${temporary}: copied OCI payload differs from the portable publication`);
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

function directoryDigestRows(root) {
  const rows = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    check(!stat.isSymbolicLink(), `${path}: symbolic links are refused in an exact OCI payload tree`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    check(stat.isFile(), `${path}: only regular files and directories are accepted in an exact OCI payload tree`);
    const bytes = readFileSync(path);
    rows.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(bytes), size: bytes.length });
  };
  visit(root);
  return rows;
}

function validatePortablePublicationLocal({ compiled, portableRoot, receipt }) {
  check(receipt?.apiVersion === "import.confighub.com/v1alpha1" && receipt?.kind === "KubaraOCIPublicationReceipt", "portable OCI publication receipt apiVersion/kind is invalid");
  check(receipt.spec?.platformDigest === compiled.lock.spec.platformDigest && receipt.status?.result === "pass", "portable OCI publication receipt does not pass for this platform digest");
  const planned = [
    ...compiled.plan.spec.oci.catalogPackages.map((row) => ({ ...row, role: "component-definition" })),
    ...compiled.plan.spec.oci.configReleases.map((row) => ({ ...row, role: "effective-config-set" })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const received = [...(receipt.spec?.members ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  check(received.length === planned.length, "portable OCI publication receipt member inventory differs from the bound compile");
  for (let index = 0; index < planned.length; index += 1) {
    const plan = planned[index];
    const row = received[index];
    check(row.id === plan.id && row.role === plan.role && row.ref === plan.plannedOCIRef, `${plan.id}: portable publication identity/ref differs from the bound compile`);
    check(row.payloadSha256 === plan.payloadSha256 && row.layerDigest === `sha256:${plan.payloadSha256}` && /^sha256:[0-9a-f]{64}$/.test(row.manifestDigest ?? ""), `${plan.id}: portable publication digest contract is invalid`);
    const payloadPath = safeJoin(portableRoot, row.payloadPath);
    check(existsSync(payloadPath) && sha256(readFileSync(payloadPath)) === plan.payloadSha256, `${plan.id}: portable publication payload is missing or changed`);
  }
  const aggregate = receipt.spec?.aggregate;
  check(aggregate?.ref === compiled.plan.spec.oci.aggregate.plannedOCIRef && /^[0-9a-f]{64}$/.test(aggregate?.payloadSha256 ?? "") && aggregate.layerDigest === `sha256:${aggregate.payloadSha256}` && /^sha256:[0-9a-f]{64}$/.test(aggregate.manifestDigest ?? ""), "portable aggregate OCI publication contract is invalid");
  const aggregatePath = safeJoin(portableRoot, aggregate.payloadPath);
  check(existsSync(aggregatePath) && sha256(readFileSync(aggregatePath)) === aggregate.payloadSha256, "portable aggregate OCI payload is missing or changed");
}

function packageImport({ compiled, outputRoot, oci = createOrasClient() }) {
  ensureSafeOutputTree(outputRoot);
  const payloadRoot = join(outputRoot, "oci", "payloads");
  mkdirSync(payloadRoot, { recursive: true });
  rejectSymlinks(outputRoot);
  const rows = [
    ...compiled.plan.spec.oci.catalogPackages.map((row) => ({ ...row, packageRole: "component-definition" })),
    ...compiled.plan.spec.oci.configReleases.map((row) => ({ ...row, packageRole: "effective-config-set" })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const published = [];
  for (const row of rows) {
    const payload = compiled.execution.componentPayloads.get(row.id) ?? compiled.execution.configPayloads.get(row.id);
    check(payload, `${row.id}: deterministic OCI payload is missing`);
    check(payload.sha256 === row.payloadSha256 && sha256(payload.text) === row.payloadSha256, `${row.id}: planned OCI payload digest drifted`);
    const filename = `${safeArtifactFilename(row.id)}-${row.payloadSha256}.json`;
    const path = join(payloadRoot, filename);
    writeFileSync(path, payload.text);
    const observation = publishExactOciArtifact(oci, {
      id: row.id,
      ref: row.plannedOCIRef,
      path,
      artifactType: OCI_ARTIFACT_TYPE,
      layerType: OCI_LAYER_TYPE,
      expectedLayerDigest: `sha256:${row.payloadSha256}`,
    });
    published.push({
      id: row.id,
      role: row.packageRole,
      ref: row.plannedOCIRef,
      payloadPath: relative(outputRoot, path).replaceAll("\\", "/"),
      payloadSha256: row.payloadSha256,
      manifestDigest: observation.manifestDigest,
      layerDigest: observation.layerDigest,
      artifactType: OCI_ARTIFACT_TYPE,
      layerType: OCI_LAYER_TYPE,
    });
  }
  const aggregate = buildPlatformOciIndex(compiled, published);
  const aggregateText = `${stableJson(aggregate)}\n`;
  const aggregateSha256 = sha256(aggregateText);
  const aggregatePath = join(payloadRoot, `platform-index-${aggregateSha256}.json`);
  writeFileSync(aggregatePath, aggregateText);
  const aggregateObservation = publishExactOciArtifact(oci, {
    id: "platform-index",
    ref: compiled.plan.spec.oci.aggregate.plannedOCIRef,
    path: aggregatePath,
    artifactType: OCI_INDEX_ARTIFACT_TYPE,
    layerType: OCI_INDEX_LAYER_TYPE,
    expectedLayerDigest: `sha256:${aggregateSha256}`,
  });
  const receipt = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraOCIPublicationReceipt",
    metadata: { name: compiled.plan.metadata.name },
    spec: {
      platformDigest: compiled.lock.spec.platformDigest,
      publicationPolicy: "exclusive-single-writer-required; content-addressed-tag; reuse one exact observed layer or refuse an observed conflict",
      members: published,
      aggregate: {
        ref: compiled.plan.spec.oci.aggregate.plannedOCIRef,
        payloadPath: relative(outputRoot, aggregatePath).replaceAll("\\", "/"),
        payloadSha256: aggregateSha256,
        manifestDigest: aggregateObservation.manifestDigest,
        layerDigest: aggregateObservation.layerDigest,
        artifactType: OCI_INDEX_ARTIFACT_TYPE,
        layerType: OCI_INDEX_LAYER_TYPE,
        members: published.map((row) => ({ id: row.id, manifestDigest: row.manifestDigest, layerDigest: row.layerDigest })),
      },
    },
    status: {
      result: "pass",
      exactRemoteLayersVerified: published.length + 1,
      componentDefinitionPackages: published.filter((row) => row.role === "component-definition").length,
      effectiveConfigSetPackages: published.filter((row) => row.role === "effective-config-set").length,
      targetFactsIncluded: false,
    },
  };
  writeJsonExact(join(outputRoot, "oci-publication-receipt.json"), receipt);
  return receipt;
}

function buildPlatformOciIndex(compiled, published) {
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraPlatformOCIIndex",
    metadata: { name: compiled.plan.metadata.name },
    spec: {
      platformDigest: compiled.lock.spec.platformDigest,
      source: compiled.lock.spec.source,
      importerMaterializationContract: importerMaterializationContract(),
      importerMaterializationContractSHA256: importerMaterializationContractSHA256(),
      members: published.map((row) => ({
        id: row.id,
        role: row.role,
        ref: row.ref,
        payloadSha256: row.payloadSha256,
        manifestDigest: row.manifestDigest,
        layerDigest: row.layerDigest,
      })),
      controlPayloads: [
        controlPayloadRow("platform-lock", "AppConfig/YAML", compiled.lockText),
        controlPayloadRow("kubara-config", "AppConfig/YAML", compiled.execution.kubaraConfigText),
        controlPayloadRow("wiring-ledger", "AppConfig/JSON", compiled.execution.wiringGraphText),
        controlPayloadRow("argo-cd-runtime", "AppConfig/YAML", deliveryRuntimeDefinitionText()),
      ],
      deliveryTemplateContract: {
        source: "ConfigHub Space release OCI",
        destination: "request-bound cluster-local Argo root",
        applicationTemplate: "generated during apply from the external destination binding; never embedded in this target-neutral index",
      },
      flattenedFleetBundle: false,
      targetFactsIncluded: false,
      destinationBindingsIncluded: false,
    },
  };
}

function publishExactOciArtifact(oci, expected) {
  const existing = oci.inspect(expected.ref);
  if (existing) {
    assertExactOciArtifact(existing, expected);
    return { ...existing, layerDigest: existing.layers[0].digest };
  }
  oci.push(expected);
  const published = oci.inspect(expected.ref);
  check(published, `${expected.ref}: OCI artifact disappeared immediately after publication`);
  assertExactOciArtifact(published, expected);
  return { ...published, layerDigest: published.layers[0].digest };
}

function assertExactOciArtifact(actual, expected) {
  check(actual.artifactType === expected.artifactType, `${expected.ref}: existing OCI artifact type ${actual.artifactType || "missing"} differs from ${expected.artifactType}; refusing overwrite`);
  check(actual.layers.length === 1, `${expected.ref}: expected exactly one OCI payload layer, found ${actual.layers.length}; refusing overwrite`);
  const layer = actual.layers[0];
  check(layer.mediaType === expected.layerType, `${expected.ref}: existing OCI layer media type ${layer.mediaType || "missing"} differs from ${expected.layerType}; refusing overwrite`);
  check(layer.digest === expected.expectedLayerDigest, `${expected.ref}: existing OCI layer ${layer.digest || "missing"} differs from ${expected.expectedLayerDigest}; refusing overwrite`);
  check(layer.size === readFileSync(expected.path).length, `${expected.ref}: existing OCI layer size differs from the exact local payload; refusing overwrite`);
}

function createOrasClient() {
  return {
    inspect(ref) {
      const orasRef = toOrasRef(ref);
      const manifestResult = commandResult("oras", ["manifest", "fetch", orasRef]);
      if (!manifestResult.ok) {
        if (isNotFoundOutput(manifestResult.output)) return null;
        throw new Error(`${ref}: cannot safely inspect OCI ref; refusing publication\n${manifestResult.output}`);
      }
      let manifest;
      try { manifest = JSON.parse(manifestResult.output); } catch (error) { throw new Error(`${ref}: OCI manifest is not JSON: ${error.message}`); }
      const descriptorResult = commandResult("oras", ["manifest", "fetch", "--descriptor", orasRef]);
      check(descriptorResult.ok, `${ref}: failed to resolve OCI manifest descriptor: ${descriptorResult.output}`);
      let descriptor;
      try { descriptor = JSON.parse(descriptorResult.output); } catch (error) { throw new Error(`${ref}: OCI descriptor is not JSON: ${error.message}`); }
      check(/^sha256:[0-9a-f]{64}$/.test(descriptor.digest ?? ""), `${ref}: OCI manifest digest is missing or invalid`);
      return {
        manifestDigest: descriptor.digest,
        artifactType: manifest.artifactType ?? manifest.config?.mediaType ?? "",
        layers: manifest.layers ?? [],
      };
    },
    push(expected) {
      const result = commandResult("oras", [
        "push", "--no-tty", "--format", "json",
        "--artifact-type", expected.artifactType,
        toOrasRef(expected.ref),
        `${basename(expected.path)}:${expected.layerType}`,
      ], { cwd: dirname(expected.path) });
      check(result.ok, `${expected.ref}: ORAS push failed\n${result.output}`);
    },
    fetch(ref, layerDigest, outputPath) {
      const repository = orasRepository(toOrasRef(ref));
      const result = commandResult("oras", ["blob", "fetch", "--output", outputPath, `${repository}@${layerDigest}`]);
      check(result.ok, `${ref}@${layerDigest}: failed to fetch exact OCI layer\n${result.output}`);
    },
  };
}

function toOrasRef(ref) {
  check(/^oci:\/\//.test(ref), `OCI ref must begin oci://, got ${ref}`);
  return ref.replace(/^oci:\/\//, "");
}

function orasRepository(ref) {
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  check(colon > lastSlash, `OCI ref must contain an exact tag: ${ref}`);
  return ref.slice(0, colon);
}

function safeArtifactFilename(value) {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function writeJsonExact(path, value) {
  if (existsSync(path)) check(!lstatSync(path).isSymbolicLink(), `${path}: refusing to replace a symbolic link`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function prepareImmutableApplyReceiptEvidencePath({ outputRoot, path }) {
  const canonical = join(outputRoot, "apply-receipt.json");
  check(isWithin(path, outputRoot), "--receipt-output must resolve inside the destination-bound --output directory");
  check(path !== canonical, "--receipt-output must be an immutable snapshot path, not the mutable canonical apply-receipt.json");
  mkdirSync(dirname(path), { recursive: true });
  ensureSafeOutputTree(outputRoot);
  if (existsSync(path)) check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "--receipt-output must be a real file, not a symbolic link");
  return path;
}

function writeImmutableApplyReceiptEvidence(path, receipt) {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path)) {
    check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${path}: immutable apply receipt evidence must be a real file`);
    check(readFileSync(path, "utf8") === text, `${path}: refusing to overwrite different immutable apply receipt evidence`);
    return;
  }
  writeJsonExact(path, receipt);
}

function controlPayloadRow(id, toolchain, text) {
  return {
    id,
    toolchain,
    sha256: sha256(text),
    size: Buffer.byteLength(text),
    contentBase64: Buffer.from(text).toString("base64"),
  };
}

function platformDeliveryApplicationTemplate() {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: "${SOURCE_SPACE}", namespace: "argocd" },
    spec: {
      project: "default",
      source: {
        repoURL: "${SPACE_RELEASE_OCI_BASE}/${SOURCE_SPACE}",
        targetRevision: "${SOURCE_MANIFEST_DIGEST}",
        path: ".",
      },
      destination: {
        server: "https://kubernetes.default.svc",
        namespace: "${DESTINATION_NAMESPACE}",
      },
      syncPolicy: {
        syncOptions: [
          "CreateNamespace=false",
          "PruneLast=true",
          "FailOnSharedResource=true",
          "RespectIgnoreDifferences=true",
          "ApplyOutOfSyncOnly=true",
        ],
        retry: { limit: 5, backoff: { duration: "5s", factor: 2, maxDuration: "1m" } },
      },
    },
  };
}

function spaceReleaseOCIRef(base, sourceSpace) {
  validateOCIRepositoryBase(base, "Space-release OCI base");
  checkSlug(sourceSpace, "Space-release source Space");
  return `${base}/${sourceSpace}`;
}

function platformDeliveryApplication(spaceReleaseOCIBase, sourceSpace, destinationNamespace, manifestDigest) {
  validateOCIRepositoryBase(spaceReleaseOCIBase, "platform delivery Space-release OCI base");
  checkSlug(sourceSpace, "platform delivery source Space");
  checkSlug(destinationNamespace, `${sourceSpace} delivery destination namespace`);
  check(/^sha256:[0-9a-f]{64}$/.test(manifestDigest ?? ""), `${sourceSpace} delivery requires an exact source release manifest digest`);
  const application = platformDeliveryApplicationTemplate();
  application.metadata.name = sourceSpace;
  application.spec.source.repoURL = spaceReleaseOCIRef(spaceReleaseOCIBase, sourceSpace);
  application.spec.source.targetRevision = manifestDigest;
  application.spec.destination.namespace = destinationNamespace;
  return application;
}

function autoGeneratedPlatformDeliveryApplication(spaceReleaseOCIBase, sourceSpace, destinationNamespace) {
  validateOCIRepositoryBase(spaceReleaseOCIBase, "auto-generated platform delivery Space-release OCI base");
  checkSlug(sourceSpace, "auto-generated platform delivery source Space");
  checkSlug(destinationNamespace, `${sourceSpace} auto-generated delivery destination namespace`);
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: sourceSpace, namespace: "argocd" },
    spec: {
      project: "default",
      source: { repoURL: spaceReleaseOCIRef(spaceReleaseOCIBase, sourceSpace), targetRevision: "latest", path: "." },
      destination: { server: "https://kubernetes.default.svc", namespace: destinationNamespace },
      syncPolicy: { automated: { prune: true, selfHeal: true, allowEmpty: true } },
    },
  };
}

function importerMaterializationContract() {
  return {
    version: IMPORTER_CONTRACT_VERSION,
    packageMedia: {
      memberArtifactType: OCI_ARTIFACT_TYPE,
      memberLayerType: OCI_LAYER_TYPE,
      indexArtifactType: OCI_INDEX_ARTIFACT_TYPE,
      indexLayerType: OCI_INDEX_LAYER_TYPE,
      layout: "one-immutable-package-per-component-or-config-set-plus-target-neutral-index",
    },
    roles: [
      "PlatformControl", "ComponentDefinition", "ComponentInstance", "DeliveryDefinition", "DeliveryInstance",
      "DeliveryApplication", "WiringDefinition", "WiringInstance", "ClusterTarget",
    ],
    lineage: {
      definitionToInstance: { linkType: "UpgradeUnit", autoUpdate: false },
      needsProvides: { linkType: "NeedsProvides", autoUpdate: false, makeCurrent: true },
    },
    delivery: {
      applicationTemplate: platformDeliveryApplicationTemplate(),
      releaseOrder: ["component-source-spaces", "exact-digest-delivery-applications", "delivery-root"],
      releaseAuthority: "exact-source-release-manifest-digest",
      mutableLatestAcceptedAsAuthority: false,
      automatedSyncAccepted: false,
      clusterConvergenceClaimedByImporter: false,
      clusterReconcilerPrune: true,
      importerDeleteOperations: [],
    },
    destinationFacts: {
      includedInGitOrOCI: false,
      exactBindingRequiredBeforeApply: true,
    },
  };
}

function importerMaterializationContractSHA256() {
  return `sha256:${sha256(stableJson(importerMaterializationContract()))}`;
}

function applyImport({ compiled, outputRoot, context, targetFactsPath, previousApplyReceiptPath = null, oci = createOrasClient(), hub = null }) {
  check(context === compiled.execution.request.spec.destination.context, `--context ${context} does not equal request-pinned context ${compiled.execution.request.spec.destination.context}`);
  const consumed = consumePackagedImport({ compiled, outputRoot, oci });
  const attestation = validateTargetFactAttestation({ compiled, path: targetFactsPath });
  const client = hub ?? createCubClient(context, compiled.execution.request.spec.destination);
  client.request = compiled.execution.request;
  client.assertExactCoordinate();
  client.assertVersion();
  const expected = buildApplyPayloads(compiled, consumed);
  addObservedDeliveryApplicationPayloads({ compiled, client, expected });
  const transition = prepareContentTransition({ compiled, client, expected, previousApplyReceiptPath });
  assertApplyReceiptOutputReady({
    outputRoot,
    compiled,
    context,
    packageReceiptSHA256: sha256(`${JSON.stringify(consumed.receipt, null, 2)}\n`),
    targetFactAttestationSHA256: sha256(stableJson(attestation)),
  });
  preflightOrganization({ compiled, client, expected, transition });

  const state = { actions: [], releases: new Map() };
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-import-apply-"));
  try {
    const payloadFiles = materializeApplyPayloads(tempRoot, expected);
    for (const targetSpace of compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding)) {
      ensureBoundTargetSpaceMetadata(client, targetSpace, state);
    }
    for (const metadataPlan of pinnedDeliveryMetadataPlans(compiled)) ensurePinnedDeliveryMetadata(client, metadataPlan, state);
    for (const clusterPlan of compiled.plan.spec.configHub.deliveryInfrastructure.clusters) {
      const release = ensurePublishedRelease(client, clusterPlan.argobot.space, state);
      state.releases.set(clusterPlan.argobot.space, release);
    }
    const managedSpaces = compiled.plan.spec.configHub.spaces.filter((row) => !row.externalBinding);
    const definitionAndControl = managedSpaces.filter((row) => row.role !== "ComponentInstance" && row.role !== "DeliveryInstance");
    for (const space of definitionAndControl) ensureManagedSpace(client, space, state);
    for (const unitPlan of compiled.plan.spec.configHub.units.filter((row) => definitionAndControl.some((space) => space.slug === row.space))) {
      ensureManagedUnit(client, unitPlan, expected.get(`${unitPlan.space}/${unitPlan.slug}`), payloadFiles, state, { transition });
    }

    const instanceSpaces = managedSpaces.filter((row) => ["ComponentInstance", "DeliveryInstance"].includes(row.role));
    for (const space of instanceSpaces) {
      const unitPlan = compiled.plan.spec.configHub.units.find((row) => row.space === space.slug && row.upstream);
      check(unitPlan, `${space.slug}: instance Unit plan is missing`);
      ensureVariantInstance(client, compiled, space, unitPlan, state);
      ensureManagedSpace(client, space, state, { mustExist: true });
      ensureManagedUnit(client, unitPlan, expected.get(`${unitPlan.space}/${unitPlan.slug}`), payloadFiles, state, { allowCanonicalTransition: true, transition });
    }

    for (const linkPlan of compiled.plan.spec.configHub.links) ensureManagedLink(client, linkPlan, state, transition);
    for (const releasePlan of compiled.plan.spec.oci.configReleases) {
      const release = ensurePublishedRelease(client, releasePlan.releaseSpace, state);
      state.releases.set(releasePlan.releaseSpace, release);
    }
    for (const applicationPlan of compiled.plan.spec.configHub.deliveryApplications) {
      const release = state.releases.get(applicationPlan.sourceSpace);
      check(release, `${applicationPlan.sourceSpace}: exact source release is missing before delivery Application materialization`);
      const ref = `${applicationPlan.space}/${applicationPlan.slug}`;
      const payload = deliveryApplicationPayload(applicationPlan, release);
      expected.set(ref, payload);
      const path = join(tempRoot, `${safeArtifactFilename(ref)}-${sha256(payload.text)}.yaml`);
      writeFileSync(path, payload.text);
      payloadFiles.set(ref, path);
      ensurePlatformDeliveryApplication(client, applicationPlan, payload, payloadFiles, state, transition);
    }
    for (const appsSpace of [...new Set(compiled.plan.spec.configHub.deliveryApplications.map((row) => row.space))].sort()) {
      const clusterPlan = compiled.plan.spec.configHub.deliveryInfrastructure.clusters.find((row) => row.appsSpace === appsSpace);
      assertPreservedWorkloadHeads(client, clusterPlan);
      const release = ensurePublishedRelease(client, appsSpace, state);
      state.releases.set(appsSpace, release);
    }
    const observation = verifyAppliedImport({ compiled, client, expected, consumed, attestation, transition });
    const receipt = updateApplyReceipt({ compiled, outputRoot, context, attestation, state, observation, consumed, transition });
    return receipt;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertApplyReceiptOutputReady({ outputRoot, compiled, context, packageReceiptSHA256, targetFactAttestationSHA256 }) {
  const path = join(outputRoot, "apply-receipt.json");
  if (!existsSync(path)) return;
  check(!lstatSync(path).isSymbolicLink(), "existing apply receipt must not be a symbolic link");
  const existing = readJson(path);
  check(existing?.spec?.platformDigest === compiled.lock.spec.platformDigest, "--output contains an apply receipt for another platform digest; preserve it as the immutable --previous-apply-receipt and use a fresh output directory for the transition");
  validatePriorApplyReceipt({
    previous: existing,
    compiled,
    context,
    observation: existing.spec.observation,
    packageReceiptSHA256,
    targetFactAttestationSHA256,
    requireObservationMatch: false,
  });
}

function prepareContentTransition({ compiled, client, expected, previousApplyReceiptPath }) {
  const requested = compiled.execution.request.spec.transition ?? null;
  check(Boolean(requested) === Boolean(previousApplyReceiptPath), requested
    ? "spec.transition requires --previous-apply-receipt"
    : "--previous-apply-receipt requires an exact spec.transition block");
  if (!requested) return null;
  check(existsSync(previousApplyReceiptPath), `previous apply receipt does not exist: ${previousApplyReceiptPath}`);
  check(!lstatSync(previousApplyReceiptPath).isSymbolicLink(), "previous apply receipt must not be a symbolic link");
  const bytes = readFileSync(previousApplyReceiptPath);
  check(`sha256:${sha256(bytes)}` === requested.previousApplyReceiptSHA256, "previous apply receipt bytes differ from spec.transition.previousApplyReceiptSHA256");
  let previous;
  try { previous = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`previous apply receipt is invalid JSON: ${error.message}`); }
  validatePassingTransitionReceipt(previous);
  check(previous.metadata.name === compiled.plan.metadata.name, "previous apply receipt import name differs");
  check(previous.spec.platformDigest === requested.fromPlatformDigest, "previous apply receipt platform digest differs from spec.transition.fromPlatformDigest");
  check(previous.spec.bindingDigest === requested.fromBindingDigest, "previous apply receipt binding digest differs from spec.transition.fromBindingDigest");
  const destination = compiled.execution.request.spec.destination;
  const priorOrganization = previous.spec?.observation?.organization;
  check(priorOrganization?.name === destination.organization
    && priorOrganization.externalID === destination.organizationExternalID
    && priorOrganization.organizationID === destination.organizationID
    && priorOrganization.serverURL === destination.serverURL
    && priorOrganization.context === destination.context, "previous apply receipt Organization coordinate differs from the selected destination");
  const transition = {
    importName: compiled.plan.metadata.name,
    fromPlatformDigest: requested.fromPlatformDigest,
    fromBindingDigest: requested.fromBindingDigest,
    previousApplyReceiptSHA256: requested.previousApplyReceiptSHA256,
    policy: requested.policy,
    previous,
    priorSpaces: new Map((previous.spec.observation?.spaces ?? []).map((row) => [row.slug, row])),
    priorUnits: new Map([
      ...(previous.spec.observation?.units ?? []),
      ...(previous.spec.observation?.deliveryApplications ?? []),
    ].map((row) => [row.ref, row])),
    priorLinks: new Map((previous.spec.observation?.links ?? []).map((row) => [row.ref, row])),
  };
  assertAdditiveTransition(compiled, transition);
  assertExactPriorOrCurrentTransitionState({ compiled, client, expected, transition });
  return transition;
}

function validatePassingTransitionReceipt(previous) {
  checkExactKeys(previous, ["apiVersion", "kind", "metadata", "spec", "status"], "previous apply receipt");
  check(previous.apiVersion === "import.confighub.com/v1alpha1" && previous.kind === "KubaraConfigHubApplyReceipt", "previous apply receipt apiVersion/kind is invalid");
  checkExactKeys(previous.metadata, ["name"], "previous apply receipt metadata");
  checkSlug(previous.metadata.name, "previous apply receipt metadata.name");
  checkExactKeys(previous.spec, ["platformDigest", "bindingDigest", "transitionAuthority", "organization", "packageReceiptSHA256", "targetFactAttestationSHA256", "runs", "observation", "claimBoundary"], "previous apply receipt spec");
  check(/^sha256:[0-9a-f]{64}$/.test(previous.spec.platformDigest ?? "") && /^sha256:[0-9a-f]{64}$/.test(previous.spec.bindingDigest ?? ""), "previous apply receipt platform/binding digest is invalid");
  check(/^([0-9a-f]{64})$/.test(previous.spec.packageReceiptSHA256 ?? "") && /^([0-9a-f]{64})$/.test(previous.spec.targetFactAttestationSHA256 ?? ""), "previous apply receipt package/attestation hash is invalid");
  if (previous.spec.transitionAuthority !== null) {
    checkExactKeys(previous.spec.transitionAuthority, ["fromPlatformDigest", "fromBindingDigest", "previousApplyReceiptSHA256", "policy"], "previous apply receipt transition authority");
    check(/^sha256:[0-9a-f]{64}$/.test(previous.spec.transitionAuthority.fromPlatformDigest ?? "") && /^sha256:[0-9a-f]{64}$/.test(previous.spec.transitionAuthority.fromBindingDigest ?? "") && /^sha256:[0-9a-f]{64}$/.test(previous.spec.transitionAuthority.previousApplyReceiptSHA256 ?? ""), "previous apply receipt transition authority digests are invalid");
    check(previous.spec.transitionAuthority.policy === "additive-confighub-topology-importer-no-delete-argo-prune-disclosed", "previous apply receipt transition authority policy is invalid");
  }
  checkExactKeys(previous.status, ["result", "lastActionCount", "secondRunZeroActions", "exactPackageReuseOrRefuse", "organizationProtection", "targetBindingsExternalToGitAndOCI", "localReceiptCryptographicProof"], "previous apply receipt status");
  check(previous.status.result === "pass" && previous.status.secondRunZeroActions === true && previous.status.lastActionCount === 0, "previous apply receipt must be a passing second-zero-action receipt");
  check(previous.status.exactPackageReuseOrRefuse === "pass" && previous.status.organizationProtection === "pass" && previous.status.targetBindingsExternalToGitAndOCI === "pass" && previous.status.localReceiptCryptographicProof === false, "previous apply receipt status gates differ");
  check(Array.isArray(previous.spec.runs) && previous.spec.runs.length === 2, "previous apply receipt must contain exactly the accepted two runs");
  for (const [index, run] of previous.spec.runs.entries()) {
    checkExactKeys(run, ["number", "actionCount", "actions", "packageReceiptSHA256", "targetFactAttestationSHA256", "observationSHA256", "runDigest"], `previous apply receipt run ${index + 1}`);
    check(run.number === index + 1 && Array.isArray(run.actions) && run.actionCount === run.actions.length, `previous apply receipt run ${index + 1} is malformed`);
    check(run.packageReceiptSHA256 === previous.spec.packageReceiptSHA256 && run.targetFactAttestationSHA256 === previous.spec.targetFactAttestationSHA256, `previous apply receipt run ${index + 1} is not bound to its spec package/attestation`);
    for (const action of run.actions) checkObjectKeys(action, ["type", "ref", "detail"], ["type", "ref"], `previous apply receipt run ${index + 1} action`);
    const unsigned = { number: run.number, actionCount: run.actionCount, actions: run.actions, packageReceiptSHA256: run.packageReceiptSHA256, targetFactAttestationSHA256: run.targetFactAttestationSHA256, observationSHA256: run.observationSHA256 };
    check(run.runDigest === `sha256:${sha256(stableJson(unsigned))}`, `previous apply receipt run ${index + 1} digest is invalid`);
  }
  const last = previous.spec.runs.at(-1);
  check(last.actionCount === 0 && last.observationSHA256 === sha256(stableJson(previous.spec.observation)), "previous apply receipt final observation binding is invalid");
  const currentClaimBoundary = stableJson(previous.spec.claimBoundary) === stableJson(applyReceiptClaimBoundary());
  const legacyV1ClaimBoundary = stableJson(previous.spec.claimBoundary) === stableJson(applyReceiptClaimBoundaryV1());
  check(Array.isArray(previous.spec.claimBoundary) && (currentClaimBoundary || legacyV1ClaimBoundary), "previous apply receipt claim boundary differs");
  const observation = previous.spec.observation;
  checkObjectKeys(observation, ["targetSpaces", "deliveryInfrastructureComponents", "organization", "spaces", "units", "links", "releases", "deliveryApplications", "deliveryRootReleases", "argobotReleases", "preservedWorkloadApplications", "targets", "packages", "platformIndex", "delivery", "guiIdentity"], ["targetSpaces", "deliveryInfrastructureComponents", "organization", "spaces", "units", "links", "releases", "deliveryApplications", "deliveryRootReleases", "argobotReleases", "preservedWorkloadApplications", "targets", "packages", "platformIndex", "delivery", "guiIdentity"], "previous apply receipt observation");
  for (const key of ["targetSpaces", "deliveryInfrastructureComponents", "spaces", "units", "links", "releases", "deliveryApplications", "deliveryRootReleases", "argobotReleases", "preservedWorkloadApplications", "targets", "packages"]) check(Array.isArray(observation[key]), `previous apply receipt observation.${key} must be an array`);
  checkExactKeys(previous.spec.organization, ["context", "name", "externalID", "organizationID", "serverURL"], "previous apply receipt spec.organization");
  check(stableJson(previous.spec.organization) === stableJson(observation.organization), "previous apply receipt spec/observation Organization differs");
  check(observation.targetSpaces.length > 0 && observation.spaces.length > 0 && observation.units.length > 0 && observation.links.length > 0 && observation.targets.length > 0, "previous apply receipt required transition inventories must be nonempty");
  for (const row of observation.targetSpaces) checkObjectKeys(row, ["slug", "spaceID", "targetID", "lane"], ["slug", "spaceID", "targetID", "lane"], "previous target Space observation");
  for (const row of observation.targets) checkObjectKeys(row, ["cluster", "space", "spaceID", "target", "targetID", "delivery"], ["cluster", "space", "spaceID", "target", "targetID", "delivery"], "previous target binding observation");
  check(observation.targetSpaces.length === observation.targets.length, "previous apply receipt target Space/binding inventories differ");
  const priorTargetsBySpace = new Map(observation.targets.map((row) => [row.space, row]));
  for (const row of observation.targetSpaces) {
    const target = priorTargetsBySpace.get(row.slug);
    check(target?.spaceID === row.spaceID && target.targetID === row.targetID, `${row.slug}: previous target Space and target binding identities differ`);
  }
  for (const row of observation.spaces) checkObjectKeys(row, ["slug", "spaceID", "role"], ["slug", "spaceID", "role"], "previous managed Space observation");
  for (const row of observation.units) checkObjectKeys(row, ["ref", "unitID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum", "targetID", "upstreamUnitID"], ["ref", "unitID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum", "targetID", "upstreamUnitID"], "previous managed Unit observation");
  for (const row of observation.deliveryApplications) checkObjectKeys(
    row,
    ["ref", "unitID", "sourceSpace", "sourceReleaseManifestDigest", "automatedSync", "targetID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum"],
    currentClaimBoundary
      ? ["ref", "unitID", "sourceSpace", "sourceReleaseManifestDigest", "automatedSync", "targetID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum"]
      : ["ref", "unitID", "sourceSpace", "targetID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum"],
    "previous delivery Application observation",
  );
  for (const row of observation.links) checkObjectKeys(row, ["ref", "linkID", "updateType", "autoUpdate", "fromUnitID", "toUnitID", "toSpaceID", "ownedLabels", "ownedAnnotations"], ["ref", "linkID", "updateType", "autoUpdate", "fromUnitID", "toUnitID", "toSpaceID", "ownedLabels", "ownedAnnotations"], "previous Link observation");
  for (const row of observation.preservedWorkloadApplications) checkObjectKeys(row, ["ref", "unitID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum", "sourceSpace", "sourceUnitID", "sourceReleaseManifestDigest"], ["ref", "unitID", "dataHash", "dataSHA256", "headRevisionNum", "lastAppliedRevisionNum", "sourceSpace", "sourceUnitID", "sourceReleaseManifestDigest"], "previous preserved workload observation");
  for (const [label, rows, key] of [["target Space", observation.targetSpaces, "slug"], ["target binding", observation.targets, "cluster"], ["Space", observation.spaces, "slug"], ["Unit", observation.units, "ref"], ["Link", observation.links, "ref"], ["delivery Application", observation.deliveryApplications, "ref"], ["preserved workload", observation.preservedWorkloadApplications, "ref"]]) {
    const values = rows.map((row) => row[key]);
    check(values.every(Boolean) && new Set(values).size === values.length, `previous apply receipt contains duplicate or missing ${label} observations`);
  }
}

function assertAdditiveTransition(compiled, transition) {
  const observation = transition.previous.spec.observation ?? {};
  const currentSpaces = new Set(compiled.plan.spec.configHub.spaces.filter((row) => !row.externalBinding).map((row) => row.slug));
  const currentUnits = new Set(compiled.plan.spec.configHub.units.map((row) => `${row.space}/${row.slug}`));
  const currentLinks = new Set(compiled.plan.spec.configHub.links.map((row) => `${row.space}/${row.slug}`));
  const currentApplications = new Set(compiled.plan.spec.configHub.deliveryApplications.map((row) => `${row.space}/${row.slug}`));
  const currentWorkloads = new Set(Object.values(compiled.execution.request.spec.targets).flatMap((target) => (target.delivery.workloadApplications ?? []).map((row) => `${target.delivery.appsSpace}/${row.unit}`)));
  for (const row of observation.spaces ?? []) check(currentSpaces.has(row.slug), `${row.slug}: additive transition cannot remove or rename a previously managed Space`);
  for (const row of observation.units ?? []) check(currentUnits.has(row.ref), `${row.ref}: additive transition cannot remove or rename a previously managed Unit`);
  for (const row of observation.links ?? []) check(currentLinks.has(row.ref), `${row.ref}: additive transition cannot remove or rename a previously managed Link`);
  for (const row of observation.deliveryApplications ?? []) check(currentApplications.has(row.ref), `${row.ref}: additive transition cannot remove or rename a platform delivery Application`);
  for (const row of observation.preservedWorkloadApplications ?? []) check(currentWorkloads.has(row.ref), `${row.ref}: additive transition cannot silently drop a preserved workload Application pin`);
  const currentUnitPlans = new Map(compiled.plan.spec.configHub.units.map((row) => [`${row.space}/${row.slug}`, row]));
  const priorUnits = new Map([...(observation.units ?? []), ...(observation.deliveryApplications ?? [])].map((row) => [row.ref, row]));
  for (const prior of observation.units ?? []) {
    const plan = currentUnitPlans.get(prior.ref);
    const expectedTargetID = plan.target ? requestTargetByRef(compiled.execution.request, plan.target).targetID : null;
    const expectedUpstreamID = plan.upstream ? priorUnits.get(plan.upstream)?.unitID : null;
    check((prior.targetID ?? null) === expectedTargetID, `${prior.ref}: additive transition cannot rebind a prior Unit target`);
    check((prior.upstreamUnitID ?? null) === (expectedUpstreamID ?? null), `${prior.ref}: additive transition cannot rebind prior definition/instance lineage`);
  }
  const currentApplicationPlans = new Map(compiled.plan.spec.configHub.deliveryApplications.map((row) => [`${row.space}/${row.slug}`, row]));
  for (const prior of observation.deliveryApplications ?? []) {
    const plan = currentApplicationPlans.get(prior.ref);
    check(prior.targetID === requestTargetByRef(compiled.execution.request, plan.target).targetID, `${prior.ref}: additive transition cannot rebind a platform delivery Application target`);
  }
  const currentLinkPlans = new Map(compiled.plan.spec.configHub.links.map((row) => [`${row.space}/${row.slug}`, row]));
  const priorSpaces = new Map((observation.spaces ?? []).map((row) => [row.slug, row]));
  for (const prior of observation.links ?? []) {
    const plan = currentLinkPlans.get(prior.ref);
    const fromID = priorUnits.get(`${plan.space}/${plan.fromUnit}`)?.unitID;
    const toID = priorUnits.get(`${plan.toSpace}/${plan.toUnit}`)?.unitID;
    const toSpaceID = priorSpaces.get(plan.toSpace)?.spaceID;
    check(prior.fromUnitID === fromID && prior.toUnitID === toID && prior.toSpaceID === toSpaceID && prior.updateType === plan.updateType, `${prior.ref}: additive transition cannot rewire prior Link endpoints or semantics`);
  }
  const currentTargets = new Map(compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding).map((row) => [row.slug, row]));
  for (const row of observation.targetSpaces ?? []) {
    const current = currentTargets.get(row.slug);
    check(current?.expectedSpaceID === row.spaceID && current.expectedTargetID === row.targetID, `${row.slug}: additive transition cannot rebind a prior cluster target identity`);
  }
}

function assertExactPriorOrCurrentTransitionState({ compiled, client, expected, transition }) {
  const observation = transition.previous.spec.observation;
  for (const row of observation.spaces ?? []) {
    const live = client.getSpace(row.slug);
    check(live?.SpaceID === row.spaceID, `${row.slug}: live Space identity differs from the prior passing receipt`);
    check(isImporterOwned(live, compiled) || isPriorTransitionOwned(live, transition, "space", row.slug), `${row.slug}: live Space ownership is neither exact prior nor exact current transition state`);
  }
  const unitPlans = new Map(compiled.plan.spec.configHub.units.map((row) => [`${row.space}/${row.slug}`, row]));
  const applicationPlans = new Map(compiled.plan.spec.configHub.deliveryApplications.map((row) => [`${row.space}/${row.slug}`, row]));
  for (const [ref, prior] of transition.priorUnits) {
    const separator = ref.indexOf("/");
    const space = ref.slice(0, separator);
    const slug = ref.slice(separator + 1);
    const live = client.getUnit(space, slug);
    check(live?.UnitID === prior.unitID, `${ref}: live Unit identity differs from the prior passing receipt`);
    const data = client.unitData(space, slug);
    const plan = unitPlans.get(ref) ?? applicationPlans.get(ref);
    const payload = expected.get(ref);
    check(plan && payload, `${ref}: current additive transition plan/payload is missing`);
    const toolchain = unitPlans.has(ref) ? plan.toolchain : "Kubernetes/YAML";
    const priorExact = transitionAllowsPriorUnit(transition, ref, live, data);
    const currentExact = sameUnitData(toolchain, data, payload.text)
      && (live.TargetID ?? null) === (prior.targetID ?? null)
      && (live.UpstreamUnitID ?? null) === (prior.upstreamUnitID ?? null)
      && Number(live.HeadRevisionNum ?? 0) >= Number(prior.headRevisionNum ?? 0)
      && Number(live.LastReleasedRevisionNum ?? 0) >= Number(prior.lastAppliedRevisionNum ?? 0)
      && Number(live.LastReleasedRevisionNum ?? 0) <= Number(live.HeadRevisionNum ?? 0);
    check(priorExact || currentExact, `${ref}: live Unit is neither exact prior receipt state nor exact current transition payload`);
    check(isImporterOwned(live, compiled) || isPriorTransitionOwned(live, transition, "unit", ref), `${ref}: live Unit ownership is neither exact prior nor exact current transition state`);
  }
  const currentLinkPlans = new Map(compiled.plan.spec.configHub.links.map((row) => [`${row.space}/${row.slug}`, row]));
  for (const prior of observation.links ?? []) {
    const separator = prior.ref.indexOf("/");
    const space = prior.ref.slice(0, separator);
    const slug = prior.ref.slice(separator + 1);
    const live = client.listLinks(space).find((row) => row.Slug === slug);
    check(live?.LinkID === prior.linkID
      && live.UpdateType === prior.updateType
      && Boolean(live.AutoUpdate) === prior.autoUpdate
      && live.FromUnitID === prior.fromUnitID
      && live.ToUnitID === prior.toUnitID
      && live.ToSpaceID === prior.toSpaceID, `${prior.ref}: live Link differs from the prior passing receipt`);
    const currentPlan = currentLinkPlans.get(prior.ref);
    const currentAnnotations = {
      ...(currentPlan?.annotations ?? {}),
      ...(currentPlan?.reasons?.length ? { "import.confighub.com/reason": currentPlan.reasons.join(";").replaceAll(",", ";").replaceAll("=", ":") } : {}),
    };
    const priorMetadata = stableJson(ownedProjection(live.Labels, OWNED_LINK_LABELS)) === stableJson(prior.ownedLabels)
      && stableJson(ownedProjection(live.Annotations, OWNED_ANNOTATIONS)) === stableJson(prior.ownedAnnotations);
    const currentMetadata = currentPlan
      && stableJson(ownedProjection(live.Labels, OWNED_LINK_LABELS)) === stableJson(ownedProjection(currentPlan.labels, OWNED_LINK_LABELS))
      && stableJson(ownedProjection(live.Annotations, OWNED_ANNOTATIONS)) === stableJson(ownedProjection(currentAnnotations, OWNED_ANNOTATIONS));
    check(priorMetadata || currentMetadata, `${prior.ref}: live Link metadata is neither exact prior nor exact current transition state`);
    check(isImporterOwned(live, compiled) || isPriorTransitionOwned(live, transition, "link", prior.ref), `${prior.ref}: live Link ownership is neither exact prior nor exact current transition state`);
  }
}

function assertPreservedWorkloadHeads(client, clusterPlan) {
  check(clusterPlan, "delivery apps Space lacks a pinned cluster plan");
  for (const workload of clusterPlan.workloadApplications ?? []) {
    const unit = client.getUnit(clusterPlan.appsSpace, workload.unit);
    check(unit?.UnitID === workload.unitID && unit.DataHash === workload.dataHash && Number(unit.HeadRevisionNum ?? 0) === workload.headRevisionNum && Number(unit.LastReleasedRevisionNum ?? 0) === workload.headRevisionNum, `${clusterPlan.appsSpace}/${workload.unit}: refusing root publication with a changed or pending preserved workload head`);
  }
}

function consumePackagedImport({ compiled, outputRoot, oci }) {
  ensureSafeOutputTree(outputRoot);
  const receiptPath = join(outputRoot, "oci-publication-receipt.json");
  check(existsSync(receiptPath), `${receiptPath} is missing; publish with --package-portable and bind it, or use the compatibility --package path, before --apply`);
  const receipt = readJson(receiptPath);
  check(receipt?.kind === "KubaraOCIPublicationReceipt", "OCI publication receipt kind is invalid");
  check(receipt.spec?.platformDigest === compiled.lock.spec.platformDigest, "OCI publication receipt platform digest differs from this exact compile");
  check(receipt.status?.result === "pass", "OCI publication receipt is not a pass");
  const planned = [
    ...compiled.plan.spec.oci.catalogPackages.map((row) => ({ ...row, role: "component-definition" })),
    ...compiled.plan.spec.oci.configReleases.map((row) => ({ ...row, role: "effective-config-set" })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const received = [...(receipt.spec?.members ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  check(received.length === planned.length, `OCI publication receipt member count ${received.length} differs from planned ${planned.length}`);
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-import-pull-"));
  try {
    const payloads = new Map();
    for (let index = 0; index < planned.length; index += 1) {
      const plan = planned[index];
      const row = received[index];
      check(row.id === plan.id && row.role === plan.role, `OCI publication receipt member ${row.id ?? "missing"} does not match ${plan.id}`);
      check(row.ref === plan.plannedOCIRef, `${plan.id}: published OCI ref differs from plan`);
      check(row.payloadSha256 === plan.payloadSha256, `${plan.id}: published payload digest differs from plan`);
      check(row.layerDigest === `sha256:${plan.payloadSha256}`, `${plan.id}: receipt layer digest differs from exact payload`);
      check(/^sha256:[0-9a-f]{64}$/.test(row.manifestDigest ?? ""), `${plan.id}: receipt manifest digest is invalid`);
      const localPath = safeJoin(outputRoot, row.payloadPath);
      check(existsSync(localPath), `${plan.id}: packaged payload is missing at ${localPath}`);
      check(sha256(readFileSync(localPath)) === plan.payloadSha256, `${plan.id}: packaged payload file was modified`);
      const inspected = oci.inspect(row.ref);
      check(inspected, `${plan.id}: packaged OCI ref no longer exists`);
      assertExactOciArtifact(inspected, {
        ref: row.ref,
        path: localPath,
        artifactType: OCI_ARTIFACT_TYPE,
        layerType: OCI_LAYER_TYPE,
        expectedLayerDigest: row.layerDigest,
      });
      check(inspected.manifestDigest === row.manifestDigest, `${plan.id}: OCI manifest digest differs from the package receipt`);
      const pulledPath = join(tempRoot, `${index}.json`);
      oci.fetch(row.ref, row.layerDigest, pulledPath);
      check(readFileSync(pulledPath).equals(readFileSync(localPath)), `${plan.id}: pulled OCI payload differs byte-for-byte from the packaged payload`);
      let payload;
      try { payload = JSON.parse(readFileSync(pulledPath, "utf8")); } catch (error) { throw new Error(`${plan.id}: pulled OCI payload is invalid JSON: ${error.message}`); }
      payloads.set(plan.id, { row, payload, text: readFileSync(pulledPath, "utf8") });
    }
    const aggregateRow = receipt.spec?.aggregate ?? {};
    check(aggregateRow.ref === compiled.plan.spec.oci.aggregate.plannedOCIRef, "aggregate OCI ref differs from the exact plan");
    check(/^[0-9a-f]{64}$/.test(aggregateRow.payloadSha256 ?? ""), "aggregate payload digest is invalid");
    check(aggregateRow.layerDigest === `sha256:${aggregateRow.payloadSha256}`, "aggregate layer digest differs from its payload digest");
    check(/^sha256:[0-9a-f]{64}$/.test(aggregateRow.manifestDigest ?? ""), "aggregate manifest digest is invalid");
    const aggregatePath = safeJoin(outputRoot, aggregateRow.payloadPath);
    check(existsSync(aggregatePath) && sha256(readFileSync(aggregatePath)) === aggregateRow.payloadSha256, "aggregate payload file is missing or modified");
    const aggregateInspected = oci.inspect(aggregateRow.ref);
    check(aggregateInspected, "aggregate OCI ref no longer exists");
    assertExactOciArtifact(aggregateInspected, {
      ref: aggregateRow.ref,
      path: aggregatePath,
      artifactType: OCI_INDEX_ARTIFACT_TYPE,
      layerType: OCI_INDEX_LAYER_TYPE,
      expectedLayerDigest: aggregateRow.layerDigest,
    });
    check(aggregateInspected.manifestDigest === aggregateRow.manifestDigest, "aggregate OCI manifest digest differs from the package receipt");
    const pulledAggregatePath = join(tempRoot, "aggregate.json");
    oci.fetch(aggregateRow.ref, aggregateRow.layerDigest, pulledAggregatePath);
    check(readFileSync(pulledAggregatePath).equals(readFileSync(aggregatePath)), "pulled aggregate OCI payload differs byte-for-byte from the packaged payload");
    const aggregate = JSON.parse(readFileSync(pulledAggregatePath, "utf8"));
    check(aggregate.kind === "KubaraPlatformOCIIndex", "pulled aggregate OCI payload kind is invalid");
    check(aggregate.spec?.platformDigest === compiled.lock.spec.platformDigest, "pulled aggregate platform digest differs from the exact compile");
    const exactMembers = received.map((row) => ({ id: row.id, role: row.role, ref: row.ref, payloadSha256: row.payloadSha256, manifestDigest: row.manifestDigest, layerDigest: row.layerDigest }));
    check(stableJson(aggregate.spec?.members) === stableJson(exactMembers), "aggregate OCI index does not bind every exact component and config manifest/layer digest");
    const expectedAggregate = buildPlatformOciIndex(compiled, received);
    check(stableJson(aggregate) === stableJson(expectedAggregate), "aggregate OCI index differs from the deterministic compile; refusing control or delivery payload substitution");
    return { receipt, payloads, aggregate, aggregateText: readFileSync(pulledAggregatePath, "utf8") };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateTargetFactAttestation({ compiled, path }) {
  check(existsSync(path), `target-fact attestation does not exist: ${path}`);
  check(!lstatSync(path).isSymbolicLink(), `target-fact attestation must not be a symbolic link: ${path}`);
  const value = readYaml(path);
  check(value?.apiVersion === "import.confighub.com/v1alpha1" && value?.kind === "KubaraTargetFactAttestation", "target-fact attestation apiVersion/kind is invalid");
  checkExactKeys(value, ["apiVersion", "kind", "metadata", "spec"], "target-fact attestation");
  checkExactKeys(value.metadata, ["name"], "target-fact attestation metadata");
  checkExactKeys(value.spec, ["platformDigest", "bindingDigest", "organization", "bindings", "resolutions", "policy"], "target-fact attestation spec");
  checkExactKeys(value.spec?.organization, ["externalID", "organizationID"], "target-fact attestation organization");
  check(value.metadata?.name === compiled.plan.metadata.name, "target-fact attestation name differs from the import request");
  check(value.spec?.platformDigest === compiled.lock.spec.platformDigest, "target-fact attestation platform digest differs from the exact compile");
  check(value.spec?.bindingDigest === compiled.plan.spec.bindingDigest, "target-fact attestation binding digest differs from the exact destination request");
  check(value.spec?.organization?.externalID === compiled.execution.request.spec.destination.organizationExternalID, "target-fact attestation external organization ID differs");
  check(value.spec?.organization?.organizationID === compiled.execution.request.spec.destination.organizationID, "target-fact attestation Organization entity ID differs");
  const expectedBindings = compiled.targetFactsRequired.spec.bindings;
  const actualBindings = [...(value.spec?.bindings ?? [])].sort((left, right) => left.cluster.localeCompare(right.cluster));
  check(actualBindings.length === expectedBindings.length, "target-fact attestation binding inventory differs from the request");
  for (let index = 0; index < expectedBindings.length; index += 1) {
    const expected = expectedBindings[index];
    const actual = actualBindings[index];
    checkExactKeys(actual, ["cluster", "space", "spaceID", "target", "targetID", "delivery", "status"], `${expected.cluster} target-fact binding`);
    for (const key of ["cluster", "space", "spaceID", "target", "targetID"]) check(actual?.[key] === expected[key], `${expected.cluster}: target-fact binding ${key} differs from the request`);
    check(stableJson(actual.delivery) === stableJson(expected.delivery), `${expected.cluster}: target-fact delivery infrastructure binding differs from the request`);
    check(actual.status === "verified-present", `${expected.cluster}: binding status must be verified-present`);
  }
  const expectedResolutions = compiled.targetFactsRequired.spec.resolutions;
  const key = (row) => `${row.consumer}\0${row.fact}\0${row.sourceStatus}`;
  const actualResolutions = [...(value.spec?.resolutions ?? [])].sort((left, right) => key(left).localeCompare(key(right)));
  const sortedExpected = [...expectedResolutions].sort((left, right) => key(left).localeCompare(key(right)));
  check(actualResolutions.length === sortedExpected.length, "target-fact resolution inventory differs from the mechanically derived requirements");
  for (let index = 0; index < sortedExpected.length; index += 1) {
    const expected = sortedExpected[index];
    const actual = actualResolutions[index];
    checkExactKeys(actual, ["consumer", "fact", "sourceStatus", "status", "evidenceRef", "evidenceSHA256"], `${expected.consumer}/${expected.fact} target-fact resolution`);
    for (const field of ["consumer", "fact", "sourceStatus"]) check(actual?.[field] === expected[field], `${expected.consumer}/${expected.fact}: attested ${field} differs`);
    check(["satisfied", "not-applicable-reviewed"].includes(actual.status), `${expected.consumer}/${expected.fact}: status must be satisfied or not-applicable-reviewed`);
    check(typeof actual.evidenceRef === "string" && actual.evidenceRef.length > 3 && !/[<>]/.test(actual.evidenceRef), `${expected.consumer}/${expected.fact}: external evidenceRef is missing or still a placeholder`);
    validateEvidenceReference(actual.evidenceRef, `${expected.consumer}/${expected.fact} evidenceRef`);
    check(/^sha256:[0-9a-f]{64}$/.test(actual.evidenceSHA256 ?? ""), `${expected.consumer}/${expected.fact}: evidenceSHA256 must be an exact SHA-256`);
  }
  const serialized = stableJson(value);
  check(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized), "target-fact attestation contains private key material");
  check(!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(serialized), "target-fact attestation contains credential-shaped material");
  check(!containsCredentialMaterial(serialized), "target-fact attestation contains credential-shaped material");
  checkExactKeys(value.spec?.policy, ["secretValuesIncluded", "generatedTemplateIsAnAttestation", "acceptedBindingStatus", "acceptedResolutionStatuses"], "target-fact attestation policy");
  check(value.spec?.policy?.secretValuesIncluded === false, "target-fact attestation must explicitly state secretValuesIncluded: false");
  check(value.spec?.policy?.generatedTemplateIsAnAttestation === true, "target-fact attestation must explicitly set generatedTemplateIsAnAttestation: true");
  check(value.spec?.policy?.acceptedBindingStatus === "verified-present", "target-fact attestation acceptedBindingStatus differs from the contract");
  check(stableJson(value.spec?.policy?.acceptedResolutionStatuses) === stableJson(["satisfied", "not-applicable-reviewed"]), "target-fact attestation acceptedResolutionStatuses differs from the contract");
  return value;
}

function buildApplyPayloads(compiled, consumed) {
  const result = new Map();
  const aggregateControls = new Map((consumed.aggregate.spec?.controlPayloads ?? []).map((row) => [row.id, row]));
  const memberById = new Map(consumed.receipt.spec.members.map((row) => [row.id, row]));
  for (const unitPlan of compiled.plan.spec.configHub.units) {
    const ref = `${unitPlan.space}/${unitPlan.slug}`;
    let text;
    let oci = null;
    if (unitPlan.slug === "component-catalog-index") {
      text = `${JSON.stringify(consumed.receipt, null, 2)}\n`;
      oci = consumed.receipt.spec.aggregate;
    } else if (
      (["platform-lock", "kubara-config", "wiring-ledger"].includes(unitPlan.slug) && unitPlan.space.endsWith("-platform"))
      || (unitPlan.slug === "argo-cd-runtime" && unitPlan.source === "generated:argo-runtime-definition")
    ) {
      const row = aggregateControls.get(unitPlan.slug);
      check(row && /^sha256:[0-9a-f]{64}$/.test(`sha256:${row.sha256}`), `${ref}: pulled aggregate control payload is missing`);
      text = Buffer.from(row.contentBase64, "base64").toString("utf8");
      check(Buffer.byteLength(text) === row.size && sha256(text) === row.sha256, `${ref}: pulled aggregate control payload digest differs`);
      oci = consumed.receipt.spec.aggregate;
    } else if (unitPlan.source.startsWith("config:")) {
      const sourceID = unitPlan.source.slice("config:".length);
      const configPlan = compiled.plan.spec.oci.configReleases.find((row) => row.id.startsWith(`config:${sourceID}@`));
      check(configPlan, `${ref}: config package plan ${sourceID} is missing`);
      const packaged = consumed.payloads.get(configPlan.id);
      check(packaged?.payload?.kind === "KubaraConfigSetOCIPayload", `${ref}: pulled config-set payload kind is invalid`);
      const render = packaged.payload.spec?.effectiveRender;
      const bytes = Buffer.from(render?.contentBase64 ?? "", "base64");
      check(render?.sha256 === configPlan.renderSha256 && sha256(bytes) === configPlan.renderSha256, `${ref}: pulled effective render differs from the exact config package plan`);
      check(bytes.length === render.size, `${ref}: pulled effective render size differs`);
      text = bytes.toString("utf8");
      oci = memberById.get(configPlan.id);
    } else if (unitPlan.source.startsWith("component:")) {
      const prefix = unitPlan.source.slice("component:".length);
      const componentPlan = compiled.plan.spec.oci.catalogPackages.find((row) => row.id === `component:${prefix}`);
      check(componentPlan, `${ref}: component package plan ${prefix} is missing`);
      const packaged = consumed.payloads.get(componentPlan.id);
      text = `${toYaml({
        apiVersion: "import.confighub.com/v1alpha1",
        kind: "KubaraComponentCatalogLock",
        metadata: { name: componentPlan.service },
        spec: { package: memberById.get(componentPlan.id), component: packaged.payload.spec },
      })}\n`;
      oci = memberById.get(componentPlan.id);
    } else check(false, `${ref}: no apply payload route for ${unitPlan.source}`);
    const annotations = {
      ...(unitPlan.annotations ?? {}),
      "import.confighub.com/source-sha256": `sha256:${sha256(text)}`,
      ...(oci ? {
        "import.confighub.com/oci-ref": oci.ref,
        "import.confighub.com/oci-manifest-digest": oci.manifestDigest,
        "import.confighub.com/oci-layer-digest": oci.layerDigest,
      } : {}),
    };
    result.set(ref, { text, annotations });
  }
  return result;
}

function deliveryApplicationPayload(plan, release) {
  validatePublishedRelease(plan.sourceSpace, release, "delivery-authority source release");
  const text = `${toYaml(platformDeliveryApplicationFromPlan(plan, release.ManifestDigest))}\n`;
  return {
    text,
    annotations: {
      ...(plan.annotations ?? {}),
      "import.confighub.com/source-sha256": `sha256:${sha256(text)}`,
      "import.confighub.com/oci-manifest-digest": release.ManifestDigest,
    },
  };
}

function platformDeliveryApplicationFromPlan(plan, manifestDigest) {
  validateOCIRepositoryRef(plan.sourceRepoURL, `${plan.sourceSpace}: delivery sourceRepoURL`);
  const separator = plan.sourceRepoURL.lastIndexOf("/");
  check(separator > "oci://".length && plan.sourceRepoURL.slice(separator + 1) === plan.sourceSpace, `${plan.sourceSpace}: delivery sourceRepoURL does not bind the exact source Space`);
  return platformDeliveryApplication(plan.sourceRepoURL.slice(0, separator), plan.sourceSpace, plan.destinationNamespace, manifestDigest);
}

function addObservedDeliveryApplicationPayloads({ compiled, client, expected }) {
  for (const plan of compiled.plan.spec.configHub.deliveryApplications) {
    if (!client.getSpace(plan.sourceSpace)) continue;
    const release = latestReleaseRow(client.listPublishedReleases(plan.sourceSpace));
    if (release) expected.set(`${plan.space}/${plan.slug}`, deliveryApplicationPayload(plan, release));
  }
}

function materializeApplyPayloads(root, expected) {
  const result = new Map();
  for (const [ref, payload] of expected) {
    const path = join(root, `${safeArtifactFilename(ref)}-${sha256(payload.text)}.yaml`);
    writeFileSync(path, payload.text);
    result.set(ref, path);
  }
  return result;
}

function preflightOrganization({ compiled, client, expected, transition = null }) {
  client.assertExactCoordinate();
  const destination = compiled.execution.request.spec.destination;
  const allSpaces = new Map(client.listSpaces().map((row) => [row.Slug, row]));
  const managedPlans = compiled.plan.spec.configHub.spaces.filter((row) => !row.externalBinding);
  const managedBySlug = new Map(managedPlans.map((row) => [row.slug, row]));
  const targetPlans = compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding);
  const targetBySlug = new Map(targetPlans.map((row) => [row.slug, row]));
  check(managedBySlug.size === managedPlans.length, "managed Space plan contains duplicate slugs");
  check(targetBySlug.size === targetPlans.length, "external target Space plan contains duplicate slugs");
  for (const slug of managedBySlug.keys()) check(!targetBySlug.has(slug), `${slug}: target Space collides with an importer-managed Space`);

  for (const target of targetPlans) {
    const live = allSpaces.get(target.slug);
    check(live, `${target.slug}: exact pre-existing target Space is missing; the importer never creates targets`);
    check(live.SpaceID === target.expectedSpaceID, `${target.slug}: Space ID ${live.SpaceID ?? "missing"} differs from request-pinned ${target.expectedSpaceID}`);
    check(live.OrganizationID === destination.organizationID, `${target.slug}: target Space belongs to another Organization entity`);
    const targetEntity = client.getTarget(target.slug, target.expectedTarget);
    check(targetEntity, `${target.slug}/${target.expectedTarget}: exact pre-existing Target is missing`);
    check(targetEntity.TargetID === target.expectedTargetID, `${target.slug}/${target.expectedTarget}: Target ID differs from request-pinned ${target.expectedTargetID}`);
    if (targetEntity.SpaceID) check(targetEntity.SpaceID === target.expectedSpaceID, `${target.slug}/${target.expectedTarget}: Target points at another Space ID`);
  }
  preflightDeliveryInfrastructure({ compiled, client, allSpaces, expected, transition });

  const externalInfrastructure = [...externalInfrastructureSpaces(compiled.execution.request), ...workloadSourceSpaces(compiled.execution.request)];
  const externalBySlug = new Map(externalInfrastructure.map((row) => [row.space, row]));
  const deliveryBySlug = new Map(deliveryInfrastructureSpaceRows(compiled.execution.request).map((row) => [row.space, row]));
  for (const row of externalInfrastructure) {
    check(!managedBySlug.has(row.space) && !targetBySlug.has(row.space), `${row.space}: external infrastructure collides with a managed or target Space`);
    const live = allSpaces.get(row.space);
    check(live, `${row.space}: request-pinned external infrastructure Space is missing`);
    check(live.SpaceID === row.spaceID, `${row.space}: external infrastructure Space ID differs from the request`);
    check(live.OrganizationID === destination.organizationID, `${row.space}: external infrastructure belongs to another Organization entity`);
    if (row.units?.length) {
      const units = new Map(client.listUnits(row.space).map((unit) => [unit.Slug, unit]));
      for (const expectedUnit of row.units) {
        const unit = units.get(expectedUnit.slug);
        check(unit?.UnitID === expectedUnit.unitID, `${row.space}/${expectedUnit.slug}: external infrastructure Unit ID differs or is missing`);
      }
    }
  }

  for (const live of allSpaces.values()) {
    if (targetBySlug.has(live.Slug) || externalBySlug.has(live.Slug) || deliveryBySlug.has(live.Slug)) continue;
    const plan = managedBySlug.get(live.Slug);
    check(plan, `${live.Slug}: refusing nonempty organization with an unexpected Space`);
    assertImporterOwnership(live, compiled, `${live.Slug} Space`, transition, "space", live.Slug);
    check(live.OrganizationID === destination.organizationID, `${live.Slug}: importer-owned Space belongs to another Organization entity`);
  }

  const unitPlansBySpace = groupBy(compiled.plan.spec.configHub.units, (row) => row.space);
  const linkPlansBySpace = groupBy(compiled.plan.spec.configHub.links, (row) => row.space);
  for (const plan of managedPlans) {
    const live = allSpaces.get(plan.slug);
    if (!live) continue;
    const allowedUnits = new Map((unitPlansBySpace.get(plan.slug) ?? []).map((row) => [row.slug, row]));
    const units = client.listUnits(plan.slug);
    for (const unit of units) {
      const unitPlan = allowedUnits.get(unit.Slug);
      check(unitPlan, `${plan.slug}/${unit.Slug}: refusing unexpected Unit in importer-owned Space`);
      assertImporterOwnership(unit, compiled, `${plan.slug}/${unit.Slug} Unit`, transition, "unit", `${plan.slug}/${unit.Slug}`);
      check(unit.ToolchainType === unitPlan.toolchain, `${plan.slug}/${unit.Slug}: toolchain drifted from ${unitPlan.toolchain}`);
      check((unit.ProviderType ?? null) === (unitPlan.provider ?? null), `${plan.slug}/${unit.Slug}: provider drifted from ${unitPlan.provider ?? "default"}`);
      const expectedPayload = expected.get(`${plan.slug}/${unit.Slug}`);
      check(expectedPayload, `${plan.slug}/${unit.Slug}: expected apply payload is missing`);
      const liveData = client.unitData(plan.slug, unit.Slug);
      const exact = sameUnitData(unitPlan.toolchain, liveData, expectedPayload.text);
      let canonicalTransition = false;
      if (!exact && unitPlan.upstream) {
        const canonical = expected.get(unitPlan.upstream);
        canonicalTransition = Boolean(canonical && sameUnitData(unitPlan.toolchain, liveData, canonical.text));
      }
      const priorTransition = transitionAllowsPriorUnit(transition, `${plan.slug}/${unit.Slug}`, unit, liveData);
      check(exact || canonicalTransition || priorTransition, `${plan.slug}/${unit.Slug}: existing importer-owned Unit data is neither exact, prior-receipt-authorized, nor the one allowed freshly-cloned canonical transition`);
      if (unitPlan.target) {
        const target = requestTargetByRef(compiled.execution.request, unitPlan.target);
        check(!unit.TargetID || unit.TargetID === target.targetID, `${plan.slug}/${unit.Slug}: Unit targets an unexpected Target ID`);
      } else check(!unit.TargetID, `${plan.slug}/${unit.Slug}: untargeted Unit gained a Target`);
      if (unitPlan.upstream) {
        const [upstreamSpace, upstreamSlug] = unitPlan.upstream.split("/");
        const upstream = client.getUnit(upstreamSpace, upstreamSlug);
        check(upstream?.UnitID, `${plan.slug}/${unit.Slug}: existing instance has no exact upstream definition Unit`);
        check(unit.UpstreamUnitID === upstream.UnitID, `${plan.slug}/${unit.Slug}: upstream Unit lineage differs from ${unitPlan.upstream}`);
      } else check(!unit.UpstreamUnitID, `${plan.slug}/${unit.Slug}: definition/control Unit unexpectedly has an upstream`);
    }
    const allowedLinks = new Map((linkPlansBySpace.get(plan.slug) ?? []).map((row) => [row.slug, row]));
    for (const link of client.listLinks(plan.slug)) {
      const linkPlan = allowedLinks.get(link.Slug);
      check(linkPlan, `${plan.slug}/${link.Slug}: refusing unexpected Link in importer-owned Space`);
      check(link.UpdateType === linkPlan.updateType, `${plan.slug}/${link.Slug}: Link update type drifted`);
      check(link.AutoUpdate !== true, `${plan.slug}/${link.Slug}: Link unexpectedly enables auto-update`);
      const from = client.getUnit(plan.slug, linkPlan.fromUnit);
      const to = client.getUnit(linkPlan.toSpace, linkPlan.toUnit);
      const toSpace = client.getSpace(linkPlan.toSpace);
      check(link.FromUnitID === from?.UnitID && link.ToUnitID === to?.UnitID && link.ToSpaceID === toSpace?.SpaceID, `${plan.slug}/${link.Slug}: refusing existing Link with different endpoints`);
      check(isImporterOwned(link, compiled) || isPriorTransitionOwned(link, transition, "link", `${plan.slug}/${link.Slug}`) || isCanonicalUnownedUpgradeTransition(link, linkPlan, from, to, toSpace), `${plan.slug}/${link.Slug}: refusing unowned existing Link; only exact current/prior-receipt ownership or the canonical auto-created UpgradeUnit transition is recoverable`);
    }
  }
}

function preflightDeliveryInfrastructure({ compiled, client, allSpaces, expected, transition = null }) {
  const request = compiled.execution.request;
  const destination = request.spec.destination;
  const basePlan = destination.argobotBase;
  const baseSpace = allSpaces.get(basePlan.space);
  check(baseSpace?.SpaceID === basePlan.spaceID && baseSpace.OrganizationID === destination.organizationID, `${basePlan.space}: request-pinned argobot base Space is missing or differs`);
  let argobotSources;
  try { argobotSources = JSON.parse(baseSpace.Annotations?.["confighub.com/external-source"] ?? "null"); } catch { check(false, `${basePlan.space}: external-source annotation is invalid JSON`); }
  check(Array.isArray(argobotSources) && argobotSources.length === 1 && argobotSources[0]?.ref === basePlan.sourceRef && argobotSources[0]?.digest === basePlan.sourceDigest, `${basePlan.space}: exact argobot external source ref/digest differs from the request`);
  const baseUnits = client.listUnits(basePlan.space);
  check(baseUnits.length === 1 && baseUnits[0].Slug === basePlan.unit && baseUnits[0].UnitID === basePlan.unitID, `${basePlan.space}: argobot base Unit allowlist/identity differs`);
  check(!baseUnits[0].TargetID && !baseUnits[0].UpstreamUnitID, `${basePlan.space}/${basePlan.unit}: argobot base must be untargeted and without upstream`);
  check(baseUnits[0].DataHash === basePlan.dataHash, `${basePlan.space}/${basePlan.unit}: ConfigHub DataHash differs from the request`);
  check(sha256(client.unitData(basePlan.space, basePlan.unit)) === basePlan.dataSHA256, `${basePlan.space}/${basePlan.unit}: exact request-pinned bootstrap Unit bytes differ`);
  check(client.listLinks(basePlan.space).length === 0, `${basePlan.space}: argobot base has unexpected Links`);

  const applicationPlansByCluster = groupBy(compiled.plan.spec.configHub.deliveryApplications, (row) => row.cluster);
  for (const [cluster, target] of Object.entries(request.spec.targets)) {
    const delivery = target.delivery;
    const targetEntity = client.getTarget(target.space, target.target);
    check(targetEntity.ProviderType === "OCI", `${target.space}/${target.target}: delivery Target provider must be OCI`);
    check(targetEntity.ToolchainType === "Any", `${target.space}/${target.target}: delivery Target toolchain must be Any`);
    check(targetEntity.Annotations?.["confighub.com/argo-apps-space"] === delivery.appsSpace, `${target.space}/${target.target}: target argo-apps annotation must name ${delivery.appsSpace}`);
    const appsSpace = allSpaces.get(delivery.appsSpace);
    check(appsSpace?.SpaceID === delivery.appsSpaceID && appsSpace.OrganizationID === destination.organizationID, `${delivery.appsSpace}: request-pinned apps Space is missing or differs`);
    check(appsSpace.ReleaseTargetID === target.targetID, `${delivery.appsSpace}: release Target differs from ${target.space}/${target.target}`);
    const allowedApps = new Map([
      [delivery.root.unit, { id: delivery.root.unitID, bootstrapSource: delivery.appsSpace }],
      [delivery.argobotApplication.unit, { id: delivery.argobotApplication.unitID, bootstrapSource: delivery.argobot.space }],
      ...(delivery.workloadApplications ?? []).map((workload) => [workload.unit, { workload }]),
      ...(applicationPlansByCluster.get(cluster) ?? []).map((row) => [row.slug, { plan: row }]),
    ]);
    const appsUnits = client.listUnits(delivery.appsSpace);
    for (const unit of appsUnits) {
      const allowed = allowedApps.get(unit.Slug);
      check(allowed, `${delivery.appsSpace}/${unit.Slug}: refusing unexpected Application Unit in the pinned delivery root`);
      check(unit.ToolchainType === "Kubernetes/YAML" && !unit.ProviderType, `${delivery.appsSpace}/${unit.Slug}: delivery Application Unit toolchain/provider drifted`);
      check(unit.TargetID === target.targetID, `${delivery.appsSpace}/${unit.Slug}: delivery Application target differs`);
      if (allowed.workload) {
        const workload = allowed.workload;
        check(unit.UnitID === workload.unitID && unit.DataHash === workload.dataHash, `${delivery.appsSpace}/${unit.Slug}: preserved workload Application identity/data hash differs`);
        check(sha256(client.unitData(delivery.appsSpace, unit.Slug)) === workload.dataSHA256, `${delivery.appsSpace}/${unit.Slug}: preserved workload Application exact bytes differ`);
        check(!unit.UpstreamUnitID && Number(unit.HeadRevisionNum ?? 0) === workload.headRevisionNum && Number(unit.LastReleasedRevisionNum ?? 0) === workload.headRevisionNum, `${delivery.appsSpace}/${unit.Slug}: preserved workload Application has an unpinned or unpublished head`);
        assertPreservedWorkloadApplicationData(client.unitData(delivery.appsSpace, unit.Slug), workload.unit, destination.spaceReleaseOCIBase, workload.sourceSpace, workload.sourceReleaseManifestDigest);
        const sourceSpace = allSpaces.get(workload.sourceSpace);
        check(sourceSpace?.SpaceID === workload.sourceSpaceID && sourceSpace.OrganizationID === destination.organizationID, `${workload.sourceSpace}: preserved workload source Space identity differs`);
        const sourceUnit = client.getUnit(workload.sourceSpace, workload.sourceUnit);
        check(sourceUnit?.UnitID === workload.sourceUnitID, `${workload.sourceSpace}/${workload.sourceUnit}: preserved workload source Unit identity differs`);
        check(client.listUnits(workload.sourceSpace).every((row) => Number(row.HeadRevisionNum ?? 0) === Number(row.LastReleasedRevisionNum ?? 0)), `${workload.sourceSpace}: preserved workload source has unpublished heads`);
        check(latestReleaseRow(client.listPublishedReleases(workload.sourceSpace))?.ManifestDigest === workload.sourceReleaseManifestDigest, `${workload.sourceSpace}: preserved workload source release manifest differs`);
      } else if (allowed.id) {
        check(unit.UnitID === allowed.id, `${delivery.appsSpace}/${unit.Slug}: bootstrap Application Unit ID differs from the request`);
        const requestEntity = unit.Slug === delivery.root.unit ? delivery.root : delivery.argobotApplication;
        check(unit.DataHash === requestEntity.dataHash, `${delivery.appsSpace}/${unit.Slug}: ConfigHub DataHash differs from the request`);
        check(sha256(client.unitData(delivery.appsSpace, unit.Slug)) === requestEntity.dataSHA256, `${delivery.appsSpace}/${unit.Slug}: exact request-pinned bootstrap Application bytes differ`);
        assertBootstrapApplicationData(client.unitData(delivery.appsSpace, unit.Slug), unit.Slug, destination.spaceReleaseOCIBase, allowed.bootstrapSource);
      } else {
        const payload = expected.get(`${delivery.appsSpace}/${unit.Slug}`);
        check(payload, `${delivery.appsSpace}/${unit.Slug}: expected platform delivery payload is missing`);
        const data = client.unitData(delivery.appsSpace, unit.Slug);
        check(
          sameUnitData("Kubernetes/YAML", data, payload.text)
            || transitionAllowsPriorUnit(transition, `${delivery.appsSpace}/${unit.Slug}`, unit, data)
            || isCompatibleAutoDeliveryApplication(data, allowed.plan.sourceRepoURL, allowed.plan.sourceSpace, allowed.plan.destinationNamespace),
          `${delivery.appsSpace}/${unit.Slug}: existing platform delivery Application is neither exact, prior-receipt-authorized, nor an allowed fresh auto-generated form`,
        );
        if (unit.Labels?.ManagedBy) assertImporterOwnership(unit, compiled, `${delivery.appsSpace}/${unit.Slug} delivery Unit`, transition, "unit", `${delivery.appsSpace}/${unit.Slug}`);
      }
    }
    for (const required of [delivery.root.unit, delivery.argobotApplication.unit, ...(delivery.workloadApplications ?? []).map((row) => row.unit)]) check(appsUnits.some((unit) => unit.Slug === required), `${delivery.appsSpace}/${required}: required pinned Application Unit is missing`);
    check(client.listLinks(delivery.appsSpace).length === 0, `${delivery.appsSpace}: delivery root must not contain Links`);

    const argobotSpace = allSpaces.get(delivery.argobot.space);
    check(argobotSpace?.SpaceID === delivery.argobot.spaceID && argobotSpace.OrganizationID === destination.organizationID, `${delivery.argobot.space}: request-pinned argobot Space is missing or differs`);
    check(argobotSpace.ReleaseTargetID === target.targetID, `${delivery.argobot.space}: release Target differs`);
    const argobotUnits = client.listUnits(delivery.argobot.space);
    check(argobotUnits.length === 1 && argobotUnits[0].Slug === delivery.argobot.unit && argobotUnits[0].UnitID === delivery.argobot.unitID, `${delivery.argobot.space}: argobot Unit allowlist/identity differs`);
    check(argobotUnits[0].TargetID === target.targetID && argobotUnits[0].UpstreamUnitID === basePlan.unitID, `${delivery.argobot.space}/${delivery.argobot.unit}: target or upstream lineage differs`);
    check(argobotUnits[0].DataHash === delivery.argobot.dataHash, `${delivery.argobot.space}/${delivery.argobot.unit}: ConfigHub DataHash differs from the request`);
    check(sha256(client.unitData(delivery.argobot.space, delivery.argobot.unit)) === delivery.argobot.dataSHA256, `${delivery.argobot.space}/${delivery.argobot.unit}: exact request-pinned argobot Unit bytes differ`);
    check(Number(argobotUnits[0].HeadRevisionNum ?? 0) === Number(argobotUnits[0].LastReleasedRevisionNum ?? 0), `${delivery.argobot.space}/${delivery.argobot.unit}: exact argobot head is not published`);
    validatePublishedRelease(delivery.argobot.space, latestReleaseRow(client.listPublishedReleases(delivery.argobot.space)), "request-pinned argobot release");
    const argobotLinks = client.listLinks(delivery.argobot.space);
    check(argobotLinks.length === 1 && argobotLinks[0].Slug === `upgrade-${delivery.argobot.unit}` && argobotLinks[0].UpdateType === "UpgradeUnit" && argobotLinks[0].FromUnitID === delivery.argobot.unitID && argobotLinks[0].ToUnitID === basePlan.unitID && argobotLinks[0].ToSpaceID === basePlan.spaceID, `${delivery.argobot.space}: argobot UpgradeUnit Link differs`);
  }
}

function assertBootstrapApplicationData(text, applicationName, spaceReleaseOCIBase, sourceSpace) {
  const docs = parseDocs(text);
  check(docs.length === 1 && docs[0]?.kind === "Application", `${applicationName}: expected one bootstrap Argo Application`);
  const app = docs[0];
  check(app.metadata?.name === applicationName && app.metadata?.namespace === "argocd", `${applicationName}: bootstrap Application identity differs`);
  check(app.spec?.project === "default", `${applicationName}: bootstrap Application project differs`);
  check(app.spec?.source?.repoURL === spaceReleaseOCIRef(spaceReleaseOCIBase, sourceSpace) && app.spec?.source?.targetRevision === "latest" && app.spec?.source?.path === ".", `${applicationName}: bootstrap Application source differs from ${sourceSpace}`);
  check(app.spec?.destination?.server === "https://kubernetes.default.svc", `${applicationName}: bootstrap Application destination is not cluster-local`);
  check(app.spec?.syncPolicy?.automated?.selfHeal === true && app.spec?.syncPolicy?.automated?.prune !== true, `${applicationName}: bootstrap Application must self-heal without prune`);
  check(!(app.spec?.syncPolicy?.syncOptions ?? []).some((row) => String(row).startsWith("Replace=")), `${applicationName}: bootstrap Application must not use Replace`);
}

function isCompatibleAutoDeliveryApplication(text, sourceRepoURL, sourceSpace, destinationNamespace) {
  try {
    const docs = parseDocs(text);
    if (docs.length !== 1 || docs[0]?.kind !== "Application") return false;
    const app = docs[0];
    return app.metadata?.name === sourceSpace
      && app.metadata?.namespace === "argocd"
      && app.spec?.source?.repoURL === sourceRepoURL
      && app.spec?.source?.targetRevision === "latest"
      && app.spec?.source?.path === "."
      && app.spec?.destination?.server === "https://kubernetes.default.svc"
      && [undefined, null, destinationNamespace].includes(app.spec?.destination?.namespace)
      && !(app.spec?.syncPolicy?.syncOptions ?? []).some((row) => String(row).startsWith("Replace="));
  } catch {
    return false;
  }
}

function assertPreservedWorkloadApplicationData(text, applicationName, spaceReleaseOCIBase, sourceSpace, manifestDigest) {
  const docs = parseDocs(text);
  check(docs.length === 1 && docs[0]?.kind === "Application", `${applicationName}: preserved workload delivery must be exactly one Argo Application`);
  const app = docs[0];
  check(app.metadata?.name === applicationName && app.metadata?.namespace === "argocd", `${applicationName}: preserved workload Application identity differs`);
  check(/^sha256:[0-9a-f]{64}$/.test(manifestDigest ?? ""), `${applicationName}: preserved workload source release manifest digest is invalid`);
  check(app.spec?.source?.repoURL === spaceReleaseOCIRef(spaceReleaseOCIBase, sourceSpace) && app.spec?.source?.path === ".", `${applicationName}: preserved workload Application source differs from ${sourceSpace}`);
  const exactNoAuto = app.spec?.source?.targetRevision === manifestDigest && !Object.hasOwn(app.spec?.syncPolicy ?? {}, "automated");
  const pinnedLegacy = app.spec?.source?.targetRevision === "latest";
  check(exactNoAuto || pinnedLegacy, `${applicationName}: preserved workload Application is neither exact-digest/no-auto nor the exact request-pinned legacy latest form`);
  check(app.spec?.destination?.server === "https://kubernetes.default.svc", `${applicationName}: preserved workload Application is not cluster-local`);
  check(!(app.spec?.syncPolicy?.syncOptions ?? []).some((row) => String(row).startsWith("Replace=")), `${applicationName}: preserved workload Application uses forbidden Replace`);
}

function assertImporterOwnership(entity, compiled, label, transition = null, kind = "", ref = "") {
  const expected = {
    ManagedBy: "kubara-git-import",
    ImportName: compiled.plan.metadata.name,
    PlatformDigest: compiled.lock.spec.platformDigest,
  };
  check(mapContains(entity.Labels, expected) || isPriorTransitionOwned(entity, transition, kind, ref), `${label} is not importer-owned with the identical current or prior-receipt-authorized platform digest`);
}

function isImporterOwned(entity, compiled) {
  return hasExactImportOwnership(entity, compiled.plan.metadata.name, compiled.lock.spec.platformDigest);
}

function hasExactImportOwnership(entity, importName, platformDigest) {
  return mapContains(entity?.Labels, {
    ManagedBy: "kubara-git-import",
    ImportName: importName,
    PlatformDigest: platformDigest,
  });
}

function isPriorTransitionOwned(entity, transition, kind, ref) {
  if (!transition || !hasExactImportOwnership(entity, transition.importName, transition.fromPlatformDigest)) return false;
  const prior = kind === "space" ? transition.priorSpaces.get(ref)
    : kind === "unit" ? transition.priorUnits.get(ref)
      : kind === "link" ? transition.priorLinks.get(ref)
        : null;
  const actualID = kind === "space" ? entity.SpaceID : kind === "unit" ? entity.UnitID : kind === "link" ? entity.LinkID : null;
  const expectedID = kind === "space" ? prior?.spaceID : kind === "unit" ? prior?.unitID : kind === "link" ? prior?.linkID : null;
  return Boolean(prior && actualID === expectedID);
}

function transitionAllowsPriorUnit(transition, ref, unit, data) {
  const prior = transition?.priorUnits?.get(ref);
  if (!prior) return false;
  return unit.UnitID === prior.unitID
    && unit.DataHash === prior.dataHash
    && sha256(data) === prior.dataSHA256
    && Number(unit.HeadRevisionNum ?? 0) === Number(prior.headRevisionNum)
    && Number(unit.LastReleasedRevisionNum ?? 0) === Number(prior.lastAppliedRevisionNum)
    && (unit.TargetID ?? null) === (prior.targetID ?? null)
    && (unit.UpstreamUnitID ?? null) === (prior.upstreamUnitID ?? null);
}

function isCanonicalUnownedUpgradeTransition(link, plan, from, to, toSpace) {
  const ownershipKeys = ["ManagedBy", "ImportName", "PlatformDigest"];
  return plan.updateType === "UpgradeUnit"
    && link.UpdateType === "UpgradeUnit"
    && link.AutoUpdate !== true
    && link.FromUnitID === from?.UnitID
    && link.ToUnitID === to?.UnitID
    && link.ToSpaceID === toSpace?.SpaceID
    && ownershipKeys.every((key) => !Object.hasOwn(link.Labels ?? {}, key));
}

function ensureManagedSpace(client, plan, state, { mustExist = false } = {}) {
  let live = client.getSpace(plan.slug);
  if (!live) {
    check(!mustExist, `${plan.slug}: expected freshly-created variant Space is missing`);
    client.mutate(["space", "create", plan.slug, ...labelsArgs(plan.labels), ...annotationsArgs(plan.annotations), "--quiet"]);
    recordApplyAction(state, "space-create", plan.slug);
    live = client.getSpace(plan.slug);
  }
  check(live, `${plan.slug}: Space creation did not converge`);
  const staleLabels = staleOwnedKeys(live.Labels, plan.labels, OWNED_SPACE_LABELS);
  const staleAnnotations = staleOwnedKeys(live.Annotations, plan.annotations ?? {}, OWNED_ANNOTATIONS);
  if (!mapContains(live.Labels, plan.labels) || !mapContains(live.Annotations, plan.annotations ?? {}) || staleLabels.length || staleAnnotations.length) {
    client.mutate([
      "space", "update", "--patch", plan.slug,
      ...labelsArgs(plan.labels),
      ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
      ...annotationsArgs(plan.annotations ?? {}),
      ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
      "--quiet",
    ]);
    recordApplyAction(state, "space-metadata", plan.slug);
  }
}

function ensureBoundTargetSpaceMetadata(client, plan, state) {
  const live = client.getSpace(plan.slug);
  check(live?.SpaceID === plan.expectedSpaceID, `${plan.slug}: request-pinned target Space is missing or differs before metadata reconciliation`);
  const staleLabels = staleOwnedKeys(live.Labels, plan.labels, PINNED_GUI_LABELS);
  if (!mapContains(live.Labels, plan.labels) || staleLabels.length) {
    client.mutate(["space", "update", "--patch", plan.slug, ...labelsArgs(plan.labels), ...staleLabels.flatMap((key) => ["--label", `${key}=-`]), "--quiet"]);
    recordApplyAction(state, "target-space-metadata", plan.slug, "Lane=Adapted");
  }
}

function pinnedDeliveryMetadataPlans(compiled) {
  const infrastructure = compiled.plan.spec.configHub.deliveryInfrastructure;
  const rows = [
    { kind: "space", space: infrastructure.argobotBase.space, expectedID: infrastructure.argobotBase.spaceID, labels: infrastructure.argobotBase.labels },
    { kind: "unit", space: infrastructure.argobotBase.space, slug: infrastructure.argobotBase.unit, expectedID: infrastructure.argobotBase.unitID, labels: infrastructure.argobotBase.unitLabels },
  ];
  for (const cluster of infrastructure.clusters) rows.push(
    { kind: "space", space: cluster.appsSpace, expectedID: cluster.appsSpaceID, labels: cluster.appsSpaceLabels },
    { kind: "unit", space: cluster.appsSpace, slug: cluster.root.unit, expectedID: cluster.root.unitID, labels: cluster.rootUnitLabels },
    { kind: "unit", space: cluster.appsSpace, slug: cluster.argobotApplication.unit, expectedID: cluster.argobotApplication.unitID, labels: cluster.argobotApplicationUnitLabels },
    { kind: "space", space: cluster.argobot.space, expectedID: cluster.argobot.spaceID, labels: cluster.argobotSpaceLabels },
    { kind: "unit", space: cluster.argobot.space, slug: cluster.argobot.unit, expectedID: cluster.argobot.unitID, labels: cluster.argobotUnitLabels },
  );
  return rows;
}

function ensurePinnedDeliveryMetadata(client, plan, state) {
  const live = plan.kind === "space" ? client.getSpace(plan.space) : client.getUnit(plan.space, plan.slug);
  const actualID = plan.kind === "space" ? live?.SpaceID : live?.UnitID;
  const ref = plan.kind === "space" ? plan.space : `${plan.space}/${plan.slug}`;
  check(actualID === plan.expectedID, `${ref}: pinned delivery ${plan.kind} identity differs before metadata reconciliation`);
  const staleLabels = staleOwnedKeys(live.Labels, plan.labels, PINNED_GUI_LABELS);
  if (mapContains(live.Labels, plan.labels) && staleLabels.length === 0) return;
  if (plan.kind === "space") client.mutate(["space", "update", "--patch", plan.space, ...labelsArgs(plan.labels), ...staleLabels.flatMap((key) => ["--label", `${key}=-`]), "--quiet"]);
  else client.mutate(["unit", "update", "--patch", "--space", plan.space, plan.slug, ...labelsArgs(plan.labels), ...staleLabels.flatMap((key) => ["--label", `${key}=-`]), "--wait", "--quiet"]);
  recordApplyAction(state, `delivery-${plan.kind}-metadata`, ref);
}

function verifyPinnedDeliveryMetadata(compiled, client) {
  const rows = [];
  for (const plan of pinnedDeliveryMetadataPlans(compiled)) {
    const live = plan.kind === "space" ? client.getSpace(plan.space) : client.getUnit(plan.space, plan.slug);
    const actualID = plan.kind === "space" ? live?.SpaceID : live?.UnitID;
    const ref = plan.kind === "space" ? plan.space : `${plan.space}/${plan.slug}`;
    check(actualID === plan.expectedID && mapContains(live.Labels, plan.labels) && staleOwnedKeys(live.Labels, plan.labels, PINNED_GUI_LABELS).length === 0, `${ref}: pinned delivery GUI metadata did not converge`);
    rows.push({ kind: plan.kind, ref, id: actualID, role: plan.labels.Role, component: plan.labels.Component, lane: plan.labels.Lane });
  }
  return rows;
}

function ensureVariantInstance(client, compiled, spacePlan, unitPlan, state) {
  if (client.getSpace(spacePlan.slug)) return;
  const [upstreamSpace] = unitPlan.upstream.split("/");
  const target = compiled.execution.request.spec.targets[unitPlan.labels.Cluster];
  check(target, `${spacePlan.slug}: target mapping is missing`);
  client.mutate([
    "variant", "create", unitPlan.labels.Variant, upstreamSpace,
    "--space-pattern", `template:${spacePlan.slug}`,
    "--environment", target.environment,
    ...(target.region ? ["--region", target.region] : []),
    ...(unitPlan.target ? ["--target", unitPlan.target] : []),
    "--wait", "--quiet",
  ]);
  recordApplyAction(state, "variant-create", spacePlan.slug, `upstream=${upstreamSpace}`);
}

function ensureManagedUnit(client, plan, payload, payloadFiles, state, { allowCanonicalTransition = false, transition = null } = {}) {
  const ref = `${plan.space}/${plan.slug}`;
  check(payload, `${ref}: expected payload is missing`);
  const path = payloadFiles.get(ref);
  check(path, `${ref}: materialized payload is missing`);
  let live = client.getUnit(plan.space, plan.slug);
  if (!live) {
    check(!plan.upstream, `${ref}: variant clone Unit is missing; refusing partial lineage repair`);
    client.mutate([
      "unit", "create", "--space", plan.space, plan.slug, path,
      "--toolchain", plan.toolchain,
      ...(plan.provider ? ["--provider", plan.provider] : []),
      ...labelsArgs(plan.labels), ...annotationsArgs(payload.annotations),
      "--change-desc", `Import ${plan.labels.ImportName} ${plan.labels.PlatformDigest}`,
      "--wait", "--quiet",
    ]);
    recordApplyAction(state, "unit-create", ref);
    live = client.getUnit(plan.space, plan.slug);
  }
  check(live, `${ref}: Unit creation did not converge`);
  check(live.ToolchainType === plan.toolchain, `${ref}: toolchain drifted`);
  check((live.ProviderType ?? null) === (plan.provider ?? null), `${ref}: provider drifted`);
  const currentData = client.unitData(plan.space, plan.slug);
  if (!sameUnitData(plan.toolchain, currentData, payload.text)) {
    const priorAuthorized = transitionAllowsPriorUnit(transition, ref, live, currentData);
    const canonical = allowCanonicalTransition && plan.upstream ? payloadFiles.get(plan.upstream) : null;
    const canonicalAuthorized = Boolean(canonical && sameUnitData(plan.toolchain, currentData, readFileSync(canonical, "utf8")));
    check(priorAuthorized || canonicalAuthorized, `${ref}: refusing to rewrite Unit data without exact prior-receipt or canonical-clone authority`);
    client.mutate([
      "unit", "update", "--space", plan.space, plan.slug, path,
      "--change-desc", `Specialize exact Kubara config ${plan.labels.PlatformDigest}`,
      "--wait", "--quiet",
    ]);
    recordApplyAction(state, "unit-data", ref);
    live = client.getUnit(plan.space, plan.slug);
  }
  const staleLabels = staleOwnedKeys(live.Labels, plan.labels, OWNED_UNIT_LABELS);
  const staleAnnotations = staleOwnedKeys(live.Annotations, payload.annotations, OWNED_ANNOTATIONS);
  if (!mapContains(live.Labels, plan.labels) || !mapContains(live.Annotations, payload.annotations) || staleLabels.length || staleAnnotations.length) {
    client.mutate([
      "unit", "update", "--patch", "--space", plan.space, plan.slug,
      ...labelsArgs(plan.labels), ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
      ...annotationsArgs(payload.annotations), ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
      "--change-desc", `Bind Kubara import provenance ${plan.labels.PlatformDigest}`,
      "--quiet",
    ]);
    recordApplyAction(state, "unit-metadata", ref);
    live = client.getUnit(plan.space, plan.slug);
  }
  if (plan.target) {
    const target = requestTargetByRef(client.request, plan.target);
    if (live.TargetID !== target.targetID) {
      check(!live.TargetID, `${ref}: refusing to replace a different target`);
      client.mutate(["unit", "set-target", "--space", plan.space, plan.slug, plan.target, "--quiet"]);
      recordApplyAction(state, "unit-target", ref, plan.target);
    }
  } else check(!live.TargetID, `${ref}: untargeted Unit gained a Target`);
}

function ensurePlatformDeliveryApplication(client, plan, payload, payloadFiles, state, transition = null) {
  const ref = `${plan.space}/${plan.slug}`;
  check(payload, `${ref}: packaged platform delivery payload is missing`);
  const path = payloadFiles.get(ref);
  check(path, `${ref}: materialized platform delivery payload is missing`);
  let live = client.getUnit(plan.space, plan.slug);
  check(live, `${ref}: variant creation did not materialize the platform delivery Application Unit`);
  check(live.ToolchainType === "Kubernetes/YAML" && !live.ProviderType, `${ref}: platform delivery Application toolchain/provider drifted`);
  const target = requestTargetByRef(client.request, plan.target);
  check(live.TargetID === target.targetID, `${ref}: platform delivery Application target differs from the exact request`);
  check(!live.UpstreamUnitID, `${ref}: platform delivery Application unexpectedly has Unit lineage`);
  const data = client.unitData(plan.space, plan.slug);
  if (!sameUnitData("Kubernetes/YAML", data, payload.text)) {
    check(transitionAllowsPriorUnit(transition, ref, live, data) || isCompatibleAutoDeliveryApplication(data, plan.sourceRepoURL, plan.sourceSpace, plan.destinationNamespace), `${ref}: refusing to replace an unrecognized or non-prior-receipt-authorized Application contract`);
    client.mutate([
      "unit", "update", "--space", plan.space, plan.slug, path,
      "--change-desc", `Normalize Kubara platform delivery ${plan.labels.PlatformDigest}`,
      "--wait", "--quiet",
    ]);
    recordApplyAction(state, "platform-delivery-data", ref);
    live = client.getUnit(plan.space, plan.slug);
  }
  const staleLabels = staleOwnedKeys(live.Labels, plan.labels, OWNED_UNIT_LABELS);
  const staleAnnotations = staleOwnedKeys(live.Annotations, payload.annotations, OWNED_ANNOTATIONS);
  if (!mapContains(live.Labels, plan.labels) || !mapContains(live.Annotations, payload.annotations) || staleLabels.length || staleAnnotations.length) {
    client.mutate([
      "unit", "update", "--patch", "--space", plan.space, plan.slug,
      ...labelsArgs(plan.labels), ...staleLabels.flatMap((key) => ["--label", `${key}=-`]),
      ...annotationsArgs(payload.annotations), ...staleAnnotations.flatMap((key) => ["--annotation", `${key}=-`]),
      "--change-desc", `Bind Kubara platform delivery identity ${plan.labels.PlatformDigest}`,
      "--quiet",
    ]);
    recordApplyAction(state, "platform-delivery-metadata", ref);
  }
}

function ensureManagedLink(client, plan, state, transition = null) {
  const existing = client.listLinks(plan.space).find((row) => row.Slug === plan.slug);
  const from = client.getUnit(plan.space, plan.fromUnit);
  const to = client.getUnit(plan.toSpace, plan.toUnit);
  const toSpace = client.getSpace(plan.toSpace);
  check(from?.UnitID && to?.UnitID && toSpace?.SpaceID, `${plan.space}/${plan.slug}: Link endpoint is missing`);
  if (existing) {
    const ref = `${plan.space}/${plan.slug}`;
    const exactCurrentCore = existing.FromUnitID === from.UnitID && existing.ToUnitID === to.UnitID && existing.ToSpaceID === toSpace.SpaceID && existing.UpdateType === plan.updateType && existing.AutoUpdate !== true;
    const prior = transition?.priorLinks?.get(ref);
    const exactPriorCore = prior && existing.LinkID === prior.linkID && existing.FromUnitID === prior.fromUnitID && existing.ToUnitID === prior.toUnitID && existing.ToSpaceID === prior.toSpaceID && existing.UpdateType === prior.updateType && Boolean(existing.AutoUpdate) === prior.autoUpdate;
    check(exactCurrentCore || exactPriorCore, `${ref}: refusing a concurrently rewired Link`);
    check(hasExactImportOwnership(existing, plan.labels.ImportName, plan.labels.PlatformDigest) || isPriorTransitionOwned(existing, transition, "link", ref) || isCanonicalUnownedUpgradeTransition(existing, plan, from, to, toSpace), `${ref}: refusing an unowned or concurrently rewired Link`);
  }
  const expectedAnnotations = {
    ...(plan.annotations ?? {}),
    ...(plan.reasons?.length ? { "import.confighub.com/reason": plan.reasons.join(";").replaceAll(",", ";").replaceAll("=", ":") } : {}),
  };
  const needsUpdate = !existing
    || existing.FromUnitID !== from.UnitID
    || existing.ToUnitID !== to.UnitID
    || existing.ToSpaceID !== toSpace.SpaceID
    || existing.UpdateType !== plan.updateType
    || existing.AutoUpdate === true
    || !mapContains(existing.Labels, plan.labels)
    || !mapContains(existing.Annotations, expectedAnnotations)
    || staleOwnedKeys(existing.Labels, plan.labels, OWNED_LINK_LABELS).length
    || staleOwnedKeys(existing.Annotations, expectedAnnotations, OWNED_ANNOTATIONS).length;
  if (!needsUpdate) return;
  const command = existing ? "update" : "create";
  client.mutate([
    "link", command, "--space", plan.space,
    plan.slug, plan.fromUnit, plan.toUnit, plan.toSpace,
    "--update-type", plan.updateType,
    "--make-current", "--no-auto-update",
    ...labelsArgs(plan.labels),
    ...staleOwnedKeys(existing?.Labels, plan.labels, OWNED_LINK_LABELS).flatMap((key) => ["--label", `${key}=-`]),
    ...annotationsArgs(expectedAnnotations),
    ...staleOwnedKeys(existing?.Annotations, expectedAnnotations, OWNED_ANNOTATIONS).flatMap((key) => ["--annotation", `${key}=-`]),
    "--wait", "--quiet",
  ]);
  recordApplyAction(state, `link-${command}`, `${plan.space}/${plan.slug}`);
}

function ensurePublishedRelease(client, space, state) {
  const units = client.listUnits(space);
  check(units.length > 0, `${space}: refusing to publish an empty Space release`);
  const unreleased = units.some((unit) => Number(unit.HeadRevisionNum ?? 0) !== Number(unit.LastReleasedRevisionNum ?? 0));
  const releases = client.listPublishedReleases(space);
  if (!unreleased && releases.length > 0) return latestReleaseRow(releases);
  const boundary = releaseBoundary(units);
  let result;
  try {
    result = client.mutate(["release", "publish", space, "-o", "json"], { json: true, timeout: 1_200_000 });
  } catch (error) {
    if (!isUnchangedReleaseError(error)) throw error;
    const latest = latestReleaseRow(client.listPublishedReleases(space));
    check(latest, `${space}: ConfigHub reported an unchanged bundle but no published release exists`);
    const after = client.listUnits(space);
    check(stableJson(releaseBoundary(after)) === stableJson(boundary), `${space}: Unit identity, data, or head changed during unchanged-bundle recovery`);
    check(after.every((unit) => Number(unit.HeadRevisionNum ?? 0) === Number(unit.LastReleasedRevisionNum ?? 0)), `${space}: ConfigHub reported an unchanged bundle while Unit heads remain unreleased`);
    validatePublishedRelease(space, latest, "reused unchanged-bundle release");
    return latest;
  }
  const release = unwrapEntity(result, "Release");
  const latest = release?.ManifestDigest ? release : latestReleaseRow(client.listPublishedReleases(space));
  validatePublishedRelease(space, latest, "published release");
  recordApplyAction(state, "release-publish", space, latest.ManifestDigest);
  return latest;
}

function releaseBoundary(units) {
  return units.map((unit) => ({ slug: unit.Slug, unitID: unit.UnitID, dataHash: unit.DataHash, headRevisionNum: Number(unit.HeadRevisionNum ?? 0) }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function isUnchangedReleaseError(error) {
  return error instanceof Error && error.message.includes(UNCHANGED_RELEASE_ERROR);
}

function validatePublishedRelease(space, release, label) {
  check(/^sha256:[0-9a-f]{64}$/.test(release?.Digest ?? ""), `${space}: ${label} bundle digest is missing`);
  check(/^sha256:[0-9a-f]{64}$/.test(release?.ManifestDigest ?? ""), `${space}: ${label} OCI manifest digest is missing`);
}

function latestReleaseRow(rows) {
  return [...rows].sort((left, right) => Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0) || String(right.CreatedAt ?? "").localeCompare(String(left.CreatedAt ?? "")))[0] ?? null;
}

function verifyAppliedImport({ compiled, client, expected, consumed, attestation, transition = null }) {
  preflightOrganization({ compiled, client, expected, transition });
  const deliveryInfrastructureComponents = verifyPinnedDeliveryMetadata(compiled, client);
  const spaces = [];
  const targetSpaces = [];
  const units = [];
  const links = [];
  const releases = [];
  const deliveryApplications = [];
  const deliveryRootReleases = [];
  const argobotReleases = [];
  const preservedWorkloadApplications = [];
  for (const plan of compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding)) {
    const live = client.getSpace(plan.slug);
    check(live?.SpaceID === plan.expectedSpaceID, `${plan.slug}: exact target Space identity differs after apply`);
    check(mapContains(live.Labels, plan.labels), `${plan.slug}: target Space GUI labels did not converge`);
    check(staleOwnedKeys(live.Labels, plan.labels, PINNED_GUI_LABELS).length === 0, `${plan.slug}: target Space retains stale importer GUI taxonomy labels`);
    targetSpaces.push({ slug: plan.slug, spaceID: live.SpaceID, targetID: plan.expectedTargetID, lane: live.Labels.Lane });
  }
  for (const plan of compiled.plan.spec.configHub.spaces.filter((row) => !row.externalBinding)) {
    const live = client.getSpace(plan.slug);
    check(live, `${plan.slug}: managed Space is missing after apply`);
    check(mapContains(live.Labels, plan.labels), `${plan.slug}: managed Space labels did not converge`);
    check(staleOwnedKeys(live.Labels, plan.labels, OWNED_SPACE_LABELS).length === 0, `${plan.slug}: managed Space retains stale importer-owned labels`);
    check(mapContains(live.Annotations, plan.annotations ?? {}), `${plan.slug}: managed Space annotations did not converge`);
    spaces.push({ slug: plan.slug, spaceID: live.SpaceID, role: plan.role });
  }
  const plansBySpace = groupBy(compiled.plan.spec.configHub.units, (row) => row.space);
  for (const [space, plans] of plansBySpace) {
    const liveRows = client.listUnits(space);
    check(stableJson(liveRows.map((row) => row.Slug).sort()) === stableJson(plans.map((row) => row.slug).sort()), `${space}: exact Unit allowlist did not converge`);
    for (const plan of plans) {
      const live = client.getUnit(space, plan.slug);
      const payload = expected.get(`${space}/${plan.slug}`);
      check(live && payload, `${space}/${plan.slug}: Unit or expected payload is missing`);
      check(sameUnitData(plan.toolchain, client.unitData(space, plan.slug), payload.text), `${space}/${plan.slug}: Unit data differs from the pulled OCI payload`);
      check(mapContains(live.Labels, plan.labels) && staleOwnedKeys(live.Labels, plan.labels, OWNED_UNIT_LABELS).length === 0, `${space}/${plan.slug}: Unit labels did not converge`);
      check(mapContains(live.Annotations, payload.annotations) && staleOwnedKeys(live.Annotations, payload.annotations, OWNED_ANNOTATIONS).length === 0, `${space}/${plan.slug}: Unit provenance annotations did not converge`);
      if (plan.upstream) {
        const [upstreamSpace, upstreamSlug] = plan.upstream.split("/");
        check(live.UpstreamUnitID === client.getUnit(upstreamSpace, upstreamSlug)?.UnitID, `${space}/${plan.slug}: UpgradeUnit lineage did not converge`);
      }
      if (plan.target) check(live.TargetID === requestTargetByRef(compiled.execution.request, plan.target).targetID, `${space}/${plan.slug}: exact Target binding did not converge`);
      else check(!live.TargetID, `${space}/${plan.slug}: untargeted Unit gained a Target`);
      units.push({
        ref: `${space}/${plan.slug}`,
        unitID: live.UnitID,
        dataHash: live.DataHash,
        dataSHA256: sha256(client.unitData(space, plan.slug)),
        headRevisionNum: live.HeadRevisionNum,
        lastAppliedRevisionNum: live.LastReleasedRevisionNum,
        targetID: live.TargetID ?? null,
        upstreamUnitID: live.UpstreamUnitID ?? null,
      });
    }
  }
  const linkPlansBySpace = groupBy(compiled.plan.spec.configHub.links, (row) => row.space);
  for (const [space, plans] of linkPlansBySpace) {
    const liveRows = client.listLinks(space);
    check(stableJson(liveRows.map((row) => row.Slug).sort()) === stableJson(plans.map((row) => row.slug).sort()), `${space}: exact Link allowlist did not converge`);
    for (const plan of plans) {
      const live = liveRows.find((row) => row.Slug === plan.slug);
      const from = client.getUnit(space, plan.fromUnit);
      const to = client.getUnit(plan.toSpace, plan.toUnit);
      check(live?.UpdateType === plan.updateType && live.AutoUpdate !== true, `${space}/${plan.slug}: Link semantics did not converge`);
      check(live.FromUnitID === from?.UnitID && live.ToUnitID === to?.UnitID && live.ToSpaceID === client.getSpace(plan.toSpace)?.SpaceID, `${space}/${plan.slug}: Link endpoints did not converge`);
      const expectedAnnotations = {
        ...(plan.annotations ?? {}),
        ...(plan.reasons?.length ? { "import.confighub.com/reason": plan.reasons.join(";").replaceAll(",", ";").replaceAll("=", ":") } : {}),
      };
      check(mapContains(live.Labels, plan.labels) && staleOwnedKeys(live.Labels, plan.labels, OWNED_LINK_LABELS).length === 0, `${space}/${plan.slug}: Link labels did not converge`);
      check(mapContains(live.Annotations, expectedAnnotations) && staleOwnedKeys(live.Annotations, expectedAnnotations, OWNED_ANNOTATIONS).length === 0, `${space}/${plan.slug}: Link annotations did not converge`);
      links.push({
        ref: `${space}/${plan.slug}`,
        linkID: live.LinkID,
        updateType: live.UpdateType,
        autoUpdate: Boolean(live.AutoUpdate),
        fromUnitID: live.FromUnitID,
        toUnitID: live.ToUnitID,
        toSpaceID: live.ToSpaceID,
        ownedLabels: ownedProjection(live.Labels, OWNED_LINK_LABELS),
        ownedAnnotations: ownedProjection(live.Annotations, OWNED_ANNOTATIONS),
      });
    }
  }
  for (const plan of compiled.plan.spec.configHub.deliveryApplications) {
    const live = client.getUnit(plan.space, plan.slug);
    const payload = expected.get(`${plan.space}/${plan.slug}`);
    check(live && payload, `${plan.space}/${plan.slug}: platform delivery Application is missing`);
    check(live.TargetID === requestTargetByRef(compiled.execution.request, plan.target).targetID && !live.UpstreamUnitID, `${plan.space}/${plan.slug}: platform delivery target/lineage differs`);
    check(sameUnitData("Kubernetes/YAML", client.unitData(plan.space, plan.slug), payload.text), `${plan.space}/${plan.slug}: platform delivery Application data differs from the pulled aggregate OCI plan`);
    check(mapContains(live.Labels, plan.labels) && staleOwnedKeys(live.Labels, plan.labels, OWNED_UNIT_LABELS).length === 0, `${plan.space}/${plan.slug}: platform delivery labels did not converge`);
    check(mapContains(live.Annotations, payload.annotations), `${plan.space}/${plan.slug}: platform delivery provenance did not converge`);
    const sourceRelease = latestReleaseRow(client.listPublishedReleases(plan.sourceSpace));
    validatePublishedRelease(plan.sourceSpace, sourceRelease, "platform delivery source release");
    const application = parseDocs(client.unitData(plan.space, plan.slug))[0];
    check(application?.spec?.source?.targetRevision === sourceRelease.ManifestDigest, `${plan.space}/${plan.slug}: platform delivery Application does not authorize the exact source release manifest digest`);
    check(!Object.hasOwn(application?.spec?.syncPolicy ?? {}, "automated"), `${plan.space}/${plan.slug}: platform delivery Application enables automated sync`);
    deliveryApplications.push({
      ref: `${plan.space}/${plan.slug}`,
      unitID: live.UnitID,
      sourceSpace: plan.sourceSpace,
      sourceReleaseManifestDigest: sourceRelease.ManifestDigest,
      automatedSync: false,
      targetID: live.TargetID,
      dataHash: live.DataHash,
      dataSHA256: sha256(client.unitData(plan.space, plan.slug)),
      headRevisionNum: live.HeadRevisionNum,
      lastAppliedRevisionNum: live.LastReleasedRevisionNum,
    });
  }
  for (const appsSpace of [...new Set(compiled.plan.spec.configHub.deliveryApplications.map((row) => row.space))].sort()) {
    const liveUnits = client.listUnits(appsSpace);
    check(liveUnits.every((unit) => Number(unit.HeadRevisionNum ?? 0) === Number(unit.LastReleasedRevisionNum ?? 0)), `${appsSpace}: delivery root Unit heads remain unpublished`);
    const release = latestReleaseRow(client.listPublishedReleases(appsSpace));
    check(/^sha256:[0-9a-f]{64}$/.test(release?.Digest ?? "") && /^sha256:[0-9a-f]{64}$/.test(release?.ManifestDigest ?? ""), `${appsSpace}: delivery root release evidence is missing`);
    deliveryRootReleases.push({ space: appsSpace, releaseNum: release.ReleaseNum, bundleDigest: release.Digest, manifestDigest: release.ManifestDigest });
  }
  for (const cluster of compiled.plan.spec.configHub.deliveryInfrastructure.clusters) {
    const release = latestReleaseRow(client.listPublishedReleases(cluster.argobot.space));
    validatePublishedRelease(cluster.argobot.space, release, "request-pinned argobot release");
    argobotReleases.push({ space: cluster.argobot.space, releaseNum: release.ReleaseNum, bundleDigest: release.Digest, manifestDigest: release.ManifestDigest });
    for (const workload of cluster.workloadApplications ?? []) {
      const unit = client.getUnit(cluster.appsSpace, workload.unit);
      preservedWorkloadApplications.push({ ref: `${cluster.appsSpace}/${workload.unit}`, unitID: unit.UnitID, dataHash: unit.DataHash, dataSHA256: sha256(client.unitData(cluster.appsSpace, workload.unit)), headRevisionNum: unit.HeadRevisionNum, lastAppliedRevisionNum: unit.LastReleasedRevisionNum, sourceSpace: workload.sourceSpace, sourceUnitID: workload.sourceUnitID, sourceReleaseManifestDigest: workload.sourceReleaseManifestDigest });
    }
  }
  for (const plan of compiled.plan.spec.oci.configReleases) {
    const liveUnits = client.listUnits(plan.releaseSpace);
    check(liveUnits.every((unit) => Number(unit.HeadRevisionNum ?? 0) === Number(unit.LastReleasedRevisionNum ?? 0)), `${plan.releaseSpace}: Unit heads remain unpublished`);
    const release = latestReleaseRow(client.listPublishedReleases(plan.releaseSpace));
    check(/^sha256:[0-9a-f]{64}$/.test(release?.Digest ?? "") && /^sha256:[0-9a-f]{64}$/.test(release?.ManifestDigest ?? ""), `${plan.releaseSpace}: exact ConfigHub release evidence is missing`);
    releases.push({ space: plan.releaseSpace, releaseNum: release.ReleaseNum, bundleDigest: release.Digest, manifestDigest: release.ManifestDigest });
  }
  return {
    targetSpaces,
    deliveryInfrastructureComponents,
    organization: {
      context: compiled.execution.request.spec.destination.context,
      name: compiled.execution.request.spec.destination.organization,
      externalID: compiled.execution.request.spec.destination.organizationExternalID,
      organizationID: compiled.execution.request.spec.destination.organizationID,
      serverURL: compiled.execution.request.spec.destination.serverURL,
    },
    spaces: spaces.sort((left, right) => left.slug.localeCompare(right.slug)),
    units: units.sort((left, right) => left.ref.localeCompare(right.ref)),
    links: links.sort((left, right) => left.ref.localeCompare(right.ref)),
    releases: releases.sort((left, right) => left.space.localeCompare(right.space)),
    deliveryApplications: deliveryApplications.sort((left, right) => left.ref.localeCompare(right.ref)),
    deliveryRootReleases,
    argobotReleases,
    preservedWorkloadApplications,
    targets: attestation.spec.bindings.map((row) => ({ cluster: row.cluster, space: row.space, spaceID: row.spaceID, target: row.target, targetID: row.targetID, delivery: row.delivery })),
    packages: consumed.receipt.spec.members.map((row) => ({ id: row.id, ref: row.ref, manifestDigest: row.manifestDigest, layerDigest: row.layerDigest })),
    platformIndex: {
      ref: consumed.receipt.spec.aggregate.ref,
      manifestDigest: consumed.receipt.spec.aggregate.manifestDigest,
      layerDigest: consumed.receipt.spec.aggregate.layerDigest,
    },
    delivery: {
      state: "platform-delivery-materialized-root-and-source-releases-published-awaiting-cluster-convergence",
      platformSourceReleasesPublished: releases.length,
      platformDeliveryApplicationsMaterialized: deliveryApplications.length,
      deliveryRootReleasesPublished: deliveryRootReleases.length,
      clusterConvergenceClaim: false,
      userWorkloadApplicationsIncluded: preservedWorkloadApplications.length > 0,
      preservedUserWorkloadApplicationCount: preservedWorkloadApplications.length,
    },
    guiIdentity: {
      startHereSpace: `${compiled.execution.request.spec.destination.spacePrefix}-platform`,
      componentLabel: "Component",
      ownerLabel: "Owner",
      variantLabel: "Variant",
      definitionLineage: "DefinitionSpace+InstanceOf+UpgradeUnit",
      wiringLinkType: "NeedsProvides",
      publicNavigation: navigationAnnotations(compiled.execution.request),
    },
  };
}

function updateApplyReceipt({ compiled, outputRoot, context, attestation, state, observation, consumed, transition = null }) {
  const path = join(outputRoot, "apply-receipt.json");
  const packageReceiptSHA256 = sha256(`${JSON.stringify(consumed.receipt, null, 2)}\n`);
  const targetFactAttestationSHA256 = sha256(stableJson(attestation));
  const observationSHA256 = sha256(stableJson(observation));
  const actions = state.actions.map((row) => ({ ...row }));
  let previous = null;
  if (existsSync(path)) {
    check(!lstatSync(path).isSymbolicLink(), "existing apply receipt must not be a symbolic link");
    previous = readJson(path);
    validatePriorApplyReceipt({
      previous,
      compiled,
      context,
      observation,
      packageReceiptSHA256,
      targetFactAttestationSHA256,
      requireObservationMatch: actions.length === 0 && previous.spec?.bindingDigest === compiled.plan.spec.bindingDigest,
    });
  }
  const bindingChanged = previous && (
    previous.spec.bindingDigest !== compiled.plan.spec.bindingDigest
    || previous.spec.packageReceiptSHA256 !== packageReceiptSHA256
    || previous.spec.targetFactAttestationSHA256 !== targetFactAttestationSHA256
  );
  if (previous?.status?.result === "pass" && actions.length === 0 && !bindingChanged) {
    return previous;
  }
  check(!(previous?.status?.result === "pending-second-zero-action-run" && bindingChanged), "existing pending apply receipt is stale for the current package or target-fact attestation; refusing to carry its first run");
  const priorRuns = previous?.spec?.runs ?? [];
  const reset = !previous || actions.length > 0 || previous.status.result === "pass" || bindingChanged;
  const nextNumber = reset ? 1 : priorRuns.length + 1;
  const run = applyReceiptRun({ number: nextNumber, actions, packageReceiptSHA256, targetFactAttestationSHA256, observationSHA256 });
  const runs = reset ? [run] : [...priorRuns, run];
  const secondZero = runs.length >= 2 && runs.at(-1).actionCount === 0;
  const claimBoundary = applyReceiptClaimBoundary();
  const receipt = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraConfigHubApplyReceipt",
    metadata: { name: compiled.plan.metadata.name },
    spec: {
      platformDigest: compiled.lock.spec.platformDigest,
      bindingDigest: compiled.plan.spec.bindingDigest,
      transitionAuthority: transition ? {
        fromPlatformDigest: transition.fromPlatformDigest,
        fromBindingDigest: transition.fromBindingDigest,
        previousApplyReceiptSHA256: transition.previousApplyReceiptSHA256,
        policy: transition.policy,
      } : null,
      organization: observation.organization,
      packageReceiptSHA256,
      targetFactAttestationSHA256,
      runs,
      observation,
      claimBoundary,
    },
    status: {
      result: secondZero ? "pass" : "pending-second-zero-action-run",
      lastActionCount: actions.length,
      secondRunZeroActions: secondZero,
      exactPackageReuseOrRefuse: "pass",
      organizationProtection: "pass",
      targetBindingsExternalToGitAndOCI: "pass",
      localReceiptCryptographicProof: false,
    },
  };
  writeJsonExact(path, receipt);
  return receipt;
}

function applyReceiptRun({ number, actions, packageReceiptSHA256, targetFactAttestationSHA256, observationSHA256 }) {
  const row = { number, actionCount: actions.length, actions, packageReceiptSHA256, targetFactAttestationSHA256, observationSHA256 };
  return { ...row, runDigest: `sha256:${sha256(stableJson(row))}` };
}

function applyReceiptClaimBoundary() {
  return [
    "The exact packaged component/config layers were pulled and verified before ConfigHub mutation.",
    "The selected existing context, Organization entity, target Spaces, Targets, and exact bootstrap Unit bytes were pinned and rechecked.",
    "Each apply requires exclusive serialized control of importer-managed topology and request-pinned bootstrap/workload heads; cub mutations are not cross-client transactional conditional writes.",
    "The receipt proves ConfigHub Spaces, Units, UpgradeUnit/NeedsProvides Links, platform delivery Applications, delivery-root releases, and source Space releases.",
    "Every importer-managed platform delivery Application names the exact current source release ManifestDigest and has no automated sync field; mutable latest and retained release tags are not deployment authority.",
    "Argo prune is enabled: removing objects from a reviewed source release can delete those objects from a cluster after sync; the importer itself issues no delete operation.",
    "Cluster convergence and health at the exact source release manifest digests require the subsequent explicit live verify and are not claimed here.",
    "Request-pinned user workload Applications are preserved exactly when present; creating or promoting them remains a separate app workflow.",
    "This local receipt is a deterministic continuity check, not a server-signed or cryptographically tamper-proof attestation.",
  ];
}

function applyReceiptClaimBoundaryV1() {
  return [
    "The exact packaged component/config layers were pulled and verified before ConfigHub mutation.",
    "The selected existing context, Organization entity, target Spaces, Targets, and exact bootstrap Unit bytes were pinned and rechecked.",
    "Each apply requires exclusive serialized control of importer-managed topology and request-pinned bootstrap/workload heads; cub mutations are not cross-client transactional conditional writes.",
    "The receipt proves ConfigHub Spaces, Units, UpgradeUnit/NeedsProvides Links, platform delivery Applications, delivery-root releases, and source Space releases.",
    "Argo prune is enabled: removing objects from a reviewed source release can delete those objects from a cluster after sync; the importer itself issues no delete operation.",
    "Cluster convergence and health at the exact source release manifest digests require the subsequent explicit live verify and are not claimed here.",
    "Request-pinned user workload Applications are preserved exactly when present; creating or promoting them remains a separate app workflow.",
    "This local receipt is a deterministic continuity check, not a server-signed or cryptographically tamper-proof attestation.",
  ];
}

function validatePriorApplyReceipt({ previous, compiled, context, observation, packageReceiptSHA256, targetFactAttestationSHA256, requireObservationMatch }) {
  checkExactKeys(previous, ["apiVersion", "kind", "metadata", "spec", "status"], "existing apply receipt");
  check(previous.apiVersion === "import.confighub.com/v1alpha1" && previous.kind === "KubaraConfigHubApplyReceipt", "existing apply receipt apiVersion/kind is invalid");
  checkExactKeys(previous.metadata, ["name"], "existing apply receipt metadata");
  check(previous.metadata.name === compiled.plan.metadata.name, "existing apply receipt name differs from the import");
  checkExactKeys(previous.spec, ["platformDigest", "bindingDigest", "transitionAuthority", "organization", "packageReceiptSHA256", "targetFactAttestationSHA256", "runs", "observation", "claimBoundary"], "existing apply receipt spec");
  check(previous.spec.platformDigest === compiled.lock.spec.platformDigest, "existing apply receipt belongs to another platform digest");
  check(previous.spec.bindingDigest === compiled.plan.spec.bindingDigest || previous.status.result === "pass", "existing pending apply receipt belongs to another destination binding digest");
  const expectedTransitionAuthority = compiled.execution.request.spec.transition ?? null;
  check(stableJson(previous.spec.transitionAuthority) === stableJson(expectedTransitionAuthority), "existing apply receipt transition authority differs from the exact request");
  check(stableJson(previous.spec.organization) === stableJson(observation.organization) && previous.spec.organization.context === context, "existing apply receipt organization coordinate differs from the current exact observation");
  const destination = compiled.execution.request.spec.destination;
  check(previous.spec.organization.context === destination.context
    && previous.spec.organization.name === destination.organization
    && previous.spec.organization.externalID === destination.organizationExternalID
    && previous.spec.organization.organizationID === destination.organizationID
    && previous.spec.organization.serverURL === destination.serverURL, "existing apply receipt organization coordinate differs from the exact destination request");
  check(stableJson(previous.spec.claimBoundary) === stableJson(applyReceiptClaimBoundary()), "existing apply receipt claim boundary is stale or modified");
  checkExactKeys(previous.status, ["result", "lastActionCount", "secondRunZeroActions", "exactPackageReuseOrRefuse", "organizationProtection", "targetBindingsExternalToGitAndOCI", "localReceiptCryptographicProof"], "existing apply receipt status");
  check(["pending-second-zero-action-run", "pass"].includes(previous.status.result), "existing apply receipt status result is invalid");
  check(previous.status.exactPackageReuseOrRefuse === "pass" && previous.status.organizationProtection === "pass" && previous.status.targetBindingsExternalToGitAndOCI === "pass" && previous.status.localReceiptCryptographicProof === false, "existing apply receipt status gates differ");
  check(Array.isArray(previous.spec.runs) && previous.spec.runs.length >= 1 && previous.spec.runs.length <= 2, "existing apply receipt run inventory is invalid");
  for (const [index, run] of previous.spec.runs.entries()) {
    checkExactKeys(run, ["number", "actionCount", "actions", "packageReceiptSHA256", "targetFactAttestationSHA256", "observationSHA256", "runDigest"], `existing apply receipt run ${index + 1}`);
    check(run.number === index + 1 && Array.isArray(run.actions) && run.actionCount === run.actions.length, `existing apply receipt run ${index + 1} sequence/action count is invalid`);
    for (const action of run.actions) {
      const keys = Object.hasOwn(action, "detail") ? ["type", "ref", "detail"] : ["type", "ref"];
      checkExactKeys(action, keys, `existing apply receipt run ${index + 1} action`);
      check(typeof action.type === "string" && typeof action.ref === "string", `existing apply receipt run ${index + 1} action is invalid`);
    }
    const unsigned = { number: run.number, actionCount: run.actionCount, actions: run.actions, packageReceiptSHA256: run.packageReceiptSHA256, targetFactAttestationSHA256: run.targetFactAttestationSHA256, observationSHA256: run.observationSHA256 };
    check(run.runDigest === `sha256:${sha256(stableJson(unsigned))}`, `existing apply receipt run ${index + 1} digest is invalid`);
  }
  const last = previous.spec.runs.at(-1);
  check(previous.status.lastActionCount === last.actionCount, "existing apply receipt lastActionCount differs from its last run");
  if (previous.status.result === "pass") check(previous.spec.runs.length === 2 && last.actionCount === 0 && previous.status.secondRunZeroActions === true, "existing passing apply receipt lacks the exact second zero-action run");
  else check(previous.spec.runs.length === 1 && previous.status.secondRunZeroActions === false, "existing pending apply receipt run/status shape is invalid");
  const bindingMatches = previous.spec.packageReceiptSHA256 === packageReceiptSHA256 && previous.spec.targetFactAttestationSHA256 === targetFactAttestationSHA256;
  if (previous.status.result === "pending-second-zero-action-run") check(bindingMatches, "existing pending apply receipt is stale for the current package or target-fact attestation");
  if (bindingMatches) {
    check(last.packageReceiptSHA256 === packageReceiptSHA256 && last.targetFactAttestationSHA256 === targetFactAttestationSHA256, "existing apply receipt last run is not bound to the current package/attestation");
  }
  if (requireObservationMatch) check(stableJson(previous.spec.observation) === stableJson(observation), "existing apply receipt observation differs from current exact live state");
  check(last.observationSHA256 === sha256(stableJson(previous.spec.observation)), "existing apply receipt last run observation digest differs");
}

function recordApplyAction(state, type, ref, detail = "") {
  state.actions.push({ type, ref, ...(detail ? { detail } : {}) });
}

function createCubClient(context, destination) {
  const contextArgs = ["--context", context];
  const run = (commandArgs, options = {}) => {
    const result = commandResult("cub", [...contextArgs, ...commandArgs], { timeout: options.timeout });
    if (!result.ok) {
      if (options.allowNotFound && isNotFoundOutput(result.output)) return null;
      throw new Error(`cub ${commandArgs.join(" ")} failed\n${result.output}`);
    }
    if (!options.json) return result.output;
    try { return JSON.parse(result.output); } catch (error) { throw new Error(`cub ${commandArgs.join(" ")} returned invalid JSON: ${error.message}`); }
  };
  const assertExactCoordinate = () => {
    const coordinate = parseCubContext(run(["context", "get"]));
    check(coordinate.name === context, `cub context drifted from ${context} to ${coordinate.name || "unknown"}`);
    check(coordinate.organizationName === destination.organization, `refusing cub organization ${coordinate.organizationName || "unknown"}; expected ${destination.organization}`);
    check(coordinate.organizationExternalID === destination.organizationExternalID, `refusing ConfigHub external organization ID ${coordinate.organizationExternalID || "unknown"}`);
    check(coordinate.serverURL === destination.serverURL.replace(/\/$/, ""), `refusing ConfigHub server ${coordinate.serverURL || "unknown"}; expected ${destination.serverURL}`);
    const orgRows = unwrapRows(run([
      "organization", "list", "--where", `ExternalID = '${destination.organizationExternalID}'`,
      "--select", "DisplayName,ExternalID,OrganizationID", "-o", "json",
    ], { json: true }), "Organization");
    check(orgRows.length === 1, `expected exactly one Organization entity for ${destination.organizationExternalID}`);
    const organization = orgRows[0];
    check(organization.DisplayName === destination.organization && organization.ExternalID === destination.organizationExternalID && organization.OrganizationID === destination.organizationID, "request-pinned ConfigHub Organization entity coordinate drifted");
  };
  const client = {
    request: { spec: { targets: {} } },
    assertExactCoordinate,
    assertVersion() {
      const output = run(["version"]);
      const clientVersion = output.match(/Client Version:[\s\S]*?Version:\s+v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "";
      const serverVersion = output.match(/Server Version:[\s\S]*?Version:\s+v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "";
      check(clientVersion && versionAtLeast(clientVersion, MIN_CUB_VERSION), `cub client v${clientVersion || "unknown"} is older than required v${MIN_CUB_VERSION}`);
      check(serverVersion && versionAtLeast(serverVersion, MIN_CUB_VERSION), `ConfigHub server v${serverVersion || "unknown"} is older than required v${MIN_CUB_VERSION}`);
    },
    listSpaces() { return unwrapRows(run(["space", "list", "--select", "Slug,SpaceID,Labels,Annotations,OrganizationID,ReleaseTargetID", "-o", "json"], { json: true }), "Space"); },
    getSpace(space) { const row = run(["space", "get", space, "-o", "json"], { json: true, allowNotFound: true }); return row ? unwrapEntity(row, "Space") : null; },
    listUnits(space) { return unwrapRows(run(["unit", "list", "--space", space, "--select", "Slug,UnitID,Labels,Annotations,TargetID,UpstreamUnitID,ToolchainType,ProviderType,DataHash,HeadRevisionNum,LastReleasedRevisionNum", "-o", "json"], { json: true }), "Unit"); },
    getUnit(space, slug) {
      const rows = unwrapRows(run([
        "unit", "list", "--space", space, "--where", `Slug = '${slug}'`,
        "--select", "Slug,UnitID,Labels,Annotations,TargetID,UpstreamUnitID,ToolchainType,ProviderType,DataHash,HeadRevisionNum,LastReleasedRevisionNum", "-o", "json",
      ], { json: true }), "Unit");
      check(rows.length <= 1, `${space}/${slug}: narrow Unit identity query returned ${rows.length} rows`);
      return rows[0] ?? null;
    },
    unitData(space, slug) {
      const result = commandResult("cub", [...contextArgs, "unit", "data", "--space", space, slug]);
      check(result.ok, `cub unit data --space ${space} ${slug} failed\n${result.output}`);
      return result.stdout;
    },
    listLinks(space) { return unwrapRows(run(["link", "list", "--space", space, "--select", "Slug,LinkID,FromUnitID,ToUnitID,ToSpaceID,UpdateType,AutoUpdate,Labels,Annotations", "-o", "json"], { json: true }), "Link"); },
    getTarget(space, slug) {
      const rows = unwrapRows(run([
        "target", "list", "--space", space, "--where", `Slug = '${slug}'`,
        "--select", "Slug,TargetID,SpaceID,ProviderType,ToolchainType,Annotations", "-o", "json",
      ], { json: true }), "Target");
      check(rows.length <= 1, `${space}/${slug}: narrow Target identity query returned ${rows.length} rows`);
      return rows[0] ?? null;
    },
    listPublishedReleases(space) { return unwrapRows(run(["release", "list", "--space", space, "--where", "Published = true", "--select", "Digest,ManifestDigest,ReleaseNum,CreatedAt", "-o", "json"], { json: true }), "Release"); },
    mutate(commandArgs, options = {}) { assertExactCoordinate(); return run(commandArgs, options); },
  };
  client.request = { spec: { targets: destination.__targets ?? {} } };
  return client;
}

function parseCubContext(text) {
  return {
    name: text.match(/^Context Name\s+(\S+)\s*$/mi)?.[1] ?? "",
    organizationExternalID: text.match(/^Organization ID\s+([0-9a-f-]+)\s*$/mi)?.[1] ?? "",
    organizationName: text.match(/^Organization Name\s+(.+?)\s*$/mi)?.[1] ?? "",
    serverURL: text.match(/^Server URL\s+(\S+)\s*$/mi)?.[1]?.replace(/\/$/, "") ?? "",
  };
}

function selfTest() {
  credentialScannerSelfTest();
  const fixture = resolve("examples/kubara/current-platform");
  check(existsSync(fixture), "current Kubara v0.13.0 fixture is missing");
  const tempRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-git-import-"));
  try {
    const checkout = join(tempRoot, "checkout");
    const platform = join(checkout, "platform");
    cpSync(fixture, platform, { recursive: true });
    mkdirSync(join(platform, "wiring"), { recursive: true });
    cpSync(resolve("data/kubara-wiring/graph.json"), join(platform, "wiring", "graph.json"));
    gitInit(checkout, "https://example.invalid/acme/kubara-platform.git");
    let commit = commitAll(checkout, "fixture");
    const requestPath = join(tempRoot, "request.yaml");
    const output = join(tempRoot, "output");
    const request = fixtureRequest(commit);
    writeFileSync(requestPath, `${toYaml(request)}\n`);
    expectFailure(
      () => compileImport({ requestPath, checkoutRoot: checkout }),
      /target facts must be supplied at target-binding time/,
      "current test-only target-fact-in-Git refusal",
    );
    rmSync(join(platform, "target-facts"), { recursive: true, force: true });
    commit = commitAll(checkout, "externalize target facts");
    pinFixtureCommit(request, commit);
    writeFileSync(requestPath, `${toYaml(request)}\n`);
    expectFailure(
      () => compileImport({ requestPath, checkoutRoot: checkout }),
      /credential-shaped material is forbidden/,
      "current test-only application credential refusal",
    );
    rmSync(join(platform, "apps"), { recursive: true, force: true });
    commit = commitAll(checkout, "externalize application credentials and sources");
    pinFixtureCommit(request, commit);
    writeFileSync(requestPath, `${toYaml(request)}\n`);
    let compiled = compileImport({ requestPath, checkoutRoot: checkout });
    const duplicateArtifactLock = readYaml(join(platform, "component-artifacts.yaml"));
    const conflictingArtifact = structuredClone(duplicateArtifactLock.spec.artifacts[0]);
    conflictingArtifact.sha256 = "e".repeat(64);
    duplicateArtifactLock.spec.artifacts.push(conflictingArtifact);
    expectFailure(
      () => discoverComponents(join(platform, "generated/platform-components/helm"), duplicateArtifactLock),
      /duplicate or conflicting semantic key/,
      "conflicting duplicate exact artifact-lock refusal",
    );
    const duplicateFirstPartyLock = readYaml(join(platform, "component-artifacts.yaml"));
    duplicateFirstPartyLock.spec.firstParty.push({ ...structuredClone(duplicateFirstPartyLock.spec.firstParty[0]), canonicalIdentity: "kubara:homer-dashboard-alias" });
    expectFailure(
      () => discoverComponents(join(platform, "generated/platform-components/helm"), duplicateFirstPartyLock),
      /duplicate or ambiguous first-party artifact locks/,
      "ambiguous first-party artifact-lock refusal",
    );
    const duplicateRenderReceipt = readYaml(join(platform, "generation-receipt.yaml"));
    duplicateRenderReceipt.spec.outputs.renders.push({ ...structuredClone(duplicateRenderReceipt.spec.outputs.renders[0]), sha256: "d".repeat(64) });
    const duplicateRenderReceiptPath = join(tempRoot, "duplicate-render-receipt.yaml");
    writeFileSync(duplicateRenderReceiptPath, `${toYaml(duplicateRenderReceipt)}\n`);
    expectFailure(
      () => discoverInstances({ ...compiled.execution.inputPaths, generationReceipt: duplicateRenderReceiptPath }, compiled.plan.spec.topology, compiled.execution.components, request.spec.destination.deliveryMode),
      /generation receipt render cluster\/service contains duplicate or conflicting semantic key/,
      "conflicting duplicate generation-render receipt refusal",
    );
    const duplicateArtifactReceipt = readYaml(join(platform, "generation-receipt.yaml"));
    duplicateArtifactReceipt.spec.artifacts.push({ ...structuredClone(duplicateArtifactReceipt.spec.artifacts[0]), sha256: "c".repeat(64) });
    const duplicateArtifactReceiptPath = join(tempRoot, "duplicate-artifact-receipt.yaml");
    writeFileSync(duplicateArtifactReceiptPath, `${toYaml(duplicateArtifactReceipt)}\n`);
    expectFailure(
      () => discoverInstances({ ...compiled.execution.inputPaths, generationReceipt: duplicateArtifactReceiptPath }, compiled.plan.spec.topology, compiled.execution.components, request.spec.destination.deliveryMode),
      /generation receipt artifact service\/dependency\/version contains duplicate or conflicting semantic key/,
      "conflicting duplicate generation-artifact receipt refusal",
    );
    const duplicateClusterConfig = readYaml(join(platform, "source/config.yaml"));
    duplicateClusterConfig.clusters.push(structuredClone(duplicateClusterConfig.clusters[0]));
    expectFailure(() => discoverTopology(duplicateClusterConfig, compiled.execution.components, request.spec.targets), /Kubara config cluster name contains duplicate or conflicting semantic key/, "duplicate Kubara cluster refusal");
    const normalizedCollisionComponents = [...compiled.execution.components, { ...compiled.execution.components.find((row) => row.service === "metrics-server"), service: "metricsserver" }];
    expectFailure(() => discoverTopology(readYaml(join(platform, "source/config.yaml")), normalizedCollisionComponents, request.spec.targets), /normalized generated component service contains duplicate or conflicting semantic key/, "normalized component-service collision refusal");
    const trackedSiblingPath = join(platform, "source-lock.yaml");
    const trackedSiblingBytes = readFileSync(trackedSiblingPath);
    const trackedSiblingGitPath = gitPath(checkout, trackedSiblingPath);
    execFileSync("git", ["-C", checkout, "update-index", "--skip-worktree", trackedSiblingGitPath]);
    rmSync(trackedSiblingPath);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /working-tree selected-path inventory differs from exact committed blob inventory/, "sparse or skip-worktree omitted committed sibling refusal");
    writeFileSync(trackedSiblingPath, trackedSiblingBytes);
    execFileSync("git", ["-C", checkout, "update-index", "--no-skip-worktree", trackedSiblingGitPath]);
    check(git(checkout, ["status", "--porcelain=v1", "--untracked-files=all", "--", request.spec.source.path]) === "", "sparse-checkout refusal did not restore the exact fixture");
    check(compiled.plan.spec.topology.clusters.length === 4, "self-test did not preserve four clusters");
    check(compiled.plan.spec.topology.hubs.length === 1 && compiled.plan.spec.topology.spokes.length === 3, "self-test did not preserve one hub and three spokes");
    check(compiled.plan.spec.oci.configReleases.length === 13, "self-test did not produce all 13 component-instance config release plans");
    check(compiled.plan.spec.oci.catalogPackages.filter((row) => row.deployable).length === 7, "self-test did not produce seven deployable component definitions");
    check(compiled.plan.spec.oci.aggregate.members.length === compiled.plan.spec.oci.catalogPackages.length + compiled.plan.spec.oci.configReleases.length, "self-test aggregate did not bind every component definition and effective config set");
    check(stableJson(compiled.plan.spec.oci.aggregate.members) === stableJson([...compiled.plan.spec.oci.catalogPackages, ...compiled.plan.spec.oci.configReleases].map((row) => row.id).sort()), "self-test aggregate member identities differ from the exact package inventory");
    check(compiled.plan.spec.configHub.links.some((row) => row.updateType === "NeedsProvides"), "self-test did not preserve visible provides/needs wiring");
    check(compiled.plan.spec.targetFacts.rows.length > 0 && compiled.plan.spec.targetFacts.rows.every((row) => row.includedInGitOrOCI === false), "self-test did not preserve the external target-fact boundary");
    check(compiled.plan.spec.targetFacts.rows.some((row) => row.status === "external" && row.requiredBeforeApply && row.consumer !== "hx-app-dev/argo-cd"), "self-test did not require an external fact for a targeted adapted-lane consumer");
    check(compiled.plan.spec.targetFacts.rows.filter((row) => row.consumer === "hx-app-dev/argo-cd").every((row) => row.requiredBeforeApply === false), "self-test made retained untargeted faithful-lane facts block adapted-lane apply");
    check(compiled.plan.spec.targetFacts.rows.some((row) => row.status === "optional-unprovided"), "self-test silently dropped optional unprovided wiring evidence");
    check(compiled.plan.spec.boundary.flattenedFleetBundle === false, "self-test flattened the platform");
    check(compiled.plan.spec.boundary.clusterReconcilerPrune === true && compiled.plan.spec.boundary.importerDeleteOperations.length === 0, "self-test did not disclose Argo prune separately from importer delete operations");
    const argoDefinition = compiled.plan.spec.configHub.units.find((row) => row.space.endsWith("-argo-cd-base") && row.slug === "argo-cd");
    check(argoDefinition?.labels.ComponentVersion === "10.2.1" && argoDefinition.labels.WrapperVersion === "1.3.0" && argoDefinition.labels.BundledVersions.includes("template-library@0.2.0"), "self-test GUI identity confuses the exact Argo component version with its Kubara wrapper");
    check(argoDefinition.labels.Lane === "Faithful", "self-test Kubara Argo chart definition is not visibly faithful");
    check(compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding).every((row) => !Object.hasOwn(row.labels, "Component")), "self-test target Spaces leaked into native Components");
    const runtimeDefinition = compiled.plan.spec.configHub.units.find((row) => row.space.endsWith("-argo-runtime-base") && row.slug === "argo-cd-runtime");
    check(
      runtimeDefinition?.labels.Component === "argo-cd"
        && runtimeDefinition.labels.CatalogComponent === "argo-cd"
        && runtimeDefinition.labels.ComponentSurface === "argocd-delivery-runtime"
        && runtimeDefinition.labels.ComponentVersion === "v3.4.6"
        && runtimeDefinition.labels.Lane === "Adapted"
        && runtimeDefinition.labels.Owner === "ConfigHubBootstrap"
        && runtimeDefinition.labels.RuntimeImage === "quay.io/argoproj/argocd:v3.4.6",
      "self-test adapted delivery runtime definition lacks recognizable argo-cd grouping and request-attested identity",
    );
    check(
      argoDefinition.labels.Component === "argo-cd"
        && argoDefinition.labels.CatalogComponent === "argo-cd"
        && argoDefinition.labels.Owner === "KubaraBootstrap"
        && runtimeDefinition.labels.Owner === "ConfigHubBootstrap",
      "self-test native Components no longer exposes faithful and adapted argo-cd definitions under their distinct Owners",
    );
    check(
      compiled.plan.spec.configHub.deliveryInfrastructure.clusters.every((row) =>
        row.appsSpaceLabels.Component === "argo-cd"
          && row.appsSpaceLabels.CatalogComponent === "argo-cd"
          && row.appsSpaceLabels.InstanceOf === "argo-cd-runtime"
          && row.appsSpaceLabels.ComponentVersion === "v3.4.6"
          && row.appsSpaceLabels.Lane === "Adapted"
          && row.appsSpaceLabels.Owner === "ConfigHubBootstrap"
          && row.appsSpaceLabels.DefinitionSpace.endsWith("-argo-runtime-base")),
      "self-test request-pinned Argo apps Spaces lack recognizable component grouping or exact adapted runtime-definition lineage",
    );
    check(compiled.plan.spec.configHub.deliveryInfrastructure.argobotBase.labels.ComponentVersion === "v0.1.6" && compiled.plan.spec.configHub.deliveryInfrastructure.argobotBase.labels.Owner === "ConfigHubDelivery", "self-test argobot definition lacks its separately pinned component identity");
    check(!Object.values(navigationAnnotations(request)).includes("https://confighub.github.io/helm-expt/data/kubara-platform-matrix/matrix.html") && !Object.hasOwn(navigationAnnotations(request), "URL-Matrix") && !Object.hasOwn(navigationAnnotations(request), "URL-Wiring"), "self-test attached canned matrix/wiring evidence to an arbitrary adopter");
    const secondOrganizationRequest = remapFixtureDestination(request);
    writeFileSync(requestPath, `${toYaml(secondOrganizationRequest)}\n`);
    const secondOrganizationCompile = compileImport({ requestPath, checkoutRoot: checkout });
    check(secondOrganizationCompile.lock.spec.platformDigest === compiled.lock.spec.platformDigest, "same Kubara Git content produced a destination-specific platform digest");
    check(secondOrganizationCompile.plan.spec.bindingDigest !== compiled.plan.spec.bindingDigest, "different Organization/Target mapping did not produce a distinct binding digest");
    check(secondOrganizationCompile.plan.spec.configHub.deliveryApplications.every((row) => row.sourceRepoURL.startsWith(`${secondOrganizationRequest.spec.destination.spaceReleaseOCIBase}/`)), "remapped destination retained the first Organization's Space-release OCI origin");
    check(!secondOrganizationCompile.plan.spec.configHub.deliveryApplications.some((row) => compiled.plan.spec.configHub.deliveryApplications.some((prior) => prior.sourceRepoURL === row.sourceRepoURL)), "destination remap did not change exact Space-release OCI refs");
    check(stableJson([...secondOrganizationCompile.execution.componentPayloads].map(([id, row]) => [id, row.sha256])) === stableJson([...compiled.execution.componentPayloads].map(([id, row]) => [id, row.sha256])), "component OCI payloads changed across destination mappings");
    check(stableJson([...secondOrganizationCompile.execution.configPayloads].map(([id, row]) => [id, row.sha256])) === stableJson([...compiled.execution.configPayloads].map(([id, row]) => [id, row.sha256])), "config OCI payloads changed across destination mappings");
    check(stableJson([...secondOrganizationCompile.plan.spec.oci.catalogPackages, ...secondOrganizationCompile.plan.spec.oci.configReleases].map((row) => row.plannedOCIRef).sort()) === stableJson([...compiled.plan.spec.oci.catalogPackages, ...compiled.plan.spec.oci.configReleases].map((row) => row.plannedOCIRef).sort()), "same catalog base produced destination-specific OCI publication refs");
    const indexRows = [...compiled.plan.spec.oci.catalogPackages, ...compiled.plan.spec.oci.configReleases].map((row) => ({
      id: row.id, role: row.id.startsWith("component:") ? "component-definition" : "effective-config-set",
      ref: row.plannedOCIRef, payloadSha256: row.payloadSha256,
      manifestDigest: `sha256:${sha256(`manifest:${row.id}`)}`, layerDigest: `sha256:${row.payloadSha256}`,
    })).sort((left, right) => left.id.localeCompare(right.id));
    check(stableJson(buildPlatformOciIndex(secondOrganizationCompile, indexRows)) === stableJson(buildPlatformOciIndex(compiled, indexRows)), "target-neutral aggregate OCI member index changed across destination mappings");
    const portableRequest = {
      apiVersion: "import.confighub.com/v1alpha1",
      kind: "KubaraPortableGitRevision",
      metadata: { name: request.metadata.name },
      spec: {
        source: structuredClone(request.spec.source),
        layout: structuredClone(request.spec.layout),
        security: structuredClone(request.spec.security),
        publication: { catalogOCIBase: request.spec.destination.catalogOCIBase },
      },
    };
    const portableRequestPath = join(tempRoot, "portable-request.yaml");
    const portableOutput = join(tempRoot, "portable-output");
    writeFileSync(portableRequestPath, `${toYaml(portableRequest)}\n`);
    const portableCompiled = compilePortableRequest({ requestPath: portableRequestPath, checkoutRoot: checkout });
    check(portableCompiled.lock.spec.platformDigest === compiled.lock.spec.platformDigest, "source-only portable compilation produced another platform digest");
    writePortableOutputs(portableOutput, portableCompiled);
    verifyPortableOutputs(portableOutput, compiled);
    verifyPortableOutputs(portableOutput, secondOrganizationCompile);
    check(!existsSync(join(portableOutput, "destination-binding-lock.yaml")) && !existsSync(join(portableOutput, "target-facts-required.yaml")), "portable compilation leaked destination binding artifacts");
    writeFileSync(requestPath, `${toYaml(request)}\n`);
    const wiringGraph = readJson(join(platform, "wiring/graph.json"));
    const noProviderGraph = structuredClone(wiringGraph);
    const resolvedWithoutProvider = noProviderGraph.spec.edges.find((edge) => ["resolved-rendered", "resolved-runtime"].includes(edge.status));
    resolvedWithoutProvider.providerComponents = [];
    expectFailure(() => buildWiringPlan(noProviderGraph, compiled.execution.instances), /resolved wiring edge has no provider/, "resolved wiring edge without provider refusal");
    const duplicateComponentGraph = structuredClone(wiringGraph);
    duplicateComponentGraph.spec.components.push(structuredClone(duplicateComponentGraph.spec.components[0]));
    expectFailure(() => buildWiringPlan(duplicateComponentGraph, compiled.execution.instances), /wiring graph component id contains duplicate or conflicting semantic key/, "duplicate wiring component refusal");
    const duplicateEdgeGraph = structuredClone(wiringGraph);
    duplicateEdgeGraph.spec.edges.push(structuredClone(duplicateEdgeGraph.spec.edges[0]));
    expectFailure(() => buildWiringPlan(duplicateEdgeGraph, compiled.execution.instances), /wiring graph edge id contains duplicate or conflicting semantic key/, "duplicate wiring edge refusal");
    const unknownStatusGraph = structuredClone(wiringGraph);
    unknownStatusGraph.spec.edges.find((edge) => edge.relation === "needs").status = "future-magic-status";
    expectFailure(() => buildWiringPlan(unknownStatusGraph, compiled.execution.instances), /unknown needs status/, "unknown wiring status refusal");
    writeOutputs(output, compiled);
    verifyOutputs(output, compiled);
    const outputSymlink = join(output, "unsafe-output-link");
    const untouched = join(tempRoot, "untouched.txt");
    writeFileSync(untouched, "unchanged\n");
    symlinkSync(untouched, outputSymlink);
    expectFailure(() => verifyOutputs(output, compiled), /symbolic links are refused/, "output symlink refusal");
    rmSync(outputSymlink);
    check(readFileSync(untouched, "utf8") === "unchanged\n", "output symlink refusal modified its target");

    check(compiled.plan.spec.configHub.deliveryApplications.length === 12, "self-test did not plan all 12 targeted platform delivery Applications");
    check(compiled.plan.spec.configHub.deliveryApplications.every((row) => row.sourceRepoURL === `${FIXTURE_SPACE_RELEASE_OCI_BASE}/${row.sourceSpace}`), "self-test delivery Applications did not use the request-bound non-production Space-release OCI base");
    check(!stableJson(compiled.plan).includes("oci.hub.confighub.com"), "self-test compiled plan leaked the production ConfigHub OCI origin");
    check(compiled.plan.spec.configHub.deliveryApplications.every((row) => row.destinationNamespace && row.destinationNamespace !== "default"), "self-test did not preserve mechanically attested non-default Kubara destination namespaces");
    check(compiled.plan.spec.configHub.deliveryApplications.every((row) => row.labels.Lane === "Adapted" && row.labels.DeliveryMode === "ConfigHubOCI"), "self-test delivery Applications do not expose the adapted ConfigHub lane");
    check(compiled.plan.spec.configHub.spaces.filter((row) => row.externalBinding).every((row) => row.labels.Lane === "Adapted"), "self-test target Spaces do not expose the adapted ConfigHub lane");
    check(compiled.plan.spec.configHub.units.some((row) => row.labels.Lane === "Faithful" && row.labels.ComponentSurface === "argocd-delivery"), "self-test retained Kubara Argo surface does not expose the faithful lane");
    check(compiled.plan.spec.configHub.units.filter((row) => row.labels.StartHere === "true").every((row) => row.annotations?.["URL-Catalog"] === PUBLIC_CATALOG_URL), "self-test StartHere Units do not link to the public Component Catalog");
    const fakeOci = createFakeOciClient();
    const portablePackageReceipt = packageImport({ compiled: portableCompiled, outputRoot: portableOutput, oci: fakeOci });
    check(portablePackageReceipt.spec.platformDigest === compiled.lock.spec.platformDigest, "portable OCI publication receipt platform digest differs");
    const boundOutput = join(tempRoot, "bound-output");
    writeOutputs(boundOutput, secondOrganizationCompile);
    copyPortablePublication({ portableRoot: portableOutput, outputRoot: boundOutput, compiled: secondOrganizationCompile });
    check(readJson(join(boundOutput, "portable-binding-receipt.json")).status.portablePublicationCopied === true, "portable publication was not copied into the separate destination binding output");
    check(readYaml(join(boundOutput, "destination-binding-lock.yaml")).spec.bindingDigest === secondOrganizationCompile.plan.spec.bindingDigest, "separate destination binding output does not name the selected binding digest");
    const firstBindingReceipt = readFileSync(join(boundOutput, "portable-binding-receipt.json"), "utf8");
    copyPortablePublication({ portableRoot: portableOutput, outputRoot: boundOutput, compiled: secondOrganizationCompile });
    check(readFileSync(join(boundOutput, "portable-binding-receipt.json"), "utf8") === firstBindingReceipt, "exact portable binding replay changed its receipt");
    const unexpectedBoundPayload = join(boundOutput, "oci", "unexpected.json");
    writeFileSync(unexpectedBoundPayload, "unexpected\n");
    expectFailure(() => copyPortablePublication({ portableRoot: portableOutput, outputRoot: boundOutput, compiled: secondOrganizationCompile }), /differs from the portable publication/, "conflicting bound OCI directory refusal");
    rmSync(unexpectedBoundPayload);
    writeFileSync(join(boundOutput, "apply-receipt.json"), "{}\n");
    assertBindOutputReplaySafe(boundOutput, secondOrganizationCompile);
    expectFailure(() => assertBindOutputReplaySafe(boundOutput, compiled), /stale or was modified/, "advanced bound-output rebinding refusal");
    rmSync(join(boundOutput, "apply-receipt.json"));
    consumePackagedImport({ compiled: secondOrganizationCompile, outputRoot: boundOutput, oci: fakeOci });
    const packageReceipt = packageImport({ compiled, outputRoot: output, oci: fakeOci });
    check(packageReceipt.spec.members.some((row) => row.role === "component-definition") && packageReceipt.spec.members.some((row) => row.role === "effective-config-set"), "self-test OCI index omitted a package role");
    const firstPackageReceiptText = readFileSync(join(output, "oci-publication-receipt.json"), "utf8");
    packageImport({ compiled, outputRoot: output, oci: fakeOci });
    check(readFileSync(join(output, "oci-publication-receipt.json"), "utf8") === firstPackageReceiptText, "exact OCI reuse changed the deterministic package receipt");
    const firstMember = packageReceipt.spec.members[0];
    const savedArtifact = fakeOci.snapshot(firstMember.ref);
    fakeOci.corruptLayer(firstMember.ref);
    expectFailure(() => packageImport({ compiled, outputRoot: output, oci: fakeOci }), /refusing overwrite/, "conflicting OCI tag refusal");
    fakeOci.restore(firstMember.ref, savedArtifact);
    check(fakeOci.inspect(firstMember.ref).layers[0].digest === firstMember.layerDigest, "fake OCI restore did not restore the exact remote layer");
    consumePackagedImport({ compiled, outputRoot: output, oci: fakeOci });
    const receiptPath = join(output, "oci-publication-receipt.json");
    const exactReceiptText = readFileSync(receiptPath, "utf8");
    const conflictingReceipt = JSON.parse(exactReceiptText);
    conflictingReceipt.spec.members[0].layerDigest = `sha256:${"e".repeat(64)}`;
    writeJsonExact(receiptPath, conflictingReceipt);
    expectFailure(() => consumePackagedImport({ compiled, outputRoot: output, oci: fakeOci }), /receipt layer digest differs from exact payload/, "tampered package-receipt layer refusal");
    writeFileSync(receiptPath, exactReceiptText);
    fakeOci.tamperFetch = true;
    expectFailure(() => consumePackagedImport({ compiled, outputRoot: output, oci: fakeOci }), /pulled OCI payload differs/, "pulled packaged-payload tamper refusal");
    fakeOci.tamperFetch = false;

    const attestationPath = join(tempRoot, "target-facts-attested.yaml");
    const attestation = completedTargetFactAttestation(compiled);
    writeFileSync(attestationPath, `${toYaml(attestation)}\n`);
    const fakeHub = createFakeHub(compiled);
    const inspectionTemplate = structuredClone(request);
    const expectedInspection = structuredClone(request);
    const credentialReportPath = join(tempRoot, "credential-scan-pass.json");
    const credentialReportMarker = "CREDENTIAL-REPORT-INTERNAL-MARKER-7f12";
    const runtimeEvidenceMarker = "RUNTIME-EVIDENCE-INTERNAL-MARKER-91ab";
    const failedUnitDataMarker = "FAILED-UNIT-DATA-MUST-NOT-LEAK-53e1";
    let failedUnitDataError = null;
    try {
      unitDataCommandOutput({ ok: false, status: 1, stdout: failedUnitDataMarker, stderr: failedUnitDataMarker, output: failedUnitDataMarker }, "cub unit data --space guarded guarded");
    } catch (error) {
      failedUnitDataError = error;
    }
    check(failedUnitDataError && /failed without exposing Unit content/.test(failedUnitDataError.message) && !failedUnitDataError.message.includes(failedUnitDataMarker), "failed unit-data read disclosed partial raw Unit bytes");
    writeFileSync(credentialReportPath, `${JSON.stringify({ scanner: "gitleaks@8.24.3", result: "pass", findings: 0, internalMarker: credentialReportMarker })}\n`);
    expectedInspection.spec.security.credentialScan.reportSHA256 = `sha256:${sha256(readFileSync(credentialReportPath))}`;
    const runtimeEvidenceArgs = [];
    for (const [cluster, target] of Object.entries(request.spec.targets)) {
      const evidencePath = join(tempRoot, `runtime-${cluster}.yaml`);
      const evidence = {
        apiVersion: "import.confighub.com/v1alpha1",
        kind: "KubaraArgoRuntimeObservation",
        metadata: { name: `${cluster}-argocd-runtime` },
        spec: {
          cluster,
          componentVersion: target.delivery.reconciler.componentVersion,
          image: target.delivery.reconciler.image,
          evidenceRef: target.delivery.reconciler.evidenceRef,
          internalObservationMarker: runtimeEvidenceMarker,
        },
        status: { result: "pass" },
      };
      writeFileSync(evidencePath, `${toYaml(evidence)}\n`);
      expectedInspection.spec.targets[cluster].delivery.reconciler.evidenceSHA256 = `sha256:${sha256(readFileSync(evidencePath))}`;
      runtimeEvidenceArgs.push(`${cluster}=${evidencePath}`);
    }
    inspectionTemplate.spec.destination.organization = "REPLACE_ME";
    inspectionTemplate.spec.destination.context = "replace-me";
    inspectionTemplate.spec.destination.organizationExternalID = "00000000-0000-4000-8000-000000000000";
    inspectionTemplate.spec.destination.organizationID = "00000000-0000-4000-8000-000000000000";
    inspectionTemplate.spec.destination.serverURL = "https://replace.invalid";
    for (const entity of [inspectionTemplate.spec.destination.argobotBase, ...Object.values(inspectionTemplate.spec.targets).flatMap((target) => [target, target.delivery, target.delivery.root, target.delivery.argobotApplication, target.delivery.argobot])]) {
      for (const key of ["spaceID", "targetID", "unitID", "dataHash", "dataSHA256", "sourceDigest", "componentVersion"]) if (Object.hasOwn(entity, key)) entity[key] = "REPLACE_ME";
    }
    inspectionTemplate.spec.destination.argobotBase.sourceRef = "REPLACE_ME";
    for (const target of Object.values(inspectionTemplate.spec.targets)) target.delivery.reconciler = { componentVersion: "REPLACE_ME", image: "REPLACE_ME", evidenceRef: "REPLACE_ME", evidenceSHA256: "REPLACE_ME" };
    inspectionTemplate.spec.security.credentialScan.reportSHA256 = "REPLACE_ME";
    const inspectionTemplatePath = join(tempRoot, "inspection-template.yaml");
    const inspectedRequestPath = join(tempRoot, "inspected-request.yaml");
    writeFileSync(inspectionTemplatePath, `${toYaml(inspectionTemplate)}\n`);
    const inspectedRequest = inspectDestination({
      requestPath: inspectionTemplatePath,
      outputPath: inspectedRequestPath,
      context: request.spec.destination.context,
      credentialScanReportPath: credentialReportPath,
      runtimeEvidence: runtimeEvidenceArgs,
      inspector: createFakeInspectionClient(request, fakeHub),
    });
    check(stableJson(inspectedRequest) === stableJson(expectedInspection), "read-only destination inspector did not produce the exact reviewed request");
    const inspectedText = readFileSync(inspectedRequestPath, "utf8");
    check(!inspectedText.includes(credentialReportMarker) && !inspectedText.includes(runtimeEvidenceMarker) && !inspectedText.includes("mode: cluster-local"), "destination inspector disclosed report, evidence, or Unit payload contents instead of hashes/selected identities");
    const inspectedRequestPath2 = join(tempRoot, "inspected-request-second.yaml");
    inspectDestination({ requestPath: inspectionTemplatePath, outputPath: inspectedRequestPath2, context: request.spec.destination.context, credentialScanReportPath: credentialReportPath, runtimeEvidence: runtimeEvidenceArgs, inspector: createFakeInspectionClient(request, fakeHub) });
    check(readFileSync(inspectedRequestPath, "utf8") === readFileSync(inspectedRequestPath2, "utf8"), "read-only destination inspection was not byte-for-byte deterministic");
    const firstApplyEvidencePath = prepareImmutableApplyReceiptEvidencePath({ outputRoot: output, path: join(output, "evidence", "apply-first-receipt.json") });
    const noopApplyEvidencePath = prepareImmutableApplyReceiptEvidencePath({ outputRoot: output, path: join(output, "evidence", "apply-immediate-noop-receipt.json") });
    check(firstApplyEvidencePath !== noopApplyEvidencePath, "self-test apply evidence paths are not distinct");
    const firstApply = applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub });
    check(firstApply.status.result === "pending-second-zero-action-run" && firstApply.status.lastActionCount > 0, "first fake apply did not record deterministic materialization actions");
    writeImmutableApplyReceiptEvidence(firstApplyEvidencePath, firstApply);
    const firstApplyEvidenceText = readFileSync(firstApplyEvidencePath, "utf8");
    writeImmutableApplyReceiptEvidence(firstApplyEvidencePath, firstApply);
    check(readFileSync(firstApplyEvidencePath, "utf8") === firstApplyEvidenceText, "exact first-apply evidence replay changed immutable bytes");
    const secondApply = applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub });
    check(secondApply.status.result === "pass" && secondApply.status.lastActionCount === 0 && secondApply.status.secondRunZeroActions === true, "second fake apply did not prove zero actions");
    writeImmutableApplyReceiptEvidence(noopApplyEvidencePath, secondApply);
    check(readFileSync(firstApplyEvidencePath, "utf8") === firstApplyEvidenceText, "second apply destroyed first-step immutable evidence");
    check(readFileSync(noopApplyEvidencePath, "utf8") !== firstApplyEvidenceText, "second apply reused the first-step evidence bytes");
    expectFailure(() => writeImmutableApplyReceiptEvidence(firstApplyEvidencePath, secondApply), /refusing to overwrite different immutable apply receipt evidence/, "immutable first-apply evidence overwrite refusal");
    check(secondApply.spec.observation.deliveryApplications.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.sourceReleaseManifestDigest) && row.automatedSync === false), "fake apply did not retain exact-digest/no-auto platform delivery authority");
    const legacyV1Receipt = structuredClone(secondApply);
    legacyV1Receipt.spec.claimBoundary = applyReceiptClaimBoundaryV1();
    for (const row of legacyV1Receipt.spec.observation.deliveryApplications) {
      delete row.sourceReleaseManifestDigest;
      delete row.automatedSync;
    }
    const legacyObservationSHA256 = sha256(stableJson(legacyV1Receipt.spec.observation));
    legacyV1Receipt.spec.runs.at(-1).observationSHA256 = legacyObservationSHA256;
    const legacyLastRun = legacyV1Receipt.spec.runs.at(-1);
    legacyLastRun.runDigest = `sha256:${sha256(stableJson({ number: legacyLastRun.number, actionCount: legacyLastRun.actionCount, actions: legacyLastRun.actions, packageReceiptSHA256: legacyLastRun.packageReceiptSHA256, targetFactAttestationSHA256: legacyLastRun.targetFactAttestationSHA256, observationSHA256: legacyLastRun.observationSHA256 }))}`;
    validatePassingTransitionReceipt(legacyV1Receipt);
    check(secondApply.spec.observation.deliveryApplications.length === 12 && secondApply.spec.observation.deliveryRootReleases.length === 4, "fake apply receipt omitted platform delivery Application/root identities");
    check(secondApply.spec.observation.delivery.clusterConvergenceClaim === false, "fake apply receipt overclaimed cluster convergence");
    const passedApplyReceiptText = readFileSync(join(output, "apply-receipt.json"), "utf8");
    const thirdApply = applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub });
    check(thirdApply.status.result === "pass" && readFileSync(join(output, "apply-receipt.json"), "utf8") === passedApplyReceiptText, "third zero-action apply changed a passed receipt");
    const unchangedSpace = instanceSpace(request.spec.destination.spacePrefix, "hx-app-dev", "metrics-server");
    const unchangedUnitSnapshot = fakeHub.snapshotUnit(unchangedSpace, "metrics-server");
    fakeHub.simulateUnchangedBundleOnNextPublish(unchangedSpace);
    const unchangedRecoveryState = { actions: [] };
    ensurePublishedRelease(fakeHub, unchangedSpace, unchangedRecoveryState);
    check(unchangedRecoveryState.actions.length === 0, "unchanged-bundle recovery recorded a false publication action");
    fakeHub.restoreUnit(unchangedSpace, "metrics-server", unchangedUnitSnapshot);
    const bootstrapSnapshot = fakeHub.snapshotUnit(request.spec.destination.argobotBase.space, request.spec.destination.argobotBase.unit);
    fakeHub.tamperUnitData(request.spec.destination.argobotBase.space, request.spec.destination.argobotBase.unit, `${fakeArgobotData()}# tampered\n`);
    expectFailure(() => applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub }), /DataHash differs/, "exact bootstrap bytes tamper refusal");
    fakeHub.restoreUnit(request.spec.destination.argobotBase.space, request.spec.destination.argobotBase.unit, bootstrapSnapshot);
    const needsOwnership = fakeHub.stripLinkOwnership("NeedsProvides");
    const needsPlan = compiled.plan.spec.configHub.links.find((row) => row.space === needsOwnership.space && row.slug === needsOwnership.slug);
    expectFailure(() => ensureManagedLink(fakeHub, needsPlan, { actions: [] }), /refusing an unowned/, "unowned NeedsProvides Link refusal");
    fakeHub.restoreLink(needsOwnership);
    const upgradeOwnership = fakeHub.stripLinkOwnership("UpgradeUnit");
    const upgradePlan = compiled.plan.spec.configHub.links.find((row) => row.space === upgradeOwnership.space && row.slug === upgradeOwnership.slug);
    const upgradeRecoveryState = { actions: [] };
    ensureManagedLink(fakeHub, upgradePlan, upgradeRecoveryState);
    check(upgradeRecoveryState.actions.length === 1, "canonical auto-created UpgradeUnit ownership recovery did not record one bounded action");
    fakeHub.restoreLink(upgradeOwnership);
    const rewiredLink = fakeHub.rewireLink("NeedsProvides");
    const rewiredPlan = compiled.plan.spec.configHub.links.find((row) => row.space === rewiredLink.space && row.slug === rewiredLink.slug);
    expectFailure(() => ensureManagedLink(fakeHub, rewiredPlan, { actions: [] }), /concurrently rewired/, "concurrent Link rewire refusal");
    fakeHub.restoreLink(rewiredLink);
    const targetToCorrupt = request.spec.targets["hx-app-dev"];
    const targetSnapshot = fakeHub.getTarget(targetToCorrupt.space, targetToCorrupt.target).TargetID;
    fakeHub.setTargetID(targetToCorrupt.space, targetToCorrupt.target, "49999999-9999-4999-8999-999999999999");
    expectFailure(() => applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub }), /Target ID differs/, "target identity drift refusal");
    fakeHub.setTargetID(targetToCorrupt.space, targetToCorrupt.target, targetSnapshot);
    fakeHub.addForeignSpace("foreign-space");
    expectFailure(() => applyImport({ compiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub }), /unexpected Space/, "foreign nonempty organization refusal");
    fakeHub.removeSpace("foreign-space");

    const workloadRequest = structuredClone(request);
    const workloadPin = fakeHub.addPublishedWorkload("hx-app-dev", "payments-api", { legacyLatest: true });
    workloadRequest.spec.targets["hx-app-dev"].delivery.workloadApplications.push(workloadPin);
    writeFileSync(requestPath, `${toYaml(workloadRequest)}\n`);
    const workloadCompiled = compileImport({ requestPath, checkoutRoot: checkout });
    check(workloadCompiled.lock.spec.platformDigest === compiled.lock.spec.platformDigest, "registering a preserved workload changed the target-neutral platform content digest");
    check(workloadCompiled.plan.spec.bindingDigest !== compiled.plan.spec.bindingDigest, "registering a preserved workload did not change the destination binding digest");
    writeOutputs(output, workloadCompiled);
    packageImport({ compiled: workloadCompiled, outputRoot: output, oci: fakeOci });
    const workloadAttestation = completedTargetFactAttestation(workloadCompiled);
    writeFileSync(attestationPath, `${toYaml(workloadAttestation)}\n`);
    const workloadFirst = applyImport({ compiled: workloadCompiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub });
    check(workloadFirst.status.result === "pending-second-zero-action-run" && workloadFirst.status.lastActionCount === 0, "preserved workload registration was not a zero-action binding re-attestation");
    const workloadSecond = applyImport({ compiled: workloadCompiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub });
    check(workloadSecond.status.result === "pass" && workloadSecond.status.lastActionCount === 0 && workloadSecond.spec.observation.preservedWorkloadApplications.length === 1, "preserved workload registration did not pass on the second zero-action run");
    const workloadSnapshot = fakeHub.snapshotUnit(workloadRequest.spec.targets["hx-app-dev"].delivery.appsSpace, workloadPin.unit);
    fakeHub.driftUnitHead(workloadRequest.spec.targets["hx-app-dev"].delivery.appsSpace, workloadPin.unit);
    expectFailure(() => applyImport({ compiled: workloadCompiled, outputRoot: output, context: request.spec.destination.context, targetFactsPath: attestationPath, oci: fakeOci, hub: fakeHub }), /unpublished head/, "pending preserved workload head refusal");
    fakeHub.restoreUnit(workloadRequest.spec.targets["hx-app-dev"].delivery.appsSpace, workloadPin.unit, workloadSnapshot);
    compiled = workloadCompiled;

    const previousReceiptPath = join(tempRoot, "immutable-prior-apply-receipt.json");
    writeFileSync(previousReceiptPath, readFileSync(join(output, "apply-receipt.json")));
    const previousReceiptSHA256 = `sha256:${sha256(readFileSync(previousReceiptPath))}`;
    const renderPath = join(platform, "effective-renders/hx-app-dev/metrics-server/release-objects.yaml");
    writeFileSync(renderPath, `${readFileSync(renderPath, "utf8").trimEnd()}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: importer-transition-proof\n  namespace: kube-system\ndata:\n  revision: two\n`);
    const generationReceiptPath = join(platform, "generation-receipt.yaml");
    const nextGenerationReceipt = readYaml(generationReceiptPath);
    const changedRender = nextGenerationReceipt.spec.outputs.renders.find((row) => row.cluster === "hx-app-dev" && row.service === "metrics-server");
    check(changedRender, "self-test transition render receipt row is missing");
    changedRender.sha256 = sha256(readFileSync(renderPath));
    changedRender.objectCount += 1;
    changedRender.kinds.ConfigMap = Number(changedRender.kinds.ConfigMap ?? 0) + 1;
    writeFileSync(generationReceiptPath, `${toYaml(nextGenerationReceipt)}\n`);
    const nextWiringGraphPath = join(platform, "wiring/graph.json");
    const nextWiringGraph = readJson(nextWiringGraphPath);
    const changedGraphComponent = nextWiringGraph.spec.components.find((row) => row.id === "component:hx-app-dev/metrics-server");
    check(changedGraphComponent, "self-test transition wiring component is missing");
    changedGraphComponent.objectCount += 1;
    writeFileSync(nextWiringGraphPath, `${JSON.stringify(nextWiringGraph, null, 2)}\n`);
    commit = commitAll(checkout, "additive metrics-server config revision");
    const nextRequestWithoutAuthority = structuredClone(workloadRequest);
    pinFixtureCommit(nextRequestWithoutAuthority, commit);
    writeFileSync(requestPath, `${toYaml(nextRequestWithoutAuthority)}\n`);
    const nextCompileWithoutAuthority = compileImport({ requestPath, checkoutRoot: checkout });
    const nextRequest = structuredClone(nextRequestWithoutAuthority);
    nextRequest.spec.transition = {
      fromPlatformDigest: workloadCompiled.lock.spec.platformDigest,
      fromBindingDigest: workloadCompiled.plan.spec.bindingDigest,
      previousApplyReceiptSHA256: previousReceiptSHA256,
      policy: "additive-confighub-topology-importer-no-delete-argo-prune-disclosed",
    };
    writeFileSync(requestPath, `${toYaml(nextRequest)}\n`);
    const nextCompiled = compileImport({ requestPath, checkoutRoot: checkout });
    check(nextCompiled.lock.spec.platformDigest !== workloadCompiled.lock.spec.platformDigest, "changed Git config did not produce a new platform content digest");
    check(nextCompiled.lock.spec.platformDigest === nextCompileWithoutAuthority.lock.spec.platformDigest && nextCompiled.plan.spec.bindingDigest === nextCompileWithoutAuthority.plan.spec.bindingDigest, "transition execution authority contaminated the platform or binding digest");
    const outputV2 = join(tempRoot, "output-v2");
    writeOutputs(outputV2, nextCompiled);
    packageImport({ compiled: nextCompiled, outputRoot: outputV2, oci: fakeOci });
    const nextAttestationPath = join(tempRoot, "target-facts-v2.yaml");
    writeFileSync(nextAttestationPath, `${toYaml(completedTargetFactAttestation(nextCompiled))}\n`);
    expectFailure(() => applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, oci: fakeOci, hub: fakeHub }), /requires --previous-apply-receipt/, "missing prior receipt transition refusal");
    const incompletePrevious = JSON.parse(readFileSync(previousReceiptPath, "utf8"));
    incompletePrevious.spec.observation.links = [];
    incompletePrevious.spec.runs.at(-1).observationSHA256 = sha256(stableJson(incompletePrevious.spec.observation));
    const incompleteRun = incompletePrevious.spec.runs.at(-1);
    incompleteRun.runDigest = `sha256:${sha256(stableJson({ number: incompleteRun.number, actionCount: incompleteRun.actionCount, actions: incompleteRun.actions, packageReceiptSHA256: incompleteRun.packageReceiptSHA256, targetFactAttestationSHA256: incompleteRun.targetFactAttestationSHA256, observationSHA256: incompleteRun.observationSHA256 }))}`;
    expectFailure(() => validatePassingTransitionReceipt(incompletePrevious), /inventories must be nonempty/, "internally rehashed incomplete prior receipt refusal");
    const removalCompiled = structuredClone(nextCompiled);
    const removedPriorUnit = workloadSecond.spec.observation.units[0].ref;
    removalCompiled.plan.spec.configHub.units = removalCompiled.plan.spec.configHub.units.filter((row) => `${row.space}/${row.slug}` !== removedPriorUnit);
    expectFailure(() => assertAdditiveTransition(removalCompiled, { previous: JSON.parse(readFileSync(previousReceiptPath, "utf8")) }), /cannot remove or rename/, "additive transition Unit removal refusal");
    fakeHub.failAfterMutations(5);
    expectFailure(() => applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, previousApplyReceiptPath: previousReceiptPath, oci: fakeOci, hub: fakeHub }), /simulated bounded apply interruption/, "mixed-state transition interruption fixture");
    const changedReleaseSpace = instanceSpace(request.spec.destination.spacePrefix, "hx-app-dev", "metrics-server");
    const releasesBeforeResume = fakeHub.listPublishedReleases(changedReleaseSpace).length;
    fakeHub.failAfterPublishedRelease(changedReleaseSpace);
    expectFailure(() => applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, previousApplyReceiptPath: previousReceiptPath, oci: fakeOci, hub: fakeHub }), /simulated interruption after published release/, "post-release transition interruption fixture");
    check(fakeHub.listPublishedReleases(changedReleaseSpace).length === releasesBeforeResume + 1, "post-release interruption did not leave exactly one recoverable affected release");
    const nextFirst = applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, previousApplyReceiptPath: previousReceiptPath, oci: fakeOci, hub: fakeHub });
    check(nextFirst.status.result === "pending-second-zero-action-run", "authorized next Git revision did not record its recovered first run");
    check(fakeHub.listPublishedReleases(changedReleaseSpace).length === releasesBeforeResume + 1, "resumed transition did not publish exactly one affected source release");
    const nextSecond = applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, previousApplyReceiptPath: previousReceiptPath, oci: fakeOci, hub: fakeHub });
    check(nextSecond.status.result === "pass" && nextSecond.status.lastActionCount === 0, "authorized next Git revision did not prove its second zero-action run");
    check(fakeHub.listPublishedReleases(changedReleaseSpace).length === releasesBeforeResume + 1, "second transition run published a duplicate source release");
    check(nextSecond.spec.transitionAuthority?.previousApplyReceiptSHA256 === previousReceiptSHA256, "next-revision receipt omitted its exact transition authority");
    const forgedPrevious = JSON.parse(readFileSync(previousReceiptPath, "utf8"));
    forgedPrevious.spec.observation.units[0].dataHash = "forged";
    const forgedPreviousPath = join(tempRoot, "forged-prior-apply-receipt.json");
    writeFileSync(forgedPreviousPath, `${JSON.stringify(forgedPrevious, null, 2)}\n`);
    expectFailure(() => applyImport({ compiled: nextCompiled, outputRoot: outputV2, context: request.spec.destination.context, targetFactsPath: nextAttestationPath, previousApplyReceiptPath: forgedPreviousPath, oci: fakeOci, hub: fakeHub }), /bytes differ from spec\.transition/, "forged prior receipt refusal");

    const planPath = join(output, "import-plan.json");
    writeFileSync(planPath, `${compiled.planText.trimEnd()} \n`);
    expectFailure(() => verifyOutputs(output, compiled), /stale or was modified/, "output tamper refusal");
    writeOutputs(output, compiled);

    const mutableRequest = structuredClone(nextRequestWithoutAuthority);
    mutableRequest.spec.source.commit = "main";
    writeFileSync(requestPath, `${toYaml(mutableRequest)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /full lowercase Git object ID/, "mutable ref refusal");

    const missingTarget = structuredClone(nextRequestWithoutAuthority);
    delete missingTarget.spec.targets["hx-app-prod-b"];
    writeFileSync(requestPath, `${toYaml(missingTarget)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /destination target mapping is missing/, "missing target refusal");

    const unsafeOrg = structuredClone(nextRequestWithoutAuthority);
    unsafeOrg.spec.destination.organizationPolicy = "merge-whatever-exists";
    writeFileSync(requestPath, `${toYaml(unsafeOrg)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /organizationPolicy/, "unsafe organization policy refusal");

    const unknownCredentialField = structuredClone(nextRequestWithoutAuthority);
    unknownCredentialField.spec.destination.adminPassword = "should-never-be-retained";
    writeFileSync(requestPath, `${toYaml(unknownCredentialField)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /spec\.destination fields differ/, "unknown secret-shaped request field refusal");

    const chartPath = join(platform, "generated/platform-components/helm/metrics-server/Chart.yaml");
    const originalChart = readFileSync(chartPath, "utf8");
    writeFileSync(chartPath, originalChart.replace("version: 3.13.1", "version: latest"));
    commit = commitAll(checkout, "mutable chart version");
    const mutableChartRequest = fixtureRequest(commit);
    writeFileSync(requestPath, `${toYaml(mutableChartRequest)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /must be an exact version/, "missing exact version refusal");

    writeFileSync(chartPath, originalChart);
    const secretPath = join(platform, "generated/platform-configs/hx-app-dev/helm/metrics-server/committed-secret.yaml");
    writeFileSync(secretPath, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: bad\nstringData:\n  password: should-not-be-here\n");
    commit = commitAll(checkout, "secret material");
    const secretRequest = fixtureRequest(commit);
    writeFileSync(requestPath, `${toYaml(secretRequest)}\n`);
    expectFailure(() => compileImport({ requestPath, checkoutRoot: checkout }), /credential-shaped material is forbidden/, "secret material refusal");

    rmSync(secretPath);
    commitAll(checkout, "restore safe fixture");
    console.log("Kubara Git importer self-test passed: exact Git compile, 22 component/config OCI packages plus digest index, pulled-payload verification, pinned delivery topology, 12 platform Argo Applications, four root releases, second-run zero actions, and adversarial refusals");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function fixtureRequest(commit) {
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraGitRevisionImport",
    metadata: { name: "kubara-current-four-cluster" },
    spec: {
      source: {
        repository: "https://example.invalid/acme/kubara-platform.git",
        commit,
        path: "platform",
      },
      layout: {
        source: "source",
        config: "source/config.yaml",
        components: "generated/platform-components/helm",
        configs: "generated/platform-configs",
        renders: "effective-renders",
        artifactLock: "component-artifacts.yaml",
        generationReceipt: "generation-receipt.yaml",
        wiringGraph: "wiring/graph.json",
      },
      security: {
        credentialScan: {
          status: "pass", scanner: "gitleaks@8.24.3", reportSHA256: `sha256:${sha256(`gitleaks:${commit}:platform`)}`,
          sourceCommit: commit, scopePath: "platform", opaqueFilesReviewed: true,
        },
      },
      destination: {
        organization: "Acme Kubara",
        context: "acme-kubara",
        organizationExternalID: "11111111-1111-4111-8111-111111111111",
        organizationID: "22222222-2222-4222-8222-222222222222",
        serverURL: "https://hub.confighub.example",
        spaceReleaseOCIBase: FIXTURE_SPACE_RELEASE_OCI_BASE,
        organizationPolicy: "require-bootstrap-only-or-importer-owned-identical",
        spacePrefix: "acme-kubara",
        deliveryMode: "confighub-managed-argo",
        catalogOCIBase: "oci://registry.example.invalid/acme/kubara-components",
        argobotBase: {
          space: "argobot-base", spaceID: "50000000-0000-4000-8000-000000000000",
          unit: "argobot", unitID: "51000000-0000-4000-8000-000000000000",
          componentVersion: "v0.1.6", sourceRef: "oci://registry.example.invalid/confighub/argobot",
          sourceDigest: `sha256:${sha256("argobot-source-v0.1.6")}`,
          dataHash: sha256(fakeArgobotData()), dataSHA256: sha256(fakeArgobotData()),
        },
      },
      targets: {
        "hx-app-dev": fixtureTarget(1, "acme-target-dev", "Dev", "local", FIXTURE_SPACE_RELEASE_OCI_BASE),
        "hx-app-staging": fixtureTarget(2, "acme-target-staging", "Staging", "local", FIXTURE_SPACE_RELEASE_OCI_BASE),
        "hx-app-prod-a": fixtureTarget(3, "acme-target-prod-a", "Prod", "us-east", FIXTURE_SPACE_RELEASE_OCI_BASE),
        "hx-app-prod-b": fixtureTarget(4, "acme-target-prod-b", "Prod", "us-west", FIXTURE_SPACE_RELEASE_OCI_BASE),
      },
    },
  };
}

function pinFixtureCommit(request, commit) {
  request.spec.source.commit = commit;
  request.spec.security.credentialScan.sourceCommit = commit;
  request.spec.security.credentialScan.reportSHA256 = `sha256:${sha256(`gitleaks:${commit}:${request.spec.source.path}`)}`;
}

function remapFixtureDestination(request) {
  const value = structuredClone(request);
  value.spec.destination.organization = "Second Acme Kubara";
  value.spec.destination.context = "second-acme-kubara";
  value.spec.destination.organizationExternalID = deterministicUUID("second:organization-external");
  value.spec.destination.organizationID = deterministicUUID("second:organization-entity");
  value.spec.destination.spaceReleaseOCIBase = "oci://oci.second.example.invalid:5443/space-releases";
  value.spec.destination.argobotBase.spaceID = deterministicUUID("second:argobot-base-space");
  value.spec.destination.argobotBase.unitID = deterministicUUID("second:argobot-base-unit");
  for (const [cluster, target] of Object.entries(value.spec.targets)) {
    target.spaceID = deterministicUUID(`second:${cluster}:target-space`);
    target.targetID = deterministicUUID(`second:${cluster}:target`);
    target.delivery.appsSpaceID = deterministicUUID(`second:${cluster}:apps-space`);
    target.delivery.root.unitID = deterministicUUID(`second:${cluster}:root-unit`);
    target.delivery.argobotApplication.unitID = deterministicUUID(`second:${cluster}:argobot-application-unit`);
    target.delivery.argobot.spaceID = deterministicUUID(`second:${cluster}:argobot-space`);
    target.delivery.argobot.unitID = deterministicUUID(`second:${cluster}:argobot-unit`);
    const rootData = fakeBootstrapApplicationData(target.delivery.root.unit, target.delivery.appsSpace, value.spec.destination.spaceReleaseOCIBase);
    target.delivery.root.dataHash = sha256(rootData);
    target.delivery.root.dataSHA256 = sha256(rootData);
    const argobotApplicationData = fakeBootstrapApplicationData(target.delivery.argobotApplication.unit, target.delivery.argobot.space, value.spec.destination.spaceReleaseOCIBase);
    target.delivery.argobotApplication.dataHash = sha256(argobotApplicationData);
    target.delivery.argobotApplication.dataSHA256 = sha256(argobotApplicationData);
    target.delivery.reconciler.evidenceRef = `evidence://second-cluster/${cluster}/argocd-runtime`;
    target.delivery.reconciler.evidenceSHA256 = `sha256:${sha256(`second:${cluster}:argocd-runtime:v3.4.6`)}`;
  }
  return value;
}

function fixtureTarget(index, space, environment, region, spaceReleaseOCIBase) {
  const suffix = String(index).padStart(12, "0");
  const cluster = index === 1 ? "hx-app-dev" : index === 2 ? "hx-app-staging" : index === 3 ? "hx-app-prod-a" : "hx-app-prod-b";
  const appsSpace = `${cluster}-argo-apps`;
  const argobotSpace = `argobot-${cluster}`;
  const argobotApplication = `argobot-${cluster}`;
  return {
    space,
    spaceID: `30000000-0000-4000-8000-${suffix}`,
    target: "target",
    targetID: `40000000-0000-4000-8000-${suffix}`,
    environment,
    region,
    delivery: {
      appsSpace,
      appsSpaceID: `60000000-0000-4000-8000-${suffix}`,
      root: { unit: "root", unitID: `61000000-0000-4000-8000-${suffix}`, dataHash: sha256(fakeBootstrapApplicationData("root", appsSpace, spaceReleaseOCIBase)), dataSHA256: sha256(fakeBootstrapApplicationData("root", appsSpace, spaceReleaseOCIBase)) },
      argobotApplication: { unit: argobotApplication, unitID: `62000000-0000-4000-8000-${suffix}`, dataHash: sha256(fakeBootstrapApplicationData(argobotApplication, argobotSpace, spaceReleaseOCIBase)), dataSHA256: sha256(fakeBootstrapApplicationData(argobotApplication, argobotSpace, spaceReleaseOCIBase)) },
      argobot: { space: argobotSpace, spaceID: `63000000-0000-4000-8000-${suffix}`, unit: "argobot", unitID: `64000000-0000-4000-8000-${suffix}`, dataHash: sha256(fakeArgobotData()), dataSHA256: sha256(fakeArgobotData()) },
      reconciler: {
        componentVersion: "v3.4.6",
        image: "quay.io/argoproj/argocd:v3.4.6",
        evidenceRef: `evidence://cluster/${cluster}/argocd-runtime`,
        evidenceSHA256: `sha256:${sha256(`${cluster}:argocd-runtime:v3.4.6`)}`,
      },
      workloadApplications: [],
    },
  };
}

function completedTargetFactAttestation(compiled) {
  const value = structuredClone(compiled.targetFactsRequired);
  for (const row of value.spec.bindings) row.status = "verified-present";
  for (const [index, row] of value.spec.resolutions.entries()) {
    row.status = "satisfied";
    row.evidenceRef = `evidence://kubara-target-fact/${index + 1}`;
    row.evidenceSHA256 = `sha256:${sha256(`${row.consumer}\0${row.fact}\0self-test`)}`;
  }
  value.spec.policy.secretValuesIncluded = false;
  value.spec.policy.generatedTemplateIsAnAttestation = true;
  return value;
}

function fakeBootstrapApplicationData(name, sourceSpace, spaceReleaseOCIBase = FIXTURE_SPACE_RELEASE_OCI_BASE) {
  return `${toYaml({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name, namespace: "argocd" },
    spec: {
      project: "default",
      source: { repoURL: spaceReleaseOCIRef(spaceReleaseOCIBase, sourceSpace), targetRevision: "latest", path: "." },
      destination: { server: "https://kubernetes.default.svc", namespace: "argocd" },
      syncPolicy: { automated: { prune: false, selfHeal: true } },
    },
  })}\n`;
}

function fakeArgobotData() {
  return `${toYaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "argobot", namespace: "argocd" }, data: { mode: "cluster-local" } })}\n`;
}

function createFakeOciClient() {
  const artifacts = new Map();
  const client = {
    tamperFetch: false,
    inspect(ref) {
      const row = artifacts.get(ref);
      if (!row) return null;
      return { manifestDigest: row.manifestDigest, artifactType: row.artifactType, layers: structuredClone(row.layers) };
    },
    push(expected) {
      const bytes = readFileSync(expected.path);
      const layer = { mediaType: expected.layerType, digest: `sha256:${sha256(bytes)}`, size: bytes.length };
      const manifestDigest = `sha256:${sha256(stableJson({ ref: expected.ref, artifactType: expected.artifactType, layer }))}`;
      artifacts.set(expected.ref, { manifestDigest, artifactType: expected.artifactType, layers: [layer], bytes: Buffer.from(bytes) });
    },
    fetch(ref, layerDigest, outputPath) {
      const row = artifacts.get(ref);
      check(row?.layers?.[0]?.digest === layerDigest, `${ref}@${layerDigest}: fake OCI layer is missing`);
      const bytes = client.tamperFetch ? Buffer.concat([row.bytes, Buffer.from("tampered")]) : row.bytes;
      writeFileSync(outputPath, bytes);
    },
    snapshot(ref) {
      const row = artifacts.get(ref);
      return row ? {
        manifestDigest: row.manifestDigest,
        artifactType: row.artifactType,
        layers: row.layers.map((layer) => ({ ...layer })),
        bytes: Buffer.from(row.bytes),
      } : null;
    },
    restore(ref, row) { artifacts.set(ref, { manifestDigest: row.manifestDigest, artifactType: row.artifactType, layers: row.layers.map((layer) => ({ ...layer })), bytes: Buffer.from(row.bytes) }); },
    corruptLayer(ref) {
      const row = artifacts.get(ref);
      check(row, `${ref}: fake OCI artifact missing for corruption test`);
      row.layers[0].digest = `sha256:${"f".repeat(64)}`;
    },
  };
  return client;
}

function createFakeHub(compiled) {
  const request = compiled.execution.request;
  const destination = request.spec.destination;
  const spaces = new Map();
  const units = new Map();
  const unitData = new Map();
  const links = new Map();
  const targets = new Map();
  const releases = new Map();
  const unchangedReleaseResponses = new Set();
  let failMutationNumber = null;
  let mutationCounter = 0;
  let failAfterPublishedReleaseSpace = null;
  let sequence = 1;
  const id = (kind, value) => deterministicUUID(`${kind}:${value}`);
  const addSpace = (slug, spaceID, extra = {}) => {
    spaces.set(slug, { Slug: slug, SpaceID: spaceID, OrganizationID: destination.organizationID, Labels: {}, Annotations: {}, ReleaseTargetID: null, ...extra });
    units.set(slug, new Map());
    links.set(slug, new Map());
    releases.set(slug, []);
  };
  const putUnit = (space, slug, data, extra = {}) => {
    const row = {
      Slug: slug,
      UnitID: extra.UnitID ?? id("unit", `${space}/${slug}`),
      Labels: structuredClone(extra.Labels ?? {}),
      Annotations: structuredClone(extra.Annotations ?? {}),
      ToolchainType: extra.ToolchainType ?? "Kubernetes/YAML",
      ProviderType: extra.ProviderType ?? null,
      TargetID: extra.TargetID ?? null,
      UpstreamUnitID: extra.UpstreamUnitID ?? null,
      DataHash: sha256(data),
      HeadRevisionNum: extra.HeadRevisionNum ?? 1,
      LastReleasedRevisionNum: extra.LastReleasedRevisionNum ?? 1,
    };
    units.get(space).set(slug, row);
    unitData.set(`${space}/${slug}`, data);
    return row;
  };
  const putLink = (space, slug, extra) => {
    const row = { Slug: slug, LinkID: extra.LinkID ?? id("link", `${space}/${slug}`), Labels: {}, Annotations: {}, AutoUpdate: false, ...extra };
    links.get(space).set(slug, row);
    return row;
  };
  const seedPublishedRelease = (space) => {
    const rows = [...units.get(space).values()].sort((left, right) => left.Slug.localeCompare(right.Slug));
    const digestInput = rows.map((row) => `${row.Slug}:${row.DataHash}:${row.HeadRevisionNum}`).join("|");
    releases.get(space).push({
      ReleaseNum: releases.get(space).length + 1,
      Digest: `sha256:${sha256(`bundle:${space}:${digestInput}`)}`,
      ManifestDigest: `sha256:${sha256(`manifest:${space}:1:${digestInput}`)}`,
      CreatedAt: `self-test-${String(sequence++).padStart(4, "0")}`,
    });
  };
  addSpace(destination.argobotBase.space, destination.argobotBase.spaceID, {
    Annotations: { "confighub.com/external-source": JSON.stringify([{ ref: destination.argobotBase.sourceRef, digest: destination.argobotBase.sourceDigest }]) },
  });
  const argobotBaseData = fakeArgobotData();
  putUnit(destination.argobotBase.space, destination.argobotBase.unit, argobotBaseData, {
    UnitID: destination.argobotBase.unitID,
    Labels: { ComponentVersion: destination.argobotBase.componentVersion },
  });
  for (const [cluster, target] of Object.entries(request.spec.targets)) {
    addSpace(target.space, target.spaceID);
    targets.set(`${target.space}/${target.target}`, {
      Slug: target.target,
      TargetID: target.targetID,
      SpaceID: target.spaceID,
      ProviderType: "OCI",
      ToolchainType: "Any",
      Annotations: { "confighub.com/argo-apps-space": target.delivery.appsSpace },
    });
    addSpace(target.delivery.appsSpace, target.delivery.appsSpaceID, { ReleaseTargetID: target.targetID });
    putUnit(target.delivery.appsSpace, target.delivery.root.unit, fakeBootstrapApplicationData(target.delivery.root.unit, target.delivery.appsSpace, destination.spaceReleaseOCIBase), { UnitID: target.delivery.root.unitID, TargetID: target.targetID });
    putUnit(target.delivery.appsSpace, target.delivery.argobotApplication.unit, fakeBootstrapApplicationData(target.delivery.argobotApplication.unit, target.delivery.argobot.space, destination.spaceReleaseOCIBase), { UnitID: target.delivery.argobotApplication.unitID, TargetID: target.targetID });
    addSpace(target.delivery.argobot.space, target.delivery.argobot.spaceID, { ReleaseTargetID: target.targetID });
    putUnit(target.delivery.argobot.space, target.delivery.argobot.unit, argobotBaseData, { UnitID: target.delivery.argobot.unitID, TargetID: target.targetID, UpstreamUnitID: destination.argobotBase.unitID });
    putLink(target.delivery.argobot.space, `upgrade-${target.delivery.argobot.unit}`, {
      UpdateType: "UpgradeUnit",
      FromUnitID: target.delivery.argobot.unitID,
      ToUnitID: destination.argobotBase.unitID,
      ToSpaceID: destination.argobotBase.spaceID,
    });
    seedPublishedRelease(target.delivery.argobot.space);
  }
  for (const row of externalInfrastructureSpaces(request)) {
    addSpace(row.space, row.spaceID);
    for (const unit of row.units ?? []) putUnit(row.space, unit.slug, `${toYaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: unit.slug } })}\n`, { UnitID: unit.unitID });
  }

  const clone = (value) => value == null ? value : structuredClone(value);
  const applyPairs = (entity, commandArgs) => {
    for (let index = 0; index < commandArgs.length; index += 1) {
      if (!["--label", "--annotation"].includes(commandArgs[index])) continue;
      const field = commandArgs[index] === "--label" ? "Labels" : "Annotations";
      const raw = commandArgs[index + 1];
      const separator = raw.indexOf("=");
      const key = raw.slice(0, separator);
      const value = raw.slice(separator + 1);
      entity[field] ??= {};
      if (value === "-") delete entity[field][key];
      else entity[field][key] = value;
      index += 1;
    }
  };
  const flag = (commandArgs, name) => {
    const index = commandArgs.indexOf(name);
    return index >= 0 ? commandArgs[index + 1] : null;
  };
  const client = {
    request,
    assertExactCoordinate() {},
    assertVersion() {},
    listSpaces() { return [...spaces.values()].map(clone); },
    getSpace(space) { return clone(spaces.get(space) ?? null); },
    listUnits(space) { return [...(units.get(space)?.values() ?? [])].map(clone); },
    getUnit(space, slug) { return clone(units.get(space)?.get(slug) ?? null); },
    unitData(space, slug) { const value = unitData.get(`${space}/${slug}`); check(value !== undefined, `${space}/${slug}: fake Unit data missing`); return value; },
    listLinks(space) { return [...(links.get(space)?.values() ?? [])].map(clone); },
    getTarget(space, slug) { return clone(targets.get(`${space}/${slug}`) ?? null); },
    listPublishedReleases(space) { return (releases.get(space) ?? []).map(clone); },
    mutate(commandArgs, options = {}) {
      mutationCounter += 1;
      if (failMutationNumber !== null && mutationCounter === failMutationNumber) {
        failMutationNumber = null;
        throw new Error("simulated bounded apply interruption");
      }
      const [resource, verb] = commandArgs;
      if (resource === "space" && verb === "create") {
        const slug = commandArgs[2];
        addSpace(slug, id("space", slug));
        applyPairs(spaces.get(slug), commandArgs);
        return {};
      }
      if (resource === "space" && verb === "update") {
        const slug = commandArgs[2] === "--patch" ? commandArgs[3] : commandArgs[2];
        const row = spaces.get(slug);
        check(row, `${slug}: fake Space missing`);
        applyPairs(row, commandArgs);
        const releaseTarget = flag(commandArgs, "--release-target");
        if (releaseTarget) row.ReleaseTargetID = requestTargetByRef(request, releaseTarget).targetID;
        return {};
      }
      if (resource === "unit" && verb === "create") {
        const space = flag(commandArgs, "--space");
        const spaceIndex = commandArgs.indexOf("--space");
        const slug = commandArgs[spaceIndex + 2];
        const path = commandArgs[spaceIndex + 3];
        const provider = flag(commandArgs, "--provider");
        const row = putUnit(space, slug, readFileSync(path, "utf8"), { ToolchainType: flag(commandArgs, "--toolchain") ?? "Kubernetes/YAML", ProviderType: provider, LastReleasedRevisionNum: 0 });
        applyPairs(row, commandArgs);
        return {};
      }
      if (resource === "unit" && verb === "update") {
        const spaceIndex = commandArgs.indexOf("--space");
        const space = commandArgs[spaceIndex + 1];
        const slug = commandArgs[spaceIndex + 2];
        const row = units.get(space)?.get(slug);
        check(row, `${space}/${slug}: fake Unit missing`);
        const possiblePath = commandArgs[spaceIndex + 3];
        if (possiblePath && !possiblePath.startsWith("--")) {
          const data = readFileSync(possiblePath, "utf8");
          unitData.set(`${space}/${slug}`, data);
          row.DataHash = sha256(data);
          row.HeadRevisionNum += 1;
        }
        applyPairs(row, commandArgs);
        return {};
      }
      if (resource === "unit" && verb === "set-target") {
        const spaceIndex = commandArgs.indexOf("--space");
        const space = commandArgs[spaceIndex + 1];
        const slug = commandArgs[spaceIndex + 2];
        const targetRef = commandArgs[spaceIndex + 3];
        units.get(space).get(slug).TargetID = targetRef === "-" ? null : requestTargetByRef(request, targetRef).targetID;
        return {};
      }
      if (resource === "variant" && verb === "create") {
        const upstreamSpace = commandArgs[3];
        const spacePattern = flag(commandArgs, "--space-pattern");
        const space = spacePattern.replace(/^template:/, "");
        const targetRef = flag(commandArgs, "--target");
        const targetID = targetRef ? requestTargetByRef(request, targetRef).targetID : null;
        const upstream = spaces.get(upstreamSpace);
        addSpace(space, id("space", space), { Labels: clone(upstream.Labels), Annotations: clone(upstream.Annotations), ReleaseTargetID: targetID });
        for (const upstreamUnit of units.get(upstreamSpace).values()) {
          const data = unitData.get(`${upstreamSpace}/${upstreamUnit.Slug}`);
          const cloned = putUnit(space, upstreamUnit.Slug, data, { Labels: clone(upstreamUnit.Labels), Annotations: clone(upstreamUnit.Annotations), ToolchainType: upstreamUnit.ToolchainType, ProviderType: upstreamUnit.ProviderType, TargetID: targetID, UpstreamUnitID: upstreamUnit.UnitID, LastReleasedRevisionNum: 0 });
          putLink(space, `upgrade-${upstreamUnit.Slug}`, { UpdateType: "UpgradeUnit", FromUnitID: cloned.UnitID, ToUnitID: upstreamUnit.UnitID, ToSpaceID: upstream.SpaceID });
        }
        if (targetRef) {
          const appPlan = compiled.plan.spec.configHub.deliveryApplications.find((row) => row.sourceSpace === space);
          check(appPlan, `${space}: fake delivery Application plan missing`);
          const target = requestTargetByRef(request, targetRef);
          const autoApp = autoGeneratedPlatformDeliveryApplication(destination.spaceReleaseOCIBase, space, appPlan.destinationNamespace);
          const app = putUnit(appPlan.space, appPlan.slug, `${toYaml(autoApp)}\n`, { TargetID: target.targetID, LastReleasedRevisionNum: 0 });
          app.Labels = {};
        }
        return {};
      }
      if (resource === "link" && ["create", "update"].includes(verb)) {
        const spaceIndex = commandArgs.indexOf("--space");
        const space = commandArgs[spaceIndex + 1];
        const slug = commandArgs[spaceIndex + 2];
        const fromSlug = commandArgs[spaceIndex + 3];
        const toSlug = commandArgs[spaceIndex + 4];
        const toSpaceSlug = commandArgs[spaceIndex + 5];
        const row = links.get(space).get(slug) ?? putLink(space, slug, {});
        Object.assign(row, {
          FromUnitID: units.get(space).get(fromSlug).UnitID,
          ToUnitID: units.get(toSpaceSlug).get(toSlug).UnitID,
          ToSpaceID: spaces.get(toSpaceSlug).SpaceID,
          UpdateType: flag(commandArgs, "--update-type"),
          AutoUpdate: false,
        });
        applyPairs(row, commandArgs);
        return {};
      }
      if (resource === "release" && verb === "publish") {
        const space = commandArgs[2];
        const rows = [...units.get(space).values()];
        for (const row of rows) row.LastReleasedRevisionNum = row.HeadRevisionNum;
        if (unchangedReleaseResponses.delete(space)) {
          throw new Error(`cub release publish ${space} failed\nHTTP 400: ${UNCHANGED_RELEASE_ERROR}`);
        }
        const digestInput = rows.sort((left, right) => left.Slug.localeCompare(right.Slug)).map((row) => `${row.Slug}:${row.DataHash}:${row.HeadRevisionNum}`).join("|");
        const releaseNum = releases.get(space).length + 1;
        const release = { ReleaseNum: releaseNum, Digest: `sha256:${sha256(`bundle:${space}:${digestInput}`)}`, ManifestDigest: `sha256:${sha256(`manifest:${space}:${releaseNum}:${digestInput}`)}`, CreatedAt: `self-test-${String(sequence++).padStart(4, "0")}` };
        releases.get(space).push(release);
        if (failAfterPublishedReleaseSpace === space) {
          failAfterPublishedReleaseSpace = null;
          throw new Error(`simulated interruption after published release ${space}`);
        }
        return options.json ? { Release: clone(release) } : {};
      }
      check(false, `fake ConfigHub client does not implement ${resource}/${verb}`);
    },
    setTargetID(space, slug, targetID) { targets.get(`${space}/${slug}`).TargetID = targetID; },
    failAfterMutations(count) {
      check(Number.isSafeInteger(count) && count > 0, "fake mutation failure count must be positive");
      mutationCounter = 0;
      failMutationNumber = count;
    },
    failAfterPublishedRelease(space) { failAfterPublishedReleaseSpace = space; },
    simulateUnchangedBundleOnNextPublish(space) {
      const row = units.get(space)?.values().next().value;
      check(row && releases.get(space)?.length > 0, `${space}: fake unchanged-bundle recovery requires a Unit and published release`);
      row.HeadRevisionNum += 1;
      unchangedReleaseResponses.add(space);
    },
    driftUnitHead(space, slug) { units.get(space).get(slug).HeadRevisionNum += 1; },
    snapshotUnit(space, slug) { return { row: clone(units.get(space).get(slug)), data: unitData.get(`${space}/${slug}`) }; },
    tamperUnitData(space, slug, data) {
      const row = units.get(space).get(slug);
      unitData.set(`${space}/${slug}`, data);
      row.DataHash = sha256(data);
      row.HeadRevisionNum += 1;
    },
    restoreUnit(space, slug, snapshot) { units.get(space).set(slug, clone(snapshot.row)); unitData.set(`${space}/${slug}`, snapshot.data); },
    stripLinkOwnership(updateType) {
      for (const [space, rows] of links) for (const row of rows.values()) if (row.UpdateType === updateType && row.Labels?.ManagedBy) {
        const snapshot = clone(row);
        for (const key of ["ManagedBy", "ImportName", "PlatformDigest"]) delete row.Labels[key];
        return { space, slug: row.Slug, snapshot };
      }
      check(false, `fake ${updateType} Link with importer ownership is missing`);
    },
    rewireLink(updateType) {
      for (const [space, rows] of links) for (const row of rows.values()) if (row.UpdateType === updateType) {
        const snapshot = clone(row);
        row.ToUnitID = id("unit", `concurrent-rewire:${space}/${row.Slug}`);
        return { space, slug: row.Slug, snapshot };
      }
      check(false, `fake ${updateType} Link is missing for concurrent rewire`);
    },
    restoreLink(value) { links.get(value.space).set(value.slug, clone(value.snapshot)); },
    addPublishedWorkload(cluster, applicationName, { legacyLatest = false } = {}) {
      const target = request.spec.targets[cluster];
      check(target, `${cluster}: fake workload target is missing`);
      const sourceSpace = `acme-app-${applicationName}`;
      const sourceUnit = applicationName;
      const sourceSpaceID = id("space", sourceSpace);
      const sourceUnitID = id("unit", `${sourceSpace}/${sourceUnit}`);
      const sourceData = `${toYaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: applicationName, namespace: "apps" }, data: { revision: "one" } })}\n`;
      addSpace(sourceSpace, sourceSpaceID);
      putUnit(sourceSpace, sourceUnit, sourceData, { UnitID: sourceUnitID });
      seedPublishedRelease(sourceSpace);
      const sourceReleaseManifestDigest = latestReleaseRow(releases.get(sourceSpace)).ManifestDigest;
      const applicationDocument = legacyLatest
        ? parseDocs(fakeBootstrapApplicationData(applicationName, sourceSpace, destination.spaceReleaseOCIBase))[0]
        : platformDeliveryApplication(destination.spaceReleaseOCIBase, sourceSpace, "apps", sourceReleaseManifestDigest);
      applicationDocument.metadata.name = applicationName;
      const exactApplicationData = `${toYaml(applicationDocument)}\n`;
      const applicationUnit = putUnit(target.delivery.appsSpace, applicationName, exactApplicationData, { TargetID: target.targetID });
      seedPublishedRelease(target.delivery.appsSpace);
      return {
        unit: applicationName,
        unitID: applicationUnit.UnitID,
        dataHash: applicationUnit.DataHash,
        dataSHA256: sha256(exactApplicationData),
        headRevisionNum: applicationUnit.HeadRevisionNum,
        sourceSpace,
        sourceSpaceID,
        sourceUnit,
        sourceUnitID,
        sourceReleaseManifestDigest,
      };
    },
    addForeignSpace(slug) { addSpace(slug, id("space", slug)); },
    removeSpace(slug) { spaces.delete(slug); units.delete(slug); links.delete(slug); releases.delete(slug); },
  };
  return client;
}

function createFakeInspectionClient(request, hub) {
  const destination = request.spec.destination;
  return {
    context() {
      return {
        name: destination.context,
        organizationExternalID: destination.organizationExternalID,
        organizationName: destination.organization,
        serverURL: destination.serverURL,
      };
    },
    organization(externalID) {
      check(externalID === destination.organizationExternalID, "fake inspector Organization lookup differs");
      return { DisplayName: destination.organization, ExternalID: externalID, OrganizationID: destination.organizationID };
    },
    space(slug) { return hub.getSpace(slug); },
    unit(space, slug) { return hub.getUnit(space, slug); },
    target(space, slug) { return hub.getTarget(space, slug); },
    unitData(space, slug) { return hub.unitData(space, slug); },
    latestRelease(space) { return latestReleaseRow(hub.listPublishedReleases(space)); },
  };
}

function deterministicUUID(value) {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function checkExactVersion(value, label) {
  check(value && !/[<>=~*^|,\s]/.test(value) && !/^(?:latest|main|master|head|x)$/i.test(value) && /\d/.test(value), `${label} must be an exact version, got ${JSON.stringify(value)}`);
}

function validateGitURL(value) {
  let parsed;
  try { parsed = new URL(value); } catch { check(false, "spec.source.repository must be a valid HTTPS Git URL"); }
  check(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "", "spec.source.repository must be an HTTPS Git URL without embedded credentials");
  check(parsed.search === "" && parsed.hash === "" && parsed.pathname.endsWith(".git"), "spec.source.repository must end in .git and contain no mutable query or fragment");
}

function validateArtifactURL(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { check(false, `${label}: artifact URL is invalid`); }
  check(["https:", "oci:"].includes(parsed.protocol), `${label}: artifact URL must use HTTPS or OCI`);
  check(parsed.username === "" && parsed.password === "", `${label}: artifact URL must not contain embedded credentials`);
  check(parsed.search === "" && parsed.hash === "", `${label}: artifact URL must not contain a mutable query or fragment`);
}

function validateRuntimeImage(value, label) {
  const text = String(value ?? "");
  check(text.length > 3 && !/[\s<>]/.test(text), `${label} must be a concrete container image reference`);
  check(!/^(?:https?|oci):\/\//.test(text), `${label} must use container image syntax, not a URL`);
  check(!text.includes("@") || /@sha256:[0-9a-f]{64}$/.test(text), `${label} image digest must be an exact sha256 digest`);
  const lastSlash = text.lastIndexOf("/");
  const tagSeparator = text.lastIndexOf(":");
  const hasDigest = /@sha256:[0-9a-f]{64}$/.test(text);
  const tag = tagSeparator > lastSlash ? text.slice(tagSeparator + 1) : "";
  check(hasDigest || tag.length > 0, `${label} must include an exact version tag or digest`);
  if (!hasDigest) checkExactVersion(tag, label);
  check(!/(?:^|[/:])latest(?:$|@)/i.test(text), `${label} must not use latest`);
}

function validateOCIRepositoryRef(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { check(false, `${label} must be a valid OCI repository URL`); }
  check(parsed.protocol === "oci:" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" && parsed.pathname !== "", `${label} must be an OCI repository URL without credentials, query, or fragment`);
}

function validateOCIRepositoryBase(value, label) {
  validateOCIRepositoryRef(value, label);
  const parsed = new URL(value);
  check(!/[{@}]/.test(value), `${label} cannot contain placeholders`);
  check(!parsed.pathname.endsWith("/"), `${label} must not end with a slash`);
  check(!/[:@][^/]+$/.test(parsed.pathname), `${label} must be an untagged, undigested OCI repository base`);
}

function validateServerURL(value) {
  let parsed;
  try { parsed = new URL(value); } catch { check(false, "spec.destination.serverURL must be a valid HTTPS URL"); }
  check(
    parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && ["", "/"].includes(parsed.pathname),
    "spec.destination.serverURL must be an HTTPS origin without credentials, path, query, or fragment",
  );
}

function validateNavigationURL(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { check(false, `${label} must be a valid HTTPS URL`); }
  check(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && !String(value).includes(",") && !String(value).includes("="), `${label} must be an HTTPS URL without credentials, commas, or equals signs`);
}

function checkSafeRelative(value, label) {
  check(typeof value === "string" && value.length > 0, `${label} is required`);
  check(!value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"), `${label} must be a safe relative path`);
}

function checkSlug(value, label) {
  check(/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value ?? ""), `${label} must be a lowercase DNS-style slug`);
}

function safeJoin(root, child) {
  checkSafeRelative(child, "relative path");
  const result = resolve(root, child);
  check(isWithin(result, root), `${child}: path escapes its declared root`);
  return result;
}

function assertNoSymlinkPath(root, path) {
  check(isWithin(path, root), `${path}: path is outside ${root}`);
  let current = resolve(root);
  check(!lstatSync(current).isSymbolicLink(), `${current}: symbolic link roots are refused`);
  const rel = relative(current, resolve(path));
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    check(!lstatSync(current).isSymbolicLink(), `${current}: symbolic links are refused`);
  }
}

function ensureSafeOutputTree(outputRoot, { create = false } = {}) {
  if (create) mkdirSync(outputRoot, { recursive: true });
  check(existsSync(outputRoot), `output directory does not exist: ${outputRoot}`);
  check(lstatSync(outputRoot).isDirectory() && !lstatSync(outputRoot).isSymbolicLink(), `${outputRoot}: output must be a real directory, not a symbolic link`);
  rejectSymlinks(outputRoot);
}

function assertOutputOutsideCheckout(outputRoot, checkoutRoot, operation) {
  const checkout = realpathSync(checkoutRoot);
  if (existsSync(outputRoot)) {
    check(!lstatSync(outputRoot).isSymbolicLink(), `${operation} output must not be a symbolic link`);
    check(!isWithin(realpathSync(outputRoot), checkout), `--output must resolve outside the source checkout; ${operation} never mutates its Git input`);
    return;
  }
  let existing = dirname(outputRoot);
  while (!existsSync(existing)) existing = dirname(existing);
  check(!lstatSync(existing).isSymbolicLink(), `${operation} output ancestor must not be a symbolic link`);
  const projected = resolve(realpathSync(existing), relative(existing, outputRoot));
  check(!isWithin(projected, checkout), `--output must resolve outside the source checkout; ${operation} never mutates its Git input`);
}

function isWithin(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function rejectSymlinks(root, skipGit = false) {
  const visit = (path) => {
    const stat = lstatSync(path);
    check(!stat.isSymbolicLink(), `${path}: symbolic links are refused in selected import inputs`);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) {
      if (skipGit && entry === ".git") continue;
      visit(join(path, entry));
    }
  };
  visit(root);
}

function walkFiles(root, skipGit = false) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skipGit && entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path, skipGit));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

function digestTree(root) {
  return digestRows(walkFiles(root).map((path) => `${relative(root, path).replaceAll("\\", "/")}\0${sha256(readFileSync(path))}`));
}

function payloadFileRows(root) {
  rejectSymlinks(root);
  return walkFiles(root).map((path) => payloadFileRow(path, relative(root, path).replaceAll("\\", "/")));
}

function payloadFileRow(path, payloadPath) {
  const bytes = readFileSync(path);
  return {
    path: payloadPath,
    sha256: sha256(bytes),
    size: bytes.length,
    contentBase64: bytes.toString("base64"),
  };
}

function digestRows(rows) {
  const hash = createHash("sha256");
  for (const row of [...rows].sort()) hash.update(`${row}\n`);
  return hash.digest("hex");
}

function git(cwd, gitArgs) {
  return execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitInit(checkout, remote) {
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["-C", checkout, "init", "--quiet"]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", remote]);
}

function commitAll(checkout, message) {
  execFileSync("git", ["-C", checkout, "add", "--all"]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Kubara Import Self-Test", "-c", "user.email=kubara-import@example.invalid", "commit", "--quiet", "-m", message]);
  return git(checkout, ["rev-parse", "HEAD"]);
}

function normalizeGitURL(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function gitPath(checkoutRoot, path) {
  return relative(checkoutRoot, path).replaceAll("\\", "/");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error.message}`);
  }
}

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sameUnitData(toolchain, actual, expected) {
  try {
    // ConfigHub returns the exact submitted bytes in the common path. Avoid
    // reparsing multi-megabyte effective renders on every idempotency pass;
    // semantic normalization remains the fallback for harmless YAML changes.
    if (actual === expected) return true;
    if (toolchain === "Kubernetes/YAML") return canonicalDocuments(actual) === canonicalDocuments(expected);
    if (toolchain === "AppConfig/JSON") return stableJson(JSON.parse(actual)) === stableJson(JSON.parse(expected));
    return stableJson(parseDocs(actual)) === stableJson(parseDocs(expected));
  } catch {
    return false;
  }
}

function canonicalDocuments(text) {
  return stableJson(parseDocs(text).sort((left, right) => resourceIdentity(left).localeCompare(resourceIdentity(right))));
}

function resourceIdentity(value) {
  return `${value?.apiVersion ?? ""}|${value?.kind ?? ""}|${value?.metadata?.namespace ?? ""}|${value?.metadata?.name ?? ""}`;
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortDeep(nested)]));
  return value;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function exactOCIRefTag(value) {
  const text = String(value ?? "");
  const lastSlash = text.lastIndexOf("/");
  const colon = text.lastIndexOf(":");
  check(text.startsWith("oci://") && colon > lastSlash, `Kubara bootstrapCatalog must be an exact tagged OCI ref, got ${text || "missing"}`);
  const tag = text.slice(colon + 1);
  checkExactVersion(tag, "Kubara catalog");
  return tag;
}

function definitionSpace(prefix, service) {
  return `${prefix}-${service}-base`;
}

function instanceSpace(prefix, cluster, service) {
  return `${prefix}-${service}-${cluster}`;
}

function unit(space, slug, role, target, toolchain, source, extra = {}) {
  return { space, slug, role, target, toolchain, provider: toolchain.startsWith("AppConfig/") ? "None" : null, source, labels: { Role: role }, ...extra };
}

function uniqueLinkSlug(base, rows) {
  const used = new Set(rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function dedupeBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!result.has(value)) result.set(value, row);
    else check(stableJson(result.get(value)) === stableJson(row), `conflicting duplicate plan row ${value}`);
  }
  return [...result.values()];
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(row);
  }
  return result;
}

function navigationAnnotations(request) {
  const supplied = request.spec.navigation ?? {};
  return {
    "URL-Guide": supplied.guideURL ?? PUBLIC_GUIDE_URL,
    "URL-Catalog": supplied.catalogURL ?? PUBLIC_CATALOG_URL,
    ...(supplied.matrixURL ? { "URL-Matrix": supplied.matrixURL } : {}),
    ...(supplied.wiringURL ? { "URL-Wiring": supplied.wiringURL } : {}),
  };
}

function selectKeys(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key]).map((key) => [key, value[key]]));
}

function mapContains(actual, expected) {
  return Object.entries(expected ?? {}).every(([key, value]) => actual?.[key] === value);
}

function checkExactKeys(value, expected, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(stableJson(actual) === stableJson(wanted), `${label} fields differ; expected ${wanted.join(", ")}`);
}

function checkObjectKeys(value, allowed, required, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
  const missing = required.filter((key) => !Object.hasOwn(value, key)).sort();
  check(unknown.length === 0 && missing.length === 0, `${label} fields differ; unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
}

function assertUniqueSemanticKeys(rows, keyFor, label) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const key = keyFor(row);
    check(typeof key === "string" && key.length > 0 && !key.split("\0").some((part) => part.length === 0), `${label} row ${index + 1} has an incomplete semantic key`);
    check(!seen.has(key), `${label} contains duplicate or conflicting semantic key ${key.replaceAll("\0", "/")}`);
    seen.add(key);
  }
}

function validateEvidenceReference(value, label) {
  check(!containsCredentialMaterial(value) && !/:\/\/[^/\s:]+:[^@\s]+@/.test(value), `${label} contains credential-shaped material`);
  if (!value.includes(":")) return;
  let parsed;
  try { parsed = new URL(value); } catch { check(false, `${label} must be a plain identifier or valid URL`); }
  check(parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", `${label} must not contain credentials, query parameters, or fragments`);
}

function staleOwnedKeys(actual, expected, owned) {
  return Object.keys(actual ?? {}).filter((key) => owned.has(key) && !Object.hasOwn(expected ?? {}, key)).sort();
}

function ownedProjection(actual, owned) {
  return Object.fromEntries(Object.entries(actual ?? {}).filter(([key]) => owned.has(key)).sort(([left], [right]) => left.localeCompare(right)));
}

function labelsArgs(labels) {
  return Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function annotationsArgs(annotations) {
  return Object.entries(annotations ?? {}).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => {
    check(!String(value).includes(",") && !String(value).includes("="), `${key}: annotation value contains a comma or equals sign that cub's StringSlice parser cannot represent safely`);
    return ["--annotation", `${key}=${value}`];
  });
}

function requestTargetByRef(request, ref) {
  const [space, target] = ref.split("/");
  const match = Object.values(request.spec.targets).find((row) => row.space === space && row.target === target);
  check(match, `${ref}: target ref is not in the exact request mapping`);
  return match;
}

function externalInfrastructureSpaces(request) {
  return request.spec.externalInfrastructure?.spaces ?? [];
}

function workloadSourceSpaces(request) {
  const rows = new Map();
  for (const target of Object.values(request.spec.targets)) for (const workload of target.delivery.workloadApplications ?? []) {
    if (!rows.has(workload.sourceSpace)) rows.set(workload.sourceSpace, { space: workload.sourceSpace, spaceID: workload.sourceSpaceID, purpose: "PreservedWorkloadSource", units: [] });
    const row = rows.get(workload.sourceSpace);
    if (!row.units.some((unit) => unit.slug === workload.sourceUnit)) row.units.push({ slug: workload.sourceUnit, unitID: workload.sourceUnitID });
  }
  return [...rows.values()].map((row) => ({ ...row, units: row.units.sort((left, right) => left.slug.localeCompare(right.slug)) })).sort((left, right) => left.space.localeCompare(right.space));
}

function deliveryInfrastructureSpaceRows(request) {
  const base = request.spec.destination.argobotBase;
  return [
    { space: base.space, spaceID: base.spaceID },
    ...Object.values(request.spec.targets).flatMap((target) => [
      { space: target.delivery.appsSpace, spaceID: target.delivery.appsSpaceID },
      { space: target.delivery.argobot.space, spaceID: target.delivery.argobot.spaceID },
    ]),
  ];
}

function unwrapEntity(value, key) {
  return value?.[key] ?? value;
}

function unwrapRows(value, key) {
  const rows = value?.[`${key}s`] ?? value?.[key.toLowerCase() + "s"] ?? value;
  check(Array.isArray(rows), `cub ${key} list returned an unexpected shape`);
  return rows.map((row) => row?.[key] ?? row);
}

function versionAtLeast(actual, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(actual) || !/^\d+\.\d+\.\d+$/.test(minimum)) return false;
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function commandResult(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, CONFIGHUB_AGENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 1_200_000,
    maxBuffer: 1024 * 1024 * 300,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: result.error ? `${output}\n${result.error.message}`.trim() : output,
  };
}

function unitDataCommandOutput(result, label) {
  if (!result.ok) {
    const status = Number.isInteger(result.status) ? String(result.status) : "unavailable";
    throw new Error(`${label} failed without exposing Unit content (exit ${status})`);
  }
  return result.stdout;
}

function isNotFoundOutput(output) {
  return /(?:\b404\b|manifest unknown|name unknown|not[ _-]?found|does not exist)/i.test(output);
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
  return parent && typeof parent === "object" && [...SECRET_RESOURCE_REFERENCE_FIELDS]
    .some((field) => nonemptyReference(parent[field]));
}

function isStructuredSecretReferenceField({ key, parent, root }) {
  const value = parent?.[key];
  const tokens = credentialKeyTokens(key);
  if (
    typeof value === "string"
    && ["file", "path"].includes(tokens.at(-1))
    && /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)$/.test(value)
  ) return true;
  if (key === "passwordKey") return hasSiblingSecretResourceReference(parent);
  if (key !== "secretKey") return false;
  if (hasSiblingSecretResourceReference(parent)) return true;
  return EXTERNAL_SECRET_REFERENCE_KINDS.has(root?.kind)
    && ["remoteRef", "sourceRef"].some((field) => nonemptyReference(parent?.[field]));
}

function scanSensitiveMappings(value, path, findings, trail = [], root = null) {
  const document = root ?? value;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanSensitiveMappings(item, path, findings, [...trail, String(index)], root ?? item);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.name === "string" && isSensitiveSecretKey(value.name) && Object.hasOwn(value, "value") && meaningfulSecretValue(value.value)) {
    findings.push(`${path}: literal credential-shaped environment value at ${[...trail, "value"].join(".")}`);
  }
  for (const [key, nested] of Object.entries(value)) {
    const nestedTrail = [...trail, key];
    if (
      !isStructuredSecretReferenceField({ key, parent: value, root: document })
      && isSensitiveSecretKey(key)
      && typeof nested !== "object"
      && meaningfulCredentialValue(nested)
    ) {
      findings.push(`${path}: literal credential-shaped value at ${nestedTrail.join(".")}`);
    }
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

function credentialScannerSelfTest() {
  const legitimateReferences = [
    {
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: { name: "database" },
      spec: {
        data: [{
          secretKey: "database-password",
          remoteRef: { key: "production/database", property: "password" },
        }],
      },
    },
    {
      grafana: {
        admin: {
          existingSecret: "grafana-admin-credentials",
          passwordKey: "admin-password",
        },
      },
    },
  ];
  for (const [index, value] of legitimateReferences.entries()) {
    const findings = [];
    scanSensitiveMappings(value, `legitimate-reference-${index}.yaml`, findings);
    check(findings.length === 0, `credential scanner rejected a structured secret reference: ${findings.join("; ")}`);
  }

  const credentials = [
    { credentials: { secretKey: "literal-secret-key" } },
    { kind: "ConfigMap", credentials: { secretKey: "literal-despite-remote-ref", remoteRef: { key: "not-an-external-secret" } } },
    { grafana: { adminPassword: "literal-admin-password" } },
    { aws: { secretAccessKey: "literal-secret-access-key" } },
    { aws: { accessKeyId: "literal-access-key-id" } },
    { oauth: { bearerToken: "literal-bearer-token" } },
    { env: [{ name: "databasePassword", value: "literal-environment-password" }] },
  ];
  for (const [index, value] of credentials.entries()) {
    const findings = [];
    scanSensitiveMappings(value, `literal-credential-${index}.yaml`, findings);
    check(findings.length > 0, `credential scanner accepted literal camelCase credential fixture ${index}`);
  }
  const rawFindings = [];
  scanRawCredentialAssignments("adminPassword: literal-template-password\n", "literal-credential.tpl", rawFindings);
  check(rawFindings.length === 1, "credential scanner accepted a raw camelCase credential assignment");
  const templatedReferenceFindings = [];
  scanRawCredentialAssignments('adminPassword: "{{ .Values.adminPassword }}"\n', "templated-reference.tpl", templatedReferenceFindings);
  check(templatedReferenceFindings.length === 0, "credential scanner rejected an unresolved Helm template expression as a literal");
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
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("utf8");
  } catch {
    return value;
  }
}

function containsCredentialMaterial(value) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i.test(value)
    || /"(?:password|token|apiKey|clientSecret|privateKey)"\s*:\s*"(?!<|\$\{|REPLACE_ME|CHANGEME|redacted)[^"]+"/i.test(value);
}

function meaningfulSecretValue(value) {
  if (value === null || value === undefined || value === "") return false;
  const text = String(value);
  return !/^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|REPLACE_ME|CHANGEME|redacted|null)$/i.test(text.trim());
}

function meaningfulCredentialValue(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return false;
  return meaningfulSecretValue(value)
    && !/^(?:false|true|none|disabled|enabled)$/i.test(String(value).trim());
}

function pass(id, detail) {
  return { id, result: "pass", detail };
}

function expectFailure(fn, pattern, label) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  check(error && pattern.test(String(error.message)), `${label}: expected ${pattern}, got ${error?.message ?? "success"}`);
}

function requiredOption(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  check(value && !value.startsWith("--"), `${name} is required`);
  return value;
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function optionValues(name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) result.push(args[index + 1]);
  return result;
}

function validateCliArgs(values) {
  const valueFlags = new Set(["--request", "--checkout", "--output", "--portable", "--context", "--target-facts", "--receipt-output", "--previous-apply-receipt", "--credential-scan-report", "--runtime-evidence"]);
  const flags = new Set([...MODES, "--help", ...valueFlags]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    check(flags.has(value), `unknown argument ${value}`);
    if (valueFlags.has(value)) {
      check(values[index + 1] && !values[index + 1].startsWith("--"), `${value} requires a value`);
      index += 1;
    }
  }
}

function usage() {
  console.log(`Usage:
  node scripts/import-kubara-git-revision.mjs --plan    --request <request.yaml> --checkout <clean-git-checkout>
  node scripts/import-kubara-git-revision.mjs --compile --request <request.yaml> --checkout <clean-git-checkout> --output <directory-outside-checkout>
  node scripts/import-kubara-git-revision.mjs --verify  --request <request.yaml> --checkout <clean-git-checkout> --output <directory-outside-checkout>
  node scripts/import-kubara-git-revision.mjs --compile-portable --request <portable-request.yaml> --checkout <clean-git-checkout> --output <portable-directory>
  node scripts/import-kubara-git-revision.mjs --verify-portable  --request <portable-request.yaml> --checkout <clean-git-checkout> --output <portable-directory>
  node scripts/import-kubara-git-revision.mjs --package-portable --request <portable-request.yaml> --checkout <clean-git-checkout> --output <portable-directory>
  node scripts/import-kubara-git-revision.mjs --bind --request <reviewed-destination-request.yaml> --checkout <clean-git-checkout> --portable <portable-directory> --output <bound-directory>
  node scripts/import-kubara-git-revision.mjs --package --request <request.yaml> --checkout <clean-git-checkout> --output <directory-outside-checkout>
  node scripts/import-kubara-git-revision.mjs --apply   --request <request.yaml> --checkout <clean-git-checkout> --output <packaged-output> --context <exact-existing-context> --target-facts <completed-attestation.yaml> [--receipt-output <immutable-snapshot-inside-output>] [--previous-apply-receipt <passing-prior-receipt.json>]
  node scripts/import-kubara-git-revision.mjs --inspect-destination --request <request-template.yaml> --context <exact-existing-context> --credential-scan-report <pass-report> --runtime-evidence <cluster>=<observation.yaml>... --output <reviewed-request.yaml>
  node scripts/import-kubara-git-revision.mjs --self-test

The portable request names only the immutable Git source, exact scanner
attestation, layout, and an untagged OCI repository base. It can be compiled
and published before a ConfigHub organization is selected. The reviewed
destination request separately pins the chosen organization, context,
bootstrap infrastructure, and every Space/Target identity. Bind proves the
portable PlatformDigest is unchanged and copies a passing publication receipt
when present. OCI publication requires authenticated ORAS registry access.
Apply consumes the bound exact package receipt and an external, secret-free
target-fact attestation; it never creates organizations or targets. Use a
distinct --receipt-output for each journaled apply so the mutable canonical
apply-receipt.json cannot destroy an earlier step's evidence.
`);
}
