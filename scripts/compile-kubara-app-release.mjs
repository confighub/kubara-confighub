#!/usr/bin/env node

// Compile a reusable, destination-bound application release hand-off after a
// Kubara platform import. This compiler performs no ConfigHub, registry, Argo,
// or cluster mutation. It makes the only accepted delivery authority explicit:
// an exact ConfigHub source-release ManifestDigest with Argo automation absent.

import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { check, readYaml, sha256, toYaml } from "./lib/proof-common.mjs";

const args = process.argv.slice(2);
const modes = args.filter((value) => ["--compile", "--verify", "--self-test"].includes(value));
if (args.includes("--help") || modes.length === 0) {
  usage();
  process.exit(args.includes("--help") ? 0 : 1);
}
check(modes.length === 1, "choose exactly one of --compile, --verify, or --self-test");
if (modes[0] === "--self-test") {
  selfTest();
  process.exit(0);
}
const requestPath = resolve(required("--request"));
const outputRoot = resolve(required("--output"));
const compiled = compile(readYaml(requestPath));
if (modes[0] === "--compile") {
  write(outputRoot, compiled);
  console.log(`compiled exact-digest Kubara application release ${compiled.plan.spec.releaseDigest} -> ${outputRoot}`);
} else {
  verify(outputRoot, compiled);
  console.log(`verified exact-digest Kubara application release ${compiled.plan.spec.releaseDigest} in ${outputRoot}`);
}

function compile(request) {
  validate(request);
  const targets = orderedTargetEntries(request.spec.targets);
  const applications = targets.map(([targetName, target]) => ({
    target: targetName,
    environment: target.environment,
    promoteFrom: target.promoteFrom,
    source: structuredClone(target.source),
    delivery: structuredClone(target.delivery),
    approval: structuredClone(target.approval),
    health: structuredClone(target.health),
    document: application(target, request.metadata.name, request.spec.destination.spaceReleaseOCIBase),
  }));
  const semantic = {
    application: request.metadata.name,
    source: request.spec.source,
    destination: request.spec.destination,
    targets: applications.map(({ document, ...row }) => ({ ...row, documentSHA256: `sha256:${sha256(`${toYaml(document)}\n`)}` })),
    promotion: request.spec.promotion,
    policy: request.spec.policy,
  };
  const releaseDigest = `sha256:${sha256(stable(semantic))}`;
  const plan = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraApplicationReleasePlan",
    metadata: { name: request.metadata.name },
    spec: {
      releaseDigest,
      source: request.spec.source,
      destination: request.spec.destination,
      targets: semantic.targets,
      promotion: request.spec.promotion,
      policy: request.spec.policy,
      orderedPhases: [
        "verify exact reviewed application source and source Unit heads",
        "satisfy every required approval against the exact Unit ID, head revision, and data hash",
        "publish each explicitly promoted ConfigHub source Space release",
        "observe and pin each exact source release ManifestDigest",
        "materialize each delivery Application with that digest and no automated sync",
        "publish each cluster-local apps-root release",
        "fence the live root Application to the exact apps-root release and submit it with Kubernetes identity compare-and-set",
        "observe the exact delivery Application materialized by that root release",
        "submit an explicit Argo sync operation for the same exact source digest with Kubernetes identity compare-and-set",
        "observe that exact digest, Synced, and the reviewed workload health contract",
      ],
      liveClaims: { configHubMutation: false, argoSync: false, clusterHealth: false },
    },
    status: { result: "compiled-offline" },
  };
  const applicationDocuments = new Map(applications.map((row) => [row.target, `${toYaml(row.document)}\n`]));
  const applicationText = [...applicationDocuments.values()].join("---\n");
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const journal = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraApplicationReleaseJournal",
    metadata: { name: request.metadata.name },
    spec: {
      releaseDigest,
      requestSHA256: `sha256:${sha256(stable(request))}`,
      recoveryAuthority: "exact-request-and-durable-prefix-only",
      steps: targets.flatMap(([targetName, target]) => [
        journalStep(`${targetName}:verify-source-head`, "read-only", {
          space: target.source.space,
          unit: target.source.unit,
          unitID: target.source.unitID,
          headRevisionNum: target.source.headRevisionNum,
          dataHash: target.source.dataHash,
          promoteFrom: target.promoteFrom,
        }),
        ...(target.approval.required ? [journalStep(`${targetName}:approve-exact-head`, "ConfigHub-write", {
          unitID: target.source.unitID,
          headRevisionNum: target.source.headRevisionNum,
          dataHash: target.source.dataHash,
          authority: target.approval.authority,
        })] : []),
        journalStep(`${targetName}:publish-source-release`, "ConfigHub-write", {
          space: target.source.space,
          bundleDigest: target.source.releaseBundleDigest,
          manifestDigest: target.source.releaseManifestDigest,
        }),
        journalStep(`${targetName}:materialize-no-auto-delivery`, "ConfigHub-write", {
          appsSpace: target.delivery.appsSpace,
          unit: target.delivery.unit,
          targetRef: target.delivery.targetRef,
          manifestDigest: target.source.releaseManifestDigest,
        }),
        journalStep(`${targetName}:publish-apps-root`, "ConfigHub-write", { appsSpace: target.delivery.appsSpace, rootApplication: target.delivery.rootApplication }),
        journalStep(`${targetName}:submit-exact-root-sync`, "cluster-write", {
          clusterContext: target.delivery.clusterContext,
          clusterIdentityUID: target.delivery.clusterIdentityUID,
          argoNamespace: target.delivery.argoNamespace,
          rootApplication: target.delivery.rootApplication,
          appsSpace: target.delivery.appsSpace,
        }),
        journalStep(`${targetName}:observe-delivery-materialized`, "read-only", {
          clusterContext: target.delivery.clusterContext,
          clusterIdentityUID: target.delivery.clusterIdentityUID,
          argoNamespace: target.delivery.argoNamespace,
          application: target.delivery.unit,
          manifestDigest: target.source.releaseManifestDigest,
        }),
        journalStep(`${targetName}:submit-exact-argo-sync`, "cluster-write", {
          clusterContext: target.delivery.clusterContext,
          clusterIdentityUID: target.delivery.clusterIdentityUID,
          argoNamespace: target.delivery.argoNamespace,
          targetRef: target.delivery.targetRef,
          manifestDigest: target.source.releaseManifestDigest,
        }),
        journalStep(`${targetName}:observe-convergence`, "read-only", {
          clusterContext: target.delivery.clusterContext,
          clusterIdentityUID: target.delivery.clusterIdentityUID,
          argoNamespace: target.delivery.argoNamespace,
          manifestDigest: target.source.releaseManifestDigest,
          contract: target.health.contract,
          evidenceRef: target.health.evidenceRef,
        }),
      ]),
      terminalAcceptance: "all-steps-completed-and-immediate-identical-rerun-zero-actions",
    },
    status: { state: "not-started", liveActionsRecorded: 0, liveAcceptanceClaimed: false },
  };
  const journalText = `${JSON.stringify(journal, null, 2)}\n`;
  const checksumsText = [
    ...[...applicationDocuments].map(([target, text]) => `${sha256(text)}  delivery-applications/${target}.yaml`),
    `${sha256(applicationText)}  delivery-applications.yaml`,
    `${sha256(journalText)}  operation-journal.json`,
    `${sha256(planText)}  release-plan.json`,
  ].sort().join("\n") + "\n";
  return { plan, planText, applicationText, applicationDocuments, journalText, checksumsText };
}

function application(target, name, spaceReleaseOCIBase) {
  const document = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: target.delivery.unit,
      namespace: target.delivery.argoNamespace,
      annotations: {
        "import.confighub.com/application-release": name,
        "import.confighub.com/source-unit-id": target.source.unitID,
        "import.confighub.com/source-head-revision": String(target.source.headRevisionNum),
        "import.confighub.com/source-data-hash": target.source.dataHash,
        "import.confighub.com/source-release-bundle-digest": target.source.releaseBundleDigest,
        "import.confighub.com/source-release-manifest-digest": target.source.releaseManifestDigest,
        "import.confighub.com/target-ref": target.delivery.targetRef,
      },
    },
    spec: {
      project: "default",
      source: {
        repoURL: `${spaceReleaseOCIBase}/${target.source.space}`,
        targetRevision: target.source.releaseManifestDigest,
        path: ".",
      },
      destination: { server: "https://kubernetes.default.svc", namespace: target.delivery.namespace },
      syncPolicy: {
        syncOptions: ["CreateNamespace=false", "PruneLast=true", "FailOnSharedResource=true", "RespectIgnoreDifferences=true", "ApplyOutOfSyncOnly=true"],
      },
    },
  };
  check(!Object.hasOwn(document.spec.syncPolicy, "automated"), "compiled application unexpectedly enabled automated sync");
  return document;
}

function orderedTargetEntries(targets) {
  const remaining = new Map(Object.entries(targets));
  const completed = new Set();
  const result = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, target]) => target.promoteFrom === null || completed.has(target.promoteFrom))
      .sort(([left], [right]) => left.localeCompare(right));
    check(ready.length > 0, "application promotion topology cannot be ordered");
    for (const [name, target] of ready) {
      result.push([name, target]);
      completed.add(name);
      remaining.delete(name);
    }
  }
  return result;
}

function validate(request) {
  check(request?.apiVersion === "import.confighub.com/v1alpha1" && request?.kind === "KubaraApplicationRelease", "application release apiVersion/kind is invalid");
  exactKeys(request, ["apiVersion", "kind", "metadata", "spec"], "application release");
  exactKeys(request.metadata, ["name"], "application release metadata");
  slug(request.metadata.name, "application release metadata.name");
  exactKeys(request.spec, ["source", "destination", "targets", "promotion", "policy"], "application release spec");
  exactKeys(request.spec.destination, ["organization", "context", "organizationExternalID", "organizationID", "serverURL", "spaceReleaseOCIBase"], "application destination");
  check(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(request.spec.destination.organization ?? ""), "application destination organization is invalid");
  slug(request.spec.destination.context, "application destination context");
  check(uuid(request.spec.destination.organizationExternalID) && uuid(request.spec.destination.organizationID), "application destination Organization IDs must be exact UUIDs");
  httpsOrigin(request.spec.destination.serverURL, "application destination serverURL");
  ociBase(request.spec.destination.spaceReleaseOCIBase, "application destination spaceReleaseOCIBase");
  exactKeys(request.spec.source, ["repository", "commit", "path", "treeSHA256", "credentialScanReportSHA256"], "application source");
  httpsGit(request.spec.source.repository, "application source repository");
  check(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.spec.source.commit ?? ""), "application source commit must be a full immutable object ID");
  check(safeRelative(request.spec.source.path), "application source path must be safe and relative");
  for (const key of ["treeSHA256", "credentialScanReportSHA256"]) digest(request.spec.source[key], `application source ${key}`);
  check(request.spec.targets && typeof request.spec.targets === "object" && !Array.isArray(request.spec.targets) && Object.keys(request.spec.targets).length > 0, "application release needs at least one target");
  for (const [name, target] of Object.entries(request.spec.targets)) {
    slug(name, `application target ${name}`);
    exactKeys(target, ["environment", "promoteFrom", "source", "delivery", "approval", "health"], `application target ${name}`);
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(target.environment ?? ""), `${name}: environment is invalid`);
    if (target.promoteFrom !== null) slug(target.promoteFrom, `${name}: promoteFrom`);
    exactKeys(target.source, ["space", "unit", "unitID", "headRevisionNum", "dataHash", "releaseBundleDigest", "releaseManifestDigest"], `${name}: source`);
    slug(target.source.space, `${name}: source space`);
    slug(target.source.unit, `${name}: source unit`);
    check(uuid(target.source.unitID), `${name}: source unitID must be exact`);
    check(Number.isSafeInteger(target.source.headRevisionNum) && target.source.headRevisionNum > 0, `${name}: source headRevisionNum must be positive`);
    check(/^[0-9a-f]{64}$/.test(target.source.dataHash ?? ""), `${name}: source dataHash must be exact`);
    digest(target.source.releaseBundleDigest, `${name}: source release bundle digest`);
    digest(target.source.releaseManifestDigest, `${name}: source release manifest digest`);
    exactKeys(target.delivery, ["appsSpace", "unit", "targetRef", "targetID", "namespace", "clusterContext", "clusterIdentityUID", "argoNamespace", "rootApplication"], `${name}: delivery`);
    for (const key of ["appsSpace", "unit", "namespace", "clusterContext", "argoNamespace", "rootApplication"]) slug(target.delivery[key], `${name}: delivery ${key}`);
    check(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/.test(target.delivery.targetRef ?? ""), `${name}: delivery targetRef must be space/target`);
    check(uuid(target.delivery.targetID), `${name}: delivery targetID must be exact`);
    check(uuid(target.delivery.clusterIdentityUID), `${name}: delivery clusterIdentityUID must be the exact kube-system Namespace UID`);
    exactKeys(target.approval, ["required", "authority"], `${name}: approval`);
    check(typeof target.approval.required === "boolean", `${name}: approval.required must be boolean`);
    check(target.approval.authority === "exact-unit-id-head-revision-and-data-hash", `${name}: approval authority is not exact`);
    exactKeys(target.health, ["contract", "evidenceRef"], `${name}: health`);
    check(target.health.contract === "argo-synced-and-healthy-exact-source-manifest", `${name}: health contract must be the executable exact-revision Argo contract`);
    check(/^evidence:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(target.health.evidenceRef ?? ""), `${name}: health evidenceRef is invalid`);
  }
  for (const [name, target] of Object.entries(request.spec.targets)) if (target.promoteFrom !== null) check(request.spec.targets[target.promoteFrom], `${name}: promoteFrom names an unknown target`);
  const deliveryRefs = Object.values(request.spec.targets).map((target) => `${target.delivery.appsSpace}/${target.delivery.unit}`);
  check(new Set(deliveryRefs).size === deliveryRefs.length, "application targets contain duplicate delivery Application identities");
  for (const name of Object.keys(request.spec.targets)) {
    const seen = new Set();
    let current = name;
    while (current !== null) {
      check(!seen.has(current), `${name}: promotion topology contains a cycle`);
      seen.add(current);
      current = request.spec.targets[current].promoteFrom;
    }
  }
  exactKeys(request.spec.promotion, ["mode", "departures", "rollback"], "application promotion");
  check(request.spec.promotion.mode === "explicit-reviewed-upgrade-unit", "application promotion mode must be explicit-reviewed-upgrade-unit");
  check(request.spec.promotion.departures === "preserve-reviewed-target-departures" && request.spec.promotion.rollback === "target-local-exact-revision", "application promotion departure/rollback policy differs");
  exactKeys(request.spec.policy, ["deliveryAuthority", "automatedSync", "mutableTagsAreAuthority", "applicationSetsAccepted", "targetFactsInSource"], "application release policy");
  check(request.spec.policy.deliveryAuthority === "exact-source-release-manifest-digest", "application deliveryAuthority must be exact-source-release-manifest-digest");
  check(request.spec.policy.automatedSync === false && request.spec.policy.mutableTagsAreAuthority === false && request.spec.policy.applicationSetsAccepted === false && request.spec.policy.targetFactsInSource === false, "application release policy re-enabled mutable or external authority");
}

function journalStep(id, effect, authority) {
  return { id, effect, authority, state: "pending", attempts: [], completionEvidenceSHA256: null };
}

function write(root, compiled) {
  ensureOutputRoot(root, true);
  const journalPath = join(root, "operation-journal.json");
  if (existsSync(journalPath)) {
    assertRegularFile(journalPath, "application operation journal");
    check(readFileSync(journalPath, "utf8") === compiled.journalText, "refusing to overwrite an advanced or foreign application operation journal");
  }
  writeSafe(join(root, "release-plan.json"), compiled.planText);
  writeSafe(join(root, "delivery-applications.yaml"), compiled.applicationText);
  const applicationRoot = join(root, "delivery-applications");
  ensureOutputRoot(applicationRoot, true);
  for (const [target, text] of compiled.applicationDocuments) writeSafe(join(applicationRoot, `${target}.yaml`), text);
  writeSafe(journalPath, compiled.journalText);
  writeSafe(join(root, "checksums.txt"), compiled.checksumsText);
}

function verify(root, compiled) {
  ensureOutputRoot(root);
  const expected = {
    "release-plan.json": compiled.planText,
    "delivery-applications.yaml": compiled.applicationText,
    "operation-journal.json": compiled.journalText,
    "checksums.txt": compiled.checksumsText,
  };
  for (const [target, text] of compiled.applicationDocuments) expected[`delivery-applications/${target}.yaml`] = text;
  for (const [name, text] of Object.entries(expected)) {
    assertRegularFile(join(root, name), name);
    check(readFileSync(join(root, name), "utf8") === text, `${name} is missing, stale, or changed`);
  }
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "kubara-app-release-self-test-"));
  try {
    const request = fixture();
    const compiled = compile(request);
    write(root, compiled);
    verify(root, compiled);
    const documents = compiled.applicationText.split("---\n").map((text) => readYamlText(text));
    check(documents.length === 2 && documents.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.spec.source.targetRevision) && !Object.hasOwn(row.spec.syncPolicy, "automated")), "self-test delivery Applications are not exact-digest/no-auto");
    check(documents.every((row) => row.spec.source.repoURL.startsWith(`${request.spec.destination.spaceReleaseOCIBase}/`)) && !compiled.applicationText.includes("oci.hub.confighub.com"), "self-test delivery Applications did not bind the reviewed non-production OCI origin");
    check(compiled.plan.spec.targets[0].source.unitID === request.spec.targets.dev.source.unitID
      && compiled.plan.spec.targets[0].source.headRevisionNum === request.spec.targets.dev.source.headRevisionNum
      && compiled.plan.spec.targets[0].source.dataHash === request.spec.targets.dev.source.dataHash
      && compiled.plan.spec.targets[1].promoteFrom === "dev"
      && compiled.plan.spec.targets[1].approval.required === true
      && compiled.plan.spec.targets[1].delivery.targetRef === request.spec.targets.prod.delivery.targetRef
      && compiled.plan.spec.targets[1].health.evidenceRef === request.spec.targets.prod.health.evidenceRef,
    "self-test release plan omitted exact per-target source, promotion, approval, delivery, or health authority");
    check(compiled.plan.spec.targets.map((row) => row.target).join(",") === "dev,prod", "self-test promotion topology was not ordered parent before child");
    check(JSON.parse(compiled.journalText).spec.steps.some((row) => row.id === "prod:approve-exact-head" && row.authority.unitID === request.spec.targets.prod.source.unitID), "self-test journal omitted exact production approval authority");
    const authorityMutations = [
      ["unit ID", (value) => { value.spec.targets.dev.source.unitID = "10000000-0000-4000-8000-000000000099"; }],
      ["head revision", (value) => { value.spec.targets.dev.source.headRevisionNum = 99; }],
      ["data hash", (value) => { value.spec.targets.dev.source.dataHash = "e".repeat(64); }],
      ["target ref", (value) => { value.spec.targets.dev.delivery.targetRef = "cluster-dev/alternate"; }],
      ["approval", (value) => { value.spec.targets.prod.approval.required = false; }],
      ["promotion parent", (value) => { value.spec.targets.prod.promoteFrom = null; }],
      ["health", (value) => { value.spec.targets.dev.health.evidenceRef = "evidence://apps/payments/dev-alternate"; }],
      ["Space-release OCI origin", (value) => { value.spec.destination.spaceReleaseOCIBase = "oci://oci.alternate.example.invalid/space"; }],
    ];
    for (const [label, mutate] of authorityMutations) {
      const changed = structuredClone(request);
      mutate(changed);
      check(compile(changed).plan.spec.releaseDigest !== compiled.plan.spec.releaseDigest, `self-test ${label} did not change releaseDigest`);
    }
    const unsafeRoot = join(root, "unsafe-output");
    mkdirSync(unsafeRoot);
    const untouched = join(root, "untouched.txt");
    writeFileSync(untouched, "unchanged\n");
    symlinkSync(untouched, join(unsafeRoot, "release-plan.json"));
    expectFailure(() => write(unsafeRoot, compiled), /symbolic link/, "output symlink refusal");
    check(readFileSync(untouched, "utf8") === "unchanged\n", "output symlink refusal modified its target");
    const mutable = structuredClone(request);
    mutable.spec.targets.dev.source.releaseManifestDigest = "latest";
    expectFailure(() => compile(mutable), /manifest digest/, "mutable release refusal");
    const automated = structuredClone(request);
    automated.spec.policy.automatedSync = true;
    expectFailure(() => compile(automated), /re-enabled mutable or external authority/, "automated sync refusal");
    console.log("Kubara application release self-test passed: exact source heads, explicit promotion topology, exact ManifestDigest Applications, no automated sync, and resumable journal contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixture() {
  const target = (index, environment, promoteFrom, approval) => ({
    environment,
    promoteFrom,
    source: {
      space: `payments-${environment.toLowerCase()}`,
      unit: "payments",
      unitID: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      headRevisionNum: index,
      dataHash: sha256(`payments:${environment}`),
      releaseBundleDigest: `sha256:${sha256(`bundle:${environment}`)}`,
      releaseManifestDigest: `sha256:${sha256(`manifest:${environment}`)}`,
    },
    delivery: {
      appsSpace: `cluster-${environment.toLowerCase()}-argo-apps`,
      unit: "payments",
      targetRef: `cluster-${environment.toLowerCase()}/target`,
      targetID: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      namespace: "payments",
      clusterContext: `cluster-${environment.toLowerCase()}`,
      clusterIdentityUID: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      argoNamespace: "argocd",
      rootApplication: "root",
    },
    approval: { required: approval, authority: "exact-unit-id-head-revision-and-data-hash" },
    health: { contract: "argo-synced-and-healthy-exact-source-manifest", evidenceRef: `evidence://apps/payments/${environment.toLowerCase()}` },
  });
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraApplicationRelease",
    metadata: { name: "payments" },
    spec: {
      destination: {
        organization: "Acme Kubara",
        context: "acme-kubara",
        organizationExternalID: "30000000-0000-4000-8000-000000000001",
        organizationID: "30000000-0000-4000-8000-000000000002",
        serverURL: "https://hub.nonprod.example.invalid",
        spaceReleaseOCIBase: "oci://oci.nonprod.example.invalid:5443/space",
      },
      source: {
        repository: "https://github.com/acme/payments.git",
        commit: "a".repeat(40),
        path: "deploy",
        treeSHA256: `sha256:${sha256("tree")}`,
        credentialScanReportSHA256: `sha256:${sha256("scan")}`,
      },
      targets: { dev: target(1, "Dev", null, false), prod: target(2, "Prod", "dev", true) },
      promotion: { mode: "explicit-reviewed-upgrade-unit", departures: "preserve-reviewed-target-departures", rollback: "target-local-exact-revision" },
      policy: { deliveryAuthority: "exact-source-release-manifest-digest", automatedSync: false, mutableTagsAreAuthority: false, applicationSetsAccepted: false, targetFactsInSource: false },
    },
  };
}

function readYamlText(text) {
  const root = mkdtempSync(join(tmpdir(), "kubara-app-yaml-"));
  try {
    const path = join(root, "document.yaml");
    writeFileSync(path, text);
    return readYaml(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function exactKeys(value, keys, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields differ from the contract`);
}
function ensureOutputRoot(root, create = false) { if (create) mkdirSync(root, { recursive: true }); check(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), `${root}: output must be a real directory, not a symbolic link`); }
function assertRegularFile(path, label) { check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${label} must be a real file, not a symbolic link`); }
function writeSafe(path, text) { if (existsSync(path)) check(!lstatSync(path).isSymbolicLink(), `${path}: refusing to replace a symbolic link`); writeFileSync(path, text); }
function slug(value, label) { check(/^[a-z0-9][a-z0-9.-]{0,62}$/.test(value ?? ""), `${label} must be a safe slug`); }
function digest(value, label) { check(/^sha256:[0-9a-f]{64}$/.test(value ?? ""), `${label} must be an exact sha256 digest`); }
function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? ""); }
function safeRelative(value) { return typeof value === "string" && value !== "" && !value.startsWith("/") && !value.split("/").some((part) => ["", ".", ".."].includes(part)); }
function httpsGit(value, label) { let url; try { url = new URL(value); } catch { check(false, `${label} is invalid`); } check(url.protocol === "https:" && !url.username && !url.password && url.pathname.endsWith(".git") && !url.search && !url.hash, `${label} must be credential-free HTTPS ending in .git`); }
function httpsOrigin(value, label) { let url; try { url = new URL(value); } catch { check(false, `${label} is invalid`); } check(url.protocol === "https:" && !url.username && !url.password && ["", "/"].includes(url.pathname) && !url.search && !url.hash, `${label} must be a credential-free HTTPS origin`); }
function ociBase(value, label) { let url; try { url = new URL(value); } catch { check(false, `${label} is invalid`); } check(url.protocol === "oci:" && !url.username && !url.password && url.pathname.length > 1 && !url.pathname.endsWith("/") && !url.search && !url.hash && !/[{@}]/.test(value) && !/[:@][^/]+$/.test(url.pathname), `${label} must be an untagged, undigested, credential-free OCI repository base`); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function expectFailure(fn, pattern, label) { let error = null; try { fn(); } catch (value) { error = value; } check(error && pattern.test(error.message), `${label} did not fail as expected`); }
function required(name) { const index = args.indexOf(name); check(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `${name} is required`); return args[index + 1]; }
function usage() { console.log("Usage: node scripts/compile-kubara-app-release.mjs --compile|--verify --request <release.yaml> --output <directory>\n       node scripts/compile-kubara-app-release.mjs --self-test"); }
