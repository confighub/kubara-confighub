const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PROTECTED_NAMESPACE_OWNERSHIP_POLICY =
  "a declared Kubernetes system namespace is retained in place while exactly four reviewed legacy Kubara ownership fields are detached with JSON-Patch UID/resourceVersion/value tests, only after the replacement Namespace has the expected Argo tracking identity and matching ConfigHub origin; the Namespace is never deleted or recreated";

export const PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS = Object.freeze([
  detachment({
    migrationID: "hx-metrics-dev/default-namespace-ownership-detach/v1",
    cluster: "hx-app-dev",
    application: "hx-metrics-dev",
    unitSlug: "hx-metrics",
    replacementNamespace: "metrics-server",
  }),
  detachment({
    migrationID: "hx-traefik-staging/default-namespace-ownership-detach/v1",
    cluster: "hx-app-staging",
    application: "hx-traefik-staging",
    unitSlug: "hx-traefik",
    replacementNamespace: "traefik",
  }),
  detachment({
    migrationID: "hx-traefik-prod-a/default-namespace-ownership-detach/v1",
    cluster: "hx-app-prod-a",
    application: "hx-traefik-prod-a",
    unitSlug: "hx-traefik",
    replacementNamespace: "traefik",
  }),
  detachment({
    migrationID: "hx-traefik-prod-b/default-namespace-ownership-detach/v1",
    cluster: "hx-app-prod-b",
    application: "hx-traefik-prod-b",
    unitSlug: "hx-traefik",
    replacementNamespace: "traefik",
  }),
]);

export function protectedNamespaceDetachmentFor(cluster, application) {
  return PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.find(
    (item) => item.cluster === cluster && item.application === application,
  ) ?? null;
}

export function classifyProtectedNamespaceOwnership(contract, retained, replacement) {
  assertContract(contract);
  assertNamespaceIdentity(retained, contract.retainedNamespace, `${contract.migrationID}: retained Namespace`);
  assertNamespaceIdentity(replacement, contract.replacementNamespace, `${contract.migrationID}: replacement Namespace`);

  const replacementTracking = replacement.metadata.annotations?.["argocd.argoproj.io/tracking-id"];
  invariant(
    replacementTracking === contract.replacementTrackingID,
    `${contract.migrationID}: replacement Argo tracking identity drifted`,
  );
  const replacementOriginText = replacement.metadata.annotations?.["confighub.com/origin"];
  const replacementOrigin = parseOrigin(replacementOriginText, `${contract.migrationID}: replacement origin`);
  assertOriginIdentity(contract, replacementOrigin, { legacy: false });

  const current = ownershipFields(retained);
  const absent = Object.values(current).every((value) => value === undefined);
  if (absent) {
    return {
      state: "already-detached",
      retainedUID: retained.metadata.uid,
      retainedResourceVersion: retained.metadata.resourceVersion,
      replacementUID: replacement.metadata.uid,
      replacementResourceVersion: replacement.metadata.resourceVersion,
      replacementOrigin,
    };
  }

  invariant(
    Object.values(current).every((value) => value !== undefined),
    `${contract.migrationID}: protected Namespace ownership is partially detached; refusing mutation`,
  );
  invariant(current.trackingID === contract.legacyTrackingID, `${contract.migrationID}: legacy Argo tracking identity drifted`);
  invariant(current.projectName === contract.legacyLabels["project-name"], `${contract.migrationID}: legacy project-name drifted`);
  invariant(current.stage === contract.legacyLabels.stage, `${contract.migrationID}: legacy stage drifted`);
  const legacyOrigin = parseOrigin(current.origin, `${contract.migrationID}: legacy origin`);
  assertOriginIdentity(contract, legacyOrigin, { legacy: true });
  invariant(
    legacyOrigin.spaceId === replacementOrigin.spaceId && legacyOrigin.unitId === replacementOrigin.unitId,
    `${contract.migrationID}: legacy and replacement ConfigHub entity IDs differ`,
  );
  invariant(
    replacementOrigin.revisionNum > legacyOrigin.revisionNum,
    `${contract.migrationID}: replacement origin is not newer than the legacy origin`,
  );

  return {
    state: "legacy-owned",
    retainedUID: retained.metadata.uid,
    retainedResourceVersion: retained.metadata.resourceVersion,
    replacementUID: replacement.metadata.uid,
    replacementResourceVersion: replacement.metadata.resourceVersion,
    legacyOrigin,
    replacementOrigin,
    ownership: current,
  };
}

export function protectedNamespaceDetachPatch(contract, classification) {
  assertContract(contract);
  invariant(classification?.state === "legacy-owned", `${contract.migrationID}: only exact legacy ownership can be patched`);
  return [
    { op: "test", path: "/metadata/name", value: contract.retainedNamespace },
    { op: "test", path: "/metadata/uid", value: classification.retainedUID },
    { op: "test", path: "/metadata/resourceVersion", value: classification.retainedResourceVersion },
    { op: "test", path: "/status/phase", value: "Active" },
    { op: "test", path: "/metadata/labels/kubernetes.io~1metadata.name", value: contract.retainedNamespace },
    { op: "test", path: "/metadata/annotations/argocd.argoproj.io~1tracking-id", value: contract.legacyTrackingID },
    { op: "test", path: "/metadata/annotations/confighub.com~1origin", value: classification.ownership.origin },
    { op: "test", path: "/metadata/labels/project-name", value: contract.legacyLabels["project-name"] },
    { op: "test", path: "/metadata/labels/stage", value: contract.legacyLabels.stage },
    { op: "remove", path: "/metadata/annotations/argocd.argoproj.io~1tracking-id" },
    { op: "remove", path: "/metadata/annotations/confighub.com~1origin" },
    { op: "remove", path: "/metadata/labels/project-name" },
    { op: "remove", path: "/metadata/labels/stage" },
  ];
}

export function validateProtectedNamespaceDetached(contract, beforeUID, retained, replacement) {
  const classification = classifyProtectedNamespaceOwnership(contract, retained, replacement);
  invariant(classification.state === "already-detached", `${contract.migrationID}: ownership fields remain after detachment`);
  invariant(classification.retainedUID === beforeUID, `${contract.migrationID}: retained Namespace UID changed`);
  return classification;
}

export function assertProtectedNamespaceDetachmentEvidence(item, contract, { requireComplete = true } = {}) {
  assertContract(contract);
  invariant(item?.migrationID === contract.migrationID, `${contract.migrationID}: evidence migration identity drifted`);
  invariant(item.cluster === contract.cluster, `${contract.migrationID}: evidence cluster drifted`);
  invariant(item.application === `${contract.cluster}/${contract.application}`, `${contract.migrationID}: evidence Application drifted`);
  invariant(item.namespace === contract.retainedNamespace, `${contract.migrationID}: evidence retained Namespace drifted`);
  invariant(item.replacementNamespace === contract.replacementNamespace, `${contract.migrationID}: evidence replacement Namespace drifted`);
  invariant(UUID_PATTERN.test(item.uid ?? ""), `${contract.migrationID}: evidence UID is invalid`);
  invariant(UUID_PATTERN.test(item.replacementUID ?? ""), `${contract.migrationID}: replacement evidence UID is invalid`);
  invariant(/^\d+$/.test(String(item.resourceVersionObserved ?? "")), `${contract.migrationID}: evidence resourceVersion is invalid`);
  invariant(/^sha256:[0-9a-f]{64}$/.test(item.expectedRevision ?? ""), `${contract.migrationID}: evidence OCI revision is invalid`);
  invariant(
    ["prepared", "patch-returned", "observed-detached"].includes(item.state),
    `${contract.migrationID}: evidence state is invalid`,
  );
  invariant(Number.isFinite(Date.parse(item.preparedAt ?? "")), `${contract.migrationID}: evidence preparedAt is invalid`);
  if (item.state === "observed-detached") {
    invariant(
      ["already-detached", "detached-by-reconciler"].includes(item.outcome),
      `${contract.migrationID}: evidence outcome is invalid`,
    );
    invariant(Number.isFinite(Date.parse(item.observedDetachedAt ?? "")), `${contract.migrationID}: observedDetachedAt is invalid`);
    invariant(item.evidenceScope === "historical-migration-event", `${contract.migrationID}: evidence scope drifted`);
  } else if (requireComplete) {
    invariant(false, `${contract.migrationID}: evidence is not complete`);
  }
}

export function selfTestProtectedNamespaceOwnership() {
  const contract = PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS[2];
  const spaceId = "11111111-1111-4111-8111-111111111111";
  const unitId = "22222222-2222-4222-8222-222222222222";
  const retained = namespaceFixture({
    name: contract.retainedNamespace,
    uid: "33333333-3333-4333-8333-333333333333",
    resourceVersion: "41",
    annotations: {
      "argocd.argoproj.io/tracking-id": contract.legacyTrackingID,
      "confighub.com/origin": JSON.stringify({
        spaceId,
        spaceSlug: contract.spaceSlug,
        unitId,
        unitSlug: contract.unitSlug,
        revisionNum: contract.legacyOriginRevision,
      }),
    },
    labels: contract.legacyLabels,
  });
  const replacement = namespaceFixture({
    name: contract.replacementNamespace,
    uid: "44444444-4444-4444-8444-444444444444",
    resourceVersion: "52",
    annotations: {
      "argocd.argoproj.io/tracking-id": contract.replacementTrackingID,
      "confighub.com/origin": JSON.stringify({
        spaceId,
        spaceSlug: contract.spaceSlug,
        unitId,
        unitSlug: contract.unitSlug,
        revisionNum: 3,
      }),
    },
  });

  const classification = classifyProtectedNamespaceOwnership(contract, retained, replacement);
  invariant(classification.state === "legacy-owned", "self-test: exact legacy ownership was not recognized");
  const patch = protectedNamespaceDetachPatch(contract, classification);
  invariant(
    patch.every((item) => ["test", "remove"].includes(item.op)),
    "self-test: protected Namespace patch contains a non-test/non-remove operation",
  );
  invariant(
    patch.filter((item) => item.op === "remove").map((item) => item.path).join("\n") === [
      "/metadata/annotations/argocd.argoproj.io~1tracking-id",
      "/metadata/annotations/confighub.com~1origin",
      "/metadata/labels/project-name",
      "/metadata/labels/stage",
    ].join("\n"),
    "self-test: protected Namespace patch removal allowlist drifted",
  );

  const detached = structuredClone(retained);
  delete detached.metadata.annotations["argocd.argoproj.io/tracking-id"];
  delete detached.metadata.annotations["confighub.com/origin"];
  delete detached.metadata.labels["project-name"];
  delete detached.metadata.labels.stage;
  detached.metadata.resourceVersion = "42";
  const postcondition = validateProtectedNamespaceDetached(
    contract,
    retained.metadata.uid,
    detached,
    replacement,
  );
  invariant(postcondition.state === "already-detached", "self-test: detached postcondition was not recognized");

  assertProtectedNamespaceDetachmentEvidence({
    migrationID: contract.migrationID,
    cluster: contract.cluster,
    application: `${contract.cluster}/${contract.application}`,
    namespace: contract.retainedNamespace,
    replacementNamespace: contract.replacementNamespace,
    uid: retained.metadata.uid,
    replacementUID: replacement.metadata.uid,
    resourceVersionObserved: retained.metadata.resourceVersion,
    expectedRevision: `sha256:${"a".repeat(64)}`,
    state: "observed-detached",
    outcome: "detached-by-reconciler",
    evidenceScope: "historical-migration-event",
    preparedAt: "2026-08-05T00:00:00.000Z",
    observedDetachedAt: "2026-08-05T00:00:01.000Z",
  }, contract);

  const partial = structuredClone(retained);
  delete partial.metadata.labels.stage;
  expectFailure(
    () => classifyProtectedNamespaceOwnership(contract, partial, replacement),
    "partially detached",
  );
  const alien = structuredClone(retained);
  alien.metadata.annotations["argocd.argoproj.io/tracking-id"] = "alien:/Namespace:traefik/default";
  expectFailure(
    () => classifyProtectedNamespaceOwnership(contract, alien, replacement),
    "tracking identity drifted",
  );
  const replaced = structuredClone(replacement);
  replaced.metadata.annotations["confighub.com/origin"] = JSON.stringify({
    spaceId: "55555555-5555-4555-8555-555555555555",
    spaceSlug: contract.spaceSlug,
    unitId,
    unitSlug: contract.unitSlug,
    revisionNum: 3,
  });
  expectFailure(
    () => classifyProtectedNamespaceOwnership(contract, retained, replaced),
    "entity IDs differ",
  );
}

function detachment({ migrationID, cluster, application, unitSlug, replacementNamespace }) {
  return Object.freeze({
    migrationID,
    cluster,
    application,
    spaceSlug: application,
    unitSlug,
    retainedNamespace: "default",
    replacementNamespace,
    legacyOriginRevision: 2,
    legacyTrackingID: `${application}:/Namespace:${replacementNamespace}/default`,
    replacementTrackingID: `${application}:/Namespace:${replacementNamespace}/${replacementNamespace}`,
    legacyLabels: Object.freeze({ "project-name": "test-cluster", stage: "local" }),
  });
}

function namespaceFixture({ name, uid, resourceVersion, annotations = {}, labels = {} }) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid,
      resourceVersion,
      annotations: { ...annotations },
      labels: {
        "kubernetes.io/metadata.name": name,
        ...labels,
      },
    },
    status: { phase: "Active" },
  };
}

function expectFailure(callback, pattern) {
  let message = "";
  try {
    callback();
  } catch (error) {
    message = error.message;
  }
  invariant(message.includes(pattern), `self-test: expected failure containing ${JSON.stringify(pattern)}, got ${JSON.stringify(message)}`);
}

function assertContract(contract) {
  invariant(PROTECTED_NAMESPACE_OWNERSHIP_DETACHMENTS.includes(contract), "unknown protected Namespace ownership contract");
}

function assertNamespaceIdentity(namespace, expectedName, prefix) {
  invariant(namespace?.apiVersion === "v1" && namespace?.kind === "Namespace", `${prefix} GVK drifted`);
  invariant(namespace.metadata?.name === expectedName, `${prefix} name drifted`);
  invariant(UUID_PATTERN.test(namespace.metadata?.uid ?? ""), `${prefix} UID is invalid`);
  invariant(/^\d+$/.test(String(namespace.metadata?.resourceVersion ?? "")), `${prefix} resourceVersion is invalid`);
  invariant(namespace.metadata?.deletionTimestamp == null, `${prefix} is terminating`);
  invariant(namespace.status?.phase === "Active", `${prefix} is not Active`);
  invariant(
    namespace.metadata?.labels?.["kubernetes.io/metadata.name"] === expectedName,
    `${prefix} built-in name label drifted`,
  );
}

function ownershipFields(namespace) {
  return {
    trackingID: namespace.metadata.annotations?.["argocd.argoproj.io/tracking-id"],
    origin: namespace.metadata.annotations?.["confighub.com/origin"],
    projectName: namespace.metadata.labels?.["project-name"],
    stage: namespace.metadata.labels?.stage,
  };
}

function parseOrigin(value, prefix) {
  invariant(typeof value === "string" && value.length > 0, `${prefix} is missing`);
  let origin;
  try {
    origin = JSON.parse(value);
  } catch {
    invariant(false, `${prefix} is not JSON`);
  }
  invariant(origin && typeof origin === "object" && !Array.isArray(origin), `${prefix} is not an object`);
  return origin;
}

function assertOriginIdentity(contract, origin, { legacy }) {
  invariant(UUID_PATTERN.test(origin.spaceId ?? ""), `${contract.migrationID}: origin Space ID is invalid`);
  invariant(UUID_PATTERN.test(origin.unitId ?? ""), `${contract.migrationID}: origin Unit ID is invalid`);
  invariant(origin.spaceSlug === contract.spaceSlug, `${contract.migrationID}: origin Space slug drifted`);
  invariant(origin.unitSlug === contract.unitSlug, `${contract.migrationID}: origin Unit slug drifted`);
  invariant(Number.isInteger(origin.revisionNum) && origin.revisionNum > 0, `${contract.migrationID}: origin revision is invalid`);
  if (legacy) {
    invariant(
      origin.revisionNum === contract.legacyOriginRevision,
      `${contract.migrationID}: legacy origin revision drifted`,
    );
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
