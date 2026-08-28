# Fresh-organization acceptance: staging checklist

A companion to [the runbook](fresh-org-acceptance.md). The runbook is the procedure; this records what is already staged, what the compiler requires, and the exact command sequence, so the run starts the moment a fresh organization exists.

## Staged and green

The offline toolchain passes end to end. `npm run kubara-adoption:self-test` runs four self-tests, and all four pass: the Git importer, the selected-organization workflow, the application release, and its runner. The organization is the only remaining blocker.

The command surface matches the installed client. cub is v0.2.34. The promotion tooling uses `cub variant promote` and `cub release publish`, and `LastAppliedRevisionNum` is the current field name at this version. The rename to `LastReleasedRevisionNum` arrives with v0.4.0 and does not affect this run. No deprecated verb appears in the scripts.

## Which organization

The run needs a genuinely fresh organization, and freshness is the point rather than a formality. This run proves replication: that the platform imports into an organization that has never held it. An organization that already carries the platform cannot demonstrate replication, and the two-run proof needs a clean baseline before the second run can read as zero new actions.

Any empty organization you own qualifies. Create one, or select an organization that has never had this platform imported. Do not reuse the reference organization that already carries the platform, because it is populated and mid-flight, so it proves nothing here and its state would foul the proof.

## What the compiler requires

`compile-kubara-selected-org-workflow.mjs --compile` validates the whole request but reads only one kind of file at compile time. Every path is checked for shape. Only each `applications[].request` file must already exist, be a real file rather than a symlink, and name the same organization as the workflow. The platform checkout, portable package, runtime evidence, and target facts are consumed later, during execution.

So the compile needs two inputs: the organization's five coordinates, and one organization-bound application-release request per application.

| Coordinate | Format | Source |
| --- | --- | --- |
| organization | name, up to 80 characters | `cub organization get` DisplayName |
| context | slug | the cub context the fresh organization is logged into |
| organizationExternalID | UUID | `cub organization get` ExternalID |
| organizationID | UUID | `cub organization get` OrganizationID |
| serverURL | https origin | `https://hub.confighub.com` |
| spaceReleaseOCIBase | `oci://…/space` | the organization's release OCI base |

## The run

Run everything serially, and keep the machine awake for the duration.

1. Create or select the fresh organization, then read its coordinates.

   ```sh
   cub auth login
   cub organization get
   ```

2. Copy the example request into your controlled tree and fill the five coordinates, binding `serverURL` to `https://hub.confighub.com`.

   ```sh
   cp examples/kubara/git-import/selected-org-workflow.example.yaml \
     /controlled/import/selected-org-workflow.request.yaml
   ```

3. Compile the journal. The compiler executes nothing; it emits the ordered, resumable plan.

   ```sh
   node scripts/compile-kubara-selected-org-workflow.mjs --compile \
     --request /controlled/import/selected-org-workflow.request.yaml \
     --output /controlled/import/journal
   ```

4. Execute the journal's steps in order. They run the portable publish, switch to the organization, bootstrap the clusters, inspect and bind the destination, apply once, and then apply again to record zero actions.

5. Run the whole sequence a second time. The acceptance is a two-run proof, and this run must be prefix-cached with zero new actions.

6. On green, update the honest-status lines in the README and the checkpoints ledger, and commit both journals and their receipts.

## Decisions

- Platform input. Reuse the reference platform's portable definition, or generate a fresh one with kubara. Either satisfies the acceptance.
- kubara version. The repository pins v0.13.0 for byte-identical reference reproduction. v0.15.0 is fine for a fresh platform.

## The honest boundary

This staging proves the toolchain and the command surface. It does not certify promotion behaviour against the latest server; the run itself is that certification. Promotion has changed recently. It replays functions across the walked range, protection is opt-in, conflicts are recorded rather than failing the merge, and a changeset wraps every promotion. Expect the run to surface any mismatch, which is what an acceptance run is for.
