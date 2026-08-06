const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const KIND_TRAEFIK_POLICY =
  "each persistent Kubara kind cluster reserves the first declared NodePort in its cub window for argocd-server and exposes Traefik through a separate, exclusive HTTP/HTTPS NodePort pair two slots later; Traefik publishes the cluster DNS hostname into application Ingress status without a LoadBalancer controller or publishedService dependency, and every application Certificate is Ready";

const APPLICATION_ENDPOINTS = Object.freeze([
  applicationEndpoint("hx-web", "hx-web", "hx-web", "hx-web-tls"),
  applicationEndpoint("cubbychat", "cubbychat", "cubbychat", "cubbychat-tls"),
]);

export const KIND_TRAEFIK_CONTRACTS = Object.freeze([
  kindTraefikContract("hx-app-dev", "hx-app-dev.traefik.me", 30000, 30002, 30003),
  kindTraefikContract("hx-app-staging", "hx-app-staging.traefik.me", 30010, 30012, 30013),
  kindTraefikContract("hx-app-prod-a", "hx-app-prod-a.traefik.me", 30020, 30022, 30023),
  kindTraefikContract("hx-app-prod-b", "hx-app-prod-b.traefik.me", 30030, 30032, 30033),
]);

export function kindTraefikContractFor(cluster) {
  return KIND_TRAEFIK_CONTRACTS.find((item) => item.cluster === cluster) ?? null;
}

// Validate the two objects produced by the Traefik Helm render. The return value
// is deliberately receipt-safe: it contains the reviewed contract facts and no
// timestamps or process-local data.
export function assertKindTraefikRenderedObjects(contract, resources) {
  assertContract(contract);
  const documents = resourceItems(resources);
  const service = uniqueResource(
    documents,
    "v1",
    "Service",
    contract.namespace,
    contract.serviceName,
    `${contract.cluster}: rendered Traefik Service`,
  );
  const deployment = uniqueResource(
    documents,
    "apps/v1",
    "Deployment",
    contract.namespace,
    contract.deploymentName,
    `${contract.cluster}: rendered Traefik Deployment`,
  );
  return Object.freeze({
    cluster: contract.cluster,
    hostname: contract.hostname,
    service: assertServiceContract(contract, service, { live: false }),
    deployment: assertDeploymentContract(contract, deployment, { live: false }),
  });
}

// Validate post-convergence Kubernetes objects. `resources` may be an array of
// objects, one or more Kubernetes List objects, or any nested combination of
// those forms. Extra resources are ignored; every exact contract resource must
// occur once.
export function assertKindTraefikLiveObjects(contract, resources) {
  assertContract(contract);
  const objects = resourceItems(resources);
  const service = uniqueResource(
    objects,
    "v1",
    "Service",
    contract.namespace,
    contract.serviceName,
    `${contract.cluster}: live Traefik Service`,
  );
  const deployment = uniqueResource(
    objects,
    "apps/v1",
    "Deployment",
    contract.namespace,
    contract.deploymentName,
    `${contract.cluster}: live Traefik Deployment`,
  );
  const applications = contract.applications.map((application) => {
    const ingress = uniqueResource(
      objects,
      "networking.k8s.io/v1",
      "Ingress",
      application.namespace,
      application.ingressName,
      `${contract.cluster}/${application.id}: live Ingress`,
    );
    const certificate = uniqueResource(
      objects,
      "cert-manager.io/v1",
      "Certificate",
      application.namespace,
      application.certificateName,
      `${contract.cluster}/${application.id}: live Certificate`,
    );
    return Object.freeze({
      id: application.id,
      ingress: assertIngressContract(contract, application, ingress),
      certificate: assertCertificateContract(contract, application, certificate),
    });
  });

  return Object.freeze({
    cluster: contract.cluster,
    hostname: contract.hostname,
    reservedArgocdServerNodePort: contract.reservedArgocdServerNodePort,
    httpNodePort: contract.httpNodePort,
    httpsNodePort: contract.httpsNodePort,
    service: assertServiceContract(contract, service, { live: true }),
    deployment: assertDeploymentContract(contract, deployment, { live: true }),
    applications: Object.freeze(applications),
  });
}

export function selfTestKindTraefikContract() {
  invariant(KIND_TRAEFIK_CONTRACTS.length === 4, "self-test: expected exactly four kind Traefik contracts");
  invariant(
    new Set(KIND_TRAEFIK_CONTRACTS.map((item) => item.cluster)).size === 4,
    "self-test: cluster identities are not unique",
  );
  invariant(
    new Set(KIND_TRAEFIK_CONTRACTS.flatMap((item) => [
      item.reservedArgocdServerNodePort,
      item.httpNodePort,
      item.httpsNodePort,
    ])).size === 12,
    "self-test: reserved Argo CD and Traefik NodePorts are not exclusive across the four persistent clusters",
  );
  invariant(kindTraefikContractFor("not-a-kubara-cluster") === null, "self-test: unknown cluster matched a contract");

  for (const contract of KIND_TRAEFIK_CONTRACTS) {
    invariant(
      contract.httpNodePort === contract.reservedArgocdServerNodePort + 2,
      `${contract.cluster}: self-test Traefik HTTP NodePort overlaps the cub Argo CD reservation`,
    );
    const rendered = renderedFixture(contract);
    const renderedEvidence = assertKindTraefikRenderedObjects(contract, rendered);
    invariant(renderedEvidence.service.ports[0].nodePort === contract.httpNodePort, `${contract.cluster}: self-test HTTP NodePort drifted`);
    invariant(renderedEvidence.service.ports[1].nodePort === contract.httpsNodePort, `${contract.cluster}: self-test HTTPS NodePort drifted`);
  }

  const contract = KIND_TRAEFIK_CONTRACTS[0];
  const live = liveFixture(contract);
  const evidence = assertKindTraefikLiveObjects(contract, live);
  invariant(evidence.service.loadBalancerIngress.length === 0, "self-test: empty LoadBalancer status was not recorded");
  invariant(evidence.applications.every((item) => item.certificate.ready), "self-test: Ready Certificates were not recorded");
  invariant(evidence.applications.every((item) => item.ingress.hostname === contract.hostname), "self-test: Ingress hostnames were not recorded");

  const wrongPort = structuredClone(live);
  exactFixtureResource(wrongPort, "v1", "Service", "traefik", "traefik").spec.ports[0].nodePort = 30999;
  expectFailure(() => assertKindTraefikLiveObjects(contract, wrongPort), "Service ports drifted");

  const argocdCollision = structuredClone(live);
  exactFixtureResource(argocdCollision, "v1", "Service", "traefik", "traefik").spec.ports[0].nodePort = contract.reservedArgocdServerNodePort;
  expectFailure(() => assertKindTraefikLiveObjects(contract, argocdCollision), "Service ports drifted");

  const loadBalancerAddress = structuredClone(live);
  exactFixtureResource(loadBalancerAddress, "v1", "Service", "traefik", "traefik").status.loadBalancer.ingress = [{ ip: "192.0.2.10" }];
  expectFailure(() => assertKindTraefikLiveObjects(contract, loadBalancerAddress), "LoadBalancer ingress is not empty");

  const publishedService = structuredClone(live);
  exactFixtureResource(publishedService, "apps/v1", "Deployment", "traefik", "traefik")
    .spec.template.spec.containers[0].args.push("--providers.kubernetesingress.ingressendpoint.publishedservice=traefik/traefik");
  expectFailure(() => assertKindTraefikLiveObjects(contract, publishedService), "publishedService argument remains");

  const wrongEndpoint = structuredClone(live);
  const wrongEndpointArgs = exactFixtureResource(wrongEndpoint, "apps/v1", "Deployment", "traefik", "traefik")
    .spec.template.spec.containers[0].args;
  wrongEndpointArgs[0] = "--providers.kubernetesingress.ingressendpoint.hostname=wrong.example";
  expectFailure(() => assertKindTraefikLiveObjects(contract, wrongEndpoint), "hostname argument drifted");

  const wrongIngressStatus = structuredClone(live);
  exactFixtureResource(wrongIngressStatus, "networking.k8s.io/v1", "Ingress", "hx-web", "hx-web")
    .status.loadBalancer.ingress[0].hostname = "wrong.example";
  expectFailure(() => assertKindTraefikLiveObjects(contract, wrongIngressStatus), "Ingress status hostname drifted");

  const certificateNotReady = structuredClone(live);
  exactFixtureResource(certificateNotReady, "cert-manager.io/v1", "Certificate", "cubbychat", "cubbychat-tls")
    .status.conditions[0].status = "False";
  expectFailure(() => assertKindTraefikLiveObjects(contract, certificateNotReady), "Certificate is not Ready");
}

function kindTraefikContract(cluster, hostname, reservedArgocdServerNodePort, httpNodePort, httpsNodePort) {
  invariant(/^hx-app-(dev|staging|prod-a|prod-b)$/.test(cluster), `invalid kind Traefik cluster ${cluster}`);
  invariant(hostname === `${cluster}.traefik.me`, `${cluster}: kind Traefik hostname must use the cluster DNS name`);
  invariant(
    [reservedArgocdServerNodePort, httpNodePort, httpsNodePort].every(Number.isInteger),
    `${cluster}: NodePorts must be integers`,
  );
  invariant(reservedArgocdServerNodePort >= 30000 && httpsNodePort <= 32767, `${cluster}: NodePorts must be in the Kubernetes NodePort range`);
  invariant(httpNodePort === reservedArgocdServerNodePort + 2, `${cluster}: Traefik HTTP NodePort must leave cub's first mapped NodePort reserved for argocd-server`);
  invariant(httpsNodePort === httpNodePort + 1, `${cluster}: HTTPS NodePort must immediately follow HTTP`);
  const ports = Object.freeze([
    Object.freeze({ name: "web", port: 80, targetPort: "web", protocol: "TCP", nodePort: httpNodePort }),
    Object.freeze({ name: "websecure", port: 443, targetPort: "websecure", protocol: "TCP", nodePort: httpsNodePort }),
  ]);
  return Object.freeze({
    cluster,
    hostname,
    namespace: "traefik",
    serviceName: "traefik",
    deploymentName: "traefik",
    containerName: "traefik",
    ingressClassName: "traefik",
    reservedArgocdServerNodePort,
    httpNodePort,
    httpsNodePort,
    endpointArgument: `--providers.kubernetesingress.ingressendpoint.hostname=${hostname}`,
    ports,
    applications: APPLICATION_ENDPOINTS,
  });
}

function applicationEndpoint(id, namespace, ingressName, certificateName) {
  return Object.freeze({
    id,
    namespace,
    ingressName,
    certificateName,
    certificateSecretName: certificateName,
  });
}

function assertServiceContract(contract, service, { live }) {
  assertResourceIdentity(service, "v1", "Service", contract.namespace, contract.serviceName, { live });
  invariant(service.spec?.type === "NodePort", `${contract.cluster}: Traefik Service type is not NodePort`);
  const ports = (service.spec?.ports ?? []).map((port) => ({
    name: port.name,
    port: port.port,
    targetPort: port.targetPort,
    protocol: port.protocol ?? "TCP",
    nodePort: port.nodePort,
  }));
  invariant(
    stableJson(ports) === stableJson(contract.ports),
    `${contract.cluster}: Traefik Service ports drifted; observed ${stableJson(ports)}, expected ${stableJson(contract.ports)}`,
  );

  let loadBalancerIngress = [];
  if (live) {
    const loadBalancer = service.status?.loadBalancer;
    invariant(
      loadBalancer == null || (isPlainObject(loadBalancer) && Object.keys(loadBalancer).every((key) => key === "ingress")),
      `${contract.cluster}: Traefik Service LoadBalancer status contains unexpected fields`,
    );
    loadBalancerIngress = loadBalancer?.ingress ?? [];
    invariant(Array.isArray(loadBalancerIngress), `${contract.cluster}: Traefik Service LoadBalancer ingress is not an array`);
    invariant(loadBalancerIngress.length === 0, `${contract.cluster}: Traefik Service LoadBalancer ingress is not empty`);
  }

  return Object.freeze({
    namespace: contract.namespace,
    name: contract.serviceName,
    type: service.spec.type,
    uid: live ? service.metadata.uid : null,
    clusterIP: live ? (service.spec.clusterIP ?? null) : null,
    ports: contract.ports,
    loadBalancerIngress: Object.freeze([...loadBalancerIngress]),
  });
}

function assertDeploymentContract(contract, deployment, { live }) {
  assertResourceIdentity(deployment, "apps/v1", "Deployment", contract.namespace, contract.deploymentName, { live });
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const matches = containers.filter((item) => item.name === contract.containerName);
  invariant(matches.length === 1, `${contract.cluster}: Traefik Deployment must have exactly one ${contract.containerName} container`);
  const args = matches[0].args ?? [];
  invariant(Array.isArray(args) && args.every((item) => typeof item === "string"), `${contract.cluster}: Traefik container args are invalid`);
  invariant(
    args.filter((item) => item === contract.endpointArgument).length === 1,
    `${contract.cluster}: Traefik ingressEndpoint hostname argument drifted; expected ${contract.endpointArgument}`,
  );
  invariant(
    !args.some((item) => item.toLowerCase().includes("publishedservice")),
    `${contract.cluster}: Traefik publishedService argument remains`,
  );
  return Object.freeze({
    namespace: contract.namespace,
    name: contract.deploymentName,
    uid: live ? deployment.metadata.uid : null,
    container: contract.containerName,
    image: matches[0].image ?? null,
    endpointArgument: contract.endpointArgument,
    publishedServiceArguments: Object.freeze([]),
  });
}

function assertIngressContract(contract, application, ingress) {
  assertResourceIdentity(
    ingress,
    "networking.k8s.io/v1",
    "Ingress",
    application.namespace,
    application.ingressName,
    { live: true },
  );
  invariant(
    ingress.spec?.ingressClassName === contract.ingressClassName,
    `${contract.cluster}/${application.id}: Ingress class drifted`,
  );
  const addresses = ingress.status?.loadBalancer?.ingress;
  invariant(
    Array.isArray(addresses) && addresses.length === 1,
    `${contract.cluster}/${application.id}: Ingress status must contain exactly one address`,
  );
  invariant(
    addresses[0]?.hostname === contract.hostname && addresses[0]?.ip == null,
    `${contract.cluster}/${application.id}: Ingress status hostname drifted; expected ${contract.hostname}`,
  );
  return Object.freeze({
    namespace: application.namespace,
    name: application.ingressName,
    uid: ingress.metadata.uid,
    ingressClassName: contract.ingressClassName,
    hostname: contract.hostname,
  });
}

function assertCertificateContract(contract, application, certificate) {
  assertResourceIdentity(
    certificate,
    "cert-manager.io/v1",
    "Certificate",
    application.namespace,
    application.certificateName,
    { live: true },
  );
  invariant(
    certificate.spec?.secretName === application.certificateSecretName,
    `${contract.cluster}/${application.id}: Certificate secretName drifted`,
  );
  const readyConditions = (certificate.status?.conditions ?? []).filter((item) => item.type === "Ready");
  invariant(readyConditions.length === 1, `${contract.cluster}/${application.id}: Certificate must have exactly one Ready condition`);
  invariant(readyConditions[0].status === "True", `${contract.cluster}/${application.id}: Certificate is not Ready`);
  if (readyConditions[0].observedGeneration != null) {
    invariant(
      readyConditions[0].observedGeneration === certificate.metadata.generation,
      `${contract.cluster}/${application.id}: Certificate Ready condition observes a stale generation`,
    );
  }
  return Object.freeze({
    namespace: application.namespace,
    name: application.certificateName,
    uid: certificate.metadata.uid,
    secretName: application.certificateSecretName,
    ready: true,
    readyReason: readyConditions[0].reason ?? null,
    notAfter: certificate.status?.notAfter ?? null,
  });
}

function assertContract(contract) {
  invariant(KIND_TRAEFIK_CONTRACTS.includes(contract), "unknown kind Traefik contract");
}

function assertResourceIdentity(resource, apiVersion, kind, namespace, name, { live }) {
  invariant(resource?.apiVersion === apiVersion && resource?.kind === kind, `${namespace}/${name}: ${kind} GVK drifted`);
  invariant(resource.metadata?.namespace === namespace, `${namespace}/${name}: ${kind} namespace drifted`);
  invariant(resource.metadata?.name === name, `${namespace}/${name}: ${kind} name drifted`);
  invariant(resource.metadata?.deletionTimestamp == null, `${namespace}/${name}: ${kind} is terminating`);
  if (live) {
    invariant(UUID_PATTERN.test(resource.metadata?.uid ?? ""), `${namespace}/${name}: live ${kind} UID is invalid`);
    invariant(/^\d+$/.test(String(resource.metadata?.resourceVersion ?? "")), `${namespace}/${name}: live ${kind} resourceVersion is invalid`);
  }
}

function uniqueResource(resources, apiVersion, kind, namespace, name, label) {
  const matches = resources.filter(
    (item) => item?.apiVersion === apiVersion
      && item?.kind === kind
      && item?.metadata?.namespace === namespace
      && item?.metadata?.name === name,
  );
  invariant(matches.length === 1, `${label} must occur exactly once; observed ${matches.length}`);
  return matches[0];
}

function resourceItems(input) {
  if (Array.isArray(input)) return input.flatMap(resourceItems);
  if (input && typeof input === "object" && Array.isArray(input.items) && /List$/.test(input.kind ?? "List")) {
    return input.items.flatMap(resourceItems);
  }
  return input && typeof input === "object" ? [input] : [];
}

function renderedFixture(contract) {
  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "traefik", namespace: "traefik" },
      spec: { type: "NodePort", ports: contract.ports.map((item) => ({ ...item })) },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "traefik", namespace: "traefik" },
      spec: {
        template: {
          spec: {
            containers: [{
              name: "traefik",
              image: "docker.io/traefik:v3.7.6",
              args: [contract.endpointArgument, "--providers.kubernetesingress"],
            }],
          },
        },
      },
    },
  ];
}

function liveFixture(contract) {
  const resources = renderedFixture(contract);
  resources[0].metadata.uid = "11111111-1111-4111-8111-111111111111";
  resources[0].metadata.resourceVersion = "10";
  resources[0].spec.clusterIP = "10.96.0.10";
  resources[0].status = { loadBalancer: {} };
  resources[1].metadata.uid = "22222222-2222-4222-8222-222222222222";
  resources[1].metadata.resourceVersion = "20";
  for (const [index, application] of contract.applications.entries()) {
    resources.push({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: application.ingressName,
        namespace: application.namespace,
        uid: `${index + 3}${index + 3}${index + 3}${index + 3}${index + 3}${index + 3}${index + 3}${index + 3}-${index + 3}${index + 3}${index + 3}${index + 3}-4${index + 3}${index + 3}${index + 3}-8${index + 3}${index + 3}${index + 3}-${String(index + 3).repeat(12)}`,
        resourceVersion: String(30 + index),
      },
      spec: { ingressClassName: contract.ingressClassName },
      status: { loadBalancer: { ingress: [{ hostname: contract.hostname }] } },
    });
    resources.push({
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: application.certificateName,
        namespace: application.namespace,
        uid: `${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}${index + 5}-${index + 5}${index + 5}${index + 5}${index + 5}-4${index + 5}${index + 5}${index + 5}-8${index + 5}${index + 5}${index + 5}-${String(index + 5).repeat(12)}`,
        resourceVersion: String(40 + index),
        generation: 1,
      },
      spec: { secretName: application.certificateSecretName },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "Ready", observedGeneration: 1 }],
        notAfter: "2027-08-05T00:00:00Z",
      },
    });
  }
  return resources;
}

function exactFixtureResource(resources, apiVersion, kind, namespace, name) {
  return uniqueResource(resources, apiVersion, kind, namespace, name, "self-test fixture");
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

function stableJson(value) {
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
