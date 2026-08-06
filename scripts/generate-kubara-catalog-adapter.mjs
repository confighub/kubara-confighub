#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import {
  KUBARA_BOOTSTRAP_CONCERNS,
  KUBARA_CATALOG_LINES,
  KUBARA_SERVICE_KEYS,
  KUBARA_SERVICE_SPECS,
  SNAPSHOT_DIGEST_ALGORITHM,
  TEMPLATE_LIBRARY_SPECS,
  assert,
  chartFacts,
  compareTrees,
  copySelectedPaths,
  fileRecord,
  lineById,
  pathsSummary,
  replaceOwnedDirectory,
  selectedPathsForLine,
  sha256File,
  treeSummary,
  writeYaml,
} from "./lib/kubara-catalog.mjs";
import { readYaml, repoRoot } from "./lib/proof-common.mjs";

const mode = process.argv[2] ?? "--verify";
if (!["--refresh-snapshots", "--generate", "--verify"].includes(mode)) {
  console.error(
    "Usage: node scripts/generate-kubara-catalog-adapter.mjs [--refresh-snapshots|--generate|--verify]",
  );
  process.exit(1);
}

const snapshotsRoot = join(repoRoot, "data", "kubara-catalog-snapshots");
const profilesRoot = join(repoRoot, "data", "kubara-compatibility-profiles");
const adapterRoot = join(repoRoot, "data", "kubara-catalog-adapter");
const configPath = join(repoRoot, "examples", "kubara", "local-platform", "source", "config.yaml");
const candidateLanes = [
  {
    name: "kubara-current-catalog-candidates",
    root: join(repoRoot, "data", "kubara-catalog-refresh", "current-candidates"),
  },
  {
    name: "kubara-v0.12.0-candidates",
    root: join(repoRoot, "data", "kubara-catalog-refresh", "candidates"),
  },
];
const releaseLineId = "kubara-catalogs-1.1.0-release";
const observedLineId = "kubara-catalogs-1.1.0-observed-head";
const builtInLineId = "kubara-v0.12.0-built-in";

const expectedCurrentVersionDeltasNotInRoot = [];

if (mode === "--refresh-snapshots") {
  refreshSnapshots();
  generate();
}
if (mode === "--generate") generate();
verify();

console.log(
  `${mode === "--verify" ? "verified" : "generated and verified"} deterministic Kubara catalog adapter for ${KUBARA_CATALOG_LINES.length} immutable source line(s)`,
);

function refreshSnapshots() {
  mkdirSync(snapshotsRoot, { recursive: true });
  for (const line of KUBARA_CATALOG_LINES) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), `helm-expt-${line.id}-`));
    const checkoutRoot = join(temporaryRoot, "checkout");
    try {
      run("git", ["init", "--quiet", checkoutRoot]);
      run("git", ["-C", checkoutRoot, "remote", "add", "origin", line.repository]);
      run("git", ["-C", checkoutRoot, "fetch", "--quiet", "--depth=1", "origin", line.commit]);
      run("git", ["-C", checkoutRoot, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);

      const head = git(checkoutRoot, ["rev-parse", "HEAD"]);
      const repositoryTree = git(checkoutRoot, ["rev-parse", "HEAD^{tree}"]);
      assert(head === line.commit, `${line.id} resolved ${head}, expected ${line.commit}`);
      assert(
        repositoryTree === line.repositoryTree,
        `${line.id} repository tree is ${repositoryTree}, expected ${line.repositoryTree}`,
      );
      for (const catalog of line.catalogSubtrees) {
        const tree = git(checkoutRoot, ["rev-parse", `HEAD:${catalog.path}`]);
        assert(tree === catalog.gitTree, `${line.id}/${catalog.name} tree is ${tree}, expected ${catalog.gitTree}`);
      }
      for (const tag of line.releaseTags ?? []) {
        run("git", [
          "-C",
          checkoutRoot,
          "fetch",
          "--quiet",
          "--depth=1",
          "origin",
          `refs/tags/${tag}:refs/tags/${tag}`,
        ]);
        const tagCommit = git(checkoutRoot, ["rev-list", "-n", "1", tag]);
        assert(tagCommit === line.commit, `${tag} resolves ${tagCommit}, expected ${line.commit}`);
      }

      const lineRoot = join(snapshotsRoot, line.id);
      replaceOwnedDirectory(lineRoot, snapshotsRoot);
      const sourceRoot = join(lineRoot, "source");
      const upstreamSourceRoot = join(checkoutRoot, line.sourceSubtree);
      copySelectedPaths(upstreamSourceRoot, sourceRoot, selectedPathsForLine(line.id));
      cpSync(join(checkoutRoot, "LICENSE"), join(lineRoot, "UPSTREAM_LICENSE"));

      const summary = treeSummary(sourceRoot);
      if (line.snapshotTreeSha256) {
        assert(
          summary.treeSha256 === line.snapshotTreeSha256,
          `${line.id} selected source tree changed: ${summary.treeSha256}`,
        );
      }
      if (line.snapshotFileCount !== null) {
        assert(summary.fileCount === line.snapshotFileCount, `${line.id} selected source file count changed`);
      }
      writeFileSync(join(lineRoot, "checksums.txt"), summary.checksumText);
      writeYaml(join(lineRoot, "provenance.yaml"), snapshotProvenance(line, summary, lineRoot));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function generate() {
  verifySnapshots();
  materializeOutputs(adapterRoot, profilesRoot);
}

function verify() {
  verifySnapshots();
  verifyOutputs();
}

function verifySnapshots() {
  assert(existsSync(configPath), `missing Kubara platform selection: ${relative(repoRoot, configPath)}`);
  const expectedEntries = new Set(["README.md", ...KUBARA_CATALOG_LINES.map((line) => line.id)]);
  const actualEntries = readdirSync(snapshotsRoot).filter((entry) => !entry.startsWith("."));
  for (const entry of actualEntries) assert(expectedEntries.has(entry), `unexpected snapshot entry: ${entry}`);
  for (const entry of expectedEntries) {
    assert(existsSync(join(snapshotsRoot, entry)), `missing snapshot entry: ${entry}`);
  }

  for (const line of KUBARA_CATALOG_LINES) {
    assert(line.snapshotTreeSha256, `${line.id} is missing its offline selected-tree lock`);
    assert(line.snapshotFileCount !== null, `${line.id} is missing its offline selected-file-count lock`);
    const lineRoot = snapshotLineRoot(line.id);
    const sourceRoot = join(lineRoot, "source");
    const summary = treeSummary(sourceRoot);
    assert(summary.fileCount === line.snapshotFileCount, `${line.id} snapshot file count changed`);
    assert(summary.treeSha256 === line.snapshotTreeSha256, `${line.id} snapshot tree digest changed`);
    assert(
      readFileSync(join(lineRoot, "checksums.txt"), "utf8") === summary.checksumText,
      `${line.id} checksum manifest changed`,
    );
    const provenance = readYaml(join(lineRoot, "provenance.yaml"));
    assert(provenance.kind === "KubaraCatalogSnapshot", `${line.id} provenance kind changed`);
    assert(provenance.spec?.source?.commit === line.commit, `${line.id} provenance commit changed`);
    assert(
      provenance.spec?.source?.repositoryTree === line.repositoryTree,
      `${line.id} provenance repository tree changed`,
    );
    assert(provenance.spec?.snapshot?.treeSha256 === summary.treeSha256, `${line.id} provenance tree changed`);
    assert(provenance.spec?.snapshot?.fileCount === summary.fileCount, `${line.id} provenance count changed`);
    assert(
      provenance.spec?.license?.sha256 === sha256File(join(lineRoot, "UPSTREAM_LICENSE")),
      `${line.id} license digest changed`,
    );
    verifyCatalogManifests(line, sourceRoot);
  }

  const releaseRoot = join(snapshotLineRoot(releaseLineId), "source");
  const observedRoot = join(snapshotLineRoot(observedLineId), "source");
  const comparison = compareTrees(releaseRoot, observedRoot);
  assert(!comparison.byteForByte, "observed catalogs head must not be described as the released 1.1.0 bytes");
}

function verifyCatalogManifests(line, sourceRoot) {
  for (const catalog of line.catalogSubtrees) {
    if (!catalog.catalogManifest) continue;
    const manifest = readYaml(join(sourceRoot, catalog.catalogManifest));
    assert(manifest.kind === "Catalog", `${line.id}/${catalog.name} manifest kind changed`);
    assert(String(manifest.spec?.version) === catalog.version, `${line.id}/${catalog.name} version changed`);
    assert(manifest.metadata?.name === catalog.name, `${line.id}/${catalog.name} manifest name changed`);
  }
}

function materializeOutputs(destinationAdapterRoot, destinationProfilesRoot) {
  mkdirSync(destinationAdapterRoot, { recursive: true });
  mkdirSync(destinationProfilesRoot, { recursive: true });
  const exportsRoot = join(destinationAdapterRoot, "exports");
  const serviceProfilesRoot = join(destinationProfilesRoot, "services");
  replaceOwnedDirectory(exportsRoot, destinationAdapterRoot);
  replaceOwnedDirectory(serviceProfilesRoot, destinationProfilesRoot);

  for (const line of KUBARA_CATALOG_LINES) {
    const sourceRoot = join(snapshotLineRoot(line.id), "source");
    const exportRoot = join(exportsRoot, line.id);
    cpSync(sourceRoot, exportRoot, { recursive: true, preserveTimestamps: false });
  }

  const profiles = KUBARA_SERVICE_KEYS.map((key) => buildServiceProfile(key));
  for (const profile of profiles) {
    writeYaml(join(serviceProfilesRoot, `${profile.metadata.name}.yaml`), profile);
  }
  const templateLibrary = buildTemplateLibraryProfile();
  const bootstrapConcerns = Object.keys(KUBARA_BOOTSTRAP_CONCERNS).map((key) =>
    buildBootstrapConcernProfile(key),
  );
  writeYaml(join(destinationProfilesRoot, "template-library.yaml"), templateLibrary);
  for (const profile of bootstrapConcerns) {
    writeYaml(join(destinationProfilesRoot, `${profile.metadata.name}.yaml`), profile);
  }

  const currentVersionDeltasNotInRoot = versionDeltasNotInRoot(profiles, releaseLineId, builtInLineId);
  assert(
    JSON.stringify(currentVersionDeltasNotInRoot) === JSON.stringify(expectedCurrentVersionDeltasNotInRoot),
    `current Kubara version deltas outside the ConfigHub root changed: ${currentVersionDeltasNotInRoot.join(", ")}`,
  );
  const observedVersionDeltasNotInRoot = versionDeltasNotInRoot(profiles, observedLineId, builtInLineId);
  assert(
    JSON.stringify(observedVersionDeltasNotInRoot) === JSON.stringify(expectedCurrentVersionDeltasNotInRoot),
    "released and observed catalog lines disagree on their version deltas outside the ConfigHub root",
  );
  const passthroughServices = buildPassthroughServices();

  writeYaml(
    join(destinationProfilesRoot, "index.yaml"),
    buildProfileIndex(
      profiles,
      templateLibrary,
      bootstrapConcerns,
      passthroughServices,
      currentVersionDeltasNotInRoot,
    ),
  );
  writeYaml(
    join(destinationAdapterRoot, "adapter-output.yaml"),
    buildAdapterOutput(
      profiles,
      bootstrapConcerns,
      passthroughServices,
      currentVersionDeltasNotInRoot,
    ),
  );
  writeYaml(
    join(destinationAdapterRoot, "receipt.yaml"),
    buildAdapterReceipt(exportsRoot, passthroughServices, currentVersionDeltasNotInRoot),
  );
}

function verifyOutputs() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "helm-expt-kubara-adapter-verify-"));
  const expectedAdapterRoot = join(temporaryRoot, "adapter");
  const expectedProfilesRoot = join(temporaryRoot, "profiles");
  try {
    mkdirSync(expectedAdapterRoot, { recursive: true });
    mkdirSync(expectedProfilesRoot, { recursive: true });
    cpReadme(adapterRoot, expectedAdapterRoot);
    cpReadme(profilesRoot, expectedProfilesRoot);
    materializeOutputs(expectedAdapterRoot, expectedProfilesRoot);

    const adapterComparison = compareTrees(expectedAdapterRoot, adapterRoot);
    assertTreeParity(adapterComparison, "Kubara catalog adapter output");
    const profileComparison = compareTrees(expectedProfilesRoot, profilesRoot);
    assertTreeParity(profileComparison, "Kubara compatibility profiles");

    const receipt = readYaml(join(adapterRoot, "receipt.yaml"));
    assert(receipt.kind === "KubaraCatalogAdapterReceipt", "adapter receipt kind changed");
    assert(receipt.spec?.invariants?.liveWrites === false, "adapter receipt must prohibit live writes");
    assert(receipt.spec?.invariants?.aiRequired === false, "adapter receipt must not require AI");
    assert(receipt.spec?.invariants?.rootCatalogPromotion === false, "adapter must not promote root entries");
    assert(
      receipt.spec?.sourceExportParity?.every((entry) => entry.byteForByte === true),
      "adapter receipt contains a non-parity source/export line",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function buildServiceProfile(key) {
  const service = KUBARA_SERVICE_SPECS[key];
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCompatibilityProfile",
    metadata: { name: key },
    spec: {
      kubaraServiceKey: key,
      aliases: service.aliases,
      sourceLines: KUBARA_CATALOG_LINES.map((line) => buildServiceLineProfile(key, line)),
      contract: {
        serviceDefinition: "retained-byte-for-byte",
        wrapper: "retained-byte-for-byte",
        configTemplate: "retained-byte-for-byte",
        platformSpecialization: "remains-a-separate-config-step",
        aiRequired: false,
      },
    },
  };
}

function buildServiceLineProfile(key, line) {
  const service = KUBARA_SERVICE_SPECS[key];
  const selection = service.lines[line.id];
  const root = join(snapshotLineRoot(line.id), "source");
  const serviceDefinition = readYaml(join(root, selection.serviceDefinition));
  const chart = chartFacts(root, selection.wrapper);
  const serviceSlice = pathsSummary(root, [
    selection.serviceDefinition,
    selection.wrapper,
    selection.configTemplate,
  ]);
  const sourceCatalog = line.catalogSubtrees.find((catalog) => catalog.name === selection.catalog);
  assert(sourceCatalog, `missing ${line.id}/${selection.catalog} catalog metadata`);

  const upstreamComponents = service.upstreamDependencies.map((mapping) => {
    const dependency = chart.dependencies.find((candidate) => candidate.name === mapping.dependency);
    assert(dependency, `${line.id}/${key} does not contain dependency ${mapping.dependency}`);
    return {
      canonicalIdentity: mapping.canonicalIdentity,
      chartDependency: dependency,
      configHub: configHubAvailability(mapping, dependency.version),
    };
  });

  const firstParty = service.firstPartyMapping
    ? {
        canonicalIdentity: service.firstPartyMapping.canonicalIdentity,
        version: chart.version,
        configHub: configHubAvailability(service.firstPartyMapping, chart.version),
      }
    : null;
  const templateDependency = chart.dependencies.find((dependency) => dependency.name === "template-library");
  assert(templateDependency, `${line.id}/${key} must retain its template-library dependency`);

  return {
    id: line.id,
    provenance: {
      repository: line.repository,
      commit: line.commit,
      repositoryTree: line.repositoryTree,
      releaseTags: line.releaseTags ?? [],
      distributionStatus: distributionStatus(line.id),
    },
    sourceCatalog: {
      name: sourceCatalog.name,
      version: sourceCatalog.version,
      manifest: sourceCatalog.catalogManifest
        ? fileRecord(root, sourceCatalog.catalogManifest)
        : { status: "absent-in-upstream-built-in-layout" },
    },
    serviceDefinition: {
      ...fileRecord(root, selection.serviceDefinition),
      apiVersion: serviceDefinition.apiVersion,
      kind: serviceDefinition.kind,
      name: serviceDefinition.metadata?.name,
      category: serviceDefinition.metadata?.annotations?.["kubara.io/category"] ?? null,
      chartPath: serviceDefinition.spec?.chartPath,
      defaultStatus: serviceDefinition.spec?.status,
      clusterTypes: serviceDefinition.spec?.clusterTypes ?? [],
    },
    wrapper: {
      path: selection.wrapper,
      chartYaml: fileRecord(root, `${selection.wrapper}/Chart.yaml`),
      name: chart.name,
      version: chart.version,
      tree: compactTree(treeSummary(join(root, selection.wrapper))),
    },
    configTemplate: fileRecord(root, selection.configTemplate),
    serviceSliceTree: compactTree(serviceSlice),
    snapshotSelectionTreeSha256: line.snapshotTreeSha256,
    templateLibraryDependency: templateDependency,
    upstreamComponents,
    firstPartyComponent: firstParty,
  };
}

function buildTemplateLibraryProfile() {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCompatibilityProfile",
    metadata: { name: "template-library" },
    spec: {
      kubaraServiceKey: "template-library",
      role: "nondeployable-shared-build-dependency",
      deployable: false,
      sourceLines: KUBARA_CATALOG_LINES.map((line) => {
        const sourceRoot = join(snapshotLineRoot(line.id), "source");
        const selection = TEMPLATE_LIBRARY_SPECS[line.id];
        const chart = chartFacts(sourceRoot, selection.path);
        assert(chart.name === "template-library", `${line.id} template library chart name changed`);
        return {
          id: line.id,
          catalog: selection.catalog,
          path: selection.path,
          version: chart.version,
          chartYaml: fileRecord(sourceRoot, `${selection.path}/Chart.yaml`),
          tree: compactTree(treeSummary(join(sourceRoot, selection.path))),
          configHub: {
            mappingStatus: "source-locked-build-dependency",
            deployableUnit: false,
          },
        };
      }),
    },
  };
}

function buildBootstrapConcernProfile(key) {
  const concern = KUBARA_BOOTSTRAP_CONCERNS[key];
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraBootstrapCompatibilityProfile",
    metadata: { name: key },
    spec: {
      role: concern.role,
      deployable: concern.deployable,
      userSelectable: concern.userSelectable,
      platformRoleCounted: false,
      sourceLines: KUBARA_CATALOG_LINES.map((line) => {
        const selection = concern.lines[line.id];
        if (!selection) {
          return {
            id: line.id,
            status: "not-present-as-a-separate-bootstrap-service-in-this-source-line",
          };
        }
        const sourceRoot = join(snapshotLineRoot(line.id), "source");
        const serviceDefinition = readYaml(join(sourceRoot, selection.serviceDefinition));
        const chart = chartFacts(sourceRoot, selection.wrapper);
        const upstreamComponents = concern.upstreamDependencies.map((mapping) => {
          const dependency = chart.dependencies.find((candidate) => candidate.name === mapping.dependency);
          assert(dependency, `${line.id}/${key} does not contain dependency ${mapping.dependency}`);
          return {
            canonicalIdentity: mapping.canonicalIdentity,
            chartDependency: dependency,
            configHub: configHubAvailability(mapping, dependency.version),
          };
        });
        return {
          id: line.id,
          status: "present",
          provenance: {
            repository: line.repository,
            commit: line.commit,
            repositoryTree: line.repositoryTree,
            releaseTags: line.releaseTags ?? [],
            distributionStatus: distributionStatus(line.id),
          },
          serviceDefinition: {
            ...fileRecord(sourceRoot, selection.serviceDefinition),
            apiVersion: serviceDefinition.apiVersion,
            kind: serviceDefinition.kind,
            name: serviceDefinition.metadata?.name,
            chartPath: serviceDefinition.spec?.chartPath,
            defaultStatus: serviceDefinition.spec?.status,
            clusterTypes: serviceDefinition.spec?.clusterTypes ?? [],
          },
          wrapper: {
            path: selection.wrapper,
            chartYaml: fileRecord(sourceRoot, `${selection.wrapper}/Chart.yaml`),
            name: chart.name,
            version: chart.version,
            tree: compactTree(treeSummary(join(sourceRoot, selection.wrapper))),
          },
          configTemplate: { status: "absent-upstream-by-design" },
          upstreamComponents,
          configHubBootstrapWrapper: {
            disposition: "source-export-only-no-equivalent-bootstrap-wrapper-component",
          },
        };
      }),
      contract: {
        requiredForCurrentKubaraBootstrap: true,
        retainedByteForByte: true,
        configSelectable: false,
        aiRequired: false,
      },
    },
  };
}

function buildPassthroughServices() {
  const profiledNames = new Set(
    Object.values(KUBARA_SERVICE_SPECS).flatMap((service) => service.aliases),
  );
  const sourceLines = [releaseLineId, observedLineId].map((lineId) => {
    const root = join(snapshotLineRoot(lineId), "source");
    const services = treeSummary(root).records
      .filter((record) => record.path.includes("/services/") && record.path.endsWith(".yaml"))
      .map((record) => {
        const serviceDefinition = readYaml(join(root, record.path));
        assert(serviceDefinition.kind === "ServiceDefinition", `${lineId}/${record.path} is not a ServiceDefinition`);
        const key = serviceDefinition.metadata?.name;
        if (profiledNames.has(key) || key === "bootstrap-crds") return null;
        const catalog = record.path.split("/")[0];
        const chartPath = serviceDefinition.spec?.chartPath;
        const wrapperPath = `${catalog}/platform-components/helm/${chartPath}`;
        assert(existsSync(join(root, wrapperPath)), `${lineId}/${key} wrapper is missing: ${wrapperPath}`);
        const configTemplatePath = `${catalog}/platform-configs/helm/${chartPath}/values.generated.yaml.tplt`;
        return {
          key,
          lineId,
          catalog,
          serviceDefinition: {
            ...fileRecord(root, record.path),
            defaultStatus: serviceDefinition.spec?.status,
            clusterTypes: serviceDefinition.spec?.clusterTypes ?? [],
            chartPath,
          },
          wrapper: {
            path: wrapperPath,
            tree: compactTree(treeSummary(join(root, wrapperPath))),
          },
          configTemplate: existsSync(join(root, configTemplatePath))
            ? fileRecord(root, configTemplatePath)
            : { status: "absent-upstream", path: configTemplatePath },
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.key.localeCompare(right.key));
    return { lineId, services };
  });
  const released = sourceLines.find((line) => line.lineId === releaseLineId).services;
  const observed = sourceLines.find((line) => line.lineId === observedLineId).services;
  assert(released.length === 10, `expected ten passthrough general services, found ${released.length}`);
  assert(
    JSON.stringify(released.map((service) => service.key)) ===
      JSON.stringify(observed.map((service) => service.key)),
    "released and observed catalogs disagree on passthrough service identities",
  );
  return released.map((releasedService) => ({
    key: releasedService.key,
    reviewStatus: "byte-preserved-unreviewed",
    configHubMappingStatus: "not-assessed-by-seven-role-adapter",
    sourceLines: sourceLines.map((line) => {
      const service = line.services.find((candidate) => candidate.key === releasedService.key);
      return {
        sourceLine: line.lineId,
        catalog: service.catalog,
        serviceDefinition: service.serviceDefinition,
        wrapper: service.wrapper,
        configTemplate: service.configTemplate,
      };
    }),
  }));
}

function buildProfileIndex(
  profiles,
  templateLibrary,
  bootstrapConcerns,
  passthroughServices,
  currentVersionDeltasNotInRoot,
) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCompatibilityProfileIndex",
    metadata: { name: "kubara-component-catalog-alignment" },
    spec: {
      serviceCount: profiles.length,
      services: profiles.map((profile) => ({
        key: profile.metadata.name,
        profile: `services/${profile.metadata.name}.yaml`,
      })),
      sharedDependencies: [
        {
          key: templateLibrary.metadata.name,
          profile: "template-library.yaml",
          deployable: false,
        },
      ],
      bootstrapConcerns: bootstrapConcerns.map((profile) => ({
        key: profile.metadata.name,
        profile: `${profile.metadata.name}.yaml`,
        deployable: profile.spec.deployable,
        userSelectable: profile.spec.userSelectable,
        platformRoleCounted: false,
      })),
      passthroughServiceCount: passthroughServices.length,
      passthroughServices,
      sourceLines: KUBARA_CATALOG_LINES.map((line) => ({
        id: line.id,
        repository: line.repository,
        commit: line.commit,
        repositoryTree: line.repositoryTree,
        selectedTreeSha256: line.snapshotTreeSha256,
        distributionStatus: distributionStatus(line.id),
      })),
      currentCatalogVersionDeltasNotInConfigHubRoot: currentVersionDeltasNotInRoot,
      currentCatalogRootDeltaCount: currentVersionDeltasNotInRoot.length,
      exactRevisionRule:
        "compare generated or OCI results only with the snapshot from the exact source commit that produced them",
    },
  };
}

function buildAdapterOutput(
  profiles,
  bootstrapConcerns,
  passthroughServices,
  currentVersionDeltasNotInRoot,
) {
  const config = readYaml(configPath);
  const clusters = config.clusters ?? [];
  assert(clusters.length === 1, `adapter foundation expects one example cluster, found ${clusters.length}`);
  const cluster = clusters[0];
  const enabled = Object.entries(cluster.services ?? {})
    .filter(([, value]) => value?.status === "enabled")
    .map(([key]) => key)
    .sort();
  const expected = [...KUBARA_SERVICE_KEYS].sort();
  assert(JSON.stringify(enabled) === JSON.stringify(expected), `enabled Kubara service selection changed: ${enabled}`);

  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogAdapterOutput",
    metadata: { name: "kubara-component-catalog-alignment" },
    spec: {
      mode: "deterministic-source-preserving",
      input: {
        config: relative(repoRoot, configPath),
        configSha256: sha256File(configPath),
        cluster: {
          name: cluster.name,
          stage: cluster.stage,
          type: cluster.type,
        },
      },
      selection: {
        enabledServiceCount: enabled.length,
        enabledServices: enabled,
        disabledServicesRemainInPlatformConfig: true,
      },
      exports: KUBARA_CATALOG_LINES.map((line) => ({
        sourceLine: line.id,
        source: `data/kubara-catalog-snapshots/${line.id}/source`,
        export: `data/kubara-catalog-adapter/exports/${line.id}`,
        preservation: "byte-for-byte",
        snapshotMode: line.snapshotMode,
        distributionStatus: distributionStatus(line.id),
        ociReferences: line.defaultOciReferences ?? [],
      })),
      serviceMappings: profiles.map((profile) => ({
        kubaraServiceKey: profile.metadata.name,
        profile: `data/kubara-compatibility-profiles/services/${profile.metadata.name}.yaml`,
        selectedInConfig: true,
        sourceLineVersions: profile.spec.sourceLines.map((line) => ({
          sourceLine: line.id,
          wrapperVersion: line.wrapper.version,
          upstreamComponents: line.upstreamComponents.map((component) => ({
            canonicalIdentity: component.canonicalIdentity,
            version: component.chartDependency.version,
            configHubDisposition: component.configHub.disposition,
          })),
          firstPartyComponent: line.firstPartyComponent,
        })),
      })),
      sharedDependencies: [
        {
          key: "template-library",
          deployable: false,
          profile: "data/kubara-compatibility-profiles/template-library.yaml",
        },
      ],
      bootstrapConcerns: bootstrapConcerns.map((profile) => ({
        key: profile.metadata.name,
        role: profile.spec.role,
        deployable: profile.spec.deployable,
        userSelectable: profile.spec.userSelectable,
        platformRoleCounted: false,
        profile: `data/kubara-compatibility-profiles/${profile.metadata.name}.yaml`,
        sourceLines: profile.spec.sourceLines.map((line) => ({
          sourceLine: line.id,
          status: line.status,
          wrapperVersion: line.wrapper?.version ?? null,
          upstreamComponents: (line.upstreamComponents ?? []).map((component) => ({
            canonicalIdentity: component.canonicalIdentity,
            version: component.chartDependency.version,
            configHubDisposition: component.configHub.disposition,
          })),
        })),
      })),
      passthroughServices: {
        count: passthroughServices.length,
        reviewStatus: "byte-preserved-unreviewed",
        services: passthroughServices,
      },
      currentCatalogVersionDeltasNotInConfigHubRoot: currentVersionDeltasNotInRoot,
      boundaries: {
        aiRequired: false,
        liveWrites: false,
        rootCatalogPromotion: false,
        platformConfigMutation: false,
        renderedObjectParity: "not-claimed-by-this-foundation",
      },
    },
  };
}

function buildAdapterReceipt(exportsRoot, passthroughServices, currentVersionDeltasNotInRoot) {
  const parity = KUBARA_CATALOG_LINES.map((line) => {
    const sourceRoot = join(snapshotLineRoot(line.id), "source");
    const exportRoot = join(exportsRoot, line.id);
    const comparison = compareTrees(sourceRoot, exportRoot);
    assertTreeParity(comparison, `${line.id} source/export`);
    return {
      sourceLine: line.id,
      sourceTreeSha256: comparison.source.treeSha256,
      exportTreeSha256: comparison.exported.treeSha256,
      sourceFileCount: comparison.source.fileCount,
      exportFileCount: comparison.exported.fileCount,
      byteForByte: comparison.byteForByte,
      classes: sourceExportClasses(sourceRoot, exportRoot),
    };
  });
  const releaseObserved = compareTrees(
    join(snapshotLineRoot(releaseLineId), "source"),
    join(snapshotLineRoot(observedLineId), "source"),
  );

  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogAdapterReceipt",
    metadata: { name: "kubara-component-catalog-alignment" },
    spec: {
      digestAlgorithm: SNAPSHOT_DIGEST_ALGORITHM,
      sourceExportParity: parity,
      releaseVsObservedHead: {
        releaseSourceLine: releaseLineId,
        observedSourceLine: observedLineId,
        byteForByte: releaseObserved.byteForByte,
        changedFileCount: releaseObserved.changed.length,
        extraFileCount: releaseObserved.extra.length,
        missingFileCount: releaseObserved.missing.length,
        rule: "the observed head is not evidence for the released OCI bytes",
      },
      kubaraGenerateParity: {
        fullCurrentCatalogSourceAvailable: true,
        sourceExportIdentity: "proved-byte-for-byte",
        executionStatus: "not-run-by-this-offline-adapter",
        boundary:
          "full source identity makes exact-revision Kubara generation mechanically possible; rendered parity needs its own receipt",
      },
      currentCatalogVersionDeltasNotInConfigHubRoot: currentVersionDeltasNotInRoot,
      invariants: {
        selectedPlatformRoleCount: KUBARA_SERVICE_KEYS.length,
        nonUserSelectableBootstrapConcernCount: Object.keys(KUBARA_BOOTSTRAP_CONCERNS).length,
        bytePreservedUnreviewedPassthroughServiceCount: passthroughServices.length,
        currentCatalogExportsAreFullBootstrapAndGeneralTrees: true,
        catalogManifestPreservation: "byte-for-byte-when-present-upstream",
        serviceDefinitionPreservation: "byte-for-byte",
        platformComponentPreservation: "byte-for-byte",
        platformConfigTemplatePreservation: "byte-for-byte",
        sourceMutation: false,
        liveWrites: false,
        aiRequired: false,
        rootCatalogPromotion: false,
      },
      commands: {
        refreshPinnedSnapshots: "npm run kubara-catalog-snapshots:refresh",
        generateOffline: "npm run kubara-catalog-adapter:generate",
        verifyOffline: "npm run kubara-catalog-adapter:verify",
      },
    },
  };
}

function sourceExportClasses(sourceRoot, exportRoot) {
  const classes = [
    ["Catalog.yaml", (path) => basename(path) === "Catalog.yaml"],
    ["services", (path) => path.startsWith("services/") || path.includes("/services/")],
    ["platform-components", (path) => path.includes("platform-components/") || path.startsWith("platform-components/")],
    ["platform-configs", (path) => path.includes("platform-configs/") || path.startsWith("platform-configs/")],
  ];
  const results = classes.map(([name, predicate]) => {
    const source = treeSummary(sourceRoot, predicate);
    const exported = treeSummary(exportRoot, predicate);
    return {
      name,
      sourceFileCount: source.fileCount,
      exportFileCount: exported.fileCount,
      sourceTreeSha256: source.treeSha256,
      exportTreeSha256: exported.treeSha256,
      byteForByte:
        source.fileCount === exported.fileCount && source.treeSha256 === exported.treeSha256,
      upstreamPresence: source.fileCount > 0 ? "present" : "absent",
    };
  });
  const classifiedCount = results.reduce((sum, result) => sum + result.sourceFileCount, 0);
  assert(classifiedCount === treeSummary(sourceRoot).fileCount, `unclassified catalog source files under ${sourceRoot}`);
  assert(results.every((result) => result.byteForByte), `source/export class parity failed under ${sourceRoot}`);
  return results;
}

function configHubAvailability(mapping, version) {
  const rootRecipe = join(repoRoot, mapping.recipeRoot, version);
  const rootPackage = join(repoRoot, mapping.packageRoot, version);
  const rootRecipeExists = existsSync(rootRecipe);
  const rootPackageExists = existsSync(rootPackage);
  const candidates = candidateLanes.map((lane) => {
    const recipe = join(lane.root, mapping.recipeRoot, version);
    const packagePath = join(lane.root, mapping.packageRoot, version);
    return {
      lane: lane.name,
      recipe: relative(repoRoot, recipe),
      package: relative(repoRoot, packagePath),
      recipeExists: existsSync(recipe),
      packageExists: existsSync(packagePath),
    };
  });
  const completeCandidate = candidates.find((candidate) => candidate.recipeExists && candidate.packageExists);
  const incompleteCandidate = candidates.find((candidate) => candidate.recipeExists || candidate.packageExists);
  let disposition = "not-modeled-in-confighub";
  if (rootRecipeExists && rootPackageExists) disposition = "available-in-root-catalog";
  else if (completeCandidate) disposition = `${completeCandidate.lane}-only-not-root`;
  else if (rootRecipeExists || rootPackageExists) disposition = "incomplete-root-entry";
  else if (incompleteCandidate) disposition = `incomplete-${incompleteCandidate.lane}`;
  return {
    disposition,
    root: {
      recipe: relative(repoRoot, rootRecipe),
      package: relative(repoRoot, rootPackage),
      recipeExists: rootRecipeExists,
      packageExists: rootPackageExists,
    },
    candidates,
  };
}

function versionDeltasNotInRoot(profiles, currentLineId, baselineLineId) {
  const deltas = [];
  for (const profile of profiles) {
    const current = profile.spec.sourceLines.find((line) => line.id === currentLineId);
    const baseline = profile.spec.sourceLines.find((line) => line.id === baselineLineId);
    const baselineVersions = new Map(
      baseline.upstreamComponents.map((component) => [
        component.canonicalIdentity,
        component.chartDependency.version,
      ]),
    );
    for (const component of current.upstreamComponents) {
      if (baselineVersions.get(component.canonicalIdentity) === component.chartDependency.version) continue;
      const root = component.configHub.root;
      if (root.recipeExists && root.packageExists) continue;
      deltas.push(`${component.canonicalIdentity}@${component.chartDependency.version}`);
    }
  }
  return [...new Set(deltas)].sort();
}

function snapshotProvenance(line, summary, lineRoot) {
  return {
    apiVersion: "catalog.confighub.com/v1alpha1",
    kind: "KubaraCatalogSnapshot",
    metadata: { name: line.id },
    spec: {
      source: {
        repository: line.repository,
        commit: line.commit,
        repositoryTree: line.repositoryTree,
        sourceSubtree: line.sourceSubtree,
        releaseTags: line.releaseTags ?? [],
        defaultOciReferences: line.defaultOciReferences ?? [],
        distributionStatus: distributionStatus(line.id),
        catalogSubtrees: line.catalogSubtrees,
      },
      snapshot: {
        scope: line.snapshotMode,
        profiledServices: KUBARA_SERVICE_KEYS,
        bootstrapConcerns: Object.entries(KUBARA_BOOTSTRAP_CONCERNS).map(([key, concern]) => ({
          key,
          status: concern.lines[line.id] ? "included" : "not-present-as-a-separate-service-in-source-line",
        })),
        selectedPaths: selectedPathsForLine(line.id),
        fileCount: summary.fileCount,
        bytes: summary.bytes,
        treeSha256: summary.treeSha256,
        digestAlgorithm: SNAPSHOT_DIGEST_ALGORITHM,
        checksums: `data/kubara-catalog-snapshots/${line.id}/checksums.txt`,
      },
      license: {
        path: `data/kubara-catalog-snapshots/${line.id}/${basename(join(lineRoot, "UPSTREAM_LICENSE"))}`,
        sha256: sha256File(join(lineRoot, "UPSTREAM_LICENSE")),
        identifier: "Apache-2.0",
      },
      boundaries: {
        fullUpstreamRepositorySnapshot: false,
        fullCatalogSubtrees:
          line.snapshotMode === "full-bootstrap-and-general-catalogs",
        historicalBuiltInBoundary:
          line.id === builtInLineId
            ? "selected compatibility slice only; the existing Kubara v0.12 example retains its generated full built-in output"
            : null,
        sourceFilesModified: false,
        networkRequiredForOfflineVerify: false,
      },
    },
  };
}

function distributionStatus(lineId) {
  if (lineId === builtInLineId) return "embedded-in-kubara-v0.12.0";
  if (lineId === releaseLineId) return "released-oci-source-at-bootstrap-and-general-1.1.0-tags";
  if (lineId === observedLineId) return "observed-post-tag-source-not-byte-equivalent-to-released-oci";
  throw new Error(`unknown distribution status for ${lineId}`);
}

function snapshotLineRoot(lineId) {
  lineById(lineId);
  return join(snapshotsRoot, lineId);
}

function compactTree(summary) {
  return {
    fileCount: summary.fileCount,
    bytes: summary.bytes,
    treeSha256: summary.treeSha256,
    digestAlgorithm: SNAPSHOT_DIGEST_ALGORITHM,
  };
}

function assertTreeParity(comparison, label) {
  assert(
    comparison.byteForByte,
    `${label} differs (missing: ${comparison.missing.join(", ") || "none"}; extra: ${comparison.extra.join(", ") || "none"}; changed: ${comparison.changed.join(", ") || "none"})`,
  );
}

function cpReadme(sourceRoot, destinationRoot) {
  const source = join(sourceRoot, "README.md");
  assert(existsSync(source), `missing authored README: ${relative(repoRoot, source)}`);
  cpSync(source, join(destinationRoot, "README.md"));
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    maxBuffer: 1024 * 1024 * 200,
  });
}

function git(checkoutRoot, args) {
  return execFileSync("git", ["-C", checkoutRoot, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
