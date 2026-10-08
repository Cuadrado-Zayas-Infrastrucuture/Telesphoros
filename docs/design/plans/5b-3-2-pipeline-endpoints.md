> **Plan record.** Plan for slice 5B-3.2 (the pipeline endpoints), version 2 with the acceptance conditions of the second review appended as section 12. Kept in the repository so the reasoning behind the decisions survives a change of session or person.
> Approved 2026-10-08 (decisions 1 to 16). Built as 3.2a (merged: #20, #21) and 3.2b-1 (merged: #22, #24); 3.2b-2 is in progress. Where this text and the code or `docs/design/records-and-corrections.md` differ, the code and the specification govern.
> Section numbers cited elsewhere (for example "plan 12.3") refer to this file.

# Plan v2: slice 5B-3.2, the pipeline endpoints (capture, accept, evaluate, read)

Status at approval (2026-10-08): plan only. Supersedes `PLAN-5B-3-2-pipeline-endpoints.md` after the review of 2026-10-08.
Branch each PR off `main` (now `a04e2aa`); never stacked. Synthetic data only; nothing applied in AWS; the pipeline is a **non-production integration**:
the deferred verification and readiness wiring (5B-3.3) means it must not run against real data, and configuration validation refuses it in production.

## 0. What the review changed

| Review point | Change in this version |
| --- | --- |
| 1 Disabled behavior | "503" now means *authenticated and authorized callers meet the feature gate*; 401/403 still win. Side-effect-free proof by spies. `lab-pdf` on the **existing** report routes is tested in both switch states (section 2.2). |
| 2 Combined roles | Explicit rule table (section 2.3); backend keeps every role the token carries (verified: both token verifiers keep the whole set); self-acceptance stays 409, a missing role stays 403. |
| 3 Evidence integrity | Migration 0010 now pins the **bytes**: object version, verified hash, uploader identity; freezes them in the database; closes the capture-versus-modification race with a real interleaving test (section 2.4). Download links target the pinned version. |
| 4 Retry rule | Reworded to the narrower rule; there is **no reservation** to expire (section 7). Idempotency acceptance tests listed. `worker-error` is no longer called transient. |
| 5 Pinned inputs | The evaluation request carries the **accepted-decision id** it relies on; stale decisions are refused; dispute check is repeated **after the tenant's ledger lock is held** (section 6). Read behavior while disputes exist is specified. |
| 6 Fake runner | Described as a recorded-text substitute only; it hashes the **retrieved bytes**; two distinct failures for unknown file and broken install; early real-subprocess checkpoint in CI (section 9). |
| 7 Limits and errors | Limit scope stated (per process), `Retry-After`, release on every exit path, no DB transaction held while waiting; stable error codes table (section 5). |
| Endpoint contract table | Section 4. |

## 1. Scope and split (unchanged in shape)

- **3.2a, foundations:** roles, `lab-pdf`, object-storage versions, migration 0010, error codes, pipeline switch and gate. No pipeline endpoint does any work.
- **3.2b, endpoints:** capture, decision, evaluation, reads, fake runner, knowledge loading, reader limiter, end-to-end proof on D01 to D12.
- **Left for 5B-3.3:** corrections, disputes and the overlay, `current=true`, startup and background verification, the production refusal on a damaged chain, the readiness `ledger` check, `GET /ledger/verify`, restore-time ledger check, the scheduled verification.

## 2. 3.2a, foundations

### 2.1 Files

| # | Change | Where |
| --- | --- | --- |
| a1 | `reviewer` added to `ROLES` (shared-types), Cognito group, infra test, fake identity provider users **including combinations**, `docs/auth.md`, frontend `roles.ts` | `packages/shared-types/src/roles.ts`, `common.ts`; `infrastructure/terraform/cognito.tf`, `guard.test.mjs`; `packages/fake-idp/src/index.ts`; `docs/auth.md`; `apps/frontend/src/auth/roles.ts` and tests |
| a2 | `lab-pdf` report type (enum, `.pdf`, `application/pdf`); a filename must match its type (`lab-pdf` takes only `.pdf`; `vcf`/`structured` keep `.vcf`/`.json`, so a `.pdf` named `vcf` report stays a 400). The frontend shows the label but does **not** offer the type for upload. | `packages/shared-types/src/report.ts`; frontend `types/report.ts` (display only) |
| a3 | `ObjectStorage`: `inspect` returns the **object version**; `getObject(key, {version, maxBytes})`; `putObject(key, bytes, type)`; `createDownloadUrl(key, version, ttl)` that signs the version; `DOWNLOAD_URL_TTL_SECONDS` 60 to 600, default 120. In-memory implementation keeps versions too. With the pipeline enabled and the S3 driver, startup checks that the bucket has **versioning enabled** (the Terraform reports bucket does) and refuses to start otherwise. | `src/object-storage/*`, `src/config/env.ts` |
| a4 | `ReportsService.completeUpload` records `objectVersion` and `uploadedBy` (the caller's `sub`) with the verified hash. | `src/reports/reports.service.ts`, repositories, `ReportRecord` |
| a5 | **Migration 0010** (section 2.4) | `apps/backend/migrations/0010_*` |
| a6 | Error codes and mapping (section 5) | `packages/shared-types/src/errors.ts`, `src/common/error-mapping.ts` |
| a7 | Pipeline switch and gate (section 2.2) | `src/config/env.ts`, `src/lab-reports/*` (new), `app.module.ts` |
| a8 | Docs: `docs/lab-report-reader.md`, `docs/database.md`, spec section 15, `docs/auth.md` | docs |

### 2.2 The switch, precisely

- `LAB_REPORT_PIPELINE=disabled|enabled`, default `disabled`. Configuration validation **fails** for `enabled` when `NODE_ENV=production`, when `STORAGE_DRIVER` is not `postgres`, or (S3 driver) when versioning is off. Tests cover each.
- **Order on every new route:** authentication (401) → role (403) → the gate (503 `PIPELINE_DISABLED`) → validation → work. An unauthenticated or wrongly-roled caller learns nothing about the switch.
- **Zero side effects while disabled**, proven with spies on the reader, the object storage (no read, no write, **no link issued**), the ledger repository (no write, no read), and the knowledge loader (never loaded). The route list is taken from the controllers' own metadata, so a route added later without the gate fails the test.
- **Existing routes, newly able to carry `lab-pdf`:** while disabled, `POST /reports` and `PATCH /reports/:id` that would produce a `lab-pdf` report answer 503 `PIPELINE_DISABLED`; upload-URL and complete are unreachable because no such report can exist. Tests run both switch states against create, patch (to and from), upload-url, complete, list, get and delete for `lab-pdf`, `vcf` and `structured`, and the **existing suites pass unmodified** (proof that `vcf`/`structured` did not change).
- While enabled, the whole surface is a **synthetic, non-production integration**: it works without the ledger being verified at startup (that is 5B-3.3), which is exactly why production refuses it. Every evaluation response carries `clinicalUse: "not-approved"`.

### 2.3 Roles, with combinations

The backend reads `principal.roles` (a set; verified for both the HMAC and Cognito verifiers: every recognised group is kept) and `principal.sub` (stable Cognito subject). The UI's "highest role" is for display only and is never consulted for permission.

| Holds | May capture/evaluate | May accept or reject a capture | May read |
| --- | --- | --- | --- |
| `reader` only | no (403) | no (403) | yes |
| `clinician` | yes | no (403) | yes |
| `admin` alone | yes | **no (403)** | yes |
| `reviewer` | yes | yes, except as below | yes |
| `admin` + `reviewer` | yes | yes, except as below | yes |
| `clinician` + `reviewer` | yes | yes, except as below | yes |
| any combination | | **never** when the caller is the person who created the report, completed its upload, or created that capture → **409** `self-review` | |

Tests: every row above through HTTP with tokens carrying exactly those groups (fake identity provider users for each combination, plus the frontend `roles` helper tests for the same combinations), once as an independent person (accepted) and once as the uploader (409). Missing role is always 403, never 409.

### 2.4 Migration 0010: protect the captured evidence, bytes included

Columns added to `reports`: `object_version text`, `uploaded_by text`. Rules enforced by the database (each with a test that tries to break it and a control that must succeed):

1. **Once uploaded**, `sha256`, `storage_key`, `object_version`, `content_type`, `size_bytes`, `uploaded_at`, `uploaded_by` can no longer change. (Today the service refuses a second upload-url, but nothing in the database does.) A `lab-pdf` row with `uploaded_at` set must carry an `object_version`.
2. **Once any capture exists** for the report: also `type`, `original_filename`, `patient_id` and `deleted_at` are frozen (soft-delete refused).
3. **Capture insert** (replaces the 0007 check): locks the report row (`FOR SHARE`), requires `type='lab-pdf'`, uploaded, `object_version` present, and `pdf_sha256` equal to the report's recorded hash.
4. **Acceptance check** (replaces the 0007 function): an accepting reviewer must differ from `reports.created_by`, `reports.uploaded_by` **and** the capture's `created_by` (decision 12). Rejections stay open to any reviewer.
5. **Race:** a capture insert racing a report update, in both orders, must end with either the capture committed and the update refused, or the update committed and the capture refused; never a capture describing different bytes. Proved with a deterministic interleaving (two connections held at a barrier), not by repetition. If the first mechanism fails that test I run a small spike (as in 5B-3.1) and report it before building on it.

Bytes: the capture service never trusts the stored hash alone. At capture time it fetches **the pinned version**, recomputes SHA-256 from the retrieved bytes (bounded to the 10 MiB report limit, streamed), and refuses with 409 `source-changed` if it differs from `reports.sha256`. The same recomputed hash is what the fake runner looks up. Test: after `complete`, a still-valid presigned PUT (they last up to 300 s) writes new bytes to the same key; the report stays pinned to the verified version, the capture uses it, and the download link serves it. If the S3 emulator cannot honor versions on pre-signed reads I report that and do not weaken the rule.

Download links: issued only after the tenant-scoped lookup; sign the pinned version; default 120 s; never logged (the request logger already records the path only, and a test asserts no link appears in logs or error bodies). **Disabling the API does not revoke a link already issued**; it remains a bearer credential until it expires, and the TTL is the bound. This is written into the runbook.

## 3. 3.2b, endpoints (summary; details in the tables below)

`TextCaptureRunner` interface and `FakeTextCaptureRunner`; capture, decision, evaluation and read services and controllers; DTOs in shared-types; knowledge loading at startup only when enabled (`KNOWLEDGE_DIR`, mode from `NODE_ENV`; a load failure stops the start); `BUILD_VERSION` required when enabled; the reader limiter; a database-backed `CaptureAcceptanceStore`; repository additions `findAcceptance`, `findCaptureByIdentity`, `activeDisputeExists`.

**The fake runner, honestly:** it substitutes *recorded extraction text*. A file whose recomputed SHA-256 equals a fixture's `source_pdf_sha256` returns that fixture's stored text (and the fixture's own `stored_text_sha256` is checked, so a corrupt fixture is caught). It validates the integration from extraction text onward; it says nothing about real PDF extraction, which needs Poppler 26.03.0 and is not in this slice. Two different failures: an unknown file is 422 `UNSUPPORTED_SOURCE` (a user-facing fact); a missing, unreadable or corrupt fixture directory or entry is 500 `PIPELINE_MISCONFIGURED` (an installation fault, logged with codes only).

## 4. Endpoint contract table (all under `/api/v1`)

Common to every row: authenticated → role → gate → validation. Tenant is the token's tenant; every lookup is tenant-scoped and a foreign or unknown id is **404**. No response contains report text, span text, gene values from the report (other than in the stored evaluation inputs of that evaluation), or note text in lists. Links are never logged.

| Route | Roles (capability) | Tenant/object checks | Input identity | Idempotency | Successful writes | Failure side effects |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /reports/:id/capture` | clinician, reviewer, admin | report exists, type `lab-pdf`, uploaded | report id (path) | content identity `(tenant, report, text sha, poppler version)`: same text → `200 created:false`, same record, **no new event** | 1 text object (deterministic key), 1 `report_captures` row + 1 ledger event | unknown file 422, broken fixtures 500: nothing written. Source changed 409: nothing written. Insert failure after the text write: an orphan text object is possible but harmless (deterministic key; a retry overwrites identical bytes) |
| `GET /reports/:id/download-url` | all | report exists, uploaded | report id | n/a (a new short-lived link each call) | none | none |
| `GET /captures/:id` | all; text link only reviewer, admin | capture exists in tenant | capture id | n/a | none | none |
| `POST /captures/:id/decision` `{decision, note?}` | **reviewer** | capture exists; decision text/hash/version are copied from the capture, never from the body | capture id + decision | not idempotent by design: each decision is a new row (a later one supersedes) | 1 acceptance + ≤1 note + 1 event | self-review 409; any DB rule refusal 409; nothing written |
| `POST /reports/:id/evaluations` `{captureId, acceptanceId}` | clinician, reviewer, admin | report/capture/acceptance exist, belong together; acceptance is the **latest** decision for the capture and is `accepted` | `(captureId, acceptanceId)` plus server-held knowledge set and build version | evaluation identity key (existing): same inputs, knowledge and build → `200 created:false`; different knowledge or build → a new row | 1 evaluation (+ results, gene states) + 1 event | none accepted → 409 `capture-not-accepted`; later decision exists → 409 `stale-acceptance`; stored text hash differs → 409 `text-hash-mismatch`; active dispute → 409 `dispute-active`; reader unavailable → 503; **nothing stored in any of these** |
| `GET /evaluations` | all | tenant | filters `patientId`, `reportId` | n/a | none | none |
| `GET /evaluations/:id` | all | tenant | id | n/a | none | none |

Evaluation responses (list and detail) include: `clinicalUse: "not-approved"`, the knowledge set id, build version, the capture and acceptance ids, derived `state`, correction history (empty until 5B-3.3), and `advisory: { activeDisputes: n }` for the tenant. **Reads when a dispute exists:** an evaluation stays readable by id but its response carries `advisory.activeDisputes > 0` and `actionable: false`, so a historical result never looks current while the overlay does not exist. `current=true` waits for 5B-3.3.

## 5. Error contract

Stable `code` plus a stable `details[].reason` where the code is shared. Each code has one meaning and one retry rule.

| Situation | HTTP | `code` / `reason` | Retry? |
| --- | --- | --- | --- |
| Not signed in / wrong role | 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN` | no |
| Unknown or other-tenant id | 404 | `NOT_FOUND` | no |
| Feature switched off | 503 | `PIPELINE_DISABLED` | only after an operator enables it; no `Retry-After` |
| Reader capacity (limiter full) | 503 + `Retry-After: 5` | `PIPELINE_BUSY` | yes, after the delay |
| Reader failed to run or timed out | 503 + `Retry-After: 30` | `READER_UNAVAILABLE` | yes, bounded; a repeating failure shows in the logs and alerts, never as a stored record |
| Ledger head lock timeout | 503 + `Retry-After: 2` | `LEDGER_BUSY` | yes |
| Business conflicts | 409 | `CONFLICT` with `reason`: `self-review`, `capture-not-accepted`, `stale-acceptance`, `text-hash-mismatch`, `source-changed`, `dispute-active` | no, the caller must change something |
| Ledger or record rule refused the write (including a lost race) | 409 | `LEDGER_CONFLICT` | re-read, then decide; never blind retry |
| Unsupported source (fake runner) | 422 | `UNSUPPORTED_SOURCE` | no |
| Server installation fault | 500 | `PIPELINE_MISCONFIGURED` | no, operator action |

## 6. The evaluation flow (3.2b)

1. Gate and role as above. Resolve report, capture and the named acceptance in the caller's tenant.
2. Require: acceptance is `accepted`, is the **latest** decision for the capture (else `stale-acceptance`), capture belongs to the report. Nothing is stored on refusal.
3. Read the stored text (bounded, outside any transaction), recompute SHA-256, compare with the capture's (else `text-hash-mismatch`).
4. Quick refusal: any open or upheld dispute in the tenant → `dispute-active`. (This is only an early exit; step 7 is the guarantee.)
5. Reader, bounded by the limiter and 8 s, outside any transaction → `adaptReport` (database-backed acceptance store) → `evaluate` over the **recorded inputs**: knowledge set id, build version, the capture/acceptance ids and the adapter's source binding are stored with the result. This engine takes **no population or drug-context input** (drugs default to all in the loaded knowledge); the plan records that rather than inventing one. The golden comparison uses exactly these inputs.
6. Hold handling: a deterministic hold (a fact about this exact text) is stored as a `held` evaluation; a reader that failed to run or ran out of time answers 503 `READER_UNAVAILABLE` and stores nothing.
7. Store in one transaction. The ledger's tenant head lock is taken by the append; **after it is held, the transaction re-checks for active disputes** and aborts with `dispute-active` if one now exists. A dispute that commits earlier is seen; one that commits later is ordered after this evaluation and so cannot have been unknown to it. A database-tier test holds the two transactions at a barrier in both orders.
8. 201 for a new record, 200 for the existing one.

## 7. Retry and idempotency semantics

- **Rule:** a transient or operational failure creates **no terminal capture or evaluation record and consumes no idempotency key.** Operational diagnostics (reason code, duration, text length, never text) go to the structured log. A durable store for operational failures is deferred to the observability work.
- **There is no reservation.** Idempotency is the database's uniqueness on committed rows (capture identity, evaluation identity key). Concurrent identical requests may both run the reader; one insert wins and the other returns the existing record. Nothing is held that could need expiring after a timeout, crash or restart.
- `worker-error` and `source-time-budget` are treated as *retryable operational errors*, not as "transient": a repeatable defect will be visible as a repeating log event and a repeating 503, and is never hidden by a stored result.
- Identity is by content, not by a client-supplied key. "Same key, different input" therefore means a different identity (a new record) or an id that does not belong together (404/409); the tests assert both.

Acceptance tests: failed attempt then success with the same identity; N concurrent identical requests give one durable row and one event; replaying a committed success returns the same record and appends no event; the same PDF in two tenants, or two reports, never shares a capture, evaluation, text object or result; an evaluation naming a capture of another report is refused.

## 8. The reader limiter

- **Scope: per application process** (the pilot runs one). It is *not* a deployment-wide or per-tenant limit; a multi-instance deployment needs a shared limit, noted as a hosting-phase item. Setting `LAB_REPORT_MAX_CONCURRENT_READS`, default 2.
- Over the limit: immediate 503 `PIPELINE_BUSY` with `Retry-After`; nothing queued.
- The slot is released in `finally`; tests: timeout, spawn failure, non-zero exit, thrown error, and a client that disconnects (the read is bounded at 8 s and finishes; it is not cancelled, which is stated, and capacity returns afterwards). A test checks that no worker process survives and that no database transaction is open while waiting for storage or the reader (`pg_stat_activity` shows none `idle in transaction` during a deliberately slow reader).

## 9. How I verify

- Clean-state run before each PR: typecheck, lint, build, `knowledge:verify --production`, `test:infra`, `test:ci-config`, chunk check, gitleaks, three backend tiers, frontend tests; browser tests in CI.
- **Early checkpoint in 3.2b (first commit, pushed as a draft before anything else is built):** a test in the `database-and-storage` job that runs the real reader on D01 and asserts the packet's bindings equal `PINNED_READER` (`generatorCodeHash` etc.). It **fails**, not skips, if Python or the engine is missing, so the CI run is evidence that the intended reader ran with its dependencies. If that fails I fix the job before building more.
- **End to end over HTTP on the real database and the S3 emulator, D01 to D12:** presigned upload, complete, capture (fake runner), decision by a second person, evaluation. The independent oracle is the **hand-written** expected output in `tests/report_adapter/golden.json`; the stored result must match it. A fresh run of the same engine on the same recorded inputs is a *persistence-consistency* check only (both could share a defect), and is labelled so. The chain verifies afterwards.
- Negative suite beyond D01 to D12: source-hash mismatch (bytes replaced after upload), unknown fixture, known fixture with a missing or corrupt entry or directory (two different errors), reader timeout, spawn failure, cross-tenant access on every route, unaccepted capture, rejected capture, stale acceptance, uploader / completer / capturer accepting, active dispute at the start and appearing at the barrier, combined-role matrix, disabled-gate matrix with spies, existing-route `lab-pdf` matrix, no text or link in logs.
- **Defect injection** with controls: drop each independence check, drop the latest-acceptance check, drop the stale-acceptance check, skip the byte re-hash, skip the pinned version, skip the post-lock dispute check, store `READER_UNAVAILABLE` outcomes, allow `enabled` in production, remove the gate from one route, remove a role from one route, return note text, drop a tenant scope. All must be caught; equivalent mutants explained (as in 5B-3.1).

## 10. Decisions only you can make (recommendations changed where marked)

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Split into 3.2a and 3.2b | Yes |
| 2 | Self-review is 409 `self-review`; missing role stays 403 | Yes |
| 3 | Admin alone cannot accept; `admin`+`reviewer` can (never their own work) | Yes, with the table in 2.3 |
| 4 | No accepted capture: 409, nothing stored (diagnostics in logs) | Yes |
| 5 | **Revised:** operational reader failures create no terminal record and consume no key; not called "transient" | Yes, as worded in section 7 |
| 6 | Active disputes block evaluation until the overlay exists; checked again after the ledger lock; stale-looking reads marked | Yes |
| 7 | While disabled, reads are 503 too (acceptable for this synthetic stage; before operational use, historical access and "stop processing" need separate switches) | Yes for now |
| 8 | Migration 0010 widened to bytes, versions, uploader identity, race-proof | Yes |
| 9 | Two concurrent reads **per process**, with `Retry-After` | Yes |
| 10 | Fake runner by recomputed hash; 422 for unknown file, 500 for broken install | Yes |
| **11 (new)** | Require S3 **bucket versioning** and pin the object version (startup refuses otherwise) | Yes |
| **12 (new)** | The accepting reviewer must differ from the report creator, the person who completed the upload **and** the person who ran the capture | Yes; it means one reviewer cannot capture and accept the same file |
| **13 (new)** | The evaluation request must name the acceptance id it relies on (stale ones refused) | Yes |

## 11. What I have not checked and the risks

- **Not checked:** that the emulator in CI honors object versions on signed reads, and that the `database-and-storage` job runs the reader with its dependencies; the first checkpoint commits answer both. The reader's own tests have no skip logic (I looked), so a missing Python would fail rather than skip.
- **Not checked:** that `FOR SHARE` on the report row closes the capture/update race under READ COMMITTED; the barrier test decides, with a spike as the fallback.
- **Reader and engine remain test-only** (`clinical_approval: false`; the reader refuses `production`). The slice changes nothing about that.
- **Uploaded files are not inspected for being PDFs**; the fake runner accepts only known hashes. The real runner will need a magic-byte check and is planned with Poppler.
- **Cognito reviewer group is Terraform that is not applied.** Until it is, `reviewer` exists in code, tests and the fake identity provider only.
- **No operational-failure store** in this slice: a repeating reader failure is visible in logs only.
- **The limiter is per process.**
- Frontend: report types are a local copy in the frontend; it gains a display label only, so a `lab-pdf` row returned by the API does not break the list page. I will test that.

## 12. Acceptance conditions from the second review (these override anything above that differs)

### 12.1 Order of work inside 3.2a: the two unknowns come first and gate the rest

The first commits of the 3.2a branch (pushed as a draft before anything else is built) contain only:

1. migration 0010 and its two-session tests (12.3);
2. the object-storage version tests against the S3 emulator (12.4).

3.2a is **not marked ready, and 3.2b does not start, until both pass in CI.** If either fails, I stop and report instead of working around it (the fallback for the locking protocol is a short spike, as in 5B-3.1).

### 12.2 Dispute race: what makes the re-check sound

It is sound only because of three facts, each tested rather than assumed:

- **Every operation that changes effective dispute status appends a ledger event** (raising a dispute, deciding one), and `ledger_append` takes the tenant's head-row lock before commit. So all of them serialize with an evaluation on the same lock. A test asserts it from the database side: raising and deciding a dispute both leave the head row locked until commit.
- **The evaluation keeps that lock until its own COMMIT** (the lock is released only at transaction end).
- **The re-check is a separate SQL statement issued after `ledger_append` returned**, under the default `READ COMMITTED`, so it takes a new snapshot and sees every dispute that committed before the lock was granted. A test asserts `transaction_isolation = 'read committed'` for these transactions, and a static test fails if the check is ever folded into the same statement as the append.

Two-session tests, both orders: dispute commits first → evaluation refused (`dispute-active`); evaluation commits first → it is stored, the later dispute commits after it, and a subsequent read of that evaluation returns `actionable: false` with `advisory.activeDisputes = 1`. A third case: a dispute *decided as dismissed* before the evaluation takes the lock does not block it.

### 12.3 The capture protocol, complete (the final transaction is the guarantee)

1. Before any storage read: read the report row and keep its **protected bindings** (`type`, `deleted_at`, `patient_id`, `sha256`, `object_version`, `storage_key`, `uploaded_at`).
2. Outside any transaction: fetch the pinned version, recompute SHA-256 from those bytes, run the runner.
3. **Final transaction:** `SELECT ... FOR SHARE` on the report row; **re-read the protected bindings and compare them with step 1**; any difference → 409 `source-changed`, nothing written; then insert the capture and append its event. The 0010 trigger repeats the checks in the database, so a caller that skipped step 3 is still stopped.
4. The repository's `insertCapture` takes the expected bindings as an argument and performs step 3 itself, so a service cannot forget it.

Coordinated two-session tests (a barrier holds one session at a known point), both outcomes: **report change commits first** → the capture is refused; **capture commits first** → the waiting report update then hits the immutability guard and is refused. Each with its control (an unrelated report is unaffected).

### 12.4 Version and digest from the same retrieved object

- **One request yields both.** `inspect` becomes a single streamed `GetObject`; the hash is computed over that response's body and the version id is read from the same response. There is no "hash the current object, then ask which version that was". `completeUpload` stores both from that one result.
- **Null or missing version id is refused:** an object without a real version id (including S3's literal `null` for objects written before versioning) cannot be completed as a `lab-pdf` (409 `source-unpinned`). Synthetic data only, so there are no legacy objects to migrate.
- **A missing pinned version fails; it never falls back to the latest.** Every read and every link for a captured PDF names the version explicitly.
- **The decisive emulator test:** complete V1; reuse the still-valid upload URL to write V2; then prove (a) capture hashes V1's bytes, (b) the download link serves V1, (c) with V1 deleted from the emulator, capture and link both fail with `source-missing` rather than serving V2.
- **Retention, found while checking:** `infrastructure/terraform/storage.tf` currently expires **noncurrent versions after 90 days**. If a file were overwritten after capture, the pinned (now noncurrent) version would be deleted 90 days later, destroying evidence a capture still references. 3.2a changes that rule for the reports bucket (**decision 15**) and adds an infra test that fails if noncurrent expiration for the reports bucket is shorter than the retention floor. Explicit version deletion by anyone with the right IAM permission is outside what versioning prevents; the runbook states that no principal other than a documented break-glass role may hold `s3:DeleteObjectVersion` on the reports bucket. (Terraform is not applied; this is a written control until it is.)

### 12.5 The idempotency contract, written out

| | Capture | Evaluation |
| --- | --- | --- |
| Unique key (database) | `UNIQUE (tenant_id, report_id, text_sha256, poppler_version)` | `UNIQUE (tenant_id, identity_key)` |
| Request fingerprint | those four values (text hash is recomputed server-side from the pinned bytes, never taken from the client) | `identity_key` = canonical hash of report id, capture id, acceptance id, disposition, hold code, knowledge set id, build version and the adapter's source binding |
| Loser of a concurrent insert | `INSERT ... ON CONFLICT ... DO NOTHING` waits for the winner; on conflict the loser reads the committed row **in the same, still-usable transaction** (a new statement under READ COMMITTED) and returns it with `created:false` | same |
| Ledger | the loser appends **nothing**; the existing record already has its one event | same |
| Guarantee | **one durable result** per fingerprint; the reader or runner may have run more than once | same |

3.1's tests already show the shape (six concurrent identical evaluations → one row, one event); 3.2b repeats it over HTTP and adds a count of ledger events.

### 12.6 Scope of the synthetic stage is recorded, not assumed

The engine is unchanged. What the engine does **not** take (population, indication, any source-bound clinical context) is not treated as resolved. For this stage:

- Policy constant `PIPELINE_SCOPE = "synthetic-test-only/1"`: the loaded knowledge is test-only content for invented drugs; no claim is made about a real drug or population.
- It is written **inside the stored evaluation** (in the `binding` JSON, next to the knowledge set id and the SHA-256 of the fixture manifest), so it is hashed into the ledger event with the result and cannot be separated from it, and it is returned in every response as `scope`, with `clinicalUse: "not-approved"`. No migration is needed.
- **Deferred, tracked in the spec's section 14:** source-bound clinical context (drug indication, population, specimen), and a validation note in `docs/clinical-validation/` before any non-synthetic knowledge is loaded.

### 12.7 "Stale" defined, and replay vs retrieval

- **An acceptance is current iff it is the latest decision on its capture.** That is the only staleness condition: a later decision (accept or reject) on the same capture supersedes it. A newer capture of the same report, rejected or unreviewed, does **not** invalidate an older accepted one. Changed source bindings cannot occur after capture (frozen by 0010), so they need no staleness rule.
- **Creation and retrieval are different operations.** `POST /reports/:id/evaluations` always requires a current acceptance: with a superseded one it returns 409 `stale-acceptance` **even if an identical evaluation already exists**. A caller who wants the historical result reads it with `GET /evaluations?reportId=...` or `GET /evaluations/:id`, which are unaffected by later decisions (and show which acceptance the result relied on and whether it is still the latest). **Decision 14.**
- **Replay of a successful request while the acceptance is still current** returns the existing evaluation (200, `created:false`).

### 12.8 Whose identity is checked (decision 12, made precise)

- `reports.created_by`: whoever created the report record. `reports.upload_requested_by`: whoever asked for the **first** upload link (set once, never overwritten by later requests). `reports.uploaded_by`: whoever **completed** the upload, set once; a repeated `complete` returns the stored record and changes nobody's identity. `report_captures.created_by`: whoever created the capture; a retry that returns an existing capture changes nothing, and the second caller is not recorded as its creator.
- The acceptance trigger excludes **all four** for an acceptance. A rejection is open to any reviewer.
- There is no background worker in this slice: capture runs inline as the authenticated caller. If capture is automated later, its actor would be a system identity and the "capturer" exclusion would stop applying to humans; that is a workflow choice to revisit then.
- **Staffing note:** with this policy an office needs at least two people able to review (and neither of them may be whoever created, uploaded or captured the file). Recorded as an amendment to the independence rule in the spec (sections 7 and 15).

### 12.9 Decisions added or changed by this review

| # | Decision | Recommendation |
| --- | --- | --- |
| 11 | Require versioning, pin version and digest from one request, refuse null/missing version, never fall back | Yes, as 12.4 |
| 12 | Four-identity exclusion for acceptance, recorded as an amendment | Yes, with the staffing note in 12.8 |
| 13 | Named acceptance; "stale" = superseded by a later decision on the same capture | Yes, as 12.7 |
| 14 | Creating from a superseded acceptance is always 409, even if the result exists; history is read with GET | Yes |
| 15 | Reports-bucket noncurrent-version expiration raised to the retention floor (6 years), with an infra guard | Yes |
| 16 | Record the synthetic scope inside the stored evaluation; defer source-bound clinical context | Yes |
