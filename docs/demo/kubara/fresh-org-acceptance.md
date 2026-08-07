# Runbook: the fresh-organization acceptance run

This run is the last unearned claim in this repository: the general import into a genuinely fresh, user-selected ConfigHub organization. The tutorial and the reference deployment prove the journey; this run proves replication. Until it passes, the README and the checkpoints ledger say so.

## Preconditions

- A genuinely fresh ConfigHub organization. Creating or selecting it is a deliberate human step (`cub organization create` exists, but organization creation is account-level); log in with `cub auth login` and record the organization's name, external ID, and internal ID from `cub organization get`.
- Cluster capacity for a fresh kind fleet. Do not reuse the reference clusters.
- Fresh tokens: cub sessions expire daily around 07:00.

## The run

1. Copy `examples/kubara/git-import/selected-org-workflow.example.yaml` to a real request and bind the organization's exact coordinates and `https://hub.confighub.com`.
2. Compile the contract: `node scripts/compile-kubara-selected-org-workflow.mjs` against the request. The compiler executes nothing; organization and cluster bootstrap remain explicit steps in the journal it emits.
3. Execute the journal's ordered commands. Interruptions are safe: the journal is prefix-resumable, and a rerun replays only what is proven.
4. The acceptance is a two-run proof: one complete run, then a second run that must be prefix-cached with zero new actions. Retain the complete journal and receipts from both.
5. Only then update the honest-status lines in the README and the checkpoints ledger, and commit the acceptance evidence.

## Operating cautions

- Run everything serially. The hub has been sensitive to read bursts; one command at a time is the polite and the reliable mode.
- Keep the machine awake for the duration; sleep kills kind builds and long journals.
- A fresh organization has full quota headroom, but the same courtesy applies.
