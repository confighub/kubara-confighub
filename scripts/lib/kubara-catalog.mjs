import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { readYaml, toYaml } from "./proof-common.mjs";

export const SNAPSHOT_DIGEST_ALGORITHM =
  "sha256 of sorted '<file-sha256>  <posix-relative-path>\\n' records";

export const KUBARA_CATALOG_LINES = [
  {
    id: "kubara-v0.12.0-built-in",
    label: "Kubara v0.12.0 built-in catalog",
    repository: "https://github.com/kubara-io/kubara.git",
    commit: "ad039dd3e038c8580592b3b9134c2165a426344d",
    repositoryTree: "92cb8480e662d53906418c8c1e0b6f7bbd545f40",
    sourceSubtree: "src/internal/catalog/built-in",
    snapshotMode: "seven-service-adoption-slice",
    catalogSubtrees: [
      {
        name: "built-in",
        path: "src/internal/catalog/built-in",
        gitTree: "1df083ad7aefc36c93035d97c52379b20a4a42c9",
        version: "embedded-in-v0.12.0",
        catalogManifest: null,
      },
    ],
    snapshotTreeSha256: "31b72b264f1d0ae58cb79d5b4c11b26baf48c02b3651baa81ebf2d0f361c1f14",
    snapshotFileCount: 117,
  },
  {
    id: "kubara-catalogs-1.1.0-release",
    label: "Released kubara-io/catalogs bootstrap and general 1.1.0",
    repository: "https://github.com/kubara-io/catalogs.git",
    commit: "b451260636bba764ccdb0561d9f8f5ce414e2ee5",
    repositoryTree: "9c722d1ba28053d4b802d3c74a14fea5a343b765",
    sourceSubtree: ".",
    snapshotMode: "full-bootstrap-and-general-catalogs",
    releaseTags: ["bootstrap-1.1.0", "general-1.1.0"],
    defaultOciReferences: [
      "oci://ghcr.io/kubara-io/catalogs/bootstrap:1.1.0",
      "oci://ghcr.io/kubara-io/catalogs/general:1.1.0",
    ],
    catalogSubtrees: [
      {
        name: "bootstrap",
        path: "bootstrap",
        gitTree: "055d6d4204113290911d0dfab1697976b3c9ac21",
        version: "1.1.0",
        catalogManifest: "bootstrap/Catalog.yaml",
      },
      {
        name: "general",
        path: "general",
        gitTree: "99cc97f9f54d1094dba87dce39e53c4d6f344fff",
        version: "1.1.0",
        catalogManifest: "general/Catalog.yaml",
      },
    ],
    snapshotTreeSha256: "25470fa8da444c2eafd078e1d9daab6734afbc6fafb66d0a6a7a4f6c162a62fa",
    snapshotFileCount: 354,
  },
  {
    id: "kubara-catalogs-1.1.0-observed-head",
    label: "Observed post-tag kubara-io/catalogs head with manifests still at 1.1.0",
    repository: "https://github.com/kubara-io/catalogs.git",
    commit: "79d566dd82013ecf11beb8d1fec4ede7be069c20",
    repositoryTree: "a4e0dc903011577b26640b7e3fd61f5358e43cd4",
    sourceSubtree: ".",
    snapshotMode: "full-bootstrap-and-general-catalogs",
    releaseTags: [],
    notByteEquivalentTo: "kubara-catalogs-1.1.0-release",
    catalogSubtrees: [
      {
        name: "bootstrap",
        path: "bootstrap",
        gitTree: "ecb54cef159ea19e3015b2627180d3cc408402ac",
        version: "1.1.0",
        catalogManifest: "bootstrap/Catalog.yaml",
      },
      {
        name: "general",
        path: "general",
        gitTree: "209f06e611fea9c78367338a20f90aab3d433ae6",
        version: "1.1.0",
        catalogManifest: "general/Catalog.yaml",
      },
    ],
    snapshotTreeSha256: "a0595a03d4088c1b543400064cb8ff6f48fe3edbec688521496e54936863d4b8",
    snapshotFileCount: 354,
  },
];

export const KUBARA_SERVICE_KEYS = [
  "argocd",
  "cert-manager",
  "external-secrets",
  "homer-dashboard",
  "kube-prometheus-stack",
  "metrics-server",
  "traefik",
];

const builtIn = (chartPath, serviceFile = chartPath) => ({
  catalog: "built-in",
  serviceDefinition: `services/${serviceFile}.yaml`,
  wrapper: `platform-components/helm/${chartPath}`,
  configTemplate: `platform-configs/helm/${chartPath}/values.generated.yaml.tplt`,
});

const current = (catalog, chartPath, serviceFile = chartPath) => ({
  catalog,
  serviceDefinition: `${catalog}/services/${serviceFile}.yaml`,
  wrapper: `${catalog}/platform-components/helm/${chartPath}`,
  configTemplate: `${catalog}/platform-configs/helm/${chartPath}/values.generated.yaml.tplt`,
});

export const KUBARA_SERVICE_SPECS = {
  argocd: {
    aliases: ["argocd", "argo-cd"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("argo-cd"),
      "kubara-catalogs-1.1.0-release": current("bootstrap", "argo-cd"),
      "kubara-catalogs-1.1.0-observed-head": current("bootstrap", "argo-cd"),
    },
    upstreamDependencies: [
      {
        dependency: "argo-cd",
        canonicalIdentity: "helm:argo-cd/argo-cd",
        recipeRoot: "recipes/argo-cd/argo-cd",
        packageRoot: "packages/argo-cd/argo-cd",
      },
    ],
  },
  "cert-manager": {
    aliases: ["cert-manager"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("cert-manager"),
      "kubara-catalogs-1.1.0-release": current("general", "cert-manager"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "cert-manager"),
    },
    upstreamDependencies: [
      {
        dependency: "cert-manager",
        canonicalIdentity: "helm:jetstack/cert-manager",
        recipeRoot: "recipes/jetstack/cert-manager",
        packageRoot: "packages/jetstack/cert-manager",
      },
    ],
  },
  "external-secrets": {
    aliases: ["external-secrets"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("external-secrets"),
      "kubara-catalogs-1.1.0-release": current("general", "external-secrets"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "external-secrets"),
    },
    upstreamDependencies: [
      {
        dependency: "external-secrets",
        canonicalIdentity: "helm:external-secrets/external-secrets",
        recipeRoot: "recipes/external-secrets/external-secrets",
        packageRoot: "packages/external-secrets/external-secrets",
      },
    ],
  },
  "homer-dashboard": {
    aliases: ["homer-dashboard"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("homer-dashboard"),
      "kubara-catalogs-1.1.0-release": current("general", "homer-dashboard"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "homer-dashboard"),
    },
    upstreamDependencies: [],
    firstPartyMapping: {
      canonicalIdentity: "kubara:homer-dashboard",
      recipeRoot: "recipes/kubara/homer-dashboard",
      packageRoot: "packages/kubara/homer-dashboard",
    },
  },
  "kube-prometheus-stack": {
    aliases: ["kube-prometheus-stack"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("kube-prometheus-stack"),
      "kubara-catalogs-1.1.0-release": current("general", "kube-prometheus-stack"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "kube-prometheus-stack"),
    },
    upstreamDependencies: [
      {
        dependency: "kube-prometheus-stack",
        canonicalIdentity: "helm:prometheus-community/kube-prometheus-stack",
        recipeRoot: "recipes/prometheus-community/kube-prometheus-stack",
        packageRoot: "packages/prometheus-community/kube-prometheus-stack",
      },
      {
        dependency: "prometheus-blackbox-exporter",
        canonicalIdentity: "helm:prometheus-community/prometheus-blackbox-exporter",
        recipeRoot: "recipes/prometheus-community/prometheus-blackbox-exporter",
        packageRoot: "packages/prometheus-community/prometheus-blackbox-exporter",
      },
    ],
  },
  "metrics-server": {
    aliases: ["metrics-server"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("metrics-server"),
      "kubara-catalogs-1.1.0-release": current("general", "metrics-server"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "metrics-server"),
    },
    upstreamDependencies: [
      {
        dependency: "metrics-server",
        canonicalIdentity: "helm:metrics-server/metrics-server",
        recipeRoot: "recipes/metrics-server/metrics-server",
        packageRoot: "packages/metrics-server/metrics-server",
      },
    ],
  },
  traefik: {
    aliases: ["traefik"],
    lines: {
      "kubara-v0.12.0-built-in": builtIn("traefik"),
      "kubara-catalogs-1.1.0-release": current("general", "traefik"),
      "kubara-catalogs-1.1.0-observed-head": current("general", "traefik"),
    },
    upstreamDependencies: [
      {
        dependency: "traefik",
        canonicalIdentity: "helm:traefik/traefik",
        recipeRoot: "recipes/traefik/traefik",
        packageRoot: "packages/traefik/traefik",
      },
    ],
  },
};

export const TEMPLATE_LIBRARY_SPECS = {
  "kubara-v0.12.0-built-in": {
    catalog: "built-in",
    path: "platform-components/helm/template-library",
  },
  "kubara-catalogs-1.1.0-release": {
    catalog: "bootstrap",
    path: "bootstrap/platform-components/helm/template-library",
  },
  "kubara-catalogs-1.1.0-observed-head": {
    catalog: "bootstrap",
    path: "bootstrap/platform-components/helm/template-library",
  },
};

export const KUBARA_BOOTSTRAP_CONCERNS = {
  "bootstrap-crds": {
    role: "non-user-selectable-bootstrap-concern",
    deployable: true,
    userSelectable: false,
    lines: {
      "kubara-v0.12.0-built-in": null,
      "kubara-catalogs-1.1.0-release": {
        catalog: "bootstrap",
        serviceDefinition: "bootstrap/services/crds.yaml",
        wrapper: "bootstrap/platform-components/helm/bootstrap-crds",
      },
      "kubara-catalogs-1.1.0-observed-head": {
        catalog: "bootstrap",
        serviceDefinition: "bootstrap/services/crds.yaml",
        wrapper: "bootstrap/platform-components/helm/bootstrap-crds",
      },
    },
    upstreamDependencies: [
      KUBARA_SERVICE_SPECS["cert-manager"].upstreamDependencies[0],
      KUBARA_SERVICE_SPECS["kube-prometheus-stack"].upstreamDependencies[0],
      KUBARA_SERVICE_SPECS["external-secrets"].upstreamDependencies[0],
    ],
  },
};

export function lineById(id) {
  const line = KUBARA_CATALOG_LINES.find((candidate) => candidate.id === id);
  assert(line, `unknown Kubara catalog line: ${id}`);
  return line;
}

export function selectedPathsForLine(lineId) {
  const line = lineById(lineId);
  if (line.snapshotMode === "full-bootstrap-and-general-catalogs") {
    return line.catalogSubtrees.map((catalog) => catalog.path).sort();
  }
  const paths = [];
  for (const catalog of line.catalogSubtrees) {
    if (catalog.catalogManifest) paths.push(catalog.catalogManifest);
  }
  for (const key of KUBARA_SERVICE_KEYS) {
    const selection = KUBARA_SERVICE_SPECS[key].lines[lineId];
    paths.push(selection.serviceDefinition, selection.wrapper, selection.configTemplate);
  }
  for (const concern of Object.values(KUBARA_BOOTSTRAP_CONCERNS)) {
    const selection = concern.lines[lineId];
    if (selection) paths.push(selection.serviceDefinition, selection.wrapper);
  }
  paths.push(TEMPLATE_LIBRARY_SPECS[lineId].path);
  return [...new Set(paths)].sort();
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not supported in snapshots: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => posixRelative(root, left).localeCompare(posixRelative(root, right)));
}

export function fileRecords(root, paths = listFiles(root)) {
  return paths.map((path) => ({
    path: posixRelative(root, path),
    sha256: sha256File(path),
    bytes: statSync(path).size,
  }));
}

export function checksumText(records) {
  return records.map((record) => `${record.sha256}  ${record.path}\n`).join("");
}

export function treeSummary(root, predicate = () => true) {
  const records = fileRecords(root).filter((record) => predicate(record.path));
  const manifest = checksumText(records);
  return {
    fileCount: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    treeSha256: sha256(manifest),
    records,
    checksumText: manifest,
  };
}

export function pathsSummary(root, relativePaths) {
  const files = [];
  for (const relativePath of relativePaths) {
    const absolutePath = join(root, relativePath);
    assert(existsSync(absolutePath), `missing selected snapshot input: ${absolutePath}`);
    if (lstatSync(absolutePath).isDirectory()) files.push(...listFiles(absolutePath));
    else files.push(absolutePath);
  }
  const unique = [...new Set(files.map((path) => resolve(path)))].sort((left, right) =>
    posixRelative(root, left).localeCompare(posixRelative(root, right)),
  );
  const records = fileRecords(root, unique);
  const manifest = checksumText(records);
  return {
    fileCount: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    treeSha256: sha256(manifest),
    records,
    checksumText: manifest,
  };
}

export function copySelectedPaths(sourceRoot, destinationRoot, relativePaths) {
  mkdirSync(destinationRoot, { recursive: true });
  for (const relativePath of relativePaths) {
    const source = join(sourceRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    assert(existsSync(source), `missing pinned Kubara source path: ${source}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, preserveTimestamps: false });
  }
}

export function replaceOwnedDirectory(path, ownerRoot) {
  assertOwnedPath(path, ownerRoot);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

export function assertOwnedPath(path, ownerRoot) {
  const resolvedPath = resolve(path);
  const resolvedOwner = resolve(ownerRoot);
  assert(
    resolvedPath !== resolvedOwner && resolvedPath.startsWith(`${resolvedOwner}${sep}`),
    `refusing to replace path outside owned root: ${resolvedPath}`,
  );
}

export function compareTrees(sourceRoot, exportRoot) {
  const source = treeSummary(sourceRoot);
  const exported = treeSummary(exportRoot);
  const sourceMap = new Map(source.records.map((record) => [record.path, record]));
  const exportMap = new Map(exported.records.map((record) => [record.path, record]));
  const missing = source.records.filter((record) => !exportMap.has(record.path)).map((record) => record.path);
  const extra = exported.records.filter((record) => !sourceMap.has(record.path)).map((record) => record.path);
  const changed = source.records
    .filter((record) => exportMap.has(record.path) && exportMap.get(record.path).sha256 !== record.sha256)
    .map((record) => record.path);
  return {
    source,
    exported,
    missing,
    extra,
    changed,
    byteForByte: missing.length === 0 && extra.length === 0 && changed.length === 0,
  };
}

export function fileRecord(root, relativePath) {
  const path = join(root, relativePath);
  assert(existsSync(path), `missing catalog file: ${path}`);
  return {
    path: relativePath,
    sha256: sha256File(path),
    bytes: statSync(path).size,
  };
}

export function chartFacts(snapshotRoot, wrapperPath) {
  const chartPath = join(snapshotRoot, wrapperPath, "Chart.yaml");
  const chart = readYaml(chartPath);
  return {
    name: String(chart.name),
    version: String(chart.version),
    dependencies: (chart.dependencies ?? []).map((dependency) => ({
      name: String(dependency.name),
      version: String(dependency.version),
      repository: String(dependency.repository),
    })),
  };
}

export function yamlText(value) {
  return `---\n${toYaml(value)}\n`;
}

export function writeYaml(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlText(value));
}

export function posixRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}
