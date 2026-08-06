#!/usr/bin/env node
// Preserve the historical Kubara v0.12.0 conceptual-shape proof.
//
// This is deliberately narrower than the full platform demo. It records the
// committed Kubara contract as native AppConfig/YAML and labels the existing
// proof Spaces so the contract, definitions, instances, delivery machinery,
// clusters, and applications are queryable without guessing from slug names.
//
// Modes:
//   --plan            print the exact intended mapping (default; offline)
//   --apply           retired: fail before any ConfigHub access
//   --verify          retired: fail before any ConfigHub access
//   --receipt-verify  verify the committed receipt without a live login
//   --self-test       verify that both retired live modes fail closed
//
// The 53-Space plan and receipt remain immutable historical evidence. The
// current Kubara organization is owned by reconcile-kubara-mini-idp.mjs; this
// script must never read or mutate that live state.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  check,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256File,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--plan";
const MODES = new Set(["--plan", "--apply", "--verify", "--receipt-verify", "--self-test"]);
if (!MODES.has(mode)) {
  console.error(`Unknown mode ${mode}. Use one of: ${[...MODES].join(", ")}`);
  process.exit(2);
}

const RETIRED_LIVE_MODES = new Set(["--apply", "--verify"]);

function assertHistoricalModeIsSafe(selectedMode) {
  if (!RETIRED_LIVE_MODES.has(selectedMode)) return;
  throw new Error(
    `historical Kubara v0.12.0 mode ${selectedMode} is retired and cannot access ConfigHub; `
      + "this artifact is read-only. Use npm run kubara-mini-idp:plan, "
      + "npm run kubara-mini-idp:apply, and npm run kubara-mini-idp:verify "
      + "for the current v0.13.0 organization.",
  );
}

function verifyRetirementBoundary() {
  for (const retiredMode of RETIRED_LIVE_MODES) {
    let error = null;
    try {
      assertHistoricalModeIsSafe(retiredMode);
    } catch (caught) {
      error = caught;
    }
    check(
      error?.message.includes("historical Kubara v0.12.0")
        && error.message.includes("kubara-mini-idp"),
      `${retiredMode} did not fail with the historical retirement handoff`,
    );
  }
  for (const offlineMode of ["--plan", "--receipt-verify", "--self-test"]) {
    assertHistoricalModeIsSafe(offlineMode);
  }
  console.log("verified historical Kubara v0.12.0 live-mode retirement boundary");
}

if (mode === "--self-test") {
  verifyRetirementBoundary();
  process.exit(0);
}
try {
  assertHistoricalModeIsSafe(mode);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const ORGANIZATION = "Kubara";
const KUBARA_VERSION = "v0.12.0";
const EXAMPLE_COHORT = "kubara-v0.12.0";
const CONTRACT_SPACE = "hx-platform";
const CONTRACT_UNIT = "platform-contract";
const CONTRACT_TOOLCHAIN = "AppConfig/YAML";
const CONTRACT_PROVIDER = "None";
const catalogAlignmentPath = join(
  repoRoot,
  "examples",
  "kubara",
  "local-platform",
  "catalog-alignment.yaml",
);
const platformReceiptPath = join(
  repoRoot,
  "runs",
  "kubara-single-platform-proof",
  "receipt.yaml",
);
const contractPath = join(
  repoRoot,
  "examples",
  "kubara",
  "local-platform",
  "source",
  "config.yaml",
);
const receiptPath = join(
  repoRoot,
  "runs",
  "kubara-org-shape-proof",
  "receipt.yaml",
);
const contextArgs = process.env.CUB_CONTEXT
  ? ["--context", process.env.CUB_CONTEXT]
  : [];

const FLEET = [
  { suffix: "dev", environment: "Dev", cluster: "hx-app-dev" },
  { suffix: "staging", environment: "Staging", cluster: "hx-app-staging" },
  { suffix: "prod-a", environment: "Prod", cluster: "hx-app-prod-a" },
  { suffix: "prod-b", environment: "Prod", cluster: "hx-app-prod-b" },
];

const PLATFORM_SURFACES = [
  {
    prefix: "hx-cm",
    catalogIdentity: "helm:jetstack/cert-manager",
    kubaraComponent: "cert-manager",
    selectedVersion: "v1.21.0",
    observedVersion: "v1.21.0",
    targets: FLEET,
  },
  {
    prefix: "hx-traefik",
    catalogIdentity: "helm:traefik/traefik",
    kubaraComponent: "traefik",
    selectedVersion: "41.0.2",
    observedVersion: "41.0.2",
    targets: FLEET,
  },
  {
    prefix: "hx-metrics",
    catalogIdentity: "helm:metrics-server/metrics-server",
    kubaraComponent: "metrics-server",
    selectedVersion: "3.13.1",
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-homer",
    catalogIdentity: "kubara:homer-dashboard",
    kubaraComponent: "homer-dashboard",
    selectedVersion: "0.1.0",
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-kps-crds",
    catalogIdentity: "helm:prometheus-community/kube-prometheus-stack",
    kubaraComponent: "kube-prometheus-stack",
    selectedVersion: "87.15.1",
    observedVersion: "87.19.0",
    definitionRole: "LifecycleDefinition",
    instanceRole: "LifecycleInstance",
    part: "crds",
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-kps-main",
    catalogIdentity: "helm:prometheus-community/kube-prometheus-stack",
    kubaraComponent: "kube-prometheus-stack",
    selectedVersion: "87.15.1",
    observedVersion: "87.19.0",
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-eso",
    catalogIdentity: "helm:external-secrets/external-secrets",
    kubaraComponent: "external-secrets",
    selectedVersion: "2.7.0",
    observedVersion: "2.7.0",
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-eso-store",
    kubaraComponent: "external-secrets",
    definitionRole: "PrerequisiteDefinition",
    instanceRole: "PrerequisiteInstance",
    part: "cluster-secret-store",
    kubaraDerived: false,
    targets: FLEET.slice(0, 1),
  },
  {
    prefix: "hx-eso-grafana-es",
    kubaraComponent: "external-secrets",
    definitionRole: "WiringDefinition",
    instanceRole: "WiringInstance",
    part: "grafana-admin-credentials",
    kubaraDerived: false,
    targets: FLEET.slice(0, 1),
  },
];

const APPLICATIONS = ["hx-web", "hx-cubbychat"];
const PLATFORM_BINDINGS = ["hx-web-platform"];
const OWNED_SPACE_LABEL_KEYS = new Set([
  "ExampleCohort",
  "Cluster",
  "Environment",
  "Role",
  "KubaraVersion",
  "KubaraComponent",
  "ComponentVersion",
  "KubaraSelectedVersion",
  "ObservedComponentVersion",
  "Part",
  "Scope",
  "DefinitionScope",
]);
const OWNED_WHEN_PLANNED_LABEL_KEYS = new Set(["Component", "Layer"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cohortLabels(extra = {}) {
  return { ExampleCohort: EXAMPLE_COHORT, ...extra };
}

function definitionLabels(role, extra = {}) {
  return cohortLabels({ Scope: "Fleet", DefinitionScope: "Base", Role: role, ...extra });
}

function targetLabels(role, target, extra = {}) {
  return cohortLabels({
    Cluster: target.cluster,
    Environment: target.environment,
    Role: role,
    ...extra,
  });
}

function kubaraSurfaceLabels(surface) {
  if (surface.kubaraDerived === false) {
    return {
      KubaraComponent: surface.kubaraComponent,
      ...(surface.part ? { Part: surface.part } : {}),
    };
  }
  return {
    KubaraVersion: KUBARA_VERSION,
    KubaraComponent: surface.kubaraComponent,
    KubaraSelectedVersion: surface.selectedVersion,
    ...(surface.observedVersion
      ? { ObservedComponentVersion: surface.observedVersion }
      : {}),
    ...(surface.part ? { Part: surface.part } : {}),
  };
}

function verifyDeclaredVersions() {
  const alignment = readYaml(catalogAlignmentPath);
  const byIdentity = new Map(
    (alignment.spec?.components ?? []).map((component) => [component.canonicalIdentity, component]),
  );
  const platformReceipt = readYaml(platformReceiptPath);
  const observedByService = new Map(
    (platformReceipt.spec?.platform?.services ?? []).map((service) => [service.name, service.version]),
  );
  for (const surface of PLATFORM_SURFACES.filter((item) => item.kubaraDerived !== false)) {
    const mapping = byIdentity.get(surface.catalogIdentity);
    check(mapping, `${surface.prefix}: catalog alignment mapping is missing`);
    check(
      String(mapping.kubara?.selectedVersion) === surface.selectedVersion,
      `${surface.prefix}: selected version disagrees with ${relativeRepo(catalogAlignmentPath)}`,
    );
    if (surface.observedVersion) {
      const recorded = String(observedByService.get(surface.kubaraComponent) ?? "");
      check(
        recorded === surface.observedVersion || recorded.startsWith(`${surface.observedVersion} `),
        `${surface.prefix}: observed version disagrees with ${relativeRepo(platformReceiptPath)}`,
      );
    }
  }
}

function buildPlan() {
  verifyDeclaredVersions();
  const spaces = [
    {
      slug: CONTRACT_SPACE,
      labels: cohortLabels({
        Scope: "Fleet",
        Component: "platform-control",
        Layer: "Platform",
        Role: "PlatformControl",
      }),
    },
  ];

  for (const target of FLEET) {
    spaces.push({
      slug: target.cluster,
      labels: targetLabels("ClusterTarget", target, {
        Component: "cluster-target",
        Layer: "Platform",
      }),
    });
    spaces.push({
      slug: `${target.cluster}-argo-apps`,
      labels: targetLabels("DeliveryInstance", target, {
        Component: "argocd-delivery",
        Layer: "Platform",
      }),
    });
  }

  spaces.push({
    slug: "argobot-base",
    labels: definitionLabels("DeliveryDefinition", { Layer: "Platform" }),
  });
  for (const target of FLEET) {
    spaces.push({
      slug: `argobot-${target.cluster}`,
      labels: targetLabels("DeliveryInstance", target, { Layer: "Platform" }),
    });
  }

  for (const surface of PLATFORM_SURFACES) {
    const componentLabels = kubaraSurfaceLabels(surface);
    spaces.push({
      slug: `${surface.prefix}-base`,
      labels: definitionLabels(
        surface.definitionRole ?? "ComponentDefinition",
        componentLabels,
      ),
    });
    for (const target of surface.targets) {
      spaces.push({
        slug: `${surface.prefix}-${target.suffix}`,
        labels: targetLabels(
          surface.instanceRole ?? "ComponentInstance",
          target,
          componentLabels,
        ),
      });
    }
  }

  for (const prefix of APPLICATIONS) {
    spaces.push({
      slug: `${prefix}-base`,
      labels: definitionLabels("ApplicationDefinition"),
    });
    for (const target of FLEET) {
      spaces.push({
        slug: `${prefix}-${target.suffix}`,
        labels: targetLabels("ApplicationInstance", target),
      });
    }
  }

  for (const prefix of PLATFORM_BINDINGS) {
    spaces.push({
      slug: `${prefix}-base`,
      labels: definitionLabels("PlatformBindingDefinition"),
    });
    for (const target of FLEET) {
      spaces.push({
        slug: `${prefix}-${target.suffix}`,
        labels: targetLabels("PlatformBindingInstance", target),
      });
    }
  }

  spaces.sort((left, right) => left.slug.localeCompare(right.slug));
  check(spaces.length === 53, `internal plan error: expected 53 Spaces, got ${spaces.length}`);
  check(
    new Set(spaces.map((space) => space.slug)).size === spaces.length,
    "internal plan error: duplicate Space slug",
  );
  return spaces;
}

const plan = buildPlan();

function cub(args, options = {}) {
  return execFileSync("cub", [...contextArgs, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CONFIGHUB_AGENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
    ...options,
  });
}

function cubJson(args) {
  return JSON.parse(cub([...args, "-o", "json"]));
}

function assertOrg() {
  const context = cub(["context", "get"]);
  if (!/^Organization Name\s+Kubara\s*$/m.test(context)) {
    throw new Error(
      `refusing to run: active cub context is not the '${ORGANIZATION}' organization`,
    );
  }
}

function readSpaces() {
  const rows = cubJson(["space", "list"]);
  return new Map(rows.map((row) => [row.Space.Slug, row.Space]));
}

function readContractUnit() {
  const rows = cubJson([
    "unit",
    "list",
    "--space",
    CONTRACT_SPACE,
    "--where",
    `Slug = '${CONTRACT_UNIT}'`,
  ]);
  if (rows.length === 0) return null;
  check(rows.length === 1, `found ${rows.length} ${CONTRACT_UNIT} Units`);
  return rows[0].Unit;
}

function normalized(text) {
  return `${text.trimEnd()}\n`;
}

function expectedContractLabels() {
  return {
    ExampleCohort: EXAMPLE_COHORT,
    KubaraVersion: KUBARA_VERSION,
    Role: "PlatformContract",
    SourceType: "Kubara",
  };
}

function expectedContractAnnotations() {
  return {
    "confighub.com/source-path": relativeRepo(contractPath),
    "confighub.com/source-sha256": `sha256:${sha256File(contractPath)}`,
  };
}

function labelArgs(expected) {
  return Object.entries(expected).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function annotationArgs(expected) {
  return Object.entries(expected).flatMap(([key, value]) => ["--annotation", `${key}=${value}`]);
}

function missingMetadata(actual, expected) {
  return Object.entries(expected).filter(([key, value]) => actual?.[key] !== value);
}

function unexpectedOwnedLabels(actual, expected) {
  const ownedKeys = [
    ...OWNED_SPACE_LABEL_KEYS,
    ...[...OWNED_WHEN_PLANNED_LABEL_KEYS].filter((key) => expected[key] !== undefined),
  ];
  return ownedKeys
    .filter((key) => actual?.[key] !== undefined && expected[key] === undefined)
    .map((key) => [key, actual[key]]);
}

function labelPatchArgs(actual, expected) {
  return [
    ...labelArgs(expected),
    ...unexpectedOwnedLabels(actual, expected)
      .flatMap(([key]) => ["--label", `${key}=-`]),
  ];
}

function sameRecord(actual, expected) {
  const byKey = ([left], [right]) => left.localeCompare(right);
  const actualEntries = Object.entries(actual ?? {}).sort(byKey);
  const expectedEntries = Object.entries(expected ?? {}).sort(byKey);
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function preflightSpaces(spaces) {
  const missing = plan.filter((entry) => !spaces.has(entry.slug)).map((entry) => entry.slug);
  check(missing.length === 0, `refusing to write: missing planned Spaces: ${missing.join(", ")}`);
}

function applyContract() {
  const expectedLabels = expectedContractLabels();
  const expectedAnnotations = expectedContractAnnotations();
  let unit = readContractUnit();

  if (!unit) {
    cub([
      "unit",
      "create",
      "--space",
      CONTRACT_SPACE,
      CONTRACT_UNIT,
      contractPath,
      "--toolchain",
      CONTRACT_TOOLCHAIN,
      "--provider",
      CONTRACT_PROVIDER,
      ...labelArgs(expectedLabels),
      ...annotationArgs(expectedAnnotations),
      "--change-desc",
      "Record the committed Kubara platform contract",
      "--quiet",
    ]);
    console.log(`created ${CONTRACT_SPACE}/${CONTRACT_UNIT}`);
    return;
  }

  check(
    unit.ToolchainType === CONTRACT_TOOLCHAIN,
    `${CONTRACT_SPACE}/${CONTRACT_UNIT} uses ${unit.ToolchainType}, expected ${CONTRACT_TOOLCHAIN}`,
  );
  const liveData = cub(["unit", "data", "--space", CONTRACT_SPACE, CONTRACT_UNIT]);
  const sourceData = readFileSync(contractPath, "utf8");
  if (normalized(liveData) !== normalized(sourceData)) {
    cub([
      "unit",
      "update",
      "--space",
      CONTRACT_SPACE,
      CONTRACT_UNIT,
      contractPath,
      "--provider",
      CONTRACT_PROVIDER,
      "--change-desc",
      "Refresh the Kubara platform contract from committed config.yaml",
      "--quiet",
    ]);
    console.log(`updated data for ${CONTRACT_SPACE}/${CONTRACT_UNIT}`);
  }

  unit = readContractUnit();
  if (
    missingMetadata(unit.Labels, expectedLabels).length > 0
    || missingMetadata(unit.Annotations, expectedAnnotations).length > 0
    || unit.ProviderType !== CONTRACT_PROVIDER
  ) {
    cub([
      "unit",
      "update",
      "--patch",
      "--space",
      CONTRACT_SPACE,
      CONTRACT_UNIT,
      "--provider",
      CONTRACT_PROVIDER,
      ...labelArgs(expectedLabels),
      ...annotationArgs(expectedAnnotations),
      "--change-desc",
      "Reconcile Kubara contract provenance",
      "--quiet",
    ]);
    console.log(`reconciled metadata for ${CONTRACT_SPACE}/${CONTRACT_UNIT}`);
  }
}

function applyLabels(spaces) {
  let changed = 0;
  for (const entry of plan) {
    const space = spaces.get(entry.slug);
    if (
      missingMetadata(space.Labels, entry.labels).length === 0
      && unexpectedOwnedLabels(space.Labels, entry.labels).length === 0
    ) continue;
    cub([
      "space",
      "update",
      "--patch",
      entry.slug,
      ...labelPatchArgs(space.Labels, entry.labels),
      "--quiet",
    ]);
    changed += 1;
    console.log(`labeled ${entry.slug}`);
  }
  console.log(`label sweep complete: ${changed} changed, ${plan.length - changed} already matched`);
}

function verifyLive({ quiet = false } = {}) {
  assertOrg();
  const spaces = readSpaces();
  const findings = [];
  for (const entry of plan) {
    const space = spaces.get(entry.slug);
    if (!space) {
      findings.push(`${entry.slug}: missing`);
      continue;
    }
    for (const [key, expected] of missingMetadata(space.Labels, entry.labels)) {
      findings.push(
        `${entry.slug}: ${key} is ${JSON.stringify(space.Labels?.[key])}, expected ${JSON.stringify(expected)}`,
      );
    }
    for (const [key, actual] of unexpectedOwnedLabels(space.Labels, entry.labels)) {
      findings.push(`${entry.slug}: stale owned label ${key}=${JSON.stringify(actual)}`);
    }
  }

  const unit = readContractUnit();
  if (!unit) {
    findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: missing`);
  } else {
    if (unit.ToolchainType !== CONTRACT_TOOLCHAIN) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: toolchain is ${unit.ToolchainType}`);
    }
    if (unit.ProviderType !== CONTRACT_PROVIDER) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: provider is ${unit.ProviderType}`);
    }
    if (unit.TargetID != null) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: target is ${unit.TargetID}, expected none`);
    }
    for (const [key, expected] of missingMetadata(unit.Labels, expectedContractLabels())) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: label ${key} is not ${expected}`);
    }
    for (const [key, expected] of missingMetadata(unit.Annotations, expectedContractAnnotations())) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: annotation ${key} is not ${expected}`);
    }
    const data = cub(["unit", "data", "--space", CONTRACT_SPACE, CONTRACT_UNIT]);
    if (normalized(data) !== normalized(readFileSync(contractPath, "utf8"))) {
      findings.push(`${CONTRACT_SPACE}/${CONTRACT_UNIT}: data differs from ${relativeRepo(contractPath)}`);
    }
  }

  check(findings.length === 0, `Kubara org-shape verification failed:\n- ${findings.join("\n- ")}`);
  if (!quiet) {
    console.log(
      `verified Kubara org shape: ${plan.length} Spaces and ${CONTRACT_SPACE}/${CONTRACT_UNIT}`,
    );
  }
  return { spaces, unit };
}

function recordReceipt(observation) {
  const spaceRows = plan.map((entry) => {
    const live = observation.spaces.get(entry.slug);
    return { slug: entry.slug, id: live.SpaceID, labels: entry.labels };
  });
  const unit = observation.unit;
  const organizationIDs = [...new Set(spaceRows.map((row) => observation.spaces.get(row.slug).OrganizationID))];
  check(organizationIDs.length === 1, "planned Spaces do not share one organization ID");

  writeYaml(receiptPath, {
    apiVersion: "confighub.com/v1alpha1",
    kind: "ConfigHubKubaraOrgShapeReceipt",
    metadata: { name: "kubara-org-shape" },
    spec: {
      organization: { name: ORGANIZATION, entityID: organizationIDs[0] },
      source: {
        kubaraVersion: KUBARA_VERSION,
        contractPath: relativeRepo(contractPath),
        contractSha256: `sha256:${sha256File(contractPath)}`,
        catalogAlignmentPath: relativeRepo(catalogAlignmentPath),
        catalogAlignmentSha256: `sha256:${sha256File(catalogAlignmentPath)}`,
        platformReceiptPath: relativeRepo(platformReceiptPath),
        platformReceiptSha256: `sha256:${sha256File(platformReceiptPath)}`,
      },
      contractUnit: {
        ref: `${CONTRACT_SPACE}/${CONTRACT_UNIT}`,
        id: unit.UnitID,
        toolchain: unit.ToolchainType,
        provider: unit.ProviderType,
        targetID: unit.TargetID ?? null,
        headRevisionNum: unit.HeadRevisionNum,
        dataHash: unit.DataHash,
        labels: expectedContractLabels(),
        annotations: expectedContractAnnotations(),
      },
      spaces: spaceRows,
    },
    status: {
      result: "pass",
      observedAt: new Date().toISOString(),
      limits: [
        "This receipt verifies the existing proof organization's conceptual labels and contract mirror; it does not reproduce the platform or its clusters.",
        "The four-cluster adapted lane is not generated from the one-cluster contract yet.",
        "ExampleCohort groups the proof; KubaraVersion is reserved for the contract and Kubara-derived component surfaces.",
        "KubaraSelectedVersion comes from the checked catalog alignment; ObservedComponentVersion appears only where the historical live-platform receipt records a version.",
        "Provider None and a null target prove the contract is not target-applied; this receipt does not inspect release membership.",
      ],
    },
  });
  console.log(`wrote ${relativeRepo(receiptPath)}`);
}

function verifyReceipt() {
  check(existsSync(receiptPath), `${relativeRepo(receiptPath)} is missing`);
  const receipt = readYaml(receiptPath);
  check(
    receipt.kind === "ConfigHubKubaraOrgShapeReceipt",
    "receipt kind is not ConfigHubKubaraOrgShapeReceipt",
  );
  check(receipt.spec?.organization?.name === ORGANIZATION, "receipt organization is not Kubara");
  check(
    UUID_PATTERN.test(receipt.spec?.organization?.entityID ?? ""),
    "receipt organization entity ID is missing",
  );
  check(receipt.spec?.source?.kubaraVersion === KUBARA_VERSION, "receipt Kubara version drifted");
  check(
    receipt.spec?.source?.contractPath === relativeRepo(contractPath),
    "receipt contract path drifted",
  );
  check(
    receipt.spec?.source?.contractSha256 === `sha256:${sha256File(contractPath)}`,
    "receipt contract digest is stale",
  );
  check(
    receipt.spec?.source?.catalogAlignmentPath === relativeRepo(catalogAlignmentPath)
      && receipt.spec?.source?.catalogAlignmentSha256 === `sha256:${sha256File(catalogAlignmentPath)}`,
    "receipt catalog alignment evidence is stale",
  );
  check(
    receipt.spec?.source?.platformReceiptPath === relativeRepo(platformReceiptPath)
      && receipt.spec?.source?.platformReceiptSha256 === `sha256:${sha256File(platformReceiptPath)}`,
    "receipt observed-version evidence is stale",
  );
  check(
    receipt.spec?.contractUnit?.toolchain === CONTRACT_TOOLCHAIN,
    "receipt contract toolchain drifted",
  );
  check(
    receipt.spec?.contractUnit?.provider === CONTRACT_PROVIDER,
    "receipt contract provider drifted",
  );
  check(receipt.spec?.contractUnit?.targetID === null, "receipt contract target must be null");
  check(
    receipt.spec?.contractUnit?.ref === `${CONTRACT_SPACE}/${CONTRACT_UNIT}`,
    "receipt contract Unit ref drifted",
  );
  check(
    Number(receipt.spec?.contractUnit?.headRevisionNum) > 0,
    "receipt contract head revision is missing",
  );
  check(
    receipt.spec?.contractUnit?.dataHash === sha256File(contractPath),
    "receipt contract data hash does not match the committed source",
  );
  check(
    sameRecord(receipt.spec?.contractUnit?.labels, expectedContractLabels()),
    "receipt contract labels drifted",
  );
  check(
    sameRecord(receipt.spec?.contractUnit?.annotations, expectedContractAnnotations()),
    "receipt contract annotations drifted",
  );
  check(UUID_PATTERN.test(receipt.spec?.contractUnit?.id ?? ""), "receipt contract Unit ID is missing");
  const rows = receipt.spec?.spaces ?? [];
  check(rows.length === plan.length, `receipt has ${rows.length} Spaces, expected ${plan.length}`);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  for (const entry of plan) {
    const row = bySlug.get(entry.slug);
    check(row, `receipt is missing ${entry.slug}`);
    check(UUID_PATTERN.test(row.id ?? ""), `${entry.slug} receipt ID is missing`);
    check(sameRecord(row.labels, entry.labels), `${entry.slug} receipt labels drifted`);
  }
  check(receipt.status?.result === "pass", "receipt status is not pass");
  check(
    Number.isFinite(Date.parse(receipt.status?.observedAt ?? "")),
    "receipt observation timestamp is invalid",
  );
  check((receipt.status?.limits ?? []).length >= 5, "receipt limits are incomplete");
  console.log(`verified ${relativeRepo(receiptPath)}: ${rows.length} Spaces and one contract Unit`);
}

if (mode === "--plan") {
  console.log(JSON.stringify({
    organization: ORGANIZATION,
    contract: {
      ref: `${CONTRACT_SPACE}/${CONTRACT_UNIT}`,
      source: relativeRepo(contractPath),
      toolchain: CONTRACT_TOOLCHAIN,
      provider: CONTRACT_PROVIDER,
      labels: expectedContractLabels(),
    },
    spaces: plan,
  }, null, 2));
} else if (mode === "--apply") {
  assertOrg();
  const spaces = readSpaces();
  preflightSpaces(spaces);
  applyContract();
  applyLabels(spaces);
  const observation = verifyLive({ quiet: true });
  recordReceipt(observation);
  verifyReceipt();
} else if (mode === "--verify") {
  verifyLive();
} else {
  verifyReceipt();
}
