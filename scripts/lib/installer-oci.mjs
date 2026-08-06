export const DEFAULT_INSTALLER_OCI_REGISTRY =
  process.env.HELM_EXPT_INSTALLER_OCI_REGISTRY ||
  "oci://europe-west1-docker.pkg.dev/nth-fort-499605-q5/helm-expt";

export function installerOciName(chart) {
  return String(chart || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function installerOciTag(version) {
  const tag = String(version || "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return tag || "latest";
}

export function installerOciRef(chart, version, registry = DEFAULT_INSTALLER_OCI_REGISTRY) {
  const base = String(registry || DEFAULT_INSTALLER_OCI_REGISTRY).replace(/\/+$/, "");
  return `${base}/${installerOciName(chart)}:${installerOciTag(version)}`;
}

export function chartVersionFromPackagePath(packagePath) {
  const parts = String(packagePath || "").split("/").filter(Boolean);
  const packagesIndex = parts.indexOf("packages");
  const packageParts = packagesIndex >= 0 ? parts.slice(packagesIndex + 1) : parts;
  if (packageParts.length < 3) return { chart: "", version: "" };
  const version = packageParts.at(-1);
  const chart = `${packageParts.slice(0, -2).join("/")}/${packageParts.at(-2)}`;
  return { chart, version };
}

export function installerOciRefForPackagePath(packagePath, registry = DEFAULT_INSTALLER_OCI_REGISTRY) {
  const { chart, version } = chartVersionFromPackagePath(packagePath);
  return installerOciRef(chart, version, registry);
}
