#!/usr/bin/env node

// ConfigHub-managed Argo app-rollout proof.
//
// Proves that ConfigHub, via "cub cluster up" + argobot, owns Argo CD across a
// fleet and rolls out, promotes, and rolls back an app. The live run is
// operator-driven (four kind clusters); this script validates the committed
// receipt (--verify / --generate) and prints the reproducible runbook (--run).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { check, readYaml, relativeRepo, repoRoot } from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const known = ["--run", "--generate", "--verify"];
if (!known.includes(mode)) {
  console.error(`Unknown mode ${mode}. Use one of: ${known.join(", ")}`);
  process.exit(2);
}

const receiptPath = join(
  repoRoot,
  "runs",
  "kubara-app-rollout-proof",
  "receipt.yaml",
);

const EXPECTED = {
  clusterRoles: ["dev", "staging", "prod", "prod"],
  spaceSlugs: [
    "hx-web-base",
    "hx-web-dev",
    "hx-web-staging",
    "hx-web-prod-a",
    "hx-web-prod-b",
  ],
  variantOf: {
    "hx-web-base": "",
    "hx-web-dev": "hx-web-base",
    "hx-web-staging": "hx-web-dev",
    "hx-web-prod-a": "hx-web-staging",
    "hx-web-prod-b": "hx-web-staging",
  },
  digestSpaces: ["hx-web-dev", "hx-web-staging", "hx-web-prod-a", "hx-web-prod-b"],
  stepIds: [
    "initial-rollout",
    "namespace-as-config",
    "fleet-promotion",
    "rollback",
    "staging-sandbox-departure",
    "departure-survives-promotion",
  ],
};

const RUNBOOK = `Reproduce the live proof (operator-driven, four kind clusters):

  # 1. One cluster per environment. Each gets ConfigHub-owned Argo CD + argobot.
  cub cluster up --name hx-app-dev     --space hx-app-dev
  cub cluster up --name hx-app-staging --space hx-app-staging
  cub cluster up --name hx-app-prod-a  --space hx-app-prod-a
  cub cluster up --name hx-app-prod-b  --space hx-app-prod-b

  # 2. Author the base app (one resource per Unit): Namespace, Deployment, Service.
  cub space create hx-web-base --label Component=hx-web --label Layer=App
  cub unit create --space hx-web-base hx-web-namespace  namespace.yaml
  cub unit create --space hx-web-base hx-web-deployment deployment.yaml
  cub unit create --space hx-web-base hx-web-service    service.yaml

  # 3. Clone onto each cluster (auto-creates the Argo Application) and publish.
  cub variant create dev     hx-web-base    --target hx-app-dev/target     --namespace hx-web
  cub variant create staging hx-web-dev     --target hx-app-staging/target --namespace hx-web
  cub variant create prod-a  hx-web-staging --target hx-app-prod-a/target  --namespace hx-web \\
    --unit-delete-gate prod-critical --unit-destroy-gate prod-critical
  cub variant create prod-b  hx-web-staging --target hx-app-prod-b/target  --namespace hx-web \\
    --unit-delete-gate prod-critical --unit-destroy-gate prod-critical
  for s in hx-web-dev hx-web-staging hx-web-prod-a hx-web-prod-b; do cub release publish "$s"; done

  # 4. Promote a change across the fleet.
  cub function set --space hx-web-base --unit hx-web-deployment -- set-replicas 3
  cub variant promote hx-web-dev     && cub release publish hx-web-dev
  cub variant promote hx-web-staging && cub release publish hx-web-staging
  cub variant promote hx-web-prod-a  && cub release publish hx-web-prod-a
  cub variant promote hx-web-prod-b  && cub release publish hx-web-prod-b

  # 5. Roll one prod cluster back.
  cub unit update --space hx-web-prod-a hx-web-deployment --restore -1
  cub release publish hx-web-prod-a

  # 6. Optional staging-only sandbox connection (a per-Space departure).
  cub function set --space hx-web-staging --unit hx-web-deployment \\
    -- yq-i '.spec.template.spec.containers[0].env += [{"name":"SANDBOX_URL","value":"http://sandbox.hx-web.svc:8080"}]'
  cub release publish hx-web-staging

Then record the result into ${relativeRepo(receiptPath)} and run --verify.`;

function verifyReceipt(receipt) {
  check(
    receipt?.kind === "ConfigHubManagedArgoAppRolloutReceipt",
    "receipt kind is not ConfigHubManagedArgoAppRolloutReceipt",
  );
  const spec = receipt.spec ?? {};

  const roles = (spec.topology?.clusters ?? []).map((c) => c.role);
  check(
    JSON.stringify(roles) === JSON.stringify(EXPECTED.clusterRoles),
    `expected cluster roles ${EXPECTED.clusterRoles.join(",")}, got ${roles.join(",")}`,
  );

  const spaces = spec.spaces ?? [];
  const slugs = spaces.map((s) => s.slug);
  check(
    JSON.stringify(slugs) === JSON.stringify(EXPECTED.spaceSlugs),
    `expected spaces ${EXPECTED.spaceSlugs.join(",")}, got ${slugs.join(",")}`,
  );
  for (const s of spaces) {
    check(
      /^[0-9a-f-]{36}$/.test(s.id ?? ""),
      `space ${s.slug} is missing a UUID`,
    );
    check(
      (s.variantOf ?? "") === EXPECTED.variantOf[s.slug],
      `space ${s.slug} should be a variant of "${EXPECTED.variantOf[s.slug]}"`,
    );
  }

  const digests = spec.releaseDigests ?? {};
  for (const sp of EXPECTED.digestSpaces) {
    check(
      /^sha256:[0-9a-f]{64}$/.test(digests[sp] ?? ""),
      `release digest for ${sp} is missing or malformed`,
    );
  }

  const steps = spec.steps ?? [];
  const ids = steps.map((s) => s.id);
  for (const id of EXPECTED.stepIds) {
    check(ids.includes(id), `receipt is missing step "${id}"`);
  }
  for (const s of steps) {
    check(s.result === "pass", `step ${s.id} did not pass (result=${s.result})`);
  }

  const state = spec.finalFleetState ?? [];
  check(state.length === 4, `expected 4 final fleet rows, got ${state.length}`);
  const byCluster = Object.fromEntries(state.map((r) => [r.cluster, r]));
  check(
    byCluster.staging?.sandbox?.startsWith("http"),
    "staging should carry the sandbox connection",
  );
  for (const c of ["dev", "prod-a", "prod-b"]) {
    check(
      (byCluster[c]?.sandbox ?? "none") === "none",
      `${c} should not carry the staging-only sandbox`,
    );
  }
  check(
    byCluster["prod-a"]?.deploy === "2/2",
    "prod-a should show the rolled-back state 2/2",
  );

  check(receipt.status?.result === "pass", "receipt status.result is not pass");
  check(
    (receipt.status?.limits ?? []).length >= 3,
    "receipt should list its honest limits",
  );

  console.log(
    `verified kubara app-rollout receipt: ${slugs.length} space(s), ${steps.length} step(s), 4 cluster(s)`,
  );
}

if (mode === "--run") {
  console.log(RUNBOOK);
} else {
  check(
    existsSync(receiptPath),
    `${relativeRepo(receiptPath)} is missing; run the live proof and record it`,
  );
  verifyReceipt(readYaml(receiptPath));
}
