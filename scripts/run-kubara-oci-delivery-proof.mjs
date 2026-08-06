#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  check,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  toYaml,
  write,
  writeYaml,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
const allowedModes = new Set([
  "--rehearse",
  "--run",
  "--generate",
  "--verify",
]);
if (!allowedModes.has(mode)) {
  console.error(`Usage:
  node scripts/run-kubara-oci-delivery-proof.mjs --rehearse
  node scripts/run-kubara-oci-delivery-proof.mjs --run
  node scripts/run-kubara-oci-delivery-proof.mjs --generate
  node scripts/run-kubara-oci-delivery-proof.mjs --verify`);
  process.exit(2);
}

const exampleRoot = join(repoRoot, "examples", "kubara", "local-platform");
const renderedPath = join(exampleRoot, "rendered", "release-objects.yaml");
const sourceLockPath = join(exampleRoot, "source-lock.yaml");
const routeIntentPath = join(exampleRoot, "route-intent.yaml");
const uploadReceiptPath = join(
  exampleRoot,
  "confighub-upload-receipt.yaml",
);
const receiptPath = join(
  repoRoot,
  "runs",
  "kubara-oci-delivery-proof",
  "receipt.yaml",
);
const summaryPath = join(
  repoRoot,
  "data",
  "kubara-oci-delivery-proof",
  "summary.md",
);

const expectedOrg = "helm-catalog";
const kubaraSpace = "kubara-local-platform-v0-12-0";
const kubaraUnit = "release-objects";
const approvalGate = "platform/require-approval/vet-approvedby";
const sourceTargetSpace =
  "bitnami-redis-27-0-0-stage-pilot-live-20260705";
const sourceTarget = "oci-target";
const configHubOciHost = "oci.hub.confighub.com:443";
const bootstrapNamespace = "bootstrap-argocd";
const kubaraNamespace = "argocd";
const bootstrapArgoVersion = "v3.4.5";
const bootstrapArgoManifestUrl =
  `https://raw.githubusercontent.com/argoproj/argo-cd/${bootstrapArgoVersion}/manifests/install.yaml`;
const bootstrapArgoManifestSha256 =
  "cdf6758b489d25641c2a1fd835642543aaa64fe530867d0136a83ddf3dafe456";
const artifactType = "application/vnd.confighub.kubernetes.config.v1";
const deployableLayerType = "application/vnd.oci.image.layer.v1.tar+gzip";
const deferredIdentity =
  "external-secrets.io/v1|ClusterExternalSecret||image-pull-secret-ces";
const projectIdentity =
  "argoproj.io/v1alpha1|AppProject|argocd|test-cluster-local";
const metricsAppSetIdentity =
  "argoproj.io/v1alpha1|ApplicationSet|argocd|metrics-server";
const dexDeploymentIdentity =
  "apps/v1|Deployment|argocd|kubara-platform-argocd-dex-server";
const grpcIngressIdentity =
  "networking.k8s.io/v1|Ingress|argocd|kubara-platform-argocd-server-grpc";
const namespaceIdentity = "v1|Namespace||argocd";
const expectedCrds = [
  "applications.argoproj.io",
  "applicationsets.argoproj.io",
  "appprojects.argoproj.io",
];
const expectedHookIdentities = [
  "v1|ServiceAccount|argocd|kubara-platform-argocd-redis-secret-init",
  "rbac.authorization.k8s.io/v1|Role|argocd|kubara-platform-argocd-redis-secret-init",
  "rbac.authorization.k8s.io/v1|RoleBinding|argocd|kubara-platform-argocd-redis-secret-init",
  "batch/v1|Job|argocd|kubara-platform-argocd-redis-secret-init",
];
const expectedKubaraDeployments = [
  "kubara-platform-argocd-applicationset-controller",
  "kubara-platform-argocd-dex-server",
  "kubara-platform-argocd-redis",
  "kubara-platform-argocd-repo-server",
  "kubara-platform-argocd-server",
];
const expectedKubaraStatefulSets = [
  "kubara-platform-argocd-application-controller",
];
const serviceLabels = [
  "argocd",
  "cert-manager",
  "external-dns",
  "external-secrets",
  "homer-dashboard",
  "kube-prometheus-stack",
  "kyverno",
  "kyverno-policies",
  "kyverno-policy-reporter",
  "loki",
  "longhorn",
  "metallb",
  "metrics-server",
  "oauth2-proxy",
  "reloader",
  "traefik",
  "velero",
];

if (mode === "--rehearse") {
  executeProof({ configHub: false });
} else if (mode === "--run") {
  executeProof({ configHub: true });
} else if (mode === "--generate") {
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  write(summaryPath, renderSummary(receipt));
  console.log(`wrote ${relativeRepo(summaryPath)}`);
} else {
  check(
    existsSync(receiptPath),
    `${relativeRepo(receiptPath)} is missing; run the live proof`,
  );
  check(
    existsSync(summaryPath),
    `${relativeRepo(summaryPath)} is missing; run the generator`,
  );
  const receipt = readYaml(receiptPath);
  verifyReceipt(receipt);
  check(
    readFileSync(summaryPath, "utf8") === renderSummary(receipt),
    `${relativeRepo(summaryPath)} is stale`,
  );
  console.log("verified the Kubara OCI delivery proof");
}

function executeProof({ configHub }) {
  check(
    process.env.HELM_EXPT_ALLOW_LIVE_KUBARA_OCI_PROOF === "1",
    "set HELM_EXPT_ALLOW_LIVE_KUBARA_OCI_PROOF=1 to confirm this live proof",
  );
  const context = process.env.CUB_CONTEXT?.trim() ?? "";
  if (configHub) {
    check(context, "set CUB_CONTEXT to an authenticated helm-catalog context");
  }
  for (const [tool, args] of [
    ["curl", ["--version"]],
    ["docker", ["version"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client"]],
    ["oras", ["version"]],
    ["tar", ["--version"]],
  ]) {
    check(tryCommand(tool, args).ok, `${tool} is required for this proof`);
  }
  if (configHub) {
    check(tryCommand("cub", ["version"]).ok, "cub is required for this proof");
  }

  const runId = safeRunId(
    process.env.HELM_EXPT_PROOF_RUN_ID ?? new Date().toISOString(),
  );
  const clusterName = `hx-kubara-${runId}`;
  const registryName = `hx-kubara-reg-${runId}`;
  const proofTarget = `kubara-proof-${runId}`;
  const applicationName = `kubara-bootstrap-${runId}`;
  const workRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-oci-"));
  const cleanup = {
    unitTarget: "not-needed",
    spaceReleaseTarget: "not-needed",
    temporaryTarget: "not-needed",
    cluster: "not-run",
    registry: "not-run",
    localFiles: "not-run",
  };
  const state = {
    clusterCreated: false,
    registryStarted: false,
    targetCreated: false,
    targetId: "",
    unitTargetSet: false,
    spaceReleaseTargetSet: false,
  };
  let result;
  let failure;

  try {
    phase(`${configHub ? "full run" : "rehearsal"} ${runId}`);
    const sourceText = readFileSync(renderedPath, "utf8");
    const sourceDocs = parseDocs(sourceText);
    validateSource(sourceDocs);
    const nonSecretDocs = sourceDocs.filter((doc) => doc.kind !== "Secret");
    check(nonSecretDocs.length === 75, "expected 75 non-Secret Kubara objects");

    let approvedText = yamlDocuments(nonSecretDocs);
    let review = {
      mode: "rehearsal",
      approvedDataSource: relativeRepo(renderedPath),
      approvedObjectCount: nonSecretDocs.length,
    };
    if (configHub) {
      phase("checking ConfigHub data and approval gate");
      review = reviewInConfigHub({
        context,
        proofTarget,
        state,
        expectedDocs: nonSecretDocs,
      });
      approvedText = review.approvedText;
      delete review.approvedText;
    }

    const approvedDocs = parseDocs(approvedText);
    const prepared = prepareDelivery(approvedDocs);
    phase(
      `prepared ${prepared.deliveryDocs.length} delivery objects from ${approvedDocs.length} approved objects`,
    );

    phase("starting temporary OCI registry");
    const registry = startRegistry(registryName);
    state.registryStarted = true;
    const portable = publishPortableOci({
      workRoot,
      documents: prepared.deliveryDocs,
      registryHost: registry.host,
      clusterRegistryHost: registry.clusterHost,
    });

    phase("creating throwaway kind cluster");
    command("kind", [
      "create",
      "cluster",
      "--name",
      clusterName,
      "--wait",
      "300s",
    ], { timeout: 600_000 });
    state.clusterCreated = true;
    const kubeContext = `kind-${clusterName}`;

    phase("installing bootstrap Argo CD");
    const bootstrap = installBootstrapArgo({
      kubeContext,
      workRoot,
    });

    phase("executing Kubara target routes");
    const routes = executeRoutes({
      kubeContext,
      workRoot,
      approvedDocs,
      sourceDocs,
    });

    phase("delivering the prepared OCI through bootstrap Argo CD");
    configureAnonymousOci({
      kubeContext,
      registryHost: registry.clusterHost,
      workRoot,
    });
    createApplication({
      kubeContext,
      applicationName,
      sourceReference: portable.clusterReference,
      workRoot,
    });
    const bootstrapApplication = waitForApplication({
      kubeContext,
      namespace: bootstrapNamespace,
      name: applicationName,
      expectedRevision: portable.manifestDigest,
      attempts: 120,
    });
    check(
      bootstrapApplication.result === "pass",
      `bootstrap Argo application did not converge: ${bootstrapApplication.reason}`,
    );

    phase("checking Kubara Argo CD and selected platform service");
    const kubara = waitForKubaraPlatform({
      kubeContext,
      attempts: 150,
    });

    result = {
      apiVersion: "catalog.confighub.com/v1alpha1",
      kind: "KubaraOciDeliveryProofReceipt",
      metadata: {
        name: "kubara-local-platform-oci-delivery",
      },
      spec: {
        recordedAt: new Date().toISOString(),
        flow: {
          path: configHub
            ? "Kubara -> ConfigHub review -> route work -> OCI -> bootstrap Argo CD -> Kubara Argo CD -> Metrics Server"
            : "Kubara -> route work -> OCI -> bootstrap Argo CD -> Kubara Argo CD -> Metrics Server",
          portableShape: "work -> OCI",
          access: {
            configHubReview: configHub
              ? "ConfigHub account and server required"
              : "not used in rehearsal",
            routeWork: "local target-side commands; no ConfigHub Server required",
            portablePull: "anonymous; no ConfigHub account required",
          },
        },
        source: {
          renderedObjects: relativeRepo(renderedPath),
          sourceLock: relativeRepo(sourceLockPath),
          routeIntent: relativeRepo(routeIntentPath),
          rawObjectCount: sourceDocs.length,
          nonSecretObjectCount: nonSecretDocs.length,
          rawSha256: sha256(sourceText),
          canonicalNonSecretSha256: sha256(canonicalDocs(nonSecretDocs)),
        },
        configHubReview: review,
        preparation: {
          approvedObjectCount: approvedDocs.length,
          outputObjectCount: prepared.deliveryDocs.length,
          unchangedObjectCount: prepared.unchangedObjectCount,
          changedObjects: prepared.changedObjects,
          executedBeforeDelivery: expectedHookIdentities,
          deferredObjects: [
            {
              identity: deferredIdentity,
              reason:
                "The small live lane does not install External Secrets or a ClusterSecretStore, so the ClusterExternalSecret remains deferred.",
            },
            {
              identity: grpcIngressIdentity,
              reason:
                "The throwaway kind target has no ingress controller, so its Argo CD gRPC Ingress remains deferred.",
            },
          ],
        },
        routes,
        portableRelease: portable,
        cluster: {
          name: clusterName,
          creationCommand: "kind create cluster",
          bootstrapArgo: bootstrap,
          bootstrapApplication,
          kubara,
        },
        cleanup,
        limits: [
          "The public OCI used a temporary registry.",
          "The blocked pre-approval dry-run was observed in guarded run 20260727043744, but ConfigHub did not retain a UnitEvent for the failed dry-run.",
          "The route selected Metrics Server as the one downstream platform service; it did not install every service enabled in the original local-evaluation profile.",
          "The ClusterExternalSecret stayed deferred because this lane did not install External Secrets, a ClusterSecretStore, or its remote key.",
          "The Argo CD gRPC Ingress stayed deferred because this lane did not install an ingress controller.",
          "The local-kind Metrics Server adjustment adds --kubelet-insecure-tls for this throwaway cluster and is not a production recommendation.",
          "The proof uses one cluster. It does not prove a multi-cluster Kubara promotion wave.",
        ],
      },
      status: {
        result: "pass",
        claim:
          "ConfigHub approved the exact Kubara base, target-side route work installed its prerequisites and ran the Redis initializer, a portable OCI delivered the prepared configuration through Argo CD, Kubara Argo CD became ready, and the selected Metrics Server application became Synced and Healthy.",
      },
    };
  } catch (error) {
    failure = error;
  }

  cleanup.spaceReleaseTarget = cleanupSpaceReleaseTarget({
    context,
    state,
  });
  cleanup.unitTarget = cleanupUnitTarget({
    context,
    state,
    proofTarget,
  });
  cleanup.temporaryTarget = cleanupTarget({
    context,
    state,
    proofTarget,
  });
  cleanup.cluster = cleanupCluster(clusterName, state);
  cleanup.registry = cleanupRegistry(registryName, state);
  cleanup.localFiles = cleanupLocalFiles(workRoot);

  if (failure) throw failure;
  check(
    Object.values(cleanup).every(
      (value) => value === "pass" || value === "not-needed",
    ),
    `cleanup did not pass: ${JSON.stringify(cleanup)}`,
  );
  if (configHub) {
    writeYaml(receiptPath, result);
    write(summaryPath, renderSummary(result));
    console.log(`wrote ${relativeRepo(receiptPath)}`);
    console.log(`wrote ${relativeRepo(summaryPath)}`);
  } else {
    console.log(
      `Kubara OCI rehearsal passed (${result.spec.preparation.outputObjectCount} delivered objects, ${result.spec.cluster.kubara.selectedApplication.name} healthy)`,
    );
  }
}

function reviewInConfigHub({
  context,
  proofTarget,
  state,
  expectedDocs,
}) {
  const contextInfo = cubJson(context, [
    "context",
    "get",
    context,
    "-o",
    "json",
  ]);
  check(
    contextInfo.metadata?.organizationName === expectedOrg,
    `refusing to run outside the ${expectedOrg} organization`,
  );
  const spaceBefore = cubJson(context, [
    "space",
    "get",
    kubaraSpace,
    "-o",
    "json",
  ]).Space;
  check(
    !spaceBefore.ReleaseTargetID,
    "the Kubara Space already has a release target; refusing to replace it",
  );
  const before = getUnit(context);
  const approvedText = storedData(before);
  const approvedDocs = parseDocs(approvedText);
  check(
    canonicalDocs(approvedDocs) === canonicalDocs(expectedDocs),
    "live ConfigHub Kubara data differs from the committed non-Secret objects",
  );
  const existingApprovalCount = approvalCount(before.ApprovedBy);
  const resumeApproved = existingApprovalCount > 0;
  if (resumeApproved) {
    check(
      process.env.HELM_EXPT_KUBARA_ALLOW_APPROVED_RESUME === "1",
      "the Kubara Unit is already approved; set HELM_EXPT_KUBARA_ALLOW_APPROVED_RESUME=1 only to resume the guarded run that observed the pre-approval block",
    );
    check(
      process.env.HELM_EXPT_KUBARA_PRIOR_BLOCK_RUN_ID === "20260727043744",
      "set HELM_EXPT_KUBARA_PRIOR_BLOCK_RUN_ID=20260727043744 to identify the guarded run that observed the pre-approval block",
    );
  }
  if (resumeApproved) {
    check(
      before.ApplyGates?.[approvalGate] !== false,
      "the Kubara approval gate is explicitly disabled after approval",
    );
  } else {
    check(
      before.ApplyGates?.[approvalGate] === true,
      "the Kubara Unit does not carry the required approval gate",
    );
  }

  const created = cubJson(context, [
    "target",
    "create",
    "--space",
    kubaraSpace,
    proofTarget,
    "{}",
    "--from-target",
    sourceTarget,
    "--from-target-space",
    sourceTargetSpace,
    "--label",
    "ProofScope=temporary",
    "--quiet",
    "-o",
    "json",
  ]).Target;
  check(created?.ProviderType === "OCI", "temporary proof target is not OCI");
  state.targetCreated = true;
  state.targetId = created.TargetID;
  cub(context, [
    "unit",
    "set-target",
    "--space",
    kubaraSpace,
    kubaraUnit,
    proofTarget,
    "--wait",
    "--quiet",
  ], { timeout: 180_000 });
  state.unitTargetSet = true;
  cub(context, [
    "space",
    "update",
    kubaraSpace,
    "--release-target",
    `${kubaraSpace}/${proofTarget}`,
    "--quiet",
  ], { timeout: 180_000 });
  state.spaceReleaseTargetSet = true;

  let beforeApprovalRecord;
  let approved;
  if (resumeApproved) {
    approved = getUnit(context);
    check(
      approved.ContentHash === before.ContentHash
        && approved.DataHash === before.DataHash
        && approved.HeadRevisionNum === before.HeadRevisionNum,
      "the approved Kubara Unit changed before the resumed run",
    );
    beforeApprovalRecord = {
      result: "blocked",
      dryRun: true,
      gate: approvalGate,
      contentHashUnchanged: true,
      observation:
        "Observed by guarded run 20260727043744 before approval; the failed dry-run did not create a durable UnitEvent.",
      durableServerEvent: false,
    };
  } else {
    const beforeApproval = cubTry(context, [
      "unit",
      "apply",
      "--space",
      kubaraSpace,
      kubaraUnit,
      "--dry-run",
      "--wait",
      "-o",
      "json",
    ], { timeout: 600_000 });
    check(
      !beforeApproval.ok,
      "Kubara dry-run apply unexpectedly passed before approval",
    );
    const afterBlocked = getUnit(context);
    check(
      afterBlocked.ContentHash === before.ContentHash
        && afterBlocked.DataHash === before.DataHash
        && afterBlocked.HeadRevisionNum === before.HeadRevisionNum,
      "the blocked Kubara dry run changed the Unit",
    );
    beforeApprovalRecord = {
      result: "blocked",
      dryRun: true,
      gate: approvalGate,
      contentHashUnchanged: true,
      observation: "Observed during this run.",
      durableServerEvent: false,
    };
    cub(context, [
      "unit",
      "approve",
      "--space",
      kubaraSpace,
      kubaraUnit,
      "--wait",
      "--quiet",
    ], { timeout: 180_000 });
    approved = getUnit(context);
  }
  check(
    approvalCount(approved.ApprovedBy) >= 1,
    "Kubara approval was not recorded",
  );
  check(
    approved.ContentHash === before.ContentHash,
    "Kubara content changed while it was being approved",
  );

  const afterApproval = cubTry(context, [
    "unit",
    "apply",
    "--space",
    kubaraSpace,
    kubaraUnit,
    "--dry-run",
    "--wait",
    "-o",
    "json",
  ], { timeout: 600_000 });
  check(
    afterApproval.ok,
    `Kubara dry-run apply was not allowed after approval: ${afterApproval.error}`,
  );
  const operation = JSON.parse(afterApproval.output);
  check(operation.DryRun === true, "ConfigHub did not return a dry-run operation");
  const privateRelease = publishRelease(context);

  return {
    organization: expectedOrg,
    space: kubaraSpace,
    unit: kubaraUnit,
    unitId: before.UnitID,
    revision: before.HeadRevisionNum,
    contentHash: before.ContentHash,
    dataHash: before.DataHash,
    policy: {
      profile: "catalog-standard",
      resourceClass: "system-configuration",
      approvalGate,
      gateStateAtRunStart: resumeApproved ? "satisfied" : "pending",
      temporaryTarget: `${kubaraSpace}/${proofTarget}`,
      temporaryReleaseTarget: `${kubaraSpace}/${proofTarget}`,
    },
    beforeApproval: beforeApprovalRecord,
    approval: {
      revision: before.HeadRevisionNum,
      recordedApprovals: approvalCount(approved.ApprovedBy),
      approverIdentityRecordedInReceipt: false,
      contentHashUnchanged: true,
      action: resumeApproved
        ? "already-recorded-before-resume"
        : "recorded-during-run",
    },
    afterApproval: {
      result: "allowed",
      dryRun: true,
    },
    approvedDataMatchesCommittedObjects: true,
    privateRelease,
    approvedText,
  };
}

function prepareDelivery(approvedDocs) {
  check(approvedDocs.length === 75, "expected 75 approved Kubara objects");
  const approvedByIdentity = new Map(
    approvedDocs.map((doc) => [identity(doc), doc]),
  );
  for (const hookIdentity of expectedHookIdentities) {
    check(
      approvedByIdentity.has(hookIdentity),
      `approved Kubara data is missing ${hookIdentity}`,
    );
  }
  check(
    approvedByIdentity.has(deferredIdentity),
    "approved Kubara data is missing the deferred ClusterExternalSecret",
  );
  check(
    approvedByIdentity.has(grpcIngressIdentity),
    "approved Kubara data is missing the deferred Argo CD Ingress",
  );

  const excluded = new Set([
    ...expectedHookIdentities,
    deferredIdentity,
    grpcIngressIdentity,
  ]);
  const deliveryDocs = approvedDocs
    .filter((doc) => !excluded.has(identity(doc)))
    .map((doc) => structuredClone(doc));
  check(deliveryDocs.length === 69, "expected 69 Kubara delivery objects");

  const project = deliveryDocs.find(
    (doc) => identity(doc) === projectIdentity,
  );
  check(project, "Kubara AppProject is missing");
  project.spec.sourceRepos = ["https://github.com/confighub/helm-expt.git"];

  const metricsAppSet = deliveryDocs.find(
    (doc) => identity(doc) === metricsAppSetIdentity,
  );
  check(metricsAppSet, "Kubara Metrics Server ApplicationSet is missing");
  const metricsSource = metricsAppSet.spec?.template?.spec?.sources?.find(
    (source) => source.path?.endsWith("/metrics-server"),
  );
  check(metricsSource?.helm, "Kubara Metrics Server Helm source is missing");
  metricsSource.helm.values = `metrics-server:
  args:
    - --kubelet-insecure-tls
`;

  const dexDeployment = deliveryDocs.find(
    (doc) => identity(doc) === dexDeploymentIdentity,
  );
  check(dexDeployment, "Kubara Dex Deployment is missing");
  dexDeployment.spec.replicas = 0;

  let unchangedObjectCount = 0;
  const changedIdentities = new Set([
    projectIdentity,
    metricsAppSetIdentity,
    dexDeploymentIdentity,
  ]);
  for (const doc of deliveryDocs) {
    if (changedIdentities.has(identity(doc))) continue;
    check(
      JSON.stringify(canonicalValue(doc))
        === JSON.stringify(canonicalValue(approvedByIdentity.get(identity(doc)))),
      `unexpected Kubara delivery change: ${identity(doc)}`,
    );
    unchangedObjectCount += 1;
  }
  check(unchangedObjectCount === 66, "Kubara unchanged object count changed");
  return {
    deliveryDocs,
    unchangedObjectCount,
    changedObjects: [
      {
        identity: projectIdentity,
        path: "spec.sourceRepos",
        reason:
          "Allow the public helm-expt repository used by the generated ApplicationSets.",
      },
      {
        identity: metricsAppSetIdentity,
        path: "spec.template.spec.sources[1].helm.values",
        reason:
          "Use --kubelet-insecure-tls only for the throwaway kind target.",
      },
      {
        identity: dexDeploymentIdentity,
        path: "spec.replicas",
        reason:
          "Do not run Dex on the throwaway target because this Kubara configuration does not provide a Dex login configuration.",
      },
    ],
  };
}

function executeRoutes({
  kubeContext,
  workRoot,
  approvedDocs,
  sourceDocs,
}) {
  const approvedByIdentity = new Map(
    approvedDocs.map((doc) => [identity(doc), doc]),
  );
  const prerequisiteDocs = [
    approvedByIdentity.get(namespaceIdentity),
    ...expectedCrds.map((name) =>
      approvedDocs.find(
        (doc) =>
          doc.kind === "CustomResourceDefinition"
          && doc.metadata?.name === name,
      )),
  ];
  check(
    prerequisiteDocs.every(Boolean),
    "Kubara namespace or CRD route object is missing",
  );
  const prerequisitesPath = join(workRoot, "kubara-prerequisites.yaml");
  writeFileSync(prerequisitesPath, yamlDocuments(prerequisiteDocs));
  kube(kubeContext, [
    "apply",
    "--server-side",
    "--force-conflicts",
    "-f",
    prerequisitesPath,
  ], { timeout: 300_000 });
  for (const crd of expectedCrds) {
    kube(kubeContext, [
      "wait",
      "--for=condition=Established",
      `crd/${crd}`,
      "--timeout=180s",
    ], { timeout: 240_000 });
  }

  const argocdSecret = sourceDocs.find(
    (doc) =>
      doc.kind === "Secret"
      && doc.metadata?.namespace === kubaraNamespace
      && doc.metadata?.name === "argocd-secret",
  );
  const clusterSecret = structuredClone(sourceDocs.find(
    (doc) =>
      doc.kind === "Secret"
      && doc.metadata?.namespace === kubaraNamespace
      && doc.metadata?.name === "cluster-kubernetes.default.svc",
  ));
  check(argocdSecret && clusterSecret, "Kubara target Secrets are missing");
  for (const label of serviceLabels) {
    clusterSecret.metadata.labels[label] =
      label === "metrics-server" ? "enabled" : "disabled";
  }
  const secretsPath = join(workRoot, "kubara-target-secrets.yaml");
  writeFileSync(
    secretsPath,
    yamlDocuments([argocdSecret, clusterSecret]),
    { mode: 0o600 },
  );
  kube(kubeContext, ["apply", "-f", secretsPath]);

  const hookDocs = expectedHookIdentities.map((hookIdentity) =>
    approvedByIdentity.get(hookIdentity));
  check(hookDocs.every(Boolean), "Kubara hook route object is missing");
  kubeTry(kubeContext, [
    "-n",
    kubaraNamespace,
    "delete",
    "job",
    "kubara-platform-argocd-redis-secret-init",
    "--ignore-not-found",
    "--wait=true",
  ], { timeout: 120_000 });
  const hooksPath = join(workRoot, "kubara-redis-hook.yaml");
  writeFileSync(hooksPath, yamlDocuments(hookDocs));
  kube(kubeContext, ["apply", "-f", hooksPath]);
  kube(kubeContext, [
    "-n",
    kubaraNamespace,
    "wait",
    "--for=condition=Complete",
    "job/kubara-platform-argocd-redis-secret-init",
    "--timeout=300s",
  ], { timeout: 360_000 });
  const redisSecret = JSON.parse(kube(kubeContext, [
    "-n",
    kubaraNamespace,
    "get",
    "secret",
    "argocd-redis",
    "-o",
    "json",
  ]).output);
  check(
    Object.keys(redisSecret.data ?? {}).includes("auth")
      && String(redisSecret.data.auth).length > 0,
    "Kubara Redis initializer did not create the auth key",
  );

  return {
    crdsFirst: {
      result: "pass",
      namespace: kubaraNamespace,
      crds: expectedCrds,
      established: expectedCrds.length,
    },
    targetSecrets: {
      result: "pass",
      names: [
        "argocd/argocd-secret",
        "argocd/cluster-kubernetes.default.svc",
      ],
      secretDataRecorded: false,
      selectedServices: ["metrics-server"],
      disabledServices: serviceLabels.filter(
        (label) => label !== "metrics-server",
      ),
    },
    redisInitializer: {
      result: "pass",
      objects: expectedHookIdentities,
      job: "argocd/kubara-platform-argocd-redis-secret-init",
      generatedSecret: "argocd/argocd-redis",
      generatedDataKeys: ["auth"],
      secretDataRecorded: false,
    },
    externalSecrets: {
      result: "deferred",
      object: deferredIdentity,
      reason:
        "External Secrets, its ClusterSecretStore, and the remote key are outside this small live lane.",
    },
    ingress: {
      result: "deferred",
      object: grpcIngressIdentity,
      reason:
        "The throwaway kind target has no ingress controller.",
    },
  };
}

function installBootstrapArgo({ kubeContext, workRoot }) {
  const bootstrapRoot = join(workRoot, "bootstrap-argocd");
  mkdirSync(bootstrapRoot, { recursive: true });
  const sourcePath = join(bootstrapRoot, "install.yaml");
  command("curl", ["-fsSL", bootstrapArgoManifestUrl, "-o", sourcePath], {
    timeout: 180_000,
  });
  const sourceText = readFileSync(sourcePath, "utf8");
  check(
    sha256(sourceText) === bootstrapArgoManifestSha256,
    "bootstrap Argo CD manifest checksum changed",
  );
  writeFileSync(
    join(bootstrapRoot, "kustomization.yaml"),
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${bootstrapNamespace}
resources:
  - install.yaml
`,
  );
  const transformed = command("kubectl", [
    "kustomize",
    bootstrapRoot,
  ], { timeout: 180_000 }).output;
  const transformedPath = join(bootstrapRoot, "transformed.yaml");
  writeFileSync(transformedPath, transformed);
  kube(kubeContext, ["create", "namespace", bootstrapNamespace]);
  kube(kubeContext, [
    "apply",
    "--server-side",
    "--force-conflicts",
    "-f",
    transformedPath,
  ], { timeout: 360_000 });
  const clusterRoleBindings = [
    "argocd-application-controller",
    "argocd-applicationset-controller",
    "argocd-server",
  ];
  for (const name of clusterRoleBindings) {
    kube(kubeContext, [
      "patch",
      "clusterrolebinding",
      name,
      "--type=json",
      "-p",
      JSON.stringify([
        {
          op: "replace",
          path: "/subjects/0/namespace",
          value: bootstrapNamespace,
        },
      ]),
    ]);
  }
  kube(kubeContext, [
    "-n",
    bootstrapNamespace,
    "rollout",
    "restart",
    "statefulset/argocd-application-controller",
  ]);
  const deployments = listNames(
    kube(kubeContext, [
      "-n",
      bootstrapNamespace,
      "get",
      "deployment",
      "-o",
      "json",
    ]).output,
  );
  const statefulSets = listNames(
    kube(kubeContext, [
      "-n",
      bootstrapNamespace,
      "get",
      "statefulset",
      "-o",
      "json",
    ]).output,
  );
  check(deployments.length > 0, "bootstrap Argo CD has no Deployments");
  check(statefulSets.length > 0, "bootstrap Argo CD has no StatefulSets");
  for (const name of deployments) {
    kube(kubeContext, [
      "-n",
      bootstrapNamespace,
      "rollout",
      "status",
      `deployment/${name}`,
      "--timeout=600s",
    ], { timeout: 660_000 });
  }
  for (const name of statefulSets) {
    kube(kubeContext, [
      "-n",
      bootstrapNamespace,
      "rollout",
      "status",
      `statefulset/${name}`,
      "--timeout=600s",
    ], { timeout: 660_000 });
  }
  return {
    version: bootstrapArgoVersion,
    source: bootstrapArgoManifestUrl,
    sourceSha256: bootstrapArgoManifestSha256,
    namespace: bootstrapNamespace,
    transformedObjectCount: parseDocs(transformed).length,
    clusterRoleBindings,
    deployments,
    statefulSets,
    result: "pass",
  };
}

function waitForKubaraPlatform({ kubeContext, attempts }) {
  for (const name of expectedKubaraDeployments) {
    kube(kubeContext, [
      "-n",
      kubaraNamespace,
      "rollout",
      "status",
      `deployment/${name}`,
      "--timeout=600s",
    ], { timeout: 660_000 });
  }
  for (const name of expectedKubaraStatefulSets) {
    kube(kubeContext, [
      "-n",
      kubaraNamespace,
      "rollout",
      "status",
      `statefulset/${name}`,
      "--timeout=600s",
    ], { timeout: 660_000 });
  }

  let applications = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = kubeTry(kubeContext, [
      "-n",
      kubaraNamespace,
      "get",
      "applications.argoproj.io",
      "-o",
      "json",
    ]);
    if (result.ok) {
      applications = JSON.parse(result.output).items ?? [];
      if (applications.some(
        (application) =>
          application.metadata?.name === "test-cluster-metrics-server",
      )) break;
    }
    sleep(4000);
  }
  const selectedNames = applications
    .map((application) => application.metadata?.name)
    .filter(Boolean)
    .sort();
  check(
    selectedNames.includes("test-cluster-metrics-server"),
    `Kubara did not create the selected Metrics Server application: ${selectedNames.join(", ") || "none"}`,
  );
  check(
    selectedNames.length === 1,
    `the small Kubara lane created unexpected applications: ${selectedNames.join(", ")}`,
  );

  const selectedApplication = waitForApplication({
    kubeContext,
    namespace: kubaraNamespace,
    name: "test-cluster-metrics-server",
    attempts: 150,
  });
  check(
    selectedApplication.result === "pass",
    `Kubara Metrics Server application did not converge: ${selectedApplication.reason}`,
  );
  const deployments = waitForNamespaceDeployments({
    kubeContext,
    namespace: "metrics-server",
    attempts: 120,
  });
  return {
    result: "pass",
    argoCore: {
      namespace: kubaraNamespace,
      deployments: expectedKubaraDeployments,
      statefulSets: expectedKubaraStatefulSets,
      ready: true,
    },
    selectedApplications: selectedNames,
    selectedApplication: {
      name: "test-cluster-metrics-server",
      sync: selectedApplication.sync,
      health: selectedApplication.health,
      revision: selectedApplication.revision,
    },
    workload: {
      namespace: "metrics-server",
      deployments,
      ready: true,
    },
  };
}

function waitForNamespaceDeployments({
  kubeContext,
  namespace,
  attempts,
}) {
  let items = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = kubeTry(kubeContext, [
      "-n",
      namespace,
      "get",
      "deployment",
      "-o",
      "json",
    ]);
    if (result.ok) {
      items = JSON.parse(result.output).items ?? [];
      if (
        items.length > 0
        && items.every((item) =>
          Number(item.status?.availableReplicas ?? 0)
          === Number(item.spec?.replicas ?? 1))
      ) {
        return items.map((item) => ({
          name: item.metadata.name,
          desired: Number(item.spec?.replicas ?? 1),
          available: Number(item.status?.availableReplicas ?? 0),
          observedGenerationMatches:
            item.status?.observedGeneration === item.metadata?.generation,
        }));
      }
    }
    sleep(5000);
  }
  throw new Error(
    `${namespace} Deployments did not become available: ${items.map(
      (item) =>
        `${item.metadata?.name}=${item.status?.availableReplicas ?? 0}/${item.spec?.replicas ?? 1}`,
    ).join(", ") || "none"}`,
  );
}

function configureAnonymousOci({
  kubeContext,
  registryHost,
  workRoot,
}) {
  const path = join(workRoot, "bootstrap-oci-repository.yaml");
  writeFileSync(path, `apiVersion: v1
kind: Secret
metadata:
  name: helm-expt-anonymous-oci
  namespace: ${bootstrapNamespace}
  labels:
    argocd.argoproj.io/secret-type: repo-creds
type: Opaque
stringData:
  url: oci://${registryHost}
  type: oci
  enableOCI: "true"
  insecureOCIForceHttp: "true"
`, { mode: 0o600 });
  kube(kubeContext, ["apply", "-f", path]);
}

function createApplication({
  kubeContext,
  applicationName,
  sourceReference,
  workRoot,
}) {
  const path = join(workRoot, "kubara-bootstrap-application.yaml");
  writeFileSync(path, `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${applicationName}
  namespace: ${bootstrapNamespace}
spec:
  project: default
  source:
    repoURL: ${sourceReference}
    targetRevision: latest
    path: .
  destination:
    server: https://kubernetes.default.svc
    namespace: ${kubaraNamespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ServerSideApply=true
      - SkipDryRunOnMissingResource=true
`, { mode: 0o600 });
  kube(kubeContext, ["apply", "-f", path]);
  kube(kubeContext, [
    "-n",
    bootstrapNamespace,
    "annotate",
    "application",
    applicationName,
    "argocd.argoproj.io/refresh=hard",
    "--overwrite",
  ]);
}

function waitForApplication({
  kubeContext,
  namespace,
  name,
  expectedRevision = "",
  attempts,
}) {
  kubeTry(kubeContext, [
    "-n",
    namespace,
    "annotate",
    "application",
    name,
    "argocd.argoproj.io/refresh=hard",
    "--overwrite",
  ]);
  let last = {
    sync: "",
    health: "",
    revision: "",
    message: "",
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = kubeTry(kubeContext, [
      "-n",
      namespace,
      "get",
      "application",
      name,
      "-o",
      "json",
    ]);
    if (result.ok) {
      const application = JSON.parse(result.output);
      last = {
        sync: String(application.status?.sync?.status ?? ""),
        health: String(application.status?.health?.status ?? ""),
        revision: normalizeDigest(application.status?.sync?.revision)
          || String(application.status?.sync?.revision ?? ""),
        message: String(
          (application.status?.conditions ?? [])
            .map((condition) => condition.message)
            .filter(Boolean)
            .join("; "),
        ),
      };
      if (
        last.sync === "Synced"
        && last.health === "Healthy"
        && (!expectedRevision || last.revision === expectedRevision)
      ) {
        return {
          result: "pass",
          sync: last.sync,
          health: last.health,
          revision: last.revision,
          expectedRevision: expectedRevision || undefined,
          digestMatchesPortableOci: expectedRevision
            ? last.revision === expectedRevision
            : undefined,
        };
      }
      if (attempt > 10 && /permission denied|not permitted/i.test(last.message)) {
        break;
      }
    }
    sleep(5000);
  }
  return {
    result: "blocked",
    reason: sanitizeError(
      `sync=${last.sync || "missing"}; health=${last.health || "missing"}; revision=${last.revision || "missing"}; expected=${expectedRevision || "any"}; message=${last.message || "none"}`,
    ),
  };
}

function publishPortableOci({
  workRoot,
  documents,
  registryHost,
  clusterRegistryHost,
}) {
  const outputRoot = join(workRoot, "portable-output");
  const pullRoot = join(workRoot, "portable-output-pulled");
  const outputFile = join(outputRoot, "release-objects.yaml");
  const bundleFile = join(outputRoot, "bundle.tar.gz");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(outputFile, yamlDocuments(documents));
  command("tar", [
    "-czf",
    bundleFile,
    "release-objects.yaml",
  ], { cwd: outputRoot });
  const repository = "kubara-local-platform";
  const localReference = `${registryHost}/${repository}:latest`;
  command("oras", [
    "push",
    "--plain-http",
    "--artifact-type",
    artifactType,
    "--format",
    "json",
    localReference,
    `bundle.tar.gz:${deployableLayerType}`,
  ], { cwd: outputRoot, timeout: 180_000 });
  const descriptor = JSON.parse(command("oras", [
    "manifest",
    "fetch",
    "--plain-http",
    "--descriptor",
    localReference,
  ]).output);
  const manifestDigest = normalizeDigest(descriptor.digest);
  check(manifestDigest, "portable Kubara OCI has no manifest digest");
  command("oras", [
    "pull",
    "--plain-http",
    "--output",
    pullRoot,
    `${registryHost}/${repository}@${manifestDigest}`,
  ], { timeout: 180_000 });
  const pulledBundle = join(pullRoot, "bundle.tar.gz");
  check(existsSync(pulledBundle), "pulled Kubara OCI is missing bundle.tar.gz");
  command("tar", ["-xzf", pulledBundle, "-C", pullRoot]);
  const pulledFile = join(pullRoot, "release-objects.yaml");
  check(existsSync(pulledFile), "pulled Kubara OCI is missing its YAML");
  const pulledText = readFileSync(pulledFile, "utf8");
  check(
    canonicalDocs(parseDocs(pulledText)) === canonicalDocs(documents),
    "pulled Kubara OCI differs from the prepared objects",
  );
  return {
    reference: `oci://${localReference}`,
    clusterReference: `oci://${clusterRegistryHost}/${repository}`,
    manifestDigest,
    objectCount: documents.length,
    preparedDataSha256: sha256(canonicalDocs(documents)),
    pulledDataSha256: sha256(canonicalDocs(parseDocs(pulledText))),
    objectsMatchPreparedData: true,
    anonymousPull: true,
    registryLifetime: "temporary",
  };
}

function startRegistry(name) {
  const started = tryCommand("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    "127.0.0.1::5000",
    "registry:2",
  ], { timeout: 120_000 });
  check(
    started.ok,
    `could not start the temporary OCI registry: ${started.error}`,
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = tryCommand("docker", ["port", name, "5000/tcp"]);
    const match = port.output.match(/127\.0\.0\.1:(\d+)/);
    if (match) {
      const host = `127.0.0.1:${match[1]}`;
      if (tryCommand("curl", ["-fsS", `http://${host}/v2/`]).ok) {
        return {
          host,
          clusterHost: `host.docker.internal:${match[1]}`,
        };
      }
    }
    sleep(1000);
  }
  throw new Error("temporary Kubara OCI registry did not publish a host port");
}

function publishRelease(context) {
  const published = cubTry(
    context,
    ["release", "publish", kubaraSpace, "-o", "json"],
    { timeout: 300_000 },
  );
  let release;
  let action;
  if (published.ok) {
    const response = JSON.parse(published.output);
    release = response.Release ?? response.release ?? response;
    action = "published";
  } else {
    check(
      /no changes were made since :latest bundle/i.test(published.error),
      `Kubara release publish failed: ${published.error}`,
    );
    const releases = cubJson(context, [
      "release",
      "list",
      "--space",
      kubaraSpace,
      "-o",
      "json",
    ])
      .map((item) => item.Release ?? item.release ?? item)
      .filter((item) => item.Published === true)
      .sort((left, right) =>
        String(right.CreatedAt ?? "").localeCompare(
          String(left.CreatedAt ?? ""),
        ));
    check(releases.length > 0, "Kubara has no published release to reuse");
    release = releases[0];
    action = "reused-existing-latest";
  }
  const manifestDigest = normalizeDigest(
    release.ManifestDigest ?? release.manifestDigest,
  );
  check(manifestDigest, "Kubara release publish returned no manifest digest");
  return {
    reference: `oci://${configHubOciHost}/space/${kubaraSpace}:latest`,
    manifestDigest,
    bundleDigest: normalizeDigest(release.Digest ?? release.digest),
    releaseId: String(release.ReleaseID ?? release.releaseId ?? ""),
    action,
    usedForPortableDelivery: false,
  };
}

function getUnit(context) {
  return cubJson(context, [
    "unit",
    "get",
    "--space",
    kubaraSpace,
    kubaraUnit,
    "--quiet",
    "-o",
    "json",
  ]).Unit;
}

function cleanupUnitTarget({ context, state, proofTarget }) {
  if (!state.unitTargetSet) return "not-needed";
  try {
    const unit = getUnit(context);
    if (unit.TargetID && unit.TargetID !== state.targetId) {
      return "blocked-other-target";
    }
    if (unit.TargetID === state.targetId) {
      cub(context, [
        "unit",
        "set-target",
        "--space",
        kubaraSpace,
        kubaraUnit,
        "-",
        "--wait",
        "--quiet",
      ], { timeout: 180_000 });
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const after = getUnit(context);
      if (!after.TargetID) {
        state.unitTargetSet = false;
        return "pass";
      }
      sleep(1000);
    }
    return "failed";
  } catch {
    return "failed";
  }
}

function cleanupTarget({ context, state, proofTarget }) {
  if (!state.targetCreated) return "not-needed";
  const result = cubTry(context, [
    "target",
    "delete",
    "--space",
    kubaraSpace,
    proofTarget,
    "--quiet",
  ], { timeout: 180_000 });
  if (!result.ok) return "failed";
  state.targetCreated = false;
  return cubTry(context, [
    "target",
    "get",
    "--space",
    kubaraSpace,
    proofTarget,
    "--quiet",
    "-o",
    "json",
  ]).ok ? "failed" : "pass";
}

function cleanupSpaceReleaseTarget({ context, state }) {
  if (!state.spaceReleaseTargetSet) return "not-needed";
  try {
    const before = cubJson(context, [
      "space",
      "get",
      kubaraSpace,
      "-o",
      "json",
    ]).Space;
    if (
      before.ReleaseTargetID
      && before.ReleaseTargetID !== state.targetId
    ) {
      return "blocked-other-target";
    }
    if (before.ReleaseTargetID === state.targetId) {
      cub(context, [
        "space",
        "update",
        kubaraSpace,
        "--release-target",
        "-",
        "--quiet",
      ], { timeout: 180_000 });
    }
    const after = cubJson(context, [
      "space",
      "get",
      kubaraSpace,
      "-o",
      "json",
    ]).Space;
    state.spaceReleaseTargetSet = false;
    return after.ReleaseTargetID ? "failed" : "pass";
  } catch {
    return "failed";
  }
}

function cleanupCluster(name, state) {
  if (!state.clusterCreated && !clusterPresent(name)) return "not-needed";
  const result = tryCommand("kind", ["delete", "cluster", "--name", name], {
    timeout: 300_000,
  });
  if (!result.ok && clusterPresent(name)) return "failed";
  state.clusterCreated = false;
  return clusterPresent(name) ? "failed" : "pass";
}

function cleanupRegistry(name, state) {
  if (!state.registryStarted && !dockerContainerPresent(name)) {
    return "not-needed";
  }
  const result = tryCommand("docker", ["rm", "-f", name], {
    timeout: 120_000,
  });
  if (!result.ok && dockerContainerPresent(name)) return "failed";
  state.registryStarted = false;
  return dockerContainerPresent(name) ? "failed" : "pass";
}

function cleanupLocalFiles(workRoot) {
  try {
    rmSync(workRoot, { recursive: true, force: true });
    return existsSync(workRoot) ? "failed" : "pass";
  } catch {
    return "failed";
  }
}

function validateSource(sourceDocs) {
  check(sourceDocs.length === 77, "expected 77 Kubara rendered objects");
  check(
    sourceDocs.filter((doc) => doc.kind === "Secret").length === 2,
    "expected two Kubara rendered Secrets",
  );
  check(
    sourceDocs.filter((doc) => doc.kind === "CustomResourceDefinition").length
      === 3,
    "expected three Kubara CRDs",
  );
  const hooks = sourceDocs.filter(
    (doc) => doc.metadata?.annotations?.["helm.sh/hook"],
  );
  check(hooks.length === 4, "expected four Kubara Helm hook objects");
  check(
    canonicalDocs(hooks)
      === canonicalDocs(
        expectedHookIdentities.map((hookIdentity) =>
          sourceDocs.find((doc) => identity(doc) === hookIdentity)),
      ),
    "Kubara hook identities changed",
  );
}

function verifyReceipt(receipt) {
  check(
    receipt.kind === "KubaraOciDeliveryProofReceipt",
    "Kubara OCI receipt kind changed",
  );
  check(receipt.status?.result === "pass", "Kubara OCI proof is not pass");
  check(
    receipt.spec?.flow?.portableShape === "work -> OCI"
      && receipt.spec.flow.access?.configHubReview
      === "ConfigHub account and server required"
      && receipt.spec.flow.access?.routeWork
      === "local target-side commands; no ConfigHub Server required"
      && receipt.spec.flow.access?.portablePull
      === "anonymous; no ConfigHub account required",
    "Kubara access record changed",
  );
  const sourceText = readFileSync(renderedPath, "utf8");
  const sourceDocs = parseDocs(sourceText);
  validateSource(sourceDocs);
  const nonSecretDocs = sourceDocs.filter((doc) => doc.kind !== "Secret");
  check(
    receipt.spec?.source?.rawObjectCount === 77
      && receipt.spec.source.nonSecretObjectCount === 75
      && receipt.spec.source.rawSha256 === sha256(sourceText)
      && receipt.spec.source.canonicalNonSecretSha256
      === sha256(canonicalDocs(nonSecretDocs)),
    "Kubara source record changed",
  );
  const review = receipt.spec?.configHubReview;
  check(
    review?.organization === expectedOrg
      && review.space === kubaraSpace
      && review.unit === kubaraUnit
      && review.policy?.profile === "catalog-standard"
      && review.policy?.resourceClass === "system-configuration"
      && review.policy?.approvalGate === approvalGate
      && review.policy?.gateStateAtRunStart === "satisfied"
      && review.beforeApproval?.result === "blocked"
      && review.beforeApproval.durableServerEvent === false
      && review.afterApproval?.result === "allowed"
      && review.approval?.recordedApprovals >= 1
      && review.approval.approverIdentityRecordedInReceipt === false
      && review.approval.contentHashUnchanged === true
      && review.approvedDataMatchesCommittedObjects === true,
    "Kubara ConfigHub review record changed",
  );
  check(
    normalizeDigest(review.privateRelease?.manifestDigest)
      === review.privateRelease.manifestDigest
      && review.privateRelease.usedForPortableDelivery === false,
    "Kubara private release record changed",
  );
  const preparation = receipt.spec?.preparation;
  check(
    preparation?.approvedObjectCount === 75
      && preparation.outputObjectCount === 69
      && preparation.unchangedObjectCount === 66
      && sameSet(
        preparation.executedBeforeDelivery ?? [],
        expectedHookIdentities,
      )
      && sameSet(
        (preparation.deferredObjects ?? []).map((item) => item.identity),
        [deferredIdentity, grpcIngressIdentity],
      )
      && sameSet(
        (preparation.changedObjects ?? []).map((item) => item.identity),
        [projectIdentity, metricsAppSetIdentity, dexDeploymentIdentity],
      ),
    "Kubara delivery preparation record changed",
  );
  const routes = receipt.spec?.routes;
  check(
    routes?.crdsFirst?.result === "pass"
      && routes.crdsFirst.established === 3
      && routes.targetSecrets?.result === "pass"
      && sameSet(routes.targetSecrets.selectedServices ?? [], ["metrics-server"])
      && routes.targetSecrets.secretDataRecorded === false
      && routes.redisInitializer?.result === "pass"
      && routes.redisInitializer.generatedDataKeys?.join(",") === "auth"
      && routes.redisInitializer.secretDataRecorded === false
      && routes.externalSecrets?.result === "deferred"
      && routes.ingress?.result === "deferred",
    "Kubara route execution record changed",
  );
  const portable = receipt.spec?.portableRelease;
  check(
    portable?.objectCount === 69
      && portable.objectsMatchPreparedData === true
      && portable.anonymousPull === true
      && portable.registryLifetime === "temporary"
      && portable.preparedDataSha256 === portable.pulledDataSha256
      && normalizeDigest(portable.manifestDigest) === portable.manifestDigest,
    "Kubara portable OCI record changed",
  );
  const cluster = receipt.spec?.cluster;
  check(
    cluster?.creationCommand === "kind create cluster"
      && cluster.bootstrapArgo?.version === bootstrapArgoVersion
      && cluster.bootstrapArgo.sourceSha256
      === bootstrapArgoManifestSha256
      && cluster.bootstrapArgo.result === "pass"
      && cluster.bootstrapApplication?.result === "pass"
      && cluster.bootstrapApplication.sync === "Synced"
      && cluster.bootstrapApplication.health === "Healthy"
      && cluster.bootstrapApplication.revision === portable.manifestDigest
      && cluster.kubara?.result === "pass"
      && cluster.kubara.argoCore?.ready === true
      && cluster.kubara.selectedApplications?.join(",")
      === "test-cluster-metrics-server"
      && cluster.kubara.selectedApplication?.sync === "Synced"
      && cluster.kubara.selectedApplication?.health === "Healthy"
      && cluster.kubara.workload?.ready === true
      && cluster.kubara.workload.deployments?.length > 0
      && cluster.kubara.workload.deployments.every(
        (deployment) =>
          deployment.desired === deployment.available
          && deployment.observedGenerationMatches === true,
      ),
    "Kubara live delivery record changed",
  );
  check(
    Object.values(receipt.spec?.cleanup ?? {}).every(
      (value) => value === "pass" || value === "not-needed",
    ),
    "Kubara cleanup did not pass",
  );
  const serialized = JSON.stringify(receipt);
  check(
    !serialized.includes("@confighub.com"),
    "Kubara receipt contains a user identity",
  );
  check(!serialized.includes("ch_"), "Kubara receipt contains a credential");
  check(
    !serialized.includes("docker-password")
      && !serialized.includes("bearerToken"),
    "Kubara receipt contains target credentials",
  );
}

function renderSummary(receipt) {
  const review = receipt.spec.configHubReview;
  const routes = receipt.spec.routes;
  const portable = receipt.spec.portableRelease;
  const cluster = receipt.spec.cluster;
  const kubara = cluster.kubara;
  return `# Kubara configuration delivered through OCI

Kubara generated the Argo CD bootstrap and cluster settings for a Kubernetes
platform. ConfigHub stored the 75 non-Secret objects as one system-configuration
base. A dry-run apply was blocked until that exact revision was approved.
The failed dry-run did not create a durable ConfigHub UnitEvent, so this receipt
names the guarded run that observed it rather than claiming a server audit event.

The live test then handled the work that a flat YAML bundle cannot do by itself.
It installed the Argo CD CRDs first, created the two target-owned Secrets without
recording their data, and ran the Redis initializer Job before Argo CD started.

The test deliberately selected one downstream service, Metrics Server. It deferred
the ClusterExternalSecret because External Secrets, its ClusterSecretStore, and the
remote key were outside this small lane. It also deferred the Argo CD gRPC Ingress
because the throwaway cluster had no ingress controller.

After that route work, ${receipt.spec.preparation.outputObjectCount} prepared
objects were packaged as a temporary portable OCI. Pulling the package required no
ConfigHub account. Bootstrap Argo CD reconciled the exact OCI digest, the Kubara
Argo CD installation became ready, and Kubara created one Metrics Server
Application. That Application became Synced and Healthy.

| Check | Result |
| --- | --- |
| ConfigHub apply before approval | ${review.beforeApproval.result} |
| ConfigHub apply after approval | ${review.afterApproval.result} |
| ConfigHub private release | \`${review.privateRelease.manifestDigest}\` |
| Argo CD CRDs established | ${routes.crdsFirst.established}/3 |
| Redis initializer | ${routes.redisInitializer.result} |
| External Secrets object | ${routes.externalSecrets.result} |
| Argo CD gRPC Ingress | ${routes.ingress.result} |
| Portable OCI pull-back | ${portable.objectsMatchPreparedData ? "Pass" : "Fail"} |
| Bootstrap Argo CD | ${cluster.bootstrapApplication.sync} and ${cluster.bootstrapApplication.health} |
| Kubara Argo CD | ${kubara.argoCore.ready ? "Ready" : "Not ready"} |
| Selected platform Application | \`${kubara.selectedApplication.name}\`: ${kubara.selectedApplication.sync} and ${kubara.selectedApplication.health} |
| Metrics Server Deployments | ${kubara.workload.deployments.length} ready |
| Cleanup | ${Object.values(receipt.spec.cleanup).every((value) => value === "pass" || value === "not-needed") ? "Pass" : "Fail"} |

## What changed for the throwaway target

The approved base remains unchanged in ConfigHub. The portable output adds the
public helm-expt repository to the Kubara AppProject and adds
\`--kubelet-insecure-tls\` to the Metrics Server ApplicationSet for kind. It also
scales Dex to zero because this Kubara configuration does not provide a Dex login
configuration. Four hook resources were executed before delivery, and the
unresolved ClusterExternalSecret and Ingress were deferred rather than applied
without their prerequisites.

## Limits

This run used one kind cluster, one selected platform service, and a temporary OCI
registry. It does not prove the full seven-service local-evaluation profile or a
multi-cluster promotion wave. The kind-specific Metrics Server setting is not a
production recommendation.

- [Kubara example](../../examples/kubara/local-platform/README.md)
- [Route intent](../../examples/kubara/local-platform/route-intent.yaml)
- [Committed receipt](../../runs/kubara-oci-delivery-proof/receipt.yaml)
`;
}

function yamlDocuments(documents) {
  return `${documents.map((document) => toYaml(document).trimEnd()).join("\n---\n")}\n`;
}

function canonicalDocs(documents) {
  return JSON.stringify(
    documents
      .filter(Boolean)
      .map((document) => ({
        identity: identity(document),
        document: canonicalValue(document),
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  );
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) =>
        !key.startsWith("$comment$")
        && key !== "status"
        && key !== "managedFields"
        && key !== "creationTimestamp"
        && key !== "generation"
        && key !== "resourceVersion"
        && key !== "uid")
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function identity(document) {
  return [
    document.apiVersion ?? "",
    document.kind ?? "",
    document.metadata?.namespace ?? "",
    document.metadata?.name ?? "",
  ].join("|");
}

function listNames(json) {
  return (JSON.parse(json).items ?? [])
    .map((item) => item.metadata?.name)
    .filter(Boolean)
    .sort();
}

function storedData(unit) {
  check(unit.Data, `${unit.SpaceSlug}/${unit.Slug} has no stored data`);
  return Buffer.from(unit.Data, "base64").toString("utf8");
}

function approvalCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value ? 1 : 0;
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function normalizeDigest(value) {
  const match = String(value ?? "").match(/sha256:[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : "";
}

function clusterPresent(name) {
  const result = tryCommand("kind", ["get", "clusters"]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function dockerContainerPresent(name) {
  const result = tryCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.ok && result.output.split(/\r?\n/).includes(name);
}

function kube(context, args, options = {}) {
  return command("kubectl", ["--context", context, ...args], options);
}

function kubeTry(context, args, options = {}) {
  return tryCommand("kubectl", ["--context", context, ...args], options);
}

function cub(context, args, options = {}) {
  return command("cub", args, {
    ...options,
    env: {
      ...process.env,
      CONFIGHUB_AGENT: "1",
      CUB_CONTEXT: context,
    },
  }).output;
}

function cubTry(context, args, options = {}) {
  return tryCommand("cub", args, {
    ...options,
    env: {
      ...process.env,
      CONFIGHUB_AGENT: "1",
      CUB_CONTEXT: context,
    },
  });
}

function cubJson(context, args, options = {}) {
  return JSON.parse(cub(context, args, options));
}

function command(file, args, options = {}) {
  const result = tryCommand(file, args, options);
  if (!result.ok) {
    throw new Error(
      `${file} ${args.slice(0, 7).join(" ")} failed: ${result.error}`,
    );
  }
  return result;
}

function tryCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 1024 * 1024 * 100,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    output: result.stdout ?? "",
    error: sanitizeError(
      result.error?.message
      ?? result.stderr
      ?? result.stdout
      ?? `exit ${result.status}`,
    ),
  };
}

function sanitizeError(value) {
  return String(value ?? "")
    .replace(/(?i:password|token|secret)\s*[:=]\s*\S+/g, "$1=<redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted-long-value>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1600);
}

function safeRunId(value) {
  const compact = String(value).replace(/\D/g, "").slice(0, 14);
  check(
    compact.length >= 8,
    "HELM_EXPT_PROOF_RUN_ID must contain at least eight digits",
  );
  return compact;
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function phase(message) {
  console.log(`[kubara-oci-delivery] ${message}`);
}
