# Status, history and working agreements

Read this first to pick the project up. Project snapshot: **2026-10-14**; CI status updated **2026-10-17**. Update it in the same pull request as any change it describes.
Synthetic data only: the AWS BAA is not executed, nothing is applied in AWS, and nothing here is approved for clinical use.

## CI supply chain: pinned inputs, one reviewed workflow list, a weekly rescan (draft PR, 2026-10-20)

Audit findings INF-11 and INF-17 (founder decision 2026-10-20; INF-03, image signing, waits for its own decision). The diagnostic `fixture-phase-capture.yml`, merged despite its own "never merge" header, is deleted, and a CI-config test now allows only `ci.yml` and `rescan.yml`. The four PostgreSQL service images use one multi-arch digest; Go and Trivy are exact releases; the S3 emulator's whole dependency tree (60 packages) is installed with `pip install --require-hashes` from `requirements.txt`, generated from a new `requirements.in` that the local launcher now reads its pin from. Dependabot also watches the API Dockerfile. A new weekly, advisory `rescan.yml` rebuilds and scans the API image and audits production dependencies; it never runs on a pull request. `supply-chain.test.mjs` applies the action-pinning, read-only and no-secrets rules to every workflow file, not only `ci.yml`. No application, Terraform or AWS change.

## Logging: declared service log groups and an allowlisted API log (merged #205, 2026-10-20)
## INF-03 spec: only the image CI built and scanned can be deployed (spec only, plan approved, draft PR, 2026-10-20)

[Spec, plan and tasks](../specs/002-signed-image-release/spec.md) for closing INF-03 (High): CI pushes the exact archive its `image` job built, scanned and rehearsed, checks the digest, and signs it with an asymmetric AWS KMS key through cosign with **no** transparency-log upload (founder decision 2026-10-20); stage C refuses an `api_image` without a verified signature. Three slices (Terraform key and OIDC role, the CI job, verify-before-apply), all dormant or unapplied until the founder acts. Plan approved by the founder 2026-10-20 with the recommended D1–D5; slices follow as their own draft PRs. No code, CI, Terraform or AWS change in this PR.
## INF-03 slice 1: image-signing key, GitHub OIDC trust, CI release role (draft PR, 2026-10-20)

First slice of `specs/002-signed-image-release` (plan approved 2026-10-20). `signing.tf` declares an ECC P-256 `SIGN_VERIFY` KMS key whose policy denies `kms:Sign` to everyone but the release role; the GitHub OIDC provider (unless an existing one is named); and the release role, trusted only for this repository's `ci.yml` on `main` in the `image-release` environment (six `StringEquals` conditions on immutable IDs) and allowed only to push to the API repository and sign with that key. It exists in a plan only with API hosting on and the repository IDs set; production with API hosting now refuses to plan without it. The ECR lifecycle rule counts tagged images only, so signatures never take a slot (D5). Nothing is applied; no CI change yet (slice 2). [Verification](verification/signed-image-release.md).

## Logging: declared service log groups and an allowlisted API log (draft PR, 2026-10-20)

Two audit findings from 2026-10-19, in one PR (founder decision 2026-10-20; INF-06 follows DATA-01 slice 2, because it needs a migration).
**INF-12:** the database's exported `postgresql` and `upgrade` logs now go to log groups Terraform declares (365 days, from the same list the instance exports, created before the instance), and the password-change notifier's group is encrypted; both use a new service-logs key that only the log service may use, and only for those groups. A lost password-change notice (no email on the account, or the send failed) now raises `password-notice-lost` on the audit topic, as the handler's comment always expected. The filter is a term match because Lambda prefixes each line; a test in the notifier package checks it against the lines the handler really writes. **INF-10:** every API log line passes an allowlist of field names before pino writes it; an unlisted field is dropped and named in `droppedFields`, and an error keeps its class, code and frames but never its message, including in the line's text. The two raw `error.message` log calls are gone, and a lint rule refuses new ones. Nothing is applied in AWS; an environment applied earlier must import its existing `/aws/rds/instance/...` groups first ([audit-trail.md](ops/audit-trail.md)).

## Capture race test: time-boxed to its timeout (2026-10-20)

The loaded-host capture race test (added with the capture insert fix below) ran close to its 120 s budget on CI: before it, `lab-reports-capture.e2e-spec.ts` took 5 to 10 s; with it, 96 to 123 s in the PostgreSQL+S3 tier across 13 green runs. Its busy processes stopped themselves after 90 s, so the last batches ran unloaded. In PR #198's run 39370538229 it overran to 133.7 s and timed out. That job later had two unrelated 5 s timeouts and hung after "Jest did not exit" until the 30-minute deadline; this change has not shown that those came from this test. The test now starts no new batch after 60 s (still at most 16 batches of 10 reports, 12 requests each), keeps its busy processes alive for 75 s (at most 40 of them), and a stop timer at 105 s kills them and abandons in-flight requests, so it fails with its own message before Jest's timeout instead of running on. It also fails if fewer than 4 batches complete. On the broken insert it failed in 27 of 35 local runs (9 of 10 on a host loaded so heavily that only 12 or 13 batches fit); on the fixed insert it passed 24 of 24. With the timeouts shortened in a scratch copy, the old test's busy processes ran on for about 20 s after Jest timed it out, while the new test stopped itself and cleaned up first.

## DATA-01 slice 1: the tenant capability exists, inert (draft PR, 2026-10-20)

Migration 0028 (`expand`) adds the issuer-minted, hash-stored tenant capability ([spec](../specs/001-tenant-capability/spec.md), [verification](verification/tenant-capability.md#slice-1-capability-schema-inert-t006t012-2026-10-20)): only the new issuer login can mint, through `tenant_capability_issue`, which re-checks the organization and the membership version and logs every attempt; `app_tenant()` / `app_actor()` resolve a token, and the binding mode is `guc`. No existing policy or function reads it yet, so DATA-01 is still open and the new hostile-login spec says so on purpose. `provision-logins` creates the issuer login only when its secret is configured. The compat lint now accepts a `REVOKE` that only undoes what the same migration created (founder decision). All three backend tiers, the worker, infra and CI-config checks pass locally on Node 22.22.0 with PostgreSQL 16 tools; 8 migration mutants and 4 lint mutants each turn their suite red. No Terraform, AWS or request-path change.

## DATA-01 slice 1: catalog inventory (in progress, 2026-10-19)

The read-only inventory for the tenant capability ([verification record](verification/tenant-capability.md)) counts, from the catalog of a freshly migrated PostgreSQL 16: 48 policies that read `app.current_tenant_id` (30 for the app, 12 for the ledger role, 2 each for redactor, jobs and PUBLIC, plus 2 worker uses), 10 app-callable definer functions plus `security_audit_record` and two actor-reading triggers, and 46 `withTenant` call sites (5 bind an actor). It finds the spec's FR-006 too narrow and the post-restore isolation check dependent on the setting. The capability migration is not written yet: it waits for the founder's review of this inventory. No code, migration, Terraform or AWS change.
## P2 session capability plan published (docs, 2026-10-19)

The [option B plan for P2](design/plans/agentic-session-capability.md), written and evidenced on 2026-10-19 on a local branch, is published unchanged so the DATA-01 spec (`specs/001-tenant-capability/`) can cite it. The DATA-01 decisions the founder accepted on 2026-10-19 adopt this plan's revised D1, D2 and D4 recommendations and its D3 rate-limit approach (P2-02 is not covered); the document is published as written, so its section 3 still reads as proposed. Its non-goal "row-level security reads stay GUC-based" is superseded by that spec, and its closing note that Spec Kit is not bootstrapped predates #173. No code, migration, Terraform or AWS change.
## DATA-01 tenant capability spec (spec only, 2026-10-19)

[Spec, plan and tasks](../specs/001-tenant-capability/spec.md) for replacing the forgeable `app.current_tenant_id`/`app.current_actor` binding with an issuer-minted, hashed capability that every RLS policy and definer function reads through `app_tenant()`, rolled out guc → dual → capability; founder decisions D1–D9 decided 2026-10-19 (the recommendations), plan not yet approved for implementation; no code, migration, Terraform or AWS change.

## Capture insert: a concurrent duplicate is no longer refused (2026-10-19)

Six concurrent identical `POST /reports/:id/capture` requests are meant to give one 201 and five 200s with the same record. On a loaded host one of them could instead get `409 LEDGER_CONFLICT`: the insert named only `report_captures_identity_uq` in `ON CONFLICT`, and a lost race could fail on the table's other unique key (the text object's key, built from the same report, text and Poppler version). The stored data was never wrong (one row and one ledger event every time); only the response was. The insert now names no constraint, so either conflict returns the record the winner stored; a conflict that is not a lost race still fails. The test that exposed it had counted a missing `id` as a second capture; it now checks statuses first. A new test races many reports at once with the CPUs busy: on the old insert it failed in 10 of 15 runs, on the new one it passed 13 of 13. It is probabilistic by nature, so a future regression shows up as a flaky test.

## PGx build prompt gap analysis (plan only, 2026-10-19)

A [draft plan](design/plans/pgx-build-prompt-gap-analysis.md) maps the founder-supplied PGx build prompt (Phases 3 to 5) onto this repository's existing slices and the audit roadmap. It finds the prompt's stack assumptions (Express, BullMQ, PharmCAT as the core, pgvector memory) do not match the repository, that tenancy, auth, queue and audit chain are already built, and that VCF is accepted at intake but only header-checked. It lists three founder decisions (PharmCAT or the in-house engine, an LLM narrative in the clinical path, billing scope) and proposes gap slices, none started. No code, schema, dependency, CI, infrastructure or clinical-content change, and no decision is recorded; the prompt's external claims are unverified.


## Isolated state-probe procedure (offline, 2026-10-18)

The [remote-state probe procedure](ops/terraform-state-probe.md) now specifies
an independent scratch bucket/key with the existing exact-path policy, a
two-client native-lock check, controlled known-version recovery, negative
permission cases, private producer evidence and a protected-resource retirement
decision. It records that the current policy does not grant version listing, so
unknown historical versions are not claimed recoverable. No AWS operation,
backend activation, resource creation, policy change, approval or spend is
included; the founder's account, cost, owner, state and retention decisions
remain gates.


## Nobody merges past the checks (ruleset, 2026-10-19)

From the 2026-10-19 security audit (INF-05). Founder decision, same day: `.github/rulesets/main.json` has no bypass actor, and a pull
request must be up to date with `main` before it merges. `pnpm test:ci-config` now fails if either comes back. The file is the
specification; the live ruleset is updated from it after this merges, and read back. Break-glass is an explicit, audit-logged ruleset
edit ([CI/CD](ops/ci-cd.md#break-glass-no-standing-bypass)). Approvals stay at 0 while there is one maintainer. Applied 2026-10-20 and read back; the API sync also turned on `require_extra_approval_for_unattributed_changes` (a GitHub default for a field the file did not name), which was reverted at once and is now pinned `false` in the file.

## Production refuses unsafe settings (written, not applied, 2026-10-19)

From the 2026-10-19 security audit (AUTH-04, DATA-06, INF-14, FE-04, FE-07). `environment = "production"` now refuses to plan
without `aws_baa_executed = true`, with a database backup window under seven days, or with an `http://localhost` callback or logout
URL. Outside production a callback must still be `https://<host>/<path>` or exactly `http://localhost[:port]/<path>`, so
`localhost.attacker.example` and `user@host` forms are refused everywhere. The ALB uses `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`
(no CBC suites). The frontend publish guard checks the variable the local review build really reads (`VITE_LOCAL_REVIEW_S3_ORIGIN`;
it was misspelled) and refuses local Vite `.env` files. Staging is not exempted from the BAA gate: it stays a human gate there
([Terraform README](../infrastructure/terraform/README.md)). Nothing applied in AWS.

## Evidence cannot be erased (written, not applied, 2026-10-19)

From the 2026-10-19 security audit (findings INF-01, INF-02). Founder decisions, same day: production audit logs are locked in
**COMPLIANCE** mode (a precondition refuses `environment = "production"` with anything else), and every report-file version is locked
for **six years in GOVERNANCE** mode (`reports_lock_days`, floor 2190; one day in the synthetic rehearsal). The reports bucket policy now
refuses an upload that names another encryption, another key or a customer key, and lets the application's header-less uploads through.
The trail moves to advanced event selectors and also records deletes and lock changes in the audit and backup buckets, with two new
alarms (`EvidenceLogDeleted`, `ObjectLockOverridden`). A locked bucket refuses a `PutObject` without a checksum, so a new spec pins that
both application write paths send one. [Audit trail](ops/audit-trail.md), [break-glass](ops/break-glass.md). Nothing applied in AWS;
that S3 accepts the trailing-checksum intake upload on a locked bucket is verified only against the SDK's request, not against AWS.
## Test application loopback listener repair (local, 2026-10-18)

The real test helper now binds its persistent listener to `127.0.0.1`, matching
Supertest's client address. A deterministic macOS reproduction showed that the
previous wildcard IPv6 bind could share its port with another IPv4 listener and
send the health request to that server, returning 404. A permanent regression
first reproduces that failure, then proves exclusive port ownership and the first
health response without retries. All eight existing health cases and the local
PR #161 Terraform candidate remain intact. [Cause and verification scope](verification/test-app-loopback-listener.md).
Fresh full-check evidence belongs to the external delivery report; hosted
acceptance, publication and deployment are not granted by this local repair.

## Knowledge license metadata (schema 1.2, 2026-10-19)

Knowledge files now carry `provenance.license` and `provenance.redistribution` (schema version 1.1 becomes 1.2, a deliberate break: every fixture and test file was updated). A reviewed, non-synthetic file may not say `unknown` for either, enforced by the schema, so the loader refuses it in every mode, and `knowledge:hash` refuses to print a signing hash until both are stated. Fixtures are labelled `proprietary` / `restricted`. This records what a reviewer read from the source; it grants no right, and nothing reads the fields yet (a future knowledge feed would). `knowledge/cpic/` is still empty, so no real file is affected. The reasons are in the [data-model plan](design/plans/pgx-data-model-and-data-products.md) (merged in #179). No runtime, database, CI or clinical-content change.


## Worker settlement fixture review (local, 2026-10-18)

Review of draft PR #167 confirmed a fixture failure-path issue: a cleanup error
can hide the original setup/assertion error and skip later cleanup steps. A
separate branch directly from main carries the settlement-observation repair and
uses the existing fixture disposal helpers to retain all errors and attempt every
step. Three real PostgreSQL fault/lifecycle tests fail on #167's gate and pass with
the repair. [Finding and verification](verification/worker-consumer-settlement.md#pr-167-review-preserve-failures-during-gate-cleanup-2026-10-18).
The complete local worker suite passes 129/129 across 14 files with no skips;
build, typecheck, lint and owned-service cleanup pass.
At the time of this local review, PRs #166 and #167 were separate drafts.
Both later merged into main. This follow-on fixture repair remains subject to its
own exact-head CI; no AWS action is included.

## Migration compat lint (2026-10-19)

PR 2 of the expand/contract plan. From migration 0028 on, every migration must carry `-- compat: expand` or `-- compat: breaking` in its leading comment block, and an `expand` migration may not contain `DROP`, `RENAME`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without a default, `REVOKE`, `TRUNCATE` or `CREATE OR REPLACE` (so redefining a function, or dropping and re-adding a constraint, is `breaking` and is an outage window). The check is `apps/backend/src/db/migration-lint.ts`, run by a backend unit spec in every test tier and in CI, with no workflow change. It does not look at `ADD CONSTRAINT`, unique indexes, data rewrites or row-level-security policy changes, which can still break older code: label those `breaking`. Migrations 0001 to 0027 predate the label and are not checked. The runbook wording and rollback rule are the next slice (PR 3). No runtime, database or Terraform change.


## Foundations runbook readiness (offline, 2026-10-18)

The [readiness gate and decision record](ops/foundations-readiness.md) reconciles
the proposed synthetic rehearsal with current source: bootstrap and backend
activation are separate approvals; main-root stages are A/B/C; task definitions
precede provisioning; hosted uploads use validated API intake; and web-bucket
version cleanup is explicit. CloudFront's `us-east-1` certificate is distinguished
from primary-Region data resources. Account, budget, owner/state custody and the
BAA/manual-session decision remain pending; no exception or live operation is
approved. Terraform definitions/policies, application behavior, CI and production
gates are unchanged. Earlier local-build and plan records below retain their
dated scope. This documentation change performs no AWS access, init, apply,
deployment or teardown and supplies no live-provider acceptance.

## Migration labels and release runbook (docs, 2026-10-19)

PR 3 of the expand/contract plan (readiness tolerance merged in #178). The release runbook now classifies a release by its migrations: with none or only `expand` migrations, old and new tasks overlap and rolling back means setting the previous image; with any `breaking` migration the release is an outage window with no rollback, and a destructive change takes two releases. A manual RDS snapshot before a `breaking` release is recommended, not required. `docs/database.md` gains a "Migration labels" section and loses a sentence that said an older binary refuses even an additive newer migration, which #178 changed. `rollback = true` on the API and worker services is unchanged. Docs only: no code, Terraform, workflow or migration change, and nothing observed in AWS (overlap behaviour, the outage length and the worker's behaviour are unverified).


## Worker consumer settlement observation (local, 2026-10-18)

The separate `fix/worker-consumer-completion-race` branch repairs the process-test
failure found in PR #166 CI. A disposable PostgreSQL gate deterministically
reproduced the original observation of verification rows before terminal job
updates. The test now uses the existing bounded wait for the two report/tenant
jobs to settle, preserving strict success/dead/error and privacy assertions. A
permanent real-process regression captures the held `running` snapshot before
release; a premature-observation mutation fails it. [Cause and verification](verification/worker-consumer-settlement.md).

Focused/restored suites each passed 4/4; the full worker suite passed 126/126
across 13 files, with build/typecheck/lint and owned-service cleanup passing.
No selected full-suite skips or missing-service notices. Runtime, migrations,
permissions, CI and deadlines are unchanged. PR #166 stays a separate draft;
exact-head hosted CI for this fix remains a delivery gate. No AWS access,
deployment or merge is included.

## Ledger start check: full walks no longer block a start (2026-10-19)

From the foundation-layers audit (P1). Every tenant of at most 50 000 events used to get a full walk at start under one shared 20 s budget, so tenants whose chains summed past about 200 000 events made every production start fail with `incomplete` (every deploy and scale-out). The start check now has two steps: the checkpoint check of every tenant (unchanged, still fail-closed, still within `LEDGER_STARTUP_BUDGET_MS`), then full walks of small chains within **half as much time again**, skipping a chain already walked in full. A full walk that does not fit is logged (`ledger-startup-full-walks-deferred`, counts only) and left to the background pass that starts right after; damage found in either step still contains the tenant and refuses a production start. This weakens one guarantee on purpose (a small chain may be checked from its checkpoint only until that pass reaches it), as the founder approved. Unchanged: the verifier, the incident handling, the 1M event cap on a full walk (a separate slice) and Terraform. Proved with a fake-verifier suite and the PostgreSQL tier; nothing observed in AWS. See [ledger-watch.md](ops/ledger-watch.md).

From the foundation-layers audit (P1). A full walk stops at 1 000 000 events and answers `incomplete`, which the monitor logged with the same generic warning as running out of time, so a chain over the limit looked like a wait that would clear. The verifier now says why it was incomplete (`incompleteReason`: `time`, `size` or `shutdown`, present only on an incomplete result) and the monitor writes an **error** line `ledger-chain-over-size` (tenant, mode, events checked) for `size`, while `time` stays a warning. Nothing is latched or contained, the limit is unchanged, and there is no Terraform metric filter for the new line, so nothing pages for it. Resuming a walk across passes remains a later slice. Proved with fake-verifier tests and the PostgreSQL verifier spec; nothing observed in AWS. See [ledger-watch.md](ops/ledger-watch.md).

From the foundation-layers audit (layers 3 and 12, Medium, confirmed). In the worker's file re-check, `check()` caught every error from the store and recorded `unreadable`, so a read cut short by the job's own abort (its timeout, a shutdown, a lost lease) left an append-only `unreadable` row and an `error` line that the file-verified alarm matches, for a file nobody could read. `check()` now throws a retryable `handler-aborted` when the job's signal is aborted, before anything is recorded; a real store error still records `unreadable`. Proved with fake-inspector tests (stored and stale handlers; a control that a completed read is still recorded; the existing real-error test) and one test that the real S3 inspector throws on abort, with five injected defects caught. **Not changed:** the stale-batch SQL that counts `unreadable` as checked (needs a new migration, which the label lint classes as `breaking`), the dead-job alarm gap, Terraform. Nothing observed in AWS. See [jobs.md](ops/jobs.md).

Slice G3.3 of the [gap analysis](design/plans/pgx-build-prompt-gap-analysis.md) (option A, approved 2026-10-19): every gene input the report adapter emits now says where it came from, `callSource: 'lab-report'`, the only source today. It is stored inside the existing `gene_inputs` jsonb, so it is part of the ledger-hashed evaluation record, and it is shown in the evaluation detail's `geneInputs`. **No migration, no projection-version change:** the field is optional in the strict input schema, so evaluations stored before it existed still parse and still verify, and a new value is refused until it is added on purpose. The gap analysis called this slice small; the persisted-column reading (on `evaluation_gene_states`) is a ledger-format decision and was not taken (option B). Not changed: the engine's resolved gene states, the DTO shapes, the knowledge files, PharmCAT. Proved with schema, adapter (all twelve reports and all 28 state combinations), PostgreSQL ledger-tamper and end-to-end tests, with five injected defects caught; nothing observed in AWS. See [cpic-integration.md](cpic-integration.md).

From the foundation-layers audit (layer 2, High, confirmed). `DELETE /patients/:id` checked only that the patient had no reports, so deleting the patient another record had been merged into soft-deleted the target while the merge stayed in force: the merged-away patient stayed hidden from the list behind a patient that was gone, and its unmerge answered 404. The delete now answers `409 patient-has-merged-records` while an approved merge points at the patient (the existing alias-edge function decides, so an unmerged pair, a declined proposal and a pending proposal do not block). The in-memory store has no merges and is unchanged. Proved with two new end-to-end tests on PostgreSQL (the bug reproduced first: the delete returned 204) and five injected defects caught. **Not changed:** deleting a merged-away (source) patient, identifiers left active on a deleted patient (a separate item), the alias SQL, the ledger, migrations. Nothing observed in AWS. See [lab-report-reader.md](lab-report-reader.md).


## PR #161 current-main repair (local, 2026-10-18)

This local candidate retains the published Terraform backend source wiring from `515e249` on main `c49f9d8`, including the existing fixture cleanup and diagnostic support. All six main health cases remain, with the reviewed generated/captured request-ID pair added for eight cases. The captured UUID containing `5432` reproduces the original assertion false positive; correlation data and sanitized diagnostics have separate strict checks. Existing deadlines, response schemas, exact error envelopes and cleanup controls remain. Fresh offline and synthetic PostgreSQL/Moto evidence belongs to the external candidate report. Earlier records are preserved as history, including the separately unresolved patient-link HTTP500 acceptance failure at local `bd9c32c`. No hosted CI acceptance, publication, backend activation, cloud operation or deployment is granted.

## Worker writes no files: pinned (2026-10-19)

A follow-up written into the `/tmp` volume change for the API (#175) said the worker's capture path writes to `/tmp` and might need the same volume. A read of the code found no such writer: the worker's two production handlers import no file, operating-system or child-process module, the only file-writing handler is the queue's test-only one (a production worker refuses to register it), and lab-report capture runs in the API, not the worker. So the worker gets **no** volume (a writable path would be unused surface that hides a fault). Instead the fact is pinned in three places: a source test (`apps/worker/src/boundaries.test.ts`), a real-process test that runs the worker with `TMPDIR` and `HOME` pointing at nothing and completes the file re-check and the scheduled sweep, and a Terraform guard that fails if the worker task declares a volume or a mount. Tests only; no worker, API, Terraform or workflow change. Not proved: how Fargate's read-only root behaves for the worker image (that needs a container engine; the read-only rehearsal slice would cover it).


## FD-7a main-backend source wiring (local, 2026-10-17)

`feat/terraform-backend-wiring`, in a separate clone from main `6371f83`, adds the
partial S3 backend with explicit encryption/native locking and Terraform >= 1.11.
The four-field private config has a placeholder example and ignore rules; permanent
weakening/Git-ignore controls run through the existing infrastructure entry point.
[Design and verification](design/plans/fd7-remote-state.md#main-backend-source-wiring--approved-2026-10-17),
[activation and custody gates](ops/terraform-state.md#main-backend-configuration-source-only).
Fresh offline verification passed 119 infrastructure tests (including 23 new guards),
21 state source guards, 171 policy/mutation cases, 137 CI controls, 33 main-root and
22 standalone mocked plans, plus fmt/backend-disabled read-only-lock init/validate
for both roots; no selected skips. Native outputs, producer exits and final candidate
commit/tree are retained in the originating Codex workspace under
`work/terraform-backend-wiring/`. Bootstrap resources/policies/provider locks, required
CI, application/worker code and protected checkouts are preserved. No push, hosted CI
rerun, merge, backend activation, AWS operation or deployment. Live identity/config,
state inventory/migration, permission/locking/recovery and budget gates remain separate.

## Documentation merge and main acceptance (#162, 2026-10-17)

[PR #162](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/162) merged the reviewed two-file CI documentation update as [c18c503](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/c18c50387573ac727596c070e1b4356fab83991e), whose tree matches published head 808147c. All earlier historical text was retained; application code, tests, profiles, dependencies and the shared service budget were unchanged.

Automatic [post-merge main run 39085190419, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39085190419) passed all six required checks and all ten jobs at the exact merge. Each backend profile accounted for 2,479 tests with its intentional skips; all 125 worker tests passed, including SIGTERM readiness/acknowledgement, drain and release. Six fixture lifecycle controls, including eight construction-failure cases, passed. Four bound completion receipts, twelve producer-file hashes and nine recovery reports were verified, and both all-profile recovery validators passed.

All four service jobs passed deadline checks and stopped containers. The full service path took **14m38s**, leaving **15m22s** within the unchanged shared 30-minute budget; the joining job alone took **2m26s**. Actual hosted cancellation or expiry was not deliberately exercised. See the [#162 runbook record](ops/ci-cd.md#documentation-merge-and-post-merge-ci-162-2026-10-17) for exact counts, timing and limits. Acceptance applies to c18c503; separate feature candidates retain their own acceptance gates. Earlier #160/#159 and local-stage records below remain dated history; no deployment or clinical approval is granted.

## Fixture repair merged and verified (#160, 2026-10-17)

[PR #160](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/160) merged the reviewed fixture repair as [22209af](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/22209afa2e94bddef4926a0c5a61f1b81c8d9ec6), with the same tree as published head `85dbb89`. Automatic [post-merge main run 39081340588, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39081340588) passed all six required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) and all ten jobs. Each complete backend profile accounted for 2,479 tests with its existing intentional skips; all 125 worker tests passed, including SIGTERM health/acknowledgement, drain and release.

All six fixture lifecycle controls, including eight construction-failure cases, passed. Both all-profile recovery validators, four completion receipts, twelve producer-file hashes and nine collected recovery reports were verified; 137 hosted CI controls passed. All four service jobs passed deadline checks and stopped containers. The full service path took **15m12s**, leaving **14m48s** within the unchanged shared 30-minute budget; the joining job took 2m36s. Actual hosted cancellation at expiry was not triggered, and CI acceptance grants no deployment or clinical approval.

Earlier draft [#159](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/159) was closed unmerged as superseded by #160 on 2026-10-17, with a [comment linking the successful main CI](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/159#issuecomment-6243732928). Its branch `fix/fixture-scope-main727-cleanup` remains at `1647e19`. All eight files and complete patches match the repair merged through #160; the original #159 commit was not merged. Its failed CI and earlier local records remain history. See the [#160 runbook record](ops/ci-cd.md#fixture-repair-acceptance-and-superseded-draft-160-2026-10-17) for exact counts, timing, closure evidence and limits. Acceptance is bound to `22209af`; earlier dated sections below are preserved.

## M5.1b-1 internal session write admission (local, 2026-10-16)

`feat/m51b-session-admission`, from fetched main `1da75b1`, extends the transaction boundary with a trusted immutable session binding and a membership-then-session shared lock on the same client, including database expiry after waits. No route accepts a cookie; AuthGuard/provider registration and bearer behavior remain unchanged. No migration, ACL, frontend, runtime-key, dependency, Actions or Terraform main/backend wiring change. [Design](design/plans/m5-1b-1-session-admission.md), [verification](verification/m5-1b-1-session-admission.md).

Fresh focused 210, all three complete backend profiles, worker 123, F2/F3 all profiles, workspace typecheck/lint/build, frontend 142, all 57 F06/F07 probes and 97 browser executions pass. Every profile runs all 70 custody cases plus 53 new permanent admission cases without skips; three deliberate defects are caught with passing controls. PostgreSQL/HTTP tests prove revocation/write order, expiry after both waits, current membership, tenant/subject binding, pool/timeout failure, raw-transfer cleanup and refusal to pin a stored object after revocation. The browser bridge and genuine old-API 404/cached-UI compatibility remain intact. Later b-2/b-3 login, cookie/CSRF/generation/configuration and M5.1c frontend/same-origin work remain open. Local evidence is not hosted or exact-head CI acceptance; no publication or deployment command.


The 12 subsequent review probes are now permanent in the admission PG spec, retaining all prior cases: 65 b-1 admission cases plus 70 M5.1a cases = 135 session cases. Fresh focused PostgreSQL and PostgreSQL/S3 runs each pass 222/222 with no skips or missing-service notices; backend typecheck and lint pass. The self-revocation rollback control checks the same session cookie. Runtime code is unchanged, and cookie auth remains disabled. Full-profile, worker, browser and build results above remain historical for the earlier test set. Protected sources and references are preserved; no Actions/main wiring or publication/deployment.

A subsequent local synchronization adopts `34d6093` (PR #150) through a merge preserving published fdc2687/e728811. CI and preparation helpers match main exactly; application/tests and cookie auth are unchanged. STATUS retains both histories; only SESSION_STATE required manual resolution, retaining dated provenance. Fresh focused PostgreSQL and PG/S3 runs each pass 222/222, including all 135 session cases. Typecheck, lint, 111 CI controls, eight workspace controls, four workflow controls and actionlint pass. Exact-head hosted acceptance remains unrun for this unpushed merge. No CI rerun, GitHub merge, backend deployment or independent Actions/main wiring edit was performed. See the existing b-1 verification record.





## sprintf-js tooling remediation (local, 2026-10-17)

The separate `fix/sprintf-js-toolchain` candidate removes all 55 dev-only Jest paths to the unpatched sprintf-js advisory with a parent-scoped js-yaml 4.3.2 override. The full unfiltered candidate audit exits 0 with zero advisories; Jest/instrumentation versions, all test/coverage settings and all six required CI gates are unchanged. Five regression controls, pinned-runtime local builds/checks, all three real-service backend profiles and worker tests pass. [Cause, scope, results and acceptance limits](verification/sprintf-js-security.md). This remains local and unpublished; default-branch alert closure and exact-head hosted CI remain pending the authorized PR/merge flow. Earlier dated records below remain historical.

## Dependabot esbuild resolution repair (local, 2026-10-17)

The separate `fix/dependabot-esbuild-security` candidate addresses the hosted esbuild `security_update_not_possible` failure at main `e19e61a`. tsup 8's `^0.27.0` constraint excluded the advisory fix; a narrow pnpm override requires `^0.28.1`, resolving 0.28.2 without upgrading other build tools. The esbuild advisory disappears from the candidate audit; the unpatched `sprintf-js` advisory remains visible and the whole audit still exits 1. [Cause, scope and acceptance limits](verification/dependabot-esbuild-security.md). Local build/test compatibility results are recorded in Obsidian. All existing CI/security checks and deadlines remain unchanged; hosted candidate acceptance, default-branch merge/rescan and the separate sprintf-js remediation remain open. No merge or deployment occurred.


## PR #155 watchdog observation repair (2026-10-17)

The PostgreSQL fixture repair in draft PR #155 now incorporates main `59d478b` without rewriting published history. Its first hosted run passed the service profiles, joining gate and new fixture controls but exposed a watchdog test race: successful SIGKILL dispatch was mistaken for synchronous process exit. The [observation repair](verification/watchdog-exit-observation.md) requires actual SIGKILL exits within the existing finite helper and retains late-work cleanup checks. Delayed-delivery reproduction and a suppressed-KILL negative control distinguish the race from failed cleanup. Watchdog behavior, deadlines, profile coverage and required gates are unchanged. Exact refreshed-head hosted acceptance is pending; no merge or deployment is authorized.


## FD-7a reconciliation with current main (local, 2026-10-17)

The separate `feat/fd7a-required-ci-main` candidate now starts at freshly verified main `efb6103`, retaining the local `2fbc1b3` candidate intact. Current-main status/runbook history and all earlier FD-7a records are preserved; the earlier assembly/base statements below remain dated historical records. The approved Terraform payload and CI bytes are unchanged. Fresh local acceptance again passed 171 policy/mutation cases, 21 state guards, 22 standalone plans, 33 main-root plans, 96 infrastructure tests, 59 focused/131 full CI controls and 8 workspace/4 workflow controls with no selected skips. Both roots passed fmt/backend-disabled read-only-lock init/validate and actionlint passed. The final protection proof covers the prior 11 protected checkouts plus preserved `2fbc1b3`. [Verification](verification/fd7a-required-ci.md#local-reconciliation-with-current-main--2026-10-17). Hosted exact-head CI, assembled-candidate review, backend wiring and live AWS acceptance remain open. No publication, hosted CI dispatch/rerun, cloud operation or deployment is authorized by this local reconciliation.

## FD-7a mandatory CI assembly (local, 2026-10-17)

The separate `feat/fd7a-required-ci` candidate assembles the approved delivery `aec888e` with mandatory coverage in the existing required `terraform` job. Both roots now require fmt, backend-disabled/read-only-lock init, validate and every mocked plan; the standalone source guards and fresh policy producer are mandatory too. Exact Node 22.22.0 / Terraform 1.16.5 pins, all six required check names and the 15-minute Terraform cap remain. Service profiles, joining/evidence gates, cleanup, cancellation and their shared 30-minute budget are unchanged.

Local acceptance passed 171 policy/mutation cases (145 original + 16 promoted + 10 mutations), 21 source guards, 22 standalone plans, 96 existing infrastructure tests and 33 main-root plans; CI controls passed 131/131, including 59 focused workflow controls, with no selected skips. Both roots passed fmt/init/validate; workspace/workflow controls and actionlint passed. Resources, fixtures, provider locks and all approved probes remain identical to `aec888e`. [Verification and limits](verification/fd7a-required-ci.md) distinguish these local results from hosted CI and live AWS acceptance. The earlier records below remain historical snapshots. No hosted CI dispatch/rerun, backend activation, push, PR, merge, apply or deployment is part of this local slice.

## FD-7a standalone state bootstrap (local, 2026-10-16)

`feat/fd7a-current-main` preserves the implementation from `feat/fd7a-state-bootstrap` (`40700c7`) and adds the independent state bucket/key root, explicit owner/Region/retention inputs, exact state/lock permissions, native mocked plans and source weakening controls. [Runbook](ops/terraform-state.md). Built and verified locally; no resources created. Main backend wiring and Actions coverage are separate follow-ups owned outside this slice; no push, PR or deployment. Both F06/F07 source branches and the combined reference are preserved.

Fresh local verification against main `7987a68` passed all 145 policy probes and 10 mutation checks, 21 source guards, 22 standalone mocked plans, 96 existing infrastructure tests and 33 main-root mocked plans; both roots passed fmt/validate. No selected tests skipped. State implementation and permanent probes match `40700c7`; all current-main status sections are preserved. Mandatory standalone-root Actions coverage and exact-candidate CI remain publication gates.

### Delivery refresh from current main (2026-10-17)

`feat/fd7a-delivery` starts directly from main `c12c47a`, preserving original `40700c7` and integration `3243fef`. All ten standalone files, including the 145 policy probes and ten mutations, remain byte-identical. Fresh local verification passed 155 policy/mutation cases, 21 source guards, 22 standalone mocked plans, 96 existing infrastructure tests and 33 main-root mocked plans; both roots passed fmt, backend-disabled read-only-lock initialization and validate. No selected tests skipped. Current main status and both prior session records are retained. Actions and main-backend wiring remain unchanged; mandatory state-root CI coverage is still owned by the other session. No push, PR, merge, cloud apply or deployment.

The 16 subsequent review probes are now permanent in the existing policy suite: 145 original permission cases plus 16 promoted cases and ten unchanged mutations, **171 tests total**. Exact comparison preserved every promoted request and expectation, the original evaluator/cases and all mutations. Fresh verification passed 171 policy/mutation tests, 21 source guards, 22 standalone plans, 96 existing infrastructure tests and 33 main-root plans; both roots passed fmt, backend-disabled read-only-lock initialization and validate. No selected tests skipped. Terraform resources, variables, outputs, fixtures and provider locks are unchanged. The CI handoff is prepared externally in this task and has not been sent; mandatory Actions coverage and live acceptance remain open. No Actions/backend wiring changes, push, PR, merge or deployment.

## CI documentation merged and verified (#151, 2026-10-17)

[PR #151](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/151) merged as [c12c47a](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/c12c47a7e3865ffec7cdbaa7844aafa4b003041b), preserving reviewed documentation head `2f879fa`'s tree. Only this status file and the CI runbook changed from #150's accepted main snapshot; application code, tests, profiles, cleanup and the shared budget are unchanged.

Automatic [post-merge main run 39031051513, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39031051513) passed all six required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) and all ten jobs. All three complete backend profiles ran 2,409 tests each with unchanged intentional skips; all 123 worker tests passed. Counters and passing suite filenames match #151's [pre-merge PR run](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39030205342) and accepted #150 main. All nine recovery aggregates, both all-profile validators and 111 hosted Linux CI controls passed with zero control failures/skips.

The full service path, including setup, transfers, the joining gate and teardown, took **13m23s**, leaving **16m37s** of the original shared 30-minute budget. All four service jobs passed bootstrap/live-watchdog and final clock checks; normal teardown logs record PostgreSQL container removal and Moto termination. Actual GitHub `Runner.Worker` cancellation at expiry was not triggered. CI acceptance grants no deployment or clinical approval.

See the [#151 runbook record](ops/ci-cd.md#documentation-merge-and-post-merge-ci-151-2026-10-17) for profile counts, job timing, exact deadline and evidence limits. The #150 acceptance record and earlier dated captures below remain historical records.

## Service CI merged and verified (#150, 2026-10-17)

[PR #150](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/150) merged as [34d6093](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/commit/34d6093962d3d029aa3c6a4d8ec6be9b652a0c78), preserving reviewed head `7c35fe3`'s tree. Automatic [post-merge main run 38995941825, attempt 1](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38995941825) passed all six required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) and all ten jobs. The [successful PR run](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38994847278) is separate pre-merge evidence.

All three complete backend profiles ran 2,409 tests each with their existing intentional skips, and all 123 worker tests passed. Counters and passing suite filenames match the pre-merge evidence. All nine recovery aggregates and both existing all-profile validators passed; the hosted CI configuration suite passed 111 controls with zero failures/skips. Linux executable-permission and filesystem-freshness repairs retain process identities, executable-verified runner ownership and refusal of stale evidence.

The main run completed the entire service path in **13m58s**, leaving **16m02s** inside the original shared 30-minute run-attempt budget. All four service jobs passed bootstrap/live-watchdog and final clock checks; normal teardown logs record PostgreSQL container removal and Moto termination. Native hosted controls cover detached children, Moto handoff and bounded watchdog-error shutdown. Actual GitHub `Runner.Worker` cancellation at expiry was not triggered; pre-bootstrap platform provisioning cannot be cancelled by workflow code. No deployment or clinical approval follows from CI acceptance.

Earlier drafts [#146](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/146) and [#148](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/148) were closed as superseded by #150 on 2026-10-17. Their branches, `fix/ci-service-test-prerequisites` and `fix/ci-service-lifecycle`, remain at `9904bd1` and `8af0b59`. The prerequisite producer and previous controls are preserved or adapted in #150; #146's initial verification note remains in its PR/commit history. See the [CI runbook's acceptance record](ops/ci-cd.md#merged-acceptance-and-superseded-drafts) for profile counts, timing and evidence limits.

The dated local entries below preserve earlier capture states, including their then-pending hosted acceptance and runtime investigation. Historical verification records remain unchanged.

## Isolated service CI and deadline supervision (local, 2026-10-16)

`fix/ci-service-lifecycle` starts from main `1da75b1` and carries the unpublished candidate from `3f91713`, including PR #146’s unchanged prerequisite producer. Original `bd9b6cb`/`3f91713` checkouts and refs and the draft PR remain untouched. Three complete backend profiles still feed the required joining gate and whole worker profile. The [lifecycle repairs](verification/ci-service-lifecycle.md) preserve Moto after successful setup and bound worker shutdown after watchdog errors. Every existing test file, profile script, runtime pin and clock rule remains unchanged. Local checks pass: 94 CI controls, eight workspace controls, the actual detached reader and three defect injections. Hosted Linux cancellation, real service acceptance and runtime comparison remain unrun. No publication, CI run or merge is authorized.

## M5.1a browser-session custody (local, 2026-10-16)

`feat/m51a-session-custody`, originally branched from main `7987a68`, adds encrypted session custody, migration 0026 and a tenant-scoped PostgreSQL repository. No auth route, cookie, frontend or runtime provider is enabled. The approved clock repair adds migration 0027 without editing earlier migrations: immediate database-stamped revocation tolerates a fast application clock, and expiry is rechecked after the share lock using database time. Both review reproducers are permanent; finite-timestamp/INSERT privileges and atomic downgrade refusal until expired cleanup add two further cases. All 54 session cases and all 34 catalog role/order probes passed in each profile: totals 2,140/2,372/2,392 passed with 253/21/1 expected skips and no missing-service notices. Focused 107, migration/restore 137, worker 123, F2/F3 across all profiles and typecheck/lint/build passed. [Design](design/plans/m5-1a-session-custody.md) and [verification](verification/m5-1a-session-custody.md). Original FD-7a and its current-main candidate, F06/F07 sources and combined reference are preserved. M5.1b/c auth/CSRF/browser integration remains open; no Actions/main backend wiring, push, PR, merge or deployment.

The 16 subsequent clock review probes are now permanent in `browser-session-clock.pg-spec.ts`: focused 123/123 passed, including all 70 session cases, 19 catalog cases and 34 role/order probes. A second same-cluster run passed all 16, proving reusable fixture-role setup. Backend typecheck/lint passed. This test-only follow-up preserves production code and migrations; full-profile results above remain historical for the prior 54-case suite, rather than fresh acceptance of all 70. No publication or deployment.

## Catalog policy guard correction (local, 2026-10-16)

`fix/catalog-guard-role-matching`, from main `62675ca`, corrects the catalog test's role-prefix collision: role arrays remain arrays, complete role names are matched, and policy order cannot select the independent verifier as the tenant-scoped ledger role. The 18 new regression controls share the real guard's assertions. [Verification](verification/catalog-guard-role-matching.md) records focused PostgreSQL acceptance and the wider local checks. No database permissions, runtime behavior, Actions, main-backend wiring or deployment changes; FD-7a, F06/F07 and the combined reference are preserved.

The 16 additional review probes are now permanent in the same spec, for 34 assertion tests. Fresh focused verification passed all 34 plus 19 real PostgreSQL catalog tests (53 total), backend typecheck and lint. Two isolated defect controls failed as intended. S3/full-profile/worker/recovery checks were not rerun for this test-only follow-up; their earlier evidence remains separately identified. No publication or deployment is authorized.

After #142 merged, #143's main merge at `efe7dc9` retained duplicate inline assertions alongside the array-based helper. Its serialized-role comparison failed typecheck and the real catalog test. A local repair on `fix/catalog-guard-duplicate-assertions` removes only that redundant block, preserving all 34 probes and the shared tenant/SELECT safeguards. The original failures were reproduced; fresh 53/53 focused tests, typecheck and lint pass. This repair is not pushed; Actions/main wiring and protected references remain unchanged.

## Browser logo readiness (2026-10-16)

The interpretation-preview browser test now targets the authenticated workspace header before measuring its logo. The prior page-wide locator could capture the retiring site-header image during sign-in and return a null bounding box. The original minimum width and all other assertions remain intact; no product, auth, branding, CI or deployment behavior changes. The [verification record](verification/workspace-logo-readiness.md) separates the observed CI failure, controlled handoff/refusal probes and repeated original-scenario results.

## Repository engineering workflows (2026-10-16)

Seven [repository-scoped engineering workflows](engineering/workflows.md) adapt a pinned Addy Osmani agent-skills revision for planning, implementation, debugging, verification, review, measured optimization and release-readiness assessment. Existing working agreements and the query protocol remain authoritative. The [verification record](verification/engineering-workflows.md) separates deterministic routing checks and synthetic walkthroughs from independent model or hosted acceptance. No runtime, clinical, database, CI gate, cancellation or deployment behavior changes.

## CI dependency caching (proposed, 2026-10-16)

The founder approved compiler/dependency cache improvements while preserving all six required checks and the policy that main runs are never cancelled. The [plan and verification](verification/ci-dependency-caching.md) cover setup-go's gitleaks inputs, a Playwright-version browser key, Docker dependency layers and a scoped BuildKit cache. Database tests, recovery profiles, scan commands, image attestations and deployment behavior are unchanged. Local and remote verification results are recorded there; no merge or deployment is authorized.

## F07 publication candidate (local, 2026-10-16)

`fix/f07-download-cors-publication` starts from current main `6f2ddaa`, after F06 PR #131 and the FD-7 documentation PR #132 merged. It ports F07 from `a4ca244`, including all **38 promoted origin probes**, the shared GET-only storage policy and parity in both the owned and older review launchers. The real-storage browser bridge from `60f1795` verifies recovery through reload and same-caller sign-in to an exact-version download. Both source integration branches and the combined reference remain preserved. The [F07 verification record](verification/f07-download-cors.md) defines the candidate checks and separates earlier evidence from fresh results recorded externally. No push, PR, Terraform apply or deployment is authorized by this local preparation.

## F06 merged with PR #131 (2026-10-16)

Main `11f9157` contains the approved `b668f02` F06 content and all **19 promoted recovery probes**. Independent page/session retirement, verified caller/tenant binding, the original one-hour deadline, roles-only `/me`, separate recovery capability and genuine-404 memory-only compatibility remain unchanged by F07. See the [F06 verification record](verification/f06-upload-recovery.md). Earlier local-only wording below describes historical captures; cached JavaScript still needs refresh to obtain these safeguards. Merged code is not hosted acceptance.

## Catalog test: exact role match (draft PR, 2026-10-16)

CI run 322 on `main` (the S1 merge commit) failed one test of 2,304 in the PostgreSQL tiers: `test/db/ledger-catalog.pg-spec.ts:169`. The test found the ledger role's policy with `roles.includes('telesphoros_ledger')`, a text match that also matches `telesphoros_ledger_verifier` and `_operator`; those policies read `USING (true)`, and `pg_policies` has no guaranteed row order, so whenever a verifier policy came first the assertion saw `true` instead of `app.current_tenant_id`. The same code passed on re-run and on every other run. The lookup now matches the role exactly. Reproduced locally by forcing the verifier policy first (the original assertion fails with CI's exact diff; the fixed one passes), and the whole spec passes (19 of 19) on PostgreSQL 16. Test-only: no product code, migration, workflow or other test changed. Separate from the `database-and-storage` runtime drift towards its 30-minute limit, which is still open. No deployment.

## Landing S2: hero composition (draft PR, 2026-10-16)

Second slice of the [landing alignment plan](design/plans/landing-alignment.md), approved by the founder on 2026-10-16 with the plan's defaults. The hero is now copy on the left and a still, code-drawn synthetic report card on the right (`HeroReportCard`), over a code-drawn backdrop of two soft folds and an A/C/G/T sequence (`HeroBackdrop`) ported from the public site's Product first hero. The card reuses the fictional records and status wording of the capability fragments; it is `aria-hidden`, has nothing to operate and adds no copy beyond a header and the existing "Synthetic data only. Not for clinical use." line. Colours come from tokens only (no literal colours or inline styles, so `check:brand` passes unchanged), nothing in the backdrop moves, and forced colours hides it. Mobile and tablet stack the card under the copy. The particles are kept: in the before and after screenshots they read as a quiet depth layer around the card, not a duplicate of the backdrop. One token added (`--landing-fs-hero`); copy, palette, fonts, artwork and `branding-policy.json` are unchanged. Local checks: typecheck, lint, `check:brand`, 359 unit tests (3 new), the landing and foundation browser specs (30 cases, axe included) and the production build. The full browser suite relies on CI. Slices S3 (EN/ES parity) and S4 (token names) are not started. No deployment or merge.

## Landing S3: English and Spanish (draft PR, 2026-10-16)

Third slice of the [landing alignment plan](design/plans/landing-alignment.md), approved by the founder on 2026-10-16 as option (a): the landing's current English is the source of truth and the Spanish is written from it. All landing text now lives in one typed module, `apps/frontend/src/lib/landing/landing-copy.ts` (`en`, moved over word for word, and `es`). A button in the landing header (`LanguageToggle`) switches the whole page, including its header, footer, skip link, sign-in label and the interactive walkthrough; the page is **English by default whatever the browser language**, the choice is kept in `localStorage` when it exists and lasts for the session when it does not, `<html lang>` follows it, and leaving the landing restores English. The dashboard, upload and every other page stay English. Tests: a unit test that both languages have identical entries, no empty text, and every boundary statement in both (synthetic data only, not for clinical use, no medication or dose recommendation, verification is not clinical review); a browser spec that Spanish is never the default, changes the page, passes axe, fits at 375 px, survives a reload, returns to English, works with storage blocked and does not leak onto other pages. **The Spanish is a draft and has not been reviewed by a Spanish-speaking reviewer: the PR must not merge before that review.** The role name in "Signed in as …" stays as the system's English identifier. Page titles stay English. S4 (token names) is not started. No deployment.

## Landing S1: the watermarked DNA image is retired (draft PR, 2026-10-16)

First slice of the [landing alignment plan](design/plans/landing-alignment.md), approved by the founder on 2026-10-16. `particle-dna-reference.png` carried a watermark and its publication rights were never established; `telesphoros-site` and `cuadradozayas-site` had already retired the same bytes (SHA-256 `2e4c1dcf…`). The image, its provenance note, the hero element, its CSS and the two unused tokens are removed; the policy pin is replaced by a `retiredAssets` list (policy version 2); and `check:brand` now hashes every shipped file of any type and rejects retired artwork under any filename (3 new mutation tests, 27 in all, plus a real negative run with a renamed copy). No replacement art was added; slice S2 decides the hero. The image remains in git history (not purged). Dashboard, other pages, palette and the two site repositories are unchanged. No deployment.

## Dashboard sidebar and guided workflows (local, 2026-10-15)

`feat/dashboard-guided-workflows` adds sidebar navigation, a wide Prompt Kit chat on its existing development route, native drawers for report metadata and bundled synthetic evidence, and compact chat controls. Guided upload, retained inputs and explicit page-local report filters are included. Existing SDK/transport, backend, roles, recovery, clinical gates, branding and public landing remain unchanged. Final checks: 309 frontend tests, 24 brand rejection tests and lint/typecheck/build/chunk checks. The sidebar revision passed 118 browser cases across three profiles; the later Prompt Kit refinement received targeted desktop/mobile browser checks. See [verification](verification/dashboard-guided-workflows.md) and [approved plan](design/plans/dashboard-guided-workflows.md). PR #129 merged on 2026-10-15; the following results describe its local verification capture. Its two browser failures were isolated to a report/chat scenario in the default feature-off profile; the corrective configuration retains that guard and requires an explicit owned-storage development profile. The navigation helper also awaits the rendered header before checking the mobile menu. Final local browser profiles: 122 passed with CI=true and one worker, plus ten mobile sign-out repetitions. No deployment, real data or database/clinical acceptance.

## Launcher CORS reconciliation (local, 2026-10-15)

`fix/launcher-cors-current-main` carries PR #105's launcher regression controls and Moto pin validation onto main `7bf283a`, which already contains the merged #116 worker-cap test repair. The original #105 branch remains at `25ddb18`; its historical failed CI run has not tested this replacement. Both launchers retain their current policies: owned GET/HEAD and older review PUT. The five native controls cover actual child environments, the owned worker handoff and real-origin refusal/success. See [coverage verification](verification/launcher-cors-regression-coverage.md). #111 and F06/F07 branches remain unchanged. This reconciliation is local; no push, merge or deployment.

## Delivery snapshot and capability boundaries
## Upload navigation recovery retirement (local, 2026-10-15)

`fix/upload-navigation-retirement` fixes F06-R01 independently from main `301b035`: upload page exit retires started progress so late responses/bodies cannot replace newer recovery or continue abandoned work. Recovery remains available for retry/reload and acknowledged cancellation. Reviewed F06 `cf10828` and F07 remain frozen; their changes are not included. Local verification passed 299 frontend tests, 50 desktop/mobile auth/upload/navigation browser cases and a disposable F06 composition (322 frontend tests, 60 browser cases). Both weakened browser controls reproduced the original overwrite. See [verification](verification/upload-navigation-retirement.md). No push, PR, merge or deployment.

## Local launcher CORS controls (local branch)

`fix/local-launcher-cors-parity` disables Moto's global CORS fallback in both the owned storage runner and the older review launcher's explicit child environments. Native browser probes reproduce the excluded-origin failure before the change and require refusal plus success after allowing that same real origin after the change. See [verification](verification/local-launcher-cors.md). F06/F07 remain frozen and separate; integration of the older launcher's PUT-only rule with F07's shared GET contract is deferred until F07 reaches main. No push, PR, merge or deployment.
## Patient setup guidance (local branch)

`fix/patient-setup-guidance` corrects the upload page's empty-roster handoff to a clinician and the existing Refresh patients control. Patient creation remains the authorized clinician-only API workflow; this slice adds no patient-create screen or permission. See [setup guidance](ops/patient-setup.md). F06/F07 remain frozen; no push, PR or deployment.

## M2.3c the worker's deployment (built locally, stacked on M2.3b, not yet a PR)

Main `4400efa` contains the M2.1 and M2.2 slices plus M2.3a merged with [#100](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/100), and M2.3b/c merged with [#101](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/101). Both final PR heads report all seven CI checks successful. That is merged-code evidence, not AWS deployment or clinical acceptance. Original verification documents retain their dated local-run results; stale stacked/local wording there describes their capture time. See the [build capability matrix](product-capabilities.md) and [documentation verification](verification/delivery-docs-current-main.md).

F06 (`b47fe84`) and F07 (`47d75cd`) remain separate, frozen local fixes. Phase A launcher (`24f9f52`) and patient-guidance (`093ddc6`) fixes are also local and independent; this documentation branch includes neither runtime change. No push, PR, merge or deployment is authorized by this snapshot.

## M2.3c the worker's deployment (merged with #101)

Third and last slice of the approved [M2.3 plan](design/plans/m2-3-jobs-outbox-worker.md) ([verification](verification/m2-3c-worker-deploy.md), [runbook](ops/jobs.md#deployment-m23c-written-never-applied)). **Terraform written, never applied** (`worker.tf`, off with the API's switch): a worker task and service on the API's cluster from the **same image** (`node worker/main.js`; the Dockerfile now also builds the worker bundle), no load balancer and no inbound traffic, a read-only task role (get an exact object version under `reports/*`, decrypt through S3, nothing else), an execution role that reads only the worker's own secret, its own log group and key. Four alarms to the audit topic: a dead job, a failed stored-file check, a queue that is not draining (oldest ready job over 15 minutes, twice running) and a stale worker heartbeat. `provision-logins` now creates a **fourth login** (`telesphoros_job_worker`, member of `telesphoros_worker` only) with its secret and reads its privileges back. Migration 0025 changes `job_stats` so a suspended organization's held jobs do not age the queue. The worker logs a `queue-stats` line a minute. Tests pin the Terraform text (`worker.guard.test.mjs`, with weakened-copy controls), hand its environment to the worker's own loader and run its alarm patterns over the worker's own log lines (`deploy-contract.test.ts`). **Hosted acceptance remains open:** worker provisioning/startup, scheduled effects and delivered alarms have not been established here. The final #101 CI image job passed its build and synthetic rehearsal; no local container-engine or AWS result is claimed.

## M2.3b the outbox and the first two consumers (merged with #101)

Second slice of the approved [M2.3 plan](design/plans/m2-3-jobs-outbox-worker.md) ([verification](verification/m2-3b-outbox-consumers.md), [runbook](ops/jobs.md)). Migration 0024. Every upload commit now writes a `report.file-committed` event **inside its own transaction** (`outbox_append`); the worker relays events into jobs in one transaction that also marks them (`outbox_relay`), and `files.verify-stored` re-reads the **pinned object version**, compares size, type and SHA-256 with the report and records an append-only `file_verifications` row; a missing version or changed bytes ends the job dead (a finding; nothing is repaired or deleted). `files.verify-stale` (daily) re-checks reports not checked for 30 days. `uploads.sweep` (hourly per organization) is now one database function shared with the operator command `uploads sweep`; the application login can no longer run it. The worker still holds no table: each consumer function proves the caller holds a running job of the right type before acting for that job's organization. A suspended organization's jobs are made but held. **Deviations** (no Nest context yet; the relay is a database function) are in the plan. Deployment configuration, alarms, image target and worker login followed in M2.3c and are on main. Actual hosted execution remains separate.

## M2.3a the job queue, the worker and the system-actor rules (merged with #100)

First slice of the approved [M2.3 plan](design/plans/m2-3-jobs-outbox-worker.md) (DJ-1 to DJ-9 answered yes on 2026-10-14; [verification](verification/m2-3a-queue-core.md), [runbook](ops/jobs.md)). Migration 0023 adds a PostgreSQL job queue (`jobs`, append-only `job_attempts`, `job_schedules`, `job_workers`) behind `SECURITY DEFINER` functions: leases and heartbeats, retry with backoff (60 s, 5x, capped at an hour, +-20%), dead letters, a per-organization cap, suspended organizations' jobs held, and idempotent scheduling by slot. Payloads are flat ids and codes and errors are short codes, **enforced by CHECK constraints**. New `packages/jobs` (contracts) and `apps/worker` (claim loop, drain, health, scheduler; plain Node; M2.3b supplies the registered stored-file and upload-sweep job types). A background job acts as `system:<job type>`, which is **never a person**: refused by the database on every human-decision table and on memberships, and by token verification and the membership command. New operator command `jobs status|list|dead|show|retry|cancel`. **Outside this original slice, now supplied by M2.3b/c on main:** the outbox and the two real consumers (M2.3b), Terraform, alarms, the worker login in `provision-logins` and the image target (M2.3c). Deviations from the plan are listed in the plan. An existing deployment must run `provision-logins` before applying 0023 (it now grants the migration login the queue's owner role). The M2.x dependencies merged with #100; current CI and hosted acceptance are distinguished above.

## M2.2c browser reload recovery (merged with #100)

Third slice of the approved [M2.2 plan](design/plans/m2-2-durable-intake.md) ([verification](verification/m2-2c-reload-recovery.md)); closes audit finding A08. Frontend only. The tab keeps one `sessionStorage` record of an in-flight upload (report id, registration key, original declaration, last attempt state, file type, name, size and SHA-256; never the bytes, a token or the patient); after a reload the upload page offers to finish it (same patient and file again: no second report, original declaration replayed, no second transfer) or cancel it through the server; it is cleared on verification, on an acknowledged cancel and on sign-out. Also fixes a leftover of M2.2b: Cancel and Start over no longer depend on the build flag. Backend untouched. **Not built:** a screen listing past interrupted uploads, recovery across tabs or after the tab closes, any change to what the server does with attempts nobody resumes (the operator sweep remains). The scoped caller/tenant and one-hour safeguards of F06 remain a separate local repair; main recovery and cached bundles do not acquire them from this documentation update.

## M2.2b the direct-upload path is retired (merged with #100)

Second slice of the approved [M2.2 plan](design/plans/m2-2-durable-intake.md) ([verification](verification/m2-2b-retire-legacy-upload.md)). The validated intake is now the **only** way a report file reaches the bucket: `POST /reports/:id/upload-url` and `/complete`, the presigned-upload capability and `UPLOAD_URL_TTL_SECONDS` are deleted (the old routes answer 404), and the product upload page and the local review page send the bytes through the API in every build. Lab PDFs are gated on the pipeline at declare, send and resume. A source-level test pins that only a committed attempt can set `uploaded_at`. New operator command `uploads sweep` closes abandoned attempts and returns their quota; it deletes nothing from the bucket ([ops/report-upload.md](ops/report-upload.md#abandoned-attempts-operator)). The application's Terraform policy gains `s3:ListBucketVersions` and `s3:ListBucketMultipartUploads` on `reports/*` (written, guard-tested, never applied). Requester and uploader are now always the same person for an intake report. **Kept, and an open question for the founder:** the disposable local-run scope (the rehearsal harness in `scripts/local-storage` depends on it; the plan had said it would go) and `VITE_REPORT_STORAGE_ORIGINS` (still needed for signed download links). Browser reload recovery followed in M2.2c and is on main; F06 safeguards remain local.

## M2.2a validated intake in the organization scope (merged with #100)

First slice of the approved [M2.2 plan](design/plans/m2-2-durable-intake.md) (DI-1 to DI-7 answered yes on 2026-10-14; [verification](verification/m2-2a-organization-intake.md)). The validated intake (`POST /reports/:id/upload-attempts`, `PUT …/bytes`, `resume`, `cancel`, `GET …/upload-state`) now works **without a disposable local run**, in any mode, in the organization's own scope: keys `reports/<tenant hash>/<report id>/intake/<attempt id>`, an inventory per report, a 100 MiB reservation quota per organization, bounded structural validation **before** any bucket write, and a lab PDF only while the pipeline is on. A file it refuses is recorded as a security event (`intake.rejected`, migration 0022: reason code only). The legacy routes were retired in M2.2b (above); the local-run scope remains. The Terraform listing permissions it needs were added in M2.2b. The frontend switch/operator sweep followed in M2.2b and browser reload recovery in M2.2c; those slices are on main.

## M2.1a tenant registry and member administration (merged with #100)

Slice M2.1a of the [M2.1 plan](design/plans/m2-1-onboarding-patient-identity.md) (decisions DP-1 to DP-6 answered yes on 2026-10-13; [verification](verification/m2-1a-tenants-member-admin.md)). Migration 0019 adds a `tenants` registry (a membership must name a registered organization; a suspended one is refused on every request), an `invitations` record (a keyed digest and a masked hint of the address, never the address) and four `SECURITY DEFINER` functions through which an organization's **administrators** change roles, remove people and record or cancel invitations: own organization only, never themselves, never the last administrator, one change at a time per organization. The API login still has no write privilege on any of these tables. **`admin` is now administration only** (DP-1): it reads and writes no clinical data (patients, reports, recommendations, captures, evaluations, disputes, file links); `GET /ledger/verify` stays `admin`; a person who needs both holds both roles. Routes: `GET|PUT|DELETE /members`, `/members/invitations`. Operator commands `tenant create|list|suspend|activate` and `invite list|fulfil` ([ops/membership.md](ops/membership.md#organizations-and-invitations)); the API still creates no Cognito account (DP-2). Production now requires `INVITATION_DIGEST_KEY` (a new secret container in Terraform, nothing applied). Member-administration screens and hosted onboarding acceptance remain separate. M2.1b/c and the M1 authority/security dependencies are on main.

## M2.1b patient identifiers and a verified report link (merged with #100)

Slice M2.1b of the [M2.1 plan](design/plans/m2-1-onboarding-patient-identity.md) (DP-4 and DP-5 answered yes on 2026-10-13; [design note with the key-custody section](design/plans/m2-1b-identifiers-and-patient-link.md), [verification](verification/m2-1b-patient-identifiers-link.md), [operator notes](ops/patient-identifiers.md)). Migration 0020. A clinician registers a clinic's identifier for a patient (`POST|GET|DELETE /patients/:id/identifiers`); only a **keyed digest** is stored (HMAC-SHA-256 under a key derived per organization from one master secret, `IDENTIFIER_DIGEST_KEY`, required in production, a new secret container in Terraform, nothing applied), never the value, and no response, log or event carries it. A second person (a clinician or reviewer who did not register or upload the report; never an `admin` alone) records that the report's **exact file version** belongs to its patient (`POST /reports/:id/patient-link/decisions`), by matching an identifier read off the report or by a coded attestation; the decision is a **ledger record** (`report_patient_decisions`, event type `patient-link-decision`). `POST /reports/:id/evaluations` is refused (409 `patient-link-unverified`) until the report's current file has a latest decision of `verified`, checked before the reader and again inside the storing transaction; a replaced file is unverified again. The gate lives in the evaluations service plus the transaction re-check, not a table trigger (a test pins that nothing else creates evaluations). Quarantine/duplicate/merge APIs followed in M2.1c and are on main. The product workflow, general identifier extraction and key rotation remain separate.

## M2.1c-1 wrong-chart quarantine (merged with #100)

First half of the approved [M2.1c plan](design/plans/m2-1c-wrong-chart-and-duplicates.md) (DQ-1 to DQ-8 answered yes on 2026-10-14; [verification](verification/m2-1c-1-quarantine.md)). No migration and no new table. A report is quarantined when its newest patient-link decision names the file and patient it holds now and says `rejected`; the state is derived. A quarantined report's evaluations stop being `current`, every evaluation read shows `advisory.patientLink` (`verified`, `unverified`, `rejected`; evaluations made before M2.1b read as `unverified`), and `GET /patient-link/quarantine` (reviewer only, pipeline on) is a work list of quarantined reports that still have an active evaluation, to be retracted with `wrong-patient` by a person. Nothing is corrected automatically; a report cannot be re-pointed (upload it again under the right patient). The SMART stored-PGx preview now also requires `patientLink: verified`. A product quarantine-review screen remains open; duplicate review and merge APIs are on main in M2.1c-2.

## M2.1c-2 duplicate review and merge (merged with #100)

Second half of the approved [M2.1c plan](design/plans/m2-1c-wrong-chart-and-duplicates.md) ([implementation note](design/plans/m2-1c-2-duplicates-and-merge.md), [verification](verification/m2-1c-2-duplicates-merge.md)). Migration 0021. A `409 identifier-in-use` now also leaves a **possible-duplicate flag** (`patient_duplicate_flags`: one row per unordered pair, a system code and who hit it, never a number or digest); `GET /patient-duplicates` lists the pairs not yet reviewed. A clinician or reviewer **proposes** a merge or an unmerge (`POST /patient-merges`) and a *different* person decides it (`POST /patient-merges/:id/decision`); both are **ledger records** (`patient_merge_proposals`, `patient_merge_decisions`, event types `patient-merge-proposal` and `patient-merge-decision`). A merge is **derived**, not applied: an approved merge makes the source an alias of the target, no `patients`, `reports` or `evaluations` row is rewritten, and an approved unmerge of the pair ends it. Reads resolve the group: `GET /patients` hides merged-away patients unless `includeMerged=true` and carries `mergedInto`; the `patientId` filter of reports, evaluations and recommendations means the whole group; an identifier registered on any patient of the group verifies a report's link (0021 widens the M2.1b trigger and foreign key for this); new reports and identifiers on a merged-away patient are `409 patient-merged`. The database refuses an impossible merge at commit under the ledger lock (SQLSTATE `PM001`; reasons `same-patient`, `patient-gone`, `source-merged`, `target-merged`, `source-has-aliases`, `not-merged`), and groups are **one level deep** (a documented difference from the plan's bounded recursion). A declined merge dismisses the pair. Merges need the ledger, so they are PostgreSQL-only (503 otherwise); flags work in memory too. Not built: any screen (M3.2), chains of aliases, a pre-merge view (retention, M0/T01). Its M2.1 dependencies are on main.

## Product landing refresh (draft PR, 2026-10-14)

The approved landing page uses self-hosted Inter, the Poppins wordmark, teal branding, original static diagonal DNA and the unchanged companion mascot. It includes role-aware account actions, a synthetic Upload / Check / Find walkthrough, current feature descriptions, FAQs and the founder-approved direction “Working toward less trial-and-error prescribing,” distinguished from today's storage-only preview. No clinical interpretation or prescribing claim is added.

Reconciled the committed landing work with `origin/main` at `41d019d` (including PRs #94–97). Only this status document conflicted; current backend, membership, audit, schema and permissions are preserved exactly. Earlier uncommitted dashboard contrast and AI welcome edits remain in the original checkout and are outside this PR. Reconciliation checks passed: 264 frontend tests, 64 standard and 26 DEV browser cases, 46 in-memory permission tests, lint/build and production-exclusion guards. See [verification](verification/telesphoros-landing.md).

The founder approved the separate [Vercel visual preview](https://telesphoros-site-ogws77vab.vercel.app), based on landing commit `353ac60`. Its packaging has no sign-in, upload, assistant or backend access and is not part of this repository change. The existing production deployment and domains were verified unchanged. This reconciliation does not redeploy or promote anything.

## FD-7 slice 4: staged variables and plan-review checklist (merged, #123, 2026-10-15)

Fourth and last Phase 1 slice of the [staged synthetic deployment plan](design/plans/fd7-staged-synthetic-deploy.md). `infrastructure/terraform/synthetic-staging.tfvars.example` (placeholders only, the approved `staging.telesphoros.app` convention, `synthetic` profile, both hosting switches on) is planned offline by a new `staging.tftest.hcl` in three stages, and `staging.guard.test.mjs` keeps the example equal to that test's values, inside the staging envelope, and checks the one coupling the module does not enforce (`api_domain` must be `api.<web_domain>`, because the web page's policy allows exactly that host). [staging-plan-review.md](ops/staging-plan-review.md) lists what each real plan must and must not contain, quick `grep` checks, stop conditions and the billable items to price. **Found while building it:** there is no plan with both hosting switches off (the database can only name the API tasks' security group, which exists only with API hosting on), so the first plan and apply already include the API edge and wait for its certificate's DNS record; the plan's Phase 2 is corrected. Proved offline: `terraform test` (4 runs; 17 with the existing 13), the guard with 20 injected defects, `terraform fmt` and `validate`. **Not proved:** anything in AWS, and cost. No default, guard or existing example changed.
## FD-7 slice 1: the API image registry (merged, #120, 2026-10-15)

First build slice of the [staged synthetic deployment plan](design/plans/fd7-staged-synthetic-deploy.md) (founder approved D1 to D3 and AES-256). `registry.tf` adds one ECR repository and its lifecycle policy behind `enable_api_hosting` (immutable tags, scan on push, AWS-managed AES-256, the last 10 images kept, `force_delete` only under the `synthetic` profile) and the output `api_repository_url`; [image-push.md](ops/image-push.md) is the runbook (build linux/amd64, push, read the digest from the registry, then set `api_image`). Before this, `api_image` was validated and the execution roles could pull from the repository it names, but nothing created the repository. Proved offline: `terraform fmt`, `validate`, `terraform test` (the registry is absent by default and under the profiles' hosting runs present with the expected settings), a new text guard with 14 injected defects, and the profile ratchet extended for `force_delete`. **Not proved** in AWS: that a push works, that the execution roles can pull the pushed digest, that the lifecycle rule expires images, and cost. Nothing is applied; the Dockerfile, CI, task definitions and IAM are untouched.

## FD-7 slice 2: frontend publish (merged, #121, 2026-10-15)

Second build slice of the [staged synthetic deployment plan](design/plans/fd7-staged-synthetic-deploy.md). `scripts/staging/publish-frontend.sh` builds the production frontend and uploads it to the web bucket from a person's shell: a dry run by default, `--yes` to upload; it refuses missing, placeholder, non-https or loopback settings, a path on the API address and the local-build flags, leaves out source maps and Vite's `.vite/` manifest, checks that the bundle carries the settings it was told to use, uploads hashed assets first and `index.html` last, deletes nothing, and fails if a `*.map` is in the bucket. `web.tf` gains the output `web_distribution_id`. [frontend-publish.md](ops/frontend-publish.md) is the runbook. One plan detail changed: the distribution uses `CachingDisabled`, so the invalidation is optional (it runs only when the id is given). A hosted build still has no `/reports` dashboard (it is mounted only in the loopback owned-storage build); that is a product decision outside this slice. Proved: 10 script tests against a stand-in `aws` (including injected defects), the application's own `loadAuthConfig` accepting what the script accepts, `terraform fmt`, `validate` and `test`, and one real production build through the dry run. **Not proved:** the real AWS CLI against a real bucket, IAM, or the site behind CloudFront. Nothing is applied or published.

## FD-7 slice 3: the one-off task runner (merged, #122, 2026-10-15)

Third build slice of the [staged synthetic deployment plan](design/plans/fd7-staged-synthetic-deploy.md). `scripts/staging/run-task.sh` starts the existing migration or provisioning task with a command override (`provision-logins`, `migrate-up`, `migrate-status`, `tenant-create`, `tenant-list`, `membership-grant`, `membership-show`), waits, prints that task's log and exits 0 only if the container did; dry run by default, `--yes` to run. Values are checked against the application's own rules before anything starts, free text reaches the container as data, and destructive steps are not offered. `api-compute.tf` gains three outputs (`api_task_subnet_ids`, `api_task_assign_public_ip`, `api_service_name`); no task definition, role or secret changes. [staging-rehearsal.md](ops/staging-rehearsal.md) gives the order and what each step must print. **Found while writing it:** setting `api_image` creates the API and worker services at once, before the logins and schema exist, and `api_desired_count` cannot be 0, so the first bring-up has failing tasks until the one-off steps are done; the runbook says so and the decision is left open. Proved: 9 script tests against a stand-in `aws` (the tests found and fixed an empty-role bug), cross-checks against the CLI, roles, organization-id rule and Terraform, `terraform fmt`, `validate` and `test`. **Not proved:** ECS accepting the arguments, the tasks starting, RDS, or the described service behaviour. Nothing is applied.

## M1.5 live membership and revocation (merged, #95)

Who may do what now comes from a PostgreSQL membership table read on **every** protected request, not from the token ([auth.md](auth.md#authority-and-revocation), [plan](design/plans/m1-5-live-membership-revocation.md), [verification](verification/m1-5-live-membership-revocation.md)). Removing a person, changing their roles or revoking their sessions (operator command `db membership`, [ops/membership.md](ops/membership.md); there is no API route for it) takes effect on their next request on every API instance. A lookup failure is a 503 and does no work. Every request-driven write re-checks the caller's membership row inside its own transaction just before commit, so no write commits after a removal does. Migration 0017 adds `tenant_memberships` (read-only to the API login, rows never deleted). Cognito still proves identity and MFA. DA-1 and DA-2 were decided yes on 2026-10-13; refusing reads to members with no role (I04) is the separate M1.5b. Not part of this change: browser sessions and the logout endpoint (M5.1) and the append-only membership event trail (M1.6). Proved against a fake identity provider and a local PostgreSQL; not real Cognito or RDS, and nothing is applied in AWS. The first deployment starts with nobody granted.

## M1.4 no-store responses and tenant logs (draft PR)

Founder asked to start M1.4 of the [audit build plan](design/plans/repo-audit-and-build-plan.md). Every API response, including 401, 403, 404, 429 and the health and readiness probes, now carries `Cache-Control: private, no-store` from one middleware registered before routing; the authenticated browser request wrapper also sends `cache: 'no-store'`. Request-completion and failure logs now carry `tenantId` from the verified principal (never from a header or query) next to `userId`. Tests failed on the unchanged code and pass after the change; a header-sourced tenant is caught by a control. See the [plan](design/plans/m1-4-no-store-tenant-logging.md) and [verification](verification/m1-4-no-store-tenant-logging.md). Closes research-audit E06 and O02 at synthetic scope; the audit event store (M1.6), live revocation (M1.5) and hosted/CDN behavior (T13) remain open. No schema, authorization, retention or clinical-gate change.

## M1.5b members with no role cannot read clinical records (in review)

Closes finding I04 (decision DA-1, decided yes on 2026-10-13): the eleven clinical read routes (`GET` list and by-id for patients, reports, recommendations, evaluations and cell disputes, and `GET /captures/:id`; the audit listed nine) now require a role. A member who holds no role can still sign in and call `/me`, and gets 403 everywhere else. Any role qualifies, `reviewer` included, because reviewer-only people already capture and evaluate on their own and the reviewer browser persona reads the same lists; if the founder wants reviewer to be refused alone, change one constant (`auth/clinical-read.ts`). A test walks the real route table so a new route that forgets `@Roles()` fails. Plan: [m1-5b-no-role-reads.md](design/plans/m1-5b-no-role-reads.md); evidence: [verification](verification/m1-5b-no-role-reads.md). Proved locally; the pull request's checks are the remote record. The frontend is unchanged: a member with no role who opens the reports page gets the page's generic error, not a dedicated message.

## Landing polish, slice A (draft PR, 2026-10-15)

Founder approved the [plan](design/plans/ui-polish-landing-and-dashboard.md) (P1 to P6 as recommended). Slice A changes the product landing only: a five-step type scale held in tokens (`--landing-fs-*`), 16px running text, headings within two lines at 1440, 768 and 390, consistent section spacing with a tone step instead of a divider for two sections, and a transform-only scroll entrance (`useLandingMotion`) with control feedback and a full reduced-motion fallback. The approved brand elements, copy, DNA, mascot, fonts and `branding-policy.json` are unchanged and the DNA and mascot are never animated. Measured with the taste-skill inspector: 11 FAIL / 4 WARN before, 7 FAIL / 3 WARN after; every remaining FAIL is a decision kept under P1/P2 (eyebrows, 01/02/03, gradient, hairlines, no archive pictures) or the shared Button's approved sheen. Local checks: typecheck, lint, `check:brand` with its 24 mutation tests, 291 unit tests, 74 standard browser cases (axe included), chunk and foundation guards. DEV, local-review and owned-storage browser suites were not run (no change to those screens). Slice B (Reports and upload) has not started. See [verification](verification/ui-polish-landing.md). No deployment, merge or clinical change.

## Vercel design previews, frontend only (draft PR, 2026-10-16)

The founder decided that only the frontend is previewed on Vercel; the product stays on AWS (FD-7 and the hosting map unchanged). The founder also asked whether Vercel offers a BAA: as understood, yes on paid plans, but it would cover only Vercel, so a backend there would need several agreements instead of one with AWS. That is one reason the backend stays on AWS.

What is added (see the [plan and verification](design/plans/vercel-frontend-preview.md)):
- a root `vercel.json` (frozen pnpm install, single-page fallback, `noindex` and basic security headers);
- `build-vercel-preview.sh`, which discards inherited `VITE_` settings, builds with placeholder `.invalid` sign-in and API hosts, and publishes no source maps;
- a guard test with 11 injected defects.

A clean-clone build with hostile inherited settings leaked nothing. Not yet verified: a real Vercel build. The founder imports the repository as a new `telesphoros-previews` project behind Vercel Authentication; the agent's Vercel connector was refused (403) when creating projects. No application, backend, Terraform, DNS or `telesphoros-site` change.

## Landing motion and drawn visual elements (merged, #127, 2026-10-16)

The founder kept the approved landing design after reviewing alternative taste-skill sketches, asked for motion and visual elements so the page looks less static, and approved the [plan](design/plans/landing-motion-and-visuals.md) with "go, use your recommendations" (M1 to M6). Built on the product landing only:

- the headline's two lines rise out of their own masks on load;
- a code-drawn particle field in the hero and, faintly, the closing; it settles on load, then drifts only with the scroll, so nothing moves on its own for more than five seconds;
- a scroll cue that nudges three times;
- walkthrough transitions: a travelling step marker, the file card settling, checklist rows in order with a third "File digest" row labelled fictional, and the details panel sliding in;
- three code-drawn, `aria-hidden` interface fragments in the capability rows (patient to file, a file status list, a sample assistant exchange ending on "Sample response. Not connected to your reports.");
- row-by-row entrances for capabilities and FAQ, and FAQ answers that settle in.

Motion is transform only on text (opacity only on decorative dots) and is gated behind `is-motion`, so no script, old browsers and reduced motion all get the complete still page. The DNA and mascot never move. New tokens live in `tokens.css`; no layout, copy (other than the labelled fictional samples), palette, font, artwork, permission, route or backend changed. The taste-skill inspector counts 118 moving elements at 1440 (19 before) with no new FAIL or WARN. Checks and limits: [verification](verification/landing-motion-and-visuals.md). No deployment, merge or clinical change. The company page is still outside this repository.

## Planned: staged synthetic deployment in AWS, FD-7 (plan only)

Requested 2026-10-15 ("wire Telesphoros app to go live"), narrowed with the founder to a staged environment with **synthetic data only**. The [draft plan](design/plans/fd7-staged-synthetic-deploy.md) uses the existing `synthetic` Terraform profile, the FD-4 provisioning command and image, and the written hosting checklists; names what is missing (an image registry and push runbook, a frontend publish runbook, a seeding task for organizations and members, remote state, a budget alert); orders a founder-run apply with an acceptance and destroy phase; and lists decisions D1 to D8. The founder approved the direction and D1 to D3 on 2026-10-15 (D1 and D2 values still to be supplied; D3 corrected to the module's base-domain rule, `staging.telesphoros.app`) and asked to start Phase 1; the four Phase 1 slice plans are in the plan and each slice needs its own go before code. A real production launch with patient data stays blocked on the executed BAA and its own plan. Nothing is approved, applied, published or deployed, and no AWS credential is used.

## Planned: remote Terraform state backend, FD-7a (plan only)

The [draft plan](design/plans/fd7-remote-state.md) covers the one Phase 0 item that is still code: an encrypted, versioned, access-restricted S3 backend with native locking, in its own small Terraform root so that destroying the staged environment cannot delete the state. All four FD-7 Phase 1 slices are merged (#120 to #123), so this is the next buildable piece; the rest of FD-7 waits on the founder (D1 account and Region, D2 budget ceiling, D6 testers, D8 after the rehearsal). D7 was approved on 2026-10-16. Nothing is built, applied or run, and no AWS credential is used.

## Where the repositories, Vercel projects and addresses live (docs only, 2026-10-16)

[domains-and-hosting.md](ops/domains-and-hosting.md) now has one table of the product repository, the `telesphoros-previews` and `telesphoros-site` Vercel projects, the company site and their addresses, and records that no DNS is configured for `telesphoros.app` in Cloudflare yet and that `www.telesphoros.app` is attached to the Vercel `telesphoros-site` project although the address map promises a CloudFront redirect. Decided later the same day (founder): the `telesphoros-site` Vercel project owns `www.telesphoros.app`, and the founder then added the DNS-only Cloudflare CNAME that makes it live (Vercel reports it configured; confirmed in a browser). The founder then chose the apex as the primary name (option B): a DNS-only Cloudflare CNAME `@`, the apex attached to the project, and `www` redirecting to it with a 308, all confirmed in Vercel and in a browser; the page's existing apex canonical URL already matches, so the site needed no change. Open: the optional mail-guard records and the dormant Vercel DNS zone's leftover records; see the address map. This repository changed nothing in Vercel, DNS or AWS.

## Planned: repository audit and build plan (plan only)

A [draft audit and build plan](design/plans/repo-audit-and-build-plan.md) maps every workspace, CI job and feature on `b292d07`, re-checks the 12 October research audit against current code (R02 and R03 closed by #86 and #81; E04, A08 and R11 partly addressed; I03, I06, E06, O02, A03, O06, R05, R06 still open), lists new doc-drift and scaffold gaps, and orders the remaining backlog into slices. Install, typecheck, lint, build and tier-1 tests passed locally. Founder decisions DA-1 to DA-6 are open; nothing is approved or built by it.

## Reports and Upload polish, slice B (draft PR, 2026-10-15)

Slice B of the founder-approved [UI polish plan](design/plans/ui-polish-landing-and-dashboard.md) (decisions P1 to P6 as recommended; slice A, the landing, is a separate PR). Presentation only, inside the shared tokens, components and branding policy. Reports: the patient filter is one row (select, icon refresh, icon clear) with a quieter patient pager, so all five rows of a small result are visible at 1280×800 where three or four were; the patient is shown per row only while the list is not filtered to one patient; a calm selected-row marker; an icon beside the upload status word; the details panel leads with the upload state on a status surface, then the fields. Upload: a two-column layout with a short "Before you upload" aside (new copy, for founder review), tighter patient controls, a checkbox aligned to its label, a white card to match Reports, and a success page with real buttons. Every accessible name, role, permission, route, download and upload behavior is unchanged; the compact development layout of the details panel renders the same as before. Local checks: typecheck, lint, `check:brand` and its 24 mutation tests, 295 unit tests (4 new, one proved by defect injection), production build with chunk guards, 74 standard and 26 DEV browser cases, and the owned-storage suite against real PostgreSQL and Moto: 28 passed and 1 failed. The failure is `version-pin.spec.ts`, which fails identically on unmodified `main` (a stale "Next reports" selector; follow-up suggested separately). See [verification](verification/ui-polish-reports-upload.md). No deployment, merge or clinical change.

## Prompt Kit explanation development preview

Founder approved a synthetic-only Prompt Kit preview and further component/design iteration. The local report-detail link opens an authenticated, DEV/127.0.0.1-only workspace with fictional context, bounded sample conversations, simulated tool/step activity, explanation-basis/source disclosures, feedback, local attachment metadata, source-image zoom, loading/shimmer and working latest-message controls. The distinct shield/Rx product logo is restored in the shared header. Existing brand tokens and permissions remain; no report content, API/model requests, persistence or clinical processing is added. The route and preview runtime code are excluded from production. See the [approved scope](design/plans/prompt-kit-interpretation-preview.md) and [verification/screenshots](verification/prompt-kit-interpretation-preview.md). Final checks: 258 frontend tests, 58 production-browser and 26 DEV-browser cases, lint/typecheck/build and production-exclusion guards passed. The [SDK review](design/prompt-kit-sdk-review.md) compares official OpenAI SDK and Vercel AI SDK capabilities. The approved Vercel AI SDK continuation uses real `useChat` with an in-memory synthetic stream, cancellation and regeneration; SDK modules are excluded from production assets/source maps. Prepared for draft PR review; no live provider, deployment, clinical approval or remote CI acceptance claimed.

## Modern reports dashboard and shared branding

Follow-up dashboard loading and interaction polish includes report-shaped skeletons, reduced-motion rendering, clear-filter and recovery actions, followed by three founder-requested button/layout iterations. Shared buttons now have a clear primary/secondary/utility hierarchy, 44px minimum targets and consistent interaction states; report panels, toolbar, mobile filenames and metadata grouping were refined. Core brand colors/fonts remain, with neutral panel/elevation/size tokens added. See the [scope](design/plans/reports-loading-interactions.md), [initial verification](verification/reports-loading-interactions.md) and [final design record](verification/reports-design-refinement.md). The 229 frontend units, build/typecheck/lint/chunk guards and all 26 owned-storage browser cases passed. Permissions, API/schema and clinical/development boundaries are unchanged; no deployment or remote CI acceptance is claimed.

Final shared-button regression also passed 56 standard and 18 DEV browser cases, for 100 passing browser cases across the three suites. The disposable owned stack was removed after verification.

The founder approved the researched dashboard sketch for implementation on current main after the owned-storage browser/operations slices. The existing opt-in reports screen now has a bounded patient-filtered list, desktop detail panel, mobile list/detail navigation and native technical disclosure. It retains the existing verified attachment downloader and upload/read/download roles. Shared tokens, Poppins headings, full-name company endorsement and the square/genome company symbol carry through the frontend and local SMART pilot typography. See the [plan](design/plans/reports-dashboard-modern.md) and [verification](verification/reports-dashboard-modern.md). Backend, schema, authentication/tenant policies, owned-storage admission, clinical gates and DEV route boundaries are unchanged. Prepared for draft PR review; local evidence does not claim remote CI acceptance, deployment or clinical approval.

## Planned: Soup training pilot (plan only)

A [draft plan](design/plans/soup-pilot.md) proposes a dev-only pilot of [Soup](https://github.com/MakazhanAlpamys/Soup) (Apache-2.0, Alpha, pinned v0.76.0) as a synthetic-only section classifier for lab-report text, measured against a rule-based baseline on a hand-labelled set. It needs founder decisions D1 to D5 before any environment, data, model download or training. Nothing is installed or run, and the reader, engine, API, database and AWS are untouched.
## T02 strict migration readiness (merged, #81)

Founder approved the focused readiness fix with strict version/checksum matching and subsequently authorized commit and draft PR delivery. Readiness now delegates to the existing migration-history validator and rejects checksum drift and unknown newer versions, with generic 503 responses and unchanged liveness. Real PostgreSQL regressions demonstrated both defects before the fix; all three backend profiles passed locally. See [verification](verification/t02-readiness.md) for completed checks and limits. Broader old/new schema compatibility and G01 acceptance remain separate. Merged as #81; its `main` CI run passed. Deployment is not authorized.

## M1.6 security-event audit store (in review)

An append-only `security_events` table (migration 0018) records who changed membership (a trigger, in the same transaction as the change), why a valid token was refused (best effort, throttled). The application role has no privilege on the table; only the auditor role reads it, through `db security-events list`. Closes audit finding I06 and the security half of T04. Plan: [m1-6-security-events.md](design/plans/m1-6-security-events.md); evidence: [verification](verification/m1-6-security-events.md); runbook: [ops/security-events.md](ops/security-events.md). `main` also has the application access audit below (`security_audit_events`), which records every file link; founder decision 2026-10-14: keep both tables and record each act once, so file links are recorded there only. Proved locally against PostgreSQL and Moto; not real Cognito or RDS, and no off-site copy of the record.

## T04 application access audit (focused PR)

The separate `feat/local-access-audit` branch adds append-only API authentication, private-read and report download-link events with restricted PostgreSQL access and fail-closed private reads. See the [event contract and limits](ops/application-access-audit.md). This is synthetic local verification only: the unmerged T03 membership branch has a conflicting migration number, and operator membership events, true IdP sign-in, hosted custody, retention and G05/G09 acceptance remain separate. No merge or deployment is claimed.

## Final synthetic OpenEMR workflow acceptance

An explicit local acceptance command now connects real OpenEMR chart launches and SMART OAuth/PKCE to the built reader/viewer, actual API, restricted PostgreSQL role and versioned Moto PDFs. It verifies source download, correction rechecks, offline clearing/revocation, explicit replacement selection, missing-source refusal and an unconsented second chart. Connector reads leave evaluation/ledger counts unchanged. See the [plan](design/plans/synthetic-workflow-acceptance.md), [runbook](ops/synthetic-workflow-acceptance.md) and [verification](verification/synthetic-workflow-acceptance.md). This completes the planned synthetic integration sequence; clinical validation, hosted-service acceptance and production release remain open. No retention, clinical gate or production behavior changes.

## Synthetic correction history and stale views

The local SMART viewer now shows verified selected-evaluation correction metadata and withholds genomic/PDF content when existing evidence gates fail. It rechecks evidence every 15 seconds, clears it before revalidation, and enforces a 30-second freshness cap measured from server read start. Hidden/offline views, failed/expired checks and chart changes clear content and revoke PDF blob links; late responses cannot restore it. See [plan](design/plans/synthetic-correction-history.md), [runbook](ops/correction-history-preview.md) and [verification](verification/synthetic-correction-history.md). No backend writes, retention or clinical gate changes; no push/atomic-snapshot guarantee.

## Shared dependency build coordination

Workspace typecheck/test now finish one prerequisite-library build phase before running parallel consumers; recursive build uses pnpm’s topological graph without nested dependency rebuilds. Standalone backend/pilot commands retain their prerequisite builds. This fixes overlapping clean builds observed after #70 without serializing checks, disabling cleaning or changing clinical/retention settings. See [plan](design/plans/shared-build-race.md) and [verification](verification/shared-build-race.md).
## Authorized synthetic source PDF

The local SMART reader can opt into the existing authorized pinned-version download link, verify PDF bytes/version/size/digest against the accepted source, and embed them in the FHIR preview. The viewer offers a local synthetic PDF download. See [plan](design/plans/synthetic-source-pdf.md), [runbook](ops/source-pdf-preview.md) and [verification](verification/synthetic-source-pdf.md). No backend route, retention or clinical gate changes; no EHR writes or deployment.

## Stored synthetic PGx reads

The OpenEMR pilot can now opt into fresh, explicitly bound reads of stored synthetic evaluations through existing authorized API routes. It checks patient/tenant/principal identity, acceptance/correction/dispute state and source metadata, and never falls back to static fixtures on failure. The source is metadata-only unless the optional PDF retrieval above is configured. See [plan](design/plans/synthetic-stored-pgx.md), [runbook](ops/stored-pgx-preview.md) and [verification](verification/synthetic-stored-pgx.md). No production route, schema, retention or clinical-gate change; no real data or deployment.

## L1 owned synthetic storage API

The founder approved L1 plus intake/cancellation refinements and the explicit legacy compatibility boundary. The branch adds bounded validated PDF/VCF/JSON intake, immutable upload attempts/revision CAS, exact-version attachment access and conservative owned compensation libraries. See [API](design/local-storage-intake.md) and [verification](verification/local-storage-intake.md). The full local three-tier regression and final negative controls passed. Merged as #77. New owned-mode apps keep clinical processing disabled. L2 browser transport merged as #79 ([verification](verification/local-storage-browser.md)), and the L3 local operational runner, reconciliation and teardown merged as #80 ([runbook](ops/local-storage-operations.md), [verification](verification/local-storage-operations.md)); both are local and synthetic only. AWS upgrades, production scheduling, spending, agreements and production use remain deferred.

## Synthetic versioned PGx FHIR preview

The isolated OpenEMR pilot now maps explicitly selected synthetic evaluation/source versions into a core FHIR R4 collection preview. It preserves source bytes and SHA-256, interpretation/knowledge/engine identities, and patient-bound references; stale, held, retracted, disputed or unconsented results are withheld without fallback. See [mapping contract](fhir-cds-hooks.md), [plan](design/plans/synthetic-pgx-fhir.md) and [verification](verification/synthetic-pgx-fhir.md). This is not a production FHIR/IG adapter or clinical interpretation. No EHR writes, retention changes or clinical gate changes.

## Restore-test scheduling

The [restore-test scheduling investigation](design/plans/restore-test-scheduling.md) addresses shared PostgreSQL contention in CI: service-backed Jest runs now use one worker, while unit-only runs keep the default parallelism. Test deadlines, assertions and concurrency exercised within each suite are unchanged. See [reproduction and verification](verification/restore-test-scheduling.md) for measured stress results and the limits of attributing the original runner timeout. Retention, clinical gates and production recovery behavior are untouched.

## Genomic storage documentation corrections

The [genomic storage guidance](genomic-storage.md) applies the [source evaluation](verification/genomic-storage-report-evaluation.md): separate legal retention requirements from product policy, preserve source reports alongside structured PGx results, and correct compression, licensing and HIPAA claims. This is documentation only; retention values, clinical gates, application behavior and infrastructure are unchanged. Unverified statistics and jurisdiction-specific requirements remain explicitly unresolved. The evaluation retains real workstation evidence links and adds repository-relative navigation for GitHub readers.

## Local synthetic OpenEMR SMART pilot

A separate development package, `@telesphoros/smart-pilot`, ports the synthetic read-only OpenEMR rehearsal from the deleted gateway repository onto this codebase. It validates chart launch, signed clinician identity and exact patient-bound FHIR reads; a standalone viewer displays synthetic fixtures and withholds genomic content without fixture consent. It does not call the clinical engine or mount routes in the production API. See [plan](design/plans/openemr-smart-pilot.md), [runbook](ops/openemr-smart-pilot.md) and [verification](verification/openemr-smart-pilot.md). No clinical approval, real data, AWS deployment or broader SMART integration is claimed.

## Current frontend foundation closure

Phase 0 skeleton accepted by founder on 2026-10-09. Phase 1 closure merged as PR #50, with all seven CI checks passing; the founder confirmed the merge. It adds local-screen field errors/focus, shared token controls, mobile/keyboard checks, separate form-component files and all-page chunk guards. That closure left standard product upload as a browser-only sample stub; its later transport slice is tracked below. Clinical logic and hosting were untouched. Evidence: [Phase 1 closure](verification/phase1-closure.md). No later phase is marked complete by this change.

## Current Phase 2 closure

The founder approved three separate slices: API privacy/input boundaries, bounded evaluation/dispute lists, then batched evaluation context reads. All three merged as PR #51, #52 and #53 with all seven checks passing. The final slice batches the selected page's acceptance/correction context; real PostgreSQL query count stays at 21 statements for pages of 1, 20 and 100 records. Internal complete dispute reads remain separate from public pages. See [pagination verification](verification/phase2-review-pagination.md), [batching plan](design/plans/phase2-evaluation-context.md) and [batching verification](verification/phase2-evaluation-context.md). Whole-Phase-2 founder acceptance remains open. Existing API/storage/auth code is not a claim that all later foundation phases are complete. No deployment, clinical approval or spending is authorized by these slices.

## Phase 3A database integrity

Founder approved the revised local/synthetic plan on 2026-10-10. PR #54 merged engine-enforced recommendation/report/patient agreement in separately committed NOT VALID/validation migrations, extended catalog acceptance and measured real repository query plans under the application role. Any historical mismatch stops validation without rewriting records; operational remediation needs a separately approved script. Its green database check masked two failed migration tests; merged #55 fixes pipeline exit propagation and isolates colliding fixture logins. Inspected #55 database logs have zero failures across all three tiers (1,511 / 1,692 / 1,693 passed); all seven checks passed. Its first image attempt failed during PostgreSQL setup; an image-only retry on the same head passed, without proving that initial setup cause resolved. See [plan](design/plans/phase3a-data-integrity.md) and [verification](verification/phase3a-data-integrity.md). Full Phase 3 acceptance remains open for product upload, report-file recovery and live provider/scheduler/drill evidence. Nothing is deployed or approved clinically.

## Phase 3B backup discovery

Founder authorized this continuation with “go” on 2026-10-10. Incomplete backup listings now throw `IncompleteBackupListingError`; latest recovery aborts before object reads, temporary files or restore execution instead of choosing from a truncated window. PR #56 merged after all seven CI jobs passed; inspected database tiers passed 1,531 / 1,712 / 1,713 with zero failures. Local boundary controls, emulator pagination and PostgreSQL/S3 regressions are recorded in [verification](verification/phase3b-backup-discovery.md); see the [scoped plan](design/plans/phase3b-backup-discovery.md). This does not accept all Phase 3.

## Phase 3C current-schema recovery rehearsal

PR #57 merged after all seven exact-head CI jobs passed. Inspected database tiers passed 1,537 / 1,718 / 1,719 with zero failures or actual missing-service notices. The built format 2 CLI restored a populated synthetic DB into a fresh PostgreSQL cluster, checked catalog/privileges/ledger and recorded exact dataset bytes with timings. See [plan](design/plans/phase3c-recovery-rehearsal.md) and [verification](verification/phase3c-recovery-rehearsal.md). Pinned PDFs and captured text were checked on primary storage; independent report copies and complete application recovery remain false. This is not production-scale RTO or live-provider/custody acceptance.

## Phase 3D1 report registration retries

Founder approved this prerequisite to standard product upload on 2026-10-10. Optional request keys make report metadata creation retryable per tenant and creator, with immutable original-input fingerprints, concurrent PostgreSQL uniqueness and soft-delete reservations. See [plan](design/plans/phase3d1-report-registration.md) and [verification](verification/phase3d1-report-registration.md). PR #58 merged after all seven exact-head CI jobs passed; inspected database tiers passed 1,558 / 1,739 / 1,740 with zero failures or missing-service notices. The product form transport is tracked separately below; authentication/hosting acceptance, report-file recovery and live provider/scheduler/custody remain separate gates. This does not accept all Phase 3 or authorize clinical use/deployment.

## Phase 3D2 standard synthetic upload

Founder approved the separate transport/UI plan with “go” on 2026-10-10 after PR #58. The standard VCF/JSON screen selects existing patients from bounded pages, registers with retry keys, transfers through an explicit storage-origin allowlist and shows success only after server verification. PR #59 merged at `e550100`; all seven exact-head CI jobs passed, with inspected database tiers 1,558 / 1,739 / 1,740, zero failures/missing-service notices and browser 54 + 18 passed. See [plan](design/plans/phase3d2-product-upload.md), [runbook](ops/report-upload.md), [verification](verification/phase3d2-product-upload.md) and [final delivery evidence](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/59). The committed slice documents retain their pre-CI snapshots; the published PR completes scoped verification. Retry state is limited to the mounted form; reload recovery, PDF/local experiment changes, independent report-file recovery, clinical processing and live deployment acceptance remain separate. Nothing is deployed or approved clinically.

## Independent report-file recovery planning

PRs #60/#61 merged the [reviewed design](design/plans/report-file-recovery.md) and readability polish. Founder then approved a separate local F1 implementation with “go”: a verified-restore-bound encrypted/authenticated catalogue, frozen source identities, exact translated copies/read-back, bounded discovery and completion-last protocol. See [F1 plan](design/plans/f1-evidence-catalogue.md), [library runbook](ops/evidence-catalogue.md) and [verification](verification/f1-evidence-catalogue.md). This slice has real PostgreSQL/Moto controls and aggregate JSON CI artifacts; PR #62 is merged, with all seven exact-head CI checks passed. F2 PR #63 is merged (`2a6022f`); all seven CI checks passed, including 1,794 PostgreSQL/S3 tests and validated artifacts for all three profiles. See the [F2 plan](design/plans/f2-independent-recovery.md), [runbook](ops/independent-recovery.md) and [verification](verification/f2-independent-recovery.md). F2 recovers all required bytes with primary denied and keeps application recovery false. Founder separately approved F3: its [plan](design/plans/f3-application-recovery.md), [runbook](ops/application-recovery.md) and [verification](verification/f3-application-recovery.md) cover an opt-in read-only resolver and actual synthetic application acceptance. F3 #64 is merged at `60a73aa`; all seven CI jobs passed, with inspected database tiers 1,630 / 1,811 / 1,812 passing tests and strict downloaded F2/F3 profile validation. The merged tree matches the reviewed/tested code; see [F3 final evidence](verification/f3-application-recovery.md#merged-delivery-evidence). Founder approved [F4 documentation-only preparation](design/plans/f4-provider-custody.md): provider/Region/custody/retention/budget decisions, operational producer/loader/startup and retained-destination configuration remain prerequisites. F4 live drill, scheduling and production infrastructure remain unimplemented. Moto metadata checks do not prove AWS Compliance/IAM enforcement. Whole Phase 3 and all founder deployment gates remain open.

## What exists on `main`

| Phase | What it added | Where to read more |
| --- | --- | --- |
| Scaffold, 1 | Monorepo layout; data and secret guards; frontend foundation (Vite, React, Tailwind) | [README](../README.md) |
| 2 | NestJS API foundation, shared contracts, auth guard layer | [auth.md](auth.md), `apps/backend/README.md` |
| 3 | PostgreSQL schema with row-level security, validated API file intake and version-pinned downloads, verified backup and restore | [database.md](database.md), [ops/backup-and-restore.md](ops/backup-and-restore.md) |
| 4 | Authentication with Amazon Cognito (verification, roles, `/me`, CORS, Terraform, UI) | [auth.md](auth.md) |
| 5A | CPIC knowledge schemas, signed-content loader, phenotype and recommendation engines | [cpic-integration.md](cpic-integration.md) |
| 5B-0 | Tenancy: records belong to an organization, not one user | [database.md](database.md) |
| 5B-1 | Multi-gene guideline tables, cell verification, five outcomes, frozen vocabulary | [design/outcomes-and-reason-codes.md](design/outcomes-and-reason-codes.md) |
| CI/CD | Real CI workflow, branch-protection ruleset (applied), Dependabot, CODEOWNERS, PR template; Node pinned to an exact release | [ops/ci-cd.md](ops/ci-cd.md) |
| 5B-2a | Lab-report reader sidecar with a byte-identical, **test-only** import of the hand-off engine; the report adapter | [lab-report-reader.md](lab-report-reader.md), [design/report-adapter-spec.md](design/report-adapter-spec.md) |
| BK-1, BK-2 | Authenticated encryption and signed manifest for backups; off-site copy to a second provider with a set-up self-test | [ops/offsite-backups.md](ops/offsite-backups.md) |
| 5B-3.0, 5B-3.1 | The specification, then the database layer: records, correction tables, the per-tenant hash-chained audit ledger, verifier, redaction, roles, backup and restore that preserve ownership and privileges | [design/records-and-corrections.md](design/records-and-corrections.md), [ops/ledger-roles.md](ops/ledger-roles.md) |
| 5B-3.2a (#20, #21) | Migration 0010 (the stored lab PDF is pinned to an object version and protected by the database), the `reviewer` role, `lab-pdf` type, version-aware object storage, the error contract, the `LAB_REPORT_PIPELINE` switch, six-year retention of overwritten report files in Terraform | [ops/report-evidence.md](ops/report-evidence.md), spec section 16 |
| 5B-3.2b-1 (#22, #24) | Capture, decision and file-link endpoints, the recorded-text runner, the checkpoint proving the pinned reader runs in CI | [lab-report-reader.md](lab-report-reader.md), spec section 17 |
| 5B-3.2b-2 (#29) | Evaluation endpoints (reader, adapter, engine, stored with the ledger), knowledge loading, the per-process reader limit, the dispute re-check after the ledger lock, D01 to D12 end to end against the hand-written expectations | [lab-report-reader.md](lab-report-reader.md), spec section 18 |
| 5B-3.3a | Corrections: retract, reinstate, supersede; correction history and derived state in every evaluation; `current` and `?current=true`; `GET /notes/:id` | [lab-report-reader.md](lab-report-reader.md), spec section 19 |
| 5B-3.3b | Disputes about guideline cells and the overlay that holds a disputed cell; the exact post-lock dispute re-check replaces the tenant-wide `dispute-active` refusal | [lab-report-reader.md](lab-report-reader.md), spec section 20 |
| 5B-3.3c | Ledger watch: the check at start (production refuses to start), the background and scheduled full walks, the `ledger-compromised` latch and the append gate, readiness `ledger`, `GET /ledger/verify`, and the restore-time `ledger chain` check | [ops/ledger-watch.md](ops/ledger-watch.md), spec section 21 |

## In progress and next

Slice 5B-3.2 (the pipeline endpoints) is complete. Slice 5B-3.3 (corrections, disputes, ledger watch) is complete; 3.3a, 3.3b and 3.3c are all merged. It was planned and approved ([design/plans/5b-3-3-corrections-disputes-ledger-watch.md](design/plans/5b-3-3-corrections-disputes-ledger-watch.md), decisions 24 to 30) and is built as three PRs:

- **5B-3.3a corrections, 3.3b disputes and the overlay, 3.3c ledger watch** (all built, above). The pipeline stays synthetic, off by default and refused in
  production. **No alarm exists in AWS for the `ledger-compromised` log line yet**: it is written as Terraform in F3b (below), never applied; see [ops/ledger-watch.md](ops/ledger-watch.md).
- **Disputed-cell evaluation listing**: implemented in this slice; exact file matches and historical candidates without provable file identity are shown separately. Read-only, paginated, and synthetic-only; see [verification and limits](clinical-validation/cell-usage-listing.md).
- **Hosting H1**: company site on Vercel, product on AWS, both domains in Jan's Cloudflare account. Optional private S3/CloudFront frontend configuration is written, disabled by default and never applied; see [hosting and DNS checklist](ops/domains-and-hosting.md). API host, WAF, deployment roles/state and live validation remain separate prerequisites (the CloudTrail audit trail is the next item).
- **Audit trail (F1)**: CloudTrail with S3 data events on the reports bucket, a locked log bucket with its own key, and six email alarms are written as Terraform and guard-tested, **never applied**; see [ops/audit-trail.md](ops/audit-trail.md). It satisfies the audit condition for the break-glass role once applied and tested; the role is still not created.
- **API rate limiting (F2)**: per-address (before sign-in) and per-person-by-route-class token buckets returning 429 `RATE_LIMITED`; per process; production requires `TRUST_PROXY_HOPS`; see [ops/rate-limiting.md](ops/rate-limiting.md). The frontend does not yet show a friendly 429 message.
- **API hosting, edge (F3a)**: ACM certificate, HTTPS-only load balancer, firewall and exact security groups for the API are written as Terraform and guard-tested, **off by default and never applied**; staging front end on Vercel, staging API on AWS in production mode. The compute (F3b) and the deployment pipeline (F4) are next; see [ops/api-hosting.md](ops/api-hosting.md) and [the plan](design/plans/f3-api-hosting.md).
- **API hosting, compute (F3b)**: ECS Fargate cluster and service, task and one-off migration task definitions, roles, secret containers (no values), a log group with its own key, and four alarms (including `ledger-compromised`) are written as Terraform and guard-tested, **off by default and never applied**; the task environment is checked against the application's own configuration loader. **Open before anything can run:** the image and pipeline (F4), the three database logins (no tool creates them yet), a VPC with a NAT route; see [ops/api-hosting.md](ops/api-hosting.md).
- **Shared ledger containment (FD-2, from the 2026-10-09 peer review)**: a walk that finds damage records an incident in the database (migration 0011); `ledger_append` refuses that tenant's writes in every task, other tenants carry on, `/ready` says `contained`, and only an operator can reopen it, after a full walk that began later has passed. A global hold stops everyone. Proved against real PostgreSQL (two sessions, a restart, a restore, the in-flight order) and by 20 injected defects; **not** proved in AWS. Two-person authorisation of a clearance waits for the second reviewer. See [ops/ledger-watch.md](ops/ledger-watch.md), [the plan](design/plans/fd2-ledger-containment.md), spec section 23. This also corrects the F3b wording that a damaged task "leaves rotation at once": the load balancer fails open, and the database is what contains the tenant.
- **Database logins command (FD-4a, from the 2026-10-09 peer review)**: `db provision-logins` (run as a one-off task) creates the application, ledger-verifier and migrator logins with generated passwords sent to the database only as SCRAM verifiers (the RDS parameter group logs DDL), writes the connection strings into the three Secrets Manager containers, is safe to run twice, `--rotate` replaces every password, and reads the result back from the catalog (each login a member of exactly its group; the verifier cannot append; the application cannot touch incidents; neither writes a ledger table). Terraform adds the task and two roles (the task role cannot read the administrator secret). Proved on PostgreSQL 16 by automated tests (and, once by hand, a non-superuser administrator on a pristine cluster, after which the migrator, which is not `CREATEROLE`, applied all 11 migrations; FD-4b automates that), the Secrets Manager calls on an emulator, and 24 injected defects; **not** proved on RDS, IAM, or Fargate (FD-7). The image and the CI rehearsal of the first deployment are FD-4b. See [api-hosting.md](ops/api-hosting.md#the-database-logins-db-provision-logins) and [the plan](design/plans/fd4-provisioning-image.md).
- **Synthetic Terraform profile (FD-3, from the 2026-10-09 peer review)**: `deployment_profile` (default `production`) lets the same root plan as a one-Region, small, destroyable rehearsal (`synthetic`: allowed only with `environment = "staging"`, creates its own VPC with public subnets and no NAT, refuses COMPLIANCE locks); production values are untouched and every relaxation is listed in one guard. CI now runs `terraform test` (an offline, mocked plan per profile, 13 runs including the refusals), which also found and fixed a latent bug: with the default variables the root could not be *planned* (two IAM policy documents indexed secrets that exist only with hosting on). Proved offline by `terraform test`, the text guards and injected defects; **not** proved in AWS (limits, the free plan, destroying locked buckets: the FD-7 rehearsal). See [the Terraform README](../infrastructure/terraform/README.md#deployment-profiles-fd-3) and [the plan](design/plans/fd3-synthetic-profile.md).
- **Database TLS contract (FD-1, from the 2026-10-09 peer review)**: connection URLs may not carry TLS parameters (refused at start-up and in the connection builder); `DATABASE_SSL` is the only TLS setting and `require` verifies certificate and host name at TLS 1.2+; the command-line tools use `verify-full`; the migration task now sets `DATABASE_SSL=require`; a static guard keeps every connection on the one builder. See [database.md](database.md#database-tls). The F3b wording that a damaged task "leaves rotation at once" is corrected by FD-2 (below).
- **API image and first-deployment rehearsal (FD-4b)**: a digest-pinned Node 22.22.0 image, owner-confirmed RDS trust bundle, compiled production dependencies with a frozen-resolution comparison, numeric non-root runtime, and a synthetic TLS PostgreSQL/Moto rehearsal. The new `image` CI check builds with retained OCI SBOM/provenance, blocks fixed HIGH/CRITICAL vulnerabilities, and exercises provisioning, pristine-startup refusal, migrations, health/readiness and cross-process tenant containment. Local verification and remaining limits are recorded in [the image runbook](../infrastructure/docker/README.md). This is configuration and local/CI evidence only: nothing applied, published, clinically released, or approved for production; the founder approved adding the live `image` merge gate on 2026-10-10, and effective main protection now requires it (other existing rules preserved; see [CI controls](ops/ci-cd.md)).
- **Adapter-side R05 offline prototype (#28)**: implemented and verified with synthetic development tests; see [offline verification](clinical-validation/report-lookup-offline-v1.md). Production record-store/API integration requires its own approved plan; the evaluation API still uses the existing report adapter. Real clinical content, independent validation and clinical/training release remain pending.
- **Local synthetic review workflow**: development-only upload, PDF comparison and operations pages with a portable launcher; see [runbook](../scripts/local-review/README.md) and [verification](verification/local-review.md). The optional pinned Poppler26.03.0 adapter accepts only D01; general production Poppler integration remains a separate slice.
- **Tableau (analytics)**: feasible as its own slice; synthetic data only until a BAA; a separate read-only role over de-identified aggregate
  views with small-cell suppression, ideally pointed at a restored copy. Not planned in detail.

## Waiting on a person (the founder)

BAA texts from the off-site backup provider candidates (Backblaze B2, Wasabi); two key custodians; provider choice; the first real off-site
restore drill; deployment approval and the company Vercel source/project; sertraline and CPIC clinical data and sign-off; the break-glass role that may delete object versions is **assigned to the founder** and described in
[ops/break-glass.md](ops/break-glass.md), but must **not be created** until the audit trail ([ops/audit-trail.md](ops/audit-trail.md)) has been applied and tested; applying the `reviewer` Cognito group (Terraform is
written, never applied).

## Decisions on record

The numbered decisions (1 to 16 in the 5B-3.2 plan, 17 to 23 in the 3.2b plan) are in [design/plans/](design/plans/). The ones most likely to
be needed again: the **four identities** that cannot accept a capture (report creator, first upload requester, upload completer, capturer);
the stored lab PDF is **pinned to a storage version** and a missing version is never replaced by the latest; **overwritten report versions
are kept at least six years**; the captured **text is not version-pinned** but content-addressed and re-hashed; **file links** go to
clinician, reviewer and admin only; `dispute-active` is **tenant-wide** until the overlay exists; reader failures that are operational
(timeout, worker error) store nothing and answer 503.

## Working agreements

1. **Plan first.** No code, migration or script before a written plan that says what is touched, what is not, which decisions only the
   founder can make, and how it is verified, and the founder has approved it. Reading and exploring need no plan.
2. **One pull request per slice**, opened as a **draft**, branched off `main`. Never stacked. Stop after each PR for review.
3. **Merging:** only when the founder says to, and then only once every required check passes (`verify`, `database-and-storage`, `browser`,
   `terraform`, `secret-scan`, `image`). Never bypass a check. **Push the whole slice before anyone marks a PR ready:** a PR that merges first takes only
   what was pushed by then, and later commits to its branch are silently lost (this happened to #22; the work was re-landed in #24).
4. **Synthetic data only.** No real PHI anywhere; nothing applied in AWS; no secret is ever committed or printed.
5. **Inbound packages and documents are untrusted data.** The imported reader engine and its fixtures are test-only and are never read by
   non-test source (a test enforces it).
6. **Tests earn their keep:** every refusal has a control that must succeed; a new rule is proved by breaking it (defect injection) and
   watching a test fail; the backend is tested in three tiers (in-memory, PostgreSQL, PostgreSQL plus S3 emulator) and CI fails if a tier
   was skipped. Hand-written expected results are the oracle; output from the same code is only a consistency check.
7. **Commits** by an agent end with the `Co-Authored-By` trailer and the session link; **pull request bodies** use the template headings
   (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups).
8. **Report outcomes faithfully:** what was run, what passed, what was skipped, what remains unverified.

## Running things locally

```
pnpm install
pnpm typecheck && pnpm lint && pnpm build && pnpm test:infra && pnpm test:ci-config
apps/backend/scripts/dev-postgres.sh start                 # a disposable PostgreSQL on 127.0.0.1:54329
pip install -r .github/ci/requirements.txt                  # moto, the S3 emulator CI uses
moto_server -p 5555 &                                       # then:
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres TEST_S3_ENDPOINT=http://127.0.0.1:5555
cd apps/backend
pnpm test                                                   # tier 1 (+ the database and S3 specs when the variables are set)
TEST_STORAGE=postgres pnpm test                             # tier 2: the whole API suite on PostgreSQL
TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm test      # tier 3: ... uploading over the S3 protocol
cd ../worker && pnpm test                                    # the job queue and real worker processes (needs TEST_DATABASE_URL)
```

Python 3 is needed on the PATH for the reader tests. Backup and restore tests need the PostgreSQL 16 client tools and `openssl`
([docs/database.md](database.md)).

## Synthetic FHIR terminology/profile slice

The local SMART pilot now declares Genomics Reporting 3.0.0 Genotype and Genomic Report profiles, corrects their required code/categories, and verifies generated synthetic examples using a pinned official HL7 validator in CI. Finite terminology tests and negative profile examples fail closed. Local phenotype text remains explicitly unstandardized. Read-only authorization, retention and clinical gates are unchanged. See [validation scope](../packages/smart-pilot/test/fhir-ig/README.md). The final synthetic workflow acceptance slice is described above.


## FD-7a producer-fault probe promotion (local, 2026-10-17)

`feat/fd7a-producer-faults` starts at freshly fetched main `efb6103` and preserves
reviewed `cf532cd`. Four review-only producer faults are now permanent controls:
missing executable, terminated producer, empty output and timeout. The existing
harness passed all 63 focused / 135 full CI controls (focused included in full),
with exact native refusal receipts; all 171 policy/mutation cases, 21 state guards,
22 standalone plans, 33 main-root plans, 96 infrastructure tests and 8 workspace /
4 workflow controls passed without selected skips. Both roots fmt/init/validate
and actionlint passed. The workflow, resource/policy definitions, locks and native
fixtures are unchanged from the reviewed candidate. Earlier main and candidate
history remains intact. [Verification and remaining gates](verification/fd7a-required-ci.md#producer-fault-probes-made-permanent--2026-10-17).
Both FD-7a candidates, F06/F07 and combined are preserved. Final-candidate review,
authorized publication/exact-head hosted Linux CI, backend wiring and live AWS
acceptance remain open; no push, PR, merge, cloud operation or deployment occurred.


## FD-7a delivery reconciliation on current main (local, 2026-10-17)

`feat/fd7a-delivery-reconciled` starts from main `95c6ead`, including merged worker
shutdown fix #154. It carries local `79b727f`'s four permanent producer-fault
controls and dated records, together with published `bb14e08`'s README Actions
clarification and preserved historical handoff. The reviewed workflow, standalone
resource/policy definitions, locks and fixtures are unchanged. Main's worker code
is retained verbatim; the separate early-stop/session-test experiment is not part
of this candidate. Earlier history remains intact. See the [dated delivery
reconciliation record](verification/fd7a-required-ci.md#delivery-reconciliation-on-current-main--2026-10-17).
Fresh local results and final source/commit binding belong to the external
completion report; older test results below and above apply only to their stated
captures. Exact-head hosted acceptance, backend activation and live AWS gates
remain separate. This reconciliation authorizes no push, hosted CI rerun, merge,
apply or deployment; protected source checkouts remain preserved.


## FD-7a native producer error correction (local, 2026-10-17)

A separate clone from reviewed `b58ebc5` corrects its P2 native-error finding.
The policy entry now accepts a producer only with exit 0, no signal and no native
error. A finite regression makes the producer handle timeout SIGTERM and exit 0
while Node retains `ETIMEDOUT`; rejection must occur at the producer guard. The
existing ten refusals, including all four permanent fault controls, remain.
README clarification, worker fix #154, workflow, policies, locks and fixtures are
unchanged. Fresh local verification and red/green evidence are bound to the final
commit by the external `fd7a-native-error-fix` report; earlier results above are
historical. All protected checkouts remain preserved. Publication, exact-head
hosted CI and live backend acceptance remain separate authorization gates.

## P1 synthetic business kernel — restarted on current main (20 October 2026)

The approved memory-only SOP/FAQ kernel lives in `apps/ai-service`: fixed role graph, strict schemas, current fixture authority, exact-byte evidence, bounded scripted director/repair, projected budget math and fenced simulated audit/release. Outputs are explicitly synthetic; no API/UI/DB/job/model or clinical integration exists. Models, Harness², deployment and spending stay disabled. See [scope](design/plans/business-synthetic-kernel.md) and [verification](verification/business-synthetic-kernel.md) for producer counts, guard-defect evidence and local-test limits. Restarted on 2026-10-20 as a fresh branch off `main` `812d1d8` after the founder closed the first attempt (PR #169) unmerged as housekeeping. Only the kernel commit was brought over; the first attempt's CI-guard and Vercel-preview commits (about 1,200 lines of workflow changes for an earlier cost gate) were **not**, and no workflow, ruleset or required gate changes here. The earlier `[skip ci]` is dropped: on 2026-10-20 the founder replaced the strict-$2 delivery gate with a per-run planning cap of $1.44 and at most 3 hosted runs per PR, and instructed this draft PR. The founder's read-back of the Claude, Cursor, Codex and Vercel app settings was still pending at the time. Merge remains the founder's call.
