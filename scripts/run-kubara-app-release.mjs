#!/usr/bin/env node

// Execute the destination-bound Kubara application release contract compiled
// by compile-kubara-app-release.mjs. Every live write is preceded by an exact
// ConfigHub coordinate read or a Kubernetes UID/resourceVersion compare-and-set.
// The journal is durable and prefix-resumable; every attempt has immutable
// evidence, and final acceptance requires an immediate zero-action audit.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { check, readYaml, sha256, toYaml } from "./lib/proof-common.mjs";

const canonicalCompilerCache = new Map();

const argv = process.argv.slice(2);
const modes = argv.filter((value) => ["--execute", "--verify-acceptance", "--self-test"].includes(value));
if (argv.includes("--help") || modes.length === 0) {
  usage();
  process.exit(argv.includes("--help") ? 0 : 1);
}
check(modes.length === 1, "choose exactly one of --execute, --verify-acceptance, or --self-test");
if (modes[0] === "--self-test") {
  selfTest();
  process.exit(0);
}

const requestPath = resolve(required("--request"));
const outputRoot = resolve(required("--output"));
const acceptancePath = resolve(required("--acceptance-evidence"));
const request = readYaml(requestPath);
const state = loadState({ request, outputRoot });
if (modes[0] === "--verify-acceptance") {
  verifyAcceptance({ request, outputRoot, acceptancePath, state });
  console.log(`verified Kubara application release acceptance ${state.plan.spec.releaseDigest}`);
} else {
  const result = execute({ request, outputRoot, acceptancePath, state });
  console.log(result.message);
  if (!result.complete) process.exit(2);
}

function execute(options) {
  const { outputRoot, state } = options;
  const releaseLock = acquireExecutionLock(outputRoot, state.plan.spec.releaseDigest);
  try { return executeUnlocked(options); } finally { releaseExecutionLock(releaseLock); }
}

function executeUnlocked({ request, outputRoot, acceptancePath, state, client = null }) {
  const live = client ?? createLiveClient(request);
  live.assertExactCoordinate();
  const run = {
    run: (state.journal.status.runs?.length ?? 0) + 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    actionCount: 0,
    result: "running",
  };
  state.journal.status.runs ??= [];
  const startIndex = completedPrefixLength(state.journal.spec.steps);
  for (let index = startIndex; index < state.journal.spec.steps.length; index += 1) {
    const step = state.journal.spec.steps[index];
    const targetName = step.id.split(":", 1)[0];
    const target = request.spec.targets[targetName];
    check(target, `${step.id}: target is missing from the exact request`);
    let attempt = step.state === "prepared" ? step.attempts.at(-1) : null;
    const resumedPreparedAttempt = Boolean(attempt);
    if (attempt) {
      check(attempt.state === "prepared" && attempt.completedAt === null && attempt.evidenceSHA256 === null && attempt.result === null, `${step.id}: resumable prepared attempt is invalid`);
    } else {
      const attemptNumber = step.attempts.length + 1;
      attempt = {
        number: attemptNumber,
        state: "prepared",
        preparedAt: new Date().toISOString(),
        completedAt: null,
        evidence: relativeEvidencePath(step.id, attemptNumber),
        evidenceSHA256: null,
        actionCount: 0,
        result: null,
      };
      step.state = "prepared";
      step.attempts.push(attempt);
    }
    const attemptNumber = attempt.number;
    state.journal.status.state = `executing:${step.id}`;
    persistJournal(outputRoot, state.journal);

    const preparedEvidencePath = join(outputRoot, attempt.evidence);
    if (resumedPreparedAttempt && existsSync(preparedEvidencePath)) {
      const evidenceText = readRegular(preparedEvidencePath, `${step.id} prepared-attempt evidence`);
      const evidence = JSON.parse(evidenceText);
      const adoptedAttempt = {
        ...attempt,
        state: "completed",
        completedAt: new Date().toISOString(),
        evidenceSHA256: `sha256:${sha256(evidenceText)}`,
        actionCount: evidence.status?.actionCount,
        result: evidence.status?.result,
      };
      check(Number.isSafeInteger(adoptedAttempt.actionCount) && adoptedAttempt.actionCount >= 0 && ["pass", "pending"].includes(adoptedAttempt.result), `${step.id}: durable prepared-attempt evidence result/action fields are invalid`);
      validateStepEvidence(evidence, { request, plan: state.plan, step, attempt: adoptedAttempt });
      Object.assign(attempt, adoptedAttempt);
      run.actionCount += attempt.actionCount;
      if (attempt.result === "pending") {
        step.state = "pending";
        state.journal.status.state = `waiting:${step.id}`;
        state.journal.status.completedPrefixLength = index;
        state.journal.status.liveActionsRecorded = countJournalActions(state.journal);
        run.result = "pending";
        run.completedAt = new Date().toISOString();
        state.journal.status.runs.push(run);
        persistJournal(outputRoot, state.journal);
        return { complete: false, message: `Kubara application release recovered durable pending evidence at ${step.id}; rerun after the reconciler advances` };
      }
      step.state = "completed";
      step.completionEvidenceSHA256 = attempt.evidenceSHA256;
      state.journal.status.completedPrefixLength = index + 1;
      state.journal.status.liveActionsRecorded = countJournalActions(state.journal);
      persistJournal(outputRoot, state.journal);
      continue;
    }

    const outcome = executeStep({ step, targetName, target, request, state, live });
    const evidence = {
      apiVersion: "import.confighub.com/v1alpha1",
      kind: "KubaraApplicationReleaseStepEvidence",
      metadata: { name: safeName(`${request.metadata.name}-${step.id}-attempt-${attemptNumber}`) },
      spec: {
        releaseDigest: state.plan.spec.releaseDigest,
        step: step.id,
        attempt: attemptNumber,
        authority: step.authority,
        coordinate: exactCoordinate(request.spec.destination),
      },
      status: {
        result: outcome.complete ? "pass" : "pending",
        actionCount: outcome.actionCount,
        observation: outcome.observation,
        liveAcceptanceClaimed: false,
      },
    };
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    const evidencePath = join(outputRoot, attempt.evidence);
    writeImmutable(evidencePath, evidenceText);
    live.afterEvidenceWritten?.(step, evidence);
    attempt.completedAt = new Date().toISOString();
    attempt.state = "completed";
    attempt.evidenceSHA256 = `sha256:${sha256(evidenceText)}`;
    attempt.actionCount = outcome.actionCount;
    attempt.result = outcome.complete ? "pass" : "pending";
    run.actionCount += outcome.actionCount;
    if (!outcome.complete) {
      step.state = "pending";
      state.journal.status.state = `waiting:${step.id}`;
      state.journal.status.completedPrefixLength = index;
      state.journal.status.liveActionsRecorded = countJournalActions(state.journal);
      run.result = "pending";
      run.completedAt = new Date().toISOString();
      state.journal.status.runs.push(run);
      persistJournal(outputRoot, state.journal);
      return { complete: false, message: `Kubara application release is waiting at ${step.id}; rerun the same command after the reconciler advances` };
    }
    step.state = "completed";
    step.completionEvidenceSHA256 = attempt.evidenceSHA256;
    state.journal.status.completedPrefixLength = index + 1;
    state.journal.status.liveActionsRecorded = countJournalActions(state.journal);
    persistJournal(outputRoot, state.journal);
  }

  run.result = "pass";
  run.completedAt = new Date().toISOString();
  state.journal.status.runs.push(run);
  state.journal.status.state = "auditing-immediate-noop-rerun";
  persistJournal(outputRoot, state.journal);

  // This is the second, immediate reconciliation pass. It is intentionally
  // read-only and must prove that the exact state needs zero further actions.
  const auditMetricsBefore = live.mutationMetrics();
  const audit = auditAll({ request, state, live });
  const auditMetricsAfter = live.mutationMetrics();
  const auditMutationAttempts = auditMetricsAfter.attempts - auditMetricsBefore.attempts;
  const auditActionCount = auditMetricsAfter.actions - auditMetricsBefore.actions;
  check(auditMutationAttempts === 0 && auditActionCount === 0, "immediate audit attempted or completed a mutation; zero-action acceptance is forbidden");
  audit.mutationAttemptCount = auditMutationAttempts;
  audit.actionCount = auditActionCount;
  const auditRun = {
    run: state.journal.status.runs.length + 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    mutationAttemptCount: auditMutationAttempts,
    actionCount: auditActionCount,
    result: "pass-immediate-noop",
  };
  state.journal.status.runs.push(auditRun);
  const acceptance = acceptanceDocument({ request, state, audit });
  const acceptanceText = `${JSON.stringify(acceptance, null, 2)}\n`;
  writeImmutable(acceptancePath, acceptanceText);
  state.journal.status.state = "accepted";
  state.journal.status.liveAcceptanceClaimed = true;
  state.journal.status.acceptanceEvidence = acceptancePath;
  state.journal.status.acceptanceEvidenceSHA256 = `sha256:${sha256(acceptanceText)}`;
  state.journal.status.completedPrefixLength = state.journal.spec.steps.length;
  persistJournal(outputRoot, state.journal);
  return { complete: true, message: `accepted Kubara application release ${state.plan.spec.releaseDigest}; immediate audit recorded zero actions` };
}

function acquireExecutionLock(outputRoot, releaseDigest) {
  const lockPath = join(outputRoot, ".application-release-execution.lock");
  const lock = { releaseDigest, pid: process.pid, startedAt: new Date().toISOString() };
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  if (existsSync(lockPath)) {
    const existingText = readRegular(lockPath, "application release execution lock");
    let existing;
    try { existing = JSON.parse(existingText); } catch { check(false, "application release execution lock is invalid JSON"); }
    check(existing?.releaseDigest === releaseDigest && Number.isSafeInteger(existing?.pid) && existing.pid > 0, "application release execution lock belongs to another or invalid release");
    let live = true;
    try { process.kill(existing.pid, 0); } catch (error) { if (error?.code === "ESRCH") live = false; else throw error; }
    check(!live, `application release execution lock is held by live pid ${existing.pid}`);
    const stalePath = join(outputRoot, "evidence", "application-release", `stale-execution-lock-${sha256(existingText)}.json`);
    ensureRealParent(dirname(stalePath));
    if (existsSync(stalePath)) check(readRegular(stalePath, "preserved stale execution lock") === existingText, "preserved stale execution lock differs");
    else renameSync(lockPath, stalePath);
    if (existsSync(lockPath)) rmSync(lockPath);
  }
  writeFileSync(lockPath, text, { flag: "wx", mode: 0o600 });
  return { path: lockPath, text };
}

function releaseExecutionLock(lock) {
  check(existsSync(lock.path), "application release execution lock disappeared while held");
  check(readRegular(lock.path, "application release execution lock") === lock.text, "application release execution lock changed while held");
  rmSync(lock.path);
}

function executeStep({ step, targetName, target, request, state, live }) {
  if (step.id.endsWith(":verify-source-head")) {
    return complete(observeExactSource(live, targetName, target));
  }
  if (step.id.endsWith(":approve-exact-head")) {
    const before = observeExactSource(live, targetName, target);
    let actions = 0;
    if (before.hasApprovalGate) {
      live.approve(target.source.space, target.source.unit, before);
      actions = 1;
    }
    const after = observeExactSource(live, targetName, target);
    check(!after.hasApprovalGate && after.approvedByCount > 0, `${targetName}: exact source head is unapproved or its required approval gate remains`);
    check(after.approvedByCount === before.approvedByCount + actions, `${targetName}: exact-head approval count did not advance exactly once`);
    return complete({ approvalCountBefore: before.approvedByCount, approvalCountAfter: after.approvedByCount, approvalGateBefore: before.hasApprovalGate, approvalGateAfter: after.hasApprovalGate, unitID: after.unitID, headRevisionNum: after.headRevisionNum, dataHash: after.dataHash }, actions);
  }
  if (step.id.endsWith(":publish-source-release")) {
    observeExactSource(live, targetName, target);
    let latest = latestRelease(live.listPublishedReleases(target.source.space));
    let actions = 0;
    if (!releaseMatches(latest, target.source)) {
      const unit = live.getUnit(target.source.space, target.source.unit);
      check(Number(unit.HeadRevisionNum) !== Number(unit.LastReleasedRevisionNum), `${targetName}: latest release differs from the request but the exact source head is already published; refusing stale authority`);
      live.publish(target.source.space);
      actions = 1;
      const afterPublish = observeExactSource(live, targetName, target);
      check(afterPublish.headRevisionNum === afterPublish.lastAppliedRevisionNum, `${targetName}: exact source head remains unpublished after source release publication`);
      latest = latestRelease(live.listPublishedReleases(target.source.space));
    }
    check(releaseMatches(latest, target.source), `${targetName}: published source release differs from the request-pinned bundle/manifest digests`);
    return complete(releaseObservation(latest), actions);
  }
  if (step.id.endsWith(":materialize-no-auto-delivery")) {
    const source = latestRelease(live.listPublishedReleases(target.source.space));
    check(releaseMatches(source, target.source), `${targetName}: source release authority drifted before delivery materialization`);
    const targetEntity = live.getTarget(target.delivery.targetRef);
    check(targetEntity?.TargetID === target.delivery.targetID, `${targetName}: delivery Target ID differs from the exact request`);
    check(targetEntity.ProviderType === "OCI" && targetEntity.ToolchainType === "Any", `${targetName}: delivery Target provider/toolchain differs from the OCI contract`);
    const documentPath = join(state.outputRoot, "delivery-applications", `${targetName}.yaml`);
    const documentText = readRegular(documentPath, `${targetName} delivery Application`);
    let unit = live.getUnit(target.delivery.appsSpace, target.delivery.unit);
    let actions = 0;
    if (!unit) {
      live.createDelivery(target.delivery.appsSpace, target.delivery.unit, documentPath, target.delivery.targetRef);
      actions = 1;
    } else {
      check(unit.TargetID === target.delivery.targetID, `${targetName}: existing delivery Unit targets another entity`);
      check(unit.ToolchainType === "Kubernetes/YAML" && !unit.ProviderType, `${targetName}: existing delivery Unit toolchain/provider differs`);
      if (unit.DataHash !== sha256(documentText)) {
        assertRecognizedPriorDelivery(live.unitData(target.delivery.appsSpace, target.delivery.unit), request.metadata.name, target);
        live.updateDelivery(target.delivery.appsSpace, target.delivery.unit, documentPath);
        actions = 1;
      }
    }
    unit = live.getUnit(target.delivery.appsSpace, target.delivery.unit);
    check(unit?.TargetID === target.delivery.targetID && unit.DataHash === sha256(documentText), `${targetName}: delivery Unit read-back differs from the exact compiled Application`);
    return complete({ ref: `${target.delivery.appsSpace}/${target.delivery.unit}`, unitID: unit.UnitID, dataHash: unit.DataHash, targetID: unit.TargetID }, actions);
  }
  if (step.id.endsWith(":publish-apps-root")) {
    const delivery = live.getUnit(target.delivery.appsSpace, target.delivery.unit);
    check(delivery?.TargetID === target.delivery.targetID, `${targetName}: delivery Unit disappeared before apps-root publication`);
    const units = live.listUnits(target.delivery.appsSpace);
    const unrelatedPending = units.filter((row) => row.Slug !== target.delivery.unit && Number(row.HeadRevisionNum) !== Number(row.LastReleasedRevisionNum));
    check(unrelatedPending.length === 0, `${targetName}: refusing to publish unrelated pending apps-root Units: ${unrelatedPending.map((row) => row.Slug).join(", ")}`);
    let actions = 0;
    if (Number(delivery.HeadRevisionNum) !== Number(delivery.LastReleasedRevisionNum)) {
      live.publish(target.delivery.appsSpace);
      actions = 1;
    }
    const after = live.getUnit(target.delivery.appsSpace, target.delivery.unit);
    check(Number(after.HeadRevisionNum) === Number(after.LastReleasedRevisionNum), `${targetName}: delivery Unit head remains unpublished`);
    const rootRelease = latestRelease(live.listPublishedReleases(target.delivery.appsSpace));
    check(exactDigest(rootRelease?.ManifestDigest) && exactDigest(rootRelease?.Digest), `${targetName}: apps-root publication lacks exact release digests`);
    return complete(releaseObservation(rootRelease), actions);
  }
  if (step.id.endsWith(":submit-exact-root-sync")) {
    live.assertClusterIdentity(target.delivery.clusterContext, target.delivery.clusterIdentityUID);
    const rootRelease = priorRootRelease(state.journal, outputRootFor(state), targetName);
    assertLatestRootRelease(live, targetName, target, rootRelease);
    const root = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication);
    assertRootApplication(root, request, targetName, target);
    if (applicationAccepted(root, rootRelease.manifestDigest)) return complete(applicationObservation(root, rootRelease.manifestDigest));
    const active = activeOperationRevision(root);
    check(!active || active === rootRelease.manifestDigest, `${targetName}: root Application has an active operation for another revision`);
    let actions = 0;
    if (!active) {
      live.submitRootSync(target.delivery.clusterContext, target.delivery.clusterIdentityUID, target.delivery.argoNamespace, target.delivery.rootApplication, target.delivery.appsSpace, root, rootRelease);
      actions = 1;
    }
    assertLatestRootRelease(live, targetName, target, rootRelease);
    const after = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication);
    check(after?.spec?.source?.targetRevision === rootRelease.manifestDigest && !Object.hasOwn(after.spec?.syncPolicy ?? {}, "automated"), `${targetName}: root exact-revision/no-auto fence was not read back`);
    return complete(applicationObservation(after, rootRelease.manifestDigest), actions);
  }
  if (step.id.endsWith(":observe-delivery-materialized")) {
    live.assertClusterIdentity(target.delivery.clusterContext, target.delivery.clusterIdentityUID);
    const rootRelease = priorRootRelease(state.journal, outputRootFor(state), targetName);
    const root = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication);
    if (!applicationAccepted(root, rootRelease.manifestDigest)) return pending(applicationObservation(root, rootRelease.manifestDigest));
    const app = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit);
    if (!app) return pending({ application: target.delivery.unit, present: false, expectedRevision: target.source.releaseManifestDigest });
    assertDeliveryApplication(app, request, targetName, target);
    return complete(applicationObservation(app, target.source.releaseManifestDigest));
  }
  if (step.id.endsWith(":submit-exact-argo-sync")) {
    live.assertClusterIdentity(target.delivery.clusterContext, target.delivery.clusterIdentityUID);
    assertExactSourceReleaseAuthority(live, targetName, target);
    const app = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit);
    assertDeliveryApplication(app, request, targetName, target);
    if (applicationAccepted(app, target.source.releaseManifestDigest)) return complete(applicationObservation(app, target.source.releaseManifestDigest));
    const active = activeOperationRevision(app);
    check(!active || active === target.source.releaseManifestDigest, `${targetName}: workload Application has an active operation for another revision`);
    let actions = 0;
    if (!active) {
      live.submitApplicationSync(target.delivery.clusterContext, target.delivery.clusterIdentityUID, target.delivery.argoNamespace, target.delivery.unit, app, targetName, target);
      actions = 1;
    }
    assertExactSourceReleaseAuthority(live, targetName, target);
    const after = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit);
    return complete(applicationObservation(after, target.source.releaseManifestDigest), actions);
  }
  if (step.id.endsWith(":observe-convergence")) {
    live.assertClusterIdentity(target.delivery.clusterContext, target.delivery.clusterIdentityUID);
    const app = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit);
    assertDeliveryApplication(app, request, targetName, target);
    const observation = applicationObservation(app, target.source.releaseManifestDigest);
    return applicationAccepted(app, target.source.releaseManifestDigest) ? complete({ ...observation, healthContract: target.health.contract, evidenceRef: target.health.evidenceRef }) : pending(observation);
  }
  check(false, `${step.id}: unsupported application operation step`);
}

function auditAll({ request, state, live }) {
  live.assertExactCoordinate();
  const targets = [];
  for (const [targetName, target] of orderedTargets(request.spec.targets)) {
    const source = observeExactSource(live, targetName, target);
    const sourceUnit = live.getUnit(target.source.space, target.source.unit);
    if (target.approval.required) check(approvalCount(sourceUnit.ApprovedBy) > 0 && !hasApprovalGate(sourceUnit), `${targetName}: required exact-head approval is absent or its approval gate remains during immediate audit`);
    const release = latestRelease(live.listPublishedReleases(target.source.space));
    check(releaseMatches(release, target.source), `${targetName}: source release drifted during immediate audit`);
    const targetEntity = live.getTarget(target.delivery.targetRef);
    check(targetEntity?.TargetID === target.delivery.targetID && targetEntity.ProviderType === "OCI" && targetEntity.ToolchainType === "Any", `${targetName}: delivery Target identity/provider/toolchain drifted during immediate audit`);
    const delivery = live.getUnit(target.delivery.appsSpace, target.delivery.unit);
    const documentText = readRegular(join(state.outputRoot, "delivery-applications", `${targetName}.yaml`), `${targetName} delivery Application`);
    check(delivery?.DataHash === sha256(documentText) && delivery.TargetID === target.delivery.targetID && delivery.ToolchainType === "Kubernetes/YAML" && !delivery.ProviderType && Number(delivery.HeadRevisionNum) === Number(delivery.LastReleasedRevisionNum), `${targetName}: delivery Unit differs, has the wrong toolchain/provider, or is unpublished during immediate audit`);
    const appsRootUnits = live.listUnits(target.delivery.appsSpace);
    const pendingAppsRootUnits = appsRootUnits.filter((row) => Number(row.HeadRevisionNum) !== Number(row.LastReleasedRevisionNum));
    check(pendingAppsRootUnits.length === 0, `${targetName}: apps-root contains pending Unit heads during immediate audit: ${pendingAppsRootUnits.map((row) => row.Slug).join(", ")}`);
    const rootRelease = priorRootRelease(state.journal, state.outputRoot, targetName);
    const latestRoot = assertLatestRootRelease(live, targetName, target, rootRelease);
    live.assertClusterIdentity(target.delivery.clusterContext, target.delivery.clusterIdentityUID);
    const root = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication);
    assertRootApplication(root, request, targetName, target);
    check(applicationAccepted(root, rootRelease.manifestDigest), `${targetName}: root Application is not accepted during immediate audit`);
    const app = live.getApplication(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit);
    assertDeliveryApplication(app, request, targetName, target);
    check(applicationAccepted(app, target.source.releaseManifestDigest), `${targetName}: workload Application is not accepted during immediate audit`);
    targets.push({ target: targetName, source: { ...source, requiredApprovalPresent: !target.approval.required || approvalCount(sourceUnit.ApprovedBy) > 0 && !hasApprovalGate(sourceUnit) }, sourceRelease: releaseObservation(release), deliveryTarget: { ref: target.delivery.targetRef, targetID: targetEntity.TargetID, providerType: targetEntity.ProviderType, toolchainType: targetEntity.ToolchainType }, appsRoot: { unitCount: appsRootUnits.length, pendingUnitCount: pendingAppsRootUnits.length, latestRelease: releaseObservation(latestRoot) }, root: applicationObservation(root, rootRelease.manifestDigest), application: applicationObservation(app, target.source.releaseManifestDigest), healthContract: target.health.contract, evidenceRef: target.health.evidenceRef });
  }
  return { targets };
}

function assertLatestRootRelease(live, targetName, target, expected) {
  const latest = latestRelease(live.listPublishedReleases(target.delivery.appsSpace));
  check(latest && Number(latest.ReleaseNum) === Number(expected.releaseNum) && latest.Digest === expected.bundleDigest && latest.ManifestDigest === expected.manifestDigest, `${targetName}: latest apps-root release is newer than or differs from the journal-bound root release`);
  return latest;
}

function loadState({ request, outputRoot }) {
  assertDirectory(outputRoot, "application release output");
  const canonical = canonicalCompilerOutputs(request);
  const planText = readRegular(join(outputRoot, "release-plan.json"), "release plan");
  check(planText === canonical.planText, "release plan differs from canonical request-derived compiler output");
  check(readRegular(join(outputRoot, "delivery-applications.yaml"), "aggregate delivery Applications") === canonical.applicationText, "aggregate delivery Applications differ from canonical request-derived compiler output");
  check(readRegular(join(outputRoot, "checksums.txt"), "application compiler checksums") === canonical.checksumsText, "application compiler checksums differ from canonical request-derived output");
  const plan = JSON.parse(planText);
  const journal = JSON.parse(readRegular(join(outputRoot, "operation-journal.json"), "operation journal"));
  const canonicalJournal = JSON.parse(canonical.journalText);
  exactObjectKeys(journal, ["apiVersion", "kind", "metadata", "spec", "status"], "operation journal");
  exactObjectKeys(journal.spec, ["releaseDigest", "requestSHA256", "recoveryAuthority", "steps", "terminalAcceptance"], "operation journal spec");
  check(plan?.kind === "KubaraApplicationReleasePlan" && journal?.kind === "KubaraApplicationReleaseJournal", "application release output kinds differ from the contract");
  check(plan.metadata?.name === request.metadata?.name && journal.metadata?.name === request.metadata?.name, "application release output belongs to another request");
  check(journal.apiVersion === canonicalJournal.apiVersion && journal.kind === canonicalJournal.kind && stable(journal.metadata) === stable(canonicalJournal.metadata)
    && journal.spec.recoveryAuthority === canonicalJournal.spec.recoveryAuthority && journal.spec.terminalAcceptance === canonicalJournal.spec.terminalAcceptance,
  "operation journal immutable compiler authority differs from canonical request-derived output");
  check(journal.spec?.requestSHA256 === `sha256:${sha256(stable(request))}`, "operation journal request digest differs from the exact request");
  const semantic = { application: request.metadata.name, source: request.spec.source, destination: request.spec.destination, targets: plan.spec.targets, promotion: request.spec.promotion, policy: request.spec.policy };
  check(plan.spec.releaseDigest === `sha256:${sha256(stable(semantic))}` && journal.spec.releaseDigest === plan.spec.releaseDigest, "application release digest differs from the exact request/plan");
  const expected = expectedSteps(request);
  check(expected.length === journal.spec.steps.length, "operation journal step inventory differs from the exact request");
  for (let index = 0; index < expected.length; index += 1) {
    const actual = journal.spec.steps[index];
    check(stable({ id: actual.id, effect: actual.effect, authority: actual.authority }) === stable(expected[index]), `${actual.id ?? index}: operation journal authority differs from the exact request`);
    check(["pending", "prepared", "completed"].includes(actual.state) && Array.isArray(actual.attempts), `${actual.id}: operation journal state is invalid`);
    let passingEvidence = null;
    for (const [attemptIndex, attempt] of actual.attempts.entries()) {
      exactObjectKeys(attempt, ["number", "state", "preparedAt", "completedAt", "evidence", "evidenceSHA256", "actionCount", "result"], `${actual.id} attempt ${attemptIndex + 1}`);
      check(attempt.number === attemptIndex + 1 && attempt.evidence === relativeEvidencePath(actual.id, attempt.number), `${actual.id}: attempt numbering or evidence path differs from the deterministic contract`);
      check(["prepared", "completed"].includes(attempt.state) && typeof attempt.preparedAt === "string", `${actual.id}: attempt state/prepared time is invalid`);
      if (attempt.state === "prepared") {
        check(attemptIndex === actual.attempts.length - 1 && attempt.completedAt === null && attempt.evidenceSHA256 === null && attempt.actionCount === 0 && attempt.result === null, `${actual.id}: only the final attempt may remain prepared without evidence`);
        continue;
      }
      check(typeof attempt.completedAt === "string" && /^sha256:[0-9a-f]{64}$/.test(attempt.evidenceSHA256 ?? "") && Number.isSafeInteger(attempt.actionCount) && attempt.actionCount >= 0 && ["pass", "pending"].includes(attempt.result), `${actual.id}: completed attempt fields are invalid`);
      const text = readRegular(join(outputRoot, attempt.evidence), `${actual.id} attempt evidence`);
      check(`sha256:${sha256(text)}` === attempt.evidenceSHA256, `${actual.id}: attempt evidence digest differs`);
      validateStepEvidence(JSON.parse(text), { request, plan, step: actual, attempt });
      if (attempt.result === "pass") passingEvidence = attempt.evidenceSHA256;
    }
    if (actual.state === "completed") check(passingEvidence && actual.completionEvidenceSHA256 === passingEvidence && actual.attempts.at(-1)?.result === "pass", `${actual.id}: completed step is not bound to its terminal passing evidence`);
    else check(actual.completionEvidenceSHA256 === null, `${actual.id}: incomplete step claims completion evidence`);
  }
  const prefix = completedPrefixLength(journal.spec.steps);
  check((journal.status?.completedPrefixLength ?? 0) === prefix && (journal.status?.liveActionsRecorded ?? 0) === countJournalActions(journal), "operation journal aggregate prefix/action counts differ from exact attempts");
  const allowedStatusKeys = new Set(["state", "completedPrefixLength", "liveActionsRecorded", "liveAcceptanceClaimed", "runs", "acceptanceEvidence", "acceptanceEvidenceSHA256"]);
  check(journal.status && typeof journal.status === "object" && !Array.isArray(journal.status) && Object.keys(journal.status).every((key) => allowedStatusKeys.has(key)), "operation journal status contains unknown fields");
  check(journal.status?.runs === undefined ? prefix === 0 : Array.isArray(journal.status.runs), "operation journal runs must be an array after execution begins");
  for (const [runIndex, run] of (journal.status.runs ?? []).entries()) {
    const auditRun = run.result === "pass-immediate-noop";
    exactObjectKeys(run, auditRun ? ["run", "startedAt", "completedAt", "mutationAttemptCount", "actionCount", "result"] : ["run", "startedAt", "completedAt", "actionCount", "result"], `operation journal run ${runIndex + 1}`);
    check(run.run === runIndex + 1 && typeof run.startedAt === "string" && typeof run.completedAt === "string" && Number.isSafeInteger(run.actionCount) && run.actionCount >= 0, `operation journal run ${runIndex + 1} fields are invalid`);
    check(auditRun ? run.mutationAttemptCount === 0 && run.actionCount === 0 : ["pending", "pass"].includes(run.result), `operation journal run ${runIndex + 1} result/count fields are invalid`);
    if (auditRun) check(runIndex === journal.status.runs.length - 1, "immediate no-op audit must be the terminal journal run");
  }
  if (journal.status.liveAcceptanceClaimed) {
    check(journal.status.state === "accepted" && typeof journal.status.acceptanceEvidence === "string" && /^sha256:[0-9a-f]{64}$/.test(journal.status.acceptanceEvidenceSHA256 ?? "") && journal.status.runs?.at(-1)?.result === "pass-immediate-noop", "accepted operation journal lacks its exact terminal acceptance binding");
  } else {
    check(!Object.hasOwn(journal.status, "acceptanceEvidence") && !Object.hasOwn(journal.status, "acceptanceEvidenceSHA256"), "unaccepted operation journal claims acceptance evidence");
  }
  for (const target of Object.keys(request.spec.targets)) {
    const path = join(outputRoot, "delivery-applications", `${target}.yaml`);
    const text = readRegular(path, `${target} delivery Application`);
    check(text === canonical.applicationDocuments.get(target), `${target}: delivery Application differs from canonical request-derived compiler output`);
    const planTarget = plan.spec.targets.find((row) => row.target === target);
    check(planTarget?.documentSHA256 === `sha256:${sha256(text)}`, `${target}: delivery Application bytes differ from the release plan`);
  }
  return { request, plan, journal, outputRoot };
}

function canonicalCompilerOutputs(request) {
  const key = sha256(stable(request));
  if (canonicalCompilerCache.has(key)) return canonicalCompilerCache.get(key);
  const root = mkdtempSync(join(tmpdir(), "kubara-app-runner-canonical-"));
  try {
    const requestPath = join(root, "request.yaml");
    const output = join(root, "output");
    writeFileSync(requestPath, `${toYaml(request)}\n`);
    const result = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", output], 60_000);
    check(result.ok, `canonical application compiler failed\n${result.output}`);
    const targetNames = Object.keys(request.spec.targets);
    const derived = {
      planText: readFileSync(join(output, "release-plan.json"), "utf8"),
      journalText: readFileSync(join(output, "operation-journal.json"), "utf8"),
      applicationText: readFileSync(join(output, "delivery-applications.yaml"), "utf8"),
      checksumsText: readFileSync(join(output, "checksums.txt"), "utf8"),
      applicationDocuments: new Map(targetNames.map((target) => [target, readFileSync(join(output, "delivery-applications", `${target}.yaml`), "utf8")])),
    };
    canonicalCompilerCache.set(key, derived);
    return derived;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateStepEvidence(evidence, { request, plan, step, attempt }) {
  exactObjectKeys(evidence, ["apiVersion", "kind", "metadata", "spec", "status"], `${step.id} evidence`);
  exactObjectKeys(evidence.metadata, ["name"], `${step.id} evidence metadata`);
  exactObjectKeys(evidence.spec, ["releaseDigest", "step", "attempt", "authority", "coordinate"], `${step.id} evidence spec`);
  exactObjectKeys(evidence.spec.coordinate, ["context", "organization", "organizationExternalID", "organizationID", "serverURL", "spaceReleaseOCIBase"], `${step.id} evidence coordinate`);
  exactObjectKeys(evidence.status, ["result", "actionCount", "observation", "liveAcceptanceClaimed"], `${step.id} evidence status`);
  check(evidence?.apiVersion === "import.confighub.com/v1alpha1" && evidence?.kind === "KubaraApplicationReleaseStepEvidence", `${step.id}: evidence kind/apiVersion differs`);
  check(evidence.spec?.releaseDigest === plan.spec.releaseDigest && evidence.spec?.step === step.id && evidence.spec?.attempt === attempt.number, `${step.id}: evidence release/step/attempt binding differs`);
  check(stable(evidence.spec?.authority) === stable(step.authority) && stable(evidence.spec?.coordinate) === stable(exactCoordinate(request.spec.destination)), `${step.id}: evidence authority or destination coordinate differs`);
  check(evidence.status?.result === attempt.result && evidence.status?.actionCount === attempt.actionCount && evidence.status?.liveAcceptanceClaimed === false && Object.hasOwn(evidence.status ?? {}, "observation"), `${step.id}: evidence result/action/claim fields differ from the journal attempt`);
}

function expectedSteps(request) {
  return orderedTargets(request.spec.targets).flatMap(([name, target]) => [
    semanticStep(`${name}:verify-source-head`, "read-only", { space: target.source.space, unit: target.source.unit, unitID: target.source.unitID, headRevisionNum: target.source.headRevisionNum, dataHash: target.source.dataHash, promoteFrom: target.promoteFrom }),
    ...(target.approval.required ? [semanticStep(`${name}:approve-exact-head`, "ConfigHub-write", { unitID: target.source.unitID, headRevisionNum: target.source.headRevisionNum, dataHash: target.source.dataHash, authority: target.approval.authority })] : []),
    semanticStep(`${name}:publish-source-release`, "ConfigHub-write", { space: target.source.space, bundleDigest: target.source.releaseBundleDigest, manifestDigest: target.source.releaseManifestDigest }),
    semanticStep(`${name}:materialize-no-auto-delivery`, "ConfigHub-write", { appsSpace: target.delivery.appsSpace, unit: target.delivery.unit, targetRef: target.delivery.targetRef, manifestDigest: target.source.releaseManifestDigest }),
    semanticStep(`${name}:publish-apps-root`, "ConfigHub-write", { appsSpace: target.delivery.appsSpace, rootApplication: target.delivery.rootApplication }),
    semanticStep(`${name}:submit-exact-root-sync`, "cluster-write", { clusterContext: target.delivery.clusterContext, clusterIdentityUID: target.delivery.clusterIdentityUID, argoNamespace: target.delivery.argoNamespace, rootApplication: target.delivery.rootApplication, appsSpace: target.delivery.appsSpace }),
    semanticStep(`${name}:observe-delivery-materialized`, "read-only", { clusterContext: target.delivery.clusterContext, clusterIdentityUID: target.delivery.clusterIdentityUID, argoNamespace: target.delivery.argoNamespace, application: target.delivery.unit, manifestDigest: target.source.releaseManifestDigest }),
    semanticStep(`${name}:submit-exact-argo-sync`, "cluster-write", { clusterContext: target.delivery.clusterContext, clusterIdentityUID: target.delivery.clusterIdentityUID, argoNamespace: target.delivery.argoNamespace, targetRef: target.delivery.targetRef, manifestDigest: target.source.releaseManifestDigest }),
    semanticStep(`${name}:observe-convergence`, "read-only", { clusterContext: target.delivery.clusterContext, clusterIdentityUID: target.delivery.clusterIdentityUID, argoNamespace: target.delivery.argoNamespace, manifestDigest: target.source.releaseManifestDigest, contract: target.health.contract, evidenceRef: target.health.evidenceRef }),
  ]);
}

function semanticStep(id, effect, authority) { return { id, effect, authority }; }

function observeExactSource(live, targetName, target) {
  const units = live.listUnits(target.source.space);
  check(units.length === 1 && units[0].Slug === target.source.unit, `${targetName}: source Space must contain exactly the one request-bound Unit; found ${units.map((row) => row.Slug).join(", ") || "none"}`);
  const unit = units[0];
  check(unit.UnitID === target.source.unitID, `${targetName}: source Unit ID drifted`);
  check(Number(unit.HeadRevisionNum) === target.source.headRevisionNum, `${targetName}: source head revision drifted`);
  check(unit.DataHash === target.source.dataHash, `${targetName}: source data hash drifted`);
  return { ref: `${target.source.space}/${target.source.unit}`, unitID: unit.UnitID, headRevisionNum: Number(unit.HeadRevisionNum), lastAppliedRevisionNum: Number(unit.LastReleasedRevisionNum), dataHash: unit.DataHash, approvedByCount: approvalCount(unit.ApprovedBy), hasApprovalGate: hasApprovalGate(unit) };
}

function assertExactSourceReleaseAuthority(live, targetName, target) {
  const source = observeExactSource(live, targetName, target);
  const release = latestRelease(live.listPublishedReleases(target.source.space));
  check(releaseMatches(release, target.source), `${targetName}: latest source release differs from the request-pinned bundle/manifest immediately before cluster delivery`);
  return { source, release: releaseObservation(release) };
}

function assertRecognizedPriorDelivery(text, releaseName, target) {
  const app = parseSingleYaml(text, "existing delivery Application");
  check(app?.kind === "Application" && app.metadata?.annotations?.["import.confighub.com/application-release"] === releaseName, "existing delivery Unit is not owned by this application release stream");
  check(app.metadata.annotations?.["import.confighub.com/source-unit-id"] === target.source.unitID, "existing delivery Unit belongs to another source Unit entity");
  check(!Object.hasOwn(app.spec?.syncPolicy ?? {}, "automated"), "existing delivery Unit re-enabled automated sync");
}

function assertRootApplication(app, request, targetName, target) {
  check(app?.kind === "Application", `${targetName}: root Argo Application is missing`);
  check(app.metadata?.name === target.delivery.rootApplication && app.metadata?.namespace === target.delivery.argoNamespace, `${targetName}: root Argo Application identity differs`);
  check(app.spec?.source?.repoURL === `${request.spec.destination.spaceReleaseOCIBase}/${target.delivery.appsSpace}` && app.spec?.source?.path === ".", `${targetName}: root Argo Application source differs from the exact apps Space`);
  check(app.spec?.destination?.server === "https://kubernetes.default.svc", `${targetName}: root Argo Application is not cluster-local`);
  assertNoApplicationSetOwner(app, `${targetName}: root Argo Application`);
}

function assertDeliveryApplication(app, request, targetName, target) {
  check(app?.kind === "Application", `${targetName}: workload Argo Application is missing`);
  check(app.metadata?.name === target.delivery.unit && app.metadata?.namespace === target.delivery.argoNamespace, `${targetName}: workload Argo Application identity differs`);
  check(app.metadata?.annotations?.["import.confighub.com/source-unit-id"] === target.source.unitID
    && app.metadata?.annotations?.["import.confighub.com/source-head-revision"] === String(target.source.headRevisionNum)
    && app.metadata?.annotations?.["import.confighub.com/source-data-hash"] === target.source.dataHash
    && app.metadata?.annotations?.["import.confighub.com/source-release-manifest-digest"] === target.source.releaseManifestDigest
    && app.metadata?.annotations?.["import.confighub.com/target-ref"] === target.delivery.targetRef, `${targetName}: workload Argo Application authority annotations differ`);
  check(app.spec?.source?.repoURL === `${request.spec.destination.spaceReleaseOCIBase}/${target.source.space}` && app.spec?.source?.targetRevision === target.source.releaseManifestDigest && app.spec?.source?.path === ".", `${targetName}: workload Argo Application source authority differs`);
  check(!Object.hasOwn(app.spec?.syncPolicy ?? {}, "automated"), `${targetName}: workload Argo Application re-enabled automated sync`);
  check(app.spec?.destination?.server === "https://kubernetes.default.svc" && app.spec?.destination?.namespace === target.delivery.namespace, `${targetName}: workload Argo Application destination differs`);
  assertNoApplicationSetOwner(app, `${targetName}: workload Argo Application`);
}

function assertNoApplicationSetOwner(app, label) {
  const owners = app?.metadata?.ownerReferences ?? [];
  check(!owners.some((row) => row?.kind === "ApplicationSet" || String(row?.apiVersion ?? "").startsWith("argoproj.io/") && row?.controller === true), `${label} is owned by an ApplicationSet or another Argo controller`);
}

function applicationObservation(app, expectedRevision) {
  return {
    present: Boolean(app),
    uid: app?.metadata?.uid ?? null,
    resourceVersion: app?.metadata?.resourceVersion ?? null,
    expectedRevision,
    targetRevision: app?.spec?.source?.targetRevision ?? null,
    observedRevision: app?.status?.sync?.revision ?? null,
    syncStatus: app?.status?.sync?.status ?? null,
    healthStatus: app?.status?.health?.status ?? null,
    operationPhase: app?.status?.operationState?.phase ?? null,
    activeOperationRevision: activeOperationRevision(app),
    automatedSync: Object.hasOwn(app?.spec?.syncPolicy ?? {}, "automated"),
  };
}

function applicationAccepted(app, expectedRevision) {
  if (!app || app.spec?.source?.targetRevision !== expectedRevision || Object.hasOwn(app.spec?.syncPolicy ?? {}, "automated")) return false;
  if (activeOperationRevision(app)) return false;
  return app.status?.sync?.revision === expectedRevision && app.status?.sync?.status === "Synced" && app.status?.health?.status === "Healthy";
}

function activeOperationRevision(app) {
  if (app?.operation) return app.operation?.sync?.revision ?? "active-operation-without-exact-revision";
  if (["Pending", "Running", "Terminating"].includes(app?.status?.operationState?.phase)) return app.status?.operationState?.syncResult?.revision ?? "active-operation-without-exact-revision";
  return null;
}

function priorRootRelease(journal, root, targetName) {
  const step = journal.spec.steps.find((row) => row.id === `${targetName}:publish-apps-root`);
  check(step?.state === "completed" && step.completionEvidenceSHA256, `${targetName}: apps-root publication evidence is incomplete`);
  const attempt = [...step.attempts].reverse().find((row) => row.evidenceSHA256 === step.completionEvidenceSHA256);
  check(attempt, `${targetName}: apps-root completion attempt is missing`);
  const text = readRegular(join(root, attempt.evidence), `${targetName} apps-root evidence`);
  check(`sha256:${sha256(text)}` === attempt.evidenceSHA256, `${targetName}: apps-root evidence digest differs`);
  const evidence = JSON.parse(text);
  const observation = evidence.status?.observation;
  check(exactDigest(observation?.manifestDigest), `${targetName}: apps-root evidence lacks an exact manifest digest`);
  return observation;
}

function acceptanceDocument({ request, state, audit }) {
  return {
    apiVersion: "import.confighub.com/v1alpha1",
    kind: "KubaraApplicationReleaseAcceptance",
    metadata: { name: request.metadata.name },
    spec: {
      releaseDigest: state.plan.spec.releaseDigest,
      requestSHA256: state.journal.spec.requestSHA256,
      coordinate: exactCoordinate(request.spec.destination),
      policy: {
        sourceAuthority: "exact-UnitID-headRevisionNum-DataHash-and-source-release-digests",
        deliveryAuthority: "exact-source-release-ManifestDigest",
        rootAuthority: "exact-apps-root-ManifestDigest-with-no-automated-sync",
        syncSubmission: "Kubernetes-UID-resourceVersion-JSON-Patch-compare-and-set",
        immediateRerun: "zero-actions",
      },
    },
    status: { result: "pass", mutationAttemptCountOnImmediateRerun: audit.mutationAttemptCount, actionCountOnImmediateRerun: audit.actionCount, liveAcceptanceClaimed: true, targets: audit.targets },
  };
}

function verifyAcceptance({ request, outputRoot, acceptancePath, state = null, client = null }) {
  const loaded = state ?? loadState({ request, outputRoot });
  const text = readRegular(acceptancePath, "application live acceptance evidence");
  const evidence = JSON.parse(text);
  check(evidence?.kind === "KubaraApplicationReleaseAcceptance" && evidence.spec?.releaseDigest === loaded.plan.spec.releaseDigest && evidence.status?.result === "pass", "application live acceptance evidence differs from the exact release");
  check(evidence.status.mutationAttemptCountOnImmediateRerun === 0 && evidence.status.actionCountOnImmediateRerun === 0 && evidence.status.liveAcceptanceClaimed === true, "application acceptance lacks an immediate zero-attempt/zero-action rerun");
  check(loaded.journal.status?.state === "accepted" && loaded.journal.status?.liveAcceptanceClaimed === true && loaded.journal.status?.acceptanceEvidenceSHA256 === `sha256:${sha256(text)}`, "operation journal does not bind the acceptance evidence");
  check(completedPrefixLength(loaded.journal.spec.steps) === loaded.journal.spec.steps.length, "operation journal is not complete");
  if (client) auditAll({ request, state: loaded, live: client });
}

function createLiveClient(request) {
  const destination = request.spec.destination;
  const contextArgs = ["--context", destination.context];
  let mutationAttempts = 0;
  let mutationActions = 0;
  const cub = (args, { json = false, mutate = false, allowFailure = false, timeout = 180_000 } = {}) => {
    if (mutate) { client.assertExactCoordinate(); mutationAttempts += 1; }
    const result = command("cub", [...contextArgs, ...args], timeout);
    if (mutate && result.ok) mutationActions += 1;
    if (!result.ok && !allowFailure) check(false, `cub ${args.slice(0, 2).join(" ")} failed\n${result.output}`);
    if (allowFailure) return result;
    if (!json) return result.stdout;
    try { return JSON.parse(result.stdout); } catch { check(false, `cub ${args.slice(0, 2).join(" ")} returned invalid JSON`); }
  };
  const unit = (space, slug) => {
    const rows = unwrapRows(cub(["unit", "list", "--space", space, "--where", `Slug = '${slug}'`, "--select", "Slug,UnitID,DataHash,HeadRevisionNum,LastReleasedRevisionNum,ApprovedBy,ApplyGates,TargetID,ToolchainType,ProviderType,Annotations", "-o", "json"], { json: true }), "Unit");
    check(rows.length <= 1, `${space}/${slug}: exact Unit query returned ${rows.length} rows`);
    return rows[0] ?? null;
  };
  const application = (clusterContext, namespace, name) => {
    const result = command("kubectl", ["--context", clusterContext, "-n", namespace, "get", "application.argoproj.io", name, "-o", "json"], 60_000);
    if (!result.ok && /not found/i.test(result.output)) return null;
    check(result.ok, `kubectl get Application ${clusterContext}/${namespace}/${name} failed\n${result.output}`);
    try { return JSON.parse(result.stdout); } catch { check(false, `${clusterContext}/${namespace}/${name}: kubectl returned invalid JSON`); }
  };
  const patchApplication = (clusterContext, namespace, name, app, patch) => {
    check(app?.metadata?.uid && app?.metadata?.resourceVersion, `${clusterContext}/${namespace}/${name}: Kubernetes identity is missing`);
    mutationAttempts += 1;
    const result = command("kubectl", ["--context", clusterContext, "-n", namespace, "patch", "application.argoproj.io", name, "--type=json", "-p", JSON.stringify(patch)], 60_000);
    if (result.ok) mutationActions += 1;
    check(result.ok, `kubectl compare-and-set patch ${clusterContext}/${namespace}/${name} failed\n${result.output}`);
  };
  const client = {
    mutationMetrics() { return { attempts: mutationAttempts, actions: mutationActions }; },
    assertExactCoordinate() {
      const coordinate = parseCubContext(cub(["context", "get"]));
      check(coordinate.name === destination.context && coordinate.organizationName === destination.organization && coordinate.organizationExternalID === destination.organizationExternalID && coordinate.serverURL === destination.serverURL.replace(/\/$/, ""), "ConfigHub context/Organization/server coordinate drifted from the exact application request");
      const organizations = unwrapRows(cub(["organization", "list", "--where", `ExternalID = '${destination.organizationExternalID}'`, "--select", "DisplayName,ExternalID,OrganizationID", "-o", "json"], { json: true }), "Organization");
      check(organizations.length === 1 && organizations[0].DisplayName === destination.organization && organizations[0].OrganizationID === destination.organizationID, "ConfigHub Organization entity coordinate drifted from the exact application request");
    },
    assertClusterIdentity(clusterContext, expectedUID) {
      const result = command("kubectl", ["--context", clusterContext, "get", "namespace", "kube-system", "-o", "json"], 60_000);
      check(result.ok, `${clusterContext}: cannot read the kube-system identity\n${result.output}`);
      let namespace;
      try { namespace = JSON.parse(result.stdout); } catch { check(false, `${clusterContext}: kube-system identity response is invalid JSON`); }
      check(namespace?.metadata?.uid === expectedUID, `${clusterContext}: kube-system UID differs from the exact application request`);
    },
    getUnit: unit,
    listUnits(space) { return unwrapRows(cub(["unit", "list", "--space", space, "--select", "Slug,UnitID,DataHash,HeadRevisionNum,LastReleasedRevisionNum,ApprovedBy,ApplyGates,TargetID,ToolchainType,ProviderType,Annotations", "-o", "json"], { json: true }), "Unit"); },
    unitData(space, slug) { return cub(["unit", "data", "--space", space, slug]); },
    getTarget(ref) {
      const [space, slug] = ref.split("/");
      const rows = unwrapRows(cub(["target", "list", "--space", space, "--where", `Slug = '${slug}'`, "--select", "Slug,TargetID,SpaceID,ProviderType,ToolchainType", "-o", "json"], { json: true }), "Target");
      check(rows.length <= 1, `${ref}: exact Target query returned ${rows.length} rows`);
      return rows[0] ?? null;
    },
    listPublishedReleases(space) { return unwrapRows(cub(["release", "list", "--space", space, "--where", "Published = true", "--select", "Digest,ManifestDigest,ReleaseNum,CreatedAt", "-o", "json"], { json: true }), "Release"); },
    approve(space, slug, expected) {
      const before = unit(space, slug);
      check(before?.UnitID === expected.unitID && Number(before.HeadRevisionNum) === expected.headRevisionNum && before.DataHash === expected.dataHash && hasApprovalGate(before), `${space}/${slug}: exact gated head changed immediately before server-head approval`);
      cub(exactHeadApprovalArgs(space, slug, expected.headRevisionNum), { mutate: true });
    },
    publish(space) {
      const result = cub(["release", "publish", space, "-o", "json"], { mutate: true, allowFailure: true, timeout: 1_200_000 });
      if (result.ok || /no changes were made since :latest bundle/i.test(result.output)) return;
      check(false, `${space}: ConfigHub release publication failed\n${result.output}`);
    },
    createDelivery(space, slug, path, targetRef) { cub(["unit", "create", "--space", space, slug, path, "--target", targetRef, "--toolchain", "Kubernetes/YAML", "--wait", "--quiet"], { mutate: true }); },
    updateDelivery(space, slug, path) { cub(["unit", "update", "--space", space, slug, path, "--wait", "--quiet"], { mutate: true }); },
    getApplication: application,
    submitRootSync(clusterContext, clusterIdentityUID, namespace, name, appsSpace, app, expectedRelease) {
      client.assertClusterIdentity(clusterContext, clusterIdentityUID);
      const latest = latestRelease(client.listPublishedReleases(appsSpace));
      check(latest && Number(latest.ReleaseNum) === Number(expectedRelease.releaseNum) && latest.Digest === expectedRelease.bundleDigest && latest.ManifestDigest === expectedRelease.manifestDigest, `${appsSpace}: latest root release changed immediately before Kubernetes compare-and-set`);
      const revision = expectedRelease.manifestDigest;
      const patch = identityTests(app);
      patch.push({ op: "test", path: "/spec/source/repoURL", value: app.spec.source.repoURL });
      patch.push({ op: "add", path: "/spec/source/targetRevision", value: revision });
      if (Object.hasOwn(app.spec?.syncPolicy ?? {}, "automated")) patch.push({ op: "remove", path: "/spec/syncPolicy/automated" });
      patch.push({ op: Object.hasOwn(app, "operation") ? "replace" : "add", path: "/operation", value: syncOperation(revision) });
      patchApplication(clusterContext, namespace, name, app, patch);
    },
    submitApplicationSync(clusterContext, clusterIdentityUID, namespace, name, app, targetName, target) {
      client.assertClusterIdentity(clusterContext, clusterIdentityUID);
      assertExactSourceReleaseAuthority(client, targetName, target);
      const revision = target.source.releaseManifestDigest;
      const patch = identityTests(app);
      patch.push({ op: "test", path: "/spec/source/targetRevision", value: revision });
      patch.push({ op: Object.hasOwn(app, "operation") ? "replace" : "add", path: "/operation", value: syncOperation(revision) });
      patchApplication(clusterContext, namespace, name, app, patch);
    },
  };
  return client;
}

function identityTests(app) {
  return [
    { op: "test", path: "/metadata/uid", value: app.metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: app.metadata.resourceVersion },
  ];
}
function exactHeadApprovalArgs(space, slug, headRevisionNum) {
  check(space && slug && Number.isSafeInteger(Number(headRevisionNum)) && Number(headRevisionNum) > 0, "exact-head approval arguments are invalid");
  // ConfigHub v0.2.11 rejects a literal numeric revision even when it equals
  // the observed head. The server-current-head selector is therefore fenced
  // by exact UnitID/numeric-head/DataHash/gate reads immediately around it.
  return ["unit", "approve", "--space", space, slug, "--revision", "HeadRevisionNum", "--wait", "--quiet"];
}
function syncOperation(revision) { return { sync: { revision, prune: true, syncOptions: ["PruneLast=true", "FailOnSharedResource=true", "RespectIgnoreDifferences=true", "ApplyOutOfSyncOnly=true"] } }; }

function command(executable, args, timeout) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { ok: result.status === 0 && !result.error, status: result.status, stdout, stderr, output: `${stdout}${stderr}`.trim() };
}

function persistJournal(root, journal) {
  const path = join(root, "operation-journal.json");
  check(!existsSync(path) || (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()), "operation journal must be a real file");
  const text = `${JSON.stringify(journal, null, 2)}\n`;
  const temporary = join(root, `.operation-journal.${process.pid}.${Date.now()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, text); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function writeImmutable(path, text) {
  assertNoSymlinkAncestors(path, "immutable evidence path");
  ensureRealParent(dirname(path));
  if (existsSync(path)) {
    check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${path}: immutable evidence must be a real file`);
    check(readFileSync(path, "utf8") === text, `${path}: refusing to overwrite different immutable evidence`);
    return;
  }
  const descriptor = openSync(path, "wx", 0o600);
  try { writeFileSync(descriptor, text); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function ensureRealParent(path) {
  assertNoSymlinkAncestors(path, "evidence directory");
  const missing = [];
  let current = path;
  while (!existsSync(current)) { missing.push(current); current = dirname(current); }
  check(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), `${current}: evidence ancestor must be a real directory`);
  for (const item of missing.reverse()) mkdirSync(item);
  let checkPath = path;
  while (checkPath !== current) {
    check(lstatSync(checkPath).isDirectory() && !lstatSync(checkPath).isSymbolicLink(), `${checkPath}: evidence directory must be real`);
    checkPath = dirname(checkPath);
  }
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "kubara-app-runner-self-test-"));
  try {
    const requestPath = join(root, "request.yaml");
    const outputRoot = join(root, "output");
    const acceptancePath = join(root, "acceptance.json");
    const sourceExample = resolve("examples/kubara/git-import/app-release.example.yaml");
    writeFileSync(requestPath, readFileSync(sourceExample));
    const compileResult = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", outputRoot], 60_000);
    check(compileResult.ok, `self-test compiler failed\n${compileResult.output}`);
    const request = readYaml(requestPath);
    const fake = createFakeClient(request, outputRoot);
    let state = loadState({ request, outputRoot });
    fake.pauseRootConvergenceOnce();
    let result = execute({ request, outputRoot, acceptancePath, state, client: fake });
    check(!result.complete && !existsSync(acceptancePath), "self-test did not stop durably at pending root convergence");
    state = loadState({ request, outputRoot });
    check(state.journal.status.runs.at(-1)?.result === "pending", "self-test pending run was not reloadable");
    fake.convergeAll();
    result = execute({ request, outputRoot, acceptancePath, state, client: fake });
    check(result.complete, "self-test application execution did not complete");
    state = loadState({ request, outputRoot });
    verifyAcceptance({ request, outputRoot, acceptancePath, state, client: fake });
    check(state.journal.status.runs.at(-1)?.actionCount === 0 && state.journal.status.runs.at(-1)?.result === "pass-immediate-noop", "self-test did not record the immediate zero-action audit");
    check(state.journal.spec.steps.every((row) => row.state === "completed" && row.completionEvidenceSHA256), "self-test operation journal is not a completed evidence-bound prefix");
    const expectAuditDrift = (kind, pattern, label, targetName = "prod") => {
      const snapshot = fake.testSnapshot();
      fake.injectTestDrift(kind, targetName);
      expectFailure(() => verifyAcceptance({ request, outputRoot, acceptancePath, state, client: fake }), pattern, label);
      fake.restoreTestSnapshot(snapshot);
    };
    expectAuditDrift("missing-approval", /required exact-head approval/, "missing approval audit refusal");
    expectAuditDrift("approval-gate", /approval gate remains/, "uncleared approval gate audit refusal");
    expectAuditDrift("target-provider", /Target identity\/provider\/toolchain/, "Target provider audit refusal");
    expectAuditDrift("pending-apps-root", /pending Unit heads/, "unrelated pending apps-root Unit refusal");
    expectAuditDrift("newer-root-release", /latest apps-root release/, "newer apps-root release audit refusal");
    expectAuditDrift("root-applicationset-owner", /owned by an ApplicationSet/, "ApplicationSet-owned root refusal", "dev");
    expectAuditDrift("workload-applicationset-owner", /owned by an ApplicationSet/, "ApplicationSet-owned workload refusal", "dev");
    expectAuditDrift("extra-source-unit", /source Space must contain exactly/, "unbound source Unit refusal", "dev");

    const originalJournalText = readFileSync(join(outputRoot, "operation-journal.json"), "utf8");
    const evidenceJournal = JSON.parse(originalJournalText);
    const evidenceStep = evidenceJournal.spec.steps[0];
    const evidenceAttempt = evidenceStep.attempts.find((row) => row.result === "pass");
    const evidencePath = join(outputRoot, evidenceAttempt.evidence);
    const originalEvidenceText = readFileSync(evidencePath, "utf8");
    const forgedEvidence = JSON.parse(originalEvidenceText);
    forgedEvidence.spec.authority = { ...forgedEvidence.spec.authority, unboundAuthority: true };
    const forgedEvidenceText = `${JSON.stringify(forgedEvidence, null, 2)}\n`;
    writeFileSync(evidencePath, forgedEvidenceText);
    evidenceAttempt.evidenceSHA256 = `sha256:${sha256(forgedEvidenceText)}`;
    evidenceStep.completionEvidenceSHA256 = evidenceAttempt.evidenceSHA256;
    writeFileSync(join(outputRoot, "operation-journal.json"), `${JSON.stringify(evidenceJournal, null, 2)}\n`);
    expectFailure(() => loadState({ request, outputRoot }), /evidence authority or destination coordinate differs/, "digest-rebound semantic evidence tamper refusal");
    writeFileSync(evidencePath, originalEvidenceText);
    writeFileSync(join(outputRoot, "operation-journal.json"), originalJournalText);
    const shallowJournal = JSON.parse(originalJournalText);
    shallowJournal.spec.steps[0].attempts[0].unbound = true;
    writeFileSync(join(outputRoot, "operation-journal.json"), `${JSON.stringify(shallowJournal, null, 2)}\n`);
    expectFailure(() => loadState({ request, outputRoot }), /attempt 1 fields differ/, "shallow journal field tamper refusal");
    writeFileSync(join(outputRoot, "operation-journal.json"), originalJournalText);
    state = loadState({ request, outputRoot });
    const canonicalPlanText = readFileSync(join(outputRoot, "release-plan.json"), "utf8");
    const canonicalDeliveryPath = join(outputRoot, "delivery-applications", "dev.yaml");
    const canonicalDeliveryText = readFileSync(canonicalDeliveryPath, "utf8");
    const alteredPlan = JSON.parse(canonicalPlanText);
    const alteredDelivery = parseSingleYaml(canonicalDeliveryText, "altered canonical delivery test");
    alteredDelivery.spec.project = "hidden-foreign-project";
    const alteredDeliveryText = `${toYaml(alteredDelivery)}\n`;
    alteredPlan.spec.targets.find((row) => row.target === "dev").documentSHA256 = `sha256:${sha256(alteredDeliveryText)}`;
    writeFileSync(canonicalDeliveryPath, alteredDeliveryText);
    writeFileSync(join(outputRoot, "release-plan.json"), `${JSON.stringify(alteredPlan, null, 2)}\n`);
    expectFailure(() => loadState({ request, outputRoot }), /canonical request-derived compiler output/, "coherently edited plan and delivery document refusal");
    writeFileSync(canonicalDeliveryPath, canonicalDeliveryText);
    writeFileSync(join(outputRoot, "release-plan.json"), canonicalPlanText);
    state = loadState({ request, outputRoot });
    const tampered = JSON.parse(readFileSync(acceptancePath, "utf8"));
    tampered.status.actionCountOnImmediateRerun = 1;
    writeFileSync(join(root, "tampered.json"), `${JSON.stringify(tampered, null, 2)}\n`);
    expectFailure(() => verifyAcceptance({ request, outputRoot, acceptancePath: join(root, "tampered.json"), state }), /zero-action/, "tampered acceptance refusal");
    const realEvidenceDirectory = join(root, "real-evidence");
    mkdirSync(realEvidenceDirectory);
    const linkedEvidenceDirectory = join(root, "linked-evidence");
    symlinkSync(realEvidenceDirectory, linkedEvidenceDirectory);
    expectFailure(() => writeImmutable(join(linkedEvidenceDirectory, "forbidden.json"), "{}\n"), /symbolic link/, "evidence ancestor symlink refusal");
    check(!existsSync(join(realEvidenceDirectory, "forbidden.json")), "evidence ancestor symlink refusal wrote through the link");
    if (existsSync("/var") && lstatSync("/var").isSymbolicLink() && realpathSync("/var") === "/private/var") assertNoSymlinkAncestors("/var/tmp/kubara-app-runner-system-alias-probe", "macOS /var system alias");
    const liveLockPath = join(outputRoot, ".application-release-execution.lock");
    writeFileSync(liveLockPath, `${JSON.stringify({ releaseDigest: state.plan.spec.releaseDigest, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
    expectFailure(() => execute({ request, outputRoot, acceptancePath, state, client: fake }), /held by live pid/, "concurrent execution lock refusal");
    rmSync(liveLockPath);
    check(stable(exactHeadApprovalArgs("payments-prod", "payments", 17)) === stable(["unit", "approve", "--space", "payments-prod", "payments", "--revision", "HeadRevisionNum", "--wait", "--quiet"]), "exact-head approval command omitted the proven server-current-head selector");
    const approvalRaceFake = createFakeClient(request, outputRoot);
    approvalRaceFake.raceApprovalAuthorityOnce("prod");
    const approvalRaceBefore = approvalRaceFake.mutationMetrics();
    expectFailure(() => executeStep({ step: { id: "prod:approve-exact-head" }, targetName: "prod", target: request.spec.targets.prod, request, state, live: approvalRaceFake }), /exact gated head changed immediately before/, "approval authority race refusal");
    check(stable(approvalRaceFake.mutationMetrics()) === stable(approvalRaceBefore), "approval authority race reached the approval side effect");

    const preparedOutput = join(root, "prepared-output");
    const preparedAcceptance = join(root, "prepared-acceptance.json");
    const preparedCompile = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", preparedOutput], 60_000);
    check(preparedCompile.ok, `self-test prepared compiler failed\n${preparedCompile.output}`);
    let preparedState = loadState({ request, outputRoot: preparedOutput });
    const preparedStep = preparedState.journal.spec.steps[0];
    preparedStep.state = "prepared";
    preparedStep.attempts.push({ number: 1, state: "prepared", preparedAt: new Date().toISOString(), completedAt: null, evidence: relativeEvidencePath(preparedStep.id, 1), evidenceSHA256: null, actionCount: 0, result: null });
    preparedState.journal.status.state = `executing:${preparedStep.id}`;
    preparedState.journal.status.completedPrefixLength = 0;
    preparedState.journal.status.runs = [];
    persistJournal(preparedOutput, preparedState.journal);
    preparedState = loadState({ request, outputRoot: preparedOutput });
    const preparedFake = createFakeClient(request, preparedOutput);
    const preparedResult = execute({ request, outputRoot: preparedOutput, acceptancePath: preparedAcceptance, state: preparedState, client: preparedFake });
    check(preparedResult.complete, "self-test prepared-step recovery did not complete");
    preparedState = loadState({ request, outputRoot: preparedOutput });
    check(preparedState.journal.spec.steps[0].attempts.length === 1 && preparedState.journal.spec.steps[0].attempts[0].state === "completed", "self-test appended behind rather than completed the durable prepared attempt");
    verifyAcceptance({ request, outputRoot: preparedOutput, acceptancePath: preparedAcceptance, state: preparedState, client: preparedFake });

    const evidenceCrashOutput = join(root, "evidence-crash-output");
    const evidenceCrashAcceptance = join(root, "evidence-crash-acceptance.json");
    const evidenceCrashCompile = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", evidenceCrashOutput], 60_000);
    check(evidenceCrashCompile.ok, `self-test evidence-crash compiler failed\n${evidenceCrashCompile.output}`);
    const evidenceCrashFake = createFakeClient(request, evidenceCrashOutput);
    evidenceCrashFake.crashAfterEvidenceOnce("prod:approve-exact-head");
    expectFailure(() => execute({ request, outputRoot: evidenceCrashOutput, acceptancePath: evidenceCrashAcceptance, state: loadState({ request, outputRoot: evidenceCrashOutput }), client: evidenceCrashFake }), /simulated crash after immutable evidence/, "post-evidence pre-journal crash simulation");
    let evidenceCrashState = loadState({ request, outputRoot: evidenceCrashOutput });
    const crashedApproval = evidenceCrashState.journal.spec.steps.find((row) => row.id === "prod:approve-exact-head");
    check(crashedApproval.state === "prepared" && crashedApproval.attempts[0].evidenceSHA256 === null && existsSync(join(evidenceCrashOutput, crashedApproval.attempts[0].evidence)), "self-test did not create the durable-evidence/prepared-journal crash window");
    const evidenceCrashResult = execute({ request, outputRoot: evidenceCrashOutput, acceptancePath: evidenceCrashAcceptance, state: evidenceCrashState, client: evidenceCrashFake });
    check(evidenceCrashResult.complete, "self-test did not recover durable evidence written before its journal update");
    evidenceCrashState = loadState({ request, outputRoot: evidenceCrashOutput });
    const recoveredApproval = evidenceCrashState.journal.spec.steps.find((row) => row.id === "prod:approve-exact-head");
    check(recoveredApproval.attempts.length === 1 && recoveredApproval.attempts[0].result === "pass" && recoveredApproval.attempts[0].actionCount === 1, "self-test did not adopt the exact immutable approval evidence without replay");
    verifyAcceptance({ request, outputRoot: evidenceCrashOutput, acceptancePath: evidenceCrashAcceptance, state: evidenceCrashState, client: evidenceCrashFake });

    const raceRootOutput = join(root, "race-root-output");
    const raceRootCompile = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", raceRootOutput], 60_000);
    check(raceRootCompile.ok, `self-test root-race compiler failed\n${raceRootCompile.output}`);
    const raceRootFake = createFakeClient(request, raceRootOutput);
    raceRootFake.raceRootReleaseOnce();
    expectFailure(() => execute({ request, outputRoot: raceRootOutput, acceptancePath: join(root, "race-root-acceptance.json"), state: loadState({ request, outputRoot: raceRootOutput }), client: raceRootFake }), /latest root release CAS failed/, "newer root release pre-CAS refusal");
    check(raceRootFake.clusterPatchMetrics().roots === 0, "root release race reached the Kubernetes side effect");

    const raceSourceOutput = join(root, "race-source-output");
    const raceSourceCompile = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", raceSourceOutput], 60_000);
    check(raceSourceCompile.ok, `self-test source-race compiler failed\n${raceSourceCompile.output}`);
    const raceSourceFake = createFakeClient(request, raceSourceOutput);
    raceSourceFake.raceSourceAuthorityOnce("dev");
    expectFailure(() => execute({ request, outputRoot: raceSourceOutput, acceptancePath: join(root, "race-source-acceptance.json"), state: loadState({ request, outputRoot: raceSourceOutput }), client: raceSourceFake }), /source data hash drifted/, "source drift immediately inside workload CAS refusal");
    check(raceSourceFake.clusterPatchMetrics().workloads === 0, "source authority race reached the workload Kubernetes side effect");

    const extraSourceOutput = join(root, "extra-source-output");
    const extraSourceCompile = command(process.execPath, [resolve("scripts/compile-kubara-app-release.mjs"), "--compile", "--request", requestPath, "--output", extraSourceOutput], 60_000);
    check(extraSourceCompile.ok, `self-test extra-source compiler failed\n${extraSourceCompile.output}`);
    const extraSourceFake = createFakeClient(request, extraSourceOutput);
    extraSourceFake.injectTestDrift("extra-source-unit", "dev");
    expectFailure(() => execute({ request, outputRoot: extraSourceOutput, acceptancePath: join(root, "extra-source-acceptance.json"), state: loadState({ request, outputRoot: extraSourceOutput }), client: extraSourceFake }), /source Space must contain exactly/, "unbound source inventory pre-write refusal");
    check(stable(extraSourceFake.mutationMetrics()) === stable({ attempts: 0, actions: 0 }), "unbound source inventory refusal attempted a mutation");
    console.log("Kubara application runner self-test passed: exact coordinate, source approval/releases, delivery Unit, exact apps-root fence, Kubernetes CAS sync, durable evidence, and immediate zero-action audit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createFakeClient(request, outputRoot) {
  const units = new Map();
  const releases = new Map();
  const applications = new Map();
  const targetRows = new Map();
  let releaseNumber = 0;
  let mutationAttempts = 0;
  let mutationActions = 0;
  let pauseNextRootConvergence = false;
  let raceNextRootRelease = false;
  let raceNextSourceTarget = null;
  let raceNextApprovalTarget = null;
  let rootPatchActions = 0;
  let workloadPatchActions = 0;
  let crashAfterEvidenceStep = null;
  const unitKey = (space, slug) => `${space}/${slug}`;
  const appKey = (context, namespace, name) => `${context}/${namespace}/${name}`;
  const putUnit = (space, slug, data, extra = {}) => {
    const existing = units.get(unitKey(space, slug));
    const head = existing ? Number(existing.HeadRevisionNum) + 1 : 1;
    const row = { Slug: slug, UnitID: existing?.UnitID ?? deterministicUUID(`unit:${space}/${slug}`), DataHash: sha256(data), HeadRevisionNum: head, LastReleasedRevisionNum: existing?.LastReleasedRevisionNum ?? 0, ApprovedBy: existing?.ApprovedBy ?? [], TargetID: extra.TargetID ?? existing?.TargetID ?? null, ToolchainType: extra.ToolchainType ?? existing?.ToolchainType ?? "Kubernetes/YAML", ProviderType: null, ...extra, __data: data };
    units.set(unitKey(space, slug), row);
    return row;
  };
  for (const [name, target] of Object.entries(request.spec.targets)) {
    units.set(unitKey(target.source.space, target.source.unit), { Slug: target.source.unit, UnitID: target.source.unitID, DataHash: target.source.dataHash, HeadRevisionNum: target.source.headRevisionNum, LastReleasedRevisionNum: 0, ApprovedBy: [], ApplyGates: target.approval.required ? { "require-approval": {} } : {}, TargetID: null, __data: "source" });
    releases.set(target.source.space, []);
    releases.set(target.delivery.appsSpace, []);
    targetRows.set(target.delivery.targetRef, { TargetID: target.delivery.targetID, ProviderType: "OCI", ToolchainType: "Any" });
    applications.set(appKey(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication), fakeApplication({ name: target.delivery.rootApplication, namespace: target.delivery.argoNamespace, repoURL: `${request.spec.destination.spaceReleaseOCIBase}/${target.delivery.appsSpace}`, revision: "latest", automated: true }));
  }
  const client = {
    mutationMetrics() { return { attempts: mutationAttempts, actions: mutationActions }; },
    clusterPatchMetrics() { return { roots: rootPatchActions, workloads: workloadPatchActions }; },
    pauseRootConvergenceOnce() { pauseNextRootConvergence = true; },
    raceRootReleaseOnce() { raceNextRootRelease = true; },
    raceSourceAuthorityOnce(targetName) { raceNextSourceTarget = targetName; },
    raceApprovalAuthorityOnce(targetName) { raceNextApprovalTarget = targetName; },
    crashAfterEvidenceOnce(stepID) { crashAfterEvidenceStep = stepID; },
    afterEvidenceWritten(step) {
      if (crashAfterEvidenceStep === step.id) {
        crashAfterEvidenceStep = null;
        throw new Error(`simulated crash after immutable evidence for ${step.id}`);
      }
    },
    testSnapshot() {
      return { units: mapSnapshot(units), releases: mapSnapshot(releases), applications: mapSnapshot(applications), targetRows: mapSnapshot(targetRows), releaseNumber };
    },
    restoreTestSnapshot(snapshot) {
      mapRestore(units, snapshot.units); mapRestore(releases, snapshot.releases); mapRestore(applications, snapshot.applications); mapRestore(targetRows, snapshot.targetRows); releaseNumber = snapshot.releaseNumber;
    },
    injectTestDrift(kind, targetName) {
      const target = request.spec.targets[targetName];
      check(target, `unknown fake drift target ${targetName}`);
      if (kind === "missing-approval") units.get(unitKey(target.source.space, target.source.unit)).ApprovedBy = [];
      else if (kind === "approval-gate") units.get(unitKey(target.source.space, target.source.unit)).ApplyGates = { "require-approval": {} };
      else if (kind === "target-provider") targetRows.get(target.delivery.targetRef).ProviderType = "Git";
      else if (kind === "pending-apps-root") putUnit(target.delivery.appsSpace, "unrelated-pending", "pending");
      else if (kind === "newer-root-release") releases.get(target.delivery.appsSpace).push({ ReleaseNum: ++releaseNumber, Digest: `sha256:${sha256(`newer-bundle:${targetName}`)}`, ManifestDigest: `sha256:${sha256(`newer-manifest:${targetName}`)}`, CreatedAt: `self-test-newer-${releaseNumber}` });
      else if (kind === "root-applicationset-owner") applications.get(appKey(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.rootApplication)).metadata.ownerReferences = [{ apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", name: "foreign", uid: deterministicUUID("foreign-root-owner"), controller: true }];
      else if (kind === "workload-applicationset-owner") applications.get(appKey(target.delivery.clusterContext, target.delivery.argoNamespace, target.delivery.unit)).metadata.ownerReferences = [{ apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", name: "foreign", uid: deterministicUUID("foreign-workload-owner"), controller: true }];
      else if (kind === "extra-source-unit") putUnit(target.source.space, "unrelated-source", "foreign");
      else check(false, `unknown fake drift kind ${kind}`);
    },
    convergeAll() {
      for (const app of applications.values()) {
        const revision = app.spec?.source?.targetRevision;
        if (exactDigest(revision) && app.metadata?.name === "root") app.status = { sync: { revision, status: "Synced" }, health: { status: "Healthy" }, operationState: { phase: "Succeeded" } };
      }
    },
    assertExactCoordinate() {},
    assertClusterIdentity(context, expectedUID) {
      const target = Object.values(request.spec.targets).find((row) => row.delivery.clusterContext === context);
      check(target?.delivery.clusterIdentityUID === expectedUID, "fake cluster identity check failed");
    },
    getUnit(space, slug) { return clone(units.get(unitKey(space, slug)) ?? null); },
    listUnits(space) { return [...units.entries()].filter(([key]) => key.startsWith(`${space}/`)).map(([, row]) => clone(row)); },
    unitData(space, slug) { return units.get(unitKey(space, slug))?.__data ?? ""; },
    getTarget(ref) { return clone(targetRows.get(ref) ?? null); },
    listPublishedReleases(space) { return clone(releases.get(space) ?? []); },
    approve(space, slug, expected) {
      const targetName = Object.keys(request.spec.targets).find((name) => request.spec.targets[name].source.space === space && request.spec.targets[name].source.unit === slug);
      const unit = units.get(unitKey(space, slug));
      if (raceNextApprovalTarget === targetName) { raceNextApprovalTarget = null; unit.DataHash = "e".repeat(64); }
      check(unit?.UnitID === expected.unitID && Number(unit.HeadRevisionNum) === expected.headRevisionNum && unit.DataHash === expected.dataHash && hasApprovalGate(unit), `${space}/${slug}: exact gated head changed immediately before server-head approval`);
      mutationAttempts += 1;
      unit.ApprovedBy = [...(Array.isArray(unit.ApprovedBy) ? unit.ApprovedBy : []), "self-test-reviewer"];
      unit.ApplyGates = {};
      mutationActions += 1;
    },
    publish(space) {
      mutationAttempts += 1;
      const rows = [...units.entries()].filter(([key]) => key.startsWith(`${space}/`)).map(([, row]) => row);
      for (const row of rows) row.LastReleasedRevisionNum = row.HeadRevisionNum;
      const target = Object.values(request.spec.targets).find((row) => row.source.space === space);
      const release = target
        ? { ReleaseNum: ++releaseNumber, Digest: target.source.releaseBundleDigest, ManifestDigest: target.source.releaseManifestDigest, CreatedAt: `self-test-${releaseNumber}` }
        : { ReleaseNum: ++releaseNumber, Digest: `sha256:${sha256(`bundle:${space}:${releaseNumber}`)}`, ManifestDigest: `sha256:${sha256(`manifest:${space}:${releaseNumber}`)}`, CreatedAt: `self-test-${releaseNumber}` };
      releases.get(space).push(release);
      mutationActions += 1;
    },
    createDelivery(space, slug, path, targetRef) { mutationAttempts += 1; putUnit(space, slug, readFileSync(path, "utf8"), { TargetID: targetRows.get(targetRef).TargetID }); mutationActions += 1; },
    updateDelivery(space, slug, path) { mutationAttempts += 1; putUnit(space, slug, readFileSync(path, "utf8")); mutationActions += 1; },
    getApplication(context, namespace, name) { return clone(applications.get(appKey(context, namespace, name)) ?? null); },
    submitRootSync(context, clusterIdentityUID, namespace, name, appsSpace, app, expectedRelease) {
      client.assertClusterIdentity(context, clusterIdentityUID);
      if (raceNextRootRelease) {
        raceNextRootRelease = false;
        releases.get(appsSpace).push({ ReleaseNum: ++releaseNumber, Digest: `sha256:${sha256(`raced-bundle:${appsSpace}:${releaseNumber}`)}`, ManifestDigest: `sha256:${sha256(`raced-manifest:${appsSpace}:${releaseNumber}`)}`, CreatedAt: `self-test-race-${releaseNumber}` });
      }
      const latest = latestRelease(releases.get(appsSpace));
      check(Number(latest?.ReleaseNum) === Number(expectedRelease.releaseNum) && latest?.Digest === expectedRelease.bundleDigest && latest?.ManifestDigest === expectedRelease.manifestDigest, "fake latest root release CAS failed");
      const revision = expectedRelease.manifestDigest;
      mutationAttempts += 1;
      const key = appKey(context, namespace, name);
      const row = applications.get(key);
      check(row.metadata.uid === app.metadata.uid && row.metadata.resourceVersion === app.metadata.resourceVersion, "fake root CAS failed");
      row.metadata.resourceVersion = String(Number(row.metadata.resourceVersion) + 1);
      row.spec.source.targetRevision = revision;
      delete row.spec.syncPolicy.automated;
      row.status = pauseNextRootConvergence
        ? { sync: { revision: null, status: "OutOfSync" }, health: { status: "Progressing" }, operationState: { phase: "Running", syncResult: { revision } } }
        : { sync: { revision, status: "Synced" }, health: { status: "Healthy" }, operationState: { phase: "Succeeded" } };
      pauseNextRootConvergence = false;
      delete row.operation;
      const targetName = Object.keys(request.spec.targets).find((candidate) => request.spec.targets[candidate].delivery.rootApplication === name && request.spec.targets[candidate].delivery.clusterContext === context);
      const target = request.spec.targets[targetName];
      const document = parseSingleYaml(readFileSync(join(outputRoot, "delivery-applications", `${targetName}.yaml`), "utf8"), "fake delivery Application");
      document.metadata.uid = deterministicUUID(`application:${context}/${namespace}/${target.delivery.unit}`);
      document.metadata.resourceVersion = "1";
      document.status = { sync: { revision: null, status: "OutOfSync" }, health: { status: "Missing" } };
      applications.set(appKey(context, namespace, target.delivery.unit), document);
      mutationActions += 1;
      rootPatchActions += 1;
    },
    submitApplicationSync(context, clusterIdentityUID, namespace, name, app, targetName, target) {
      client.assertClusterIdentity(context, clusterIdentityUID);
      if (raceNextSourceTarget === targetName) {
        raceNextSourceTarget = null;
        units.get(unitKey(target.source.space, target.source.unit)).DataHash = "f".repeat(64);
      }
      assertExactSourceReleaseAuthority(client, targetName, target);
      const revision = target.source.releaseManifestDigest;
      mutationAttempts += 1;
      const row = applications.get(appKey(context, namespace, name));
      check(row.metadata.uid === app.metadata.uid && row.metadata.resourceVersion === app.metadata.resourceVersion, "fake workload CAS failed");
      row.metadata.resourceVersion = String(Number(row.metadata.resourceVersion) + 1);
      row.status = { sync: { revision, status: "Synced" }, health: { status: "Healthy" }, operationState: { phase: "Succeeded" } };
      delete row.operation;
      mutationActions += 1;
      workloadPatchActions += 1;
    },
  };
  return client;
}

function fakeApplication({ name, namespace, repoURL, revision, automated }) {
  return {
    apiVersion: "argoproj.io/v1alpha1", kind: "Application",
    metadata: { name, namespace, uid: deterministicUUID(`application:${namespace}/${name}`), resourceVersion: "1" },
    spec: { project: "default", source: { repoURL, targetRevision: revision, path: "." }, destination: { server: "https://kubernetes.default.svc", namespace }, syncPolicy: automated ? { automated: { selfHeal: true } } : {} },
    status: { sync: { revision: null, status: "OutOfSync" }, health: { status: "Missing" } },
  };
}

function completedPrefixLength(steps) {
  let prefix = 0;
  let incomplete = false;
  for (const step of steps) {
    if (step.state === "completed") {
      check(!incomplete, "operation journal completed steps are not a contiguous prefix");
      check(step.completionEvidenceSHA256, `${step.id}: completed step lacks evidence`);
      prefix += 1;
    } else incomplete = true;
  }
  check(steps.filter((row) => row.state === "prepared").length <= 1, "operation journal has multiple prepared steps");
  return prefix;
}
function countJournalActions(journal) { return journal.spec.steps.flatMap((row) => row.attempts).reduce((sum, row) => sum + Number(row.actionCount ?? 0), 0); }
function complete(observation, actionCount = 0) { return { complete: true, observation, actionCount }; }
function pending(observation) { return { complete: false, observation, actionCount: 0 }; }
function latestRelease(rows) { return [...rows].sort((left, right) => Number(right.ReleaseNum ?? 0) - Number(left.ReleaseNum ?? 0))[0] ?? null; }
function releaseMatches(release, source) { return release?.Digest === source.releaseBundleDigest && release?.ManifestDigest === source.releaseManifestDigest; }
function releaseObservation(release) { return { releaseNum: Number(release.ReleaseNum), bundleDigest: release.Digest, manifestDigest: release.ManifestDigest, createdAt: release.CreatedAt ?? null }; }
function exactDigest(value) { return /^sha256:[0-9a-f]{64}$/.test(value ?? ""); }
function approvalCount(value) { if (Array.isArray(value)) return value.length; if (value && typeof value === "object") return Object.keys(value).length; return Number(Boolean(value)); }
function hasApprovalGate(unit) { return Object.keys(unit?.ApplyGates ?? {}).some((key) => key.includes("require-approval") || key === "vet-approvedby" || key.endsWith("/vet-approvedby")); }
function relativeEvidencePath(id, attempt) { return `evidence/application-release/${id.replace(/[^a-zA-Z0-9._-]+/g, "-")}-attempt-${attempt}.json`; }
function safeName(value) { return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 63); }
function exactCoordinate(destination) { return { context: destination.context, organization: destination.organization, organizationExternalID: destination.organizationExternalID, organizationID: destination.organizationID, serverURL: destination.serverURL, spaceReleaseOCIBase: destination.spaceReleaseOCIBase }; }
function outputRootFor(state) { return state.outputRoot; }
function assertNoSymlinkAncestors(path, label) { let current = resolve(path); while (true) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) { const systemAlias = (current === "/var" && realpathSync(current) === "/private/var") || (current === "/tmp" && realpathSync(current) === "/private/tmp"); check(systemAlias, `${label} contains a symbolic link: ${current}`); } const parent = dirname(current); if (parent === current) break; current = parent; } }
function assertDirectory(path, label) { assertNoSymlinkAncestors(path, label); check(existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `${label} must be a real directory`); }
function readRegular(path, label) { assertNoSymlinkAncestors(path, label); check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${label} must be a real file`); return readFileSync(path, "utf8"); }
function parseSingleYaml(text, label) { const root = mkdtempSync(join(tmpdir(), "kubara-app-runner-yaml-")); try { const path = join(root, "one.yaml"); writeFileSync(path, text); return readYaml(path); } finally { rmSync(root, { recursive: true, force: true }); } }
function orderedTargets(targets) { const remaining = new Map(Object.entries(targets)); const done = new Set(); const rows = []; while (remaining.size) { const ready = [...remaining.entries()].filter(([, row]) => row.promoteFrom === null || done.has(row.promoteFrom)).sort(([a], [b]) => a.localeCompare(b)); check(ready.length, "application promotion topology is cyclic"); for (const row of ready) { rows.push(row); done.add(row[0]); remaining.delete(row[0]); } } return rows; }
function exactObjectKeys(value, keys, label) { check(value && typeof value === "object" && !Array.isArray(value) && stable(Object.keys(value).sort()) === stable([...keys].sort()), `${label} fields differ from the contract`); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function unwrapRows(value, key) { if (Array.isArray(value)) return value; if (Array.isArray(value?.[key])) return value[key]; if (Array.isArray(value?.Results)) return value.Results; if (Array.isArray(value?.results)) return value.results; return value?.[key] ? [value[key]] : []; }
function parseCubContext(text) { return { name: text.match(/^Context Name\s+(\S+)\s*$/mi)?.[1] ?? "", organizationExternalID: text.match(/^Organization ID\s+([0-9a-f-]+)\s*$/mi)?.[1] ?? "", organizationName: text.match(/^Organization Name\s+(.+?)\s*$/mi)?.[1]?.trim() ?? "", serverURL: text.match(/^Server URL\s+(\S+)\s*$/mi)?.[1]?.replace(/\/$/, "") ?? "" }; }
function deterministicUUID(seed) { const hex = sha256(seed); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
function clone(value) { return value == null ? value : structuredClone(value); }
function mapSnapshot(map) { return [...map.entries()].map(([key, value]) => [key, clone(value)]); }
function mapRestore(map, snapshot) { map.clear(); for (const [key, value] of snapshot) map.set(key, clone(value)); }
function expectFailure(fn, pattern, label) { let error = null; try { fn(); } catch (value) { error = value; } check(error && pattern.test(error.message), `${label} did not fail as expected`); }
function required(name) { const index = argv.indexOf(name); check(index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--"), `${name} is required`); return argv[index + 1]; }
function usage() { console.log("Usage: node scripts/run-kubara-app-release.mjs --execute|--verify-acceptance --request <release.yaml> --output <compiled-directory> --acceptance-evidence <evidence.json>\n       node scripts/run-kubara-app-release.mjs --self-test"); }
