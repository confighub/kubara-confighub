#!/usr/bin/env node

// Offline verifier for the Kubara mini-IDP performance acceptance contract.
//
// The contract deliberately treats subprocess commands, authenticated
// transport requests, state-changing mutations, and controller waits as
// different things. --receipt-verify performs no network or live-cluster I/O.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  check,
  readYaml,
  repoRoot,
  sha256File,
} from "./lib/proof-common.mjs";

const CONTRACT_PATH = join(repoRoot, "data", "kubara-mini-idp-performance", "contract.yaml");
const DEFAULT_RECEIPT_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "receipt.yaml");
const DEFAULT_ORPHAN_RECEIPT_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "orphan-audit.yaml");
const DEFAULT_ATTEMPT_LEDGER_PATH = join(repoRoot, "runs", "kubara-mini-idp-reconcile", "attempts.yaml");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CORE_CONFIGHUB_FINGERPRINT_RESOURCES = Object.freeze(["space", "unit", "release", "link", "target"]);
const FULL_CONFIGHUB_FINGERPRINT_RESOURCES = Object.freeze([...CORE_CONFIGHUB_FINGERPRINT_RESOURCES, "trigger", "filter", "tag"]);
const MODES = new Set(["--contract", "--receipt-verify", "--self-test"]);
const requestedModes = process.argv.filter((arg) => MODES.has(arg));
check(requestedModes.length <= 1, `choose one mode: ${[...MODES].join(", ")}`);
const mode = requestedModes[0] ?? "--contract";
validateArgs();

const contract = readYaml(CONTRACT_PATH);
verifyContract(contract);

if (mode === "--contract") {
  console.log("Kubara mini-IDP performance acceptance contract verified");
} else if (mode === "--receipt-verify") {
  const receiptPath = optionValue("--receipt")
    ? resolve(optionValue("--receipt"))
    : DEFAULT_RECEIPT_PATH;
  const orphanReceiptPath = optionValue("--orphan-receipt")
    ? resolve(optionValue("--orphan-receipt"))
    : DEFAULT_ORPHAN_RECEIPT_PATH;
  check(existsSync(receiptPath), `${receiptPath} is missing`);
  check(existsSync(orphanReceiptPath), `${orphanReceiptPath} is missing`);
  check(existsSync(DEFAULT_ATTEMPT_LEDGER_PATH), `${DEFAULT_ATTEMPT_LEDGER_PATH} is missing`);
  verifyAcceptedPair(
    readYaml(receiptPath),
    readYaml(orphanReceiptPath),
    contract,
    sha256File(orphanReceiptPath),
    readYaml(DEFAULT_ATTEMPT_LEDGER_PATH),
    sha256File(DEFAULT_ATTEMPT_LEDGER_PATH),
  );
  console.log(`Kubara mini-IDP changed/idempotent performance pair verified: ${receiptPath}`);
} else {
  selfTest(contract);
  console.log("Kubara mini-IDP performance acceptance self-test passed");
}

function validateArgs() {
  const valueOptions = new Set(["--receipt", "--orphan-receipt"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (MODES.has(arg)) continue;
    check(valueOptions.has(arg), `unknown argument ${arg}`);
    check(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${arg} requires a value`);
    index += 1;
  }
  if (mode !== "--receipt-verify") {
    check(!process.argv.includes("--receipt") && !process.argv.includes("--orphan-receipt"), "receipt paths require --receipt-verify");
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function verifyContract(value) {
  check(value?.kind === "KubaraMiniIDPPerformanceAcceptance", "performance contract kind drifted");
  const spec = value.spec ?? {};
  check(spec.fixture?.id === "kubara-v0-13-0-four-cluster-warm-v1", "performance fixture ID drifted");
  check(spec.fixture?.managedUnits === 63 && spec.fixture?.deployments === 27, "performance fixture cardinality drifted");
  check(spec.fixture?.clusters === 4 && spec.fixture?.spaces === 55, "performance fixture topology drifted");

  const baseline = spec.rejectedBaseline ?? {};
  check(baseline.evidenceType === "failed-process-exit-profile", "baseline must remain failure evidence");
  check(baseline.acceptedAsSuccessfulRun === false, "failed baseline must never be accepted as a successful run");
  check(baseline.wallElapsedMs === 1541558, "failed baseline wall time drifted");
  check(baseline.subprocesses?.calls === 1372, "failed baseline subprocess count drifted");
  const metadataRows = baseline.confighub?.metadataDiscoveryReadCommands?.byVerb ?? [];
  const contentRows = baseline.confighub?.contentReadCommands?.byVerb ?? [];
  check(sum(metadataRows, "calls") === 658, "failed baseline metadata-discovery count drifted");
  check(sum(contentRows, "calls") === 208, "failed baseline content-read count drifted");
  check(baseline.confighub?.knownReadCommands?.calls === 866, "failed baseline known-read count drifted");
  check(sum(metadataRows, "calls") + sum(contentRows, "calls") === baseline.confighub.knownReadCommands.calls, "failed baseline read accounting is inconsistent");
  check(baseline.confighub?.knownMutationCommands?.completeness === "partial-one-verb-only", "baseline must not present unit.update as all mutations");
  check(rowCalls(baseline.confighub.knownMutationCommands.byVerb, "cub.unit.update") === 20, "failed baseline unit.update count drifted");
  check(baseline.waits?.explicitSleepElapsedMs === 866701, "failed baseline explicit sleep time drifted");
  check(baseline.waits?.unclassifiedByReason === true, "old wait evidence must remain explicitly unclassified");
  check(baseline.derived?.wallOutsideExplicitSleepMs === 674857, "failed baseline non-sleep wall time drifted");
  check(baseline.disposition === "rejected-as-performance-evidence", "failed baseline disposition drifted");

  check(spec.receiptSchema?.schemaVersion === 2, "performance receipt schema must be v2");
  const allowedWaitReasons = spec.receiptSchema?.allowedWaitReasons ?? [];
  check(allowedWaitReasons.length >= 7 && new Set(allowedWaitReasons).size === allowedWaitReasons.length, "allowed wait reasons are incomplete or duplicated");
  check(spec.receiptSchema?.commandSemantics?.includes("not wire-request counts"), "contract must distinguish subprocesses from wire requests");

  const profiles = new Map((spec.profiles ?? []).map((profile) => [profile.id, profile]));
  check(profiles.size === 2 && profiles.has("changed-apply") && profiles.has("idempotent-apply"), "performance profiles must be changed then idempotent");
  const changed = profiles.get("changed-apply").budgets;
  const noop = profiles.get("idempotent-apply").budgets;
  check(changed.maximumWallElapsedMs === 900000, "changed-apply wall budget drifted");
  check(changed.maximumSubprocessCalls === 650, "changed-apply subprocess budget drifted");
  check(changed.maximumConfigHubReadCommandsBeforeFirstDevAccepted === 96, "changed-apply reads through first dev acceptance must stay below 100");
  check(changed.maximumUnclassifiedExplicitWaitMs === 0, "changed-apply may not contain unclassified waits");
  check(noop.maximumWallElapsedMs === 300000, "idempotent wall budget drifted");
  check(noop.maximumSubprocessCalls === 220, "idempotent subprocess budget drifted");
  check(noop.maximumConfigHubReadCommands === 96, "idempotent ConfigHub read budget must stay below 100");
  check(noop.maximumConfigHubReadCommandsBeforeFirstDevAccepted === 96, "idempotent reads through first dev acceptance must stay below 100");
  check(noop.exactSuccessfulConfigHubMutations === 0 && noop.exactConfigHubMutationAttempts === 0, "idempotent run must attempt no ConfigHub writes");
  check(noop.exactArgoSyncRequests === 0, "idempotent run must request no Argo sync");
  check(noop.byVerbMaximums?.["cub.unit.get"] === 0 && noop.byVerbMaximums?.["cub.target.get"] === 0, "idempotent point metadata reads must remain eliminated");
  check(
    noop.byVerbMaximums?.["cub.unit.list"] === 36
      && noop.byVerbMaximums?.["cub.release.list"] === 36
      && noop.byVerbMaximums?.["cub.space.list"] === 4
      && noop.byVerbMaximums?.["cub.link.list"] === 4
      && noop.byVerbMaximums?.["cub.target.list"] === 4
      && noop.byVerbMaximums?.["cub.space.get"] === 1,
    "idempotent per-verb ceilings do not match the 31-stream plus four-snapshot design",
  );
  check(changed.byVerbMaximums?.["cub.unit.data"] === 0 && noop.byVerbMaximums?.["cub.unit.data"] === 0, "per-Unit content reads must remain eliminated");
  check(spec.pairAcceptance?.order?.join("/") === "changed-apply/idempotent-apply", "accepted pair order drifted");
  check(spec.pairAcceptance?.sameExecutionFingerprint === true && spec.pairAcceptance?.secondMustBeImmediateNextRun === true, "accepted pair identity/order boundary drifted");
  check(spec.pairAcceptance?.orphanAuditRequired === true, "performance acceptance must retain the orphan audit");
  check((spec.publication?.forbiddenWithoutClientTransportEvidence ?? []).some((item) => item.includes("authenticated HTTP")), "contract must forbid an unmeasured HTTP-round-trip claim");
}

function verifyAcceptedPair(receipt, orphanReceipt, contractValue, orphanReceiptSha256, attemptLedger, attemptLedgerSha256) {
  check(receipt?.kind === "ConfigHubKubaraMiniIDPReconcileReceipt", "unexpected mini-IDP receipt kind");
  check(receipt.status?.performanceResult === "performance-pass", "mini-IDP receipt performance status is not performance-pass");
  const runs = receipt.spec?.reconcileRuns ?? [];
  check(runs.length >= 2, "mini-IDP receipt lacks a changed/idempotent performance pair");
  const [changed, noop] = runs.slice(-2);
  check(changed.result === "pass" && noop.result === "pass", "performance pair contains a failed reconcile run");
  check(changed.idempotentNoop === false && changed.actionCount > 0, "first performance run is not a changed apply");
  check(noop.idempotentNoop === true && noop.actionCount === 0, "second performance run is not an idempotent no-op");
  check(changed.executionFingerprint && changed.executionFingerprint === noop.executionFingerprint, "performance pair execution fingerprints differ");
  check(
    SHA256_PATTERN.test(changed.finalConfigHubFingerprint ?? "")
      && changed.finalConfigHubFingerprint === noop.finalConfigHubFingerprint,
    "performance pair final ConfigHub fingerprints differ or are invalid",
  );
  const finalSnapshot = receipt.spec?.finalConfigHubSnapshot ?? {};
  check(
    JSON.stringify(finalSnapshot.resources) === JSON.stringify(CORE_CONFIGHUB_FINGERPRINT_RESOURCES)
      && finalSnapshot.fingerprint === noop.finalConfigHubFingerprint
      && finalSnapshot.sourceRunAttemptID === noop.attemptID
      && finalSnapshot.sourceRunClass === "idempotent-apply",
    "receipt final ConfigHub snapshot is not bound to the accepted no-op run",
  );
  check(validDate(changed.observedAt) && validDate(noop.observedAt), "performance pair timestamps are invalid");
  check(Date.parse(changed.observedAt) < Date.parse(noop.observedAt), "idempotent performance run is not immediately after the changed run");
  verifyAttemptContinuity(receipt, changed, noop, attemptLedger, attemptLedgerSha256);

  const profiles = new Map(contractValue.spec.profiles.map((profile) => [profile.id, profile]));
  verifyRunPerformance(changed, profiles.get("changed-apply"), contractValue);
  verifyRunPerformance(noop, profiles.get("idempotent-apply"), contractValue);
  verifyOrphanReceipt(orphanReceipt, receipt, noop, orphanReceiptSha256);
}

function verifyAttemptContinuity(receipt, changed, noop, ledger, ledgerSha256) {
  check(ledger?.kind === "KubaraMiniIDPApplyAttemptLedger", "unexpected mini-IDP apply attempt ledger kind");
  check(Array.isArray(ledger.attempts) && ledger.attempts.length >= 2, "mini-IDP apply attempt ledger is incomplete");
  check(Number.isInteger(changed.attemptSequence) && Number.isInteger(noop.attemptSequence), "performance pair lacks durable attempt sequences");
  check(noop.attemptSequence === changed.attemptSequence + 1, "performance pair has an intervening apply attempt");
  const changedAttempt = ledger.attempts.find((item) => item.sequence === changed.attemptSequence);
  const noopAttempt = ledger.attempts.find((item) => item.sequence === noop.attemptSequence);
  check(
    changedAttempt?.id === changed.attemptID
      && noopAttempt?.id === noop.attemptID
      && changedAttempt.result === "pass"
      && noopAttempt.result === "pass",
    "performance pair is not backed by two passing durable attempts",
  );
  check(
    changedAttempt.executionFingerprint === changed.executionFingerprint
      && noopAttempt.executionFingerprint === noop.executionFingerprint,
    "performance pair attempt fingerprints drifted",
  );
  check(ledger.attempts.at(-1)?.sequence === noop.attemptSequence, "a later apply attempt invalidates the performance pair");
  check(
    receipt.status?.performanceAcceptance?.applyAttemptLedgerSha256 === `sha256:${ledgerSha256}`,
    "performance acceptance is not bound to the current apply attempt ledger",
  );
}

function verifyRunPerformance(run, profile, contractValue) {
  const evidence = run.performance ?? {};
  const budgets = profile.budgets;
  check(evidence.schemaVersion === contractValue.spec.receiptSchema.schemaVersion, `${profile.id}: performance schema drifted`);
  check(evidence.fixtureID === contractValue.spec.fixture.id, `${profile.id}: fixture ID drifted`);
  check(evidence.runClass === profile.id, `${profile.id}: run class drifted`);
  integerAtLeast(evidence.wallElapsedMs, 0, `${profile.id}: wallElapsedMs`);
  check(evidence.wallElapsedMs <= budgets.maximumWallElapsedMs, `${profile.id}: wall time ${evidence.wallElapsedMs}ms exceeds ${budgets.maximumWallElapsedMs}ms`);

  const subprocesses = evidence.subprocesses ?? {};
  integerAtLeast(subprocesses.calls, 0, `${profile.id}: subprocess calls`);
  integerAtLeast(subprocesses.unexpectedFailures, 0, `${profile.id}: unexpected command failures`);
  check(subprocesses.calls <= budgets.maximumSubprocessCalls, `${profile.id}: subprocess calls ${subprocesses.calls} exceed ${budgets.maximumSubprocessCalls}`);
  check(subprocesses.unexpectedFailures <= budgets.maximumUnexpectedCommandFailures, `${profile.id}: unexpected command failures exceed budget`);
  validateCommandRows(subprocesses.byVerb, `${profile.id}: subprocess rows`);
  check(sum(subprocesses.byVerb, "calls") === subprocesses.calls, `${profile.id}: subprocess row total is inconsistent`);

  const reads = evidence.confighub?.reads ?? {};
  integerAtLeast(reads.commands, 0, `${profile.id}: ConfigHub read commands`);
  integerAtLeast(reads.beforeFirstDevAcceptedCommands, 0, `${profile.id}: ConfigHub reads through first dev acceptance`);
  check(reads.commands <= budgets.maximumConfigHubReadCommands, `${profile.id}: ConfigHub read commands ${reads.commands} exceed ${budgets.maximumConfigHubReadCommands}`);
  check(reads.beforeFirstDevAcceptedCommands <= budgets.maximumConfigHubReadCommandsBeforeFirstDevAccepted, `${profile.id}: ConfigHub reads through first dev acceptance ${reads.beforeFirstDevAcceptedCommands} exceed ${budgets.maximumConfigHubReadCommandsBeforeFirstDevAccepted}`);
  check(reads.beforeFirstDevAcceptedCommands <= reads.commands, `${profile.id}: reads through first dev acceptance exceed total reads`);
  validateCommandRows(reads.byVerb, `${profile.id}: ConfigHub read rows`);
  check(sum(reads.byVerb, "calls") === reads.commands, `${profile.id}: ConfigHub read row total is inconsistent`);
  validateReadPurposeRows(reads.byPurpose, `${profile.id}: ConfigHub read purpose rows`);
  check(sum(reads.byPurpose, "commands") === reads.commands, `${profile.id}: ConfigHub read purpose total is inconsistent`);
  for (const [verb, maximum] of Object.entries(budgets.byVerbMaximums ?? {})) {
    check(rowCalls(reads.byVerb, verb) <= maximum, `${profile.id}: ${verb} calls ${rowCalls(reads.byVerb, verb)} exceed ${maximum}`);
  }

  const mutations = evidence.confighub?.mutations ?? {};
  for (const field of ["attempts", "succeeded", "expectedRefusals", "unexpectedFailures", "unattributedSucceeded"]) {
    integerAtLeast(mutations[field], 0, `${profile.id}: ConfigHub mutation ${field}`);
  }
  validateMutationRows(mutations.byVerb, `${profile.id}: ConfigHub mutation rows`);
  check(sum(mutations.byVerb, "attempts") === mutations.attempts, `${profile.id}: mutation attempt total is inconsistent`);
  check(sum(mutations.byVerb, "succeeded") === mutations.succeeded, `${profile.id}: successful mutation total is inconsistent`);
  check(sum(mutations.byVerb, "attributedSucceeded") === mutations.succeeded - mutations.unattributedSucceeded, `${profile.id}: successful mutation action attribution is inconsistent`);
  check(sum(mutations.byVerb, "expectedRefusals") === mutations.expectedRefusals, `${profile.id}: expected-refusal total is inconsistent`);
  check(sum(mutations.byVerb, "unexpectedFailures") === mutations.unexpectedFailures, `${profile.id}: unexpected mutation failure total is inconsistent`);
  check(mutations.attempts === mutations.succeeded + mutations.expectedRefusals + mutations.unexpectedFailures, `${profile.id}: mutation outcome accounting is inconsistent`);
  check(mutations.unexpectedFailures <= budgets.maximumUnexpectedMutationFailures, `${profile.id}: unexpected mutation failures exceed budget`);
  check(mutations.unattributedSucceeded <= budgets.maximumUnattributedSuccessfulMutations, `${profile.id}: successful mutations lack exact action attribution`);
  if (budgets.exactSuccessfulConfigHubMutations !== undefined) check(mutations.succeeded === budgets.exactSuccessfulConfigHubMutations, `${profile.id}: successful ConfigHub mutations are not exactly ${budgets.exactSuccessfulConfigHubMutations}`);
  if (budgets.exactConfigHubMutationAttempts !== undefined) check(mutations.attempts === budgets.exactConfigHubMutationAttempts, `${profile.id}: ConfigHub mutation attempts are not exactly ${budgets.exactConfigHubMutationAttempts}`);

  const waits = evidence.waits ?? {};
  integerAtLeast(waits.explicitElapsedMs, 0, `${profile.id}: explicit wait time`);
  integerAtLeast(waits.unclassifiedExplicitMs, 0, `${profile.id}: unclassified wait time`);
  check(waits.explicitElapsedMs <= budgets.maximumExplicitWaitElapsedMs, `${profile.id}: explicit waits ${waits.explicitElapsedMs}ms exceed ${budgets.maximumExplicitWaitElapsedMs}ms`);
  check(waits.unclassifiedExplicitMs <= budgets.maximumUnclassifiedExplicitWaitMs, `${profile.id}: unclassified explicit wait time is forbidden`);
  validateWaitRows(waits.byReason, contractValue.spec.receiptSchema.allowedWaitReasons, `${profile.id}: wait rows`);
  check(sum(waits.byReason, "elapsedMs") === waits.explicitElapsedMs, `${profile.id}: explicit wait row total is inconsistent`);

  const milestones = evidence.milestones ?? {};
  integerAtLeast(milestones.preArgoWallElapsedMs, 0, `${profile.id}: pre-Argo wall time`);
  integerAtLeast(milestones.firstArgoAcceptedMs, 0, `${profile.id}: first accepted Argo time`);
  check(milestones.firstArgoAcceptedCluster === "hx-app-dev", `${profile.id}: first accepted Argo cluster is not hx-app-dev`);
  check(milestones.preArgoWallElapsedMs <= budgets.maximumPreArgoWallElapsedMs, `${profile.id}: pre-Argo wall time ${milestones.preArgoWallElapsedMs}ms exceeds ${budgets.maximumPreArgoWallElapsedMs}ms`);
  check(milestones.preArgoWallElapsedMs <= milestones.firstArgoAcceptedMs, `${profile.id}: first Argo acceptance predates convergence start`);
  check(milestones.firstArgoAcceptedMs <= evidence.wallElapsedMs, `${profile.id}: first Argo acceptance exceeds run wall time`);

  integerAtLeast(evidence.argo?.syncRequests, 0, `${profile.id}: Argo sync requests`);
  if (budgets.exactArgoSyncRequests !== undefined) check(evidence.argo.syncRequests === budgets.exactArgoSyncRequests, `${profile.id}: Argo sync requests are not exactly ${budgets.exactArgoSyncRequests}`);
}

function verifyOrphanReceipt(orphanReceipt, reconcileReceipt, noopRun, orphanReceiptSha256) {
  check(orphanReceipt?.kind === "KubaraMiniIDPOrphanAuditReceipt", "unexpected orphan audit receipt kind");
  check(orphanReceipt.status?.result === "pass", "orphan audit did not pass");
  check(orphanReceipt.status?.findingCount === 0, "orphan audit contains findings");
  const counts = orphanReceipt.status?.orphanCounts ?? {};
  check(Object.keys(counts).length > 0 && Object.values(counts).every((value) => value === 0), "orphan audit contains a non-zero orphan count");
  check(validDate(orphanReceipt.spec?.observedAt), "orphan audit observedAt is invalid");
  check(Date.parse(noopRun.observedAt) < Date.parse(orphanReceipt.spec.observedAt), "orphan audit does not postdate the accepted no-op run");
  const snapshot = orphanReceipt.spec?.configHubInventory?.snapshot ?? {};
  const brackets = orphanReceipt.spec?.execution?.organizationWideReadBrackets ?? {};
  check(
    JSON.stringify(snapshot.coreResources) === JSON.stringify(CORE_CONFIGHUB_FINGERPRINT_RESOURCES)
      && JSON.stringify(snapshot.fullResources) === JSON.stringify(FULL_CONFIGHUB_FINGERPRINT_RESOURCES)
      && SHA256_PATTERN.test(snapshot.coreFiveResourceFingerprint ?? "")
      && SHA256_PATTERN.test(snapshot.fullEightResourceFingerprint ?? "")
      && brackets.stable === true
      && brackets.openingCoreFiveResourceFingerprint === snapshot.coreFiveResourceFingerprint
      && brackets.closingCoreFiveResourceFingerprint === snapshot.coreFiveResourceFingerprint
      && brackets.openingFullEightResourceFingerprint === snapshot.fullEightResourceFingerprint
      && brackets.closingFullEightResourceFingerprint === snapshot.fullEightResourceFingerprint,
    "orphan audit five-/eight-resource ConfigHub snapshot evidence is invalid or unstable",
  );
  check(
    brackets.openingCoreFiveResourceFingerprint === noopRun.finalConfigHubFingerprint,
    "orphan audit opening five-resource snapshot does not equal the accepted no-op final state",
  );
  const binding = reconcileReceipt.status?.performanceAcceptance ?? {};
  check(binding.orphanObservedAt === orphanReceipt.spec.observedAt, "performance acceptance is not bound to this orphan audit observation");
  check(binding.reconcilerSha256 === orphanReceipt.spec?.source?.reconcilerSha256, "performance acceptance reconciler binding drifted");
  check(binding.reconcilePlanSha256 === orphanReceipt.spec?.source?.reconcilePlanSha256, "performance acceptance plan binding drifted");
  check(binding.applyAttemptLedgerSha256 === orphanReceipt.spec?.source?.applyAttemptLedgerSha256, "performance acceptance attempt-ledger binding drifted");
  check(binding.finalConfigHubFingerprint === noopRun.finalConfigHubFingerprint, "performance acceptance final ConfigHub fingerprint binding drifted");
  check(binding.orphanReceiptSha256 === `sha256:${orphanReceiptSha256}`, "performance acceptance orphan receipt digest does not match this audit receipt");
}

function validateCommandRows(rows, prefix) {
  check(Array.isArray(rows), `${prefix} are missing`);
  const verbs = rows.map((row) => row.verb);
  check(new Set(verbs).size === verbs.length, `${prefix} contain duplicate verbs`);
  check(JSON.stringify(verbs) === JSON.stringify([...verbs].sort()), `${prefix} are not sorted`);
  for (const row of rows) {
    check(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,2}$/.test(row.verb ?? ""), `${prefix} contain an unsafe verb`);
    integerAtLeast(row.calls, 1, `${prefix} ${row.verb} calls`);
  }
}

function validateMutationRows(rows, prefix) {
  check(Array.isArray(rows), `${prefix} are missing`);
  const verbs = rows.map((row) => row.verb);
  check(new Set(verbs).size === verbs.length, `${prefix} contain duplicate verbs`);
  check(JSON.stringify(verbs) === JSON.stringify([...verbs].sort()), `${prefix} are not sorted`);
  for (const row of rows) {
    check(/^cub\.[a-z0-9-]+\.[a-z0-9-]+$/.test(row.verb ?? ""), `${prefix} contain an unsafe verb`);
    for (const field of ["attempts", "succeeded", "attributedSucceeded", "expectedRefusals", "unexpectedFailures"]) integerAtLeast(row[field], 0, `${prefix} ${row.verb} ${field}`);
    check(row.attributedSucceeded <= row.succeeded, `${prefix} ${row.verb} attributes more successful mutations than occurred`);
    check(row.attempts > 0, `${prefix} ${row.verb} has no attempts`);
    check(row.attempts === row.succeeded + row.expectedRefusals + row.unexpectedFailures, `${prefix} ${row.verb} outcome accounting is inconsistent`);
  }
}

function validateReadPurposeRows(rows, prefix) {
  const expected = ["content", "metadata-discovery", "mutation-target-pin"];
  check(Array.isArray(rows), `${prefix} are missing`);
  check(JSON.stringify(rows.map((row) => row.purpose)) === JSON.stringify(expected), `${prefix} do not cover the exact purpose taxonomy`);
  for (const row of rows) {
    integerAtLeast(row.commands, 0, `${prefix} ${row.purpose} commands`);
    validateCommandRows(row.byVerb, `${prefix} ${row.purpose} command rows`);
    check(sum(row.byVerb, "calls") === row.commands, `${prefix} ${row.purpose} command total is inconsistent`);
  }
}

function validateWaitRows(rows, allowedReasons, prefix) {
  check(Array.isArray(rows), `${prefix} are missing`);
  const reasons = rows.map((row) => row.reason);
  check(new Set(reasons).size === reasons.length, `${prefix} contain duplicate reasons`);
  check(JSON.stringify(reasons) === JSON.stringify([...reasons].sort()), `${prefix} are not sorted`);
  for (const row of rows) {
    check(allowedReasons.includes(row.reason), `${prefix} contain unclassified reason ${row.reason}`);
    integerAtLeast(row.calls, 1, `${prefix} ${row.reason} calls`);
    integerAtLeast(row.requestedMs, 0, `${prefix} ${row.reason} requestedMs`);
    integerAtLeast(row.elapsedMs, 0, `${prefix} ${row.reason} elapsedMs`);
  }
}

function integerAtLeast(value, minimum, prefix) {
  check(Number.isInteger(value) && value >= minimum, `${prefix} is invalid`);
}

function rowCalls(rows, verb) {
  return rows?.find((row) => row.verb === verb)?.calls ?? 0;
}

function sum(rows, field) {
  return (rows ?? []).reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function selfTest(contractValue) {
  const receipt = selfTestReceipt(contractValue);
  const orphan = selfTestOrphanReceipt();
  const orphanDigest = "d".repeat(64);
  const ledger = selfTestAttemptLedger(receipt);
  const ledgerDigest = "e".repeat(64);
  verifyAcceptedPair(receipt, orphan, contractValue, orphanDigest, ledger, ledgerDigest);

  expectFailure(() => {
    const value = structuredClone(receipt);
    const noop = value.spec.reconcileRuns[1];
    noop.performance.confighub.mutations = {
      attempts: 1,
      succeeded: 1,
      expectedRefusals: 0,
      unexpectedFailures: 0,
      unattributedSucceeded: 0,
      byVerb: [{ verb: "cub.unit.update", attempts: 1, succeeded: 1, attributedSucceeded: 1, expectedRefusals: 0, unexpectedFailures: 0 }],
    };
    verifyAcceptedPair(value, orphan, contractValue, orphanDigest, ledger, ledgerDigest);
  }, "successful ConfigHub mutations are not exactly 0");

  expectFailure(() => {
    const value = structuredClone(receipt);
    value.spec.reconcileRuns[1].performance.confighub.reads.beforeFirstDevAcceptedCommands = 97;
    verifyAcceptedPair(value, orphan, contractValue, orphanDigest, ledger, ledgerDigest);
  }, "ConfigHub reads through first dev acceptance 97 exceed 96");

  expectFailure(() => {
    const value = structuredClone(receipt);
    const noop = value.spec.reconcileRuns[1].performance;
    noop.waits.unclassifiedExplicitMs = 1;
    verifyAcceptedPair(value, orphan, contractValue, orphanDigest, ledger, ledgerDigest);
  }, "unclassified explicit wait time is forbidden");

  expectFailure(() => {
    const value = structuredClone(receipt);
    value.spec.reconcileRuns.reverse();
    verifyAcceptedPair(value, orphan, contractValue, orphanDigest, ledger, ledgerDigest);
  }, "first performance run is not a changed apply");

  expectFailure(() => {
    const value = structuredClone(orphan);
    const drifted = `sha256:${"9".repeat(64)}`;
    value.spec.configHubInventory.snapshot.coreFiveResourceFingerprint = drifted;
    value.spec.execution.organizationWideReadBrackets.openingCoreFiveResourceFingerprint = drifted;
    value.spec.execution.organizationWideReadBrackets.closingCoreFiveResourceFingerprint = drifted;
    verifyAcceptedPair(receipt, value, contractValue, orphanDigest, ledger, ledgerDigest);
  }, "opening five-resource snapshot does not equal the accepted no-op final state");
}

function selfTestReceipt(contractValue) {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const finalConfigHubFingerprint = `sha256:${"f".repeat(64)}`;
  const changedAttemptID = "00000000-0000-4000-8000-000000000001";
  const noopAttemptID = "00000000-0000-4000-8000-000000000002";
  return {
    kind: "ConfigHubKubaraMiniIDPReconcileReceipt",
    spec: {
      reconcileRuns: [
        {
          observedAt: "2026-08-05T10:00:00.000Z",
          attemptSequence: 1,
          attemptID: changedAttemptID,
          executionFingerprint: fingerprint,
          finalConfigHubFingerprint,
          actionCount: 12,
          result: "pass",
          idempotentNoop: false,
          performance: selfTestPerformance("changed-apply", contractValue),
        },
        {
          observedAt: "2026-08-05T10:12:00.000Z",
          attemptSequence: 2,
          attemptID: noopAttemptID,
          executionFingerprint: fingerprint,
          finalConfigHubFingerprint,
          actionCount: 0,
          result: "pass",
          idempotentNoop: true,
          performance: selfTestPerformance("idempotent-apply", contractValue),
        },
      ],
      finalConfigHubSnapshot: {
        canonicalization: "stable-recursive-key-order-and-entity-row-order",
        fingerprintAlgorithm: "sha256",
        resources: [...CORE_CONFIGHUB_FINGERPRINT_RESOURCES],
        fingerprint: finalConfigHubFingerprint,
        sourceRunAttemptID: noopAttemptID,
        sourceRunClass: "idempotent-apply",
      },
    },
    status: {
      performanceResult: "performance-pass",
      performanceAcceptance: {
        orphanReceiptSha256: `sha256:${"d".repeat(64)}`,
        orphanObservedAt: "2026-08-05T10:13:00.000Z",
        reconcilerSha256: `sha256:${"b".repeat(64)}`,
        reconcilePlanSha256: `sha256:${"c".repeat(64)}`,
        applyAttemptLedgerSha256: `sha256:${"e".repeat(64)}`,
        finalConfigHubFingerprint,
      },
    },
  };
}

function selfTestAttemptLedger(receipt) {
  return {
    kind: "KubaraMiniIDPApplyAttemptLedger",
    attempts: receipt.spec.reconcileRuns.map((run) => ({
      sequence: run.attemptSequence,
      id: run.attemptID,
      executionFingerprint: run.executionFingerprint,
      result: "pass",
    })),
  };
}

function selfTestPerformance(runClass, contractValue) {
  const changed = runClass === "changed-apply";
  const reads = changed
    ? [
        { verb: "cub.link.list", calls: 8 },
        { verb: "cub.space.get", calls: 4 },
        { verb: "cub.space.list", calls: 8 },
        { verb: "cub.target.get", calls: 4 },
        { verb: "cub.unit.list", calls: 12 },
      ]
    : [
        { verb: "cub.link.list", calls: 4 },
        { verb: "cub.space.get", calls: 1 },
        { verb: "cub.space.list", calls: 4 },
        { verb: "cub.unit.list", calls: 4 },
      ];
  const mutations = changed
    ? [{ verb: "cub.unit.update", attempts: 12, succeeded: 12, attributedSucceeded: 12, expectedRefusals: 0, unexpectedFailures: 0 }]
    : [];
  const waitRows = changed
    ? [{ reason: "argo-health-pending", calls: 20, requestedMs: 100000, elapsedMs: 100000 }]
    : [];
  const subprocessRows = [
    ...reads,
    ...(changed ? [{ verb: "cub.unit.update", calls: 12 }] : []),
    ...(changed ? [{ verb: "sleep.wait", calls: 20 }] : []),
  ].sort((left, right) => left.verb.localeCompare(right.verb));
  const subprocessCalls = sum(subprocessRows, "calls");
  return {
    schemaVersion: contractValue.spec.receiptSchema.schemaVersion,
    fixtureID: contractValue.spec.fixture.id,
    runClass,
    wallElapsedMs: changed ? 600000 : 180000,
    subprocesses: {
      calls: subprocessCalls,
      unexpectedFailures: 0,
      byVerb: subprocessRows,
    },
    confighub: {
      reads: {
        commands: sum(reads, "calls"),
        beforeFirstDevAcceptedCommands: changed ? 30 : 10,
        byVerb: reads,
        byPurpose: [
          { purpose: "content", commands: 0, byVerb: [] },
          { purpose: "metadata-discovery", commands: sum(reads, "calls"), byVerb: reads },
          { purpose: "mutation-target-pin", commands: 0, byVerb: [] },
        ],
      },
      mutations: {
        attempts: sum(mutations, "attempts"),
        succeeded: sum(mutations, "succeeded"),
        expectedRefusals: sum(mutations, "expectedRefusals"),
        unexpectedFailures: sum(mutations, "unexpectedFailures"),
        unattributedSucceeded: 0,
        byVerb: mutations,
      },
    },
    waits: {
      explicitElapsedMs: sum(waitRows, "elapsedMs"),
      unclassifiedExplicitMs: 0,
      byReason: waitRows,
    },
    milestones: {
      preArgoWallElapsedMs: changed ? 110000 : 85000,
      firstArgoAcceptedMs: changed ? 180000 : 100000,
      firstArgoAcceptedCluster: "hx-app-dev",
    },
    argo: { syncRequests: changed ? 8 : 0 },
  };
}

function selfTestOrphanReceipt() {
  const coreFingerprint = `sha256:${"f".repeat(64)}`;
  const fullFingerprint = `sha256:${"7".repeat(64)}`;
  return {
    kind: "KubaraMiniIDPOrphanAuditReceipt",
    spec: {
      observedAt: "2026-08-05T10:13:00.000Z",
      source: {
        reconcilerSha256: `sha256:${"b".repeat(64)}`,
        reconcilePlanSha256: `sha256:${"c".repeat(64)}`,
        applyAttemptLedgerSha256: `sha256:${"e".repeat(64)}`,
      },
      execution: {
        organizationWideReadBrackets: {
          openingCoreFiveResourceFingerprint: coreFingerprint,
          closingCoreFiveResourceFingerprint: coreFingerprint,
          openingFullEightResourceFingerprint: fullFingerprint,
          closingFullEightResourceFingerprint: fullFingerprint,
          stable: true,
        },
      },
      configHubInventory: {
        snapshot: {
          coreResources: [...CORE_CONFIGHUB_FINGERPRINT_RESOURCES],
          fullResources: [...FULL_CONFIGHUB_FINGERPRINT_RESOURCES],
          coreFiveResourceFingerprint: coreFingerprint,
          fullEightResourceFingerprint: fullFingerprint,
        },
      },
    },
    status: {
      result: "pass",
      findingCount: 0,
      orphanCounts: {
        unexpectedConfigHubSpaces: 0,
        unexpectedConfigHubUnits: 0,
        unexpectedConfigHubLinks: 0,
        unexpectedConfigHubTargets: 0,
      },
    },
  };
}

function expectFailure(run, message) {
  let error = null;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  check(error?.message?.includes(message), `self-test expected failure containing ${message}, got ${error?.message ?? "no failure"}`);
}
