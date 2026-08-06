export const KUBARA_CATALOG_1_1_BASELINE = Object.freeze({
  componentCount: 100,
  versionCount: 120,
  recipesTreeSHA256: "b2f020f851838d1c4052ead583768e82710f03b03466fa882720180910007266",
  packagesTreeSHA256: "1101a9a6f546e620a992779bd2a76c2562ff66f88991deaf0c7c7112e0cef89d",
});

export const KUBARA_CATALOG_1_1_FINAL = Object.freeze({
  componentCount: 103,
  versionCount: 130,
});

export const KUBARA_CATALOG_1_1_ARTIFACTS = Object.freeze([
  artifact("argo-cd/argo-cd", "10.2.1", "https://github.com/argoproj/argo-helm/releases/download/argo-cd-10.2.1/argo-cd-10.2.1.tgz", "27e930e366d22c999002008ad5ec7961bda00410a84287210d0fffbee8150885", "retained-exact"),
  artifact("jetstack/cert-manager", "v1.21.0", "https://charts.jetstack.io/charts/cert-manager-v1.21.0.tgz", "9c2c6fabf3cf8fe14dacb016f37c819b66bc2c79e8b7acde4573d45ec141fb97", "retained-exact"),
  artifact("external-secrets/external-secrets", "2.8.0", "https://github.com/external-secrets/external-secrets/releases/download/helm-chart-2.8.0/external-secrets-2.8.0.tgz", "251e4615013c6d2f9ade5cedf1cd8615613f286bfc381e44fb005f197e611ecd", "retained-exact"),
  artifact("prometheus-community/kube-prometheus-stack", "87.19.2", "https://github.com/prometheus-community/helm-charts/releases/download/kube-prometheus-stack-87.19.2/kube-prometheus-stack-87.19.2.tgz", "b846cc368aaafd122148c8eec9b361d3893c6068d6301ec20d41c8023dcd8c88", "retained-exact"),
  artifact("grafana/loki", "7.1.0", "https://github.com/grafana/helm-charts/releases/download/helm-loki-7.1.0/loki-7.1.0.tgz", "34361cca2bbb6fa975fd1aeec4f9d5e2b91e2c99af7dd6f9c14ef7fe646493d1", "additive-root", { candidate: "loki" }),
  artifact("grafana/alloy", "1.11.0", "https://github.com/grafana/helm-charts/releases/download/alloy-1.11.0/alloy-1.11.0.tgz", "11d253b62e47beeacd89eb4283fc056962ecbf143984863c1998be13da0772dd", "additive-root", { candidate: "alloy" }),
  artifact("prometheus-community/prometheus-blackbox-exporter", "11.15.1", "https://github.com/prometheus-community/helm-charts/releases/download/prometheus-blackbox-exporter-11.15.1/prometheus-blackbox-exporter-11.15.1.tgz", "4e8e45b8a6fbec4168d9b3e772a0219afec09b61c545af5f01395de363e30b5e", "retained-exact"),
  artifact("stakater/reloader", "2.2.14", "https://stakater.github.io/stakater-charts/reloader-2.2.14.tgz", "a21154a5b32df7c4d78c575e957ffa2af5afdfdf608415d3eb0a0da1d045dcec", "additive-root", { candidate: "reloader" }),
  artifact("metrics-server/metrics-server", "3.13.1", "https://github.com/kubernetes-sigs/metrics-server/releases/download/metrics-server-helm-chart-3.13.1/metrics-server-3.13.1.tgz", "084e6edb680cf4e2acc30bd496568c53fdf663cbacf6e17876b25785c35b7a13", "retained-exact"),
  artifact("oauth2-proxy/oauth2-proxy", "10.7.0", "https://github.com/oauth2-proxy/manifests/releases/download/oauth2-proxy-10.7.0/oauth2-proxy-10.7.0.tgz", "47b44c66fdfc42677d307cf8891f3de29863414bf265f6bef2020c273ff7e839", "additive-root", { candidate: "oauth2-proxy" }),
  artifact("kyverno/kyverno-policies", "3.8.2", "https://kyverno.github.io/kyverno/kyverno-policies-3.8.2.tgz", "a9e9377c7f068842274b9fce133832a4579c81429cb099a5956bb33bd66a0ccc", "additive-root", { candidate: "kyverno-policies" }),
  artifact("external-dns/external-dns", "1.21.1", "https://github.com/kubernetes-sigs/external-dns/releases/download/external-dns-helm-chart-1.21.1/external-dns-1.21.1.tgz", "5dd033a4b872bf641860695705ee460031d0bc695f114bf8926fee6736814e19", "supplemental-lock"),
  artifact("velero/velero", "12.1.0", "https://github.com/vmware-tanzu/helm-charts/releases/download/velero-12.1.0/velero-12.1.0.tgz", "cd23589ad1b2d25cdd3220f6866b3f6f4c5683c4c09494e76a14700b33f81f83", "additive-root", { candidate: "velero" }),
  artifact("policy-reporter/policy-reporter", "3.9.1", "https://github.com/kyverno/policy-reporter/releases/download/policy-reporter-3.9.1/policy-reporter-3.9.1.tgz", "a7d00d9b79435bc40fb3049302e8e08da156f718713403042666bb699c569fb1", "additive-root", { candidate: "policy-reporter" }),
  artifact("longhorn/longhorn", "1.12.0", "https://github.com/longhorn/charts/releases/download/longhorn-1.12.0/longhorn-1.12.0.tgz", "869bb20701b154473606f1e8967b27f34f2448a2dfe6eb8970f1cae6957384f5", "additive-root", { candidate: "longhorn" }),
  artifact("metallb/metallb", "0.16.1", "https://github.com/metallb/metallb/releases/download/metallb-chart-0.16.1/metallb-0.16.1.tgz", "fb06bb584fcb7856f15733b2a6a2aff5b61b5c350687e341c163ae24a5938adc", "additive-root", { candidate: "metallb" }),
  artifact("kyverno/kyverno", "3.8.2", "https://kyverno.github.io/kyverno/kyverno-3.8.2.tgz", "f4fc787cf1d6781eefb9e9b45837edcddcfae984c872888289914e97207cc5de", "additive-root", { candidate: "kyverno" }),
  artifact("traefik/traefik", "41.0.2", "oci://ghcr.io/traefik/helm/traefik:41.0.2", "a84ec5eae9f5507c8f0632d58a7eb10c9b7fd2a277b77740ee7460c55ecde49a", "supplemental-lock", {
    manifestDigest: "sha256:b64212403e056c14dbcac5bfd0030f89f0e08fccae370dd7cd96592ee745848e",
  }),
]);

export const KUBARA_CATALOG_1_1_ADDITIONS = Object.freeze(
  KUBARA_CATALOG_1_1_ARTIFACTS.filter((item) => item.catalogState === "additive-root"),
);

export const KUBARA_CATALOG_1_1_SUPPLEMENTS = Object.freeze(
  KUBARA_CATALOG_1_1_ARTIFACTS.filter((item) => item.catalogState === "supplemental-lock"),
);

function artifact(canonicalIdentity, version, url, sha256, catalogState, extra = {}) {
  const [repository, chart] = canonicalIdentity.split("/");
  return Object.freeze({
    canonicalIdentity,
    repository,
    chart,
    version,
    url,
    sha256,
    catalogState,
    recipePath: `recipes/${canonicalIdentity}/${version}`,
    packagePath: `packages/${canonicalIdentity}/${version}`,
    ...extra,
  });
}
