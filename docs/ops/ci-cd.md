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
  GitHub Action, which requires a paid licence for organization repositories.
- **Playwright's browser is cached** by OS, architecture and installed Playwright version; unrelated lockfile changes do not invalidate the browser download. System libraries and all browser tests still run. The pnpm store and pip downloads are cached by the setup actions.
- **gitleaks compilation inputs are cached** by setup-go (OS, architecture, resolved Go release and the hash of `ci.yml`, which contains the exact gitleaks pin). There is no repository `go.sum`, so the workflow is the explicit dependency input. Source installation and the full-history scan run on both cold and warm caches.
- **Docker uses a scoped GitHub Actions layer cache** (`api-amd64-v1`), with bounded import/export waits and non-blocking export failures. Lock/workspace inputs are fetched before source is copied; the subsequent frozen install is offline. Both image exports, attestations, vulnerability scanning, and the runtime rehearsal remain mandatory. Cache restore misses rebuild normally; no test/scan result is cached. GitHub's branch/ref cache isolation applies, so a PR cache is not reusable by main. The existing cache storage limit is not raised.
- **The Terraform provider lock file is committed.** `versions.tf` constrains AWS to `~> 6.67`; the current lock selects AWS 6.68.0 and archive 2.8.1. Provider updates must preserve the reviewed lock/checksums and supported platforms; CI does not resolve an unreviewed newest 5.x provider.
- **Native GitHub secret scanning / code scanning** are not configured here. On a private repository they need GitHub
  Advanced Security. If the plan includes it, turn secret scanning on (Settings → Code security) as a second layer.

### Isolated service profiles and the joining gate

Successful shell completion rechecks the absolute deadline, then hands persistent setup services such as Moto to the job watchdog for later steps and final cleanup. Failed, signalled or expired shells still clean descendants and preserve failure/124 status. A late native zero cannot hand a service over. Watchdog heartbeat/inspection errors use the same bounded shutdown and final sweep as expiry; failed TERM attempts cannot bypass owner escalation. Persistent scan errors retain the last verified identities, with live PID/start/UID checks before signals. Unknown new processes cannot be discovered while inspection remains unavailable; bounded owner shutdown and known-process cleanup still run. Cleanup grace periods do not extend acceptance. See [lifecycle verification](../verification/ci-service-lifecycle.md).

This local slice replaces sequential backend profiles on one runner with three independent jobs. Each job installs the locked dependencies, starts its own PostgreSQL/Moto pair, verifies PostgreSQL 16 clients and OpenSSL, then runs the existing fresh shared-library producer from PR #146. Only that successful producer exports the existing prepared marker to later steps; application hooks and consumer builds are unchanged.

The **entire service path shares one deadline**, GitHub’s current run-attempt `run_started_at` plus 30 minutes. A first-step watchdog is armed **before checkout or any user action setup**. The workflow materializes the canonical `.github/ci/service-deadline.mjs` module verbatim from one YAML anchor; aliases reuse it for the other three jobs. The image’s preinstalled Node runs only this built-in clock/process supervisor. Application commands still use the unchanged exact Node 22.22.0 and pnpm pins. `node .github/ci/update-service-deadline.mjs` refreshes the embedded source after an edit; configuration guards reject drift, a missing/optional/late bootstrap or a bypassing command.

The bootstrap reads the trusted attempt start with the existing read-only token, binds repository/run/attempt/head/checkout, and starts a separate watchdog before returning `armed=true`. Post-setup initialization verifies the real Git checkout and the live watchdog; it never resets that clock. Every later budget/evidence check requires a current heartbeat, the same owner and process start identity, and matching clock/source hashes. There is no stale relative download timeout. The watchdog remains active through setup, installs, direct download/upload actions, tests and post-action work; both profile and gate acceptance still recheck the deadline.

At expiry the watchdog cancels this job’s `Runner.Worker` with SIGTERM and terminates the job’s newly created runner-user processes, including separate sessions and reparented children. The selection is restricted to a dedicated standard Linux x64 GitHub-hosted VM with verified worker ancestry. PID plus start identity protects preexisting processes and PID reuse; the listener, other users and other job VMs are outside scope. The watchdog receives no token or caller environment and uses its own owner-bound lifetime instead of the runner tracking marker, so job orphan cleanup cannot remove it before its own detached-child cleanup finishes. Native wrappers additionally retain descendant identities across groups, freeze them before losing ancestry, and apply TERM followed by KILL. Failure exits remain failures; time expiry returns 124. Shutdown has a bounded cleanup grace (500 ms for children, up to five seconds for worker shutdown, then exact-owner KILL).

Initial VM provisioning, service-container startup and GitHub’s action-download preparation occur before workflow code can run. They consume the same clock, and an already expired attempt is refused by the first-step bootstrap. No local test establishes cancellation of platform provisioning before that first step. The existing 30-minute job caps remain as a second bound. If bootstrap cannot arm, retention actions are not launched. Failure artifacts remain seven-day, best-effort evidence within the active budget; they cannot extend it. Local controls exercise native action interruption and detached cleanup, while the actual hosted Linux lifecycle still needs a separately authorized run. [Verification](../verification/ci-service-deadline-supervision.md).

The gate uses `if: always()` and explicitly requires **all three** `needs` results to be `success`. GitHub can otherwise treat a skipped check as successful. It downloads only the current run’s attempt-suffixed profile artifacts, without merging directories or overriding repository/run, and fails on digest mismatch. Each profile bundle requires a completed test summary with unique passing suite records, the existing build-timing receipt, three strict synthetic recovery aggregates and SHA-256 hashes. Its manifest binds the run, attempt, head, checkout, shared deadline and completion time. Missing, extra, changed, stale or incomplete evidence fails before copying. Existing results cannot substitute for a download.

After collection the complete worker profile runs against the joining job’s fresh cluster and Moto. Both existing all-profile F2/F3 CLI validators remain mandatory and unchanged. Final acceptance rechecks the bundles, copied metrics, complete worker summary, dependency results, live watchdog and deadline. A metric emitted early by a timed-out profile is insufficient, even when all nine aggregates passed. Intentional test skips from existing profile discovery are recorded; a missing-service `NOT RUNNING` notice is always refused. Seven-day aggregate/timing retention and failure/cancellation logs remain; attempt suffixes prevent collisions with immutable artifacts on reruns. Re-running only failed jobs cannot reuse an earlier attempt’s successful profiles: a new acceptance attempt needs all three producers again.

This does not change the six required status names, ruleset, main-run cancellation, test files, test configuration, profile commands, coverage, locks or deployments. The three internal jobs are mandatory dependencies of `database-and-storage`, not advisory checks. Local tests and retained-log replay establish orchestration controls and format compatibility only; hosted runner isolation, fresh-worker acceptance, queue time and runtime improvement still need an explicitly authorized CI run. See [verification](../verification/ci-isolated-service-profiles.md).

## Branch protection (`.github/rulesets/main.json`)

The file is a GitHub **ruleset** for the default branch. It is not active until someone with admin rights imports it.

| Rule | Setting | Why |
| --- | --- | --- |
| Require a pull request | on; **0 required approvals**; conversations must be resolved | Every PR is opened under the sole maintainer's account, so a required approval would be a permanent self-approval deadlock |
| Required status checks | `verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`, each bound to the GitHub Actions app | Another app cannot report a check by the same name |
| Block force pushes | on | History on `main` is never rewritten |
| Block deletion | on | |
| "Require branch to be up to date" | **off** | Safer, but forces a re-run after each merge; revisit when `main` becomes contested |
| Code-owner review | **off** | `.github/CODEOWNERS` still requests review automatically. A required code-owner approval cannot be given by the author, so enabling it now would block every PR |
| Bypass | repository admins, **only through a pull request** | Break-glass if Actions is down or out of minutes. Without it, nothing could merge. Use it rarely, and say so in the PR |

**When a second maintainer joins:** change `required_approving_review_count` to `1`, set `require_code_owner_review` to
`true`, and add the second person to `CODEOWNERS` for the sensitive paths. Update this table in the same PR.

**Status:** applied to `main` on 2026-10-07 by the repository owner, created by hand in the Rulesets form with the settings in
the table above (the file was used as the specification, not imported).

On 2026-10-10 the founder approved adding the missing live `image` check. Ruleset `24691287` was updated narrowly; a full before/after comparison preserved every other existing rule/condition/bypass field, and effective main protection returned all six check names. This does not claim every setting in the versioned ruleset was imported (the live rules returned no explicit deletion rule).

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
  major updates arrive one at a time; also the CI emulator pin and the local compose file.
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
