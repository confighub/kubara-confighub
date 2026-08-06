import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  check,
  listFiles,
  parseObjects,
  readYaml,
  sha256File,
  writeYaml,
} from "./lib/proof-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const alignmentPath = join(repoRoot, "examples", "kubara", "local-platform", "catalog-alignment.yaml");
const outputRootRelative = "data/kubara-catalog-refresh/candidates";
const outputRoot = join(repoRoot, outputRootRelative);
const manifestPath = join(outputRoot, "candidate-set.yaml");
const statusPath = join(outputRoot, "candidate-status.csv");
const readmePath = join(outputRoot, "README.md");
const mode = process.argv[2] ?? "--verify";

const definitions = [
  { identity: "helm:argo-cd/argo-cd", script: "scripts/argo-cd-proof.mjs", variants: ["default", "no-crds"] },
  { identity: "helm:jetstack/cert-manager", script: "scripts/cert-manager-proof.mjs", variants: ["default", "crds-enabled"] },
  { identity: "helm:external-secrets/external-secrets", script: "scripts/external-secrets-proof.mjs", variants: ["default", "no-crds"] },
  {
    identity: "helm:prometheus-community/kube-prometheus-stack",
    script: "scripts/kube-prometheus-stack-proof.mjs",
    variants: ["default", "no-crds", "existing-secret"],
    lifecycle: true,
  },
  {
    identity: "helm:prometheus-community/prometheus-blackbox-exporter",
    script: "scripts/kubara-generic-chart-proof.mjs",
    genericCandidate: "prometheus-blackbox-exporter",
    variants: ["default"],
  },
  { identity: "helm:metrics-server/metrics-server", script: "scripts/metrics-server-proof.mjs", variants: ["default", "external-tls-ca"] },
  {
    identity: "helm:traefik/traefik",
    script: "scripts/kubara-generic-chart-proof.mjs",
    genericCandidate: "traefik",
    variants: ["default"],
  },
];

if (mode === "--generate") {
  generate();
} else if (mode === "--verify") {
  verify();
} else {
  console.log(`Usage:
  node scripts/run-kubara-catalog-candidates.mjs --generate
  node scripts/run-kubara-catalog-candidates.mjs --verify`);
}

function loadAlignment() {
  const alignment = readYaml(alignmentPath);
  check(alignment.kind === "KubaraCatalogAlignment", "Kubara catalog alignment kind changed");
  return alignment;
}

function loadCandidates(alignment = loadAlignment()) {
  const components = new Map(
    (alignment.spec?.components ?? []).map((component) => [component.canonicalIdentity, component]),
  );
  return definitions.map((definition) => {
    const component = components.get(definition.identity);
    check(component, `${definition.identity}: catalog alignment entry is missing`);
    const { kubara, configHubCatalog } = component;
    const version = String(kubara.selectedVersion);
    const artifactURL = kubara.artifact?.url ?? "";
    const artifactSHA256 = (
      kubara.artifact?.sha256
      ?? kubara.artifact?.chartLayerDigest
      ?? ""
    ).replace(/^sha256:/, "");
    check(artifactURL, `${definition.identity}: exact artifact URL is missing`);
    check(/^[0-9a-f]{64}$/.test(artifactSHA256), `${definition.identity}: exact artifact SHA is invalid`);
    const recipeRelative = `${outputRootRelative}/${configHubCatalog.recipeRoot}/${version}`;
    const packageRelative = recipeRelative
      .replace(`${outputRootRelative}/recipes/`, `${outputRootRelative}/packages/`);
    return {
      ...definition,
      version,
      artifactURL,
      artifactSHA256,
      recipeRelative,
      packageRelative,
      recipePath: join(repoRoot, recipeRelative),
      packagePath: join(repoRoot, packageRelative),
      rootRecipePath: join(repoRoot, configHubCatalog.recipeRoot, version),
      rootPackagePath: join(
        repoRoot,
        configHubCatalog.recipeRoot.replace(/^recipes\//, "packages/"),
        version,
      ),
      retainedVersions: configHubCatalog.retainedVersions ?? [],
      rootRecipeBase: join(repoRoot, configHubCatalog.recipeRoot),
      rootPackageBase: join(repoRoot, configHubCatalog.recipeRoot.replace(/^recipes\//, "packages/")),
      upstreamPackageMatch: configHubCatalog.upstreamPackageMatch,
      componentEntryStatus: configHubCatalog.componentEntryStatus,
    };
  });
}

function generate() {
  const alignment = loadAlignment();
  const candidates = loadCandidates(alignment);
  mkdirSync(outputRoot, { recursive: true });
  for (const candidate of candidates) {
    console.log(`generating exact Kubara candidate ${candidate.identity}@${candidate.version}`);
    runProof(candidate, "--generate-proof");
    if (candidate.lifecycle) runLifecycle(candidate, "--generate");
    runProof(candidate, "--generate-package");
  }
  const rows = inspect(candidates);
  writeOutputs(rows, alignment);
  verify();
  console.log(`generated ${rows.length} exact Kubara catalog candidates without changing retained roots`);
}

function verify() {
  const alignment = loadAlignment();
  const candidates = loadCandidates(alignment);
  for (const candidate of candidates) {
    for (const retained of candidate.retainedVersions) {
      check(
        existsSync(join(candidate.rootRecipeBase, String(retained))),
        `${candidate.identity}: historical recipe ${retained} is missing`,
      );
      check(
        existsSync(join(candidate.rootPackageBase, String(retained))),
        `${candidate.identity}: historical package ${retained} is missing`,
      );
    }
    check(
      ["missing", "retained"].includes(candidate.upstreamPackageMatch),
      `${candidate.identity}: unsupported upstream package match ${candidate.upstreamPackageMatch}`,
    );
    check(
      ["missing", "retained"].includes(candidate.componentEntryStatus),
      `${candidate.identity}: unsupported component entry status ${candidate.componentEntryStatus}`,
    );
    if (candidate.componentEntryStatus === "retained") {
      check(candidate.upstreamPackageMatch === "retained", `${candidate.identity}: a retained component requires a retained upstream package`);
    }
    if (candidate.upstreamPackageMatch === "missing") {
      const rootRecipeExists = existsSync(candidate.rootRecipePath);
      const rootPackageExists = existsSync(candidate.rootPackagePath);
      check(
        rootRecipeExists === rootPackageExists,
        `${candidate.identity}: additive promotion is partial between the root recipe and package`,
      );
      if (rootRecipeExists) verifyRetainedRoot(candidate, { requireDeclaredRetained: false });
    } else {
      verifyRetainedRoot(candidate, { requireDeclaredRetained: true });
    }
    runProof(candidate, "--verify-proof");
    if (candidate.lifecycle) runLifecycle(candidate, "--verify");
    runProof(candidate, "--verify-package");
  }
  const rows = inspect(candidates);
  check(existsSync(manifestPath), `${relativeRepo(manifestPath)} is missing`);
  check(existsSync(statusPath), `${relativeRepo(statusPath)} is missing`);
  check(existsSync(readmePath), `${relativeRepo(readmePath)} is missing`);
  check(readFileSync(statusPath, "utf8") === statusCsv(rows), "Kubara candidate status CSV is stale");
  check(readFileSync(readmePath, "utf8") === readme(rows, alignment), "Kubara candidate README is stale");
  verifyManifest(rows, alignment);
  console.log(`verified ${rows.length} exact Kubara catalog candidates and all historical roots`);
}

function runProof(candidate, command) {
  const env = {
    ...process.env,
    HELM_EXPT_CHART_VERSION: candidate.version,
    HELM_EXPT_PROOF_OUTPUT_ROOT: outputRootRelative,
    HELM_EXPT_PROOF_SCRIPT_PREFIX: "kubara-catalog-candidates",
    HELM_EXPT_PROOF_OFFLINE_CANDIDATE: "1",
    HELM_EXPT_CHART_ARTIFACT_URL: candidate.artifactURL,
    HELM_EXPT_CHART_ARTIFACT_SHA256: candidate.artifactSHA256,
  };
  if (candidate.lifecycle) {
    env.HELM_EXPT_KPS_PACKAGE_EXTRAS_ROOT = `${outputRootRelative}/config-catalog/package-extras/prometheus-community/kube-prometheus-stack`;
  }
  if (candidate.genericCandidate) env.HELM_EXPT_KUBARA_CANDIDATE = candidate.genericCandidate;
  execFileSync(process.execPath, [candidate.script, command], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

function runLifecycle(candidate, command) {
  execFileSync(
    process.execPath,
    ["scripts/generate-kps-packaged-lifecycle.mjs", command, "--version", candidate.version],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HELM_EXPT_PROOF_OUTPUT_ROOT: outputRootRelative,
        HELM_EXPT_PROOF_OFFLINE_CANDIDATE: "1",
        HELM_EXPT_CHART_ARTIFACT_URL: candidate.artifactURL,
        HELM_EXPT_CHART_ARTIFACT_SHA256: candidate.artifactSHA256,
      },
      stdio: "inherit",
    },
  );
}

function inspect(candidates) {
  return candidates.map((candidate) => {
    check(existsSync(candidate.recipePath), `${candidate.identity}: candidate recipe is missing`);
    check(existsSync(candidate.packagePath), `${candidate.identity}: candidate package is missing`);
    const sourceLock = readYaml(join(candidate.recipePath, "source-lock.yaml"));
    check(sourceLock.spec?.version === candidate.version, `${candidate.identity}: source-lock version mismatch`);
    check(sourceLock.spec?.exactArtifact?.url === candidate.artifactURL, `${candidate.identity}: source-lock artifact URL mismatch`);
    check(sourceLock.spec?.exactArtifact?.sha256 === candidate.artifactSHA256, `${candidate.identity}: source-lock artifact SHA mismatch`);
    check(sourceLock.spec?.packageSHA256 === candidate.artifactSHA256, `${candidate.identity}: package SHA is not exact`);
    const evidencePath = sourceLock.spec?.evidence?.candidateRenderReceipt;
    check(Boolean(evidencePath), `${candidate.identity}: candidate-local source evidence is missing`);
    check(
      existsSync(join(candidate.recipePath, evidencePath)),
      `${candidate.identity}: candidate-local source evidence does not resolve`,
    );
    check(sourceLock.spec?.evidence?.harnessReceipt == null, `${candidate.identity}: stale external harness evidence remains`);
    const helmPlan = readYaml(join(candidate.recipePath, "helm-plan.yaml"));
    check(helmPlan.spec?.readiness?.status === "offline-candidate", `${candidate.identity}: HelmPlan overclaims candidate readiness`);
    check(!existsSync(join(candidate.recipePath, "publication")), `${candidate.identity}: offline candidate must not have a publication directory`);
    check(
      existsSync(join(candidate.recipePath, "evaluation", "installer-package-receipt.yaml")),
      `${candidate.identity}: local installer evaluation receipt is missing`,
    );
    const narrativePaths = [
      ...listFiles(candidate.recipePath).filter((path) => path.endsWith("README.md")),
      ...listFiles(candidate.packagePath).filter((path) => path.endsWith("README.md")),
      join(candidate.recipePath, "helm-plan.yaml"),
      join(candidate.recipePath, "chart-dossier.yaml"),
      join(candidate.recipePath, "value-model.yaml"),
      join(candidate.recipePath, "control-points.yaml"),
    ];
    for (const path of narrativePaths) {
      const content = readFileSync(path, "utf8");
      if (path.endsWith("README.md")) {
        check(content.includes("> **Offline candidate only.**"), `${candidate.identity}: ${relativeRepo(path)} lacks the candidate boundary`);
        check(
          !/kubara-catalog-candidates:(?:generate|verify)-(?:proof|package)|kubara-catalog-candidates:compare/.test(content),
          `${candidate.identity}: ${relativeRepo(path)} advertises a nonexistent command`,
        );
      }
      check(!/promoted proof slice|promoted variants|ready-to-use|public `try\.sh`/i.test(content), `${candidate.identity}: ${relativeRepo(path)} overclaims candidate status`);
    }
    const objectCounts = {};
    for (const variant of candidate.variants) {
      const inventoryPath = join(
        candidate.recipePath,
        "revisions",
        variant,
        "r001",
        "rendered",
        "release-objects.yaml",
      );
      check(existsSync(inventoryPath), `${candidate.identity}: ${variant} rendered objects are missing`);
      objectCounts[variant] = parseObjects(readFileSync(inventoryPath, "utf8")).length;
      const gate = readYaml(join(
        candidate.recipePath,
        "revisions",
        variant,
        "r001",
        "receipts",
        "install-gate.yaml",
      ));
      check(gate.spec?.decision === "blocked", `${candidate.identity}: ${variant} install gate is not blocked`);
      check(
        ["live-cluster", "root-catalog-promotion", "production"].every((scope) =>
          (gate.spec?.blockedScopes ?? []).includes(scope)),
        `${candidate.identity}: ${variant} install gate omits a candidate boundary`,
      );
      const reasons = (gate.spec?.reasons ?? []).join(" ");
      check(/live qualification/i.test(reasons), `${candidate.identity}: ${variant} gate omits live qualification`);
      check(/Kubara .*compatibility/i.test(reasons), `${candidate.identity}: ${variant} gate omits Kubara compatibility`);
    }
    return {
      identity: candidate.identity,
      version: candidate.version,
      artifactURL: candidate.artifactURL,
      artifactSHA256: candidate.artifactSHA256,
      recipe: relativeRepo(candidate.recipePath),
      package: relativeRepo(candidate.packagePath),
      variants: candidate.variants,
      objectCounts,
      sourceLockSHA256: sha256File(join(candidate.recipePath, "source-lock.yaml")),
      status: "offline-candidate-pass",
    };
  });
}

function verifyRetainedRoot(candidate, { requireDeclaredRetained }) {
  if (requireDeclaredRetained) {
    check(
      candidate.retainedVersions.map(String).includes(candidate.version),
      `${candidate.identity}: retainedVersions omits exact retained version ${candidate.version}`,
    );
  }
  check(existsSync(candidate.rootRecipePath), `${candidate.identity}: retained root recipe is missing`);
  check(existsSync(candidate.rootPackagePath), `${candidate.identity}: retained root package is missing`);
  const sourceLock = readYaml(join(candidate.rootRecipePath, "source-lock.yaml"));
  check(sourceLock.spec?.version === candidate.version, `${candidate.identity}: retained source-lock version mismatch`);
  check(sourceLock.spec?.exactArtifact?.url === candidate.artifactURL, `${candidate.identity}: retained exact artifact URL mismatch`);
  check(sourceLock.spec?.exactArtifact?.sha256 === candidate.artifactSHA256, `${candidate.identity}: retained exact artifact SHA mismatch`);
  check(sourceLock.spec?.packageSHA256 === candidate.artifactSHA256, `${candidate.identity}: retained package SHA mismatch`);
  const sourceEvidence = sourceLock.spec?.evidence?.exactArtifactRenderReceipt;
  check(Boolean(sourceEvidence), `${candidate.identity}: retained exact-artifact render evidence is missing`);
  check(existsSync(join(candidate.rootRecipePath, sourceEvidence)), `${candidate.identity}: retained exact-artifact render evidence does not resolve`);
  check(sourceLock.spec?.evidence?.harnessReceipt == null, `${candidate.identity}: retained source lock claims stale harness evidence`);
  check(!existsSync(join(candidate.rootRecipePath, "evaluation")), `${candidate.identity}: retained root contains candidate evaluation residue`);
  const publicationPath = join(candidate.rootRecipePath, "publication", "installer-package-receipt.yaml");
  check(existsSync(publicationPath), `${candidate.identity}: retained root publication receipt is missing`);
  const publication = readYaml(publicationPath);
  check(
    publication.spec?.package?.path === relativeRepo(candidate.rootPackagePath),
    `${candidate.identity}: retained publication receipt does not point at the root package`,
  );
  for (const variant of candidate.variants) {
    compareRetainedFile(
      candidate,
      join("revisions", variant, "r001", "rendered", "release-objects.yaml"),
      candidate.recipePath,
      candidate.rootRecipePath,
    );
    for (const file of ["kustomization.yaml", "upstream.yaml"]) {
      compareRetainedFile(
        candidate,
        join("bases", variant, file),
        candidate.packagePath,
        candidate.rootPackagePath,
      );
    }
  }
  compareRetainedFile(candidate, "installer.yaml", candidate.packagePath, candidate.rootPackagePath);
  for (const root of [candidate.rootRecipePath, candidate.rootPackagePath]) {
    for (const path of listFiles(root)) {
      const text = readFileSync(path, "utf8");
      check(
        !/offline(?:[- ]candidate|[- ]only|[- ]local[- ]evaluation)|live qualification has not run|root-catalog-promotion/i.test(text),
        `${candidate.identity}: retained root has offline-candidate residue in ${relativeRepo(path)}`,
      );
    }
  }
}

function compareRetainedFile(candidate, file, candidateRoot, retainedRoot) {
  const source = join(candidateRoot, file);
  const retained = join(retainedRoot, file);
  check(existsSync(source), `${candidate.identity}: candidate comparison file ${file} is missing`);
  check(existsSync(retained), `${candidate.identity}: retained comparison file ${file} is missing`);
  check(sha256File(source) === sha256File(retained), `${candidate.identity}: retained ${file} differs from the exact candidate`);
}

function writeOutputs(rows, alignment) {
  writeYaml(manifestPath, manifest(rows, alignment));
  writeFileSync(statusPath, statusCsv(rows));
  writeFileSync(readmePath, readme(rows, alignment));
}

function manifest(rows, alignment) {
  const exactSet = alignment.spec?.exactCandidateSet ?? {};
  const retained = exactSet.rootRetention === "retained";
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogCandidateSet",
    metadata: { name: "kubara-v0-12-0-exact-pins" },
    spec: {
      sourceAlignment: relativeRepo(alignmentPath),
      retentionMode: "additive-only",
      qualification: retained && exactSet.liveQualification === "passed-13-of-13"
        ? "live-qualified-root-retained"
        : "offline-only",
      rootRetention: exactSet.rootRetention ?? "not-yet-qualified",
      candidates: rows.map((row) => ({
        canonicalIdentity: row.identity,
        version: row.version,
        status: row.status,
        exactArtifact: { url: row.artifactURL, sha256: row.artifactSHA256 },
        recipe: row.recipe,
        package: row.package,
        variants: row.variants.map((variant) => ({
          name: variant,
          objectCount: row.objectCounts[variant],
        })),
        sourceLockSHA256: row.sourceLockSHA256,
      })),
      limits: [
        "candidate status does not imply retained root Catalog status",
        "candidate status does not include Kubara ServiceDefinition or wrapper compatibility",
        "candidate status does not include live qualification or installer OCI publication",
      ],
    },
  };
}

function verifyManifest(rows, alignment) {
  const actual = readYaml(manifestPath);
  const expected = manifest(rows, alignment);
  check(stableJson(actual) === stableJson(expected), "Kubara candidate-set manifest is stale");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function statusCsv(rows) {
  const headers = ["canonical_identity", "version", "status", "variants", "object_counts", "recipe", "package", "artifact_sha256"];
  const lines = rows.map((row) => [
    row.identity,
    row.version,
    row.status,
    row.variants.join(";"),
    row.variants.map((variant) => `${variant}:${row.objectCounts[variant]}`).join(";"),
    row.recipe,
    row.package,
    row.artifactSHA256,
  ].map(csvCell).join(","));
  return `${headers.join(",")}\n${lines.join("\n")}\n`;
}

function readme(rows, alignment) {
  const rootRetention = alignment.spec?.exactCandidateSet?.rootRetention ?? "not-yet-qualified";
  const retained = rootRetention === "retained";
  const retentionParagraph = retained
    ? `The exact versions also have additive root recipe and package copies after
the separately recorded live qualification passed. These candidate trees remain
the immutable offline evaluation snapshot; root retention still does not claim
complete Kubara ServiceDefinition or wrapper compatibility.`
    : `No historical root recipe or package is replaced. These are offline upstream
package candidates, not retained root Catalog entries and not complete Kubara
components. Root retention still requires scoped live qualification; complete
component retention additionally requires the Kubara ServiceDefinition, wrapper
compatibility profile, adapter, and parity evidence.`;
  return `# Kubara exact-version catalog candidates

These additive candidate trees capture the seven exact public chart artifacts
selected by Kubara v0.12.0. They are artifact-addressed and digest-verified, so
candidate generation does not depend on a mutable Helm repository index.

${retentionParagraph}

| Component | Version | Variants and object counts | Status |
| --- | --- | --- | --- |
${rows.map((row) => `| \`${row.identity}\` | \`${row.version}\` | ${row.variants.map((variant) => `\`${variant}:${row.objectCounts[variant]}\``).join("<br>")} | ${row.status} |`).join("\n")}

## Reproduce

\`\`\`sh
npm run kubara-catalog-candidates:generate
npm run kubara-catalog-candidates:verify
\`\`\`
`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n;]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function relativeRepo(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}
