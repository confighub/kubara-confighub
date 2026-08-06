# Kubara compatibility profiles

These generated profiles map Kubara's seven selected services to ConfigHub's
component-first catalog without flattening Kubara's platform package.

Every service profile retains, for each immutable source line:

- the `ServiceDefinition` identity, cluster scope, and byte digest;
- the complete Kubara wrapper tree and chart metadata;
- the config-template byte digest;
- the selected service-slice and source-snapshot tree digests;
- each upstream chart dependency and its exact ConfigHub root/candidate
  disposition.

`kube-prometheus-stack` intentionally maps two deployable upstream components:
the stack and the blackbox exporter. `template-library.yaml` is explicitly a
nondeployable shared build dependency. Homer remains a first-party Kubara
wrapper unless and until a separate ConfigHub component is actually present.

`bootstrap-crds.yaml` is kept separately as a deployable but non-user-selectable
bootstrap concern. The released/current Kubara catalog needs it alongside Argo
CD during bootstrap. It does not change the seven-role platform selection and
it has no independent platform config template.

The released catalog introduces three upstream version deltas: Argo CD 10.2.1,
External Secrets 2.8.0, and kube-prometheus-stack 87.19.2. All three are now
present additively in the ConfigHub root catalog. Their older versions remain
available; promotion does not replace or delete catalog history.

The other ten general-catalog services are listed in `index.yaml` as
`byte-preserved-unreviewed`. Their full source is retained so Kubara defaults
and explicit disabled entries still work, but this seven-role adapter does not
invent deep ConfigHub mappings for them.

Regenerate and verify offline:

```sh
npm run kubara-catalog-adapter:generate
npm run kubara-catalog-adapter:verify
```
