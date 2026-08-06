# Faithful Kubara hub-and-spoke proof

Kubara v0.13.0 generated and bootstrapped the familiar hub-and-spoke
topology with catalog 1.1.0. ConfigHub checked and approved the
exact source contract without repointing Kubara's Git repositories, generated
ApplicationSets, or AppProject. The hub registered hx-app-staging through Kubara's
documented OpenBao → ExternalSecret → Argo cluster Secret route, then
cert-manager@v1.21.0 became Synced and Healthy.

| Check | Result |
| --- | --- |
| `kubara cluster add` onboarding | pass |
| Git/AppSet/AppProject source unchanged | pass |
| ConfigHub plan check + approval | pass |
| OpenBao / External Secrets route | pass |
| Argo spoke registration | pass |
| Selected Application sync | Synced |
| Selected Application health | Healthy |
| Exact cluster cleanup | pass |

ConfigHub approval is recorded on Provider None evidence Units. This proof does
not claim an enforced GitHub status or a server-side deployment gate.
