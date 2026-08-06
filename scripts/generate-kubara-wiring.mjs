#!/usr/bin/env node

// Recover one normalized provides/needs graph from the committed Kubara
// effective-render corpus. The extractor only records references visible in
// rendered Kubernetes objects. Controller-produced objects are distinguished
// from rendered objects, external inputs stay external, and an unpaired need
// stays unresolved.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  check,
  parseDocs,
  readYaml,
  relativeRepo,
  repoRoot,
  sha256,
  write,
} from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--generate";
const profileArg = option("--profile") ?? "current";
const requestedProfiles = process.argv.includes("--all") ? ["current", "historical-v0.12.0"] : [profileArg];
const PROFILES = {
  current: {
    id: "current-platform",
    role: "primary-current",
    renderRoot: join(repoRoot, "data", "kubara-effective-renders", "current-platform"),
    artifactIndex: join(repoRoot, "examples", "kubara", "current-platform", "component-artifacts.yaml"),
    outputRoot: join(repoRoot, "data", "kubara-wiring"),
  },
  "historical-v0.12.0": {
    id: "historical-v0.12.0",
    role: "secondary-historical",
    renderRoot: join(repoRoot, "data", "kubara-effective-renders", "historical-v0.12.0", "test-cluster"),
    artifactIndex: join(repoRoot, "examples", "kubara", "local-platform", "catalog-alignment.yaml"),
    outputRoot: join(repoRoot, "data", "kubara-wiring", "historical-v0.12.0"),
  },
};

const CLUSTER_SCOPED_KINDS = new Set([
  "APIService",
  "CSIDriver",
  "CSINode",
  "ClusterExternalSecret",
  "ClusterIssuer",
  "ClusterRole",
  "ClusterRoleBinding",
  "ClusterSecretStore",
  "CustomResourceDefinition",
  "IngressClass",
  "MutatingWebhookConfiguration",
  "Namespace",
  "Node",
  "PersistentVolume",
  "PriorityClass",
  "RuntimeClass",
  "StorageClass",
  "ValidatingWebhookConfiguration",
  "VolumeAttachment",
]);

const BUILTIN_API_GROUPS = new Set([
  "",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "apps",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "autoscaling",
  "batch",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
]);

const REFERENCEABLE_KINDS = new Set([
  "ApplicationSet",
  "AppProject",
  "ClusterIssuer",
  "ClusterRole",
  "ClusterSecretStore",
  "ConfigMap",
  "DaemonSet",
  "Deployment",
  "IngressClass",
  "Issuer",
  "Namespace",
  "PersistentVolumeClaim",
  "PriorityClass",
  "Prometheus",
  "Role",
  "RuntimeClass",
  "Secret",
  "SecretStore",
  "Service",
  "ServiceAccount",
  "ServiceMonitor",
  "StatefulSet",
  "StorageClass",
]);

if (["--handoff-generate", "--handoff-verify"].includes(mode)) {
  const profile = loadPreparedHandoffProfile();
  const report = buildReport(profile);
  const output = profile.graphOutput;
  if (mode === "--handoff-generate") write(output, report.graph);
  else {
    check(existsSync(output), `${profileLabel(profile, output)} is missing; generate the prepared handoff wiring graph`);
    check(readFileSync(output, "utf8") === report.graph, `${profileLabel(profile, output)} is stale; regenerate the prepared handoff wiring graph`);
  }
  console.log(`${mode === "--handoff-generate" ? "wrote" : "verified"} prepared Kubara handoff wiring graph: ${report.document.spec.summary.needs} needs, ${report.document.spec.summary.unresolved} unresolved`);
} else if (["--generate", "--verify"].includes(mode)) {
  selfTest();
  for (const profileName of requestedProfiles) {
    const profile = loadProfile(profileName);
    const report = buildReport(profile);
    const outputs = outputPaths(profile);
    if (mode === "--generate") writeOutputs(report, outputs);
    else {
      for (const [name, path] of Object.entries(outputs)) {
        check(existsSync(path), `${relativeRepo(path)} is missing; generate wiring profile ${profile.id}`);
        check(readFileSync(path, "utf8") === report[name], `${relativeRepo(path)} is stale; generate wiring profile ${profile.id}`);
      }
    }
    console.log(`${mode === "--generate" ? "wrote" : "verified"} ${profile.role} Kubara wiring graph: ${report.document.spec.summary.needs} needs, ${report.document.spec.summary.unresolved} unresolved`);
  }
} else if (mode === "--self-test") {
  selfTest();
  console.log("Kubara wiring extractor self-test passed");
} else {
  console.log(`Usage:
  node scripts/generate-kubara-wiring.mjs --generate [--profile current|historical-v0.12.0|--all]
  node scripts/generate-kubara-wiring.mjs --verify   [--profile current|historical-v0.12.0|--all]
  node scripts/generate-kubara-wiring.mjs --handoff-generate --root <prepared-output-root> --artifact-index <exact-lock> --output <graph.json> --name <slug>
  node scripts/generate-kubara-wiring.mjs --handoff-verify   --root <prepared-output-root> --artifact-index <exact-lock> --output <graph.json> --name <slug>
  node scripts/generate-kubara-wiring.mjs --self-test`);
}

function loadPreparedHandoffProfile() {
  const root = resolve(requiredOption("--root"));
  const artifactIndex = resolve(requiredOption("--artifact-index"));
  const graphOutput = resolve(requiredOption("--output"));
  const name = requiredOption("--name");
  check(/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(name), "prepared handoff --name must be a lowercase DNS-style slug");
  const renderReceiptPath = join(root, "generation-receipt.yaml");
  check(existsSync(renderReceiptPath), `${renderReceiptPath} is missing`);
  check(existsSync(artifactIndex), `${artifactIndex} is missing`);
  check(relative(root, graphOutput) === "wiring/graph.json", "prepared handoff graph output must be <root>/wiring/graph.json");
  return {
    id: name,
    role: "prepared-git-handoff",
    preparedHandoff: true,
    pathRoot: root,
    renderRoot: join(root, "effective-renders"),
    renderReceiptPath,
    artifactIndex,
    artifactIndexLabel: "component-artifacts.yaml",
    outputRoot: join(root, "wiring"),
    graphOutput,
  };
}

function loadProfile(name) {
  const profile = PROFILES[name];
  check(profile, `unknown Kubara wiring profile ${name}`);
  const renderReceiptPath = join(profile.renderRoot, "receipt.yaml");
  check(existsSync(renderReceiptPath), `${relativeRepo(renderReceiptPath)} is missing; generate effective renders for ${profile.id}`);
  check(existsSync(profile.artifactIndex), `${relativeRepo(profile.artifactIndex)} is missing`);
  return { ...profile, renderReceiptPath };
}

function outputPaths(profile) {
  return {
    graph: join(profile.outputRoot, "graph.json"),
    csv: join(profile.outputRoot, "edges.csv"),
    summary: join(profile.outputRoot, "summary.md"),
    html: join(profile.outputRoot, "graph.html"),
  };
}

function buildReport(profile) {
  const { corpus, receipt } = loadCorpus(profile);
  const analyses = [...groupBy(corpus, (entry) => entry.cluster).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cluster, entries]) => scopeAnalysis(analyzeCorpus(entries), cluster));
  const analysis = mergeAnalyses(analyses);
  const versions = selectedVersions(profile);
  const components = corpus.map((entry) => ({
    id: `component:${entry.cluster}/${entry.component}`,
    cluster: entry.cluster,
    component: entry.component,
    kubaraService: entry.kubaraService,
    selectedVersions: versions.get(normalizeService(entry.kubaraService)) ?? [],
    render: entry.source,
    releaseNamespace: entry.releaseNamespace,
    objectCount: entry.docs.length,
  })).sort((left, right) => left.cluster.localeCompare(right.cluster) || left.component.localeCompare(right.component));
  const needs = analysis.needEdges;
  const provides = analysis.provideEdges;
  const statuses = countBy(needs, (edge) => edge.status);
  const crossComponent = needs.filter((edge) => edge.providerComponents.some((provider) => provider !== edge.component));
  const applicationDeliveries = needs.filter((edge) => edge.reason === "ApplicationSet selector matches this Argo cluster registration; the controller would generate one Application when the registration exists");
  const emptyApplicationSelectors = needs.filter((edge) => edge.reason === "ApplicationSet cluster generator has no matching Argo cluster registration in the effective render");
  const graph = {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "KubaraProvidesNeedsGraph",
    metadata: { name: `${profile.id}-provides-needs` },
    spec: {
      evidence: {
        mode: "offline-effective-render",
        profileRole: profile.role,
        kubaraVersion: receipt.spec?.source?.kubaraVersion ?? receipt.spec?.tools?.kubaraVersion ?? "unknown",
        catalogVersion: receipt.spec?.source?.catalogVersion ?? receipt.spec?.tools?.catalogVersion ?? "unknown",
        renderReceipt: profileLabel(profile, profile.renderReceiptPath),
        artifactIndex: profile.artifactIndexLabel ?? profileLabel(profile, profile.artifactIndex),
        clusters: [...new Set(corpus.map((entry) => entry.cluster))].sort(),
        liveReads: [],
      },
      vocabulary: {
        "resolved-rendered": "At least one matching provider is a rendered object or rendered CRD capability.",
        "resolved-runtime": "A rendered controller contract declares the output, but this graph does not prove that a controller materialized it.",
        external: "The dependency is intentionally outside the rendered Kubernetes object set.",
        "target-prerequisite": "The reference is to a well-known target-cluster object outside this aggregate render; presence is not observed here.",
        "optional-unprovided": "The rendered reference is explicitly optional and has no provider in the aggregate render.",
        unresolved: "No matching provider declaration exists in the committed aggregate render.",
        ambiguous: "More than one component declares an exact provider where one owner is expected.",
      },
      components,
      facts: [...analysis.facts.values()].sort(compareById),
      edges: [...provides, ...needs].sort(compareEdges),
      unknowns: needs
        .filter((edge) => ["unresolved", "ambiguous", "external", "target-prerequisite", "optional-unprovided"].includes(edge.status))
        .map((edge) => ({
          component: edge.component,
          fact: edge.to,
          status: edge.status,
          reason: edge.reason,
          evidence: edge.evidence,
        })),
      summary: {
        componentInstances: components.length,
        logicalComponents: new Set(components.map((entry) => entry.component)).size,
        clusters: new Set(components.map((entry) => entry.cluster)).size,
        facts: analysis.facts.size,
        provides: provides.length,
        needs: needs.length,
        crossComponentNeeds: crossComponent.length,
        applicationDeliveryEdges: applicationDeliveries.length,
        applicationSelectorZeroMatches: emptyApplicationSelectors.length,
        resolvedRendered: statuses["resolved-rendered"] ?? 0,
        resolvedRuntime: statuses["resolved-runtime"] ?? 0,
        external: statuses.external ?? 0,
        targetPrerequisite: statuses["target-prerequisite"] ?? 0,
        optionalUnprovided: statuses["optional-unprovided"] ?? 0,
        unresolved: statuses.unresolved ?? 0,
        ambiguous: statuses.ambiguous ?? 0,
      },
      claimBoundary: [
        profile.preparedHandoff
          ? "The graph is mechanically derived from prepared effective renders; the final Git commit and external credential scan are bound later."
          : "The graph is mechanically derived from committed effective renders, not inferred from chart names or intended values branches.",
        "Resolved-runtime means a controller contract is rendered; it is not live evidence that the target object exists.",
        "Unresolved means absent from this aggregate render. A separately managed cluster prerequisite may still satisfy it.",
        "Disabled or non-rendering values branches do not appear as wiring edges.",
      ],
    },
  };
  if (profile.preparedHandoff) rewritePreparedEvidenceLanguage(graph);
  const csv = edgesCsv(graph.spec.edges, analysis.facts);
  const summary = markdownSummary(graph, needs, crossComponent, applicationDeliveries, profile);
  const html = htmlReport(graph, needs);
  return {
    document: graph,
    csv,
    summary,
    html,
    graph: `${JSON.stringify(graph, null, 2)}\n`,
  };
}

function rewritePreparedEvidenceLanguage(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") {
      value[key] = nested
        .replaceAll("committed effective render", "prepared effective render")
        .replaceAll("committed aggregate render", "prepared aggregate render")
        .replaceAll("committed desired state", "prepared desired state");
    } else rewritePreparedEvidenceLanguage(nested);
  }
}

function writeOutputs(report, outputs) {
  write(outputs.graph, report.graph);
  write(outputs.csv, report.csv);
  write(outputs.summary, report.summary);
  write(outputs.html, report.html);
}

function loadCorpus(profile) {
  const receipt = readYaml(profile.renderReceiptPath);
  const instances = profile.preparedHandoff
    ? receipt.spec?.outputs?.renders ?? []
    : receipt.spec?.instances ?? receipt.spec?.components ?? [];
  const corpus = instances.map((instance) => {
    const path = profile.preparedHandoff
      ? safePreparedPath(profile.pathRoot, instance.output, "prepared handoff render output")
      : join(repoRoot, instance.output);
    check(existsSync(path), `${instance.output} is missing`);
    const text = readFileSync(path, "utf8");
    check(sha256(text) === instance.sha256, `${instance.output} does not match the effective-render receipt`);
    const docs = parseDocs(text).filter(isObject);
    check(docs.length === instance.objectCount, `${instance.output} object count does not match the effective-render receipt`);
    return {
      cluster: instance.cluster ?? "test-cluster",
      component: instance.component ?? instance.service ?? instance.name,
      kubaraService: instance.kubaraService ?? instance.service,
      releaseNamespace: instance.namespace,
      source: instance.output,
      docs,
    };
  });
  return { corpus, receipt };
}

function selectedVersions(profile) {
  if (profile.preparedHandoff) {
    const receipt = readYaml(profile.renderReceiptPath);
    const result = new Map();
    for (const row of receipt.spec?.outputs?.renders ?? []) {
      const service = normalizeService(row.service ?? "");
      check(service, "prepared handoff render row has no service");
      const versions = [...(row.selectedVersions ?? [])]
        .map((entry) => ({ identity: entry.identity, version: String(entry.version) }))
        .sort((left, right) => left.identity.localeCompare(right.identity));
      const prior = result.get(service);
      check(!prior || JSON.stringify(prior) === JSON.stringify(versions), `${service}: prepared handoff selected versions differ across clusters`);
      result.set(service, versions);
    }
    return result;
  }
  const index = readYaml(profile.artifactIndex);
  const result = new Map();
  const rows = index.kind === "KubaraComponentArtifactSet"
    ? [
        ...(index.spec?.artifacts ?? []).map((row) => ({ canonicalIdentity: row.canonicalIdentity, kubara: { service: row.service, selectedVersion: row.version, wrapperVersion: row.wrapperVersion } })),
        ...(index.spec?.firstParty ?? []).filter((row) => row.deployable !== false).map((row) => ({ canonicalIdentity: row.canonicalIdentity, kubara: { service: row.service, selectedVersion: row.wrapperVersion, wrapperVersion: row.wrapperVersion } })),
      ]
    : index.spec?.components ?? [];
  for (const row of rows) {
    const service = normalizeService(row.kubara?.service ?? "");
    if (!service) continue;
    if (!result.has(service)) result.set(service, []);
    result.get(service).push({
      identity: row.canonicalIdentity,
      version: String(row.kubara?.selectedVersion ?? row.kubara?.wrapperVersion ?? "unknown"),
    });
  }
  for (const entries of result.values()) entries.sort((left, right) => left.identity.localeCompare(right.identity));
  return result;
}

function profileLabel(profile, path) {
  if (profile.preparedHandoff) return relative(profile.pathRoot, path).replaceAll("\\", "/");
  return relativeRepo(path);
}

function safePreparedPath(root, value, label) {
  check(typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"), `${label} must be a safe handoff-relative path`);
  const path = resolve(root, value);
  const rel = relative(root, path);
  check(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), `${label} escapes the prepared handoff root`);
  return path;
}

function scopeAnalysis(analysis, cluster) {
  const factIds = new Map([...analysis.facts.keys()].map((id) => [id, `${id.replace(/^fact:/, `fact:${token(cluster)}:`)}`]));
  const edgeIds = new Map([...analysis.provideEdges, ...analysis.needEdges].map((edge) => [edge.id, edge.id.replace(/^edge:/, `edge:${token(cluster)}:`)]));
  const scopeEdge = (edge) => ({
    ...edge,
    id: edgeIds.get(edge.id),
    from: `component:${cluster}/${edge.component}`,
    to: factIds.get(edge.to),
    component: `${cluster}/${edge.component}`,
    providerComponents: (edge.providerComponents ?? []).map((component) => `${cluster}/${component}`),
    providers: (edge.providers ?? []).map((id) => edgeIds.get(id)),
    evidence: (edge.evidence ?? []).map((item) => ({ ...item, cluster })),
  });
  return {
    facts: new Map([...analysis.facts.entries()].map(([id, fact]) => [factIds.get(id), { ...fact, id: factIds.get(id), cluster }])),
    provideEdges: analysis.provideEdges.map(scopeEdge),
    needEdges: analysis.needEdges.map(scopeEdge),
  };
}

function mergeAnalyses(analyses) {
  return {
    facts: new Map(analyses.flatMap((analysis) => [...analysis.facts.entries()])),
    provideEdges: analyses.flatMap((analysis) => analysis.provideEdges).sort(compareEdges),
    needEdges: analyses.flatMap((analysis) => analysis.needEdges).sort(compareEdges),
  };
}

function analyzeCorpus(corpus) {
  const facts = new Map();
  const provideEdges = [];
  const rawNeeds = [];
  const records = corpus.flatMap((entry) => entry.docs.map((doc, index) => normalizeRecord(entry, doc, index)));
  const namespaces = records.filter((record) => record.doc.kind === "Namespace");
  const services = records.filter((record) => record.doc.kind === "Service");
  const serviceMonitors = records.filter((record) => record.doc.kind === "ServiceMonitor");

  const addFact = (fact) => {
    if (!facts.has(fact.id)) facts.set(fact.id, fact);
    return fact.id;
  };
  const addProvider = (component, fact, assurance, evidence) => {
    const to = addFact(fact);
    provideEdges.push({
      id: edgeId("provides", component, to, evidence),
      relation: "provides",
      from: `component:${component}`,
      to,
      component,
      assurance,
      status: String(assurance).startsWith("declared-") ? "declared-runtime" : "rendered",
      providerComponents: [component],
      evidence: [evidence],
      reason: providerReason(assurance),
    });
  };
  const addNeed = (component, fact, evidence, reason, hint = "") => {
    const to = addFact(fact);
    rawNeeds.push({
      id: edgeId("needs", component, to, evidence),
      relation: "needs",
      from: `component:${component}`,
      to,
      component,
      evidence: [evidence],
      reason,
      resolutionHint: hint,
    });
  };

  // Rendered objects, CRD-provided APIs, service endpoints, and hook records.
  for (const record of records) {
    const { component, doc } = record;
    const evidence = evidenceFor(record, "metadata.name");
    if (REFERENCEABLE_KINDS.has(doc.kind)) {
      addProvider(component, objectFact(doc.kind, record.namespace, doc.metadata.name), "rendered-object", evidence);
    }
    if (doc.kind === "CustomResourceDefinition") {
      const group = doc.spec?.group ?? "";
      const kind = doc.spec?.names?.kind ?? "";
      if (group && kind) addProvider(component, apiFact(group, kind), "rendered-crd", evidenceFor(record, "spec.names.kind"));
    }
    if (doc.kind === "Service") {
      for (const [index, port] of (doc.spec?.ports ?? []).entries()) {
        if (port.name) addProvider(component, endpointFact(record.namespace, doc.metadata.name, String(port.name)), "rendered-object", evidenceFor(record, `spec.ports[${index}].name`));
        if (port.port !== undefined) addProvider(component, endpointFact(record.namespace, doc.metadata.name, String(port.port)), "rendered-object", evidenceFor(record, `spec.ports[${index}].port`));
      }
    }
    const hook = doc.metadata?.annotations?.["helm.sh/hook"];
    if (hook) addProvider(component, hookFact(record.namespace, doc.kind, doc.metadata.name, hook), "rendered-hook", evidenceFor(record, "metadata.annotations.helm.sh/hook"));
  }

  // Rendered declarations whose output is materialized by a controller.
  for (const record of records) {
    const { component, doc } = record;
    if (doc.kind === "ExternalSecret") {
      const target = doc.spec?.target?.name ?? doc.metadata.name;
      if (target) addProvider(component, objectFact("Secret", record.namespace, target), "declared-controller-output", evidenceFor(record, "spec.target.name"));
    }
    if (doc.kind === "Certificate" && doc.spec?.secretName) {
      addProvider(component, objectFact("Secret", record.namespace, doc.spec.secretName), "declared-controller-output", evidenceFor(record, "spec.secretName"));
    }
    if (declaresArgoRedisSecret(doc)) {
      addProvider(component, objectFact("Secret", record.namespace, "argocd-redis"), "declared-hook-output", evidenceFor(record, "spec.template.spec.containers[].command"));
    }
    if (doc.kind === "Ingress" && issuerAnnotation(doc)) {
      for (const [index, tls] of (doc.spec?.tls ?? []).entries()) {
        if (tls.secretName) addProvider(component, objectFact("Secret", record.namespace, tls.secretName), "declared-controller-output", evidenceFor(record, `spec.tls[${index}].secretName`));
      }
    }
    if (doc.kind === "ClusterExternalSecret") {
      const target = doc.spec?.externalSecretSpec?.target?.name;
      for (const [selectorIndex, selector] of (doc.spec?.namespaceSelectors ?? []).entries()) {
        const matches = namespaces.filter((namespace) => matchesLabelSelector(namespace.doc.metadata?.labels ?? {}, selector));
        const selectorFact = labelSelectorFact("Namespace", "_cluster", selector);
        for (const namespace of matches) {
          addProvider(namespace.component, selectorFact, "rendered-selector-match", evidenceFor(namespace, "metadata.labels"));
          if (target) addProvider(component, objectFact("Secret", "", target, namespace.doc.metadata.name), "declared-controller-output", evidenceFor(record, `spec.namespaceSelectors[${selectorIndex}]`));
        }
      }
    }
  }

  // Argo CD's cluster generator is the rendered hub/spoke join: cluster
  // Secrets (including Secrets declared by ExternalSecret) carry the Kubara
  // service-selection labels consumed by each ApplicationSet. A selector with
  // no match is valid and means the ApplicationSet intentionally emits no
  // Applications, so it is kept as optional-unprovided rather than an error.
  const argoRegistrations = records.map(argoClusterRegistration).filter(Boolean);
  for (const record of records.filter((entry) => entry.doc.kind === "ApplicationSet")) {
    for (const generator of applicationSetClusterGenerators(record.doc.spec?.generators ?? [])) {
      const matches = argoRegistrations.filter((registration) => matchesLabelSelector(registration.labels, generator.selector));
      for (const registration of matches) {
        addNeed(
          record.component,
          objectFact("Secret", registration.namespace, registration.secretName),
          evidenceFor(record, generator.path),
          "ApplicationSet selector matches this Argo cluster registration; the controller would generate one Application when the registration exists",
        );
      }
      if (matches.length === 0) {
        addNeed(
          record.component,
          argoClusterSelectorFact(record.namespace, generator.selector),
          evidenceFor(record, generator.path),
          "ApplicationSet cluster generator has no matching Argo cluster registration in the effective render",
          "optional",
        );
      }
    }
    const project = record.doc.spec?.template?.spec?.project;
    if (project && !String(project).includes("{{")) {
      addNeed(record.component, objectFact("AppProject", record.namespace, project), evidenceFor(record, "spec.template.spec.project"), "ApplicationSet template references an Argo AppProject");
    }
    for (const [index, source] of (record.doc.spec?.template?.spec?.sources ?? []).entries()) {
      if (!source?.repoURL) continue;
      addNeed(
        record.component,
        gitSourceFact(source.repoURL, source.targetRevision ?? "", source.path ?? "", source.ref ?? ""),
        evidenceFor(record, `spec.template.spec.sources[${index}]`),
        "ApplicationSet source is a Git repository input outside the rendered object set",
        "external",
      );
    }
  }

  // Object-level needs.
  for (const record of records) {
    const { component, doc } = record;
    const group = apiGroup(doc.apiVersion);
    if (!BUILTIN_API_GROUPS.has(group) && doc.kind !== "CustomResourceDefinition") {
      addNeed(component, apiFact(group, doc.kind), evidenceFor(record, "apiVersion"), `custom resource ${group}/${doc.kind} requires its CRD`);
    }
    extractPodNeeds(record, addNeed);
    extractIngressNeeds(record, addNeed);
    extractExternalSecretNeeds(record, namespaces, addNeed, addProvider);
    extractCertificateNeeds(record, addNeed);
    extractRbacNeeds(record, addNeed);
    extractWebhookNeeds(record, addNeed);
    extractApiServiceNeeds(record, addNeed);
    extractAutoscalingNeeds(record, addNeed);
    extractAcmeNeeds(record, addNeed);
    extractKubernetesDnsNeeds(record, addNeed);

    if (doc.kind === "ServiceMonitor") {
      const selector = doc.spec?.selector ?? {};
      const namespaceSelector = doc.spec?.namespaceSelector ?? {};
      const candidates = objectsInSelectedNamespaces(services, record.namespace, namespaceSelector)
        .filter((service) => matchesLabelSelector(service.doc.metadata?.labels ?? {}, selector));
      const fact = labelSelectorFact("Service", namespaceSelectorLabel(record.namespace, namespaceSelector), selector);
      for (const service of candidates) addProvider(service.component, fact, "rendered-selector-match", evidenceFor(service, "metadata.labels"));
      const hint = candidates.length === 0 && selectorTargetsClusterNamespace(record.namespace, namespaceSelector) ? "target-prerequisite" : "";
      addNeed(component, fact, evidenceFor(record, "spec.selector"), "ServiceMonitor selector requires at least one rendered Service match", hint);
    }
    if (doc.kind === "Prometheus" && doc.spec?.serviceMonitorSelector !== undefined && doc.spec?.serviceMonitorSelector !== null) {
      const selector = doc.spec.serviceMonitorSelector ?? {};
      const namespaceSelector = doc.spec?.serviceMonitorNamespaceSelector ?? {};
      const candidates = objectsInSelectedNamespaces(serviceMonitors, record.namespace, namespaceSelector)
        .filter((monitor) => matchesLabelSelector(monitor.doc.metadata?.labels ?? {}, selector));
      const fact = labelSelectorFact("ServiceMonitor", namespaceSelectorLabel(record.namespace, namespaceSelector), selector);
      for (const monitor of candidates) addProvider(monitor.component, fact, "rendered-selector-match", evidenceFor(monitor, "metadata.labels"));
      addNeed(component, fact, evidenceFor(record, "spec.serviceMonitorSelector"), "Prometheus selector requires rendered ServiceMonitor matches");
    }
    if (doc.kind === "ClusterExternalSecret") {
      for (const [index, selector] of (doc.spec?.namespaceSelectors ?? []).entries()) {
        addNeed(component, labelSelectorFact("Namespace", "_cluster", selector), evidenceFor(record, `spec.namespaceSelectors[${index}]`), "ClusterExternalSecret requires matching namespaces");
      }
    }
  }

  const dedupedProviders = dedupeEdges(provideEdges);
  const providerIndex = groupBy(dedupedProviders, (edge) => edge.to);
  const needEdges = dedupeEdges(rawNeeds).map((need) => resolveNeed(need, providerIndex, facts));
  return {
    facts,
    provideEdges: dedupedProviders,
    needEdges: needEdges.sort(compareEdges),
  };
}

function normalizeRecord(entry, doc, index) {
  const namespace = effectiveNamespace(doc, entry.releaseNamespace);
  return {
    component: entry.component,
    source: entry.source,
    releaseNamespace: entry.releaseNamespace,
    index,
    namespace,
    identity: [doc.apiVersion, doc.kind, namespace, doc.metadata?.name ?? ""].join("|"),
    doc,
  };
}

function effectiveNamespace(doc, releaseNamespace) {
  if (isClusterScoped(doc.kind)) return "";
  return doc.metadata?.namespace ?? releaseNamespace;
}

function isClusterScoped(kind) {
  return CLUSTER_SCOPED_KINDS.has(kind) || kind.startsWith("Cluster");
}

function extractPodNeeds(record, addNeed) {
  const podSpecs = [];
  const { doc } = record;
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(doc.kind)) podSpecs.push([doc.spec?.template?.spec, "spec.template.spec"]);
  if (doc.kind === "Job") podSpecs.push([doc.spec?.template?.spec, "spec.template.spec"]);
  if (doc.kind === "CronJob") podSpecs.push([doc.spec?.jobTemplate?.spec?.template?.spec, "spec.jobTemplate.spec.template.spec"]);
  if (doc.kind === "Pod") podSpecs.push([doc.spec, "spec"]);
  if (doc.kind === "ServiceAccount") {
    for (const [index, ref] of (doc.imagePullSecrets ?? []).entries()) {
      if (ref.name) addNeed(record.component, objectFact("Secret", record.namespace, ref.name), evidenceFor(record, `imagePullSecrets[${index}].name`), "ServiceAccount image pull secret reference");
    }
  }
  for (const [podSpec, base] of podSpecs) {
    if (!podSpec) continue;
    if (podSpec.serviceAccountName && podSpec.serviceAccountName !== "default") {
      addNeed(record.component, objectFact("ServiceAccount", record.namespace, podSpec.serviceAccountName), evidenceFor(record, `${base}.serviceAccountName`), "workload service account reference");
    }
    for (const [index, ref] of (podSpec.imagePullSecrets ?? []).entries()) {
      if (ref.name) addNeed(record.component, objectFact("Secret", record.namespace, ref.name), evidenceFor(record, `${base}.imagePullSecrets[${index}].name`), "workload image pull secret reference");
    }
    for (const [index, volume] of (podSpec.volumes ?? []).entries()) {
      const prefix = `${base}.volumes[${index}]`;
      if (volume.secret?.secretName) addNeed(record.component, objectFact("Secret", record.namespace, volume.secret.secretName), evidenceFor(record, `${prefix}.secret.secretName`), "pod volume secret reference", volume.secret.optional === true ? "optional" : "");
      if (volume.configMap?.name) addNeed(record.component, objectFact("ConfigMap", record.namespace, volume.configMap.name), evidenceFor(record, `${prefix}.configMap.name`), "pod volume ConfigMap reference", volume.configMap.optional === true ? "optional" : "");
      if (volume.persistentVolumeClaim?.claimName) addNeed(record.component, objectFact("PersistentVolumeClaim", record.namespace, volume.persistentVolumeClaim.claimName), evidenceFor(record, `${prefix}.persistentVolumeClaim.claimName`), "pod volume claim reference");
      for (const [sourceIndex, source] of (volume.projected?.sources ?? []).entries()) {
        if (source.secret?.name) addNeed(record.component, objectFact("Secret", record.namespace, source.secret.name), evidenceFor(record, `${prefix}.projected.sources[${sourceIndex}].secret.name`), "projected secret reference", source.secret.optional === true ? "optional" : "");
        if (source.configMap?.name) addNeed(record.component, objectFact("ConfigMap", record.namespace, source.configMap.name), evidenceFor(record, `${prefix}.projected.sources[${sourceIndex}].configMap.name`), "projected ConfigMap reference", source.configMap.optional === true ? "optional" : "");
      }
    }
    const containers = [
      ...(podSpec.initContainers ?? []).map((container, index) => [container, `${base}.initContainers[${index}]`]),
      ...(podSpec.containers ?? []).map((container, index) => [container, `${base}.containers[${index}]`]),
      ...(podSpec.ephemeralContainers ?? []).map((container, index) => [container, `${base}.ephemeralContainers[${index}]`]),
    ];
    for (const [container, prefix] of containers) {
      for (const [index, envFrom] of (container.envFrom ?? []).entries()) {
        if (envFrom.secretRef?.name) addNeed(record.component, objectFact("Secret", record.namespace, envFrom.secretRef.name), evidenceFor(record, `${prefix}.envFrom[${index}].secretRef.name`), "container envFrom secret reference", envFrom.secretRef.optional === true ? "optional" : "");
        if (envFrom.configMapRef?.name) addNeed(record.component, objectFact("ConfigMap", record.namespace, envFrom.configMapRef.name), evidenceFor(record, `${prefix}.envFrom[${index}].configMapRef.name`), "container envFrom ConfigMap reference", envFrom.configMapRef.optional === true ? "optional" : "");
      }
      for (const [index, env] of (container.env ?? []).entries()) {
        if (env.valueFrom?.secretKeyRef?.name) addNeed(record.component, objectFact("Secret", record.namespace, env.valueFrom.secretKeyRef.name), evidenceFor(record, `${prefix}.env[${index}].valueFrom.secretKeyRef.name`), "container secret key reference", env.valueFrom.secretKeyRef.optional === true ? "optional" : "");
        if (env.valueFrom?.configMapKeyRef?.name) addNeed(record.component, objectFact("ConfigMap", record.namespace, env.valueFrom.configMapKeyRef.name), evidenceFor(record, `${prefix}.env[${index}].valueFrom.configMapKeyRef.name`), "container ConfigMap key reference", env.valueFrom.configMapKeyRef.optional === true ? "optional" : "");
      }
    }
  }
  if (doc.kind === "PersistentVolumeClaim" && doc.spec?.storageClassName) {
    addNeed(record.component, objectFact("StorageClass", "", doc.spec.storageClassName), evidenceFor(record, "spec.storageClassName"), "PVC storage class reference");
  }
}

function extractIngressNeeds(record, addNeed) {
  const { doc } = record;
  if (doc.kind !== "Ingress") return;
  if (doc.spec?.ingressClassName) addNeed(record.component, objectFact("IngressClass", "", doc.spec.ingressClassName), evidenceFor(record, "spec.ingressClassName"), "Ingress class reference");
  const issuer = issuerAnnotation(doc);
  if (issuer) {
    const kind = doc.metadata?.annotations?.["cert-manager.io/issuer"] ? "Issuer" : "ClusterIssuer";
    addNeed(record.component, objectFact(kind, kind === "Issuer" ? record.namespace : "", issuer), evidenceFor(record, `metadata.annotations.${kind === "Issuer" ? "cert-manager.io/issuer" : "cert-manager.io/cluster-issuer"}`), "cert-manager ingress issuer reference");
  }
  const backends = [];
  if (doc.spec?.defaultBackend?.service) backends.push([doc.spec.defaultBackend.service, "spec.defaultBackend.service"]);
  for (const [ruleIndex, rule] of (doc.spec?.rules ?? []).entries()) {
    for (const [pathIndex, path] of (rule.http?.paths ?? []).entries()) {
      if (path.backend?.service) backends.push([path.backend.service, `spec.rules[${ruleIndex}].http.paths[${pathIndex}].backend.service`]);
    }
  }
  for (const [backend, path] of backends) {
    const port = backend.port?.name ?? backend.port?.number;
    const fact = port === undefined ? objectFact("Service", record.namespace, backend.name) : endpointFact(record.namespace, backend.name, String(port));
    addNeed(record.component, fact, evidenceFor(record, path), "Ingress backend service reference");
  }
  for (const [index, tls] of (doc.spec?.tls ?? []).entries()) {
    if (tls.secretName) addNeed(record.component, objectFact("Secret", record.namespace, tls.secretName), evidenceFor(record, `spec.tls[${index}].secretName`), "Ingress TLS secret reference");
  }
}

function extractExternalSecretNeeds(record, namespaces, addNeed) {
  const { doc } = record;
  const externalSpec = doc.kind === "ExternalSecret" ? doc.spec : doc.kind === "ClusterExternalSecret" ? doc.spec?.externalSecretSpec : null;
  if (!externalSpec) return;
  const store = externalSpec.secretStoreRef;
  if (store?.name) {
    const kind = store.kind ?? "SecretStore";
    addNeed(record.component, objectFact(kind, kind === "ClusterSecretStore" ? "" : record.namespace, store.name), evidenceFor(record, doc.kind === "ExternalSecret" ? "spec.secretStoreRef" : "spec.externalSecretSpec.secretStoreRef"), "External Secrets store reference");
  }
  const remoteRefs = [];
  for (const [index, item] of (externalSpec.data ?? []).entries()) {
    if (item.remoteRef?.key) remoteRefs.push([item.remoteRef.key, item.remoteRef.property ?? "", `data[${index}].remoteRef`]);
  }
  for (const [index, item] of (externalSpec.dataFrom ?? []).entries()) {
    const entry = item.extract ?? item.find ?? item.rewrite;
    if (entry?.key) remoteRefs.push([entry.key, "", `dataFrom[${index}]`]);
  }
  for (const [key, property, path] of remoteRefs) {
    addNeed(record.component, externalSecretFact(key, property), evidenceFor(record, `${doc.kind === "ExternalSecret" ? "spec" : "spec.externalSecretSpec"}.${path}`), "remote secret backend input", "external");
  }
}

function extractCertificateNeeds(record, addNeed) {
  const { doc } = record;
  if (doc.kind !== "Certificate" || !doc.spec?.issuerRef?.name) return;
  const kind = doc.spec.issuerRef.kind ?? "Issuer";
  addNeed(record.component, objectFact(kind, kind === "ClusterIssuer" ? "" : record.namespace, doc.spec.issuerRef.name), evidenceFor(record, "spec.issuerRef"), "Certificate issuer reference");
}

function extractRbacNeeds(record, addNeed) {
  const { doc } = record;
  if (!["RoleBinding", "ClusterRoleBinding"].includes(doc.kind)) return;
  if (doc.roleRef?.name) {
    const kind = doc.roleRef.kind ?? (doc.kind === "ClusterRoleBinding" ? "ClusterRole" : "Role");
    const targetHint =
      (kind === "ClusterRole" && String(doc.roleRef.name).startsWith("system:")) ||
      (kind === "Role" && record.namespace === "kube-system" && doc.roleRef.name === "extension-apiserver-authentication-reader")
        ? "target-prerequisite"
        : "";
    addNeed(record.component, objectFact(kind, kind === "ClusterRole" ? "" : record.namespace, doc.roleRef.name), evidenceFor(record, "roleRef"), "RBAC role reference", targetHint);
  }
  for (const [index, subject] of (doc.subjects ?? []).entries()) {
    if (subject.kind === "ServiceAccount" && subject.name) {
      addNeed(record.component, objectFact("ServiceAccount", subject.namespace ?? record.namespace, subject.name), evidenceFor(record, `subjects[${index}]`), "RBAC ServiceAccount subject");
    }
  }
}

function extractWebhookNeeds(record, addNeed) {
  const { doc } = record;
  if (["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"].includes(doc.kind)) {
    for (const [index, webhook] of (doc.webhooks ?? []).entries()) {
      const service = webhook.clientConfig?.service;
      if (service?.name) addNeed(record.component, endpointFact(service.namespace ?? "default", service.name, String(service.port ?? 443)), evidenceFor(record, `webhooks[${index}].clientConfig.service`), "admission webhook service reference");
    }
  }
  if (doc.kind === "CustomResourceDefinition") {
    const service = doc.spec?.conversion?.webhook?.clientConfig?.service;
    if (service?.name) addNeed(record.component, endpointFact(service.namespace ?? "default", service.name, String(service.port ?? 443)), evidenceFor(record, "spec.conversion.webhook.clientConfig.service"), "CRD conversion webhook service reference");
  }
}

function extractApiServiceNeeds(record, addNeed) {
  const { doc } = record;
  if (doc.kind !== "APIService" || !doc.spec?.service?.name) return;
  addNeed(record.component, endpointFact(doc.spec.service.namespace ?? "default", doc.spec.service.name, String(doc.spec.service.port ?? 443)), evidenceFor(record, "spec.service"), "aggregated API service reference");
}

function extractAutoscalingNeeds(record, addNeed) {
  const { doc } = record;
  if (!["HorizontalPodAutoscaler", "VerticalPodAutoscaler"].includes(doc.kind)) return;
  const target = doc.spec?.scaleTargetRef?.name ? doc.spec.scaleTargetRef : doc.spec?.targetRef;
  if (!target?.name || !target.kind) return;
  addNeed(record.component, objectFact(target.kind, record.namespace, target.name), evidenceFor(record, doc.spec?.scaleTargetRef ? "spec.scaleTargetRef" : "spec.targetRef"), "autoscaler target reference");
}

function extractAcmeNeeds(record, addNeed) {
  const { doc } = record;
  if (!["Issuer", "ClusterIssuer"].includes(doc.kind) || !doc.spec?.acme?.server) return;
  addNeed(record.component, externalEndpointFact(doc.spec.acme.server), evidenceFor(record, "spec.acme.server"), "ACME server is external to the rendered object set", "external");
}

function extractKubernetesDnsNeeds(record, addNeed) {
  walkStrings(record.doc, (value, path) => {
    const matches = value.matchAll(/https?:\/\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.svc(?:\.cluster\.local)?(?::([0-9]+))?/gi);
    for (const match of matches) {
      addNeed(record.component, endpointFact(match[2], match[1], match[3] ?? "any"), evidenceFor(record, path), "Kubernetes service DNS endpoint reference");
    }
  });
}

function resolveNeed(need, providerIndex, facts) {
  if (need.resolutionHint === "external") return { ...need, status: "external", providerComponents: [], providers: [] };
  const providers = providerIndex.get(need.to) ?? [];
  const providerComponents = [...new Set(providers.map((edge) => edge.component))].sort();
  if (providers.length === 0 && need.resolutionHint === "optional") return { ...need, status: "optional-unprovided", providerComponents, providers: [] };
  if (providers.length === 0 && need.resolutionHint === "target-prerequisite") return { ...need, status: "target-prerequisite", providerComponents, providers: [] };
  if (providers.length === 0) return { ...need, status: "unresolved", providerComponents, providers: [] };
  const fact = facts.get(need.to);
  const selector = fact?.factType === "label-selector";
  if (!selector && providerComponents.length > 1) {
    return { ...need, status: "ambiguous", providerComponents, providers: providers.map((edge) => edge.id).sort() };
  }
  const status = providers.some((edge) => !String(edge.assurance).startsWith("declared-")) ? "resolved-rendered" : "resolved-runtime";
  return { ...need, status, providerComponents, providers: providers.map((edge) => edge.id).sort() };
}

function objectFact(kind, namespace, name, materializedNamespace = "") {
  const effective = materializedNamespace || namespace || "_cluster";
  return {
    id: `fact:object:${token(kind)}:${token(effective)}:${token(name)}`,
    factType: "object",
    kind,
    namespace: effective === "_cluster" ? "" : effective,
    name,
    description: `${kind}/${effective === "_cluster" ? "" : `${effective}/`}${name}`,
  };
}

function apiFact(group, kind) {
  return {
    id: `fact:api:${token(group)}:${token(kind)}`,
    factType: "api-kind",
    group,
    kind,
    namespace: "",
    name: `${group}/${kind}`,
    description: `API ${group}/${kind}`,
  };
}

function endpointFact(namespace, name, port) {
  return {
    id: `fact:service-endpoint:${token(namespace)}:${token(name)}:${token(port)}`,
    factType: "service-endpoint",
    kind: "Service",
    namespace,
    name,
    port,
    description: `Service endpoint ${namespace}/${name}:${port}`,
  };
}

function labelSelectorFact(targetKind, namespaceScope, selector) {
  const normalized = stableStringify(selector ?? {});
  return {
    id: `fact:selector:${token(targetKind)}:${token(namespaceScope)}:${sha256(normalized).slice(0, 16)}`,
    factType: "label-selector",
    targetKind,
    namespaceScope,
    selector: selector ?? {},
    kind: targetKind,
    namespace: namespaceScope,
    name: normalized,
    description: `${targetKind} selector ${normalized} in ${namespaceScope}`,
  };
}

function externalSecretFact(key, property) {
  return {
    id: `fact:external-secret:${sha256(`${key}\n${property}`).slice(0, 20)}`,
    factType: "external-secret",
    kind: "ExternalSecretBackendKey",
    namespace: "",
    name: property ? `${key}#${property}` : key,
    external: true,
    description: `external secret ${property ? `${key}#${property}` : key}`,
  };
}

function externalEndpointFact(url) {
  return {
    id: `fact:external-endpoint:${sha256(url).slice(0, 20)}`,
    factType: "external-endpoint",
    kind: "ExternalEndpoint",
    namespace: "",
    name: url,
    external: true,
    description: `external endpoint ${url}`,
  };
}

function argoClusterSelectorFact(namespace, selector) {
  const normalized = stableStringify(selector ?? {});
  return {
    id: `fact:argo-cluster-selector:${token(namespace || "argocd")}:${sha256(normalized).slice(0, 16)}`,
    factType: "argo-cluster-selector",
    kind: "ArgoClusterSecret",
    namespace,
    name: normalized,
    selector: selector ?? {},
    description: `Argo cluster registration selector ${normalized} in ${namespace || "argocd"}`,
  };
}

function gitSourceFact(repoURL, revision, path, ref) {
  const normalized = stableStringify({ repoURL, revision, path, ref });
  return {
    id: `fact:git-source:${sha256(normalized).slice(0, 20)}`,
    factType: "git-source",
    kind: "GitSource",
    namespace: "",
    name: `${repoURL}@${revision || "default"}${path ? `:${path}` : ""}${ref ? `#${ref}` : ""}`,
    repoURL,
    revision,
    path,
    ref,
    external: true,
    description: `Git source ${repoURL}@${revision || "default"}${path ? `:${path}` : ""}${ref ? `#${ref}` : ""}`,
  };
}

function hookFact(namespace, kind, name, phases) {
  return {
    id: `fact:hook:${token(namespace || "_cluster")}:${token(kind)}:${token(name)}`,
    factType: "helm-hook",
    kind,
    namespace,
    name,
    phases: String(phases).split(",").map((item) => item.trim()).filter(Boolean),
    description: `Helm hook ${kind}/${namespace ? `${namespace}/` : ""}${name} (${phases})`,
  };
}

function evidenceFor(record, path) {
  return {
    source: record.source,
    document: record.index + 1,
    object: record.identity,
    path,
  };
}

function edgeId(relation, component, fact, evidence) {
  return `edge:${relation}:${token(component)}:${sha256(`${fact}\n${evidence.source}\n${evidence.document}\n${evidence.path}`).slice(0, 20)}`;
}

function issuerAnnotation(doc) {
  return doc.metadata?.annotations?.["cert-manager.io/cluster-issuer"] ?? doc.metadata?.annotations?.["cert-manager.io/issuer"] ?? "";
}

function declaresArgoRedisSecret(doc) {
  if (doc.kind !== "Job" || !doc.metadata?.annotations?.["helm.sh/hook"]) return false;
  return (doc.spec?.template?.spec?.containers ?? []).some((container) => {
    const command = [...(container.command ?? []), ...(container.args ?? [])].map(String).join(" ");
    return /(?:^|\s)argocd\s+admin\s+redis-initial-password(?:\s|$)/.test(command);
  });
}

function argoClusterRegistration(record) {
  const renderedLabels = record.doc.kind === "Secret" ? record.doc.metadata?.labels : null;
  if (renderedLabels?.["argocd.argoproj.io/secret-type"] === "cluster") {
    return {
      component: record.component,
      labels: renderedLabels,
      namespace: record.namespace,
      secretName: record.doc.metadata.name,
    };
  }
  const declaredLabels = record.doc.kind === "ExternalSecret" ? record.doc.spec?.target?.template?.metadata?.labels : null;
  if (declaredLabels?.["argocd.argoproj.io/secret-type"] === "cluster") {
    return {
      component: record.component,
      labels: declaredLabels,
      namespace: record.namespace,
      secretName: record.doc.spec?.target?.name ?? record.doc.metadata.name,
    };
  }
  return null;
}

function applicationSetClusterGenerators(generators, path = "spec.generators") {
  const result = [];
  for (const [index, generator] of (generators ?? []).entries()) {
    const current = `${path}[${index}]`;
    if (generator?.clusters?.selector) result.push({ selector: generator.clusters.selector, path: `${current}.clusters.selector` });
    if (generator?.matrix?.generators) result.push(...applicationSetClusterGenerators(generator.matrix.generators, `${current}.matrix.generators`));
    if (generator?.merge?.generators) result.push(...applicationSetClusterGenerators(generator.merge.generators, `${current}.merge.generators`));
  }
  return result;
}

function apiGroup(apiVersion) {
  return String(apiVersion ?? "").includes("/") ? String(apiVersion).split("/")[0] : "";
}

function normalizeService(value) {
  return value === "argocd" ? "argo-cd" : value;
}

function matchesLabelSelector(labels, selector) {
  if (!Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels?.[key] === value)) return false;
  for (const expression of selector?.matchExpressions ?? []) {
    const present = Object.hasOwn(labels ?? {}, expression.key);
    const values = expression.values ?? [];
    if (expression.operator === "In" && (!present || !values.includes(labels[expression.key]))) return false;
    if (expression.operator === "NotIn" && present && values.includes(labels[expression.key])) return false;
    if (expression.operator === "Exists" && !present) return false;
    if (expression.operator === "DoesNotExist" && present) return false;
  }
  return true;
}

function objectsInSelectedNamespaces(records, localNamespace, namespaceSelector) {
  if (namespaceSelector?.any === true) return records;
  if ((namespaceSelector?.matchNames ?? []).length > 0) return records.filter((record) => namespaceSelector.matchNames.includes(record.namespace));
  return records.filter((record) => record.namespace === localNamespace);
}

function selectorTargetsClusterNamespace(localNamespace, selector) {
  const names = selector?.matchNames ?? [];
  return names.length > 0 && names.some((name) => name !== localNamespace && ["default", "kube-system"].includes(name));
}

function namespaceSelectorLabel(localNamespace, selector) {
  if (selector?.any === true) return "*";
  if ((selector?.matchNames ?? []).length > 0) return [...selector.matchNames].sort().join("+");
  return localNamespace;
}

function walkStrings(value, callback, path = "") {
  if (typeof value === "string") return callback(value, path);
  if (Array.isArray(value)) return value.forEach((child, index) => walkStrings(child, callback, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) walkStrings(child, callback, path ? `${path}.${key}` : key);
}

function providerReason(assurance) {
  if (assurance === "rendered-crd") return "CRD in the effective render declares this API kind";
  if (assurance === "rendered-selector-match") return "rendered object labels match the consuming selector";
  if (assurance === "declared-controller-output") return "rendered controller contract declares this output; materialization is not observed here";
  if (assurance === "declared-hook-output") return "rendered Helm hook command declares this output; hook execution is not observed here";
  if (assurance === "rendered-argo-cluster-match") return "rendered Argo cluster Secret labels match the ApplicationSet cluster selector";
  if (assurance === "declared-argo-cluster-match") return "rendered ExternalSecret declares an Argo cluster Secret whose labels match the ApplicationSet selector; materialization is not observed here";
  if (assurance === "rendered-hook") return "rendered object carries a Helm hook annotation";
  return "object exists in the committed effective render";
}

function dedupeEdges(edges) {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()].sort(compareEdges);
}

function groupBy(items, keyFor) {
  const result = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function countBy(items, keyFor) {
  const result = {};
  for (const item of items) {
    const key = keyFor(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function compareById(left, right) {
  return left.id.localeCompare(right.id);
}

function compareEdges(left, right) {
  return left.relation.localeCompare(right.relation) || left.component.localeCompare(right.component) || left.to.localeCompare(right.to) || left.id.localeCompare(right.id);
}

function token(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "none";
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isObject(doc) {
  return Boolean(doc && typeof doc === "object" && doc.apiVersion && doc.kind && doc.metadata?.name);
}

function edgesCsv(edges, facts) {
  const headers = ["relation", "cluster", "component", "fact_type", "kind", "namespace", "name", "status", "assurance", "provider_components", "reason", "source", "object", "path"];
  const rows = edges.map((edge) => {
    const fact = facts.get(edge.to) ?? {};
    const evidence = edge.evidence?.[0] ?? {};
    return {
      relation: edge.relation,
      cluster: fact.cluster ?? evidence.cluster ?? "",
      component: edge.component,
      fact_type: fact.factType ?? "",
      kind: fact.kind ?? "",
      namespace: fact.namespace ?? "",
      name: fact.name ?? "",
      status: edge.status,
      assurance: edge.assurance ?? "",
      provider_components: (edge.providerComponents ?? []).join(";"),
      reason: edge.reason,
      source: evidence.source ?? "",
      object: evidence.object ?? "",
      path: evidence.path ?? "",
    };
  });
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")).join("\n")}\n`;
}

function markdownSummary(graph, needs, crossComponent, applicationDeliveries, profile) {
  const s = graph.spec.summary;
  const componentRows = graph.spec.components.map((component) => {
    const instance = `${component.cluster}/${component.component}`;
    const own = needs.filter((edge) => edge.component === instance);
    const counts = countBy(own, (edge) => edge.status);
    const versions = component.selectedVersions.map((entry) => `${entry.identity.replace(/^helm:/, "")}@${entry.version}`).join("; ") || "first-party wrapper";
    return `| ${component.cluster} | ${component.component} | ${versions} | ${component.objectCount} | ${own.length} | ${counts["resolved-rendered"] ?? 0} | ${counts["resolved-runtime"] ?? 0} | ${counts.external ?? 0} | ${counts["target-prerequisite"] ?? 0} | ${counts["optional-unprovided"] ?? 0} | ${counts.unresolved ?? 0} | ${counts.ambiguous ?? 0} |`;
  }).join("\n");
  const unknownRows = needs.filter((edge) => ["unresolved", "external", "ambiguous", "target-prerequisite", "optional-unprovided"].includes(edge.status)).map((edge) => {
    const fact = graph.spec.facts.find((item) => item.id === edge.to);
    const evidence = edge.evidence[0];
    return `| ${statusIcon(edge.status)} ${edge.status} | ${edge.component} | ${escapeMd(fact?.description ?? edge.to)} | \`${evidence.object}\` → \`${evidence.path}\` | ${escapeMd(edge.reason)} |`;
  }).join("\n") || "| — | — | — | — | No unresolved, external, or ambiguous needs. |";
  const crossRows = crossComponent.map((edge) => {
    const fact = graph.spec.facts.find((item) => item.id === edge.to);
    return `| ${edge.component} | ${edge.providerComponents.join(", ")} | ${escapeMd(fact?.description ?? edge.to)} | ${edge.status} |`;
  }).join("\n") || "| — | — | — | — |";
  const deliveryRows = applicationDeliveries.map((edge) => {
    const fact = graph.spec.facts.find((item) => item.id === edge.to);
    const applicationSet = edge.evidence[0]?.object?.split("|").at(-1) ?? "unknown";
    return `| ${applicationSet} | ${escapeMd(fact?.description ?? edge.to)} | ${edge.status} |`;
  }).join("\n") || "| — | — | No selected registrations. |";
  const receiptLink = relative(profile.outputRoot, profile.renderReceiptPath).replaceAll("\\", "/");
  return `# Kubara Effective-Render Wiring — ${profile.role}

This ${profile.role === "primary-current" ? "primary" : "secondary historical"} report is generated from
committed effective Helm renders for Kubara
${graph.spec.evidence.kubaraVersion} across ${s.clusters} cluster(s). It records
object references and selector matches visible in those manifests. It performs
no live reads and does not claim live reconciliation.

[Return to the Kubara buyer and adoption journey](https://confighub.github.io/helm-expt/site/kubara.html)
· [Browse the component-first Catalog](https://confighub.github.io/helm-expt/site/charts/)

Colored, accessible table: [graph.html](graph.html). Machine-readable forms:
[graph.json](graph.json) and [edges.csv](edges.csv). Render provenance:
[effective-render receipt](${receiptLink}).

## Summary

| Metric | Count |
| --- | ---: |
| Clusters | ${s.clusters} |
| Logical components | ${s.logicalComponents} |
| Component instances | ${s.componentInstances} |
| Normalized facts | ${s.facts} |
| Provides edges | ${s.provides} |
| Needs edges | ${s.needs} |
| Cross-component needs | ${s.crossComponentNeeds} |
| Application delivery edges | ${s.applicationDeliveryEdges} |
| ApplicationSets selecting zero clusters | ${s.applicationSelectorZeroMatches} |
| Resolved by rendered object/CRD | ${s.resolvedRendered} |
| Declared controller/hook output | ${s.resolvedRuntime} |
| External inputs | ${s.external} |
| Target-cluster prerequisites not in render | ${s.targetPrerequisite} |
| Explicitly optional references without provider | ${s.optionalUnprovided} |
| Unresolved in aggregate render | ${s.unresolved} |
| Ambiguous owners | ${s.ambiguous} |

\`resolved-runtime\` is deliberately amber: an ExternalSecret, Certificate,
annotated Ingress, or Helm hook declares an output, but this offline graph
cannot prove that a controller or hook created it. \`target-prerequisite\` and
\`optional-unprovided\` keep expected absences separate from genuine unresolved
wiring. \`unresolved\` means the aggregate render has no matching provider
declaration; it does not prove that a separately managed prerequisite is absent.

## Per component

| Cluster | Component | Selected package version(s) | Rendered objects | Needs | Rendered | Runtime | External | Target | Optional | Unresolved | Ambiguous |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${componentRows}

## Hub ApplicationSet delivery joins

Each row is one mechanically matched \`ApplicationSet\` selector and Argo cluster
registration Secret. \`resolved-runtime\` means an ExternalSecret declares the
spoke registration, but this offline render does not prove the Secret or the
generated Application exists live.

| ApplicationSet | Matching registration | Resolution |
| --- | --- | --- |
${deliveryRows}

## Cross-component joins

| Consumer | Provider(s) | Fact | Resolution |
| --- | --- | --- | --- |
${crossRows}

## Explicit unknowns and external inputs

| Status | Component | Fact | Rendered reference | Why it is recorded |
| --- | --- | --- | --- | --- |
${unknownRows}

## Mechanical extraction scope

The extractor covers CRD/API dependencies, exact object references from pods,
RBAC, ingress, webhooks, APIService and autoscaling resources; ServiceMonitor,
Prometheus and ClusterExternalSecret label selectors; External Secrets stores
and remote keys; cert-manager issuer and generated-Secret contracts; Kubernetes
service-DNS URLs; service endpoints; PVC storage classes; Helm hook objects;
and Argo ApplicationSet joins to AppProjects, Git sources, and rendered or
controller-declared cluster registrations. An ApplicationSet selector with no
matching cluster registration is recorded as optional-unprovided because zero
generated Applications is a valid selector result.

Values branches that produced no object are absent by design. The graph does
not infer availability from component names, chart documentation, or the
historical live receipt.

## Commands

~~~sh
node scripts/generate-kubara-effective-renders.mjs --verify --profile ${profile.role === "primary-current" ? "current" : "historical-v0.12.0"}
node scripts/generate-kubara-wiring.mjs --generate --profile ${profile.role === "primary-current" ? "current" : "historical-v0.12.0"}
node scripts/generate-kubara-wiring.mjs --verify --profile ${profile.role === "primary-current" ? "current" : "historical-v0.12.0"}
node scripts/generate-kubara-wiring.mjs --self-test
~~~
`;
}

function htmlReport(graph, needs) {
  const facts = new Map(graph.spec.facts.map((fact) => [fact.id, fact]));
  const rows = needs.map((edge) => {
    const fact = facts.get(edge.to) ?? {};
    const evidence = edge.evidence[0] ?? {};
    return `<tr><th scope="row">${escapeHtml(edge.component)}</th><td>${escapeHtml(fact.factType ?? "")}</td><td>${escapeHtml(fact.description ?? edge.to)}</td><td class="status ${statusClass(edge.status)}"><span aria-hidden="true">${statusGlyph(edge.status)}</span> ${escapeHtml(edge.status)}</td><td>${escapeHtml(edge.providerComponents.join(", ") || "none recorded")}</td><td><code>${escapeHtml(evidence.object ?? "")}</code><br><code>${escapeHtml(evidence.path ?? "")}</code></td><td>${escapeHtml(edge.reason)}</td></tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kubara effective-render wiring</title>
<style>
:root{color-scheme:light dark}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fff;color:#17212b}h1{font-size:1.65rem;margin-bottom:.25rem}.lede,.boundary{max-width:90ch;color:#3f4d5a}.legend{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.key,.status{border-radius:.25rem;padding:.25rem .5rem;font-weight:700}.rendered{background:#d7f2df;color:#14532d}.runtime{background:#fff0bd;color:#634b00}.external{background:#dce9ff;color:#173b75}.optional{background:#edf1f5;color:#344454}.unresolved{background:#ffd9d9;color:#781d1d}.ambiguous{background:#ffe2bd;color:#6b3500}table{border-collapse:collapse;width:100%;font-size:.85rem}caption{text-align:left;font-weight:700;padding:.5rem 0}th,td{border:1px solid #aeb8c2;padding:.45rem;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#edf1f5;color:#17212b}tbody th{white-space:nowrap}code{white-space:normal;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#10161d;color:#eef4fa}.lede,.boundary{color:#c6d1dc}thead th{background:#25313d;color:#fff}.rendered{background:#14532d;color:#fff}.runtime{background:#634b00;color:#fff}.external{background:#173b75;color:#fff}.optional{background:#344454;color:#fff}.unresolved{background:#781d1d;color:#fff}.ambiguous{background:#6b3500;color:#fff}}
</style>
</head>
<body>
<main>
<h1>Kubara effective-render wiring</h1>
<nav aria-label="Kubara example navigation"><a href="https://confighub.github.io/helm-expt/site/kubara.html">Kubara buyer journey</a> · <a href="https://confighub.github.io/helm-expt/site/charts/">Component Catalog</a></nav>
<p class="lede">${graph.spec.summary.needs} mechanically extracted needs across ${graph.spec.summary.componentInstances} component instances on ${graph.spec.summary.clusters} clusters. Status is always written as text and symbol; color is supplementary.</p>
<div class="legend" aria-label="Resolution legend"><span class="key rendered">✓ resolved-rendered</span><span class="key runtime">◐ resolved-runtime</span><span class="key external">↗ external / target prerequisite</span><span class="key optional">○ optional-unprovided</span><span class="key unresolved">! unresolved</span><span class="key ambiguous">? ambiguous</span></div>
<p class="boundary"><strong>Boundary:</strong> rendered means present in committed desired state. Runtime means a rendered controller contract declares the output. Neither is a live-health assertion.</p>
<table>
<caption>Provides/needs resolution, one row per rendered reference</caption>
<thead><tr><th scope="col">Consumer</th><th scope="col">Fact type</th><th scope="col">Need</th><th scope="col">Resolution</th><th scope="col">Provider component(s)</th><th scope="col">Evidence</th><th scope="col">Reason</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p><a href="https://confighub.github.io/helm-expt/site/kubara.html">Return to the Kubara buyer journey</a> · <a href="https://confighub.github.io/helm-expt/site/charts/">Browse every retained component version</a></p>
</main>
</body>
</html>
`;
}

function statusIcon(status) {
  return ({ "resolved-rendered": "✅", "resolved-runtime": "🟠", external: "↗️", "target-prerequisite": "🏗️", "optional-unprovided": "○", unresolved: "❌", ambiguous: "⚠️" })[status] ?? "❔";
}

function statusGlyph(status) {
  return ({ "resolved-rendered": "✓", "resolved-runtime": "◐", external: "↗", "target-prerequisite": "△", "optional-unprovided": "○", unresolved: "!", ambiguous: "?" })[status] ?? "?";
}

function statusClass(status) {
  return ({ "resolved-rendered": "rendered", "resolved-runtime": "runtime", external: "external", "target-prerequisite": "external", "optional-unprovided": "optional", unresolved: "unresolved", ambiguous: "ambiguous" })[status] ?? "ambiguous";
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeMd(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function requiredOption(name) {
  const value = option(name);
  check(value, `${name} is required`);
  return value;
}

function selfTest() {
  const fixture = [
    {
      component: "infra",
      kubaraService: "infra",
      releaseNamespace: "infra",
      source: "self-test/infra.yaml",
      docs: [
        { apiVersion: "v1", kind: "Namespace", metadata: { name: "team", labels: { stage: "dev" } } },
        { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", metadata: { name: "widgets.example.io" }, spec: { group: "example.io", names: { kind: "Widget" } } },
        { apiVersion: "networking.k8s.io/v1", kind: "IngressClass", metadata: { name: "traefik" } },
        { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: { name: "platform", namespace: "argocd" } },
        { apiVersion: "v1", kind: "Secret", metadata: { name: "cluster-team", namespace: "argocd", labels: { "argocd.argoproj.io/secret-type": "cluster", "demo-app": "enabled" } } },
        { apiVersion: "v1", kind: "Service", metadata: { name: "app", namespace: "team", labels: { app: "demo" } }, spec: { ports: [{ port: 80 }] } },
        { apiVersion: "external-secrets.io/v1", kind: "ClusterExternalSecret", metadata: { name: "pull" }, spec: { namespaceSelectors: [{ matchLabels: { stage: "dev" } }], externalSecretSpec: { secretStoreRef: { kind: "ClusterSecretStore", name: "missing" }, target: { name: "pull-secret" }, data: [{ remoteRef: { key: "registry" } }] } } },
      ],
    },
    {
      component: "app",
      kubaraService: "app",
      releaseNamespace: "team",
      source: "self-test/app.yaml",
      docs: [
        { apiVersion: "example.io/v1", kind: "Widget", metadata: { name: "sample" } },
        { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app" }, spec: { template: { spec: { imagePullSecrets: [{ name: "pull-secret" }], containers: [{ name: "app", image: "example/app:1" }] } } } },
        { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "app", annotations: { "cert-manager.io/cluster-issuer": "issuer" } }, spec: { ingressClassName: "traefik", rules: [{ http: { paths: [{ backend: { service: { name: "app", port: { number: 80 } } } }] } }], tls: [{ secretName: "app-tls" }] } },
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app-config" }, data: { endpoint: "http://missing.monitoring.svc.cluster.local:3100" } },
        { apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", metadata: { name: "demo-app", namespace: "argocd" }, spec: { generators: [{ clusters: { selector: { matchLabels: { "demo-app": "enabled" } } } }], template: { spec: { project: "platform", sources: [{ repoURL: "https://example.test/platform.git", targetRevision: "main", path: "apps/demo" }] } } } },
      ],
    },
  ];
  const result = analyzeCorpus(fixture);
  const needs = result.needEdges;
  check(needs.some((edge) => edge.to.includes("fact:api:example.io:widget") && edge.status === "resolved-rendered"), "self-test: CRD API resolution failed");
  check(needs.some((edge) => edge.to.includes("fact:object:ingressclass") && edge.status === "resolved-rendered"), "self-test: IngressClass resolution failed");
  check(needs.some((edge) => edge.to.includes("pull-secret") && edge.status === "resolved-runtime"), "self-test: ClusterExternalSecret materialization failed");
  check(needs.some((edge) => edge.to.includes("clustersecretstore") && edge.status === "unresolved"), "self-test: missing SecretStore was not explicit");
  check(needs.some((edge) => edge.to.includes("missing:3100") && edge.status === "unresolved"), "self-test: missing service DNS endpoint was not explicit");
  check(needs.some((edge) => edge.to.includes("cluster-team") && edge.reason.startsWith("ApplicationSet selector matches") && edge.status === "resolved-rendered"), "self-test: ApplicationSet cluster selector did not resolve to a rendered registration");
  check(needs.some((edge) => edge.to.includes("appproject") && edge.status === "resolved-rendered"), "self-test: ApplicationSet AppProject did not resolve");
  check(needs.some((edge) => edge.to.includes("git-source") && edge.status === "external"), "self-test: ApplicationSet Git source was not recorded as external");
}
