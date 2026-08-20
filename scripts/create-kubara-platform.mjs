#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { readYaml, repoRoot, write, writeYaml } from "./lib/proof-common.mjs";

const ALL_SERVICES = [
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
const DEFAULT_SERVICES = ["cert-manager", "metrics-server", "traefik"];
const SERVICE_COMPONENTS = {
  argocd: "argo-cd/argo-cd",
  "cert-manager": "jetstack/cert-manager",
  "external-dns": "external-dns/external-dns",
  "external-secrets": "external-secrets/external-secrets",
  "kube-prometheus-stack": "prometheus-community/kube-prometheus-stack",
  kyverno: "kyverno/kyverno",
  "kyverno-policies": "kyverno/kyverno-policies",
  "kyverno-policy-reporter": "policy-reporter/policy-reporter",
  loki: "grafana/loki",
  longhorn: "longhorn/longhorn",
  metallb: "metallb/metallb",
  "metrics-server": "metrics-server/metrics-server",
  "oauth2-proxy": "oauth2-proxy/oauth2-proxy",
  reloader: "stakater/reloader",
  traefik: "traefik/traefik",
  velero: "velero/velero",
};
const CONFIG_WORKSHOP = "https://confighub.github.io/helm-expt/site";
const CATALOG_OCI = "oci://europe-west1-docker.pkg.dev/nth-fort-499605-q5/helm-expt";
const exampleRoot = join(repoRoot, "examples", "kubara", "starter-platform");

const first = process.argv[2] ?? "";
if (first === "--generate-example") {
  generate(exampleRoot, exampleOptions(), true);
  verifyExample();
  console.log(`generated ${relative(repoRoot, exampleRoot)}`);
} else if (first === "--verify-example") {
  verifyExample();
  console.log("verified deterministic Kubara starter platform");
} else if (first === "--self-test") {
  selfTest();
  console.log("Kubara platform starter self-test: pass");
} else {
  const options = parseOptions(process.argv.slice(2));
  if (!options.output) usage("--output is required");
  generate(resolve(options.output), options, options.force);
  console.log(`Created ${resolve(options.output)}`);
  console.log(`Next: review ${join(resolve(options.output), "config.yaml")}`);
}

function exampleOptions() {
  return {
    name: "workshop-platform",
    cluster: "workshop-dev",
    repository: "https://github.com/example/platform.git",
    dnsSuffix: "traefik.me",
    email: "platform@example.com",
    services: DEFAULT_SERVICES,
    output: exampleRoot,
    force: true,
  };
}

function parseOptions(args) {
  const options = {
    name: "my-platform",
    cluster: "",
    repository: "",
    dnsSuffix: "traefik.me",
    email: "platform@example.com",
    services: DEFAULT_SERVICES,
    output: "",
    force: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    const key = {
      "--name": "name",
      "--cluster": "cluster",
      "--repository": "repository",
      "--dns-suffix": "dnsSuffix",
      "--email": "email",
      "--services": "services",
      "--output": "output",
    }[argument];
    if (!key) usage(`unknown option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} needs a value`);
    options[key] = key === "services" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value;
    index += 1;
  }
  options.cluster ||= `${options.name}-dev`;
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  for (const [label, value] of [["name", options.name], ["cluster", options.cluster]]) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
      throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
    }
  }
  if (!options.repository || !/^https:\/\/[^\s]+$/.test(options.repository)) {
    throw new Error("--repository must be an HTTPS Git URL");
  }
  if (!/^[a-z0-9.-]+$/i.test(options.dnsSuffix)) throw new Error("--dns-suffix is invalid");
  if (!/^[^@\s]+@[^@\s]+$/.test(options.email)) throw new Error("--email is invalid");
  const unknown = options.services.filter((service) => !ALL_SERVICES.includes(service));
  if (unknown.length > 0) throw new Error(`unknown Kubara service(s): ${unknown.join(", ")}`);
}

function generate(outputRoot, options, force) {
  validateOptions(options);
  prepareOutput(outputRoot, force);
  const sourceLock = readYaml(join(repoRoot, "examples", "kubara", "current-platform", "source-lock.yaml"));
  const artifactRegistry = readYaml(
    join(repoRoot, "data", "kubara-catalog-1.1-full-coverage", "exact-artifact-registry.yaml"),
  );
  const artifacts = new Map(
    (artifactRegistry.spec?.artifacts ?? []).map((artifact) => [artifact.canonicalIdentity, artifact]),
  );
  const config = buildConfig(options, sourceLock);
  writeYaml(join(outputRoot, "config.yaml"), config);
  write(join(outputRoot, ".env.example"), environmentExample(options));
  const configSha256 = sha256(readFileSync(join(outputRoot, "config.yaml")));
  const intent = buildIntent(options, sourceLock, artifacts, configSha256);
  writeYaml(join(outputRoot, "source-and-intent.yaml"), intent);
  write(join(outputRoot, "README.md"), starterReadme(options));
  writeChecksums(outputRoot);
}

function buildConfig(options, sourceLock) {
  const enabled = new Set(options.services);
  const services = Object.fromEntries(
    ALL_SERVICES.map((service) => {
      const selection = { status: enabled.has(service) ? "enabled" : "disabled" };
      if (service === "cert-manager" && enabled.has(service)) {
        selection.config = {
          clusterIssuer: {
            email: options.email,
            name: "letsencrypt-staging",
            server: "https://acme-staging-v02.api.letsencrypt.org/directory",
          },
        };
      }
      return [service, selection];
    }),
  );
  return {
    version: "v1alpha4",
    bootstrapCatalog: sourceLock.spec.catalogs.publicReferences.bootstrap,
    clusters: [
      {
        name: options.cluster,
        stage: "dev",
        type: "hub",
        dnsName: `${options.cluster}.${options.dnsSuffix}`,
        ssoOrg: "none",
        ssoTeam: "none",
        ingressClassName: "traefik",
        argocd: {
          selfManaged: "enabled",
          repo: {
            https: {
              configs: { url: options.repository, targetRevision: "main" },
              components: { url: options.repository, targetRevision: "main" },
            },
          },
        },
        catalogs: [sourceLock.spec.catalogs.publicReferences.general],
        services,
      },
    ],
  };
}

function buildIntent(options, sourceLock, artifacts, configSha256) {
  const selected = ["argocd", ...options.services];
  const components = selected.map((service) => {
    const identity = SERVICE_COMPONENTS[service];
    if (!identity) {
      return {
        service,
        source: "kubara-first-party",
        catalogMatch: { status: "not-an-external-chart", review: "Review the generated Kubara files." },
      };
    }
    const artifact = artifacts.get(identity);
    if (!artifact) throw new Error(`exact artifact missing for ${identity}`);
    const pageSlug = slug(`${identity}-${artifact.version}`);
    return {
      service,
      source: "helm",
      canonicalIdentity: identity,
      version: String(artifact.version),
      exactArtifact: artifact.exactArtifact,
      catalogMatch: {
        status: artifact.catalogState,
        chartPage: `${CONFIG_WORKSHOP}/charts/${pageSlug}.html`,
        baseVariantRecords: `${CONFIG_WORKSHOP}/base-variant-records.json`,
        packageOciRef: `${CATALOG_OCI}/${identity.replaceAll("/", "-")}:${artifact.version}`,
        role: "Reference package for the component. Kubara remains the platform composer.",
      },
    };
  });
  return {
    apiVersion: "workshop.confighub.com/v1alpha1",
    kind: "KubaraPlatformSourceAndIntent",
    metadata: { name: options.name },
    spec: {
      source: {
        type: "kubara",
        repository: sourceLock.spec.kubara.repository,
        version: sourceLock.spec.kubara.version,
        commit: sourceLock.spec.kubara.commit,
        config: "config.yaml",
        configSha256: `sha256:${configSha256}`,
      },
      catalogs: {
        version: String(sourceLock.spec.catalogs.version),
        repository: sourceLock.spec.catalogs.repository,
        commit: sourceLock.spec.catalogs.commit,
        bootstrap: sourceLock.spec.catalogs.publicReferences.bootstrap,
        general: sourceLock.spec.catalogs.publicReferences.general,
      },
      intent: {
        platform: options.name,
        cluster: { name: options.cluster, stage: "dev", type: "hub" },
        enabledServices: options.services,
        repository: options.repository,
      },
      components,
      lifecycleReview: {
        status: "required-after-generation",
        check: [
          "List every generated CRD and decide who owns and applies it first.",
          "List every Helm hook or setup Job and record how it will run and how success will be checked.",
          "List required Secrets, certificate issuers, storage classes, APIs, and other target facts.",
          "Do not call the platform deployable until these checks have evidence for the intended target.",
        ],
      },
      output: {
        status: "not-generated",
        command: "kubara --work-dir . --config-file config.yaml --env-file .env generate --helm",
        expected: ["platform-components/", "platform-configs/"],
      },
      next: {
        inspect: `${CONFIG_WORKSHOP}/ask.html`,
        promote: `${CONFIG_WORKSHOP}/promote.html`,
        kubaraWithConfigHub: `${CONFIG_WORKSHOP}/kubara.html`,
      },
    },
    status: {
      phase: "ready-to-generate",
      claim: "The Kubara input and exact component versions are recorded. No generated or live result is claimed yet.",
    },
  };
}

function environmentExample(options) {
  return [
    `PROJECT_NAME=${options.cluster}`,
    "PROJECT_STAGE=dev",
    "ARGOCD_WIZARD_ACCOUNT_PASSWORD=replace-before-use",
    `ARGOCD_GIT_HTTPS_URL=${options.repository}`,
    "ARGOCD_GIT_USERNAME=",
    "ARGOCD_GIT_PAT_OR_PASSWORD=",
    "ARGOCD_HELM_REPO_USERNAME=",
    "ARGOCD_HELM_REPO_PASSWORD=",
    "ARGOCD_HELM_REPO_URL=",
    "DOCKERCONFIG_BASE64=",
    "",
  ].join("\n");
}

function starterReadme(options) {
  return `# ${options.name}

This folder is a small starting point for one Kubara development platform.
Kubara still chooses and generates the platform. Config Workshop records the
exact component versions and links each one to its checked Catalog material.

## 1. Review the platform choice

Open \`config.yaml\`. It defines one hub cluster, ${options.cluster}, and enables
${options.services.join(", ")}. Every other built-in service is disabled explicitly,
so a future catalog default cannot add a component without a visible diff.

Open \`source-and-intent.yaml\` next. It records the Kubara and catalog versions,
the exact Helm components selected by Kubara, and the Config Workshop pages for
their configurations and evidence. Kubara does not read this companion file.

## 2. Generate the platform

Review \`.env.example\`, create a private \`.env\`, and replace every placeholder.
Do not commit credentials.

\`\`\`sh
kubara --work-dir . --config-file config.yaml --env-file .env generate --helm
\`\`\`

Kubara writes \`platform-components/\` and \`platform-configs/\`. Review that output
before committing it.

## 3. Check what must happen around the YAML

List the generated CRDs, Helm hooks, setup Jobs, Secrets, certificate issuers,
storage classes, and required APIs. Decide who owns each one and how success will
be checked. The component links in \`source-and-intent.yaml\` show the matching
Config Workshop investigations, but the final answer must match this generated
platform and its target cluster.

## 4. Keep and promote the reviewed result

Commit the complete generated hand-off to Git. You can then package the exact
revision as OCI and load it into ConfigHub without changing Kubara's role.
ConfigHub adds retained versions, diffs, approvals, promotion, releases, and fleet
status. Argo CD remains the cluster reconciler.

Start with the [Kubara and ConfigHub tutorial](${CONFIG_WORKSHOP}/kubara.html).
`;
}

function prepareOutput(outputRoot, force) {
  if (existsSync(outputRoot)) {
    const entries = readdirSync(outputRoot);
    if (entries.length > 0 && !force) {
      throw new Error(`${outputRoot} is not empty; choose another directory or pass --force`);
    }
    if (force) rmSync(outputRoot, { recursive: true, force: true });
  }
  mkdirSync(outputRoot, { recursive: true });
}

function writeChecksums(outputRoot) {
  const files = listFiles(outputRoot).filter((path) => basename(path) !== "checksums.txt");
  const lines = files.map((path) => `${sha256(readFileSync(path))}  ${relative(outputRoot, path)}`);
  write(join(outputRoot, "checksums.txt"), `${lines.join("\n")}\n`);
}

function verifyExample() {
  if (!existsSync(exampleRoot)) throw new Error("starter example is missing; run --generate-example");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kubara-platform-starter-"));
  try {
    const expectedRoot = join(temporaryRoot, "expected");
    generate(expectedRoot, exampleOptions(), true);
    compareTrees(expectedRoot, exampleRoot);
    const config = readYaml(join(exampleRoot, "config.yaml"));
    const intent = readYaml(join(exampleRoot, "source-and-intent.yaml"));
    if (config.version !== "v1alpha4") throw new Error("starter config version changed");
    if (config.clusters?.length !== 1) throw new Error("starter must contain one cluster");
    if (intent.status?.phase !== "ready-to-generate") throw new Error("starter overstates its status");
    if (intent.spec?.lifecycleReview?.status !== "required-after-generation") {
      throw new Error("starter lifecycle review is missing");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function selfTest() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kubara-platform-starter-test-"));
  try {
    const firstRoot = join(temporaryRoot, "first");
    const secondRoot = join(temporaryRoot, "second");
    generate(firstRoot, exampleOptions(), true);
    generate(secondRoot, exampleOptions(), true);
    compareTrees(firstRoot, secondRoot);
    let refusedUnknown = false;
    try {
      validateOptions({ ...exampleOptions(), services: ["made-up-service"] });
    } catch {
      refusedUnknown = true;
    }
    if (!refusedUnknown) throw new Error("unknown services were not refused");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function compareTrees(expectedRoot, actualRoot) {
  const expected = listFiles(expectedRoot).map((path) => relative(expectedRoot, path));
  const actual = listFiles(actualRoot).map((path) => relative(actualRoot, path));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("starter file list changed");
  for (const path of expected) {
    const expectedBytes = readFileSync(join(expectedRoot, path));
    const actualBytes = readFileSync(join(actualRoot, path));
    if (!expectedBytes.equals(actualBytes)) throw new Error(`starter file changed: ${path}`);
  }
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...listFiles(path));
    else result.push(path);
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/create-kubara-platform.mjs --name <name> --repository <https-url> --output <dir> [--cluster <name>] [--services a,b,c] [--dns-suffix <domain>] [--email <address>] [--force]",
  );
  process.exit(2);
}
