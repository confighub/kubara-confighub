#!/usr/bin/env node

// Compile the operator-facing, resumable command contract that takes one
// portable Kubara package set into a user-selected ConfigHub Organization.
// This file deliberately does not execute the commands: Organization/cluster
// bootstrap and apply are live authorization boundaries. The durable journal
// makes their order, replay policy, and required evidence machine-readable.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { check, readYaml, sha256, toYaml } from "./lib/proof-common.mjs";

const acceptanceRequirements = [
  "exact-live-digests",
  "accepted-health",
  "immediate-zero-action-rerun",
  "exact-confighub-inventory",
  "zero-argo-prunable-resources",
  "zero-unclassified-or-dangling-five-durable-workload-types",
  "protected-namespace-uid-current-ownership",
];

const args = process.argv.slice(2);
const modes = args.filter((value) => ["--compile", "--verify", "--verify-journal", "--self-test"].includes(value));
if (args.includes("--help") || modes.length === 0) {
  usage();
  process.exit(args.includes("--help") ? 0 : 1);
}
check(modes.length === 1, "choose exactly one of --compile, --verify, --verify-journal, or --self-test");
if (modes[0] === "--self-test") {
  selfTest();
  process.exit(0);
}
const request = readYaml(resolve(required("--request")));
const root = resolve(required("--output"));
const compiled = compile(request);
if (modes[0] === "--compile") {
  write(root, compiled);
  console.log(`compiled selected-organization Kubara workflow ${compiled.plan.spec.workflowDigest} -> ${root}`);
} else if (modes[0] === "--verify") {
  verify(root, compiled);
  console.log(`verified selected-organization Kubara workflow ${compiled.plan.spec.workflowDigest} in ${root}`);
} else {
  verifyJournal(root, compiled);
  console.log(`verified selected-organization Kubara operation journal ${compiled.plan.spec.workflowDigest} in ${root}`);
}

function compile(request) {
  validate(request);
  const platform = request.spec.platform;
  const destination = request.spec.destination;
  const applicationRequests = bindApplicationRequests(request.spec.applications, destination);
  const firstApplyEvidence = joinPath(destination.boundOutput, "evidence/apply-first-receipt.json");
  const noopApplyEvidence = joinPath(destination.boundOutput, "evidence/apply-immediate-noop-receipt.json");
  const runtimeEvidence = destination.runtimeEvidence.flatMap((row) => ["--runtime-evidence", `${row.cluster}=${row.path}`]);
  const steps = [
    step("portable-compile", "offline-write", "replay-exact-idempotent", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--compile-portable", "--request", platform.portableRequest,
      "--checkout", platform.checkout, "--output", platform.portableOutput,
    ]), joinPath(platform.portableOutput, "portable-package-set.json")),
    step("portable-verify", "read-only", "replay-exact-idempotent", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--verify-portable", "--request", platform.portableRequest,
      "--checkout", platform.checkout, "--output", platform.portableOutput,
    ]), joinPath(platform.portableOutput, "portable-checksums.txt")),
    step("portable-publish", "OCI-additive-write", "reuse-exact-or-refuse-conflict", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--package-portable", "--request", platform.portableRequest,
      "--checkout", platform.checkout, "--output", platform.portableOutput,
    ]), joinPath(platform.portableOutput, "oci-publication-receipt.json")),
    step("select-organization", "ConfigHub-context-write", "replay-then-read-exact-coordinate", command("cub", ["auth", "switch", destination.organization]), destination.coordinateEvidence),
    ...request.spec.bootstrap.clusters.map((row) => row.mode === "existing" ?
      step(`bootstrap-${row.cluster}`, "read-only", "reobserve-exact-request-pinned-prerequisites", null, row.evidence) :
      step(`bootstrap-${row.cluster}`, "multi-system-create", "prepared-is-in-flight-inspect-before-any-replay", command("cub", ["--context", destination.context, "cluster", "up", "--name", row.cluster, "--space", row.space]), row.evidence)),
    step("inspect-destination", "read-only", "replay-exact-idempotent", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--inspect-destination", "--request", destination.requestTemplate,
      "--context", destination.context, "--credential-scan-report", destination.credentialScanReport,
      ...runtimeEvidence, "--output", destination.reviewedRequest,
    ]), destination.reviewedRequest),
    step("bind-portable-to-destination", "offline-write", "replay-only-before-journal-advances", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--bind", "--request", destination.reviewedRequest,
      "--checkout", platform.checkout, "--portable", platform.portableOutput, "--output", destination.boundOutput,
    ]), joinPath(destination.boundOutput, "portable-binding-receipt.json")),
    step("verify-bound-destination", "read-only", "replay-exact-idempotent", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--verify", "--request", destination.reviewedRequest,
      "--checkout", platform.checkout, "--output", destination.boundOutput,
    ]), joinPath(destination.boundOutput, "checksums.txt")),
    step("apply-first", "ConfigHub-additive-write", "resume-importer-with-exact-inputs", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--apply", "--request", destination.reviewedRequest,
      "--checkout", platform.checkout, "--output", destination.boundOutput, "--context", destination.context,
      "--target-facts", destination.targetFactAttestation, "--receipt-output", firstApplyEvidence,
    ]), firstApplyEvidence),
    step("apply-immediate-noop", "ConfigHub-additive-write", "same-command-must-record-zero-actions", command("node", [
      "scripts/import-kubara-git-revision.mjs", "--apply", "--request", destination.reviewedRequest,
      "--checkout", platform.checkout, "--output", destination.boundOutput, "--context", destination.context,
      "--target-facts", destination.targetFactAttestation, "--receipt-output", noopApplyEvidence,
    ]), noopApplyEvidence),
    ...request.spec.applications.flatMap((row) => [
      step(`app-${row.name}-compile`, "offline-write", "refuse-advanced-journal-overwrite", command("node", [
        "scripts/compile-kubara-app-release.mjs", "--compile", "--request", row.request, "--output", row.output,
      ]), joinPath(row.output, "checksums.txt")),
      step(`app-${row.name}-live-release`, "ConfigHub-and-cluster-write", "execute-resumable-exact-prefix-then-immediate-zero-action-audit", command("node", [
        "scripts/run-kubara-app-release.mjs", "--execute", "--request", row.request, "--output", row.output,
        "--acceptance-evidence", row.liveAcceptanceEvidence,
      ]), row.liveAcceptanceEvidence),
    ]),
    step("live-acceptance", "read-only", "reobserve-exact-digests-health-idempotence-and-declared-residue-scope", null, request.spec.acceptance.evidence),
  ];
  assertDistinctStepEvidencePaths(steps);
  const workflowSemantic = { request, applicationRequests, steps: steps.map(({ state: _state, attempts: _attempts, completionEvidenceSHA256: _evidence, ...row }) => row) };
  const workflowDigest = `sha256:${sha256(stable(workflowSemantic))}`;
  const plan = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraSelectedOrganizationImportPlan",
    metadata: { name: request.metadata.name },
    spec: {
      workflowDigest,
      organization: { name: destination.organization, context: destination.context },
      applicationRequests,
      steps: workflowSemantic.steps,
      boundaries: {
        portableCompilationBeforeOrganizationSelection: true,
        destinationBindingIncludedInPortableOCI: false,
        targetFactsAndSecretsIncludedInPortableOCI: false,
        organizationCreationImplicit: false,
        clusterBootstrapImplicit: false,
        commandRunnerImplementedHere: false,
        applicationCommandRunnerImplemented: true,
        liveAcceptanceRequired: true,
      },
    },
    status: { result: "compiled-offline", liveActionsClaimed: false },
  };
  const journal = {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraSelectedOrganizationImportJournal",
    metadata: { name: request.metadata.name },
    spec: {
      workflowDigest,
      requestSHA256: `sha256:${sha256(stable(request))}`,
      applicationRequests,
      recoveryAuthority: "exact-request-workflow-digest-and-durable-completed-prefix",
      steps,
      invariants: [
        "at most one prepared or running live-write step",
        "never replay a prepared multi-system-create without inspecting its exact evidence",
        "never change context, organization, Git commit, portable package set, target facts, or writer between apply-first and apply-immediate-noop",
        "mutable latest, automated sync, and ApplicationSets are not delivery authority",
        "completion requires exact live digests, accepted health, two-run idempotence, exact ConfigHub inventory, zero Argo-prunable resources, and zero unclassified or dangling objects in the declared five-durable-workload-type and protected-namespace scope; it is not a whole-cluster inventory claim",
      ],
    },
    status: { state: "not-started", completedPrefixLength: 0, liveActionsRecorded: 0, liveAcceptanceClaimed: false },
  };
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const journalText = `${JSON.stringify(journal, null, 2)}\n`;
  const checksumsText = `${sha256(journalText)}  operation-journal.json\n${sha256(planText)}  workflow-plan.json\n`;
  return { plan, planText, journalText, checksumsText };
}

function validate(request) {
  check(request?.apiVersion === "import.confighub.com/v1alpha1" && request?.kind === "KubaraSelectedOrganizationImport", "selected-organization workflow apiVersion/kind is invalid");
  exact(request, ["apiVersion", "kind", "metadata", "spec"], "workflow");
  exact(request.metadata, ["name"], "workflow metadata");
  slug(request.metadata.name, "workflow metadata.name");
  exact(request.spec, ["platform", "destination", "bootstrap", "applications", "acceptance"], "workflow spec");
  exact(request.spec.platform, ["portableRequest", "checkout", "portableOutput"], "workflow platform");
  const destination = request.spec.destination;
  exact(destination, ["organization", "context", "organizationExternalID", "organizationID", "serverURL", "spaceReleaseOCIBase", "requestTemplate", "reviewedRequest", "credentialScanReport", "runtimeEvidence", "boundOutput", "targetFactAttestation", "coordinateEvidence"], "workflow destination");
  check(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(destination.organization ?? ""), "workflow destination organization is invalid");
  slug(destination.context, "workflow destination context");
  uuid(destination.organizationExternalID, "workflow destination external Organization ID");
  uuid(destination.organizationID, "workflow destination Organization entity ID");
  httpsOrigin(destination.serverURL, "workflow destination serverURL");
  ociBase(destination.spaceReleaseOCIBase, "workflow destination spaceReleaseOCIBase");
  check(Array.isArray(destination.runtimeEvidence) && destination.runtimeEvidence.length > 0, "workflow needs runtime evidence for at least one cluster");
  for (const row of destination.runtimeEvidence) { exact(row, ["cluster", "path"], "runtime evidence"); slug(row.cluster, "runtime evidence cluster"); absolute(row.path, "runtime evidence path"); }
  exact(request.spec.bootstrap, ["policy", "clusters"], "workflow bootstrap");
  check(request.spec.bootstrap.policy === "explicit-existing-or-cub-cluster-up", "workflow bootstrap policy is invalid");
  check(Array.isArray(request.spec.bootstrap.clusters) && request.spec.bootstrap.clusters.length > 0, "workflow bootstrap clusters are missing");
  const runtimeClusters = new Set(destination.runtimeEvidence.map((row) => row.cluster));
  for (const row of request.spec.bootstrap.clusters) {
    exact(row, ["cluster", "space", "mode", "evidence"], "bootstrap cluster");
    slug(row.cluster, "bootstrap cluster name"); slug(row.space, "bootstrap Space"); absolute(row.evidence, "bootstrap evidence");
    check(["existing", "cub-cluster-up"].includes(row.mode), `${row.cluster}: bootstrap mode is invalid`);
    check(runtimeClusters.has(row.cluster), `${row.cluster}: bootstrap cluster lacks one runtime evidence binding`);
  }
  check(new Set(request.spec.bootstrap.clusters.map((row) => row.cluster)).size === request.spec.bootstrap.clusters.length, "workflow bootstrap clusters contain duplicates");
  check(runtimeClusters.size === destination.runtimeEvidence.length && runtimeClusters.size === request.spec.bootstrap.clusters.length, "bootstrap and runtime-evidence cluster inventories differ");
  check(Array.isArray(request.spec.applications), "workflow applications must be an array");
  for (const row of request.spec.applications) { exact(row, ["name", "request", "output", "liveAcceptanceEvidence"], "workflow application"); slug(row.name, "workflow application name"); absolute(row.request, "application request"); absolute(row.output, "application output"); absolute(row.liveAcceptanceEvidence, "application live evidence"); }
  exact(request.spec.acceptance, ["evidence", "requires"], "workflow acceptance");
  absolute(request.spec.acceptance.evidence, "workflow acceptance evidence");
  check(stable(request.spec.acceptance.requires) === stable(acceptanceRequirements), "workflow acceptance requirements differ");
  for (const [label, value] of Object.entries({ ...request.spec.platform, ...selectPaths(destination) })) absolute(value, label);
}

function bindApplicationRequests(applications, destination) {
  return applications.map((row) => {
    check(existsSync(row.request) && lstatSync(row.request).isFile() && !lstatSync(row.request).isSymbolicLink(), `${row.name}: application request must be an existing real file`);
    const bytes = readFileSync(row.request);
    const application = readYaml(row.request);
    check(application?.apiVersion === "import.confighub.com/v1alpha1" && application?.kind === "KubaraApplicationRelease" && application?.metadata?.name === row.name, `${row.name}: application request identity differs from the selected workflow row`);
    const appDestination = application.spec?.destination;
    check(appDestination
      && appDestination.organization === destination.organization
      && appDestination.context === destination.context
      && appDestination.organizationExternalID === destination.organizationExternalID
      && appDestination.organizationID === destination.organizationID
      && appDestination.serverURL === destination.serverURL
      && appDestination.spaceReleaseOCIBase === destination.spaceReleaseOCIBase,
    `${row.name}: application request destination differs from the selected Organization/server/context/OCI binding`);
    return { name: row.name, path: row.request, requestSHA256: `sha256:${sha256(bytes)}`, destination: { organization: destination.organization, context: destination.context, organizationExternalID: destination.organizationExternalID, organizationID: destination.organizationID, serverURL: destination.serverURL, spaceReleaseOCIBase: destination.spaceReleaseOCIBase } };
  });
}

function selectPaths(destination) {
  return {
    requestTemplate: destination.requestTemplate,
    reviewedRequest: destination.reviewedRequest,
    credentialScanReport: destination.credentialScanReport,
    boundOutput: destination.boundOutput,
    targetFactAttestation: destination.targetFactAttestation,
    coordinateEvidence: destination.coordinateEvidence,
  };
}

function step(id, effect, replayPolicy, argv, evidencePath) {
  return { id, effect, replayPolicy, command: argv, evidencePath, state: "pending", attempts: [], completionEvidenceSHA256: null };
}
function command(executable, argv) { return { executable, argv, shell: false, credentialArgumentsAllowed: false }; }

function write(root, compiled) {
  ensureOutputRoot(root, true);
  const journal = join(root, "operation-journal.json");
  if (existsSync(journal)) {
    assertRegularFile(journal, "selected-organization operation journal");
    check(readFileSync(journal, "utf8") === compiled.journalText, "refusing to overwrite an advanced or foreign selected-organization operation journal");
  }
  writeSafe(join(root, "workflow-plan.json"), compiled.planText);
  writeSafe(journal, compiled.journalText);
  writeSafe(join(root, "checksums.txt"), compiled.checksumsText);
}

function verify(root, compiled) {
  ensureOutputRoot(root);
  for (const name of ["workflow-plan.json", "operation-journal.json", "checksums.txt"]) assertRegularFile(join(root, name), name);
  check(readFileSync(join(root, "workflow-plan.json"), "utf8") === compiled.planText, "workflow-plan.json is missing, stale, or changed");
  check(readFileSync(join(root, "operation-journal.json"), "utf8") === compiled.journalText, "operation-journal.json is missing, advanced, or changed; use the journal verifier for a live run rather than recompiling it");
  check(readFileSync(join(root, "checksums.txt"), "utf8") === compiled.checksumsText, "checksums.txt is missing, stale, or changed");
}

function verifyJournal(root, compiled) {
  ensureOutputRoot(root);
  for (const name of ["workflow-plan.json", "operation-journal.json", "checksums.txt"]) assertRegularFile(join(root, name), name);
  check(readFileSync(join(root, "workflow-plan.json"), "utf8") === compiled.planText, "workflow-plan.json is missing, stale, or changed");
  check(readFileSync(join(root, "checksums.txt"), "utf8") === compiled.checksumsText, "checksums.txt no longer binds the pristine workflow contract");
  const actual = JSON.parse(readFileSync(join(root, "operation-journal.json"), "utf8"));
  const pristine = JSON.parse(compiled.journalText);
  exact(actual, ["apiVersion", "kind", "metadata", "spec", "status"], "operation journal");
  check(actual.apiVersion === pristine.apiVersion && actual.kind === pristine.kind && stable(actual.metadata) === stable(pristine.metadata), "operation journal identity differs from the workflow contract");
  check(actual.spec.workflowDigest === pristine.spec.workflowDigest && actual.spec.requestSHA256 === pristine.spec.requestSHA256 && stable(actual.spec.applicationRequests) === stable(pristine.spec.applicationRequests) && actual.spec.recoveryAuthority === pristine.spec.recoveryAuthority && stable(actual.spec.invariants) === stable(pristine.spec.invariants), "operation journal immutable authority differs");
  check(Array.isArray(actual.spec.steps) && actual.spec.steps.length === pristine.spec.steps.length, "operation journal step inventory differs");
  let completedPrefixLength = 0;
  let preparedCount = 0;
  const completedEvidencePaths = new Set();
  for (let index = 0; index < pristine.spec.steps.length; index += 1) {
    const expected = pristine.spec.steps[index];
    const row = actual.spec.steps[index];
    exact(row, ["id", "effect", "replayPolicy", "command", "evidencePath", "state", "attempts", "completionEvidenceSHA256"], `operation journal step ${index + 1}`);
    for (const key of ["id", "effect", "replayPolicy", "command", "evidencePath"]) check(stable(row[key]) === stable(expected[key]), `${row.id ?? index}: immutable step contract differs`);
    check(["pending", "prepared", "completed"].includes(row.state), `${row.id}: journal state is invalid`);
    check(Array.isArray(row.attempts), `${row.id}: attempts must be an array`);
    for (const [attemptIndex, attempt] of row.attempts.entries()) {
      exact(attempt, ["number", "state", "evidenceSHA256"], `${row.id} attempt ${attemptIndex + 1}`);
      check(attempt.number === attemptIndex + 1 && ["prepared", "completed"].includes(attempt.state), `${row.id}: attempt sequence/state is invalid`);
      if (attempt.state === "completed") check(/^sha256:[0-9a-f]{64}$/.test(attempt.evidenceSHA256 ?? ""), `${row.id}: completed attempt lacks exact evidence`);
      else check(attempt.evidenceSHA256 === null, `${row.id}: prepared attempt cannot claim completion evidence`);
    }
    if (row.state === "completed") {
      check(preparedCount === 0 && index === completedPrefixLength, `${row.id}: completed steps must form one exact prefix`);
      check(row.attempts.length > 0 && row.attempts.slice(0, -1).every((attempt) => attempt.state === "prepared") && row.attempts.at(-1)?.state === "completed", `${row.id}: completed step must have only prepared attempts before one terminal completed attempt`);
      check(/^sha256:[0-9a-f]{64}$/.test(row.completionEvidenceSHA256 ?? "") && row.completionEvidenceSHA256 === row.attempts.at(-1).evidenceSHA256, `${row.id}: completed step evidence differs from its final attempt`);
      const resolvedEvidencePath = resolve(row.evidencePath);
      check(!completedEvidencePaths.has(resolvedEvidencePath), `${row.id}: completed evidence path was already consumed by another step`);
      completedEvidencePaths.add(resolvedEvidencePath);
      check(row.completionEvidenceSHA256 === evidenceFileDigest(row.evidencePath, row.id), `${row.id}: completion evidence digest differs from the exact real evidence file`);
      completedPrefixLength += 1;
    } else if (row.state === "prepared") {
      check(index === completedPrefixLength && preparedCount === 0 && row.attempts.length > 0 && row.attempts.every((attempt) => attempt.state === "prepared") && row.completionEvidenceSHA256 === null, `${row.id}: only the next incomplete step may be prepared and it cannot contain a completed attempt`);
      preparedCount += 1;
    } else {
      check(index >= completedPrefixLength + preparedCount && row.attempts.length === 0 && row.completionEvidenceSHA256 === null, `${row.id}: pending step carries execution evidence`);
    }
  }
  exact(actual.status, ["state", "completedPrefixLength", "liveActionsRecorded", "liveAcceptanceClaimed"], "operation journal status");
  check(actual.status.completedPrefixLength === completedPrefixLength, "operation journal completedPrefixLength differs from its steps");
  const completedLiveWrites = actual.spec.steps.slice(0, completedPrefixLength).filter(isLiveWriteStep).length;
  check(actual.status.liveActionsRecorded === completedLiveWrites, "operation journal liveActionsRecorded differs from its completed live-write prefix");
  const complete = completedPrefixLength === actual.spec.steps.length;
  check(actual.status.liveAcceptanceClaimed === complete, "operation journal may claim live acceptance only after every step completes");
  check(actual.status.state === (complete ? "complete" : completedPrefixLength === 0 && preparedCount === 0 ? "not-started" : "running"), "operation journal aggregate state differs from its durable prefix");
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "kubara-selected-org-self-test-"));
  try {
    const request = fixture(root);
    const application = readYaml(resolve("examples/kubara/git-import/app-release.example.yaml"));
    application.spec.destination = {
      organization: request.spec.destination.organization,
      context: request.spec.destination.context,
      organizationExternalID: request.spec.destination.organizationExternalID,
      organizationID: request.spec.destination.organizationID,
      serverURL: request.spec.destination.serverURL,
      spaceReleaseOCIBase: request.spec.destination.spaceReleaseOCIBase,
    };
    writeFileSync(request.spec.applications[0].request, `${toYaml(application)}\n`);
    const compiled = compile(request);
    write(root, compiled);
    verify(root, compiled);
    check(compiled.plan.spec.applicationRequests[0].requestSHA256 === `sha256:${sha256(readFileSync(request.spec.applications[0].request))}`, "self-test application request bytes are not digest-bound");
    const steps = compiled.plan.spec.steps;
    check(steps.find((row) => row.id === "portable-compile").command.argv.includes("--compile-portable"), "self-test portable compile command is missing");
    check(steps.findIndex((row) => row.id === "portable-publish") < steps.findIndex((row) => row.id === "select-organization"), "self-test does not package before Organization selection");
    check(steps.find((row) => row.id === "bootstrap-dev").replayPolicy === "prepared-is-in-flight-inspect-before-any-replay", "self-test multi-system bootstrap replay policy is unsafe");
    check(steps.findIndex((row) => row.id === "bind-portable-to-destination") < steps.findIndex((row) => row.id === "verify-bound-destination")
      && steps.findIndex((row) => row.id === "verify-bound-destination") < steps.findIndex((row) => row.id === "apply-first"), "self-test omitted the destination-bound verify checkpoint before apply");
    check(steps.filter((row) => row.id.startsWith("apply-")).length === 2, "self-test lacks the immediate no-op apply pair");
    const applySteps = steps.filter((row) => row.id.startsWith("apply-"));
    check(applySteps[0].evidencePath !== applySteps[1].evidencePath
      && applySteps.every((row) => row.command.argv.includes("--receipt-output") && row.command.argv.at(-1) === row.evidencePath), "self-test apply steps do not preserve distinct immutable receipt evidence");
    const appLive = steps.find((row) => row.id === "app-payments-live-release");
    check(appLive.command?.executable === "node"
      && appLive.command.argv.includes("scripts/run-kubara-app-release.mjs")
      && appLive.command.argv.includes("--execute")
      && appLive.command.argv.at(-1) === appLive.evidencePath
      && compiled.plan.spec.boundaries.applicationCommandRunnerImplemented === true,
    "self-test application hand-off is still compile-only or lacks the executable resumable runner");
    const originalApplicationText = readFileSync(request.spec.applications[0].request, "utf8");
    const changedApplication = readYaml(request.spec.applications[0].request);
    changedApplication.spec.source.commit = "2222222222222222222222222222222222222222";
    writeFileSync(request.spec.applications[0].request, `${toYaml(changedApplication)}\n`);
    const changedApplicationCompiled = compile(request);
    check(changedApplicationCompiled.plan.spec.workflowDigest !== compiled.plan.spec.workflowDigest, "changed application request did not change selected-workflow authority");
    expectFailure(() => verify(root, changedApplicationCompiled), /workflow-plan\.json/, "changed application request verification refusal");
    writeFileSync(request.spec.applications[0].request, originalApplicationText);
    const wrongDestination = readYaml(request.spec.applications[0].request);
    wrongDestination.spec.destination.serverURL = "https://different.confighub.example";
    writeFileSync(request.spec.applications[0].request, `${toYaml(wrongDestination)}\n`);
    expectFailure(() => compile(request), /destination differs/, "application destination mismatch refusal");
    writeFileSync(request.spec.applications[0].request, originalApplicationText);
    const linkedApplication = join(root, "linked-payments-release.yaml");
    symlinkSync(request.spec.applications[0].request, linkedApplication);
    const symlinkRequest = structuredClone(request);
    symlinkRequest.spec.applications[0].request = linkedApplication;
    expectFailure(() => compile(symlinkRequest), /existing real file/, "application request symlink refusal");
    const duplicateEvidenceSteps = structuredClone(steps);
    duplicateEvidenceSteps[1].evidencePath = duplicateEvidenceSteps[0].evidencePath;
    expectFailure(() => assertDistinctStepEvidencePaths(duplicateEvidenceSteps), /duplicate evidence path/, "duplicate workflow evidence path refusal");
    const changed = JSON.parse(compiled.journalText);
    mkdirSync(dirname(changed.spec.steps[0].evidencePath), { recursive: true });
    writeFileSync(changed.spec.steps[0].evidencePath, "portable-compile-evidence\n");
    const evidence = evidenceFileDigest(changed.spec.steps[0].evidencePath, changed.spec.steps[0].id);
    changed.spec.steps[0].state = "completed";
    changed.spec.steps[0].attempts = [{ number: 1, state: "completed", evidenceSHA256: evidence }];
    changed.spec.steps[0].completionEvidenceSHA256 = evidence;
    changed.status.state = "running";
    changed.status.completedPrefixLength = 1;
    changed.status.liveActionsRecorded = changed.spec.steps.slice(0, 1).filter(isLiveWriteStep).length;
    writeFileSync(join(root, "operation-journal.json"), `${JSON.stringify(changed, null, 2)}\n`);
    expectFailure(() => write(root, compiled), /refusing to overwrite/, "advanced journal overwrite refusal");
    verifyJournal(root, compiled);
    const forged = structuredClone(changed);
    const next = forged.spec.steps[1];
    next.state = "completed";
    next.attempts = [{ number: 1, state: "completed", evidenceSHA256: `sha256:${"f".repeat(64)}` }];
    next.completionEvidenceSHA256 = next.attempts[0].evidenceSHA256;
    forged.status.completedPrefixLength = 2;
    forged.status.liveActionsRecorded = forged.spec.steps.slice(0, 2).filter(isLiveWriteStep).length;
    writeFileSync(join(root, "operation-journal.json"), `${JSON.stringify(forged, null, 2)}\n`);
    expectFailure(() => verifyJournal(root, compiled), /evidence file/, "fabricated evidence digest refusal");

    const complete = JSON.parse(compiled.journalText);
    for (const row of complete.spec.steps) {
      mkdirSync(dirname(row.evidencePath), { recursive: true });
      if (!existsSync(row.evidencePath)) writeFileSync(row.evidencePath, `evidence for ${row.evidencePath}\n`);
      const digest = evidenceFileDigest(row.evidencePath, row.id);
      row.state = "completed";
      row.attempts = [{ number: 1, state: "completed", evidenceSHA256: digest }];
      row.completionEvidenceSHA256 = digest;
    }
    complete.status = {
      state: "complete",
      completedPrefixLength: complete.spec.steps.length,
      liveActionsRecorded: complete.spec.steps.filter(isLiveWriteStep).length,
      liveAcceptanceClaimed: true,
    };
    writeFileSync(join(root, "operation-journal.json"), `${JSON.stringify(complete, null, 2)}\n`);
    verifyJournal(root, compiled);
    complete.status.liveActionsRecorded += 1;
    writeFileSync(join(root, "operation-journal.json"), `${JSON.stringify(complete, null, 2)}\n`);
    expectFailure(() => verifyJournal(root, compiled), /liveActionsRecorded differs/, "fabricated live action count refusal");

    const unsafeRoot = join(root, "unsafe-output");
    mkdirSync(unsafeRoot);
    const untouched = join(root, "untouched.txt");
    writeFileSync(untouched, "unchanged\n");
    symlinkSync(untouched, join(unsafeRoot, "workflow-plan.json"));
    expectFailure(() => write(unsafeRoot, compiled), /symbolic link/, "output symlink refusal");
    check(readFileSync(untouched, "utf8") === "unchanged\n", "output symlink refusal modified its target");
    console.log("Kubara selected-organization workflow self-test passed: portable-first split, explicit Organization/cluster bootstrap, safe replay policies, two-run import, app hand-off, and live acceptance boundary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixture(root = "/controlled/kubara") {
  const path = (name) => join(root, name);
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraSelectedOrganizationImport",
    metadata: { name: "acme-kubara" },
    spec: {
      platform: { portableRequest: path("portable-request.yaml"), checkout: path("checkout"), portableOutput: path("portable") },
      destination: {
        organization: "Acme Kubara", context: "acme-kubara",
        organizationExternalID: "30000000-0000-4000-8000-000000000001", organizationID: "30000000-0000-4000-8000-000000000002",
        serverURL: "https://hub.confighub.example", spaceReleaseOCIBase: "oci://oci.hub.confighub.example:443/space",
        requestTemplate: path("destination-template.yaml"), reviewedRequest: path("reviewed-request.yaml"),
        credentialScanReport: path("gitleaks.json"), runtimeEvidence: [{ cluster: "dev", path: path("dev-runtime.yaml") }],
        boundOutput: path("bound"), targetFactAttestation: path("target-facts.yaml"), coordinateEvidence: path("organization-coordinate.yaml"),
      },
      bootstrap: { policy: "explicit-existing-or-cub-cluster-up", clusters: [{ cluster: "dev", space: "acme-dev", mode: "cub-cluster-up", evidence: path("dev-bootstrap-receipt.yaml") }] },
      applications: [{ name: "payments", request: path("payments-release.yaml"), output: path("payments-release"), liveAcceptanceEvidence: path("payments-live.yaml") }],
      acceptance: { evidence: path("acceptance.yaml"), requires: acceptanceRequirements },
    },
  };
}

function exact(value, keys, label) { check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); check(stable(Object.keys(value).sort()) === stable([...keys].sort()), `${label} fields differ from the contract`); }
function assertDistinctStepEvidencePaths(steps) { const paths = new Set(); for (const row of steps) { const path = resolve(row.evidencePath); check(!paths.has(path), `${row.id}: duplicate evidence path ${path}`); paths.add(path); } }
function ensureOutputRoot(root, create = false) { if (create) mkdirSync(root, { recursive: true }); check(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), `${root}: output must be a real directory, not a symbolic link`); }
function assertRegularFile(path, label) { check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${label} must be a real file, not a symbolic link`); }
function writeSafe(path, text) { if (existsSync(path)) check(!lstatSync(path).isSymbolicLink(), `${path}: refusing to replace a symbolic link`); writeFileSync(path, text); }
function evidenceFileDigest(path, stepID) { check(existsSync(path), `${stepID}: evidence file does not exist: ${path}`); assertRegularFile(path, `${stepID} evidence file`); return `sha256:${sha256(readFileSync(path))}`; }
function isLiveWriteStep(row) { return !["read-only", "offline-write"].includes(row.effect); }
function slug(value, label) { check(/^[a-z0-9][a-z0-9.-]{0,62}$/.test(value ?? ""), `${label} must be a safe slug`); }
function uuid(value, label) { check(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? ""), `${label} must be an exact UUID`); }
function httpsOrigin(value, label) { let url; try { url = new URL(value); } catch { check(false, `${label} is invalid`); } check(url.protocol === "https:" && !url.username && !url.password && ["", "/"].includes(url.pathname) && !url.search && !url.hash, `${label} must be a credential-free HTTPS origin`); }
function ociBase(value, label) { let url; try { url = new URL(value); } catch { check(false, `${label} is invalid`); } check(url.protocol === "oci:" && !url.username && !url.password && url.pathname.length > 1 && !url.pathname.endsWith("/") && !url.search && !url.hash && !/[{@}]/.test(value) && !/[:@][^/]+$/.test(url.pathname), `${label} must be an untagged, undigested, credential-free OCI repository base`); }
function absolute(value, label) { check(typeof value === "string" && value.startsWith("/") && !/[\n\r\0]/.test(value), `${label} must be an absolute path without control characters`); }
function joinPath(root, child) { return `${root.replace(/\/+$/, "")}/${child}`; }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function expectFailure(fn, pattern, label) { let error = null; try { fn(); } catch (value) { error = value; } check(error && pattern.test(error.message), `${label} did not fail as expected`); }
function required(name) { const index = args.indexOf(name); check(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `${name} is required`); return args[index + 1]; }
function usage() { console.log("Usage: node scripts/compile-kubara-selected-org-workflow.mjs --compile|--verify|--verify-journal --request <workflow.yaml> --output <directory>\n       node scripts/compile-kubara-selected-org-workflow.mjs --self-test"); }
