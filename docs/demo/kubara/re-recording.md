# Runbook: re-recording the live evidence

The receipts in this repository bind one organization fingerprint and one changed/no-op apply pair. Outages, cluster restarts, and server-side drift invalidate them, and the gates are deliberately strict about what counts as re-earned. This is the operator's guide to re-recording without rediscovering the rules.

## The proof pair, precisely

The idempotence proof requires the ledger's last two apply attempts to be a changed apply (at least one action) followed by the immediately next-sequenced zero-action apply, both passing, both at the same execution fingerprint, closing at the same organization fingerprint.

- **Extra no-op applies invalidate the pair.** Running `--apply` "just to check" pushes the changed run out of the last-two window. Use `--verify` for checking; it is read-only and records nothing.
- **Any failed attempt between the pair invalidates it**, including a transient server error. The pair must then be re-earned with a fresh changed apply.
- **The organization fingerprint drifts across outages and cluster restarts** even with zero managed-content changes (observed drivers include apply-status fields). After any such event, plan to re-earn the pair; yesterday's proven receipt cannot be revalidated against today's fingerprint.

## Producing a changed apply within budget

The performance acceptance caps a changed apply at 96 ConfigHub reads before the first accepted dev Application. A fleet-wide release exceeds this (a full cubbychat release measured 104). The pattern that fits: a one-action drift repair.

1. Remove or alter one reconciler-owned Space label out of band (`cub space update --patch <space> --label Key=drift-value --quiet`). Note: automated policy may block an assistant from issuing this mutation; the operator runs this one line.
2. `--apply`: the reconciler detects and repairs the drift as one attributed action. This is the changed apply, comfortably inside every budget.
3. `--apply` again immediately: the zero-action rerun completes the pair.
4. Run the orphan audit; it stamps the performance acceptance onto the receipt when the pair and the scoped residue are clean.

## Order of operations for a full re-record

Commit-clean tree first (the static gate's git-handoff step requires it), then gates, then captures, then receipts, then atomic embedding, then `kubara-release:verify`. Captures only happen after the seven-command pre-capture gate passes, and any input change after it passes discards uncatalogued captures.

## Screenshot capture mechanics

The frames are real captures, and the pipeline that works without macOS screen-recording permission:

- **GUI and web frames**: a dedicated Chrome with `--remote-debugging-port` and a separate `--user-data-dir`, driven via puppeteer-core connected to the debug port; screenshots come out of the DevTools protocol as real PNGs. The operator logs into the ConfigHub GUI in that window; the assistant never touches credentials. Capture GitHub views pinned to the exact bound commit so the visible ref matches the receipt.
- **Terminal frames**: `ttyd` serves a real shell to the browser; run the real command in it and capture the tab. No mockups, no composites — the contracts forbid both.
- **Bindings**: every image records SHA-256, capture time (at or after the newest live receipt's observation time), visible identities (described without personal names), sensitive handling, caption, and claim boundary. The GUI receipt binds the faithful receipt's source commit exactly.

## Known traps

- cub tokens expire daily around 07:00; every context needs a fresh `cub auth login` by the operator.
- The hub has been sensitive to read-heavy access; run gates serially, browse the GUI gently, and never run live lanes in parallel.
- Keep the machine awake; sleep kills kind builds and long applies.
