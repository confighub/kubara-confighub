#!/usr/bin/env node

// Read-only orphan audit for the Kubara + ConfigHub mini-IDP.
//
// The audit deliberately consumes the reconciler's deterministic --plan output
// instead of maintaining a second topology. Live mode acquires the shared
// live-parity lock, refuses every in-flight journal state, and performs only
// ConfigHub/Kubernetes reads. It never deletes or detaches anything.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  check,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  sha256File,
  toYaml,
} from "./lib/proof-common.mjs";

const MODES = new Set(["--plan", "--audit", "--self-test", "--receipt-verify"]);
const requestedModes = process.argv.filter((arg) => MODES.has(arg));
check(requestedModes.length <= 1, `choose one mode: ${[...MODES].join(", ")}`);
const mode = requestedModes[0] ?? "--plan";
const contextOption = optionValue("--context") || process.env.CUB_CONTEXT?.trim() || "";
const receiptOption = optionValue("--receipt");
validateArgs();

const ORGANIZATION = "Kubara";
const ORGANIZATION_EXTERNAL_ID = "58b23b85-9699-4384-bd57-80ef695a1d58";
const ORGANIZATION_ENTITY_ID = "12c33fa8-00b1-4011-ad3e-19d56458b29c";
const CONFIGHUB_SERVER_URL = "https://hub.confighub.com";
const AUDITOR_PATH = join(repoRoot, "scripts", "audit-kubara-mini-idp-orphans.mjs");
const RECONCILER_PATH = join(repoRoot, "scripts", "reconcile-kubara-mini-idp.mjs");
const RECONCILE_RECEIPT_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "receipt.yaml");
const APPLY_ATTEMPT_LEDGER_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "attempts.yaml");
const PERFORMANCE_VERIFIER_PATH = join(repoRoot, "scripts", "verify-kubara-mini-idp-performance.mjs");
const RECEIPT_PATH = receiptOption
  ? resolve(receiptOption)
  : join(repoRoot, "runs", "kubara-mini-idp-reconcile", "orphan-audit.yaml");
const OPERATION_JOURNAL_PATH = join(homedir(), ".confighub", "locks", "helm-expt-kubara-operation-journal.json");
const LIVE_LOCK_PATH = process.env.HELM_EXPT_LIVE_PARITY_LOCK
  ? resolve(process.env.HELM_EXPT_LIVE_PARITY_LOCK)
  : join(homedir(), ".confighub", "locks", "helm-expt-live-parity.lock");
const OCI_SPACE_PREFIX = "oci://oci.hub.confighub.com:443/space/";
const PROTECTED_NAMESPACES = ["default", "kube-system", "kube-public", "kube-node-lease"];
const OWNERSHIP_ANNOTATIONS = [
  "argocd.argoproj.io/tracking-id",
  "confighub.com/origin",
  "confighub.com/SpaceID",
  "confighub.com/UnitSlug",
  "confighub.com/RevisionNum",
];
const LEGACY_DEFAULT_NAMESPACE_LABELS = ["project-name", "stage"];
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_TAG_SLUG_PATTERN = /^release-([1-9][0-9]*)$/;
const ARGO_TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id";
const ARGOBOT_VERSION = "v0.1.6";
const ARGOBOT_IMAGE = `ghcr.io/confighub/argobot:${ARGOBOT_VERSION}`;
const EXPECTED_TRIGGERS = Object.freeze([
  Object.freeze({
    ref: "hx-platform/require-approval",
    purpose: "production-approval",
    event: "Mutation",
    toolchainType: "Kubernetes/YAML",
    functionName: "vet-approvedby",
    arguments: Object.freeze([{ ParameterName: "num-approvers", Value: "1" }]),
    validating: true,
    disabled: false,
    failOpenAfter: 0,
  }),
]);
const EXPECTED_FILTERS = Object.freeze([
  Object.freeze({
    ref: "hx-platform/prod-approval",
    attachment: "production-spaces",
    from: "Trigger",
    where: "Space.Slug = 'hx-platform' AND FunctionName = 'vet-approvedby'",
  }),
]);
const SPACE_READ_SELECT = "SpaceID,OrganizationID,Labels,Annotations,ReleaseTargetID,TriggerFilterID,TriggerIDs,WhereTrigger,DeleteGates";
// Data is not a selectable Unit field any more -- naming it is a 400 -- and DataHash is
// the only hash. The body is read from the Unit's data endpoint and attached as
// ConfigData, which is why ConfigData rather than Data is a snapshot field below.
const UNIT_READ_SELECT = "SpaceID,Labels,Annotations,TargetID,UpstreamUnitID,DeleteGates,DestroyGates,ToolchainType,ProviderType,DataHash,HeadRevisionNum,LastReleasedRevisionNum,ApprovedBy,ApplyGates";
const LINK_READ_SELECT = "SpaceID,FromUnitID,ToUnitID,ToSpaceID,UpdateType,AutoUpdate,Labels,Annotations,UpstreamLastMergedRevisionNum,DownstreamLastMergedRevisionNum";
const TRIGGER_READ_SELECT = "SpaceID,Event,ToolchainType,FunctionName,Arguments,Disabled,Validating,FailOpenAfter";
const FILTER_READ_SELECT = "SpaceID,From,Where";
const TAG_READ_SELECT = "SpaceID,CreatedAt";
const CORE_CONFIGHUB_FINGERPRINT_RESOURCES = Object.freeze(["space", "unit", "release", "link", "target"]);
const FULL_CONFIGHUB_FINGERPRINT_RESOURCES = Object.freeze([...CORE_CONFIGHUB_FINGERPRINT_RESOURCES, "trigger", "filter", "tag"]);
const CONFIGHUB_FINGERPRINT_FIELD_SETS = Object.freeze({
  space: Object.freeze(["OrganizationID", "SpaceID", "Slug", "Labels", "Annotations", "ReleaseTargetID", "TriggerFilterID", "TriggerIDs", "WhereTrigger", "DeleteGates"]),
  unit: Object.freeze(["SpaceID", "UnitID", "Slug", "Labels", "Annotations", "TargetID", "UpstreamUnitID", "DeleteGates", "DestroyGates", "ToolchainType", "ProviderType", "ConfigData", "DataHash", "HeadRevisionNum", "LastReleasedRevisionNum", "ApprovedBy", "ApplyGates"]),
  release: Object.freeze(["SpaceID", "ReleaseID", "TagID", "Digest", "ManifestDigest", "ReleaseNum", "UnitCount", "CreatedAt"]),
  link: Object.freeze(["SpaceID", "LinkID", "Slug", "FromUnitID", "ToUnitID", "ToSpaceID", "UpdateType", "AutoUpdate", "UpstreamLastMergedRevisionNum", "DownstreamLastMergedRevisionNum", "Labels", "Annotations"]),
  target: Object.freeze(["SpaceID", "TargetID", "Slug", "ProviderType", "ToolchainType", "Annotations"]),
  trigger: Object.freeze(["SpaceID", "TriggerID", "Slug", "Event", "ToolchainType", "FunctionName", "Arguments", "Disabled", "Validating", "FailOpenAfter"]),
  filter: Object.freeze(["SpaceID", "FilterID", "Slug", "From", "Where"]),
  tag: Object.freeze(["OrganizationID", "SpaceID", "TagID", "Slug", "CreatedAt"]),
});
const CONFIGHUB_LIST_CALLS_PER_BRACKET = Object.freeze({
  space: 1,
  unit: 1,
  link: 1,
  target: 1,
  release: 1,
  trigger: 1,
  filter: 1,
  tag: 1,
});
const DURABLE_WORKLOAD_RESOURCES = [
  "deployments.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "cronjobs.batch",
  "jobs.batch",
];
const ARGO_CD_RUNTIME_VERSION = "v3.4.6";
const ARGO_CD_RUNTIME_IMAGE = `quay.io/argoproj/argocd:${ARGO_CD_RUNTIME_VERSION}`;
const ARGO_CD_RUNTIME_CONTAINER_PAIRS = Object.freeze([
  ["argocd-application-controller", "argocd-application-controller"],
  ["argocd-applicationset-controller", "argocd-applicationset-controller"],
  ["argocd-dex-server", "copyutil"],
  ["argocd-notifications-controller", "argocd-notifications-controller"],
  ["argocd-redis", "secret-init"],
  ["argocd-repo-server", "argocd-repo-server"],
  ["argocd-repo-server", "copyutil"],
  ["argocd-server", "argocd-server"],
]);
const BOOTSTRAP_DURABLE_WORKLOADS = Object.freeze([
  { group: "apps", kind: "DaemonSet", namespace: "kube-system", name: "kindnet", role: "kind-network" },
  { group: "apps", kind: "DaemonSet", namespace: "kube-system", name: "kube-proxy", role: "kubernetes-network-proxy" },
  { group: "apps", kind: "Deployment", namespace: "kube-system", name: "coredns", role: "kubernetes-dns" },
  { group: "apps", kind: "Deployment", namespace: "local-path-storage", name: "local-path-provisioner", role: "kind-storage" },
  { group: "apps", kind: "StatefulSet", namespace: "argocd", name: "argocd-application-controller", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-applicationset-controller", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-dex-server", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-notifications-controller", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-redis", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-repo-server", role: "argocd-runtime" },
  { group: "apps", kind: "Deployment", namespace: "argocd", name: "argocd-server", role: "argocd-runtime" },
]);
const BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY = new Map(
  BOOTSTRAP_DURABLE_WORKLOADS.map((item) => [resourceKey(item), item]),
);

const reconcilePlan = mode === "--self-test" ? selfTestReconcilePlan() : loadReconcilePlan();
const auditPlan = buildAuditPlan(reconcilePlan);

if (mode === "--plan") {
  console.log(JSON.stringify(publicAuditPlan(auditPlan), null, 2));
} else if (mode === "--self-test") {
  selfTest(auditPlan);
} else if (mode === "--receipt-verify") {
  verifyReceipt(auditPlan);
} else {
  runAudit(auditPlan);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  check(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} requires a value`);
  return process.argv[index + 1];
}

function validateArgs() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (MODES.has(args[index])) continue;
    if (["--context", "--receipt"].includes(args[index])) {
      check(args[index + 1] && !args[index + 1].startsWith("--"), `${args[index]} requires a value`);
      index += 1;
      continue;
    }
    check(false, `unknown argument ${args[index]}`);
  }
}

function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CONFIGHUB_AGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 200,
      timeout: options.timeout ?? 600_000,
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`${binary} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
}

function tryCommand(binary, args, options = {}) {
  try {
    return { ok: true, output: command(binary, args, options) };
  } catch (error) {
    return { ok: false, output: error.message };
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadReconcilePlan() {
  const output = command(process.execPath, [RECONCILER_PATH, "--plan"], { timeout: 1_200_000 });
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(`reconciler --plan did not return JSON: ${error.message}`);
  }
  check(value?.kind === "KubaraMiniIDPReconcilePlan", "unexpected reconciler plan kind");
  check(value.spec?.organization === ORGANIZATION, "reconciler plan Organization drifted");
  check(value.spec?.execution?.organizationExternalID === ORGANIZATION_EXTERNAL_ID, "reconciler plan external Organization ID drifted");
  check(value.spec?.execution?.organizationEntityID === ORGANIZATION_ENTITY_ID, "reconciler plan Organization entity ID drifted");
  check(value.spec?.execution?.serverURL === CONFIGHUB_SERVER_URL, "reconciler plan ConfigHub server drifted");
  return value;
}

function selfTestReconcilePlan() {
  const catalogLabels = {
    CatalogComponents: "103",
    CatalogVersions: "130",
    KubaraSelections: "18",
    Retention: "AdditiveOnly",
  };
  const spaces = [
    { slug: "hx-platform", type: "control" },
    { slug: "cluster-a", type: "cluster-target" },
    { slug: "cluster-a-argo-apps", type: "delivery-instance" },
    { slug: "argobot-base", type: "delivery-definition" },
    { slug: "argobot-cluster-a", type: "delivery-instance" },
    { slug: "app-base", type: "app-definition" },
    { slug: "app-dev", type: "app-instance", target: "cluster-a/target" },
  ];
  const units = [
    { space: "hx-platform", slug: "component-catalog-coverage", target: null, labels: catalogLabels },
    { space: "app-base", slug: "app", target: null },
    { space: "app-dev", slug: "app", target: "cluster-a/target", upstream: "app-base/app" },
  ];
  const preservedControlUnits = [
    { ref: "hx-platform/faithful-hub-spoke-plan", owner: "faithful-hub-spoke-proof" },
    { ref: "hx-platform/faithful-hub-spoke-attestation", owner: "faithful-hub-spoke-proof" },
  ];
  const deliveryApplicationUnits = [
    { ref: "cluster-a-argo-apps/root", labels: { Cluster: "cluster-a" } },
    { ref: "cluster-a-argo-apps/argobot-cluster-a", labels: { Cluster: "cluster-a" } },
    { ref: "cluster-a-argo-apps/app-dev", labels: { Cluster: "cluster-a" } },
  ];
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPReconcilePlan",
    metadata: { name: "self-test" },
    spec: {
      organization: ORGANIZATION,
      execution: {
        organizationExternalID: ORGANIZATION_EXTERNAL_ID,
        organizationEntityID: ORGANIZATION_ENTITY_ID,
        serverURL: CONFIGHUB_SERVER_URL,
      },
      counts: {
        spaces: spaces.length,
        managedUnits: units.length,
        preservedFaithfulControlUnits: preservedControlUnits.length,
        deliveryApplicationUnits: deliveryApplicationUnits.length,
      },
      spaces,
      units,
      preservedControlUnits,
      deliveryApplicationUnits,
      deployments: [{ cluster: "cluster-a", space: "app-dev", appSpace: "cluster-a-argo-apps", appUnit: "app-dev" }],
      links: [],
    },
  };
}

function addUnique(map, key, value, label) {
  check(!map.has(key), `duplicate ${label} ${key}`);
  map.set(key, value);
}

function buildAuditPlan(plan) {
  const spaces = new Map(plan.spec.spaces.map((item) => [item.slug, item]));
  const clusters = [...spaces.values()].filter((item) => item.type === "cluster-target").map((item) => item.slug).sort();
  check(clusters.length > 0, "reconciler plan has no cluster targets");
  const appsSpaces = new Map(clusters.map((cluster) => [cluster, `${cluster}-argo-apps`]));
  for (const [cluster, appsSpace] of appsSpaces) check(spaces.has(appsSpace), `${cluster}: apps Space ${appsSpace} is absent`);

  const units = new Map();
  for (const item of plan.spec.units) {
    const ref = `${item.space}/${item.slug}`;
    addUnique(units, ref, { ...item, ref, owner: "mini-idp-plan", expectedTarget: item.target ?? null }, "Unit");
  }
  for (const item of plan.spec.preservedControlUnits) {
    addUnique(units, item.ref, { ref: item.ref, owner: item.owner, expectedTarget: null }, "Unit");
  }
  for (const item of plan.spec.deliveryApplicationUnits) {
    const cluster = item.labels?.Cluster;
    check(clusters.includes(cluster), `${item.ref}: delivery Application lacks an exact fleet cluster`);
    addUnique(units, item.ref, {
      ref: item.ref,
      owner: "delivery-application",
      expectedTarget: `${cluster}/target`,
      cluster,
      applicationUnit: true,
    }, "Unit");
  }
  addUnique(units, "argobot-base/argobot", {
    ref: "argobot-base/argobot",
    owner: "delivery-helper",
    expectedTarget: null,
  }, "Unit");
  for (const cluster of clusters) {
    const ref = `argobot-${cluster}/argobot`;
    addUnique(units, ref, { ref, owner: "delivery-helper", expectedTarget: `${cluster}/target` }, "Unit");
  }

  const links = new Map();
  for (const item of plan.spec.units.filter((unit) => unit.upstream)) {
    const ref = `${item.space}/upgrade-${item.slug}`;
    addUnique(links, ref, {
      ref,
      space: item.space,
      slug: `upgrade-${item.slug}`,
      from: `${item.space}/${item.slug}`,
      to: item.upstream,
      updateType: "UpgradeUnit",
      autoUpdate: false,
    }, "Link");
  }
  for (const cluster of clusters) {
    const ref = `argobot-${cluster}/upgrade-argobot`;
    addUnique(links, ref, {
      ref,
      space: `argobot-${cluster}`,
      slug: "upgrade-argobot",
      from: `argobot-${cluster}/argobot`,
      to: "argobot-base/argobot",
      updateType: "UpgradeUnit",
      autoUpdate: false,
    }, "Link");
  }
  for (const item of plan.spec.links) {
    const ref = `${item.space}/${item.slug}`;
    addUnique(links, ref, {
      ref,
      space: item.space,
      slug: item.slug,
      from: `${item.space}/${item.fromUnit}`,
      to: `${item.toSpace}/${item.toUnit}`,
      updateType: item.updateType,
      autoUpdate: item.autoUpdate === true,
    }, "Link");
  }

  const targets = new Map(clusters.map((cluster) => [`${cluster}/target`, {
    ref: `${cluster}/target`,
    space: cluster,
    slug: "target",
    appsSpace: appsSpaces.get(cluster),
  }]));
  const triggers = new Map(EXPECTED_TRIGGERS.map((item) => [item.ref, item]));
  const filters = new Map(EXPECTED_FILTERS.map((item) => [item.ref, item]));

  const releaseStreams = new Map();
  for (const deployment of plan.spec.deployments) {
    addUnique(releaseStreams, deployment.space, {
      space: deployment.space,
      cluster: deployment.cluster,
      role: "workload-or-component",
      application: deployment.space,
    }, "current release stream");
  }
  for (const cluster of clusters) {
    const appsSpace = appsSpaces.get(cluster);
    addUnique(releaseStreams, appsSpace, {
      space: appsSpace,
      cluster,
      role: "delivery-root",
      application: "root",
    }, "current release stream");
    addUnique(releaseStreams, `argobot-${cluster}`, {
      space: `argobot-${cluster}`,
      cluster,
      role: "delivery-helper",
      application: null,
    }, "current release stream");
  }

  const allowedRetainedReleaseTypes = new Set([
    "control",
    "component-definition",
    "app-definition",
    "delivery-definition",
    "delivery-runtime-definition",
  ]);
  const catalogCoverage = plan.spec.units.find((item) => item.space === "hx-platform" && item.slug === "component-catalog-coverage")?.labels ?? {};
  check(Number(catalogCoverage.CatalogComponents) > 0, "catalog component retention count is missing from the plan");
  check(Number(catalogCoverage.CatalogVersions) >= Number(catalogCoverage.CatalogComponents), "catalog version retention count is invalid");

  const result = {
    reconcilePlan: plan,
    planSha256: `sha256:${sha256(stableJson(plan))}`,
    reconcilerSha256: `sha256:${sha256File(RECONCILER_PATH)}`,
    spaces,
    units,
    links,
    targets,
    triggers,
    filters,
    clusters,
    appsSpaces,
    releaseStreams,
    allowedRetainedReleaseTypes,
    catalogRetention: {
      components: Number(catalogCoverage.CatalogComponents),
      versions: Number(catalogCoverage.CatalogVersions),
      selections: Number(catalogCoverage.KubaraSelections),
      policy: catalogCoverage.Retention,
    },
  };
  check(result.spaces.size === plan.spec.counts.spaces, "audit Space inventory differs from reconciler count");
  check(result.units.size === plan.spec.counts.managedUnits + plan.spec.counts.preservedFaithfulControlUnits + plan.spec.counts.deliveryApplicationUnits + clusters.length + 1, "audit Unit inventory differs from the plan-derived total");
  check(result.links.size === plan.spec.links.length + plan.spec.units.filter((item) => item.upstream).length + clusters.length, "audit Link inventory differs from the plan-derived total");
  check(result.triggers.size === EXPECTED_TRIGGERS.length, "audit Trigger inventory differs from the centralized allowlist");
  check(result.filters.size === EXPECTED_FILTERS.length, "audit Filter inventory differs from the centralized allowlist");
  check(result.releaseStreams.size === plan.spec.deployments.length + (clusters.length * 2), "audit release streams differ from the plan-derived total");
  return result;
}

function publicAuditPlan(plan) {
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPOrphanAuditPlan",
    metadata: { name: "kubara-v0-13-0-mini-idp-orphan-audit" },
    spec: {
      organization: {
        name: ORGANIZATION,
        externalID: ORGANIZATION_EXTERNAL_ID,
        entityID: ORGANIZATION_ENTITY_ID,
        serverURL: CONFIGHUB_SERVER_URL,
      },
      source: {
        auditor: relativeRepo(AUDITOR_PATH),
        auditorSha256: `sha256:${sha256File(AUDITOR_PATH)}`,
        reconciler: relativeRepo(RECONCILER_PATH),
        reconcilerSha256: plan.reconcilerSha256,
        reconcilePlanSha256: plan.planSha256,
      },
      policies: {
        liveMutation: "none",
        unexpectedConfigHubSpacesUnitsLinksTargetsTriggersFiltersReleaseTags: "fail",
        configHubReadShape: "opening-and-closing-organization-wide-eight-resource-snapshots-with-one-list-per-resource-per-bracket",
        unitDataIngress: "canonical-base64-valid-UTF-8-and-exact-DataHash-required-before-cache-use",
        argoApplicationInventory: "cluster-wide-exact-plan-derived-allowlist; every Application must be in argocd",
        argoRequiresPruning: "zero",
        durableWorkloadInventory: "every-Deployment-StatefulSet-DaemonSet-CronJob-Job-must-be-Argo-desired-bootstrap-or-directly-owned-by-an-Argo-desired-root",
        danglingArgoTrackedDurableWorkloads: "zero",
        unclassifiedDurableWorkloads: "zero",
        protectedNamespaceOwnershipMetadata: "zero",
        currentRelease: "latest-published-manifest-must-equal-observed-argo-revision",
        historicalRelease: "retain contiguous release-N Tag identity history through each current Release; current deployment authority remains Release.ManifestDigest",
        catalogHistory: "retain-additively-never-classify-unselected-version-as-orphan",
      },
      counts: {
        spaces: plan.spaces.size,
        units: plan.units.size,
        links: plan.links.size,
        targets: plan.targets.size,
        triggers: plan.triggers.size,
        filters: plan.filters.size,
        currentReleaseStreams: plan.releaseStreams.size,
        expectedArgoApplications: plan.reconcilePlan.spec.counts.deliveryApplicationUnits,
        bootstrapDurableWorkloadsPerCluster: BOOTSTRAP_DURABLE_WORKLOADS.length,
      },
      catalogRetention: plan.catalogRetention,
      spaces: [...plan.spaces.keys()].sort(),
      units: [...plan.units.keys()].sort(),
      links: [...plan.links.keys()].sort(),
      targets: [...plan.targets.keys()].sort(),
      triggers: [...plan.triggers.keys()].sort(),
      filters: [...plan.filters.keys()].sort(),
      currentReleaseStreams: [...plan.releaseStreams.values()].sort((a, b) => a.space.localeCompare(b.space)),
      bootstrapDurableWorkloads: BOOTSTRAP_DURABLE_WORKLOADS,
      protectedNamespaces: PROTECTED_NAMESPACES,
    },
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function assertQuiescentJournal() {
  if (!existsSync(OPERATION_JOURNAL_PATH)) return;
  let journal;
  try {
    journal = JSON.parse(readFileSync(OPERATION_JOURNAL_PATH, "utf8"));
  } catch (error) {
    throw new Error(`operation journal is unreadable: ${error.message}`);
  }
  assertQuiescentJournalDocument(journal);
}

function assertQuiescentJournalDocument(journal) {
  check(Object.keys(journal.convergence ?? {}).length === 0, "orphan audit refuses an in-flight Argo convergence journal");
  const terminalStates = new Set(["completed", "observed-gone", "observed-detached", "already-detached"]);
  for (const [key, value] of Object.entries(journal)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("state" in value)) continue;
    if (!["namespaceMove", "scenario", "fleetBootstrap"].includes(key) && !/namespace.*detach/i.test(key)) continue;
    check(terminalStates.has(value.state), `orphan audit refuses in-flight journal ${key} state ${value.state}`);
  }
  for (const [migrationID, value] of Object.entries(journal.protectedNamespaceDetachments ?? {})) {
    check(
      value && typeof value === "object" && !Array.isArray(value) && terminalStates.has(value.state),
      `orphan audit refuses in-flight protected Namespace detachment ${migrationID} state ${value?.state ?? "missing"}`,
    );
  }
  for (const [migrationID, value] of Object.entries(journal.immutableSelectorReplacements ?? {})) {
    check(
      value && typeof value === "object" && !Array.isArray(value) && value.state === "replacement-healthy",
      `orphan audit refuses in-flight immutable selector replacement ${migrationID} state ${value?.state ?? "missing"}`,
    );
  }
}

function acquireAuditLock(lockPath = LIVE_LOCK_PATH, isProcessAlive = processAlive) {
  while (true) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: "audit-kubara-mini-idp-orphans --audit (read-only live access)",
      }, null, 2)}\n`, { mode: 0o600 });
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = {};
      try {
        owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
      } catch {
        // Never remove a lock whose exact owner cannot be established.
      }
      const hasExactOwner = Number.isInteger(owner.pid) && owner.pid > 0;
      if (hasExactOwner && !isProcessAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      check(false, `live parity lane is locked at ${lockPath}${hasExactOwner ? ` by pid ${owner.pid}` : " (owner is missing or malformed)"}`);
    }
  }
}

function releaseAuditLock(path) {
  if (!path || !existsSync(path)) return;
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  } catch {
    return;
  }
  if (owner.pid === process.pid) rmSync(path, { recursive: true, force: true });
}

function expectFailure(operation, pattern, label) {
  let failure = null;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  check(failure, `${label}: operation unexpectedly succeeded`);
  check(pattern.test(failure.message), `${label}: unexpected error: ${failure.message}`);
}

function testAuditLockSemantics() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "kubara-orphan-lock-test-"));
  const owner = (pid) => `${JSON.stringify({ pid, startedAt: "2026-01-01T00:00:00.000Z", command: "fixture" }, null, 2)}\n`;
  try {
    const deadLock = join(fixtureRoot, "dead.lock");
    mkdirSync(deadLock);
    writeFileSync(join(deadLock, "owner.json"), owner(4242));
    const acquired = acquireAuditLock(deadLock, (pid) => {
      check(pid === 4242, `dead-lock test inspected unexpected pid ${pid}`);
      return false;
    });
    check(JSON.parse(readFileSync(join(acquired, "owner.json"), "utf8")).pid === process.pid, "proven-dead lock was not replaced by the audit owner");
    releaseAuditLock(acquired);
    check(!existsSync(deadLock), "audit-owned replacement for dead lock was not released");

    const liveLock = join(fixtureRoot, "live.lock");
    mkdirSync(liveLock);
    writeFileSync(join(liveLock, "owner.json"), owner(4343));
    expectFailure(
      () => acquireAuditLock(liveLock, (pid) => {
        check(pid === 4343, `live-lock test inspected unexpected pid ${pid}`);
        return true;
      }),
      /locked.*pid 4343/,
      "live owner",
    );
    check(JSON.parse(readFileSync(join(liveLock, "owner.json"), "utf8")).pid === 4343, "live owner's lock was changed");

    const malformedLock = join(fixtureRoot, "malformed.lock");
    mkdirSync(malformedLock);
    writeFileSync(join(malformedLock, "owner.json"), "not-json\n");
    expectFailure(
      () => acquireAuditLock(malformedLock, () => false),
      /owner is missing or malformed/,
      "malformed owner",
    );
    check(readFileSync(join(malformedLock, "owner.json"), "utf8") === "not-json\n", "malformed-owner lock was changed");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function parseContext(text) {
  return {
    name: text.match(/^Context Name\s+(\S+)\s*$/mi)?.[1] ?? "",
    organizationExternalID: text.match(/^Organization ID\s+([0-9a-f-]+)\s*$/mi)?.[1] ?? "",
    organizationName: text.match(/^Organization Name\s+(.+?)\s*$/mi)?.[1] ?? "",
    serverURL: text.match(/^Server URL\s+(\S+)\s*$/mi)?.[1]?.replace(/\/$/, "") ?? "",
  };
}

function pinnedCubClient() {
  const initialArgs = contextOption ? ["--context", contextOption] : [];
  const coordinate = parseContext(command("cub", [...initialArgs, "context", "get"]));
  check(coordinate.name, "cub context name is unavailable");
  check(coordinate.organizationName === ORGANIZATION, `refusing ConfigHub Organization ${coordinate.organizationName || "unknown"}`);
  check(coordinate.organizationExternalID === ORGANIZATION_EXTERNAL_ID, "ConfigHub external Organization ID drifted");
  check(coordinate.serverURL === CONFIGHUB_SERVER_URL, "ConfigHub server URL drifted");
  const contextArgs = ["--context", coordinate.name];
  const organizations = JSON.parse(command("cub", [
    ...contextArgs,
    "organization", "list",
    "--where", `ExternalID = '${ORGANIZATION_EXTERNAL_ID}'`,
    "--select", "DisplayName,ExternalID,OrganizationID",
    "-o", "json",
  ]));
  check(Array.isArray(organizations) && organizations.length === 1, "expected exactly one pinned Kubara Organization entity");
  const organization = organizations[0]?.Organization ?? organizations[0];
  check(organization.OrganizationID === ORGANIZATION_ENTITY_ID, "ConfigHub Organization entity ID drifted");
  return {
    coordinate,
    json(args) { return JSON.parse(command("cub", [...contextArgs, ...args, "-o", "json"])); },
    // The bytes go to a file rather than stdout: stdout normalizes the trailing
    // newline and DataHash covers the stored bytes exactly.
    data(space, slug) {
      const directory = mkdtempSync(join(tmpdir(), "kubara-unit-data-"));
      const path = join(directory, "data");
      try {
        command("cub", [...contextArgs, "unit", "data", slug, "--space", space, "--output-file", path, "--quiet"]);
        return readFileSync(path);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function unwrapRows(value, key) {
  const plural = value?.[`${key}s`] ?? value?.[`${key.toLowerCase()}s`] ?? value;
  check(Array.isArray(plural), `${key} list returned an unexpected shape`);
  return plural.map((row) => row?.[key] ?? row);
}

function splitRef(ref) {
  const index = ref.indexOf("/");
  check(index > 0 && index < ref.length - 1, `invalid ref ${ref}`);
  return [ref.slice(0, index), ref.slice(index + 1)];
}

function apiGroup(apiVersion) {
  const value = String(apiVersion ?? "");
  return value.includes("/") ? value.slice(0, value.indexOf("/")) : "";
}

function resourceKey(resource) {
  return `${resource.group || "core"}/${resource.kind}/${resource.namespace || "_cluster"}/${resource.name}`;
}

function workloadKey(workload) {
  return resourceKey({
    group: apiGroup(workload.apiVersion),
    kind: workload.kind,
    namespace: workload.metadata?.namespace,
    name: workload.metadata?.name,
  });
}

function ownerReferenceKey(workload, owner) {
  return resourceKey({
    group: apiGroup(owner.apiVersion),
    kind: owner.kind,
    namespace: workload.metadata?.namespace,
    name: owner.name,
  });
}

function argoTrackingIdentity(value) {
  const match = /^([^:]+):([^/]*)\/([^:]+):([^/]+)\/(.+)$/.exec(String(value ?? ""));
  if (!match) return null;
  const [, application, group, kind, namespace, name] = match;
  if (!application || !kind || !namespace || !name) return null;
  return {
    application,
    key: resourceKey({ group, kind, namespace, name }),
  };
}

function addFinding(findings, category, ref, detail) {
  findings.push({ category, ref, detail });
}

function setDifference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

// The configuration is not a Unit field any more, so an organization-wide row carries
// metadata only. `client.data` reads the body from the Unit's own data endpoint and it
// is attached as ConfigData; these are the ingress checks that body still has to pass.
function decodeUnitConfigBytes(bytes, dataHash, ref) {
  check(/^[a-f0-9]{64}$/.test(dataHash ?? ""), `${ref}: organization-wide Unit row has an invalid DataHash`);
  check(sha256(bytes) === dataHash, `${ref}: organization-wide Unit DataHash does not match its data`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    check(false, `${ref}: organization-wide Unit data is not valid UTF-8`);
  }
}

function decodeBulkUnitData(unit, ref) {
  check(typeof unit?.ConfigData === "string", `${ref}: organization-wide Unit row omitted its configuration`);
  return decodeUnitConfigBytes(Buffer.from(unit.ConfigData, "utf8"), unit.DataHash, ref);
}

function canonicalSnapshotRows(rows, fields) {
  return rows
    .map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function configHubSnapshotFingerprint(rowsByResource, resources) {
  const selected = Object.fromEntries(resources.map((resource) => {
    check(Array.isArray(rowsByResource[resource]), `canonical ConfigHub snapshot is missing ${resource} rows`);
    return [resource, rowsByResource[resource]];
  }));
  return `sha256:${sha256(stableJson(selected))}`;
}

function assertOrganizationListCallBudget(listCalls) {
  check(
    stableJson(listCalls) === stableJson(CONFIGHUB_LIST_CALLS_PER_BRACKET),
    `ConfigHub organization-wide read budget drifted: expected ${stableJson(CONFIGHUB_LIST_CALLS_PER_BRACKET)}, observed ${stableJson(listCalls)}`,
  );
}

function scopedRowsByRef(rows, entity, spacesByID, findings) {
  const result = new Map();
  for (const row of rows) {
    const space = spacesByID.get(row.SpaceID) ?? `unknown:${row.SpaceID ?? "missing"}`;
    const ref = `${space}/${row.Slug ?? "missing"}`;
    if (result.has(ref)) {
      addFinding(findings, `duplicateConfigHub${entity}`, ref, `organization-wide ${entity} list returned a duplicate identity`);
      continue;
    }
    result.set(ref, row);
  }
  return result;
}

function classifyReleaseTags(tagRows, releases, spaceSlugByID, findings) {
  const tagsByID = new Map();
  const tagsBySpaceID = new Map();
  for (const tag of tagRows) {
    const space = spaceSlugByID.get(tag.SpaceID);
    const ref = `${space ?? `unknown:${tag.SpaceID ?? "missing"}`}/${tag.Slug ?? "missing"}`;
    if (tag.OrganizationID !== ORGANIZATION_ENTITY_ID || !space) {
      addFinding(findings, "orphanReleaseTag", ref, "release Tag belongs to an unknown Space or escaped the pinned Kubara Organization");
    }
    if (!UUID_PATTERN.test(tag.TagID ?? "")) addFinding(findings, "releaseTagContractDrift", ref, "release TagID is invalid");
    if (!RELEASE_TAG_SLUG_PATTERN.test(tag.Slug ?? "")) addFinding(findings, "releaseTagContractDrift", ref, "release Tag slug is not release-<positive integer>");
    if (tagsByID.has(tag.TagID)) addFinding(findings, "duplicateConfigHubTag", ref, "organization-wide Tag list returned a duplicate TagID");
    tagsByID.set(tag.TagID, tag);
    if (!tagsBySpaceID.has(tag.SpaceID)) tagsBySpaceID.set(tag.SpaceID, []);
    tagsBySpaceID.get(tag.SpaceID).push(tag);
  }

  const releasesBySpaceID = new Map();
  for (const release of releases) {
    if (!releasesBySpaceID.has(release.SpaceID)) releasesBySpaceID.set(release.SpaceID, []);
    releasesBySpaceID.get(release.SpaceID).push(release);
    const space = spaceSlugByID.get(release.SpaceID) ?? `unknown:${release.SpaceID ?? "missing"}`;
    const tag = tagsByID.get(release.TagID);
    if (
      !UUID_PATTERN.test(release.TagID ?? "")
      || !tag
      || tag.SpaceID !== release.SpaceID
      || tag.Slug !== `release-${release.ReleaseNum}`
    ) {
      addFinding(
        findings,
        "releaseTagContractDrift",
        `${space}/${release.ReleaseID ?? "unknown"}`,
        "Release does not reference the exact same-Space release-N Tag",
      );
    }
  }

  const allSpaceIDs = new Set([...tagsBySpaceID.keys(), ...releasesBySpaceID.keys()]);
  const streams = [];
  for (const spaceID of [...allSpaceIDs].sort((left, right) => String(spaceSlugByID.get(left) ?? left).localeCompare(String(spaceSlugByID.get(right) ?? right)))) {
    const space = spaceSlugByID.get(spaceID) ?? `unknown:${spaceID ?? "missing"}`;
    const tags = [...(tagsBySpaceID.get(spaceID) ?? [])].sort((left, right) => {
      const leftNum = Number(RELEASE_TAG_SLUG_PATTERN.exec(left.Slug ?? "")?.[1] ?? Number.MAX_SAFE_INTEGER);
      const rightNum = Number(RELEASE_TAG_SLUG_PATTERN.exec(right.Slug ?? "")?.[1] ?? Number.MAX_SAFE_INTEGER);
      return leftNum - rightNum || String(left.TagID ?? "").localeCompare(String(right.TagID ?? ""));
    });
    const releasesForSpace = [...(releasesBySpaceID.get(spaceID) ?? [])].sort(releaseSort);
    const current = releasesForSpace[0];
    if (!current) {
      addFinding(findings, "orphanReleaseTag", space, `${tags.length} retained release Tag(s) have no current Release stream`);
      continue;
    }
    const currentReleaseNum = Number(current.ReleaseNum);
    const tagNumbers = tags.map((tag) => Number(RELEASE_TAG_SLUG_PATTERN.exec(tag.Slug ?? "")?.[1] ?? NaN));
    const expectedNumbers = Number.isInteger(currentReleaseNum) && currentReleaseNum > 0
      ? Array.from({ length: currentReleaseNum }, (_unused, index) => index + 1)
      : [];
    const contiguous = stableJson(tagNumbers) === stableJson(expectedNumbers);
    if (!contiguous) {
      addFinding(
        findings,
        "releaseTagContractDrift",
        space,
        `retained release Tag sequence ${stableJson(tagNumbers)} is not the complete additive history 1..${currentReleaseNum || "invalid"}`,
      );
    }
    const currentTag = tagsByID.get(current.TagID);
    const exactCurrentTag = currentTag?.SpaceID === spaceID && currentTag?.Slug === `release-${currentReleaseNum}`;
    if (!exactCurrentTag) addFinding(findings, "missingReleaseTag", `${space}/release-${currentReleaseNum}`, "current Release Tag is absent or does not match TagID");
    streams.push({
      space,
      currentReleaseID: current.ReleaseID,
      currentReleaseNum,
      currentTagID: current.TagID,
      retainedTagCount: tags.length,
      contiguousFromOne: contiguous,
      exactCurrentTag,
      tags: tags.map((tag) => ({
        slug: tag.Slug,
        tagID: tag.TagID,
        createdAt: tag.CreatedAt,
      })),
    });
  }
  return {
    policy: "additive-release-N-tags-contiguous-from-one-through-current-release",
    streams,
    retainedTagCount: tagRows.length,
  };
}

function readConfigHubInventory(client, plan, findings) {
  const listCalls = Object.fromEntries(Object.keys(CONFIGHUB_LIST_CALLS_PER_BRACKET).map((resource) => [resource, 0]));
  const listRows = (resource, args, entity = `${resource[0].toUpperCase()}${resource.slice(1)}`) => {
    listCalls[resource] += 1;
    return unwrapRows(client.json([resource, "list", ...args]), entity);
  };
  const spaces = listRows("space", [
    "--select", SPACE_READ_SELECT,
  ]);
  for (const space of spaces) {
    check(
      space.OrganizationID === ORGANIZATION_ENTITY_ID,
      `${space.Slug ?? "unknown"}: Space escaped the pinned Kubara Organization`,
    );
  }
  const spacesBySlug = new Map(spaces.map((space) => [space.Slug, space]));
  if (spacesBySlug.size !== spaces.length) addFinding(findings, "duplicateConfigHubSpace", "organization", "Space list returned duplicate slugs");
  const spaceSlugByID = new Map(spaces.map((space) => [space.SpaceID, space.Slug]));
  const expectedSpaceSlugs = new Set(plan.spaces.keys());
  const actualSpaceSlugs = new Set(spacesBySlug.keys());
  for (const slug of setDifference(actualSpaceSlugs, expectedSpaceSlugs)) addFinding(findings, "unexpectedConfigHubSpace", slug, "Space is outside the exact reconciler plan");
  for (const slug of setDifference(expectedSpaceSlugs, actualSpaceSlugs)) addFinding(findings, "missingConfigHubSpace", slug, "planned Space is missing");
  const control = spacesBySlug.get("hx-platform");
  if (control && control.OrganizationID !== ORGANIZATION_ENTITY_ID) addFinding(findings, "organizationDrift", "hx-platform", "Space belongs to another Organization entity");

  const unitRows = listRows("unit", [
    "--space", "*",
    "--select", UNIT_READ_SELECT,
  ]);
  const units = scopedRowsByRef(unitRows, "Unit", spaceSlugByID, findings);
  const unitDataByRef = new Map();
  for (const [ref, unit] of units) {
    // The row carries no body, so it is read from the Unit's data endpoint and
    // validated at ingress before any caller can consume or cache it.
    const [unitSpace, unitSlug] = splitRef(ref);
    unit.ConfigData = decodeUnitConfigBytes(client.data(unitSpace, unitSlug), unit.DataHash, ref);
    unitDataByRef.set(ref, decodeBulkUnitData(unit, ref));
  }
  const linkRows = listRows("link", [
    "--space", "*",
    "--select", LINK_READ_SELECT,
  ]);
  const links = scopedRowsByRef(linkRows, "Link", spaceSlugByID, findings);
  const triggerRows = listRows("trigger", ["--space", "*", "--select", TRIGGER_READ_SELECT]);
  const triggersByRef = scopedRowsByRef(triggerRows, "Trigger", spaceSlugByID, findings);
  const filterRows = listRows("filter", ["--space", "*", "--select", FILTER_READ_SELECT]);
  const filtersByRef = scopedRowsByRef(filterRows, "Filter", spaceSlugByID, findings);
  const tagRows = listRows("tag", ["--space", "*", "--select", TAG_READ_SELECT]);
  const tagsByRef = scopedRowsByRef(tagRows, "Tag", spaceSlugByID, findings);

  const expectedUnits = new Set(plan.units.keys());
  const actualUnits = new Set(units.keys());
  for (const ref of setDifference(actualUnits, expectedUnits)) addFinding(findings, "unexpectedConfigHubUnit", ref, "Unit is outside the plan-derived allowlist");
  for (const ref of setDifference(expectedUnits, actualUnits)) addFinding(findings, "missingConfigHubUnit", ref, "planned Unit is missing");
  const expectedLinks = new Set(plan.links.keys());
  const actualLinks = new Set(links.keys());
  for (const ref of setDifference(actualLinks, expectedLinks)) addFinding(findings, "unexpectedConfigHubLink", ref, "Link is outside the plan-derived allowlist");
  for (const ref of setDifference(expectedLinks, actualLinks)) addFinding(findings, "missingConfigHubLink", ref, "planned Link is missing");
  const expectedTriggers = new Set(plan.triggers.keys());
  const actualTriggers = new Set(triggersByRef.keys());
  for (const ref of setDifference(actualTriggers, expectedTriggers)) addFinding(findings, "unexpectedConfigHubTrigger", ref, "Trigger is outside the exact mini-IDP allowlist");
  for (const ref of setDifference(expectedTriggers, actualTriggers)) addFinding(findings, "missingConfigHubTrigger", ref, "owned approval Trigger is missing");
  for (const [ref, expected] of plan.triggers) {
    const trigger = triggersByRef.get(ref);
    if (!trigger) continue;
    const behaviorExact = typeof trigger.TriggerID === "string"
      && trigger.TriggerID.length > 0
      && trigger.Event === expected.event
      && trigger.ToolchainType === expected.toolchainType
      && trigger.FunctionName === expected.functionName
      && stableJson(trigger.Arguments ?? []) === stableJson(expected.arguments)
      && trigger.Disabled !== true
      && trigger.Validating === expected.validating
      && Number(trigger.FailOpenAfter ?? 0) === expected.failOpenAfter;
    if (!behaviorExact) addFinding(findings, "triggerContractDrift", ref, "Trigger identity or full validation behavior drifted");
  }
  const expectedFilters = new Set(plan.filters.keys());
  const actualFilters = new Set(filtersByRef.keys());
  for (const ref of setDifference(actualFilters, expectedFilters)) addFinding(findings, "unexpectedConfigHubFilter", ref, "Filter is outside the exact mini-IDP allowlist");
  for (const ref of setDifference(expectedFilters, actualFilters)) addFinding(findings, "missingConfigHubFilter", ref, "owned production-space Filter is missing");
  for (const [ref, expected] of plan.filters) {
    const filter = filtersByRef.get(ref);
    if (!filter) continue;
    if (
      !(typeof filter.FilterID === "string" && filter.FilterID.length > 0)
      || filter.From !== expected.from
      || filter.Where !== expected.where
    ) addFinding(findings, "filterContractDrift", ref, "Filter identity or selector behavior drifted");
  }
  const approvalTriggerExpected = [...plan.triggers.values()].find((item) => item.purpose === "production-approval");
  const productionFilterExpected = [...plan.filters.values()].find((item) => item.attachment === "production-spaces");
  const approvalTrigger = triggersByRef.get(approvalTriggerExpected?.ref);
  const productionFilter = filtersByRef.get(productionFilterExpected?.ref);
  if (approvalTrigger && productionFilter) {
    for (const expected of plan.reconcilePlan.spec.spaces.filter((space) => space.prodProtected)) {
      const live = spacesBySlug.get(expected.slug);
      if (!live) continue;
      if (
        live.TriggerFilterID !== productionFilter.FilterID
        || stableJson([...(live.TriggerIDs ?? [])].sort()) !== stableJson([approvalTrigger.TriggerID])
      ) addFinding(findings, "triggerFilterAttachmentDrift", expected.slug, "production Space does not select the exact owned approval Filter and Trigger");
    }
  }

  const targets = listRows("target", [
    "--space", "*",
    "--select", "SpaceID,ProviderType,ToolchainType,Annotations",
  ]);
  const targetsByRef = scopedRowsByRef(targets, "Target", spaceSlugByID, findings);
  const expectedTargets = new Set(plan.targets.keys());
  const actualTargets = new Set(targetsByRef.keys());
  for (const ref of setDifference(actualTargets, expectedTargets)) addFinding(findings, "unexpectedConfigHubTarget", ref, "Target is outside the exact four-target allowlist");
  for (const ref of setDifference(expectedTargets, actualTargets)) addFinding(findings, "missingConfigHubTarget", ref, "planned Target is missing");
  for (const [ref, expected] of plan.targets) {
    const target = targetsByRef.get(ref);
    if (!target) continue;
    if (target.ProviderType !== "OCI" || target.ToolchainType !== "Any") addFinding(findings, "targetContractDrift", ref, `provider/toolchain is ${target.ProviderType ?? "missing"}/${target.ToolchainType ?? "missing"}`);
    if (target.Annotations?.["confighub.com/argo-apps-space"] !== expected.appsSpace) addFinding(findings, "targetContractDrift", ref, `argo-apps-space does not name ${expected.appsSpace}`);
  }

  const targetIDByRef = new Map([...targetsByRef].map(([ref, target]) => [ref, target.TargetID]));
  const unitIDByRef = new Map([...units].map(([ref, unit]) => [ref, unit.UnitID]));
  for (const [ref, expected] of plan.units) {
    const live = units.get(ref);
    if (!live) continue;
    const expectedTargetID = expected.expectedTarget ? targetIDByRef.get(expected.expectedTarget) : null;
    if ((live.TargetID ?? null) !== (expectedTargetID ?? null)) addFinding(findings, "unitTargetDrift", ref, `TargetID differs from ${expected.expectedTarget ?? "untargeted"}`);
  }
  for (const [ref, expected] of plan.links) {
    const live = links.get(ref);
    if (!live) continue;
    const [toSpace] = splitRef(expected.to);
    const toSpaceID = spacesBySlug.get(toSpace)?.SpaceID;
    if (
      live.UpdateType !== expected.updateType
      || live.AutoUpdate === true
      || live.FromUnitID !== unitIDByRef.get(expected.from)
      || live.ToUnitID !== unitIDByRef.get(expected.to)
      || live.ToSpaceID !== toSpaceID
    ) addFinding(findings, "linkContractDrift", ref, "Link type, auto-update, or endpoint identity drifted");
  }
  for (const [cluster, appsSpace] of plan.appsSpaces) {
    const targetID = targetIDByRef.get(`${cluster}/target`);
    if (spacesBySlug.get(appsSpace)?.ReleaseTargetID !== targetID) addFinding(findings, "spaceTargetDrift", appsSpace, `release target is not ${cluster}/target`);
    if (spacesBySlug.get(`argobot-${cluster}`)?.ReleaseTargetID !== targetID) addFinding(findings, "spaceTargetDrift", `argobot-${cluster}`, `release target is not ${cluster}/target`);
  }
  for (const item of plan.reconcilePlan.spec.spaces.filter((space) => space.target)) {
    const [cluster] = splitRef(item.target);
    if (spacesBySlug.get(item.slug)?.ReleaseTargetID !== targetIDByRef.get(`${cluster}/target`)) addFinding(findings, "spaceTargetDrift", item.slug, `release target is not ${item.target}`);
  }

  const publishedReleases = listRows("release", [
    "--space", "*", "--where", "Published = true",
    "--select", "SpaceID,TagID,Digest,ManifestDigest,ReleaseNum,UnitCount,CreatedAt,Published",
  ]);
  const normalizedReleases = publishedReleases.map((release) => ({
    ...release,
    space: spaceSlugByID.get(release.SpaceID) ?? "",
    published: true,
  }));
  for (const release of normalizedReleases) {
    if (!release.space) addFinding(findings, "orphanRelease", release.ReleaseID ?? "unknown", `release belongs to unknown SpaceID ${release.SpaceID ?? "missing"}`);
    if (!SHA256_PATTERN.test(release.Digest ?? "") || !SHA256_PATTERN.test(release.ManifestDigest ?? "")) addFinding(findings, "releaseDigestDrift", `${release.space}/${release.ReleaseID ?? "unknown"}`, "bundle or OCI manifest digest is invalid");
    if (!Number.isInteger(Number(release.UnitCount)) || Number(release.UnitCount) < 0) addFinding(findings, "releaseUnitCountDrift", `${release.space}/${release.ReleaseID ?? "unknown"}`, "release UnitCount is missing or invalid");
  }
  const releaseTagHistory = classifyReleaseTags(tagRows, publishedReleases, spaceSlugByID, findings);
  const releaseClassification = classifyReleases(normalizedReleases, plan, findings);
  assertOrganizationListCallBudget(listCalls);
  const snapshotRows = {
    space: canonicalSnapshotRows(spaces, CONFIGHUB_FINGERPRINT_FIELD_SETS.space),
    unit: canonicalSnapshotRows(unitRows, CONFIGHUB_FINGERPRINT_FIELD_SETS.unit),
    release: canonicalSnapshotRows(publishedReleases, CONFIGHUB_FINGERPRINT_FIELD_SETS.release),
    link: canonicalSnapshotRows(linkRows, CONFIGHUB_FINGERPRINT_FIELD_SETS.link),
    target: canonicalSnapshotRows(targets, CONFIGHUB_FINGERPRINT_FIELD_SETS.target),
    trigger: canonicalSnapshotRows(triggerRows, CONFIGHUB_FINGERPRINT_FIELD_SETS.trigger),
    filter: canonicalSnapshotRows(filterRows, CONFIGHUB_FINGERPRINT_FIELD_SETS.filter),
    tag: canonicalSnapshotRows(tagRows, CONFIGHUB_FINGERPRINT_FIELD_SETS.tag),
  };
  const coreFiveResourceFingerprint = configHubSnapshotFingerprint(snapshotRows, CORE_CONFIGHUB_FINGERPRINT_RESOURCES);
  const fullEightResourceFingerprint = configHubSnapshotFingerprint(snapshotRows, FULL_CONFIGHUB_FINGERPRINT_RESOURCES);
  const snapshot = {
    schemaVersion: 1,
    mode: "organization-wide-single-list-per-resource",
    canonicalization: "stable-recursive-key-order-and-entity-row-order",
    fingerprintAlgorithm: "sha256",
    coreResources: [...CORE_CONFIGHUB_FINGERPRINT_RESOURCES],
    fullResources: [...FULL_CONFIGHUB_FINGERPRINT_RESOURCES],
    coreFiveResourceFingerprintScope: "reconciler-final-selected-Space-Unit-published-Release-Link-Target-snapshot",
    coreFiveResourceFingerprint,
    fullEightResourceFingerprintScope: "core-five-plus-selected-Trigger-Filter-release-Tag-snapshot",
    fullEightResourceFingerprint,
    fieldSets: Object.fromEntries(FULL_CONFIGHUB_FINGERPRINT_RESOURCES.map((resource) => [resource, [...CONFIGHUB_FINGERPRINT_FIELD_SETS[resource]]])),
    listCalls,
    counts: {
      spaces: spaces.length,
      units: units.size,
      links: links.size,
      targets: targetsByRef.size,
      releases: normalizedReleases.length,
      publishedReleases: publishedReleases.length,
      triggers: triggersByRef.size,
      filters: filtersByRef.size,
      tags: tagsByRef.size,
    },
  };
  return {
    spaces,
    spacesBySlug,
    units,
    links,
    triggersByRef,
    filtersByRef,
    tagsByRef,
    targetsByRef,
    targetIDByRef,
    snapshot,
    releaseClassification,
    releaseTagHistory,
    latestPublishedBySpace: new Map(releaseClassification.activeCurrent.map((item) => [item.space, item])),
    unitData(ref) {
      check(unitDataByRef.has(ref), `${ref}: Unit body is absent from the validated organization-wide snapshot`);
      return unitDataByRef.get(ref);
    },
  };
}

function releaseSort(left, right) {
  return Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0)
    || String(right.CreatedAt ?? "").localeCompare(String(left.CreatedAt ?? ""));
}

function releaseEvidence(release, classification) {
  return {
    space: release.space,
    releaseID: release.ReleaseID,
    tagID: release.TagID,
    releaseNum: release.ReleaseNum,
    unitCount: release.UnitCount,
    bundleDigest: release.Digest,
    manifestDigest: release.ManifestDigest,
    createdAt: release.CreatedAt,
    published: release.published,
    classification,
  };
}

function classifyReleases(releases, plan, findings) {
  const bySpace = new Map();
  for (const release of releases) {
    if (!bySpace.has(release.space)) bySpace.set(release.space, []);
    bySpace.get(release.space).push(release);
  }
  const activeCurrent = [];
  const historical = [];
  const retainedCatalogOrProof = [];
  const orphaned = [];
  for (const [space, stream] of plan.releaseStreams) {
    const rows = (bySpace.get(space) ?? []).sort(releaseSort);
    const published = rows.filter((row) => row.published).sort(releaseSort);
    if (!published.length) {
      addFinding(findings, "missingCurrentRelease", space, "current delivery stream has no Published release");
      continue;
    }
    const expectedUnitCount = [...plan.units.keys()]
      .filter((ref) => ref.startsWith(`${space}/`)).length;
    check(expectedUnitCount > 0, `${space}: current release stream has no allowlisted Units`);
    if (Number(published[0].UnitCount) !== expectedUnitCount) {
      addFinding(
        findings,
        "releaseUnitCountDrift",
        `${space}/${published[0].ReleaseID ?? "unknown"}`,
        `current Published release contains ${published[0].UnitCount ?? "missing"} Units; expected exactly ${expectedUnitCount}`,
      );
    }
    activeCurrent.push({ ...releaseEvidence(published[0], "active-current"), role: stream.role, cluster: stream.cluster });
    for (const row of rows.filter((item) => item.ReleaseID !== published[0].ReleaseID)) historical.push(releaseEvidence(row, "historical-retained"));
  }
  for (const [space, rows] of bySpace) {
    if (plan.releaseStreams.has(space)) continue;
    const spaceType = plan.spaces.get(space)?.type;
    for (const row of rows) {
      if (!plan.spaces.has(space) || (row.published && !plan.allowedRetainedReleaseTypes.has(spaceType))) {
        const evidence = releaseEvidence(row, "orphan-active-nondelivery");
        orphaned.push(evidence);
        addFinding(findings, "orphanRelease", `${space}/${row.ReleaseID ?? "unknown"}`, `Published release is not a delivery stream or an allowed retained definition/proof package (${spaceType ?? "unknown Space"})`);
      } else {
        retainedCatalogOrProof.push(releaseEvidence(row, row.published ? "catalog-or-proof-retained" : "historical-retained"));
      }
    }
  }
  return {
    activeCurrent: activeCurrent.sort((a, b) => a.space.localeCompare(b.space)),
    historical: historical.sort((a, b) => `${a.space}/${a.releaseNum}`.localeCompare(`${b.space}/${b.releaseNum}`)),
    retainedCatalogOrProof: retainedCatalogOrProof.sort((a, b) => `${a.space}/${a.releaseNum}`.localeCompare(`${b.space}/${b.releaseNum}`)),
    orphaned,
  };
}

function kubectl(cluster, args) {
  return command("kubectl", [
    "--kubeconfig", join(homedir(), ".confighub", "clusters", `${cluster}.kubeconfig`),
    "--context", `kind-${cluster}`,
    ...args,
  ]);
}

function sourceSpaceFromApplication(app, ref) {
  const repoURL = app.spec?.source?.repoURL ?? "";
  check(repoURL.startsWith(OCI_SPACE_PREFIX), `${ref}: Application source is not a ConfigHub Space OCI reference`);
  const sourceSpace = repoURL.slice(OCI_SPACE_PREFIX.length);
  check(sourceSpace && !sourceSpace.includes("/"), `${ref}: Application source Space is invalid`);
  return sourceSpace;
}

function expectedApplications(plan, confighub, findings) {
  const result = new Map(plan.clusters.map((cluster) => [cluster, new Map()]));
  for (const item of plan.reconcilePlan.spec.deliveryApplicationUnits) {
    const cluster = item.labels?.Cluster;
    let docs;
    try {
      docs = parseDocs(confighub.unitData(item.ref));
    } catch (error) {
      addFinding(findings, "applicationUnitData", item.ref, error.message);
      continue;
    }
    if (docs.length !== 1 || docs[0]?.kind !== "Application") {
      addFinding(findings, "applicationUnitData", item.ref, "delivery Unit must contain exactly one Argo Application");
      continue;
    }
    const app = docs[0];
    const name = app.metadata?.name;
    if (!name || app.metadata?.namespace !== "argocd") {
      addFinding(findings, "applicationUnitData", item.ref, "Application identity must be argocd/<name>");
      continue;
    }
    let sourceSpace = "";
    try {
      sourceSpace = sourceSpaceFromApplication(app, item.ref);
    } catch (error) {
      addFinding(findings, "applicationUnitData", item.ref, error.message);
      continue;
    }
    const sourceKeys = Object.keys(app.spec?.source ?? {}).sort();
    const destinationKeys = Object.keys(app.spec?.destination ?? {}).sort();
    const sourcesAbsent = app.spec?.sources === undefined
      || (Array.isArray(app.spec.sources) && app.spec.sources.length === 0);
    if (app.operation) addFinding(findings, "applicationUnitAuthority", item.ref, "stored Application contains an executable operation");
    if (!sourcesAbsent) addFinding(findings, "applicationUnitAuthority", item.ref, "stored Application defines spec.sources");
    if (stableJson(sourceKeys) !== stableJson(["path", "repoURL", "targetRevision"])) addFinding(findings, "applicationUnitAuthority", item.ref, "stored Application source keyset is not exact");
    if (![stableJson(["namespace", "server"]), stableJson(["server"])].includes(stableJson(destinationKeys))) addFinding(findings, "applicationUnitAuthority", item.ref, "stored Application destination keyset is not exact");
    if (app.spec?.source?.targetRevision !== "latest" || app.spec?.syncPolicy?.automated) addFinding(findings, "applicationUnitAuthority", item.ref, "stored Application must keep latest discovery-only with automated sync absent");
    if (result.get(cluster).has(name)) addFinding(findings, "duplicateApplicationOwner", `${cluster}/${name}`, `multiple ConfigHub delivery Units declare the same Application (${item.ref})`);
    result.get(cluster).set(name, { name, cluster, sourceSpace, unitRef: item.ref, desiredSpec: app.spec, kind: "configHub-delivery-unit" });
  }
  return result;
}

function inspectArgobotPodSpec(podSpec, ref, findings) {
  const containers = podSpec?.containers ?? [];
  const initContainers = podSpec?.initContainers ?? [];
  const argobotContainers = containers.filter((container) => container?.name === "argobot");
  const container = argobotContainers[0] ?? {};
  const env = container.env ?? [];
  const envNames = env.map((item) => item?.name).filter(Boolean);
  const values = new Map(env.map((item) => [item?.name, item]));
  const restEnvironment = envNames.filter((name) => [
    "ARGOCD_SERVER",
    "ARGOCD_AUTH_TOKEN",
    "ARGO_APP_NAMESPACE",
    "ARGO_PRUNE",
    "ARGO_FORCE",
  ].includes(name));
  const evidence = {
    image: container.image ?? null,
    syncMode: values.get("ARGO_SYNC_MODE")?.value ?? null,
    applicationNamespace: values.get("ARGO_NAMESPACE")?.value ?? null,
    refreshType: values.get("ARGO_REFRESH_TYPE")?.value ?? null,
    restSyncEnvironmentAbsent: restEnvironment.length === 0,
    commandOverrideAbsent: !(container.command?.length || container.args?.length),
    oneContainerNoInit: containers.length === 1 && initContainers.length === 0,
    duplicateEnvironmentAbsent: new Set(envNames).size === envNames.length,
  };
  if (argobotContainers.length !== 1) addFinding(findings, "argobotAuthorityDrift", ref, "expected exactly one named argobot container");
  if (!evidence.oneContainerNoInit) addFinding(findings, "argobotAuthorityDrift", ref, "reviewed runtime permits one argobot container and no init containers");
  if (evidence.image !== ARGOBOT_IMAGE) addFinding(findings, "argobotAuthorityDrift", ref, `image is not ${ARGOBOT_IMAGE}`);
  if (evidence.syncMode !== "kubernetes") addFinding(findings, "argobotAuthorityDrift", ref, "ARGO_SYNC_MODE is not kubernetes refresh-only mode");
  if (evidence.applicationNamespace !== "argocd") addFinding(findings, "argobotAuthorityDrift", ref, "ARGO_NAMESPACE is not argocd");
  if (evidence.refreshType !== "hard") addFinding(findings, "argobotAuthorityDrift", ref, "ARGO_REFRESH_TYPE is not hard");
  if (!evidence.restSyncEnvironmentAbsent) addFinding(findings, "argobotAuthorityDrift", ref, `REST-sync environment is present: ${restEnvironment.join(", ")}`);
  if (!evidence.commandOverrideAbsent) addFinding(findings, "argobotAuthorityDrift", ref, "image entrypoint is overridden");
  if (!evidence.duplicateEnvironmentAbsent) addFinding(findings, "argobotAuthorityDrift", ref, "duplicate environment names make runtime authority ambiguous");
  return evidence;
}

function auditArgobotAuthority(cluster, findings) {
  const deployment = JSON.parse(kubectl(cluster, [
    "get", "deployment", "argobot", "-n", "argobot", "-o", "json",
  ]));
  const deploymentRef = `${cluster}/argobot/Deployment/argobot`;
  const deploymentEvidence = inspectArgobotPodSpec(
    deployment.spec?.template?.spec,
    deploymentRef,
    findings,
  );
  const selectorExact = stableJson(deployment.spec?.selector?.matchLabels ?? {}) === stableJson({ app: "argobot" });
  if (!selectorExact) addFinding(findings, "argobotAuthorityDrift", deploymentRef, "selector is not the exact reviewed app=argobot selector");
  const replicas = Number(deployment.spec?.replicas ?? 1);
  const rolloutCurrent = replicas > 0
    && Number(deployment.status?.observedGeneration ?? 0) === Number(deployment.metadata?.generation ?? -1)
    && Number(deployment.status?.updatedReplicas ?? 0) === replicas
    && Number(deployment.status?.availableReplicas ?? 0) === replicas;
  if (!rolloutCurrent) addFinding(findings, "argobotAuthorityDrift", deploymentRef, "refresh-only Deployment rollout is not fully current and available");

  const pods = JSON.parse(kubectl(cluster, [
    "get", "pods", "-n", "argobot", "-l", "app=argobot", "-o", "json",
  ])).items ?? [];
  if (pods.length !== replicas) addFinding(findings, "argobotAuthorityDrift", `${cluster}/argobot`, `expected ${replicas} active Pods, observed ${pods.length}`);
  const podRows = pods.map((pod) => {
    const ref = `${cluster}/argobot/Pod/${pod.metadata?.name ?? "unknown"}`;
    const authority = inspectArgobotPodSpec(pod.spec, ref, findings);
    const runningReady = !pod.metadata?.deletionTimestamp
      && pod.status?.phase === "Running"
      && (pod.status?.containerStatuses ?? []).find((item) => item?.name === "argobot")?.ready === true;
    if (!runningReady) addFinding(findings, "argobotAuthorityDrift", ref, "Pod is terminating or not Running and Ready");
    return {
      name: pod.metadata?.name ?? null,
      uid: pod.metadata?.uid ?? null,
      runningReady,
      ...authority,
    };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return {
    cluster,
    version: ARGOBOT_VERSION,
    deployment: {
      uid: deployment.metadata?.uid ?? null,
      generation: deployment.metadata?.generation ?? null,
      replicas,
      selectorExact,
      rolloutCurrent,
      ...deploymentEvidence,
    },
    pods: podRows,
  };
}

function auditArgo(plan, confighub, findings) {
  const expectedByCluster = expectedApplications(plan, confighub, findings);
  const desiredResourcesByCluster = new Map(plan.clusters.map((cluster) => [cluster, new Map()]));
  const rows = [];
  let resourceCount = 0;
  let requiresPruningCount = 0;
  const argobotAuthority = [];
  const applicationSets = [];
  for (const cluster of plan.clusters) {
    argobotAuthority.push(auditArgobotAuthority(cluster, findings));
    const clusterApplicationSets = JSON.parse(kubectl(cluster, [
      "get", "applicationsets.argoproj.io", "-A", "-o", "json",
    ])).items ?? [];
    applicationSets.push({
      cluster,
      count: clusterApplicationSets.length,
      refs: clusterApplicationSets.map((item) => `${item.metadata?.namespace ?? ""}/${item.metadata?.name ?? "unknown"}`).sort(),
    });
    for (const item of clusterApplicationSets) addFinding(findings, "unexpectedArgoApplicationSet", `${cluster}/${item.metadata?.namespace ?? ""}/${item.metadata?.name ?? "unknown"}`, "adapted lane forbids ApplicationSet regeneration authority");
    const payload = JSON.parse(kubectl(cluster, ["get", "applications.argoproj.io", "-A", "-o", "json"]));
    const clusterApplications = payload.items ?? [];
    for (const app of clusterApplications.filter((item) => item.metadata?.namespace !== "argocd")) {
      addFinding(
        findings,
        "unexpectedArgoApplication",
        `${cluster}/${app.metadata?.namespace ?? "missing"}/${app.metadata?.name ?? "unknown"}`,
        "managed authority forbids Application CRs outside the exact argocd namespace inventory",
      );
    }
    const actual = new Map();
    for (const app of clusterApplications.filter((item) => item.metadata?.namespace === "argocd")) {
      const name = app.metadata?.name;
      if (!name || actual.has(name)) {
        addFinding(findings, "unexpectedArgoApplication", `${cluster}/argocd/${name ?? "unknown"}`, "cluster-wide Application inventory returned a missing or duplicate identity");
        continue;
      }
      actual.set(name, app);
    }
    const expected = expectedByCluster.get(cluster);
    for (const name of setDifference(new Set(actual.keys()), new Set(expected.keys()))) addFinding(findings, "unexpectedArgoApplication", `${cluster}/${name}`, "Application is outside the plan-derived allowlist");
    for (const name of setDifference(new Set(expected.keys()), new Set(actual.keys()))) addFinding(findings, "missingArgoApplication", `${cluster}/${name}`, "planned Application is missing");
    for (const [name, contract] of expected) {
      const app = actual.get(name);
      if (!app) continue;
      if (stableJson(app.spec) !== stableJson(contract.desiredSpec)) addFinding(findings, "argoApplicationContractDrift", `${cluster}/${name}`, `live spec differs from ${contract.unitRef}`);
      const targetRevision = app.spec?.source?.targetRevision ?? null;
      const automatedSyncDisabled = !app.spec?.syncPolicy?.automated;
      if (targetRevision !== "latest" || !automatedSyncDisabled) addFinding(findings, "argoApplicationAuthorityDrift", `${cluster}/${name}`, "targetRevision must be discovery-only latest with automated sync absent");
      const applicationSetOwnerAbsent = !(app.metadata?.ownerReferences ?? []).some((owner) => owner?.kind === "ApplicationSet");
      if (!applicationSetOwnerAbsent) addFinding(findings, "argoApplicationAuthorityDrift", `${cluster}/${name}`, "ApplicationSet ownership can regenerate the managed Application");
      const release = confighub.latestPublishedBySpace.get(contract.sourceSpace);
      if (!release) addFinding(findings, "missingCurrentRelease", contract.sourceSpace, `${cluster}/${name} has no current release`);
      const observedRevision = app.status?.sync?.revision ?? "";
      const operationPhase = app.status?.operationState?.phase ?? "Unknown";
      const activeOperation = Boolean(app.operation)
        || ["Running", "Terminating"].includes(operationPhase);
      if (activeOperation) addFinding(findings, "argoActiveOperation", `${cluster}/${name}`, `active operation phase=${operationPhase}`);
      if (app.status?.sync?.status !== "Synced") addFinding(findings, "argoApplicationNotSynced", `${cluster}/${name}`, `sync=${app.status?.sync?.status ?? "Unknown"}`);
      if (release && observedRevision !== release.manifestDigest) addFinding(findings, "argoRevisionDrift", `${cluster}/${name}`, `revision=${observedRevision || "missing"}, expected ${release.manifestDigest}`);
      const statusResources = app.status?.resources ?? [];
      const prunable = statusResources.filter((resource) => resource.requiresPruning === true);
      const desiredResources = desiredResourcesByCluster.get(cluster);
      for (const resource of statusResources.filter((item) => item.requiresPruning !== true)) {
        if (!resource.kind || !resource.name) {
          addFinding(findings, "argoResourceIdentity", `${cluster}/${name}`, "Application status contains a desired resource without kind/name identity");
          continue;
        }
        const key = resourceKey(resource);
        const entry = desiredResources.get(key) ?? { key, applications: [] };
        if (!entry.applications.includes(name)) entry.applications.push(name);
        desiredResources.set(key, entry);
      }
      resourceCount += statusResources.length;
      requiresPruningCount += prunable.length;
      for (const resource of prunable) {
        const group = resource.group ? `${resource.group}/` : "";
        const ref = `${cluster}/${name}/${group}${resource.kind}/${resource.namespace ?? ""}/${resource.name}`;
        addFinding(findings, "argoRequiresPruning", ref, "accepted state requires zero stale tracked resources");
      }
      rows.push({
        cluster,
        name,
        kind: contract.kind,
        sourceSpace: contract.sourceSpace,
        sourceUnit: contract.unitRef,
        expectedRevision: release?.manifestDigest ?? null,
        observedRevision: observedRevision || null,
        targetRevision,
        automatedSyncDisabled,
        applicationSetOwnerAbsent,
        activeOperation,
        operationPhase,
        syncSubmissionAuthority: "ConfigHub-revalidated-ManifestDigest-Kubernetes-UID-resourceVersion-CAS",
        sync: app.status?.sync?.status ?? "Unknown",
        health: app.status?.health?.status ?? "Unknown",
        trackedResources: (app.status?.resources ?? []).length,
        requiresPruning: prunable.length,
      });
    }
  }
  return {
    expectedApplicationCount: [...expectedByCluster.values()].reduce((sum, items) => sum + items.size, 0),
    observedApplications: rows.sort((a, b) => `${a.cluster}/${a.name}`.localeCompare(`${b.cluster}/${b.name}`)),
    trackedResourceCount: resourceCount,
    requiresPruningCount,
    argobotAuthority: argobotAuthority.sort((left, right) => left.cluster.localeCompare(right.cluster)),
    applicationSets: applicationSets.sort((left, right) => left.cluster.localeCompare(right.cluster)),
    desiredResourcesByCluster,
  };
}

function classifyDurableWorkloads(
  cluster,
  workloads,
  desiredResources,
  findings,
  bootstrapByKey = BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY,
  liveOwnerUIDs = new Map(),
) {
  const rows = [];
  for (const workload of workloads) {
    const key = workloadKey(workload);
    const ref = `${cluster}/${key}`;
    const annotations = workload.metadata?.annotations ?? {};
    const hasTrackingAnnotation = Object.prototype.hasOwnProperty.call(annotations, ARGO_TRACKING_ANNOTATION);
    const trackingID = hasTrackingAnnotation ? annotations[ARGO_TRACKING_ANNOTATION] : null;
    const trackingIdentity = argoTrackingIdentity(trackingID);
    const desired = desiredResources.get(key);
    const bootstrap = bootstrapByKey.get(key);
    const ownerReferences = (workload.metadata?.ownerReferences ?? []).map((owner) => ({
      apiVersion: owner.apiVersion ?? null,
      kind: owner.kind ?? null,
      namespace: workload.metadata?.namespace ?? null,
      name: owner.name ?? null,
      uid: owner.uid ?? null,
      controller: owner.controller === true,
      key: owner.apiVersion && owner.kind && owner.name ? ownerReferenceKey(workload, owner) : null,
    }));
    const referencedDesiredOwnerRoots = ownerReferences
      .filter((owner) => owner.key && desiredResources.has(owner.key))
      .map((owner) => ({
        key: owner.key,
        applications: desiredResources.get(owner.key).applications,
        controller: owner.controller,
        uid: owner.uid,
        liveUID: liveOwnerUIDs.get(owner.key) ?? null,
      }));
    const desiredOwnerRoots = referencedDesiredOwnerRoots.filter((owner) => (
      owner.uid
        && owner.liveUID
        && owner.uid === owner.liveUID
    ));
    const desiredControllerOwnerRoots = desiredOwnerRoots.filter((owner) => owner.controller);
    const staleDesiredOwnerRoots = referencedDesiredOwnerRoots.filter((owner) => (
      !owner.uid
        || !owner.liveUID
        || owner.uid !== owner.liveUID
    ));
    for (const owner of staleDesiredOwnerRoots) {
      addFinding(
        findings,
        "staleControllerOwnerUID",
        `${ref} -> ${owner.key}`,
        `ownerReference uid=${owner.uid ?? "missing"}; current owner uid=${owner.liveUID ?? "missing"}`,
      );
    }
    const inheritedTrackingOwnerRoots = desiredOwnerRoots.filter((owner) => (
      owner.controller
        && trackingIdentity?.key === owner.key
        && owner.applications.includes(trackingIdentity.application)
    ));

    let classification;
    let applications = [];
    if (desired) {
      classification = "argo-status-desired";
      applications = desired.applications;
    } else if (hasTrackingAnnotation && inheritedTrackingOwnerRoots.length === 1) {
      // Operators such as Prometheus copy the desired CR's Argo tracking and
      // ConfigHub provenance annotations onto their generated StatefulSets.
      // That annotation intentionally identifies the controller owner, not the
      // generated workload. Accept it only when one controller owner is itself
      // in an expected Application status and the tracking identity names that
      // exact owner and Application. An unrelated/stale tracking annotation
      // remains a hard dangling-workload failure below.
      classification = "generated-by-argo-desired-root";
      applications = [...new Set(inheritedTrackingOwnerRoots.flatMap((owner) => owner.applications))].sort();
    } else if (hasTrackingAnnotation) {
      classification = "dangling-argo-tracking";
      addFinding(findings, "danglingTrackedDurableWorkload", ref, `${ARGO_TRACKING_ANNOTATION} identifies neither the exact workload nor one exact controller owner in an expected Application status.resources`);
    } else if (bootstrap) {
      classification = "bootstrap-baseline";
    } else if (desiredControllerOwnerRoots.length === 1) {
      classification = "generated-by-argo-desired-root";
      applications = [...new Set(desiredControllerOwnerRoots.flatMap((owner) => owner.applications))].sort();
    } else {
      classification = "unclassified";
      addFinding(findings, "unclassifiedDurableWorkload", ref, "durable workload is neither Argo desired, exact bootstrap, nor directly owned by a current Argo desired root");
    }

    rows.push({
      cluster,
      key,
      apiVersion: workload.apiVersion ?? null,
      kind: workload.kind ?? null,
      namespace: workload.metadata?.namespace ?? null,
      name: workload.metadata?.name ?? null,
      uid: workload.metadata?.uid ?? null,
      classification,
      applications,
      trackingID,
      trackingIdentity,
      inheritedTrackingFromDesiredOwner: inheritedTrackingOwnerRoots.length === 1,
      bootstrapRole: bootstrap?.role ?? null,
      bootstrapRuntimeVersion: bootstrap?.role === "argocd-runtime" ? ARGO_CD_RUNTIME_VERSION : null,
      desiredOwnerRoots,
      desiredControllerOwnerRoots,
      staleDesiredOwnerRoots,
      ownerReferences,
    });
  }
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

function desiredOwnerResourceName(owner) {
  const group = apiGroup(owner.apiVersion);
  const kind = String(owner.kind ?? "").toLowerCase();
  check(kind, "ownerReference kind is required");
  return group ? `${kind}.${group}` : kind;
}

function resolveLiveDesiredOwnerUIDs(cluster, workloads, desiredResources, findings) {
  const refs = new Map();
  for (const workload of workloads) {
    for (const owner of workload.metadata?.ownerReferences ?? []) {
      const key = owner.apiVersion && owner.kind && owner.name
        ? ownerReferenceKey(workload, owner)
        : null;
      if (!key || !desiredResources.has(key) || refs.has(key)) continue;
      refs.set(key, {
        key,
        apiVersion: owner.apiVersion,
        kind: owner.kind,
        namespace: workload.metadata?.namespace ?? null,
        name: owner.name,
      });
    }
  }

  const liveOwnerUIDs = new Map();
  for (const ref of refs.values()) {
    const args = ["get", desiredOwnerResourceName(ref), ref.name];
    if (ref.namespace) args.push("--namespace", ref.namespace);
    args.push("-o", "json");
    let live;
    try {
      live = JSON.parse(kubectl(cluster, args));
    } catch {
      addFinding(findings, "missingDesiredOwnerRoot", `${cluster}/${ref.key}`, "ownerReference target could not be read from the live cluster");
      continue;
    }
    const liveKey = workloadKey(live);
    if (liveKey !== ref.key) {
      addFinding(findings, "desiredOwnerRootIdentityDrift", `${cluster}/${ref.key}`, `live lookup returned ${liveKey}`);
      continue;
    }
    const uid = live.metadata?.uid ?? null;
    if (!uid) {
      addFinding(findings, "missingDesiredOwnerUID", `${cluster}/${ref.key}`, "live owner has no metadata.uid");
      continue;
    }
    liveOwnerUIDs.set(ref.key, uid);
  }
  return liveOwnerUIDs;
}

function workloadContainers(workload) {
  return [
    ...(workload.spec?.template?.spec?.initContainers ?? []),
    ...(workload.spec?.template?.spec?.containers ?? []),
  ];
}

function validateArgoBootstrapRuntime(cluster, workloadsByKey, findings) {
  const runtimeByName = new Map();
  for (const expected of BOOTSTRAP_DURABLE_WORKLOADS.filter((item) => item.role === "argocd-runtime")) {
    const workload = workloadsByKey.get(resourceKey(expected));
    if (workload) runtimeByName.set(expected.name, workload);
  }
  const expectedPairs = new Set(ARGO_CD_RUNTIME_CONTAINER_PAIRS.map(([workload, container]) => `${workload}/${container}`));
  for (const [workloadName, containerName] of ARGO_CD_RUNTIME_CONTAINER_PAIRS) {
    const workload = runtimeByName.get(workloadName);
    if (!workload) continue;
    const matches = workloadContainers(workload).filter((container) => container.name === containerName);
    if (matches.length !== 1) {
      addFinding(findings, "argoBootstrapRuntimeDrift", `${cluster}/argocd/${workloadName}/${containerName}`, `expected exactly one pinned runtime container, observed ${matches.length}`);
    } else if (matches[0].image !== ARGO_CD_RUNTIME_IMAGE) {
      addFinding(findings, "argoBootstrapRuntimeDrift", `${cluster}/argocd/${workloadName}/${containerName}`, `image is ${matches[0].image ?? "missing"}, expected ${ARGO_CD_RUNTIME_IMAGE}`);
    }
  }
  for (const [workloadName, workload] of runtimeByName) {
    for (const container of workloadContainers(workload)) {
      const pair = `${workloadName}/${container.name}`;
      if (String(container.image ?? "").startsWith("quay.io/argoproj/argocd:") && !expectedPairs.has(pair)) {
        addFinding(findings, "argoBootstrapRuntimeDrift", `${cluster}/argocd/${pair}`, `unexpected Argo CD runtime container uses ${container.image}`);
      }
    }
  }
}

function auditDurableWorkloads(plan, argo, findings) {
  const rows = [];
  const missingBootstrap = [];
  for (const cluster of plan.clusters) {
    const payload = JSON.parse(kubectl(cluster, [
      "get",
      DURABLE_WORKLOAD_RESOURCES.join(","),
      "--all-namespaces",
      "-o", "json",
    ]));
    const workloads = payload.items ?? [];
    const workloadsByKey = new Map();
    for (const workload of workloads) {
      const key = workloadKey(workload);
      if (workloadsByKey.has(key)) addFinding(findings, "duplicateDurableWorkload", `${cluster}/${key}`, "bulk Kubernetes inventory returned a duplicate durable-workload identity");
      workloadsByKey.set(key, workload);
    }
    for (const [key] of BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY) {
      if (workloadsByKey.has(key)) continue;
      missingBootstrap.push({ cluster, key });
      addFinding(findings, "missingBootstrapDurableWorkload", `${cluster}/${key}`, "exact kind/Argo bootstrap workload is missing");
    }
    validateArgoBootstrapRuntime(cluster, workloadsByKey, findings);
    const desiredResources = argo.desiredResourcesByCluster.get(cluster);
    const liveOwnerUIDs = resolveLiveDesiredOwnerUIDs(cluster, workloads, desiredResources, findings);
    rows.push(...classifyDurableWorkloads(
      cluster,
      workloads,
      desiredResources,
      findings,
      BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY,
      liveOwnerUIDs,
    ));
  }
  const classifications = Object.fromEntries(
    [...new Set(rows.map((row) => row.classification))].sort()
      .map((classification) => [classification, rows.filter((row) => row.classification === classification).length]),
  );
  return {
    resourceTypes: DURABLE_WORKLOAD_RESOURCES,
    bootstrapVersion: { argoCD: ARGO_CD_RUNTIME_VERSION, image: ARGO_CD_RUNTIME_IMAGE },
    argoDesiredRootCount: [...argo.desiredResourcesByCluster.values()].reduce((sum, resources) => sum + resources.size, 0),
    expectedBootstrapPerCluster: BOOTSTRAP_DURABLE_WORKLOADS.length,
    expectedBootstrapTotal: plan.clusters.length * BOOTSTRAP_DURABLE_WORKLOADS.length,
    missingBootstrap,
    classifications,
    observedCount: rows.length,
    unclassifiedCount: rows.filter((row) => row.classification === "unclassified").length,
    danglingTrackedCount: rows.filter((row) => row.classification === "dangling-argo-tracking").length,
    rows: rows.sort((left, right) => `${left.cluster}/${left.key}`.localeCompare(`${right.cluster}/${right.key}`)),
  };
}

function staleOwnershipAnnotations(resource) {
  const annotations = resource.metadata?.annotations ?? {};
  return OWNERSHIP_ANNOTATIONS.filter((key) => annotations[key] !== undefined);
}

function auditProtectedNamespaces(plan, findings) {
  const rows = [];
  for (const cluster of plan.clusters) {
    for (const namespace of PROTECTED_NAMESPACES) {
      const resource = JSON.parse(kubectl(cluster, ["get", "namespace", namespace, "-o", "json"]));
      const staleAnnotations = staleOwnershipAnnotations(resource);
      const staleLabels = namespace === "default"
        ? LEGACY_DEFAULT_NAMESPACE_LABELS.filter((key) => resource.metadata?.labels?.[key] !== undefined)
        : [];
      for (const key of staleAnnotations) addFinding(findings, "protectedNamespaceOwnership", `${cluster}/Namespace/${namespace}`, `stale annotation ${key} must be detached without deleting the namespace`);
      for (const key of staleLabels) addFinding(findings, "protectedNamespaceOwnership", `${cluster}/Namespace/${namespace}`, `stale label ${key} must be detached without deleting the namespace`);
      rows.push({
        cluster,
        namespace,
        uid: resource.metadata?.uid ?? null,
        phase: resource.status?.phase ?? "Unknown",
        staleOwnershipAnnotations: staleAnnotations,
        staleLegacyOwnershipLabels: staleLabels,
      });
    }
  }
  return rows;
}

function findingCounts(findings) {
  const categories = {};
  for (const finding of findings) categories[finding.category] = (categories[finding.category] ?? 0) + 1;
  return {
    unexpectedConfigHubSpaces: categories.unexpectedConfigHubSpace ?? 0,
    missingConfigHubSpaces: categories.missingConfigHubSpace ?? 0,
    duplicateConfigHubSpaces: categories.duplicateConfigHubSpace ?? 0,
    unexpectedConfigHubUnits: categories.unexpectedConfigHubUnit ?? 0,
    missingConfigHubUnits: categories.missingConfigHubUnit ?? 0,
    duplicateConfigHubUnits: categories.duplicateConfigHubUnit ?? 0,
    unexpectedConfigHubLinks: categories.unexpectedConfigHubLink ?? 0,
    missingConfigHubLinks: categories.missingConfigHubLink ?? 0,
    duplicateConfigHubLinks: categories.duplicateConfigHubLink ?? 0,
    unexpectedConfigHubTargets: categories.unexpectedConfigHubTarget ?? 0,
    missingConfigHubTargets: categories.missingConfigHubTarget ?? 0,
    duplicateConfigHubTargets: categories.duplicateConfigHubTarget ?? 0,
    unexpectedConfigHubTriggers: categories.unexpectedConfigHubTrigger ?? 0,
    missingConfigHubTriggers: categories.missingConfigHubTrigger ?? 0,
    duplicateConfigHubTriggers: categories.duplicateConfigHubTrigger ?? 0,
    triggerContractDrift: categories.triggerContractDrift ?? 0,
    unexpectedConfigHubFilters: categories.unexpectedConfigHubFilter ?? 0,
    missingConfigHubFilters: categories.missingConfigHubFilter ?? 0,
    duplicateConfigHubFilters: categories.duplicateConfigHubFilter ?? 0,
    filterContractDrift: categories.filterContractDrift ?? 0,
    triggerFilterAttachmentDrift: categories.triggerFilterAttachmentDrift ?? 0,
    orphanReleaseTags: categories.orphanReleaseTag ?? 0,
    missingReleaseTags: categories.missingReleaseTag ?? 0,
    duplicateConfigHubTags: categories.duplicateConfigHubTag ?? 0,
    releaseTagContractDrift: categories.releaseTagContractDrift ?? 0,
    orphanReleases: categories.orphanRelease ?? 0,
    missingCurrentReleases: categories.missingCurrentRelease ?? 0,
    releaseDigestDrift: categories.releaseDigestDrift ?? 0,
    releaseUnitCountDrift: categories.releaseUnitCountDrift ?? 0,
    unexpectedArgoApplications: categories.unexpectedArgoApplication ?? 0,
    missingArgoApplications: categories.missingArgoApplication ?? 0,
    argoApplicationContractDrift: categories.argoApplicationContractDrift ?? 0,
    argoApplicationAuthorityDrift: categories.argoApplicationAuthorityDrift ?? 0,
    applicationUnitAuthorityDrift: categories.applicationUnitAuthority ?? 0,
    argoActiveOperations: categories.argoActiveOperation ?? 0,
    argobotAuthorityDrift: categories.argobotAuthorityDrift ?? 0,
    unexpectedArgoApplicationSets: categories.unexpectedArgoApplicationSet ?? 0,
    requiresPruning: categories.argoRequiresPruning ?? 0,
    unclassifiedDurableWorkloads: categories.unclassifiedDurableWorkload ?? 0,
    danglingTrackedDurableWorkloads: categories.danglingTrackedDurableWorkload ?? 0,
    staleControllerOwnerUIDs: categories.staleControllerOwnerUID ?? 0,
    missingDesiredOwnerRoots: categories.missingDesiredOwnerRoot ?? 0,
    desiredOwnerRootIdentityDrift: categories.desiredOwnerRootIdentityDrift ?? 0,
    missingDesiredOwnerUIDs: categories.missingDesiredOwnerUID ?? 0,
    missingBootstrapDurableWorkloads: categories.missingBootstrapDurableWorkload ?? 0,
    argoBootstrapRuntimeDrift: categories.argoBootstrapRuntimeDrift ?? 0,
    protectedNamespaceOwnership: categories.protectedNamespaceOwnership ?? 0,
  };
}

function buildReceipt(plan, confighub, argo, durableWorkloads, protectedNamespaces, findings, observedAt) {
  const counts = findingCounts(findings);
  const zeroAuditedResidue = Object.values(counts).every((value) => value === 0);
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "KubaraMiniIDPOrphanAuditReceipt",
    metadata: { name: "kubara-v0-13-0-mini-idp-orphan-audit" },
    spec: {
      observedAt,
      organization: {
        name: ORGANIZATION,
        externalID: ORGANIZATION_EXTERNAL_ID,
        entityID: ORGANIZATION_ENTITY_ID,
        serverURL: CONFIGHUB_SERVER_URL,
      },
      source: {
        auditor: relativeRepo(AUDITOR_PATH),
        auditorSha256: `sha256:${sha256File(AUDITOR_PATH)}`,
        reconciler: relativeRepo(RECONCILER_PATH),
        reconcilerSha256: plan.reconcilerSha256,
        reconcilePlanSha256: plan.planSha256,
        applyAttemptLedger: relativeRepo(APPLY_ATTEMPT_LEDGER_PATH),
        applyAttemptLedgerSha256: `sha256:${sha256File(APPLY_ATTEMPT_LEDGER_PATH)}`,
      },
      auditScope: {
        claim: "zero unexpected ConfigHub inventory, zero Argo-prunable resources, zero unclassified or dangling audited durable workloads, and zero stale ownership on protected Namespaces",
        completeConfigHubInventory: ["Spaces", "Units", "Links", "Targets", "Triggers", "Filters", "release Tags", "published Releases"],
        argoInventory: ["the exact planned Applications", "every resource reported by current Application status", "every requiresPruning marker"],
        kubernetesInventory: [...DURABLE_WORKLOAD_RESOURCES, ...PROTECTED_NAMESPACES.map((namespace) => `namespace/${namespace}`)],
        excludedFromClusterWideClaim: "Kubernetes resource types outside current Argo status, the five audited durable-workload types, and the four protected Namespaces are not a complete cluster inventory and are not covered by this receipt",
        clusterWideOrphanFreeClaim: false,
      },
      execution: {
        readOnly: true,
        liveMutationCommands: 0,
        sharedSerialLiveLock: true,
        operationJournalRequiredQuiescent: true,
        snapshotBracketsRequired: 2,
        organizationWideListCallsPerBracket: CONFIGHUB_LIST_CALLS_PER_BRACKET,
        persistentClustersPreserved: plan.clusters,
      },
      expected: {
        spaces: plan.spaces.size,
        units: plan.units.size,
        links: plan.links.size,
        targets: plan.targets.size,
        triggers: plan.triggers.size,
        filters: plan.filters.size,
        releaseTags: "dynamic-complete-additive-history-through-each-current-release",
        currentReleaseStreams: plan.releaseStreams.size,
        argoApplications: argo.expectedApplicationCount,
        bootstrapDurableWorkloads: plan.clusters.length * BOOTSTRAP_DURABLE_WORKLOADS.length,
        protectedNamespaces: plan.clusters.length * PROTECTED_NAMESPACES.length,
      },
      observed: {
        spaces: confighub.spaces.length,
        units: confighub.units.size,
        links: confighub.links.size,
        targets: confighub.targetsByRef.size,
        triggers: confighub.triggersByRef.size,
        filters: confighub.filtersByRef.size,
        releaseTags: confighub.tagsByRef.size,
        argoApplications: argo.observedApplications.length,
        argoTrackedResources: argo.trackedResourceCount,
        durableWorkloads: durableWorkloads.observedCount,
      },
      configHubInventory: {
        snapshot: confighub.snapshot,
        triggerAllowlist: [...confighub.triggersByRef].map(([ref, trigger]) => ({
          ref,
          id: trigger.TriggerID,
          event: trigger.Event,
          toolchainType: trigger.ToolchainType,
          functionName: trigger.FunctionName,
          arguments: trigger.Arguments ?? [],
          disabled: trigger.Disabled === true,
          validating: trigger.Validating === true,
          failOpenAfter: Number(trigger.FailOpenAfter ?? 0),
        })).sort((left, right) => left.ref.localeCompare(right.ref)),
        filterAllowlist: [...confighub.filtersByRef].map(([ref, filter]) => ({
          ref,
          id: filter.FilterID,
          from: filter.From,
          where: filter.Where,
        })).sort((left, right) => left.ref.localeCompare(right.ref)),
      },
      catalogRetention: {
        ...plan.catalogRetention,
        classification: "intentional-additive-inventory-not-orphans",
      },
      releaseClassification: confighub.releaseClassification,
      releaseTagHistory: confighub.releaseTagHistory,
      argo: {
        applicationInventoryPolicy: "exact-plan-derived-allowlist",
        deploymentAuthorityPolicy: "targetRevision-latest-is-discovery-only; automated-sync-absent; no-active-operation; no-ApplicationSet-regeneration; ConfigHub-revalidated-ManifestDigest-operation-under-Kubernetes-UID-resourceVersion-CAS",
        argobotPolicy: "v0.1.6-kubernetes-hard-refresh-only; namespace-argocd; REST-sync-environment-absent",
        requiresPruningPolicy: "zero",
        applications: argo.observedApplications,
        argobotAuthority: argo.argobotAuthority,
        applicationSets: argo.applicationSets,
      },
      durableWorkloads: {
        policy: "classify every Deployment, StatefulSet, DaemonSet, CronJob and Job as exact Argo desired, exact bootstrap, or UID-bound directly owned by a current Argo desired root",
        danglingTrackingPolicy: "tracking-id-must-identify-the-exact-workload-or-one-exact-controller-owner-in-the-same-expected-Application-status",
        ...durableWorkloads,
      },
      protectedNamespaces: {
        policy: "retain-the-namespace-and-require-all-ConfigHub-Argo-ownership-metadata-absent",
        rows: protectedNamespaces,
      },
      findings,
    },
    status: {
      result: findings.length === 0 && zeroAuditedResidue ? "pass" : "fail",
      zeroAuditedResidue,
      exactConfigHubInventory: [
        counts.unexpectedConfigHubSpaces,
        counts.missingConfigHubSpaces,
        counts.duplicateConfigHubSpaces,
        counts.unexpectedConfigHubUnits,
        counts.missingConfigHubUnits,
        counts.duplicateConfigHubUnits,
        counts.unexpectedConfigHubLinks,
        counts.missingConfigHubLinks,
        counts.duplicateConfigHubLinks,
        counts.unexpectedConfigHubTargets,
        counts.missingConfigHubTargets,
        counts.duplicateConfigHubTargets,
        counts.unexpectedConfigHubTriggers,
        counts.missingConfigHubTriggers,
        counts.duplicateConfigHubTriggers,
        counts.triggerContractDrift,
        counts.unexpectedConfigHubFilters,
        counts.missingConfigHubFilters,
        counts.duplicateConfigHubFilters,
        counts.filterContractDrift,
        counts.triggerFilterAttachmentDrift,
        counts.orphanReleaseTags,
        counts.missingReleaseTags,
        counts.duplicateConfigHubTags,
        counts.releaseTagContractDrift,
      ].every((value) => value === 0),
      zeroUnexpectedConfigHubInventory: counts.unexpectedConfigHubSpaces + counts.unexpectedConfigHubUnits + counts.unexpectedConfigHubLinks + counts.unexpectedConfigHubTargets + counts.unexpectedConfigHubTriggers + counts.unexpectedConfigHubFilters + counts.orphanReleaseTags + counts.duplicateConfigHubTags === 0,
      exactTriggerFilterInventory: counts.unexpectedConfigHubTriggers + counts.missingConfigHubTriggers + counts.duplicateConfigHubTriggers + counts.triggerContractDrift + counts.unexpectedConfigHubFilters + counts.missingConfigHubFilters + counts.duplicateConfigHubFilters + counts.filterContractDrift + counts.triggerFilterAttachmentDrift === 0,
      exactCurrentReleaseInventory: counts.orphanReleases + counts.missingCurrentReleases + counts.releaseDigestDrift + counts.releaseUnitCountDrift + counts.orphanReleaseTags + counts.missingReleaseTags + counts.duplicateConfigHubTags + counts.releaseTagContractDrift === 0,
      exactDeploymentAuthority: counts.unexpectedArgoApplications + counts.missingArgoApplications + counts.argoApplicationContractDrift + counts.argoApplicationAuthorityDrift + counts.applicationUnitAuthorityDrift + counts.argoActiveOperations + counts.argobotAuthorityDrift + counts.unexpectedArgoApplicationSets === 0,
      zeroArgoRequiresPruning: counts.requiresPruning === 0,
      zeroUnclassifiedDurableWorkloads: counts.unclassifiedDurableWorkloads === 0,
      zeroDanglingTrackedDurableWorkloads: counts.danglingTrackedDurableWorkloads === 0,
      zeroStaleControllerOwnership: counts.staleControllerOwnerUIDs + counts.missingDesiredOwnerRoots + counts.desiredOwnerRootIdentityDrift + counts.missingDesiredOwnerUIDs === 0,
      zeroProtectedNamespaceOwnership: counts.protectedNamespaceOwnership === 0,
      retainedReleaseHistoryProvedByTags: true,
      orphanCounts: counts,
      findingCount: findings.length,
    },
  };
}

function runAudit(plan) {
  assertQuiescentJournal();
  const processes = tryCommand("pgrep", ["-fl", "reconcile-kubara-mini-idp.mjs --apply"]);
  check(!processes.ok || !processes.output.trim(), `orphan audit refuses an active reconciler:\n${processes.output}`);
  const lock = acquireAuditLock();
  try {
    assertQuiescentJournal();
    assertCurrentApplyAttemptPair();
    invalidatePriorPerformanceAcceptance();
    const findings = [];
    const client = pinnedCubClient();
    const confighub = readConfigHubInventory(client, plan, findings);
    const argo = auditArgo(plan, confighub, findings);
    const durableWorkloads = auditDurableWorkloads(plan, argo, findings);
    const protectedNamespaces = auditProtectedNamespaces(plan, findings);
    assertQuiescentJournal();
    const observedAt = new Date().toISOString();
    const openingReceipt = buildReceipt(plan, confighub, argo, durableWorkloads, protectedNamespaces, findings, observedAt);
    const closingFindings = [];
    const closingConfigHub = readConfigHubInventory(client, plan, closingFindings);
    const closingArgo = auditArgo(plan, closingConfigHub, closingFindings);
    const closingDurableWorkloads = auditDurableWorkloads(plan, closingArgo, closingFindings);
    const closingProtectedNamespaces = auditProtectedNamespaces(plan, closingFindings);
    assertQuiescentJournal();
    assertCurrentApplyAttemptPair();
    const receipt = buildReceipt(
      plan,
      closingConfigHub,
      closingArgo,
      closingDurableWorkloads,
      closingProtectedNamespaces,
      closingFindings,
      observedAt,
    );
    check(
      stableJson(receipt) === stableJson(openingReceipt),
      "ConfigHub, Argo Application, workload, or protected-Namespace inventory changed during the scoped residue audit",
    );
    receipt.spec.execution.organizationWideReadBrackets = {
      openingCoreFiveResourceFingerprint: openingReceipt.spec.configHubInventory.snapshot.coreFiveResourceFingerprint,
      closingCoreFiveResourceFingerprint: receipt.spec.configHubInventory.snapshot.coreFiveResourceFingerprint,
      openingFullEightResourceFingerprint: openingReceipt.spec.configHubInventory.snapshot.fullEightResourceFingerprint,
      closingFullEightResourceFingerprint: receipt.spec.configHubInventory.snapshot.fullEightResourceFingerprint,
      stable: true,
    };
    receipt.status.openingClosingSnapshotStable = true;
    writeYamlAtomically(RECEIPT_PATH, receipt);
    console.log(`wrote ${relativeRepo(RECEIPT_PATH)}: ${receipt.status.result}; ${receipt.status.findingCount} finding(s)`);
    check(receipt.status.result === "pass", `Kubara mini-IDP orphan audit failed:\n- ${receipt.spec.findings.map((item) => `${item.category} ${item.ref}: ${item.detail}`).join("\n- ")}`);
    verifyReceipt(plan);
    const performance = reconcilePerformanceAcceptance(receipt);
    console.log(`mini-IDP performance acceptance: ${performance.result}${performance.detail ? ` (${performance.detail})` : ""}`);
  } finally {
    releaseAuditLock(lock);
  }
}

function assertCurrentApplyAttemptPair() {
  check(existsSync(RECONCILE_RECEIPT_PATH), `${relativeRepo(RECONCILE_RECEIPT_PATH)} is missing`);
  check(existsSync(APPLY_ATTEMPT_LEDGER_PATH), `${relativeRepo(APPLY_ATTEMPT_LEDGER_PATH)} is missing`);
  const receipt = readYaml(RECONCILE_RECEIPT_PATH);
  const ledger = readYaml(APPLY_ATTEMPT_LEDGER_PATH);
  check(ledger?.kind === "KubaraMiniIDPApplyAttemptLedger" && Array.isArray(ledger.attempts), "apply attempt ledger is invalid");
  const [changed, noop] = (receipt.spec?.reconcileRuns ?? []).slice(-2);
  check(changed && noop && changed.actionCount > 0 && noop.actionCount === 0, "current reconcile receipt lacks changed/no-op runs");
  check(noop.attemptSequence === changed.attemptSequence + 1, "changed/no-op runs are not consecutive apply attempts");
  check(
    SHA256_PATTERN.test(changed.finalConfigHubFingerprint ?? "")
      && changed.finalConfigHubFingerprint === noop.finalConfigHubFingerprint
      && noop.finalConfigHubFingerprint === receipt.spec?.finalConfigHubSnapshot?.fingerprint,
    "changed/no-op runs do not share the receipt's canonical final ConfigHub state",
  );
  const changedAttempt = ledger.attempts.find((item) => item.sequence === changed.attemptSequence);
  const noopAttempt = ledger.attempts.find((item) => item.sequence === noop.attemptSequence);
  check(
    changedAttempt?.id === changed.attemptID
      && noopAttempt?.id === noop.attemptID
      && changedAttempt.result === "pass"
      && noopAttempt.result === "pass"
      && changedAttempt.executionFingerprint === changed.executionFingerprint
      && noopAttempt.executionFingerprint === noop.executionFingerprint,
    "changed/no-op runs are not backed by exact passing durable attempts",
  );
  check(ledger.attempts.at(-1)?.sequence === noop.attemptSequence, "a later apply attempt invalidates scoped-residue/performance acceptance");
  return { receipt, ledger };
}

function invalidatePriorPerformanceAcceptance() {
  const receipt = readYaml(RECONCILE_RECEIPT_PATH);
  receipt.status = { ...(receipt.status ?? {}) };
  delete receipt.status.performanceResult;
  delete receipt.status.performanceAcceptance;
  writeYamlAtomically(RECONCILE_RECEIPT_PATH, receipt);
}

function writeYamlAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${toYaml(value)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function reconcilePerformanceAcceptance(orphanReceipt) {
  if (!existsSync(RECONCILE_RECEIPT_PATH)) return { result: "pending", detail: "reconcile receipt is absent" };
  const receipt = readYaml(RECONCILE_RECEIPT_PATH);
  check(receipt?.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", "cannot bind performance acceptance to an unexpected reconcile receipt");
  assertCurrentApplyAttemptPair();
  try {
    execFileSync(process.execPath, [RECONCILER_PATH, "--receipt-verify"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`current reconcile receipt failed its own source/attempt verifier: ${String(error.stderr || error.stdout || error.message).trim()}`);
  }
  const priorPerformanceResult = receipt.status?.performanceResult;
  const priorBinding = receipt.status?.performanceAcceptance;
  receipt.status = { ...(receipt.status ?? {}) };
  delete receipt.status.performanceResult;
  delete receipt.status.performanceAcceptance;

  const [changed, noop] = (receipt.spec?.reconcileRuns ?? []).slice(-2);
  const pairLooksEligible = Boolean(
    changed
      && noop
      && changed.performance?.schemaVersion === 2
      && noop.performance?.schemaVersion === 2
      && changed.performance?.fixtureID === "kubara-v0-13-0-four-cluster-warm-v1"
      && noop.performance?.fixtureID === "kubara-v0-13-0-four-cluster-warm-v1"
      && changed.performance?.runClass === "changed-apply"
      && noop.performance?.runClass === "idempotent-apply",
  );
  if (!pairLooksEligible) {
    if (priorPerformanceResult !== undefined || priorBinding !== undefined) writeYamlAtomically(RECONCILE_RECEIPT_PATH, receipt);
    return { result: "pending", detail: "immediate measured changed/no-op pair is absent" };
  }

  const orphanCoreFingerprint = orphanReceipt.spec?.execution?.organizationWideReadBrackets?.openingCoreFiveResourceFingerprint;
  check(
    SHA256_PATTERN.test(noop.finalConfigHubFingerprint ?? "")
      && SHA256_PATTERN.test(orphanCoreFingerprint ?? "")
      && orphanCoreFingerprint === orphanReceipt.spec?.configHubInventory?.snapshot?.coreFiveResourceFingerprint
      && noop.finalConfigHubFingerprint === orphanCoreFingerprint,
    "scoped residue audit opening ConfigHub state does not equal the latest no-op run final state",
  );

  receipt.status.performanceResult = "performance-pass";
  receipt.status.performanceAcceptance = {
    orphanReceipt: relativeRepo(RECEIPT_PATH),
    orphanReceiptSha256: `sha256:${sha256File(RECEIPT_PATH)}`,
    orphanObservedAt: orphanReceipt.spec?.observedAt,
    reconcilerSha256: orphanReceipt.spec?.source?.reconcilerSha256,
    reconcilePlanSha256: orphanReceipt.spec?.source?.reconcilePlanSha256,
    applyAttemptLedgerSha256: orphanReceipt.spec?.source?.applyAttemptLedgerSha256,
    finalConfigHubFingerprint: noop.finalConfigHubFingerprint,
  };
  const fixtureRoot = mkdtempSync(join(tmpdir(), "kubara-performance-acceptance-"));
  const candidatePath = join(fixtureRoot, "receipt.yaml");
  try {
    writeFileSync(candidatePath, `${toYaml(receipt)}\n`, "utf8");
    try {
      execFileSync(process.execPath, [
        PERFORMANCE_VERIFIER_PATH,
        "--receipt-verify",
        "--receipt", candidatePath,
        "--orphan-receipt", RECEIPT_PATH,
      ], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      delete receipt.status.performanceResult;
      delete receipt.status.performanceAcceptance;
      writeYamlAtomically(RECONCILE_RECEIPT_PATH, receipt);
      const detail = String(error.stderr || error.stdout || error.message).trim().split("\n").at(-1);
      return { result: "pending", detail: detail || "performance verifier rejected the pair" };
    }
    writeYamlAtomically(RECONCILE_RECEIPT_PATH, receipt);
    return { result: "performance-pass", detail: "immediate pair and current scoped residue audit verified" };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function verifyReceipt(plan) {
  const { receipt: reconcileReceipt } = assertCurrentApplyAttemptPair();
  const noopRun = (reconcileReceipt.spec?.reconcileRuns ?? []).at(-1);
  check(existsSync(RECEIPT_PATH), `${relativeRepo(RECEIPT_PATH)} is missing; run --audit after reconciliation is quiescent`);
  const receipt = readYaml(RECEIPT_PATH);
  check(receipt?.kind === "KubaraMiniIDPOrphanAuditReceipt", "orphan audit receipt kind drifted");
  check(receipt.spec?.organization?.externalID === ORGANIZATION_EXTERNAL_ID, "orphan audit receipt external Organization ID drifted");
  check(receipt.spec?.organization?.entityID === ORGANIZATION_ENTITY_ID, "orphan audit receipt Organization entity ID drifted");
  check(receipt.spec?.organization?.serverURL === CONFIGHUB_SERVER_URL, "orphan audit receipt server drifted");
  check(receipt.spec?.source?.auditor === relativeRepo(AUDITOR_PATH), "orphan audit receipt auditor path drifted");
  check(receipt.spec?.source?.auditorSha256 === `sha256:${sha256File(AUDITOR_PATH)}`, "orphan audit receipt auditor digest is stale");
  check(receipt.spec?.source?.reconcilerSha256 === plan.reconcilerSha256, "orphan audit receipt reconciler digest is stale");
  check(receipt.spec?.source?.reconcilePlanSha256 === plan.planSha256, "orphan audit receipt plan digest is stale");
  check(
    receipt.spec?.source?.applyAttemptLedgerSha256 === `sha256:${sha256File(APPLY_ATTEMPT_LEDGER_PATH)}`,
    "orphan audit receipt apply attempt ledger digest is stale",
  );
  check(receipt.spec?.execution?.readOnly === true && receipt.spec?.execution?.liveMutationCommands === 0, "orphan audit receipt no longer proves read-only execution");
  check(receipt.spec?.execution?.snapshotBracketsRequired === 2, "orphan audit receipt no longer requires opening and closing snapshots");
  check(
    stableJson(receipt.spec?.execution?.organizationWideListCallsPerBracket) === stableJson(CONFIGHUB_LIST_CALLS_PER_BRACKET),
    "orphan audit receipt ConfigHub list-call budget drifted",
  );
  const brackets = receipt.spec?.execution?.organizationWideReadBrackets;
  check(
    brackets?.stable === true
      && SHA256_PATTERN.test(brackets.openingCoreFiveResourceFingerprint ?? "")
      && brackets.openingCoreFiveResourceFingerprint === brackets.closingCoreFiveResourceFingerprint
      && SHA256_PATTERN.test(brackets.openingFullEightResourceFingerprint ?? "")
      && brackets.openingFullEightResourceFingerprint === brackets.closingFullEightResourceFingerprint,
    "orphan audit receipt does not prove stable opening and closing ConfigHub snapshots",
  );
  const expected = receipt.spec?.expected ?? {};
  const observed = receipt.spec?.observed ?? {};
  check(expected.spaces === plan.spaces.size, "orphan audit receipt Space count drifted");
  check(expected.units === plan.units.size, "orphan audit receipt Unit count drifted");
  check(expected.links === plan.links.size, "orphan audit receipt Link count drifted");
  check(expected.targets === plan.targets.size, "orphan audit receipt Target count drifted");
  check(expected.triggers === plan.triggers.size, "orphan audit receipt Trigger count drifted");
  check(expected.filters === plan.filters.size, "orphan audit receipt Filter count drifted");
  for (const resource of ["spaces", "units", "links", "targets", "triggers", "filters"]) {
    check(observed[resource] === expected[resource], `orphan audit observed ${resource} count differs from the exact allowlist`);
  }
  const configHubInventory = receipt.spec?.configHubInventory;
  check(
    configHubInventory?.snapshot?.schemaVersion === 1
      && configHubInventory.snapshot.mode === "organization-wide-single-list-per-resource"
      && configHubInventory.snapshot.canonicalization === "stable-recursive-key-order-and-entity-row-order"
      && configHubInventory.snapshot.fingerprintAlgorithm === "sha256"
      && stableJson(configHubInventory.snapshot.coreResources) === stableJson(CORE_CONFIGHUB_FINGERPRINT_RESOURCES)
      && stableJson(configHubInventory.snapshot.fullResources) === stableJson(FULL_CONFIGHUB_FINGERPRINT_RESOURCES)
      && configHubInventory.snapshot.coreFiveResourceFingerprintScope === "reconciler-final-selected-Space-Unit-published-Release-Link-Target-snapshot"
      && configHubInventory.snapshot.fullEightResourceFingerprintScope === "core-five-plus-selected-Trigger-Filter-release-Tag-snapshot"
      && SHA256_PATTERN.test(configHubInventory.snapshot.coreFiveResourceFingerprint ?? "")
      && SHA256_PATTERN.test(configHubInventory.snapshot.fullEightResourceFingerprint ?? "")
      && configHubInventory.snapshot.coreFiveResourceFingerprint === brackets.closingCoreFiveResourceFingerprint
      && configHubInventory.snapshot.fullEightResourceFingerprint === brackets.closingFullEightResourceFingerprint,
    "orphan audit ConfigHub snapshot evidence is missing or unbound",
  );
  check(
    stableJson(configHubInventory.snapshot.fieldSets) === stableJson(CONFIGHUB_FINGERPRINT_FIELD_SETS),
    "orphan audit canonical ConfigHub snapshot field coverage drifted",
  );
  check(
    noopRun?.idempotentNoop === true
      && noopRun.actionCount === 0
      && SHA256_PATTERN.test(noopRun.finalConfigHubFingerprint ?? "")
      && noopRun.finalConfigHubFingerprint === brackets.openingCoreFiveResourceFingerprint
      && reconcileReceipt.spec?.finalConfigHubSnapshot?.fingerprint === noopRun.finalConfigHubFingerprint,
    "orphan audit opening five-resource snapshot is not the latest no-op run final ConfigHub state",
  );
  check(
    stableJson(configHubInventory.snapshot.listCalls) === stableJson(CONFIGHUB_LIST_CALLS_PER_BRACKET),
    "orphan audit ConfigHub snapshot used an unexpected list-call shape",
  );
  check(
    stableJson(configHubInventory.snapshot.counts) === stableJson({
      spaces: observed.spaces,
      units: observed.units,
      links: observed.links,
      targets: observed.targets,
      releases: receipt.spec?.releaseClassification?.activeCurrent?.length
        + receipt.spec?.releaseClassification?.historical?.length
        + receipt.spec?.releaseClassification?.retainedCatalogOrProof?.length
        + receipt.spec?.releaseClassification?.orphaned?.length,
      publishedReleases: [
        ...(receipt.spec?.releaseClassification?.activeCurrent ?? []),
        ...(receipt.spec?.releaseClassification?.historical ?? []),
        ...(receipt.spec?.releaseClassification?.retainedCatalogOrProof ?? []),
        ...(receipt.spec?.releaseClassification?.orphaned ?? []),
      ].filter((item) => item.published).length,
      triggers: observed.triggers,
      filters: observed.filters,
      tags: observed.releaseTags,
    }),
    "orphan audit ConfigHub snapshot counts are not bound to the receipt inventory",
  );
  const receiptTriggers = new Map((configHubInventory.triggerAllowlist ?? []).map((item) => [item.ref, item]));
  check(receiptTriggers.size === plan.triggers.size, "orphan audit Trigger allowlist count is not exact");
  for (const [ref, expectedTrigger] of plan.triggers) {
    const trigger = receiptTriggers.get(ref);
    check(
      typeof trigger?.id === "string"
        && trigger.id.length > 0
        && trigger.event === expectedTrigger.event
        && trigger.toolchainType === expectedTrigger.toolchainType
        && trigger.functionName === expectedTrigger.functionName
        && stableJson(trigger.arguments) === stableJson(expectedTrigger.arguments)
        && trigger.disabled === expectedTrigger.disabled
        && trigger.validating === expectedTrigger.validating
        && trigger.failOpenAfter === expectedTrigger.failOpenAfter,
      `${ref}: orphan audit receipt Trigger behavior is not exact`,
    );
  }
  const receiptFilters = new Map((configHubInventory.filterAllowlist ?? []).map((item) => [item.ref, item]));
  check(receiptFilters.size === plan.filters.size, "orphan audit Filter allowlist count is not exact");
  for (const [ref, expectedFilter] of plan.filters) {
    const filter = receiptFilters.get(ref);
    check(
      typeof filter?.id === "string"
        && filter.id.length > 0
        && filter.from === expectedFilter.from
        && filter.where === expectedFilter.where,
      `${ref}: orphan audit receipt Filter behavior is not exact`,
    );
  }
  check(expected.currentReleaseStreams === plan.releaseStreams.size, "orphan audit receipt release stream count drifted");
  check(expected.argoApplications === plan.reconcilePlan.spec.counts.deliveryApplicationUnits, "orphan audit receipt Argo Application count drifted");
  check(expected.bootstrapDurableWorkloads === plan.clusters.length * BOOTSTRAP_DURABLE_WORKLOADS.length, "orphan audit receipt bootstrap workload count drifted");
  check(receipt.spec?.releaseClassification?.activeCurrent?.length === plan.releaseStreams.size, "orphan audit active release classification is incomplete");
  for (const release of receipt.spec.releaseClassification.activeCurrent) {
    const expectedUnitCount = [...plan.units.keys()]
      .filter((ref) => ref.startsWith(`${release.space}/`)).length;
    check(
      UUID_PATTERN.test(release.releaseID ?? "")
        && UUID_PATTERN.test(release.tagID ?? "")
        && Number(release.unitCount) === expectedUnitCount
        && expectedUnitCount > 0,
      `${release.space}: orphan audit current release UnitCount is not the exact ${expectedUnitCount}-Unit inventory`,
    );
  }
  check(receipt.spec?.releaseClassification?.orphaned?.length === 0, "orphan audit receipt contains orphan releases");
  const releaseTagHistory = receipt.spec?.releaseTagHistory;
  check(
    releaseTagHistory?.policy === "additive-release-N-tags-contiguous-from-one-through-current-release"
      && Number.isInteger(releaseTagHistory.retainedTagCount)
      && releaseTagHistory.retainedTagCount === observed.releaseTags
      && releaseTagHistory.retainedTagCount === configHubInventory.snapshot.counts.tags,
    "orphan audit retained release Tag inventory is missing or unbound",
  );
  check(
    releaseTagHistory.streams?.length === configHubInventory.snapshot.counts.publishedReleases,
    "orphan audit retained release Tag streams do not cover every current Release",
  );
  for (const stream of releaseTagHistory.streams) {
    check(plan.spaces.has(stream.space), `${stream.space}: retained release Tag stream belongs to an unknown Space`);
    check(
      UUID_PATTERN.test(stream.currentReleaseID ?? "")
        && UUID_PATTERN.test(stream.currentTagID ?? "")
        && Number.isInteger(stream.currentReleaseNum)
        && stream.currentReleaseNum > 0
        && stream.retainedTagCount === stream.currentReleaseNum
        && stream.contiguousFromOne === true
        && stream.exactCurrentTag === true
        && stream.tags?.length === stream.retainedTagCount,
      `${stream.space}: retained release Tag history is incomplete`,
    );
    for (let index = 0; index < stream.tags.length; index += 1) {
      const tag = stream.tags[index];
      check(
        tag.slug === `release-${index + 1}`
          && UUID_PATTERN.test(tag.tagID ?? "")
          && typeof tag.createdAt === "string"
          && tag.createdAt.length > 0,
        `${stream.space}: retained release Tag ${index + 1} is invalid or out of sequence`,
      );
    }
    check(stream.tags.at(-1)?.tagID === stream.currentTagID, `${stream.space}: current Release does not reference the last retained Tag`);
  }
  check(receipt.status?.exactCurrentReleaseInventory === true, "orphan audit current Release inventory is not exact");
  check(receipt.spec?.argo?.requiresPruningPolicy === "zero", "orphan audit requiresPruning policy drifted");
  check(
    receipt.spec?.argo?.deploymentAuthorityPolicy === "targetRevision-latest-is-discovery-only; automated-sync-absent; no-active-operation; no-ApplicationSet-regeneration; ConfigHub-revalidated-ManifestDigest-operation-under-Kubernetes-UID-resourceVersion-CAS",
    "orphan audit deployment-authority policy drifted",
  );
  const applicationRows = receipt.spec?.argo?.applications ?? [];
  const expectedApplicationUnits = new Set(plan.reconcilePlan.spec.deliveryApplicationUnits.map((item) => item.ref));
  check(applicationRows.length === expected.argoApplications, "orphan audit does not retain every Argo Application authority row");
  check(new Set(applicationRows.map((row) => row.sourceUnit)).size === expectedApplicationUnits.size, "orphan audit Argo Application source Unit identities are duplicated");
  for (const row of applicationRows) {
    check(expectedApplicationUnits.has(row.sourceUnit), `${row.cluster}/${row.name}: authority row is outside the delivery Unit allowlist`);
    check(
      row.targetRevision === "latest"
        && row.automatedSyncDisabled === true
        && row.applicationSetOwnerAbsent === true
        && row.activeOperation === false
        && !["Running", "Terminating"].includes(row.operationPhase)
        && row.syncSubmissionAuthority === "ConfigHub-revalidated-ManifestDigest-Kubernetes-UID-resourceVersion-CAS",
      `${row.cluster}/${row.name}: retained deployment-authority evidence is not fail-closed`,
    );
    check(
      SHA256_PATTERN.test(row.expectedRevision ?? "")
        && row.observedRevision === row.expectedRevision
        && row.sync === "Synced",
      `${row.cluster}/${row.name}: retained exact-revision Argo state is not accepted`,
    );
  }
  const argobotRows = receipt.spec?.argo?.argobotAuthority ?? [];
  check(argobotRows.length === plan.clusters.length, "orphan audit argobot authority evidence is incomplete");
  for (const row of argobotRows) {
    check(plan.clusters.includes(row.cluster) && row.version === ARGOBOT_VERSION, "orphan audit argobot identity drifted");
    const deployment = row.deployment ?? {};
    check(
      deployment.image === ARGOBOT_IMAGE
        && deployment.syncMode === "kubernetes"
        && deployment.applicationNamespace === "argocd"
        && deployment.refreshType === "hard"
        && deployment.restSyncEnvironmentAbsent === true
        && deployment.commandOverrideAbsent === true
        && deployment.oneContainerNoInit === true
        && deployment.duplicateEnvironmentAbsent === true
        && deployment.selectorExact === true
        && deployment.rolloutCurrent === true,
      `${row.cluster}: retained argobot Deployment authority is not refresh-only`,
    );
    check((row.pods ?? []).length === deployment.replicas && deployment.replicas > 0, `${row.cluster}: retained argobot Pod inventory is incomplete`);
    for (const pod of row.pods) {
      check(
        /^[0-9a-f-]{36}$/i.test(pod.uid ?? "")
          && pod.runningReady === true
          && pod.image === ARGOBOT_IMAGE
          && pod.syncMode === "kubernetes"
          && pod.applicationNamespace === "argocd"
          && pod.refreshType === "hard"
          && pod.restSyncEnvironmentAbsent === true
          && pod.commandOverrideAbsent === true
          && pod.oneContainerNoInit === true
          && pod.duplicateEnvironmentAbsent === true,
        `${row.cluster}/${pod.name}: retained argobot Pod authority is not refresh-only`,
      );
    }
  }
  const applicationSetRows = receipt.spec?.argo?.applicationSets ?? [];
  check(applicationSetRows.length === plan.clusters.length, "orphan audit ApplicationSet inventory is incomplete");
  for (const row of applicationSetRows) {
    check(plan.clusters.includes(row.cluster) && row.count === 0 && stableJson(row.refs) === "[]", `${row.cluster}: orphan audit retains ApplicationSet regeneration authority`);
  }
  check(receipt.status?.exactDeploymentAuthority === true, "orphan audit deployment authority is not exact");
  check(receipt.spec?.auditScope?.clusterWideOrphanFreeClaim === false, "orphan audit must not claim a complete cluster-wide resource inventory");
  check(Array.isArray(receipt.spec?.auditScope?.completeConfigHubInventory) && receipt.spec.auditScope.completeConfigHubInventory.length === 8, "orphan audit ConfigHub scope is not explicit");
  check(typeof receipt.spec?.auditScope?.excludedFromClusterWideClaim === "string" && receipt.spec.auditScope.excludedFromClusterWideClaim.includes("not a complete cluster inventory"), "orphan audit cluster exclusion is not explicit");
  check(receipt.spec?.durableWorkloads?.resourceTypes?.length === DURABLE_WORKLOAD_RESOURCES.length, "durable workload resource inventory is incomplete");
  check(receipt.spec?.durableWorkloads?.bootstrapVersion?.argoCD === ARGO_CD_RUNTIME_VERSION, "durable workload Argo bootstrap version drifted");
  check(receipt.spec?.durableWorkloads?.expectedBootstrapTotal === plan.clusters.length * BOOTSTRAP_DURABLE_WORKLOADS.length, "durable workload bootstrap inventory drifted");
  check(receipt.spec?.durableWorkloads?.missingBootstrap?.length === 0, "durable workload receipt is missing bootstrap workloads");
  check(receipt.spec?.durableWorkloads?.unclassifiedCount === 0, "durable workload receipt contains unclassified workloads");
  check(receipt.spec?.durableWorkloads?.danglingTrackedCount === 0, "durable workload receipt contains dangling Argo tracking");
  check(Array.isArray(receipt.spec?.durableWorkloads?.rows), "durable workload receipt rows are missing");
  const durableRows = receipt.spec.durableWorkloads.rows;
  check(durableRows.length === receipt.spec?.observed?.durableWorkloads, "durable workload receipt does not record every observed workload");
  check(durableRows.every((row) => ["argo-status-desired", "bootstrap-baseline", "generated-by-argo-desired-root"].includes(row.classification)), "durable workload receipt contains a rejected classification");
  for (const row of durableRows.filter((item) => item.classification === "generated-by-argo-desired-root")) {
    check((row.desiredOwnerRoots ?? []).length > 0, `${row.cluster}/${row.key}: generated workload has no current desired owner root`);
    check((row.desiredControllerOwnerRoots ?? []).length === 1, `${row.cluster}/${row.key}: generated workload does not have exactly one current controller owner root`);
    check((row.staleDesiredOwnerRoots ?? []).length === 0, `${row.cluster}/${row.key}: generated workload retains stale controller ownership`);
    check(row.desiredOwnerRoots.every((owner) => owner.uid && owner.uid === owner.liveUID), `${row.cluster}/${row.key}: generated workload owner UID is not bound to the live controller`);
  }
  const durableRowKeys = new Set(durableRows.map((row) => `${row.cluster}/${row.key}`));
  for (const cluster of plan.clusters) {
    for (const [key] of BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY) check(durableRowKeys.has(`${cluster}/${key}`), `${cluster}: receipt omits bootstrap workload ${key}`);
  }
  const protectedRows = receipt.spec?.protectedNamespaces?.rows ?? [];
  check(protectedRows.length === plan.clusters.length * PROTECTED_NAMESPACES.length, "protected namespace inventory is incomplete");
  for (const row of protectedRows) {
    check(plan.clusters.includes(row.cluster) && PROTECTED_NAMESPACES.includes(row.namespace), "protected namespace receipt identity drifted");
    check(/^[0-9a-f-]{36}$/i.test(row.uid ?? "") && row.phase === "Active", `${row.cluster}/Namespace/${row.namespace}: retained identity or phase is invalid`);
    check((row.staleOwnershipAnnotations ?? []).length === 0, `${row.cluster}/Namespace/${row.namespace}: stale ownership annotations remain`);
    check((row.staleLegacyOwnershipLabels ?? []).length === 0, `${row.cluster}/Namespace/${row.namespace}: stale legacy ownership labels remain`);
  }
  check(receipt.spec?.findings?.length === 0, "orphan audit receipt retains findings");
  check(receipt.status?.result === "pass", "orphan audit receipt is not a pass");
  check(receipt.status?.zeroAuditedResidue === true, "orphan audit receipt does not prove zero residue in its declared scope");
  check(receipt.status?.openingClosingSnapshotStable === true, "orphan audit receipt does not attest opening/closing snapshot stability");
  check(receipt.status?.exactConfigHubInventory === true, "orphan audit receipt does not prove exact ConfigHub inventory");
  check(receipt.status?.zeroUnexpectedConfigHubInventory === true, "orphan audit receipt does not prove zero unexpected ConfigHub inventory");
  check(receipt.status?.exactTriggerFilterInventory === true, "orphan audit receipt does not prove exact Trigger/Filter inventory");
  check(receipt.status?.zeroArgoRequiresPruning === true, "orphan audit receipt does not prove zero Argo requiresPruning resources");
  check(receipt.status?.zeroUnclassifiedDurableWorkloads === true, "orphan audit receipt does not prove zero unclassified durable workloads");
  check(receipt.status?.zeroDanglingTrackedDurableWorkloads === true, "orphan audit receipt does not prove zero dangling tracked durable workloads");
  check(receipt.status?.zeroStaleControllerOwnership === true, "orphan audit receipt does not prove UID-current controller ownership");
  check(receipt.status?.zeroProtectedNamespaceOwnership === true, "orphan audit receipt does not prove protected namespace detachment");
  check(
    stableJson(receipt.status?.orphanCounts) === stableJson(findingCounts(receipt.spec.findings))
      && Object.values(receipt.status?.orphanCounts ?? {}).every((value) => value === 0),
    "orphan audit receipt finding counters are stale or nonzero",
  );
  check(receipt.status?.retainedReleaseHistoryProvedByTags === true, "orphan audit receipt no longer preserves release-N Tag history");
  console.log(`verified ${relativeRepo(RECEIPT_PATH)}: zero unexpected ConfigHub inventory, prunable Argo resources, unclassified/dangling durable workloads, and protected-namespace ownership`);
}

function selfTest(plan) {
  check(plan.spaces.size === 7, `self-test plan Space count drifted: ${plan.spaces.size}`);
  check(plan.units.size === 10, `self-test plan Unit count drifted: ${plan.units.size}`);
  check(plan.links.size === 2, `self-test plan Link count drifted: ${plan.links.size}`);
  check(plan.targets.size === 1, `self-test plan Target count drifted: ${plan.targets.size}`);
  check(stableJson([...plan.triggers.keys()]) === stableJson(EXPECTED_TRIGGERS.map((item) => item.ref)), "self-test Trigger allowlist drifted");
  check(stableJson([...plan.filters.keys()]) === stableJson(EXPECTED_FILTERS.map((item) => item.ref)), "self-test Filter allowlist drifted");
  check(plan.releaseStreams.size === 3, `self-test plan release stream count drifted: ${plan.releaseStreams.size}`);
  check(plan.catalogRetention.components === 103 && plan.catalogRetention.versions === 130 && plan.catalogRetention.selections === 18, "catalog retention contract drifted");
  check(publicAuditPlan(plan).spec.counts.expectedArgoApplications === 3, "delivery Application Units must be the sole Argo allowlist and count");
  check(
    publicAuditPlan(plan).spec.counts.triggers === EXPECTED_TRIGGERS.length
      && publicAuditPlan(plan).spec.counts.filters === EXPECTED_FILTERS.length,
    "public audit plan Trigger/Filter counts drifted",
  );
  assertOrganizationListCallBudget({ ...CONFIGHUB_LIST_CALLS_PER_BRACKET });
  expectFailure(
    () => assertOrganizationListCallBudget({ ...CONFIGHUB_LIST_CALLS_PER_BRACKET, unit: 2 }),
    /read budget drifted/,
    "N+1 Unit list budget",
  );
  assertQuiescentJournalDocument({
    convergence: {},
    protectedNamespaceDetachments: {
      "fixture/terminal": { state: "observed-detached" },
    },
    immutableSelectorReplacements: {
      "fixture/terminal": { state: "replacement-healthy" },
    },
  });
  for (const state of ["prepared", "patch-returned"]) {
    expectFailure(
      () => assertQuiescentJournalDocument({
        convergence: {},
        protectedNamespaceDetachments: {
          "fixture/in-flight": { state },
        },
      }),
      new RegExp(`protected Namespace detachment fixture/in-flight state ${state}`),
      `nested protected Namespace detachment ${state}`,
    );
  }
  for (const state of ["prepared", "delete-returned", "old-uid-gone"]) {
    expectFailure(
      () => assertQuiescentJournalDocument({
        convergence: {},
        immutableSelectorReplacements: {
          "fixture/in-flight": { state },
        },
      }),
      new RegExp(`immutable selector replacement fixture/in-flight state ${state}`),
      `nested immutable selector replacement ${state}`,
    );
  }

  const unitText = "apiVersion: v1\nkind: ConfigMap\n";
  const canonicalUnit = {
    ConfigData: unitText,
    DataHash: sha256(unitText),
  };
  check(decodeBulkUnitData(canonicalUnit, "self-test/unit") === unitText, "canonical bulk Unit configuration did not round-trip");
  const largeUnitText = `apiVersion: v1\nkind: ConfigMap\ndata:\n  payload: ${"x".repeat(512 * 1024)}\n`;
  const largeCanonicalUnit = {
    ConfigData: largeUnitText,
    DataHash: sha256(largeUnitText),
  };
  check(
    decodeBulkUnitData(largeCanonicalUnit, "self-test/large unit") === largeUnitText,
    "large canonical organization-wide Unit configuration did not round-trip",
  );
  expectFailure(
    () => decodeBulkUnitData({ ...canonicalUnit, ConfigData: undefined }, "self-test/unit"),
    /omitted its configuration/,
    "bulk Unit missing configuration",
  );
  expectFailure(
    () => decodeBulkUnitData({ ...canonicalUnit, DataHash: "0".repeat(64) }, "self-test/unit"),
    /DataHash does not match/,
    "bulk Unit hash mismatch",
  );
  const invalidUtf8 = Buffer.from([0xff]);
  expectFailure(
    () => decodeUnitConfigBytes(invalidUtf8, sha256(invalidUtf8), "self-test/unit"),
    /not valid UTF-8/,
    "bulk Unit invalid UTF-8",
  );
  check(
    stableJson(canonicalSnapshotRows([{ SpaceID: "b" }, { SpaceID: "a" }], ["SpaceID"]))
      === stableJson(canonicalSnapshotRows([{ SpaceID: "a" }, { SpaceID: "b" }], ["SpaceID"])),
    "ConfigHub snapshot fingerprint input depends on row order",
  );
  const fingerprintRows = Object.fromEntries(FULL_CONFIGHUB_FINGERPRINT_RESOURCES.map((resource) => [resource, [{ resource, value: "a" }]]));
  const coreFingerprint = configHubSnapshotFingerprint(fingerprintRows, CORE_CONFIGHUB_FINGERPRINT_RESOURCES);
  const fullFingerprint = configHubSnapshotFingerprint(fingerprintRows, FULL_CONFIGHUB_FINGERPRINT_RESOURCES);
  const triggerDriftRows = structuredClone(fingerprintRows);
  triggerDriftRows.trigger[0].value = "b";
  check(
    configHubSnapshotFingerprint(triggerDriftRows, CORE_CONFIGHUB_FINGERPRINT_RESOURCES) === coreFingerprint
      && configHubSnapshotFingerprint(triggerDriftRows, FULL_CONFIGHUB_FINGERPRINT_RESOURCES) !== fullFingerprint,
    "Trigger-only drift did not remain outside the reconciler-compatible five-resource fingerprint",
  );
  const unitDriftRows = structuredClone(fingerprintRows);
  unitDriftRows.unit[0].value = "b";
  check(
    configHubSnapshotFingerprint(unitDriftRows, CORE_CONFIGHUB_FINGERPRINT_RESOURCES) !== coreFingerprint
      && configHubSnapshotFingerprint(unitDriftRows, FULL_CONFIGHUB_FINGERPRINT_RESOURCES) !== fullFingerprint,
    "core ConfigHub drift did not change both the five- and eight-resource fingerprints",
  );
  const tagSpaceID = "11111111-1111-4111-8111-111111111111";
  const currentReleaseID = "22222222-2222-4222-8222-222222222222";
  const firstTagID = "33333333-3333-4333-8333-333333333333";
  const currentTagID = "44444444-4444-4444-8444-444444444444";
  const tagRows = [
    { OrganizationID: ORGANIZATION_ENTITY_ID, SpaceID: tagSpaceID, TagID: firstTagID, Slug: "release-1", CreatedAt: "2026-01-01T00:00:00Z" },
    { OrganizationID: ORGANIZATION_ENTITY_ID, SpaceID: tagSpaceID, TagID: currentTagID, Slug: "release-2", CreatedAt: "2026-01-02T00:00:00Z" },
  ];
  const releaseRows = [{ SpaceID: tagSpaceID, ReleaseID: currentReleaseID, TagID: currentTagID, ReleaseNum: 2 }];
  const tagFindings = [];
  const tagHistory = classifyReleaseTags(tagRows, releaseRows, new Map([[tagSpaceID, "fixture-space"]]), tagFindings);
  check(
    tagFindings.length === 0
      && tagHistory.retainedTagCount === 2
      && tagHistory.streams[0]?.contiguousFromOne === true
      && tagHistory.streams[0]?.exactCurrentTag === true,
    "complete additive release Tag history was not accepted",
  );
  const gapFindings = [];
  classifyReleaseTags([tagRows[1]], releaseRows, new Map([[tagSpaceID, "fixture-space"]]), gapFindings);
  check(
    gapFindings.some((finding) => finding.category === "releaseTagContractDrift"),
    "missing historical release Tag was not rejected",
  );
  const mismatchedTagFindings = [];
  classifyReleaseTags(tagRows, [{ ...releaseRows[0], TagID: firstTagID }], new Map([[tagSpaceID, "fixture-space"]]), mismatchedTagFindings);
  check(
    mismatchedTagFindings.some((finding) => finding.category === "releaseTagContractDrift")
      && mismatchedTagFindings.some((finding) => finding.category === "missingReleaseTag"),
    "current Release-to-Tag mismatch was not rejected",
  );
  const policyFindingCounts = findingCounts([
    { category: "unexpectedConfigHubTrigger" },
    { category: "missingConfigHubFilter" },
    { category: "duplicateConfigHubTrigger" },
    { category: "filterContractDrift" },
    { category: "orphanReleaseTag" },
    { category: "releaseTagContractDrift" },
  ]);
  check(
    policyFindingCounts.unexpectedConfigHubTriggers === 1
      && policyFindingCounts.missingConfigHubFilters === 1
      && policyFindingCounts.duplicateConfigHubTriggers === 1
      && policyFindingCounts.filterContractDrift === 1
      && policyFindingCounts.orphanReleaseTags === 1
      && policyFindingCounts.releaseTagContractDrift === 1,
    "Trigger/Filter/release-Tag finding counters drifted",
  );

  const currentSpace = [...plan.releaseStreams.keys()][0];
  const retainedSpace = [...plan.spaces.values()].find((space) => plan.allowedRetainedReleaseTypes.has(space.type) && !plan.releaseStreams.has(space.slug))?.slug;
  const invalidSpace = plan.clusters[0];
  const sha = `sha256:${"a".repeat(64)}`;
  const unitCountFor = (space) => [...plan.units.keys()].filter((ref) => ref.startsWith(`${space}/`)).length;
  const fixture = [
    { space: currentSpace, ReleaseID: "current-1", ReleaseNum: 2, UnitCount: unitCountFor(currentSpace), CreatedAt: "2026-01-02T00:00:00Z", Digest: sha, ManifestDigest: sha, published: true },
    { space: currentSpace, ReleaseID: "current-0", ReleaseNum: 1, UnitCount: unitCountFor(currentSpace), CreatedAt: "2026-01-01T00:00:00Z", Digest: sha, ManifestDigest: sha, published: true },
    { space: retainedSpace, ReleaseID: "catalog-1", ReleaseNum: 1, UnitCount: unitCountFor(retainedSpace), CreatedAt: "2026-01-01T00:00:00Z", Digest: sha, ManifestDigest: sha, published: true },
  ];
  for (const space of [...plan.releaseStreams.keys()].slice(1)) fixture.push({ space, ReleaseID: `active-${space}`, ReleaseNum: 1, UnitCount: unitCountFor(space), CreatedAt: "2026-01-01T00:00:00Z", Digest: sha, ManifestDigest: sha, published: true });
  const findings = [];
  const classified = classifyReleases(fixture, plan, findings);
  check(findings.length === 0, `historical/catalog release fixture should pass: ${stableJson(findings)}`);
  check(classified.activeCurrent.length === plan.releaseStreams.size, "active current release classification is incomplete");
  check(classified.historical.some((item) => item.releaseID === "current-0"), "older current-stream release was not retained as history");
  check(classified.retainedCatalogOrProof.some((item) => item.releaseID === "catalog-1"), "definition release was not retained as catalog/proof inventory");

  const incompleteFindings = [];
  classifyReleases(fixture.map((release) => (
    release.ReleaseID === "current-1" ? { ...release, UnitCount: 0 } : release
  )), plan, incompleteFindings);
  check(
    incompleteFindings.some((item) => item.category === "releaseUnitCountDrift"),
    "current Published release with an incomplete UnitCount was not rejected",
  );

  const invalidFindings = [];
  classifyReleases([...fixture, { space: invalidSpace, ReleaseID: "orphan", ReleaseNum: 1, UnitCount: 0, CreatedAt: "2026-01-01T00:00:00Z", Digest: sha, ManifestDigest: sha, published: true }], plan, invalidFindings);
  check(invalidFindings.some((item) => item.category === "orphanRelease"), "active release in a cluster target Space was not rejected");
  check(staleOwnershipAnnotations({ metadata: { annotations: { "argocd.argoproj.io/tracking-id": "stale" } } }).length === 1, "protected namespace tracking metadata was not detected");
  check(staleOwnershipAnnotations({ metadata: { labels: { "argocd.argoproj.io/instance": "chart-label" } } }).length === 0, "ordinary Kubara chart instance label was incorrectly treated as ownership");
  const prunable = [{ requiresPruning: true }, { requiresPruning: false }].filter((item) => item.requiresPruning === true);
  check(prunable.length === 1, "Argo requiresPruning fixture was not fail-closed");

  const desiredResources = new Map([
    ["apps/Deployment/demo/direct", { key: "apps/Deployment/demo/direct", applications: ["direct-app"] }],
    ["monitoring.coreos.com/Prometheus/monitoring/platform", { key: "monitoring.coreos.com/Prometheus/monitoring/platform", applications: ["monitoring-app"] }],
    ["batch/CronJob/jobs/report", { key: "batch/CronJob/jobs/report", applications: ["jobs-app"] }],
  ]);
  const durable = (apiVersion, kind, namespace, name, metadata = {}) => ({
    apiVersion,
    kind,
    metadata: { namespace, name, uid: `uid-${name}`, ...metadata },
  });
  const kindnetKey = "apps/DaemonSet/kube-system/kindnet";
  const fixtureBootstrap = new Map([[kindnetKey, BOOTSTRAP_DURABLE_WORKLOADS_BY_KEY.get(kindnetKey)]]);
  const acceptedDurableFindings = [];
  const liveOwnerUIDs = new Map([
    ["monitoring.coreos.com/Prometheus/monitoring/platform", "prometheus-uid"],
    ["batch/CronJob/jobs/report", "cronjob-uid"],
  ]);
  const acceptedDurableRows = classifyDurableWorkloads("cluster-a", [
    durable("apps/v1", "Deployment", "demo", "direct", { annotations: { [ARGO_TRACKING_ANNOTATION]: "direct-app:apps/Deployment:demo/direct" } }),
    durable("apps/v1", "DaemonSet", "kube-system", "kindnet"),
    durable("apps/v1", "StatefulSet", "monitoring", "prometheus-platform", {
      annotations: { [ARGO_TRACKING_ANNOTATION]: "monitoring-app:monitoring.coreos.com/Prometheus:monitoring/platform" },
      ownerReferences: [{ apiVersion: "monitoring.coreos.com/v1", kind: "Prometheus", name: "platform", uid: "prometheus-uid", controller: true }],
    }),
    durable("batch/v1", "Job", "jobs", "report-123", { ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "report", uid: "cronjob-uid", controller: true }] }),
  ], desiredResources, acceptedDurableFindings, fixtureBootstrap, liveOwnerUIDs);
  check(acceptedDurableFindings.length === 0, `valid durable-workload fixture should pass: ${stableJson(acceptedDurableFindings)}`);
  check(acceptedDurableRows.find((row) => row.name === "direct")?.classification === "argo-status-desired", "exact Application status workload was not classified as desired");
  check(acceptedDurableRows.find((row) => row.name === "kindnet")?.classification === "bootstrap-baseline", "exact kind bootstrap workload was not classified as baseline");
  check(acceptedDurableRows.find((row) => row.name === "prometheus-platform")?.classification === "generated-by-argo-desired-root", "operator-generated StatefulSet owner root was not recognized");
  check(acceptedDurableRows.find((row) => row.name === "prometheus-platform")?.inheritedTrackingFromDesiredOwner === true, "operator-copied tracking was not bound to its exact desired controller owner");
  check(acceptedDurableRows.find((row) => row.name === "report-123")?.classification === "generated-by-argo-desired-root", "CronJob-generated Job owner root was not recognized");

  const rejectedDurableFindings = [];
  const rejectedDurableRows = classifyDurableWorkloads("cluster-a", [
    durable("apps/v1", "Deployment", "demo", "dangling", {
      annotations: { [ARGO_TRACKING_ANNOTATION]: "old-app:apps/Deployment:demo/dangling" },
      ownerReferences: [{ apiVersion: "monitoring.coreos.com/v1", kind: "Prometheus", name: "platform", uid: "prometheus-uid", controller: true }],
    }),
    durable("batch/v1", "Job", "jobs", "manual-job"),
    durable("batch/v1", "Job", "jobs", "non-controller-owned", {
      ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "report", uid: "cronjob-uid", controller: false }],
    }),
  ], desiredResources, rejectedDurableFindings, fixtureBootstrap, liveOwnerUIDs);
  check(rejectedDurableRows.find((row) => row.name === "dangling")?.classification === "dangling-argo-tracking", "tracked-but-not-in-status workload was not rejected before owner classification");
  check(rejectedDurableRows.find((row) => row.name === "manual-job")?.classification === "unclassified", "unowned durable workload was not rejected");
  check(rejectedDurableRows.find((row) => row.name === "non-controller-owned")?.classification === "unclassified", "non-controller ownerReference was accepted as generated ownership");
  const rejectedDurableCounts = findingCounts(rejectedDurableFindings);
  check(rejectedDurableCounts.danglingTrackedDurableWorkloads === 1, "dangling durable workload counter drifted");
  check(rejectedDurableCounts.unclassifiedDurableWorkloads === 2, "unclassified durable workload counter drifted");

  const staleOwnerFindings = [];
  const staleOwnerRows = classifyDurableWorkloads("cluster-a", [
    durable("apps/v1", "StatefulSet", "monitoring", "prometheus-stale", {
      annotations: { [ARGO_TRACKING_ANNOTATION]: "monitoring-app:monitoring.coreos.com/Prometheus:monitoring/platform" },
      ownerReferences: [{ apiVersion: "monitoring.coreos.com/v1", kind: "Prometheus", name: "platform", uid: "recreated-owner-old-uid", controller: true }],
    }),
  ], desiredResources, staleOwnerFindings, fixtureBootstrap, liveOwnerUIDs);
  check(staleOwnerRows[0]?.classification === "dangling-argo-tracking", "workload owned by a recreated controller was not rejected");
  check(staleOwnerFindings.some((item) => item.category === "staleControllerOwnerUID"), "stale controller owner UID was not reported");

  const runtimeWorkloads = new Map();
  for (const expected of BOOTSTRAP_DURABLE_WORKLOADS.filter((item) => item.role === "argocd-runtime")) {
    runtimeWorkloads.set(resourceKey(expected), {
      apiVersion: "apps/v1",
      kind: expected.kind,
      metadata: { namespace: expected.namespace, name: expected.name },
      spec: { template: { spec: { containers: ARGO_CD_RUNTIME_CONTAINER_PAIRS
        .filter(([workload]) => workload === expected.name)
        .map(([, container]) => ({ name: container, image: ARGO_CD_RUNTIME_IMAGE })) } } },
    });
  }
  const runtimeFindings = [];
  validateArgoBootstrapRuntime("cluster-a", runtimeWorkloads, runtimeFindings);
  check(runtimeFindings.length === 0, `pinned Argo runtime fixture should pass: ${stableJson(runtimeFindings)}`);
  runtimeWorkloads.get("apps/Deployment/argocd/argocd-server").spec.template.spec.containers[0].image = "quay.io/argoproj/argocd:v0.0.0";
  validateArgoBootstrapRuntime("cluster-a", runtimeWorkloads, runtimeFindings);
  check(runtimeFindings.some((item) => item.category === "argoBootstrapRuntimeDrift"), "unpinned Argo runtime image was not rejected");

  testAuditLockSemantics();
  console.log("Kubara mini-IDP orphan audit self-test passed");
}
