# CI and branch protection

What runs on every pull request, what `main` requires before a merge, and the exact steps to turn that protection on.
Synthetic data only: no CI job has cloud credentials, and nothing is deployed from CI (see [deployment.md](deployment.md)).

## The jobs (`.github/workflows/ci.yml`)

Runs on every pull request and on every push to `main`. A newer push to the same pull request cancels the older run;
runs on `main` are never cancelled. The workflow has read-only repository permissions and no job uses a secret.

| Job | Required | What a green result proves |
| --- | --- | --- |
| `verify` | yes | Typecheck and lint pass; the unit and API suites pass on the in-memory store; everything builds; the frontend stays inside its chunk budget; the real `knowledge/cpic` directory loads under **production** rules (nothing synthetic or unreviewed); the Terraform security tripwire (`pnpm test:infra`) and the CI-configuration tripwire (`pnpm test:ci-config`) pass |
| `database-and-storage` | yes | Joining gate: all three isolated backend profiles succeed, their nine current-checkout recovery records validate, and the complete worker suite passes on a fresh PostgreSQL/Moto pair, within one shared 30-minute run-attempt budget. Native failures and missing-service notices fail the gate |
| `service-memory`, `service-postgres`, `service-postgres-s3` | through the joining gate | The same complete backend commands as before, each on its own PostgreSQL 16, Moto and runner filesystem. The memory profile still includes database/S3 specs; PostgreSQL/S3 settings, discovery, workers and test deadlines are unchanged |
| `browser` | yes | The login flow and pages, driven by Chromium at 375 px and 1280 px against the fake identity provider (test only), the built API and the built frontend. On failure, traces and screenshots are kept 7 days |
| `terraform` | yes | `terraform fmt -check`, `init -backend=false`, `validate`, then `terraform test`: an offline plan of the whole root under each deployment profile with every provider mocked (what each profile builds, what it refuses, that the default variables plan). No credentials; nothing is created or applied, and it does not prove AWS accepts the plan |
| `secret-scan` | yes | gitleaks over the **full git history** (rules and the one named allowlist entry in `.gitleaks.toml`) |
| `image` | yes | Build/scan and synthetic TLS/provisioning/migration/two-task containment rehearsal; no registry push or AWS proof |
| `terraform-lint` | no (advisory) | tflint with the AWS ruleset. Promote it once it has run clean on `main` (below) |

A green run is evidence about the code at that commit. It is not evidence about AWS: Terraform has never been applied.

### Documentation merge and post-merge CI (#162, 2026-10-17)

[PR #162](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/162) merged as [c18c50387573ac727596c070e1b4356fab83991e](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/c18c50387573ac727596c070e1b4356fab83991e), whose tree matches reviewed/published documentation head 808147c. Its 37 insertions across STATUS and this runbook preserved all existing text. Application code, assertions, tests, profile commands, dependency pins, cleanup and shared-budget controls were unchanged.

Automatic [main run 39085190419, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39085190419) passed all six required checks named above and all ten jobs. The head, every checkout log and all completion receipts identify the exact main merge; commit check-run results match GitHub Actions app 15368 and this main run. Successful [PR run 39084236228](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39084236228) is separate pre-merge evidence.

| Complete #162 main-run profile | Passed / skipped / failed tests | Passed / total suites | Whole job |
| --- | --- | --- | --- |
| memory, including database/S3 specs | 2,226 / 253 / 0 | 158 / 169 | 8m14s |
| PostgreSQL | 2,458 / 21 / 0 | 167 / 169 | 9m55s |
| PostgreSQL + S3 | 2,478 / 1 / 0 | 169 / 169 | 12m06s |
| worker in the joining gate | 125 / 0 / 0 | 13 / 13 | 2m26s joining job; 69.204 s producer |

Each backend profile accounts for 2,479 tests / 169 suites with unchanged intentional skips and no missing required service tier. All six fixture lifecycle parent controls passed, including eight real construction-failure cases. Expected timeout children retained failure; parents verified database/session reclamation and preservation of an unrelated fixture. All 125 worker tests passed, including SIGTERM readiness, held-signal shutdown acknowledgement, drain without new claims and release/takeover of unfinished work. Native evidence also records 137 CI controls, 96 infrastructure controls, 140 browser tests (108 + 30 + 2), and the FD-7a policy producer's natural exit 0 with one passing policy case.

Four completion receipts bind all three profiles and worker to this repository, run, attempt, head and checkout. All twelve producer-file hashes match; all nine recovery aggregates validate and match the gate's collected copies byte-for-byte. Both hosted all-profile F2/F3 validators and final worker/unchanged-evidence acceptance passed. All four service jobs passed deadline checks and Stop containers steps.

All receipts share the original **1,800,000 ms** run-attempt budget; setup and the joining job receive no fresh window. Times distinguish Puerto Rico (UTC−04:00) from producer UTC.

| #162 main-run service budget event | Puerto Rico, 2026-10-17 | UTC, 2026-10-18 |
| --- | --- | --- |
| Original run-attempt start | 21:05:23 | 01:05:23 |
| Shared deadline | 21:35:23 | 01:35:23 |
| Last service job complete, including teardown | 21:20:01 | 01:20:01 |

The full service path took **14m38s**, leaving **15m22s**; the joining job alone took **2m26s** and is not the end-to-end measurement. Compared with the successful PR run, main took twelve seconds longer end-to-end (14m38s versus 14m26s) and four seconds longer in the joining job (2m26s versus 2m22s). These are two individual observations of the same tree, not a performance benchmark.

**Evidence limits:** normal Linux/x64 completion and cleanup are evidenced. This run did not deliberately trigger actual hosted action cancellation or the 30-minute expiry boundary, and does not establish an independent post-VM process census. Results apply to merged c18c503, not separate active feature branches; CI acceptance grants no deployment or clinical approval. Earlier #160/#159, #151/#150 and local-stage records below remain unchanged as dated history.

### Fixture repair acceptance and superseded draft (#160, 2026-10-17)

[PR #160](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/160) merged as [22209afa2e94bddef4926a0c5a61f1b81c8d9ec6](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/22209afa2e94bddef4926a0c5a61f1b81c8d9ec6), whose tree matches reviewed/published head `85dbb89`. The repair retains each case's pending fixture ownership, fences cancelled setup and unwinds failed construction while preserving original and cleanup errors. Existing assertions, profiles, hook deadlines, dependency pins and the shared service budget remain unchanged by the repair.

Automatic [main run 39081340588, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39081340588) passed all six required checks named above and all ten jobs. Head and tested checkout both identify the exact main merge; commit check-run results match the required GitHub Actions app and this main run. The successful [PR run 39080466424](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39080466424) is separate pre-merge evidence.

| Complete #160 main-run profile | Passed / skipped / failed tests | Passed / total suites | Whole job |
| --- | --- | --- | --- |
| memory, including database/S3 specs | 2,226 / 253 / 0 | 158 / 169 | 8m58s |
| PostgreSQL | 2,458 / 21 / 0 | 167 / 169 | 11m08s |
| PostgreSQL + S3 | 2,478 / 1 / 0 | 169 / 169 | 12m31s |
| worker in the joining gate | 125 / 0 / 0 | 13 / 13 | 2m36s joining job; 65.296 s producer |

Each backend profile accounts for 2,479 tests / 169 suites with unchanged intentional skips and no missing required service tier. All six fixture lifecycle parent controls passed, including eight real construction-failure cases. Expected timeout children retained failure and exited naturally; parent controls checked database/session reclamation and preservation of an unrelated fixture. All 125 worker tests passed, including SIGTERM readiness, held-signal shutdown acknowledgement, drain without new claims, and release/takeover of unfinished work. The hosted CI configuration suite passed **137 controls, zero failures/skips**.

Four completion receipts bind all three profiles and worker to this repository, run, attempt, head and checkout. All twelve producer-file hashes match; all nine recovery aggregates pass the existing validators and match the gate's collected copies. Both hosted all-profile F2/F3 validators, final worker/unchanged-evidence acceptance and all four deadline checks passed. Normal cleanup is evidenced by the lifecycle inventory controls and successful container-stop steps in all four service jobs.

All receipts share the original **1,800,000 ms** run-attempt budget; setup and the joining job receive no fresh window. Times show Puerto Rico time (UTC−04:00) and the producer's UTC timestamps.

| #160 main-run service budget event | Puerto Rico, 2026-10-17 | UTC, 2026-10-18 |
| --- | --- | --- |
| Original run-attempt start | 20:03:23 | 00:03:23 |
| Shared deadline | 20:33:23 | 00:33:23 |
| Last service job complete, including teardown | 20:18:35 | 00:18:35 |

The full service path took **15m12s**, leaving **14m48s**; the joining job alone took **2m36s** and is not the end-to-end measurement. **Evidence limits:** this successful run did not trigger actual hosted action cancellation or the 30-minute expiry boundary. Normal teardown and synthetic fixture controls do not establish an independent post-VM process census. These results apply to merged `22209af`; they grant no AWS deployment or clinical approval.

Draft [#159](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/159) was closed unmerged as superseded by #160 at **20:29:22 Puerto Rico time on 2026-10-17**, with a [comment linking the successful post-merge CI](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/159#issuecomment-6243732928). Its branch `fix/fixture-scope-main727-cleanup` remains at `1647e19bc66a3b2aa2126aa4039b29c7930932e5`. The eight files/modes and full patch match #160/main; the original #159 commit is not a main ancestor, so it was closed as superseded rather than merged. Its original failed CI remains a failure. The #150/#151 acceptance and earlier local-stage records below remain unchanged as dated history.

### Documentation merge and post-merge CI (#151, 2026-10-17)

[PR #151](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/151) merged as [c12c47a7e3865ffec7cdbaa7844aafa4b003041b](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/c12c47a7e3865ffec7cdbaa7844aafa4b003041b), whose tree matches reviewed documentation head `2f879fa`. Its two-file documentation change preserves #150's application/CI snapshot, test files, profile commands, cleanup and shared 30-minute budget. The earlier #150 acceptance and superseded-draft record below remains unchanged.

Automatic [main run 39031051513, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39031051513) passed all six required checks named above, with their GitHub Actions app bindings, and all ten jobs. Every checkout log and profile/evidence identity matches the exact main merge commit. The successful [PR run 39030205342](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39030205342) is separate pre-merge evidence.

| Complete #151 main-run profile | Passed / skipped / failed tests | Passed / total suites | Whole job |
| --- | --- | --- | --- |
| memory, including database/S3 specs | 2,156 / 253 / 0 | 155 / 166 | 8m27s |
| PostgreSQL | 2,388 / 21 / 0 | 164 / 166 | 10m24s |
| PostgreSQL + S3 | 2,408 / 1 / 0 | 166 / 166 | 11m02s |
| worker in the joining gate | 123 / 0 / 0 | 13 / 13 | 2m17s joining job; 0m57s test step |

Each backend profile totals 2,409 tests / 166 suites. Counters, intentional skips and every passing suite filename match #151's pre-merge run and accepted #150 main. All nine recovery aggregates passed the unchanged schema, runtime, checkout and hash checks: 12 catalogue, 30 independent-recovery and 13 application-recovery controls per backend profile. Both all-profile validators and final worker/evidence acceptance passed. The hosted Linux CI configuration suite passed **111 controls, zero failures/skips**.

All four completion records bind this repository, run, attempt and exact main checkout to the same original **1,800,000 ms** budget. The joining gate and worker receive no new window. Every pre-checkout bootstrap, live-watchdog check and final clock check passed; service transfers and teardown completed before the deadline.

| #151 main-run service budget event | Puerto Rico, 2026-10-17 | UTC, 2026-10-17 |
| --- | --- | --- |
| Original run-attempt start | 08:03:45 | 12:03:45 |
| Shared deadline | 08:33:45 | 12:33:45 |
| Last service job complete, including teardown | 08:17:08 | 12:17:08 |

The full service path took **13m23s**, leaving **16m37s**. The joining job alone took 2m17s; it excludes the isolated profile work and is not the end-to-end measurement. These observed times do not guarantee future runner performance or lower billed compute.

Normal teardown logs record PostgreSQL container removal and `moto_server` termination in all four service jobs. Hosted synthetic controls passed for Moto preservation, failed/expired setup, unwrapped-action cancellation, detached children, resistant owners, heartbeat/process-scan errors, failed TERM escalation and Linux executable-permission handling. Seven JSON artifact archives matched GitHub's SHA-256 digests; retained gate metrics equal the corresponding profile producer bytes, and all ten saved job logs passed hash verification. Historical offline replay of the collector, final gate and both recovery validators passed without executing profiles or asserting a live local watchdog.

**Evidence limits:** the successful run finished before expiry; actual GitHub `Runner.Worker` cancellation at the 30-minute boundary was not triggered. Synthetic cleanup controls and recorded teardown operations do not constitute an independent post-VM process census. Pre-bootstrap platform provisioning cannot be cancelled by workflow code; it consumes the same acceptance clock. Bounded failure-cleanup grace grants no additional acceptance time. CI acceptance grants no deployment or clinical approval. These results apply to the merged #151 snapshot; separately prepared local changes require their own verification.

### Merged acceptance and superseded drafts

[PR #150](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/150) merged as [34d6093962d3d029aa3c6a4d8ec6be9b652a0c78](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/34d6093962d3d029aa3c6a4d8ec6be9b652a0c78), whose tree matches reviewed head `7c35fe3`. Automatic [main run 38995941825, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38995941825) passed all six required checks named above and all ten jobs, including the advisory lint job. The earlier [PR run 38994847278](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38994847278) also passed; it is pre-merge evidence, not the main run.

| Complete main-run profile | Passed / skipped / failed tests | Passed / total suites | Whole job |
| --- | --- | --- | --- |
| memory, including database/S3 specs | 2,156 / 253 / 0 | 155 / 166 | 7m29s |
| PostgreSQL | 2,388 / 21 / 0 | 164 / 166 | 10m33s |
| PostgreSQL + S3 | 2,408 / 1 / 0 | 166 / 166 | 11m28s |
| worker in the joining gate | 123 / 0 / 0 | 13 / 13 | 2m25s joining job; 1m01s test step |

Each backend profile totals 2,409 tests / 166 suites. Counters, intentional skips and all passing suite filenames match the successful pre-merge run and the successful main baseline on the same application snapshot. No required profile or service was omitted. The hosted CI configuration suite passed **111 controls, zero failures/skips**. All nine recovery aggregates passed: 12 catalogue, 30 independent-recovery and 13 application-recovery controls per backend profile, plus both unchanged all-profile validators and final worker/evidence acceptance.

The four completion records bind this repository, run, attempt and exact main checkout to the same original **1,800,000 ms** budget. All bootstraps, live-watchdog checks, final clock checks, transfers and service teardown finished before the deadline. Times below show Puerto Rico time (UTC−04:00) alongside the producer's UTC timestamps.

| Main-run service budget event | Puerto Rico, 2026-10-16 | UTC, 2026-10-17 |
| --- | --- | --- |
| Original run-attempt start | 22:41:57 | 02:41:57 |
| Shared deadline | 23:11:57 | 03:11:57 |
| Last service job complete, including teardown | 22:55:55 | 02:55:55 |

The full service path took **13m58s**, leaving **16m02s**. The joining job alone covers a smaller share of the work. For a workload comparison, the successful [same-application monolithic main run 38985610382](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38985610382) took 28m15s from run start to final service completion. These are observed elapsed times; they do not establish lower billed compute or guarantee future runner performance.

Normal teardown logs record PostgreSQL container removal and `moto_server` termination in all four service jobs. Hosted native synthetic controls passed for Moto preservation, failed/expired setup, unwrapped-action cancellation, detached children, resistant owners, heartbeat/process-scan errors and failed TERM escalation. Seven downloaded JSON artifact archives matched GitHub's SHA-256 digests; completion records and nine strict recovery aggregates bind the tested checkout, and retained gate metrics equal producer bytes. Historical offline replay of the collector, final gate and both recovery validators passed without executing profiles or asserting a live local watchdog.

**Remaining limits:** these successful runs finished before expiry; actual GitHub `Runner.Worker` cancellation at the 30-minute boundary was not triggered. Native controls use synthetic owners/children. Teardown logs record removal/termination operations, not an independent post-VM process census. Platform provisioning before bootstrap cannot be cancelled by workflow code, and bounded failure-cleanup grace grants no additional acceptance time. CI does not authorize deployment or clinical use.

Drafts [#146](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/146) and [#148](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/148) were closed as superseded by #150 on 2026-10-17, with comments linking the successful main run. Their branches remain: `fix/ci-service-test-prerequisites` at `9904bd1` and `fix/ci-service-lifecycle` at `8af0b59`. Their changes were carried forward by content, not by merging the old draft commits. The prerequisite producer is unchanged; prior native preparation controls remain, workflow controls cover each isolated profile, and all six CI test files from #148 remain unchanged. #146's original `docs/verification/ci-service-test-prerequisites.md` remains historical material in [its commit](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/blob/9904bd1c3ff46ece562dfb4f8e5d7775966be190/docs/verification/ci-service-test-prerequisites.md).

### Choices worth knowing

- **Every GitHub Action is pinned to a full commit SHA**, with the version in a trailing comment. Tags can be moved; SHAs cannot.
  Dependabot opens the update PRs and changes both. `pnpm test:ci-config` fails on an unpinned action.
- **Node is pinned to an exact release** (`NODE_VERSION` in `ci.yml`, currently 22.22.0), not a floating major. The report
  adapter's unavailable-value matcher is pinned to Unicode 16.0 and refuses to load on a runtime with other Unicode data;
  a newer Node 22 already reports 17.0. To move Node: run the matcher's conformance tests on the new release, then change
  the pin in `unavailable-matcher.ts` and `docs/design/report-adapter-spec.md` in the same PR. `pnpm test:ci-config` fails
  if `NODE_VERSION` becomes a floating major.
- **Permissions default to `contents: read`.** Only the four service jobs add `actions: read`, to read the current run attempt’s start time from GitHub’s REST API. The token is scoped to the first-step bootstrap; it is never passed to the watchdog child. No job requests writes; checks are reported by the runner itself.
- **gitleaks is built from source** (`go install`, verified by the Go checksum database) rather than using the maintainers'
  GitHub Action, which requires a paid licence for organization repositories. The Go toolchain that builds it is an exact
  release (`go-version`), not `stable`.
- **Every other build input is pinned too** (audit finding INF-11; `.github/ci/supply-chain.test.mjs` checks every workflow file):
  the PostgreSQL service image by its multi-arch **digest** (one digest for every tier); Trivy's own binary (`version:` on
  `trivy-action`, so an action bump cannot change the scanner silently); and the Python test emulator by **hash**. Edit
  `.github/ci/requirements.in`, then regenerate `requirements.txt` with the `uv pip compile … --generate-hashes` command in
  its header; CI installs it with `pip install --require-hashes`. The local launcher reads its Moto pin from `requirements.in`.
  Nobody updates the service-image digest automatically (no Dependabot ecosystem covers workflow service containers): bump it
  by hand when the weekly rescan reports something worth it.
- **Only reviewed workflow files exist** (audit finding INF-17): `ci.yml` and `rescan.yml`. Adding one means changing
  `WORKFLOWS` in `supply-chain.test.mjs`, in review. A diagnostic workflow belongs on its own branch, never on `main`.
- **Playwright's browser is cached** by OS, architecture and installed Playwright version; unrelated lockfile changes do not invalidate the browser download. System libraries and all browser tests still run. The pnpm store and pip downloads are cached by the setup actions.
- **gitleaks compilation inputs are cached** by setup-go (OS, architecture, resolved Go release and the hash of `ci.yml`, which contains the exact gitleaks pin). There is no repository `go.sum`, so the workflow is the explicit dependency input. Source installation and the full-history scan run on both cold and warm caches.
- **Docker uses a scoped GitHub Actions layer cache** (`api-amd64-v1`), with bounded import/export waits and non-blocking export failures. Lock/workspace inputs are fetched before source is copied; the subsequent frozen install is offline. Both image exports, attestations, vulnerability scanning, and the runtime rehearsal remain mandatory. Cache restore misses rebuild normally; no test/scan result is cached. GitHub's branch/ref cache isolation applies, so a PR cache is not reusable by main. The existing cache storage limit is not raised.
- **The Terraform provider lock file is committed.** `versions.tf` constrains AWS to `~> 6.67`; the current lock selects AWS 6.68.0 and archive 2.8.1. Provider updates must preserve the reviewed lock/checksums and supported platforms; CI does not resolve an unreviewed newest 5.x provider.
- **Native GitHub secret scanning / code scanning** are not configured here. On a private repository they need GitHub
  Advanced Security. If the plan includes it, turn secret scanning on (Settings → Code security) as a second layer.

### Isolated service profiles and the joining gate

Successful shell completion rechecks the absolute deadline, then hands persistent setup services such as Moto to the job watchdog for later steps and final cleanup. Failed, signalled or expired shells still clean descendants and preserve failure/124 status. A late native zero cannot hand a service over. Watchdog heartbeat/inspection errors use the same bounded shutdown and final sweep as expiry; failed TERM attempts cannot bypass owner escalation. Persistent scan errors retain the last verified identities, with live PID/start/UID checks before signals. Unknown new processes cannot be discovered while inspection remains unavailable; bounded owner shutdown and known-process cleanup still run. Cleanup grace periods do not extend acceptance. See [lifecycle verification](../verification/ci-service-lifecycle.md).

The merged workflow replaces sequential backend profiles on one runner with three independent jobs. Each job installs the locked dependencies, starts its own PostgreSQL/Moto pair, verifies PostgreSQL 16 clients and OpenSSL, then runs the fresh shared-library producer introduced in #146 and preserved in #150. Only that successful producer exports the existing prepared marker to later steps; application hooks and consumer builds are unchanged.

The **entire service path shares one deadline**, GitHub’s current run-attempt `run_started_at` plus 30 minutes. A first-step watchdog is armed **before checkout or any user action setup**. The workflow materializes the canonical `.github/ci/service-deadline.mjs` module verbatim from one YAML anchor; aliases reuse it for the other three jobs. The image’s preinstalled Node runs only this built-in clock/process supervisor. Application commands still use the unchanged exact Node 22.22.0 and pnpm pins. `node .github/ci/update-service-deadline.mjs` refreshes the embedded source after an edit; configuration guards reject drift, a missing/optional/late bootstrap or a bypassing command.

The bootstrap reads the trusted attempt start with the existing read-only token, binds repository/run/attempt/head/checkout, and starts a separate watchdog before returning `armed=true`. Post-setup initialization verifies the real Git checkout and the live watchdog; it never resets that clock. Every later budget/evidence check requires a current heartbeat, the same owner and process start identity, and matching clock/source hashes. There is no stale relative download timeout. The watchdog remains active through setup, installs, direct download/upload actions, tests and post-action work; both profile and gate acceptance still recheck the deadline.

On Linux, an expected denial or disappearance during optional executable inspection retains readable core PID/start/UID identity for cleanup. Runner ownership still requires the verified executable and hosted ancestry; mutable process titles cannot authorize it. Core metadata failures and unexpected executable errors fail closed. Before a backend producer runs, all expected metric paths must be absent; new regular files must meet a same-filesystem timestamp/device fence and the existing schema, identity and hash checks. This avoids comparing coarse inode timestamps with a wall-clock sample without admitting stale outputs. See the [historical Linux-fix verification](../verification/ci-linux-process-evidence.md).

At expiry the watchdog cancels this job’s `Runner.Worker` with SIGTERM and terminates the job’s newly created runner-user processes, including separate sessions and reparented children. The selection is restricted to a dedicated standard Linux x64 GitHub-hosted VM with verified worker ancestry. PID plus start identity protects preexisting processes and PID reuse; the listener, other users and other job VMs are outside scope. The watchdog receives no token or caller environment and uses its own owner-bound lifetime instead of the runner tracking marker, so job orphan cleanup cannot remove it before its own detached-child cleanup finishes. Native wrappers additionally retain descendant identities across groups, freeze them before losing ancestry, and apply TERM followed by KILL. Failure exits remain failures; time expiry returns 124. Shutdown has a bounded cleanup grace (500 ms for children, up to five seconds for worker shutdown, then exact-owner KILL).

Initial VM provisioning, service-container startup and GitHub’s action-download preparation occur before workflow code can run. They consume the same clock, and an already expired attempt is refused by the first-step bootstrap. Workflow code cannot cancel platform work before that step. The existing 30-minute job caps remain as a second bound. If bootstrap cannot arm, retention actions are not launched. Failure artifacts remain seven-day, best-effort evidence within the active budget; they cannot extend it. The successful main run above establishes hosted bootstrap/live-watchdog acceptance, complete profiles, evidence transfers and normal teardown. Native controls cover interruption and detached cleanup; actual hosted cancellation at expiry remains untriggered. The [deadline-supervision verification](../verification/ci-service-deadline-supervision.md) records the earlier local stage.

The gate uses `if: always()` and explicitly requires **all three** `needs` results to be `success`. GitHub can otherwise treat a skipped check as successful. It downloads only the current run’s attempt-suffixed profile artifacts, without merging directories or overriding repository/run, and fails on digest mismatch. Each profile bundle requires a completed test summary with unique passing suite records, the existing build-timing receipt, three strict synthetic recovery aggregates and SHA-256 hashes. Its manifest binds the run, attempt, head, checkout, shared deadline and completion time. Missing, extra, changed, stale or incomplete evidence fails before copying. Existing results cannot substitute for a download.

After collection the complete worker profile runs against the joining job’s fresh cluster and Moto. Both existing all-profile F2/F3 CLI validators remain mandatory and unchanged. Final acceptance rechecks the bundles, copied metrics, complete worker summary, dependency results, live watchdog and deadline. A metric emitted early by a timed-out profile is insufficient, even when all nine aggregates passed. Intentional test skips from existing profile discovery are recorded; a missing-service `NOT RUNNING` notice is always refused. Seven-day aggregate/timing retention and failure/cancellation logs remain; attempt suffixes prevent collisions with immutable artifacts on reruns. Re-running only failed jobs cannot reuse an earlier attempt’s successful profiles: a new acceptance attempt needs all three producers again.

The isolation change preserves the six required status names, ruleset, main-run cancellation, application test files/configuration, profile commands, coverage, locks and deployment behavior; CI regression controls were added. The three internal jobs are mandatory dependencies of `database-and-storage`, not advisory checks. Successful PR and main runs establish complete hosted profile/worker and recovery acceptance within the shared budget; elapsed timing includes setup, transfers and the joining job. The [isolation verification](../verification/ci-isolated-service-profiles.md), [deadline-supervision record](../verification/ci-service-deadline-supervision.md), [lifecycle record](../verification/ci-service-lifecycle.md) and [Linux-fix record](../verification/ci-linux-process-evidence.md) retain their original local-stage scope. Use the [merged acceptance record above](#merged-acceptance-and-superseded-drafts) for the later hosted results and remaining limits.

## Branch protection (`.github/rulesets/main.json`)

The file is a GitHub **ruleset** for the default branch. It is not active until someone with admin rights imports it.

| Rule | Setting | Why |
| --- | --- | --- |
| Require a pull request | on; **0 required approvals**; conversations must be resolved | Every PR is opened under the sole maintainer's account, so a required approval would be a permanent self-approval deadlock |
| Required status checks | `verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`, each bound to the GitHub Actions app | Another app cannot report a check by the same name |
| Block force pushes | on | History on `main` is never rewritten |
| Block deletion | on | |
| "Require branch to be up to date" | **on** (founder decision 2026-10-19, security audit INF-05) | The checks must have run against the `main` the PR merges into. `main` is now contested (several sessions merge the same day), so a PR that was green against an older `main` is not evidence. Cost: after another PR merges, update the branch and wait for CI again before merging |
| Extra approval for unattributed changes | **off**, named explicitly in the file | A field the file leaves out takes GitHub's **default** when the file is applied through the API, not the live value: on 2026-10-20 that silently turned this on. With one maintainer and 0 approvals an extra required approval could block merges. `pnpm test:ci-config` fails if the field goes missing or turns on |
| Code-owner review | **off** | `.github/CODEOWNERS` still requests review automatically. A required code-owner approval cannot be given by the author, so enabling it now would block every PR |
| Bypass | **none** (founder decision 2026-10-19, security audit INF-05) | A standing bypass let one account merge past failing checks. Break-glass is now an explicit, visible ruleset edit (below) |

**When a second maintainer joins:** change `required_approving_review_count` to `1`, set `require_code_owner_review` to
`true`, and add the second person to `CODEOWNERS` for the sensitive paths. Update this table in the same PR.

**Status:** applied to `main` on 2026-10-07 by the repository owner, created by hand in the Rulesets form with the settings in
the table above (the file was used as the specification, not imported).

On 2026-10-10 the founder approved adding the missing live `image` check. Ruleset `24691287` was updated narrowly; a full before/after comparison preserved every other existing rule/condition/bypass field, and effective main protection returned all six check names. This does not claim every setting in the versioned ruleset was imported (the live rules returned no explicit deletion rule).

### Break-glass (no standing bypass)

If Actions is down or out of minutes and a merge cannot wait: as a repository admin, edit ruleset `24691287` to add the bypass, merge
the one pull request, and **remove the bypass again at once**. Say so in that PR, with the reason. GitHub records ruleset edits in
the repository's audit log, so the exception is visible afterwards instead of being a standing permission.

### Turning it on

1. Merge the PR that adds these files, and let CI run on `main` once. A check name can only be required after it has reported.
2. GitHub → repository **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, and choose `.github/rulesets/main.json`.
3. Review the page it shows (target: default branch; the six checks; bypass: Admin, pull request only) and **Create**.
4. Check it: open a throwaway PR and confirm it cannot merge until all six checks are green, and that
   `git push --force origin main` is refused.
5. Settings → Actions → General: confirm Actions is allowed, and that **Workflow permissions** is "Read repository contents".
   (The workflow also states its own permissions, so a permissive default would not widen it.)

Renaming a job in `ci.yml` silently stops requiring it, which is why `pnpm test:ci-config` fails if the job names and the
ruleset's required checks disagree.

### Promoting `terraform-lint`

When the advisory job has been green on `main` for a few merges: remove `continue-on-error: true` from it, drop it from
`ADVISORY` in `.github/ci/guard.test.mjs`, and add `{ "context": "terraform-lint", "integration_id": 15368 }` to the ruleset
file (then re-import or edit the ruleset in the UI).

## Other automation

- **Dependabot** (`.github/dependabot.yml`): weekly; npm, GitHub Actions and Terraform minor/patch updates are grouped,
  major updates arrive one at a time; also the CI emulator pin, the local compose file and the API image's base layers
  (`docker`, for `infrastructure/docker`).
- **Weekly rescan** (`.github/workflows/rescan.yml`, founder decision 2026-10-20: weekly, advisory): every Monday it builds the
  API image fresh and fails on a fixed CRITICAL or HIGH finding (the same gate as the `image` job), and fails on a high or
  critical advisory in the production dependencies (`pnpm audit --prod`). It also prints, without failing, the findings in the
  CI PostgreSQL service image (test-only, never deployed; it carried 25 fixed HIGH/CRITICAL findings on 2026-10-20). It never
  runs on push or pull request, so it cannot block a merge. A failed scheduled run makes GitHub email whoever last edited the
  schedule; run it by hand from the Actions tab (`workflow_dispatch`).
- **CODEOWNERS** (`.github/CODEOWNERS`): requests review for migrations, auth and tenancy, clinical content and logic,
  infrastructure, and CI itself.
- **Pull request template** (`.github/pull_request_template.md`): carries the safety invariants onto every PR
  (synthetic data only, no PHI or secrets, BAA status, clinical hold).

## Running the same checks locally

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:infra && pnpm test:ci-config
# The database and S3 tiers: docs/database.md. The browser tests: pnpm --filter @telesphoros/frontend e2e
```


## API image and rehearsal (FD-4b)

The `image` job is required in the versioned ruleset and, after the approved 2026-10-10 setting update, effective main protection. It builds linux/amd64 without publishing, exports an OCI archive with SBOM and provenance, blocks fixed HIGH/CRITICAL vulnerabilities with an empty reviewed exception list, and runs the synthetic TLS/provisioning/migration/two-task containment rehearsal. See [the image runbook](../../infrastructure/docker/README.md). The Docker load exporter is used for execution; the private, one-day OCI artifact retains attestations. No keyless signing, deploy identity or cloud access is introduced.

The database job also retains seven-day aggregate-only F1 catalogue, F2 independent-byte and F3 application-recovery artifacts. Separate validators require F2/F3 records from all three profiles at the tested checkout. F2 keeps application recovery false; F3 separately exercises actual synthetic application paths while clinical approval and native replication stay false. See [F2](independent-recovery.md) and [F3](application-recovery.md).

The pristine-database check expects production startup refusal before HTTP listen, reflecting the existing ledger bootstrap guard. It does not weaken that guard to force a pre-migration HTTP 503. After migrations, both tasks must pass health/readiness and reject unauthenticated access; the independent compiled writer process must refuse contained-tenant writes while a healthy-tenant control succeeds. This does not verify live Cognito, S3, IAM, RDS or Fargate.
