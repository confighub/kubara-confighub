// Shared proof generator/verifier kit.
//
// Every scripts/<chart>-proof.mjs file historically carried a near-identical
// ~1,000-line copy of the same generate/verify/package machinery, differing only
// in per-chart DATA (chart coordinates, variants, scan policy, control points,
// value model, dossier notes, README prose) and a small block of chart-specific
// verify assertions.
//
// This module factors out the ~660 lines of identical control flow so each chart
// script becomes a declarative spec plus a one-line `runProofCli(spec)` call,
// while preserving byte-for-byte output and the exact CLI surface
// (--generate-proof / --generate-package / --verify-proof /
//  --verify-proof-self-test / --verify-package / --compare).
//
// Chart-specific behaviour is supplied via the spec:
//   - data fields: chart, variants, scanPolicy, valueModel, controlPoints,
//     dossier, plan, readme, dependencies, supportObjects
//   - hooks: installGate(variant) -> gate spec, verifyExtra(ctx) -> assertions

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  canonicalObjectMaps,
  check,
  command,
  difference,
  findingCounts,
  identityFor,
  imageTag,
  labelsMatch,
  listFiles,
  listYamlFiles,
  normalizeYaml,
  objectFilesFromDirs,
  parseDocs,
  parseObjects,
  readYaml,
  readYamlText,
  relativeRepo,
  repoRoot,
  runCub,
  sha256,
  sha256File,
  toYaml,
  workloadPodSpec,
  workloadTemplateLabels,
  write,
  writeYaml,
} from "./proof-common.mjs";

const DEFAULT_RENDER_FLAGS = ["--include-crds", "--skip-tests", "--no-hooks"];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function candidateSafeText(ctx, value) {
  if (!ctx.offlineCandidate || typeof value !== "string") return value;
  return value
    .replaceAll("promoted proof slice", "offline candidate proof slice")
    .replaceAll("promoted variants", "offline candidate variants")
    .replaceAll("ready-to-use", "locally inspectable offline candidate")
    .replaceAll("public `try.sh`", "post-qualification `try.sh`");
}

function candidateSafeValue(ctx, value) {
  if (!ctx.offlineCandidate) return value;
  if (Array.isArray(value)) return value.map((item) => candidateSafeValue(ctx, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, candidateSafeValue(ctx, item)]),
    );
  }
  return candidateSafeText(ctx, value);
}

function candidateBoundary(ctx) {
  if (!ctx.offlineCandidate) return "";
  return "> **Offline candidate only.** This artifact is for local, deterministic evaluation. It is not root-Catalog-retained, Kubara-compatible, live-qualified, or published.\n\n";
}

function proofCommands(ctx) {
  if (ctx.proofCommands) return ctx.proofCommands;
  if (ctx.offlineCandidate) {
    return `npm run ${ctx.scriptPrefix}:generate\nnpm run ${ctx.scriptPrefix}:verify`;
  }
  return `npm run ${ctx.scriptPrefix}:generate-proof\nnpm run ${ctx.scriptPrefix}:generate-package\nnpm run ${ctx.scriptPrefix}:verify-proof\nnpm run ${ctx.scriptPrefix}:verify-package\nnpm run ${ctx.scriptPrefix}:compare`;
}

// Build the immutable per-chart context derived from the spec. All chart
// coordinates and conventional names are computed once here so the rest of the
// kit (and chart specs) never re-derive them inconsistently.
function makeContext(spec) {
  check(
    spec.chart && spec.chart.repository && spec.chart.name && spec.chart.version,
    "spec.chart must set repository, name, version",
  );
  // Multi-version proof harness overrides (run-latest-top20-candidates.mjs):
  // HELM_EXPT_CHART_VERSION re-targets the version; HELM_EXPT_PROOF_OUTPUT_ROOT writes
  // proof/package trees under a scratch root. Both unset -> identical to before.
  const chart = { ...spec.chart, version: process.env.HELM_EXPT_CHART_VERSION ?? spec.chart.version };
  const outputRoot = process.env.HELM_EXPT_PROOF_OUTPUT_ROOT
    ? join(repoRoot, process.env.HELM_EXPT_PROOF_OUTPUT_ROOT)
    : repoRoot;
  const artifactURL = process.env.HELM_EXPT_CHART_ARTIFACT_URL ?? "";
  const artifactSHA256 = (process.env.HELM_EXPT_CHART_ARTIFACT_SHA256 ?? "").replace(/^sha256:/, "");
  const offlineCandidate = process.env.HELM_EXPT_PROOF_OFFLINE_CANDIDATE === "1";
  check(
    !artifactURL || /^[0-9a-f]{64}$/.test(artifactSHA256),
    "HELM_EXPT_CHART_ARTIFACT_URL requires a 64-character HELM_EXPT_CHART_ARTIFACT_SHA256",
  );
  const proofRoot = join(outputRoot, "recipes", chart.repository, chart.name, chart.version);
  const packageRoot = join(outputRoot, "packages", chart.repository, chart.name, chart.version);
  const ns = chart.namespace;
  // Base artifact name; default `${repository}-${name}`. A chart may override it via
  // spec.packageName to preserve a pre-existing name quirk (kube-prometheus-stack
  // doubles its chart name). Both lockName and packageName derive from it.
  const baseName = spec.packageName ?? `${chart.repository}-${chart.name}`;
  return {
    spec,
    chart,
    variants: spec.variants,
    scanPolicy: spec.scanPolicy,
    proofRoot,
    packageRoot,
    packageRelative: relativeRepo(packageRoot),
    receiptPath: join(
      proofRoot,
      offlineCandidate ? "evaluation" : "publication",
      "installer-package-receipt.yaml",
    ),
    lockName: `${baseName}-${chart.version}`,
    packageName: baseName, // e.g. metrics-server-metrics-server
    chartRef: `${chart.repository}/${chart.name}`, // e.g. metrics-server/metrics-server
    helmChartRef: spec.helmChartRef ?? `${chart.repository}/${chart.name}`,
    receiptSlug: spec.receiptSlug ?? chart.name, // short name used in receipt metadata.name
    scriptPrefix: process.env.HELM_EXPT_PROOF_SCRIPT_PREFIX ?? spec.scriptPrefix ?? chart.name,
    proofCommands: process.env.HELM_EXPT_PROOF_COMMANDS ?? "",
    renderFlags: spec.renderFlags ?? DEFAULT_RENDER_FLAGS,
    expectedDependencyCount: spec.expectedDependencyCount ?? 0,
    recordChartLockDigest: spec.recordChartLockDigest ?? false,
    recordDeprecated: spec.recordDeprecated ?? false,
    expectedDeprecated: spec.expectedDeprecated ?? false,
    semanticNormalizations: spec.semanticNormalizations ?? ["prune-null-fields"],
    supportObjects: spec.supportObjects ?? [`v1|Namespace||${ns}`],
    dependencyLockChart: spec.dependencyLockChart ?? `${chart.repository}/${chart.name}`,
    sourceType: spec.sourceType ?? "HelmChart",
    artifactURL,
    artifactSHA256,
    offlineCandidate,
  };
}

export function runProofCli(spec) {
  const ctx = makeContext(spec);
  const mode = process.argv[2] ?? "--help";
  const cli = spec.cliName ?? `scripts/${basename(process.argv[1] ?? `${ctx.chart.name}-proof.mjs`)}`;
  if (mode === "--generate-proof") generateProof(ctx);
  else if (mode === "--generate-package") generatePackage(ctx);
  else if (mode === "--verify-proof") verifyProof(ctx);
  else if (mode === "--verify-proof-self-test") verifyProofSelfTest(ctx);
  else if (mode === "--verify-package") verifyPackage(ctx);
  else if (mode === "--compare") verifyPackage(ctx);
  else {
    console.log(`Usage:
  node ${cli} --generate-proof
  node ${cli} --generate-package
  node ${cli} --verify-proof
  node ${cli} --verify-proof-self-test
  node ${cli} --verify-package
  node ${cli} --compare`);
  }
}

function revisionRoot(ctx, variantName) {
  return join(ctx.proofRoot, "revisions", variantName, "r001");
}

function generateProof(ctx) {
  const { chart, variants, scanPolicy, proofRoot, lockName, chartRef } = ctx;
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(proofRoot, { recursive: true });

  const source = pullSource(ctx);
  const helmVersion = command("helm", ["version", "--short"]).trim();

  writeYaml(join(proofRoot, "source-lock.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "SourceLock",
    metadata: { name: lockName },
    spec: {
      sourceType: ctx.sourceType,
      repositoryName: chart.repository,
      repositoryURL: chart.repositoryURL,
      chart: chart.name,
      version: chart.version,
      appVersion: source.appVersion,
      // Charts that record the upstream Chart.yaml deprecation marker opt in via recordDeprecated.
      ...(ctx.recordDeprecated ? { deprecated: Boolean(source.deprecated) } : {}),
      packageSHA256: source.packageSHA256,
      packageBytes: source.packageBytes,
      ...(ctx.artifactURL
        ? {
            exactArtifact: {
              url: ctx.artifactURL,
              sha256: source.packageSHA256,
              resolution: "artifact-addressed",
            },
          }
        : {}),
      evidence: ctx.offlineCandidate
        ? {
            candidateRenderReceipt:
              `revisions/${variants[0].name}/r001/receipts/render-receipt.yaml`,
          }
        : ctx.artifactURL
          ? {
              exactArtifactRenderReceipt:
                `revisions/${variants[0].name}/r001/receipts/render-receipt.yaml`,
            }
        : {
            harnessReceipt: `../../../../data/adversarial10/charts/${lockName}/render-receipt.yaml`,
          },
    },
  });

  writeYaml(join(proofRoot, "dependency-lock.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "DependencyLock",
    metadata: { name: lockName },
    spec: {
      chart: ctx.dependencyLockChart,
      version: chart.version,
      dependencies: source.dependencies,
      // Charts on the bitnami dependency-lock template always record provenance,
      // even when the packaged chart has dependencies but no Chart.lock file.
      ...(ctx.recordChartLockDigest ? { chartLockDigest: source.chartLockDigest } : {}),
      ...(ctx.recordChartLockDigest && source.chartLockProvenance ? { chartLockProvenance: source.chartLockProvenance } : {}),
    },
  });
  for (const artifact of ctx.spec.extraProofDocuments?.({ ctx, source }) ?? []) {
    writeYaml(join(proofRoot, artifact.path), artifact.document);
  }

  writeYaml(join(proofRoot, "value-model.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "ValueModel",
    metadata: { name: lockName },
    spec: {
      checkedValues: candidateSafeValue(ctx, ctx.spec.valueModel.checkedValues),
      unknownValues: candidateSafeText(ctx, ctx.spec.valueModel.unknownValues ?? "not-checked"),
      deadValues: candidateSafeText(ctx, ctx.spec.valueModel.deadValues ?? "not-checked"),
      ignoredValues: candidateSafeText(ctx, ctx.spec.valueModel.ignoredValues ?? "not-checked"),
    },
  });

  writeYaml(join(proofRoot, "control-points.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "ControlPoints",
    metadata: { name: lockName },
    spec: { points: candidateSafeValue(ctx, ctx.spec.controlPoints) },
  });

  writeYaml(join(proofRoot, "recipe.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "Recipe",
    metadata: { name: ctx.packageName, version: chart.version },
    spec: {
      chartRef: { sourceLock: "source-lock.yaml", dependencyLock: "dependency-lock.yaml" },
      importMode: "render-and-vendor",
      currentExecutableFixture: {
        installerPackage: `../../../../packages/${chart.repository}/${chart.name}/${chart.version}`,
        setupCommand: [
          "cub",
          "installer",
          "setup",
          "--pull",
          `../../../../packages/${chart.repository}/${chart.name}/${chart.version}`,
          "--non-interactive",
          "--namespace",
          chart.namespace,
        ],
      },
      variants: variants.map((variant) => `variants/${variant.name}/variant.yaml`),
    },
  });

  const summaries = [];
  for (const variant of variants) {
    const render = renderVariant(ctx, variant);
    if (!render.deterministic) {
      throw new Error(`${variant.name} did not render deterministically`);
    }
    const releaseObjects = normalizeYaml(render.first);
    const releaseDigest = sha256(releaseObjects);
    const renderedRoot = join(revisionRoot(ctx, variant.name), "rendered");
    const receiptsRoot = join(revisionRoot(ctx, variant.name), "receipts");
    mkdirSync(renderedRoot, { recursive: true });
    mkdirSync(receiptsRoot, { recursive: true });
    write(join(renderedRoot, "release-objects.yaml"), releaseObjects);
    const objects = parseObjects(releaseObjects);
    if (objects.length !== variant.expectedObjectCount) {
      throw new Error(`${variant.name} expected ${variant.expectedObjectCount} objects, got ${objects.length}`);
    }
    const docs = parseDocs(releaseObjects);
    const secretCount = docs.filter((doc) => doc.kind === "Secret").length;
    const inventory = {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "RenderedObjectInventory",
      metadata: { name: `${lockName}-${variant.name}-r001` },
      spec: {
        source: "rendered/release-objects.yaml",
        sourceSHA256: releaseDigest,
        objectCount: objects.length,
        objects,
      },
    };
    writeYaml(join(renderedRoot, "object-inventory.yaml"), inventory);

    const effectiveValues = effectiveValuesDoc(ctx, variant, source.defaultValuesSHA256);
    writeYaml(join(proofRoot, variant.valuesFile), effectiveValues);
    const variantDoc = variantDocFor(ctx, variant);
    writeYaml(join(proofRoot, "variants", variant.name, "variant.yaml"), variantDoc);

    const recipeDigest = sha256File(join(proofRoot, "recipe.yaml"));
    const variantDigest = sha256File(join(proofRoot, "variants", variant.name, "variant.yaml"));
    const effectiveValuesDigest = sha256File(join(proofRoot, variant.valuesFile));
    const rendererFingerprint = sha256(
      JSON.stringify({
        renderer: "helm",
        helmVersion,
        kubeVersion: chart.kubeVersion,
        flags: ctx.renderFlags,
        ...((variant.apiVersions ?? []).length ? { apiVersions: variant.apiVersions } : {}),
      }),
    );
    const revisionDigest = sha256(
      JSON.stringify({ recipeDigest, variantDigest, effectiveValuesDigest, rendererFingerprint, releaseDigest }),
    );

    writeYaml(join(revisionRoot(ctx, variant.name), "variant-revision.yaml"), {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "VariantRevision",
      metadata: { name: `${variant.name}-r001` },
      spec: {
        variant: `../../../variants/${variant.name}/variant.yaml`,
        revision: "r001",
        digest: revisionDigest,
        digestInputs: {
          recipeSHA256: recipeDigest,
          variantSHA256: variantDigest,
          effectiveValuesSHA256: effectiveValuesDigest,
          rendererSHA256: rendererFingerprint,
          renderedObjectSetSHA256: releaseDigest,
        },
        rendered: {
          releaseObjects: "rendered/release-objects.yaml",
          objectInventory: "rendered/object-inventory.yaml",
          objectCount: objects.length,
        },
      },
    });

    const scanFindings = scanDocs(ctx, docs);
    const scanCounts = findingCounts(scanFindings);
    const scanResult = scanFindings.some((finding) => finding.severity === "high") ? "warn" : scanFindings.length ? "warn" : "pass";
    const policyBundleDigest = sha256(JSON.stringify(scanPolicy));
    writeYaml(join(receiptsRoot, "render-receipt.yaml"), {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "RenderReceipt",
      metadata: { name: `${ctx.receiptSlug}-${variant.name}-r001` },
      spec: {
        variantRevision: "../variant-revision.yaml",
        renderer: {
          name: "helm",
          version: helmVersion,
          kubeVersion: chart.kubeVersion,
          flags: ctx.renderFlags,
          ...((variant.apiVersions ?? []).length ? { apiVersions: variant.apiVersions } : {}),
        },
        inputs: {
          sourceLockSHA256: sha256File(join(proofRoot, "source-lock.yaml")),
          dependencyLockSHA256: sha256File(join(proofRoot, "dependency-lock.yaml")),
          effectiveValuesSHA256: effectiveValuesDigest,
        },
        outputs: {
          renderedObjectSetSHA256: releaseDigest,
          renderedObjectInventorySHA256: sha256File(join(renderedRoot, "object-inventory.yaml")),
          deterministicAcrossTwoLocalRenders: true,
          objectCount: objects.length,
          renderedSecretCount: secretCount,
          secretCountSeparatedByCubInstall: variant.expectedSecretCount ?? 0,
        },
      },
    });
    writeYaml(join(receiptsRoot, "helm-equivalence-receipt.yaml"), {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "HelmEquivalenceReceipt",
      metadata: { name: `${ctx.receiptSlug}-${variant.name}-r001` },
      spec: {
        variantRevision: "../variant-revision.yaml",
        regularHelm: { renderedSHA256: releaseDigest, objectCount: objects.length },
        cubInstall: {
          objectCountIncludingSecretsAndSupportObjects: objects.length + ctx.supportObjects.length,
          uploadedManifestFiles: objects.length + ctx.supportObjects.length,
          separatedSecretFiles: variant.expectedSecretCount ?? 0,
          semanticObjectMatches: `${objects.length}/${objects.length}`,
        },
        semanticNormalizations: ctx.semanticNormalizations,
        classifications: [
          ...ctx.supportObjects.map((identity) => ({
            identity,
            classification: "installer-support-object",
            disposition: "allowed",
          })),
          ...(ctx.spec.extraEquivalenceClassifications?.(variant) ?? []),
        ],
        result: "pass",
        evidenceCommand: ctx.offlineCandidate
          ? `npm run ${ctx.scriptPrefix}:verify`
          : `npm run ${ctx.scriptPrefix}:compare`,
      },
    });
    writeYaml(join(receiptsRoot, "scan-receipt.yaml"), {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "ScanReceipt",
      metadata: { name: `${ctx.receiptSlug}-${variant.name}-r001` },
      spec: {
        variantRevision: "../variant-revision.yaml",
        renderedObjectSetSHA256: releaseDigest,
        result: scanResult,
        scanner: { name: scanPolicy.scanner, version: scanPolicy.version },
        policyBundleDigest,
        findingCounts: scanCounts,
        findings: scanFindings,
      },
    });
    const declaredGate = ctx.spec.installGate(variant);
    const gate = ctx.offlineCandidate
      ? {
          decision: "blocked",
          allowedScopes: ["offline-local-evaluation"],
          blockedScopes: ["live-cluster", "root-catalog-promotion", "production"],
          reasons: [
            ...declaredGate.reasons.map((reason) => candidateSafeText(ctx, reason)),
            "live qualification has not run",
            "Kubara ServiceDefinition, wrapper, defaults, and additions compatibility is incomplete",
          ],
        }
      : declaredGate;
    writeYaml(join(receiptsRoot, "install-gate.yaml"), {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "InstallGate",
      metadata: { name: `${ctx.receiptSlug}-${variant.name}-r001` },
      spec: {
        variantRevision: "../variant-revision.yaml",
        renderedObjectSetSHA256: releaseDigest,
        decision: gate.decision,
        allowedScopes: gate.allowedScopes ?? ["local-test"],
        blockedScopes: gate.blockedScopes ?? ["production"],
        reasons: gate.reasons,
      },
    });
    summaries.push({ ...variant, releaseDigest, objects, scanCounts, scanResult });
  }

  writeYaml(join(proofRoot, "helm-plan.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "HelmPlan",
    metadata: { name: lockName },
    spec: {
      readiness: {
        status: ctx.offlineCandidate ? "offline-candidate" : ctx.spec.plan.status,
        chart: chartRef,
        version: chart.version,
        variants: variants.map((variant) => variant.name),
        helmObjectsByVariant: Object.fromEntries(summaries.map((summary) => [summary.name, summary.objects.length])),
        cubInstallObjectsByVariant: Object.fromEntries(
          summaries.map((summary) => [summary.name, summary.objects.length + ctx.supportObjects.length]),
        ),
        helmMatchByVariant: Object.fromEntries(summaries.map((summary) => [summary.name, `${summary.objects.length}/${summary.objects.length}`])),
        scanGate: ctx.offlineCandidate
          ? "offline-only-live-qualification-required"
          : ctx.spec.plan.scanGate,
        ...candidateSafeValue(ctx, ctx.spec.plan.extraReadiness ?? {}),
        nextAction: ctx.offlineCandidate
          ? "complete Kubara compatibility and serial live qualification before root Catalog promotion"
          : ctx.spec.plan.nextAction,
      },
      receipts: summaries.flatMap((summary) => [
        `revisions/${summary.name}/r001/receipts/helm-equivalence-receipt.yaml`,
        `revisions/${summary.name}/r001/receipts/render-receipt.yaml`,
        `revisions/${summary.name}/r001/receipts/scan-receipt.yaml`,
        `revisions/${summary.name}/r001/receipts/install-gate.yaml`,
      ]),
    },
  });
  writeYaml(join(proofRoot, "chart-dossier.yaml"), {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "ChartDossier",
    metadata: { name: lockName },
    spec: {
      chart: chartRef,
      version: chart.version,
      ...candidateSafeValue(ctx, ctx.spec.dossier.extra ?? {}),
      maintainedNotes: candidateSafeValue(ctx, ctx.spec.dossier.maintainedNotes),
      knownControlPoints: candidateSafeValue(ctx, ctx.spec.dossier.knownControlPoints),
    },
  });
  writeReadme(ctx, summaries);
  console.log(`Wrote ${relativeRepo(proofRoot)}`);
}

function generatePackage(ctx) {
  const { chart, variants, packageRoot, packageRelative, receiptPath } = ctx;
  verifyProof(ctx);
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  writeYaml(join(packageRoot, "installer.yaml"), {
    apiVersion: "installer.confighub.com/v1alpha1",
    kind: "Package",
    metadata: { name: ctx.packageName, version: chart.version },
    spec: {
      bases: variants.map((variant, index) => ({
        name: variant.base,
        path: `bases/${variant.base}`,
        default: index === 0 ? true : undefined,
        description: `${chart.name} ${variant.displayName} variant rendered from ${ctx.chartRef}@${chart.version}`,
        externalRequires: externalRequiresForVariant(variant),
      })),
      ...(ctx.spec.packageInputs?.length ? { inputs: ctx.spec.packageInputs } : {}),
      ...(variants.some((variant) => hasTargetFacts(variant))
        ? {
            collector: {
              command: "/bin/sh",
              args: ["collector/target-facts.sh"],
              description:
                "Records target-fact bindings and can live-check cluster-visible Secret and CRD requirements.",
            },
          }
        : {}),
      ...(ctx.spec.packageTransformers?.length ? { transformers: ctx.spec.packageTransformers } : {}),
    },
  });
  if (variants.some((variant) => hasTargetFacts(variant))) {
    write(join(packageRoot, "collector", "target-facts.sh"), targetFactsCollectorScript(variants));
  }
  const packageExtraPaths = typeof ctx.spec.packageExtraPaths === "function"
    ? ctx.spec.packageExtraPaths({ ctx })
    : (ctx.spec.packageExtraPaths ?? []);
  for (const extra of packageExtraPaths) {
    check(
      typeof extra?.source === "string"
        && typeof extra?.destination === "string"
        && extra.source
        && extra.destination
        && !extra.destination.startsWith("/")
        && !extra.destination.split("/").includes(".."),
      "packageExtraPaths entries require safe source and destination paths",
    );
    const source = join(repoRoot, extra.source);
    const destination = join(packageRoot, extra.destination);
    check(existsSync(source), `package extra source is missing: ${extra.source}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  const declaredPackageReadme = ctx.spec.packageReadme?.({ ctx }) ?? `# ${ctx.chartRef} ${chart.version} Installer Package

This package is generated from the ${ctx.receiptSlug} proof artifacts.

\`\`\`sh
${proofCommands(ctx)}
\`\`\`
`;
  const safePackageReadme = candidateSafeText(ctx, declaredPackageReadme);
  const packageReadmeLines = safePackageReadme.trimEnd().split("\n");
  if (ctx.offlineCandidate) packageReadmeLines.splice(1, 0, "", candidateBoundary(ctx).trimEnd());
  write(join(packageRoot, "README.md"), `${packageReadmeLines.join("\n")}\n`);
  for (const variant of variants) {
    const baseRoot = join(packageRoot, "bases", variant.base);
    mkdirSync(baseRoot, { recursive: true });
    writeYaml(join(baseRoot, "kustomization.yaml"), {
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
      resources: ["upstream.yaml"],
    });
    write(
      join(baseRoot, "upstream.yaml"),
      readFileSync(join(revisionRoot(ctx, variant.name), "rendered", "release-objects.yaml"), "utf8"),
    );
  }

  const files = listFiles(packageRoot).map((path) => ({
    path: relative(packageRoot, path),
    sha256: sha256File(path),
    bytes: readFileSync(path).length,
  }));
  const tempRoot = mkdtempSync(join(tmpdir(), `${ctx.receiptSlug}-installer-package-`));
  try {
    const firstPackage = join(tempRoot, `${ctx.receiptSlug}-${chart.version}-a.tgz`);
    const secondPackage = join(tempRoot, `${ctx.receiptSlug}-${chart.version}-b.tgz`);
    runCub(["installer", "package", packageRoot, "-o", firstPackage]);
    runCub(["installer", "package", packageRoot, "-o", secondPackage]);
    const firstSHA = sha256File(firstPackage);
    const secondSHA = sha256File(secondPackage);
    if (firstSHA !== secondSHA || !readFileSync(firstPackage).equals(readFileSync(secondPackage))) {
      throw new Error("cub installer package did not produce byte-identical bundles");
    }
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeYaml(receiptPath, {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "InstallerPackageReceipt",
      metadata: { name: ctx.lockName },
      spec: {
        chart: { repository: chart.repository, name: chart.name, version: chart.version },
        package: {
          path: packageRelative,
          name: ctx.packageName,
          version: chart.version,
          sourceFiles: files,
        },
        deterministicBundle: {
          command: `cub installer package ${packageRelative} -o <tmp>/${ctx.receiptSlug}-${chart.version}.tgz`,
          sha256: firstSHA,
          byteIdenticalAcrossTwoLocalBundles: true,
        },
        setupChecks: variants.map((variant) => ({
          variant: variant.name,
          base: variant.base,
          command: `cub installer setup --pull ${packageRelative} --base ${variant.base} --work-dir <tmp> --non-interactive --namespace ${chart.namespace}`,
          helmReleaseObjectCount: variant.expectedObjectCount,
          cubInstallObjectCountIncludingSupport: variant.expectedObjectCount + ctx.supportObjects.length,
          semanticObjectMatches: `${variant.expectedObjectCount}/${variant.expectedObjectCount}`,
          separatedSecretCount: variant.expectedSecretCount ?? 0,
          targetFactMode: hasTargetFacts(variant) ? "collector-facts" : "not-required",
          targetFactsBound: hasTargetFacts(variant),
          allowedCubOnlyObjects: ctx.supportObjects,
        })),
      },
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  verifyPackage(ctx);
  console.log(`Wrote ${packageRelative}`);
  console.log(`Wrote ${relativeRepo(receiptPath)}`);
}

function requiredProofFiles(ctx) {
  const base = [
    "README.md",
    "helm-plan.yaml",
    "chart-dossier.yaml",
    "source-lock.yaml",
    "dependency-lock.yaml",
    "control-points.yaml",
    "value-model.yaml",
  ];
  for (const variant of ctx.variants) base.push(variant.valuesFile);
  for (const file of ctx.spec.extraRequiredFiles ?? []) base.push(file);
  base.push("recipe.yaml");
  for (const variant of ctx.variants) {
    base.push(
      `variants/${variant.name}/variant.yaml`,
      `revisions/${variant.name}/r001/variant-revision.yaml`,
      `revisions/${variant.name}/r001/rendered/release-objects.yaml`,
      `revisions/${variant.name}/r001/rendered/object-inventory.yaml`,
      `revisions/${variant.name}/r001/receipts/helm-equivalence-receipt.yaml`,
      `revisions/${variant.name}/r001/receipts/render-receipt.yaml`,
      `revisions/${variant.name}/r001/receipts/scan-receipt.yaml`,
      `revisions/${variant.name}/r001/receipts/install-gate.yaml`,
    );
  }
  return base;
}

function verifyProof(ctx, root = ctx.proofRoot) {
  const { chart, variants } = ctx;
  for (const file of requiredProofFiles(ctx)) {
    check(existsSync(join(root, file)), `missing required file ${file}`);
  }
  const sourceLock = readYaml(join(root, "source-lock.yaml"));
  const dependencyLock = readYaml(join(root, "dependency-lock.yaml"));
  const recipe = readYaml(join(root, "recipe.yaml"));
  const valueModel = readYaml(join(root, "value-model.yaml"));
  const controlPoints = readYaml(join(root, "control-points.yaml"));
  check(sourceLock.kind === "SourceLock", "source-lock.yaml must be SourceLock");
  check(sourceLock.spec.repositoryName === chart.repository, "source repository mismatch");
  check(sourceLock.spec.chart === chart.name, "source chart mismatch");
  check(sourceLock.spec.version === chart.version, "source version mismatch");
  check(Boolean(sourceLock.spec.packageSHA256), "source package SHA must be present");
  if (ctx.offlineCandidate) {
    const evidencePath = sourceLock.spec.evidence?.candidateRenderReceipt;
    check(Boolean(evidencePath), "offline candidate source lock must name its local render receipt");
    check(existsSync(join(root, evidencePath)), "offline candidate source-lock evidence is missing");
    check(sourceLock.spec.evidence?.harnessReceipt == null, "offline candidate must not claim an external harness receipt");
  }
  if (ctx.artifactURL) {
    check(sourceLock.spec.exactArtifact?.url === ctx.artifactURL, "exact artifact URL mismatch");
    check(sourceLock.spec.exactArtifact?.sha256 === ctx.artifactSHA256, "exact artifact SHA mismatch");
    check(sourceLock.spec.exactArtifact?.resolution === "artifact-addressed", "exact artifact resolution mismatch");
    const exactEvidencePath = ctx.offlineCandidate
      ? sourceLock.spec.evidence?.candidateRenderReceipt
      : sourceLock.spec.evidence?.exactArtifactRenderReceipt;
    check(Boolean(exactEvidencePath), "exact artifact source lock must name its local render receipt");
    check(existsSync(join(root, exactEvidencePath)), "exact artifact source-lock evidence is missing");
    check(sourceLock.spec.evidence?.harnessReceipt == null, "exact artifact source lock must not claim a stale harness receipt");
  }
  if (ctx.recordDeprecated) {
    check(sourceLock.spec.deprecated === ctx.expectedDeprecated, "source deprecation marker must be recorded");
  }
  check(dependencyLock.kind === "DependencyLock", "dependency-lock.yaml must be DependencyLock");
  check((dependencyLock.spec.dependencies ?? []).length === ctx.expectedDependencyCount, "dependency lock length mismatch");
  check(recipe.kind === "Recipe", "recipe.yaml must be Recipe");
  check(recipe.spec.variants?.length === variants.length, `recipe must have ${variants.length} variants`);
  check(valueModel.spec.checkedValues?.length >= ctx.spec.valueModel.checkedValues.length, "value model must record checked values");

  const perVariant = new Map();
  for (const variant of variants) {
    const releasePath = join(root, "revisions", variant.name, "r001", "rendered", "release-objects.yaml");
    const releaseDigest = sha256File(releasePath);
    const objects = parseObjects(readFileSync(releasePath, "utf8"));
    check(objects.length === variant.expectedObjectCount, `${variant.name} object count mismatch`);
    const identities = objects.map((object) => object.identity);
    check(new Set(identities).size === identities.length, `${variant.name} duplicate object identities`);

    const inventory = readYaml(join(root, "revisions", variant.name, "r001", "rendered", "object-inventory.yaml"));
    const revision = readYaml(join(root, "revisions", variant.name, "r001", "variant-revision.yaml"));
    const renderReceipt = readYaml(join(root, "revisions", variant.name, "r001", "receipts", "render-receipt.yaml"));
    const equivalence = readYaml(join(root, "revisions", variant.name, "r001", "receipts", "helm-equivalence-receipt.yaml"));
    const scan = readYaml(join(root, "revisions", variant.name, "r001", "receipts", "scan-receipt.yaml"));
    const gate = readYaml(join(root, "revisions", variant.name, "r001", "receipts", "install-gate.yaml"));
    check(inventory.spec.sourceSHA256 === releaseDigest, `${variant.name} inventory source digest mismatch`);
    check(inventory.spec.objectCount === variant.expectedObjectCount, `${variant.name} inventory object count mismatch`);
    check(revision.spec.digestInputs.renderedObjectSetSHA256 === releaseDigest, `${variant.name} revision digest mismatch`);
    check(renderReceipt.spec.outputs.renderedObjectSetSHA256 === releaseDigest, `${variant.name} render receipt digest mismatch`);
    check(renderReceipt.spec.outputs.objectCount === variant.expectedObjectCount, `${variant.name} render receipt count mismatch`);
    check(renderReceipt.spec.outputs.deterministicAcrossTwoLocalRenders === true, `${variant.name} must be deterministic`);
    check(equivalence.spec.regularHelm.renderedSHA256 === releaseDigest, `${variant.name} equivalence digest mismatch`);
    check(equivalence.spec.result === "pass", `${variant.name} equivalence must pass`);
    check(
      equivalence.spec.cubInstall.semanticObjectMatches === `${variant.expectedObjectCount}/${variant.expectedObjectCount}`,
      `${variant.name} semantic match mismatch`,
    );
    check(scan.spec.renderedObjectSetSHA256 === releaseDigest, `${variant.name} scan digest mismatch`);
    check(gate.spec.renderedObjectSetSHA256 === releaseDigest, `${variant.name} install gate digest mismatch`);
    const expectedDecision = ctx.offlineCandidate
      ? "blocked"
      : ctx.spec.installGate(variant).decision;
    check(gate.spec.decision === expectedDecision, `${variant.name} install gate decision mismatch`);
    perVariant.set(variant.name, { releasePath, releaseDigest, objects, identities, inventory, revision, renderReceipt, equivalence, scan, gate });
  }

  if (ctx.spec.verifyExtra) {
    ctx.spec.verifyExtra({
      root,
      ctx,
      variants,
      controlPoints,
      sourceLock,
      dependencyLock,
      recipe,
      valueModel,
      perVariant,
      // re-exported helpers so chart specs stay dependency-light
      check,
      readYaml,
      readFileSync,
      join,
    });
  }
  console.log(`verified ${ctx.receiptSlug} proof artifacts`);
}

function verifyProofSelfTest(ctx) {
  const tempRoot = mkdtempSync(join(tmpdir(), `${ctx.receiptSlug}-proof-self-test-`));
  try {
    cpSync(ctx.proofRoot, tempRoot, { recursive: true });
    const firstVariant = ctx.variants[0].name;
    const releasePath = join(tempRoot, "revisions", firstVariant, "r001", "rendered", "release-objects.yaml");
    write(releasePath, `${readFileSync(releasePath, "utf8")}\n# tampered\n`);
    let rejected = false;
    try {
      verifyProof(ctx, tempRoot);
    } catch (error) {
      rejected = String(error.message).includes("inventory source digest mismatch");
    }
    if (!rejected) throw new Error("self-test did not reject rendered object tampering");
    console.log(`self-test passed: ${ctx.receiptSlug} rendered object tampering is rejected`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyPackage(ctx) {
  const { chart, variants, packageRoot, packageRelative, receiptPath } = ctx;
  verifyProof(ctx);
  const generateCommand = ctx.offlineCandidate
    ? `${ctx.scriptPrefix}:generate`
    : `${ctx.scriptPrefix}:generate-package`;
  check(existsSync(packageRoot), `missing package root ${packageRelative}; run npm run ${generateCommand}`);
  check(existsSync(receiptPath), `missing installer package receipt; run npm run ${generateCommand}`);
  const installer = readYaml(join(packageRoot, "installer.yaml"));
  const receipt = readYaml(receiptPath);
  check(installer.kind === "Package", "installer.yaml must be Package");
  check(installer.metadata.name === ctx.packageName, "package name mismatch");
  check(receipt.kind === "InstallerPackageReceipt", "package receipt kind mismatch");
  check(receipt.spec.package.path === packageRelative, "receipt package path mismatch");

  const bases = installer.spec.bases ?? [];
  check(bases.length === variants.length, `package must declare ${variants.length} bases`);
  check(bases.filter((base) => base.default === true).length === 1, "package must have one default base");
  if (ctx.spec.packageInputs?.length) {
    check(stableJson(installer.spec.inputs ?? []) === stableJson(ctx.spec.packageInputs), "package inputs must match proof spec");
  }
  if (ctx.spec.packageTransformers?.length) {
    check(
      stableJson(installer.spec.transformers ?? []) === stableJson(ctx.spec.packageTransformers),
      "package transformers must match proof spec",
    );
  }
  for (const variant of variants) {
    const base = bases.find((item) => item.name === variant.base);
    check(Boolean(base), `missing base ${variant.base}`);
    check(base.path === `bases/${variant.base}`, `${variant.name} base path mismatch`);
    check(
      readFileSync(join(packageRoot, base.path, "upstream.yaml"), "utf8") ===
        readFileSync(join(revisionRoot(ctx, variant.name), "rendered", "release-objects.yaml"), "utf8"),
      `${variant.name} package upstream must match rendered release objects`,
    );
  }

  const receiptFiles = receipt.spec.package.sourceFiles ?? [];
  const actualFiles = listFiles(packageRoot).map((path) => ({
    path: relative(packageRoot, path),
    sha256: sha256File(path),
    bytes: readFileSync(path).length,
  }));
  check(receiptFiles.length === actualFiles.length, "package source file count mismatch");
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  for (const file of receiptFiles) {
    const actual = actualByPath.get(file.path);
    check(Boolean(actual), `receipt references missing file ${file.path}`);
    check(actual.sha256 === file.sha256, `source file SHA mismatch for ${file.path}`);
    check(actual.bytes === file.bytes, `source file byte count mismatch for ${file.path}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), `${ctx.receiptSlug}-package-verify-`));
  try {
    const firstPackage = join(tempRoot, `${ctx.receiptSlug}-a.tgz`);
    const secondPackage = join(tempRoot, `${ctx.receiptSlug}-b.tgz`);
    runCub(["installer", "package", packageRoot, "-o", firstPackage]);
    runCub(["installer", "package", packageRoot, "-o", secondPackage]);
    const firstSHA = sha256File(firstPackage);
    const secondSHA = sha256File(secondPackage);
    check(firstSHA === secondSHA, "package SHA changed across two local bundles");
    check(readFileSync(firstPackage).equals(readFileSync(secondPackage)), "package bytes changed across two local bundles");
    check(firstSHA === receipt.spec.deterministicBundle.sha256, "deterministic bundle SHA mismatch");
    for (const variant of variants) verifySetupVariant(ctx, tempRoot, variant, receipt);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`${ctx.receiptSlug} installer package verification passed`);
}

function externalRequiresForVariant(variant) {
  const requiredSecrets = variant.targetFacts?.requiredSecrets ?? [];
  const requiredCRDs = variant.targetFacts?.requiredCRDs ?? [];
  const requiredObjectStores = variant.targetFacts?.requiredObjectStores ?? [];
  const requirements = requiredCRDs.map((crd) => ({
      kind: "ClusterFeature",
      name: `CRD ${crd.name}`,
      suggestedSource:
        crd.suggestedSource ?? "kubectl apply -f <crd-manifest.yaml>",
      ...(crd.applyMode ? { applyMode: crd.applyMode } : {}),
    }));
  requirements.push(
    ...requiredSecrets.map((secret) => ({
      kind: "ClusterFeature",
      name: `Secret ${secret.namespace}/${secret.name}${(secret.keys ?? []).length === 1 ? ` key ${secret.keys[0]}` : (secret.keys ?? []).length > 1 ? ` keys ${secret.keys.join(",")}` : ""}`,
      namespace: secret.namespace,
      suggestedSource:
        secret.suggestedSource ??
        ((secret.keys ?? []).length
          ? `kubectl -n ${secret.namespace} create secret generic ${secret.name} ${secret.keys.map((key) => `--from-literal=${key}=<value>`).join(" ")}`
          : `kubectl -n ${secret.namespace} apply -f <secret-manifest.yaml>`),
    })),
  );
  requirements.push(
    ...requiredObjectStores.map((store) => ({
      kind: "ClusterFeature",
      name: `S3-compatible object store ${store.namespace}/${store.name}`,
      namespace: store.namespace,
      suggestedSource: store.suggestedSource ?? "create or bind an S3-compatible endpoint, bucket, and credentials before apply",
    })),
  );
  return requirements.length ? requirements : undefined;
}

function targetFactsCollectorScript(variants) {
  const variantCases = variants
    .filter((variant) => hasTargetFacts(variant))
    .map((variant) => {
      const targetFacts = variant.targetFacts ?? {};
      const checks = (variant.targetFacts.requiredSecrets ?? [])
        .flatMap((secret) =>
          (secret.keys ?? []).length
            ? secret.keys.map((key) => `      live_check_secret '${secret.namespace}' '${secret.name}' '${key}'`)
            : [`      live_check_secret '${secret.namespace}' '${secret.name}' ''`],
        )
        .concat((variant.targetFacts.requiredCRDs ?? []).map((crd) => `      live_check_crd '${crd.name}'`))
        .concat(
          variant.targetFacts.requiredTopology?.minimumSchedulableNodes
            ? [`      live_check_min_schedulable_nodes '${variant.targetFacts.requiredTopology.minimumSchedulableNodes}'`]
            : [],
        )
        .join("\n");
      const requiredSecrets = yamlList(targetFacts.requiredSecrets);
      const requiredCRDs = yamlList(targetFacts.requiredCRDs);
      const requiredValues = yamlList(targetFacts.requiredValues);
      const requiredObjectStores = yamlList(targetFacts.requiredObjectStores);
      const requiredTopology = yamlValue(targetFacts.requiredTopology);
      return `  '${variant.base}')\n    if [ "$check_mode" = "live" ]; then\n${checks || "      true"}\n      result="pass"\n    else\n      result="recorded"\n    fi\n    cat <<YAML\ntargetFacts:\n  requiredSecrets:${requiredSecrets}\n  requiredCRDs:${requiredCRDs}\n  requiredValues:${requiredValues}\n  requiredObjectStores:${requiredObjectStores}\n  requiredTopology:${requiredTopology}\ntargetFactChecks:\n  base: "$base"\n  mode: "$check_mode"\n  result: "$result"\nYAML\n    ;;`;
    })
    .join("\n");
  return `#!/bin/sh\nset -eu\n\nbase="\${INSTALLER_BASE:-default}"\ncheck_mode="\${TARGET_FACT_CHECK_MODE:-record}"\n\nemit_empty() {\n  cat <<YAML\ntargetFacts:\n  requiredSecrets: []\n  requiredCRDs: []\n  requiredValues: []\n  requiredObjectStores: []\n  requiredTopology: null\ntargetFactChecks:\n  base: "$base"\n  mode: not-required\n  result: pass\nYAML\n}\n\nlive_check_secret() {\n  namespace="$1"\n  name="$2"\n  key="$3"\n  if ! command -v kubectl >/dev/null 2>&1; then\n    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2\n    exit 1\n  fi\n  if ! kubectl -n "$namespace" get secret "$name" >/dev/null 2>&1; then\n    echo "required Secret $namespace/$name was not found" >&2\n    exit 1\n  fi\n  if [ -z "$key" ]; then\n    return 0\n  fi\n  if ! kubectl -n "$namespace" get secret "$name" -o yaml | awk -v key="$key" '$1 == key \":\" { found=1 } END { exit found ? 0 : 1 }'; then\n    echo "required Secret $namespace/$name is missing key $key" >&2\n    exit 1\n  fi\n}\n\nlive_check_crd() {\n  name="$1"\n  if ! command -v kubectl >/dev/null 2>&1; then\n    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2\n    exit 1\n  fi\n  if ! kubectl get crd "$name" >/dev/null 2>&1; then\n    echo "required CRD $name was not found" >&2\n    exit 1\n  fi\n}\n\nlive_check_min_schedulable_nodes() {\n  required="$1"\n  if ! command -v kubectl >/dev/null 2>&1; then\n    echo "kubectl is required for TARGET_FACT_CHECK_MODE=live" >&2\n    exit 1\n  fi\n  count="$(kubectl get nodes -o jsonpath='{range .items[*]}{.spec.unschedulable}{\"\\n\"}{end}' | awk '$1 != \"true\" { c++ } END { print c + 0 }')"\n  if [ "$count" -lt "$required" ]; then\n    echo "required at least $required schedulable node(s); found $count" >&2\n    exit 1\n  fi\n}\n\ncase "$base" in\n${variantCases}\n  *)\n    emit_empty\n    ;;\nesac\n`;
}

function hasTargetFacts(variant) {
  return Boolean(
    (variant.targetFacts?.requiredSecrets ?? []).length ||
      (variant.targetFacts?.requiredCRDs ?? []).length ||
      (variant.targetFacts?.requiredValues ?? []).length ||
      (variant.targetFacts?.requiredObjectStores ?? []).length ||
      variant.targetFacts?.requiredTopology,
  );
}

function yamlList(items) {
  return items?.length ? `\n${toYaml(items, 2)}` : " []";
}

function yamlValue(value) {
  return value ? `\n${toYaml(value, 4)}` : " null";
}

function verifySetupVariant(ctx, tempRoot, variant, receipt) {
  const { chart } = ctx;
  const checkReceipt = (receipt.spec.setupChecks ?? []).find((item) => item.variant === variant.name);
  check(Boolean(checkReceipt), `receipt missing setup check for ${variant.name}`);
  const workDir = join(tempRoot, `work-${variant.name}`);
  runCub([
    "installer",
    "setup",
    "--pull",
    ctx.packageRoot,
    "--base",
    variant.base,
    "--work-dir",
    workDir,
    "--non-interactive",
    "--namespace",
    chart.namespace,
  ]);
  const helmYaml = readFileSync(join(revisionRoot(ctx, variant.name), "rendered", "release-objects.yaml"), "utf8");
  const cubFiles = objectFilesFromDirs([join(workDir, "out", "manifests"), join(workDir, "out", "secrets")]);
  const cubYaml = cubFiles.map((file) => file.yaml).join("\n---\n");
  const semantic = canonicalObjectMaps(helmYaml, cubYaml);
  const helmObjects = new Set(Object.keys(semantic.helm));
  const cubObjects = new Set(Object.keys(semantic.cub));
  check(helmObjects.size === variant.expectedObjectCount, `${variant.name} Helm object count mismatch`);
  check(cubObjects.size === variant.expectedObjectCount + ctx.supportObjects.length, `${variant.name} cub object count mismatch`);
  const missingFromCub = difference(helmObjects, cubObjects);
  check(missingFromCub.length === 0, `${variant.name} cub output missing Helm object(s): ${missingFromCub.join(", ")}`);
  const extraInCub = difference(cubObjects, helmObjects);
  check(
    JSON.stringify(extraInCub) === JSON.stringify([...ctx.supportObjects].sort()),
    `${variant.name} cub output may add only ${ctx.supportObjects.join(", ")}; found ${extraInCub.join(", ")}`,
  );
  const semanticDiffs = [];
  for (const key of helmObjects) {
    if (
      semantic.helm[key] !== semantic.cub[key] &&
      !ctx.spec.allowedSemanticDiff?.({ key, helmObjectJson: semantic.helm[key], cubObjectJson: semantic.cub[key], variant })
    ) {
      semanticDiffs.push(key);
    }
  }
  check(semanticDiffs.length === 0, `${variant.name} semantic diffs: ${semanticDiffs.join(", ")}`);
  const secretFiles = listYamlFiles(join(workDir, "out", "secrets"));
  check(secretFiles.length === (variant.expectedSecretCount ?? 0), `${variant.name} separated Secret count mismatch`);
}

function pullSource(ctx) {
  const { chart } = ctx;
  const tempRoot = mkdtempSync(join(tmpdir(), `${ctx.receiptSlug}-source-`));
  try {
    const packagePath = materializeChartPackage(ctx, tempRoot);
    command("tar", ["-xzf", packagePath, "-C", tempRoot]);
    const chartYamlPaths = listFiles(tempRoot).filter((path) => path.endsWith("/Chart.yaml"));
    const matchingChartYamlPaths = chartYamlPaths.filter((path) => {
      const metadata = readYaml(path);
      return metadata.name === chart.name
        && String(metadata.version) === String(chart.version);
    });
    check(
      matchingChartYamlPaths.length === 1,
      `chart archive for ${ctx.chartRef}@${chart.version} contained ${matchingChartYamlPaths.length} matching Chart.yaml files among ${chartYamlPaths.length} total`,
    );
    const [chartYamlPath] = matchingChartYamlPaths;
    const chartRoot = dirname(chartYamlPath);
    const chartYaml = readYaml(join(chartRoot, "Chart.yaml"));
    check(chartYaml.name === chart.name, `chart archive name ${chartYaml.name} does not match ${chart.name}`);
    check(
      String(chartYaml.version) === String(chart.version),
      `chart archive version ${chartYaml.version} does not match ${chart.version}`,
    );
    const chartLockPath = join(chartRoot, "Chart.lock");
    const chartLock = existsSync(chartLockPath) ? readYaml(chartLockPath) : null;
    const dependencies = chartLock?.dependencies ?? chartYaml.dependencies ?? [];
    return {
      appVersion: chartYaml.appVersion,
      deprecated: Boolean(chartYaml.deprecated),
      packageSHA256: sha256File(packagePath),
      packageBytes: readFileSync(packagePath).length,
      defaultValuesSHA256: sha256File(join(chartRoot, "values.yaml")),
      chartLockDigest: chartLock?.digest ?? null,
      chartLockProvenance: chartLock || dependencies.length === 0 ? null : {
        status: "source-derived-from-packaged-chart-yaml",
        packageSHA256: sha256File(packagePath),
        packageContainsChartLock: false,
        dependencySource: "Chart.yaml dependencies from the chart package recorded in source-lock.yaml",
      },
      dependencies,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function renderVariant(ctx, variant) {
  const { chart } = ctx;
  const tempRoot = mkdtempSync(join(tmpdir(), `${ctx.receiptSlug}-render-`));
  try {
    const chartSource = ctx.artifactURL ? materializeChartPackage(ctx, tempRoot) : ctx.helmChartRef;
    const args = [
      "template",
      chart.releaseName,
      chartSource,
      "--namespace",
      chart.namespace,
      "--kube-version",
      chart.kubeVersion,
      ...ctx.renderFlags,
    ];
    if (!ctx.artifactURL) args.splice(3, 0, "--version", chart.version);
    if (variant.valuesText) {
      const valuesPath = join(tempRoot, "values.yaml");
      write(valuesPath, variant.valuesText);
      args.push("--values", valuesPath);
    }
    for (const apiVersion of variant.apiVersions ?? []) {
      args.push("--api-versions", apiVersion);
    }
    const first = command("helm", args);
    const second = command("helm", args);
    return { first, second, deterministic: sha256(first) === sha256(second) };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function materializeChartPackage(ctx, tempRoot) {
  const { chart } = ctx;
  if (!ctx.artifactURL) {
    command("helm", ["pull", ctx.helmChartRef, "--version", chart.version, "--destination", tempRoot]);
  } else if (/^https?:\/\//.test(ctx.artifactURL)) {
    const destination = join(tempRoot, `${chart.name}-${chart.version}.tgz`);
    command("curl", ["--fail", "--location", "--retry", "3", "--silent", "--show-error", "--output", destination, ctx.artifactURL]);
  } else if (ctx.artifactURL.startsWith("oci://")) {
    const versionSuffix = `:${chart.version}`;
    const artifactRef = ctx.artifactURL.endsWith(versionSuffix)
      ? ctx.artifactURL.slice(0, -versionSuffix.length)
      : ctx.artifactURL;
    command("helm", ["pull", artifactRef, "--version", chart.version, "--destination", tempRoot]);
  } else {
    throw new Error(`unsupported exact chart artifact URL ${ctx.artifactURL}`);
  }
  const packagePath = listFiles(tempRoot).find((path) => path.endsWith(".tgz"));
  check(Boolean(packagePath), `chart artifact retrieval produced no archive for ${ctx.chartRef}@${chart.version}`);
  if (ctx.artifactSHA256) {
    check(
      sha256File(packagePath) === ctx.artifactSHA256,
      `chart artifact SHA mismatch for ${ctx.chartRef}@${chart.version}`,
    );
  }
  return packagePath;
}

function effectiveValuesDoc(ctx, variant, defaultValuesSHA256) {
  if (!variant.valuesText) {
    return {
      apiVersion: "helm-expt.confighub.com/v1alpha1",
      kind: "EffectiveValues",
      metadata: { name: `${ctx.lockName}-${variant.name}` },
      spec: {
        profile: "chart-defaults",
        defaultValuesSHA256,
        mergedValuesCaptured: false,
        values: {},
      },
    };
  }
  return {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "EffectiveValues",
    metadata: { name: `${ctx.lockName}-${variant.name}` },
    spec: {
      files: [{ path: variant.valuesFile, source: "inline-proof", sha256: sha256(variant.valuesText) }],
      mergedValuesCaptured: false,
      values: readYamlText(variant.valuesText),
    },
  };
}

function variantDocFor(ctx, variant) {
  const { chart } = ctx;
  const doc = {
    apiVersion: "helm-expt.confighub.com/v1alpha1",
    kind: "Variant",
    metadata: { name: variant.name },
    spec: {
      recipe: "../../recipe.yaml",
      namespace: chart.namespace,
      releaseName: chart.releaseName,
      valuesProfile: `../../${variant.valuesFile}`,
      capabilityProfile: { kubeVersion: chart.kubeVersion, apiVersions: variant.apiVersions ?? [] },
      hookPolicy: "no-hooks",
    },
  };
  if (variant.targetFacts) doc.spec.targetFacts = variant.targetFacts;
  return doc;
}

function scanDocs(ctx, docs) {
  const findings = [];
  const serviceAccounts = new Set(
    docs.filter((doc) => doc.kind === "ServiceAccount").map((doc) => `${doc.metadata?.namespace ?? ""}/${doc.metadata?.name ?? ""}`),
  );
  const workloads = docs.filter((doc) => workloadPodSpec(doc));
  for (const doc of workloads) {
    const object = identityFor(doc);
    const podSpec = workloadPodSpec(doc);
    const containers = [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])];
    for (const container of containers) {
      const tag = imageTag(container.image ?? "");
      if (!tag || tag === "latest") {
        findings.push({
          id: `mutable-image-tag:${object}:${container.name ?? "container"}`,
          rule: "mutable-image-tag",
          severity: "high",
          object,
          message: `container ${container.name ?? "container"} uses mutable image ${container.image ?? ""}`,
        });
      }
    }
    const serviceAccountName = podSpec.serviceAccountName;
    const namespace = doc.metadata?.namespace ?? "";
    if (serviceAccountName && !serviceAccounts.has(`${namespace}/${serviceAccountName}`)) {
      findings.push({
        id: `workload-service-account-exists:${object}`,
        rule: "workload-service-account-exists",
        severity: "high",
        object,
        message: `workload references missing ServiceAccount ${namespace}/${serviceAccountName}`,
      });
    }
  }
  for (const doc of docs.filter((item) => item.kind === "Service")) {
    const selector = doc.spec?.selector ?? {};
    if (!Object.keys(selector).length) continue;
    const match = workloads.some((workload) => labelsMatch(selector, workloadTemplateLabels(workload)));
    if (!match) {
      findings.push({
        id: `service-selector-has-workload-match:${identityFor(doc)}`,
        rule: "service-selector-has-workload-match",
        severity: "high",
        object: identityFor(doc),
        message: "Service selector matches no rendered workload pod template",
      });
    }
  }
  for (const doc of docs.filter((item) => item.kind === "APIService")) {
    findings.push({
      id: `apiservice-requires-observation:${identityFor(doc)}`,
      rule: "apiservice-requires-observation",
      severity: "medium",
      object: identityFor(doc),
      message: "APIService availability must be observed after apply",
    });
  }
  for (const doc of docs.filter((item) => ["ClusterRole", "ClusterRoleBinding"].includes(item.kind))) {
    findings.push({
      id: `cluster-rbac-review:${identityFor(doc)}`,
      rule: "cluster-rbac-review",
      severity: "medium",
      object: identityFor(doc),
      message: "Cluster-scoped RBAC requires production review",
    });
  }
  // Chart-specific scan rules (e.g. admission webhooks, CRDs) the common ruleset can't infer.
  if (ctx.spec.scanExtra) findings.push(...ctx.spec.scanExtra(docs));
  findings.sort((left, right) => left.id.localeCompare(right.id));
  return findings;
}

function writeReadme(ctx, summaries) {
  const { chart } = ctx;
  const variantLines = summaries
    .map(
      (summary) =>
        `- \`${summary.name}\`: ${summary.valuesSummary}; ${summary.objects.length} Helm objects, ${summary.objects.length + ctx.supportObjects.length} cub installer objects including ${ctx.supportObjects.length === 1 ? "Namespace" : "support objects"}.`,
    )
    .join("\n");
  const provesLines = ctx.spec.readme.proves.map((line) => `- ${line}`).join("\n");
  write(
    join(ctx.proofRoot, "README.md"),
    `# ${ctx.chartRef} ${chart.version} Proof

${candidateBoundary(ctx)}${candidateSafeText(ctx, ctx.spec.readme.intro)}

Variants:

${variantLines}

What this proves:

${candidateSafeText(ctx, provesLines)}

Useful commands:

\`\`\`sh
${proofCommands(ctx)}
\`\`\`
`,
  );
}
