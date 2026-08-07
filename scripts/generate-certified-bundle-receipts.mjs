#!/usr/bin/env node
// Emits one CertifiedBundleReceipt per current-platform component, adopting the
// shared certified-bundle receipt spec. The spec's canonical home is the
// confighub/helm-expt repository (docs/reference/certified-bundle-spec.md
// there); the schema here at schemas/certified-bundle-receipt.schema.json is a
// byte-faithful copy so this repository stays verifiable on its own.
//
// Each receipt records the component definition exactly as committed: a
// per-file SHA-256 manifest, the digest index it belongs to
// (component-artifacts.yaml; the index format stays Kubara's own), the ingest
// contract, a static scan of the component's own files, and a flattening-safety
// lane. Where a wrapped chart version exactly matches a certified verdict in
// helm-expt, the lane is certified by citation; everywhere else it is
// provisional and says why. Output is a pure function of committed files.
// No network, no cluster, no wall clock.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  check,
  listFiles,
  relativeRepo,
  repoRoot,
  sha256File,
  toYaml,
  write,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--generate";

const OUT_DIR = join(repoRoot, "data", "certified-bundles");
const PLATFORM = "examples/kubara/current-platform";
const COMPONENTS_DIR = `${PLATFORM}/generated/platform-components/helm`;
const ARTIFACTS = `${PLATFORM}/component-artifacts.yaml`;
const GENERATION_RECEIPT = `${PLATFORM}/generation-receipt.yaml`;

const HELM_EXPT = "https://github.com/confighub/helm-expt";

// Certified verdicts in helm-expt, cited only on an exact chart+version match.
const VERDICTS = {
  "helm:jetstack/cert-manager@v1.21.0": {
    lane: "flatten-with-routes",
    path: "recipes/jetstack/cert-manager/v1.21.0/publication/flattening-safety-verdict.yaml",
  },
  "helm:external-secrets/external-secrets@2.8.0": {
    lane: "flatten-with-routes",
    path: "recipes/external-secrets/external-secrets/2.8.0/publication/flattening-safety-verdict.yaml",
  },
  "helm:prometheus-community/kube-prometheus-stack@87.19.2": {
    lane: "do-not-flatten",
    path: "recipes/prometheus-community/kube-prometheus-stack/87.19.2/publication/flattening-safety-verdict.yaml",
  },
  "helm:metrics-server/metrics-server@3.13.1": {
    lane: "safe-to-flatten",
    path: "recipes/metrics-server/metrics-server/3.13.1/publication/flattening-safety-verdict.yaml",
  },
  "helm:traefik/traefik@41.0.2": {
    lane: "flatten-with-routes",
    path: "recipes/traefik/traefik/41.0.2/publication/flattening-safety-verdict.yaml",
  },
};

// Per-component judgments the artifact index cannot express.
const COMPONENT_NOTES = {
  "kube-prometheus-stack": {
    openQuestions: [
      "the component also wraps prometheus-blackbox-exporter 11.15.1, which has no flattening-safety verdict yet",
    ],
  },
  "argo-cd": {
    provisionalLane: "do-not-flatten",
    provisionalWhy:
      "argo-cd 10.2.1 has no flattening-safety verdict yet; the chart family carries hooks and generated values, so the conservative lane holds until the audit decides",
    openQuestions: ["argo-cd 10.2.1 needs its flattening-safety verdict"],
  },
  "bootstrap-crds": {
    lane: "flatten-with-routes",
    certifiedBy:
      "the cert-manager v1.21.0, kube-prometheus-stack 87.19.2, and external-secrets 2.8.0 verdicts in confighub/helm-expt, whose CRD-ordering dispositions this component implements",
    notes:
      "This component is Kubara's implementation of the CRD ordering route: it delivers the CRD subsets of three audited charts ahead of their controllers, which is exactly the companion artifact those verdicts require.",
  },
  "homer-dashboard": {
    provisionalLane: "safe-to-flatten",
    provisionalWhy:
      "a first-party chart with no audited upstream; the static scan below finds no construct render time discards",
    openQuestions: ["first-party charts get verdicts when the audit lane covers them"],
  },
  "template-library": {
    provisionalLane: "safe-to-flatten",
    provisionalWhy:
      "a non-deployable helper library (deployable: false in the artifact index); nothing renders to a cluster from this component",
    openQuestions: ["first-party charts get verdicts when the audit lane covers them"],
  },
};

function parseArtifacts(text) {
  const entries = [];
  const pattern =
    /- service: ([^\n]+)\n\s+canonicalIdentity: ([^\n]+)\n(?:\s+wrapperVersion: ([^\n]+)\n)?\s+version: ([^\n]+)\n\s+url: ([^\n]+)\n(?:\s+manifestDigest: ([^\n]+)\n)?\s+sha256: ([a-f0-9]{64})/g;
  for (const match of text.matchAll(pattern)) {
    entries.push({
      service: match[1].trim(),
      canonicalIdentity: match[2].trim(),
      wrapperVersion: match[3]?.trim(),
      version: match[4].trim(),
      url: match[5].trim(),
      manifestDigest: match[6]?.trim(),
      sha256: match[7],
    });
  }
  return entries;
}

function scanComponent(dir) {
  const files = listFiles(dir).sort();
  let hooks = 0;
  let keep = 0;
  let webhooks = 0;
  let secrets = 0;
  let namespaces = 0;
  let crds = 0;
  let tests = 0;
  const hits = {};
  const note = (key, rel) => {
    hits[key] = hits[key] ?? [];
    if (hits[key].length < 6) hits[key].push(rel);
  };
  for (const path of files) {
    if (!/\.(yaml|yml|tpl|txt|md)$/.test(path)) continue;
    const rel = relative(dir, path);
    const text = readFileSync(path, "utf8");
    if (/helm\.sh\/hook["']?\s*:/.test(text)) {
      hooks += 1;
      note("hooks", rel);
      if (/helm\.sh\/hook["']?\s*:\s*["']?[^"'\n]*test/.test(text)) tests += 1;
    }
    if (/helm\.sh\/resource-policy/.test(text)) {
      keep += 1;
      note("keep", rel);
    }
    if (/kind:\s*(Mutating|Validating)WebhookConfiguration/.test(text)) {
      webhooks += 1;
      note("webhooks", rel);
    }
    if (/randAlphaNum|genSelfSignedCert|genCA\b|derivePassword/.test(text)) {
      secrets += 1;
      note("secrets", rel);
    }
    if (/^kind:\s*Namespace\s*$/m.test(text)) {
      namespaces += 1;
      note("namespaces", rel);
    }
    if (/^kind:\s*CustomResourceDefinition/m.test(text)) {
      crds += 1;
      note("crds", rel);
    }
  }
  return { files, hooks, keep, webhooks, secrets, namespaces, crds, tests, hits };
}

function dispositionRows(scan) {
  const scope = "the committed component definition files";
  const chartNote =
    "the wrapped chart's own template behavior is decided by that chart's flattening-safety verdict, cited in this receipt's verdict";
  const row = (cls, count, presentDetail, presentDisposition, evidenceKey) => {
    const result = {
      class: cls,
      finding: count > 0 ? "present" : "absent",
      detail: count > 0 ? presentDetail : `absent from ${scope}`,
      disposition: count > 0 ? presentDisposition : "none required",
    };
    if (count > 0 && scan.hits[evidenceKey]) result.evidence = scan.hits[evidenceKey].join("; ");
    return result;
  };
  const deferred = (cls) => ({
    class: cls,
    finding: "not-evaluated",
    detail: `template-time construct, out of scope for ${scope}; ${chartNote}`,
    disposition: "decided by the wrapped chart's verdict",
  });
  return [
    row(
      "helm-hooks",
      scan.hooks,
      `${scan.hooks} component file(s) carry helm.sh/hook`,
      "lifecycle route executed by the delivery runtime",
      "hooks",
    ),
    row(
      "resource-policy-keep",
      scan.keep,
      `${scan.keep} component file(s) carry helm.sh/resource-policy`,
      "prune protection emitted beside the bundle",
      "keep",
    ),
    deferred("lookup"),
    row(
      "webhook-ca",
      scan.webhooks,
      `${scan.webhooks} webhook configuration(s) in the component files`,
      "route to cert-manager or a certgen lifecycle route",
      "webhooks",
    ),
    deferred("capabilities-api-versions"),
    row(
      "generated-secrets",
      scan.secrets,
      `${scan.secrets} component file(s) generate secret material`,
      "external Secret reference required before certification",
      "secrets",
    ),
    row(
      "crd-ordering",
      scan.crds,
      `${scan.crds} component file(s) carry CustomResourceDefinitions`,
      "explicit ordering declared at ingest",
      "crds",
    ),
    {
      class: "immutable-fields",
      finding: "not-evaluated",
      detail: "a cross-version property; no second version is compared in this receipt",
      disposition: "versioned replacement route when an upgrade pair is audited",
    },
    row(
      "namespace-creation",
      scan.namespaces,
      `${scan.namespaces} Namespace object(s) ship in the component files`,
      "namespace ships as its own Unit",
      "namespaces",
    ),
    deferred("subchart-conditions"),
    row(
      "test-hooks",
      scan.tests,
      `${scan.tests} test hook(s) in the component files`,
      "pruned from any bundle",
      "tests",
    ),
  ];
}

function buildVerdict(component, chartEntries) {
  const notes = COMPONENT_NOTES[component] ?? {};
  if (notes.lane) {
    const verdict = {
      lane: notes.lane,
      status: "certified",
      decidedBy: notes.certifiedBy,
    };
    if (notes.openQuestions) verdict.openQuestions = notes.openQuestions;
    if (notes.notes) verdict.notes = notes.notes;
    return verdict;
  }
  const cited = chartEntries
    .map((entry) => ({ entry, verdict: VERDICTS[`${entry.canonicalIdentity}@${entry.version}`] }))
    .filter((pair) => pair.verdict);
  if (cited.length > 0) {
    const primary = cited[0];
    const verdict = {
      lane: primary.verdict.lane,
      status: "certified",
      decidedBy: `the flattening-safety audit in confighub/helm-expt at ${primary.verdict.path} (exact version match: ${primary.entry.canonicalIdentity} ${primary.entry.version})`,
    };
    if (notes.openQuestions) verdict.openQuestions = notes.openQuestions;
    verdict.notes =
      "The lane is the wrapped chart's, scoped to the audited base named in the cited verdict; the wrapper's own values were not rendered here.";
    return verdict;
  }
  const verdict = {
    lane: notes.provisionalLane ?? "do-not-flatten",
    status: "provisional",
    decidedBy: notes.provisionalWhy ?? "no flattening-safety verdict covers this component yet",
  };
  if (notes.openQuestions) verdict.openQuestions = notes.openQuestions;
  return verdict;
}

function buildReceipt(component, artifacts) {
  const dir = join(repoRoot, COMPONENTS_DIR, component);
  const scan = scanComponent(dir);
  const files = scan.files.map((path) => ({
    path: relative(dir, path),
    sha256: sha256File(path),
    bytes: statSync(path).size,
  }));
  const chartEntries = artifacts.filter((entry) => entry.service === component);
  const charts = chartEntries.map((entry) => ({
    repository: entry.canonicalIdentity,
    name: entry.canonicalIdentity.split("/").pop(),
    version: entry.version,
    packageSHA256: entry.sha256,
    exactArtifactUrl: entry.url,
  }));
  const spec = {
    producer: {
      name: "kubara",
      repository: "https://github.com/confighub/kubara-confighub",
    },
    source: {
      kind: "kubara-component",
      ...(charts.length > 0 ? { charts } : {}),
      evidence: [ARTIFACTS, GENERATION_RECEIPT],
    },
    bundle: {
      contentsKind: "component-definition",
      files,
      compositionIndexRef: ARTIFACTS,
    },
    ingest: {
      granularity: "per-file",
      spacePattern: "{{.Labels.Component}}-{{.Labels.Variant}}",
      externalSourceAnnotation: "confighub.com/external-source",
    },
    dispositions: dispositionRows(scan),
    verdict: buildVerdict(component, chartEntries),
    provenance: {
      emittedBy: "scripts/generate-certified-bundle-receipts.mjs",
      generatedFrom: [`${COMPONENTS_DIR}/${component}`, ARTIFACTS],
    },
  };
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "CertifiedBundleReceipt",
    metadata: { name: `kubara-current-platform-${component}` },
    spec,
  };
}

function summaryMd(rows) {
  const lines = [];
  lines.push("# Certified bundle receipts");
  lines.push("");
  lines.push(
    "One receipt per current-platform component, adopting the shared certified-bundle receipt spec. The spec's canonical home is the confighub/helm-expt repository; the schema at schemas/certified-bundle-receipt.schema.json is a byte-faithful copy so these receipts verify standalone. The component digest index stays Kubara's own format, and every receipt points at it.",
  );
  lines.push("");
  lines.push("| component | charts | lane | status |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(`| ${row.component} | ${row.charts} | ${row.lane} | ${row.status} |`);
  }
  lines.push("");
  lines.push(
    "A certified lane is cited from a flattening-safety verdict in confighub/helm-expt on an exact chart and version match. A provisional lane states what current evidence supports and names its open questions inside the receipt. Lanes move when receipts change, never by hand.",
  );
  lines.push("");
  lines.push(
    "Regenerate with `npm run certified-bundles`. Verify with `npm run certified-bundles:verify`.",
  );
  lines.push("");
  return lines.join("\n");
}

function toCsv(rows) {
  const header = "component,charts,contents_kind,file_count,lane,status,receipt";
  return `${[
    header,
    ...rows.map((row) =>
      [row.component, row.charts, "component-definition", row.fileCount, row.lane, row.status, row.receipt].join(","),
    ),
  ].join("\n")}\n`;
}

function buildAll() {
  const artifacts = parseArtifacts(readFileSync(join(repoRoot, ARTIFACTS), "utf8"));
  check(artifacts.length >= 6, "component-artifacts.yaml parsed fewer chart entries than expected");
  const components = listFiles(join(repoRoot, COMPONENTS_DIR))
    .map((path) => relative(join(repoRoot, COMPONENTS_DIR), path).split("/")[0])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  check(components.length >= 9, `expected at least nine components, found ${components.length}`);
  const outputs = [];
  const rows = [];
  for (const component of components) {
    const receipt = buildReceipt(component, artifacts);
    const rel = `data/certified-bundles/receipts/${component}/receipt.yaml`;
    outputs.push({ path: join(repoRoot, rel), contents: `${toYaml(receipt)}\n` });
    rows.push({
      component,
      charts:
        receipt.spec.source.charts?.map((chart) => `${chart.name} ${chart.version}`).join("; ") ??
        "first-party",
      fileCount: receipt.spec.bundle.files.length,
      lane: receipt.spec.verdict.lane,
      status: receipt.spec.verdict.status,
      receipt: rel,
    });
  }
  outputs.push({ path: join(OUT_DIR, "receipts.csv"), contents: toCsv(rows) });
  outputs.push({ path: join(OUT_DIR, "summary.md"), contents: summaryMd(rows) });
  return outputs;
}

const outputs = buildAll();
if (mode === "--generate") {
  for (const output of outputs) write(output.path, output.contents);
  console.log(`wrote ${outputs.length} certified-bundle file(s)`);
} else if (mode === "--verify") {
  for (const output of outputs) {
    const rel = relativeRepo(output.path);
    check(existsSync(output.path), `${rel} is missing; run npm run certified-bundles`);
    check(
      readFileSync(output.path, "utf8") === output.contents,
      `${rel} is stale; run npm run certified-bundles`,
    );
  }
  console.log(`verified ${outputs.length} certified-bundle file(s)`);
} else {
  console.log(`Usage:
  node scripts/generate-certified-bundle-receipts.mjs --generate
  node scripts/generate-certified-bundle-receipts.mjs --verify`);
}
