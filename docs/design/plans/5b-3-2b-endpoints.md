> **Plan record.** Plan for slice 5B-3.2b (capture, decision, evaluation, reads). Kept in the repository so the reasoning behind the decisions survives a change of session or person.
> Approved 2026-10-08 with all recommendations (decisions 17 to 23). 3.2b-1 is merged (#22, #24); 3.2b-2 is next. Where this text and the code or `docs/design/records-and-corrections.md` differ, the code and the specification govern.
> Section numbers cited elsewhere (for example "plan 12.3") refer to this file. The earlier plan ("plan v2") is `docs/design/plans/5b-3-2-pipeline-endpoints.md`.

# Plan: slice 5B-3.2b, the pipeline endpoints (capture, decision, evaluation, reads)

Status at approval (2026-10-08): plan only. Branch each PR off `main`; never stacked. Synthetic data only; nothing applied in AWS.
Builds on 3.2a (#20, #21): the `reviewer` role, `lab-pdf`, pinned object versions, migration 0010, the error contract, the `LAB_REPORT_PIPELINE` switch and its
route guard (`@RequiresPipeline()`), and the S3/in-memory contract tests. Read the plan v2 sections 4 to 9 and 12 for the rules this plan applies; where this
plan is more specific, this plan governs.

The pipeline remains a **synthetic, non-production integration**: the reader and the engine are test-only (`clinical_approval: false`; the reader refuses
`production`), the knowledge loaded is invented, ledger verification at startup is 5B-3.3, and configuration validation refuses the switch in production.

## 0. What I read to write this (so you can check me)

- `adaptReport(input, {captures, knowledge})` needs a `CaptureAcceptanceStore.get(tenantId, id)`; it checks `decision === 'accepted'`, the text hash and the pinned
  Poppler. It does **not** check that the acceptance is the latest one: the service must (plan 12.7).
- The reader (`SubprocessReportReader`) returns a **processing-failure envelope** instead of throwing: `source-limit` and `candidate-or-frame-limit` are facts
  about the text; `source-time-budget` and `worker-error` are operational. This plan treats them differently (section 6).
- `evaluate(knowledge, geneInputs)` takes **no population or drug-context input**; drugs default to every drug in the loaded knowledge. Recorded, not invented (12.6).
- `LedgerRecordsRepository` already stores captures, acceptances and evaluations idempotently. It lacks: expected-bindings on `insertCapture` (12.3), the
  post-lock dispute re-check (12.2), `findAcceptance`, `findCaptureByIdentity`, `activeDisputeExists`.
- D01 to D12: `source.pdf` (6.7 to 19.8 KB), `report.txt`, `capture.json` (`source_pdf_sha256`, `stored_text_sha256`). The hand-written expectation is
  `tests/report_adapter/golden.json` (10 evaluated, 2 held: D08, D12). Test-only knowledge: `data/fixtures/knowledge/test-only-reader`.
- CI's `database-and-storage` and `verify` jobs already run the reader spec with Python 3.12 (no skip logic). The first commit below makes that an explicit, named assertion.

## 1. Proposal: split 3.2b into two PRs (decision 17)

3.2b is the largest slice so far (five endpoints, reader, knowledge, adapter, engine, limiter, ledger changes, end-to-end proof). One PR would be hard to review and
hard to revert. I recommend two, each branched off `main`, each stopping for your review:

| PR | Contents | Why here |
| --- | --- | --- |
| **3.2b-1, evidence in** | real-reader checkpoint (first commit); fake text runner; `POST /reports/:id/capture`; `GET /captures/:id`; `POST /captures/:id/decision`; `GET /reports/:id/download-url`; repository changes for captures (12.3) and `findAcceptance`; capture/decision DTOs; the disabled-gate matrix for these routes | Everything up to "a second person accepted exactly these bytes and this text". No reader or engine runs on the request path. |
| **3.2b-2, results out** | knowledge loading; reader limiter; database-backed acceptance store; `POST /reports/:id/evaluations`; `GET /evaluations`, `GET /evaluations/:id`; dispute re-check (12.2); idempotency over HTTP; D01 to D12 end to end; ledger chain verified afterwards | The part that runs the reader and the engine and stores clinical-looking output. |

If you prefer one PR, the contents and tests below do not change; only the review size does.

## 2. Files touched, and what is not touched

| Area | Files | PR |
| --- | --- | --- |
| Shared types | `packages/shared-types/src/lab-report.ts` (new: capture, decision, evaluation DTOs and request schemas, `PIPELINE_SCOPE`), `index.ts` | both |
| Runner | `src/lab-reports/runner/text-capture-runner.ts` (interface), `fake-text-capture-runner.ts` | 1 |
| Services | `src/lab-reports/captures.service.ts`, `evaluations.service.ts` (2), `evidence.service.ts` (download links) | both |
| Controllers | `captures.controller.ts` (1), `evaluations.controller.ts` (2), `report-files.controller.ts` (the download-url route, 1) | both |
| Ledger repository | `storage/ledger-records.repository.ts`, `postgres/ledger-records.repository.ts`, `ledger-records.ts` | both |
| Storage helpers | export `reportObjectKey`/`textObjectKey` from one place; no change to `ObjectStorage` | 1 |
| Config | `LAB_REPORT_FIXTURES_DIR` (1); `KNOWLEDGE_DIR`, `BUILD_VERSION`, `LAB_REPORT_MAX_CONCURRENT_READS` (2); validation that they are present when enabled | both |
| Knowledge/reader wiring | `src/lab-reports/knowledge.provider.ts`, `reader.provider.ts`, `reader-limiter.ts`, `acceptance-store.ts` | 2 |
| Tests | `test/lab-reports-*.e2e-spec.ts`, `test/db/lab-reports-*.pg-spec.ts`, unit specs per file | both |
| Docs | `docs/lab-report-reader.md`, spec section 17, `docs/ops/report-evidence.md` (links), `.env.example` | both |

**Not touched:** migrations (none needed: see decision 18), the ledger functions, the projection format or hash versions, the reader and engine code, the
knowledge schema, the frontend (no screen yet), Terraform, auth. Corrections, disputes endpoints, the overlay, `current=true`, startup/background verification,
`GET /ledger/verify` and readiness stay in 5B-3.3. The real Poppler runner stays out (needs the pinned binary; planned separately).

## 3. Endpoint contract (all under `/api/v1`; order: authentication 401, role 403, gate 503, validation 400, work)

A foreign or unknown id is **404**. No response contains report text, span text, a note body or a storage key. Links are never logged.

| Route | Roles | Input | Success | Idempotency | Refusals (nothing is stored in any) |
| --- | --- | --- | --- | --- | --- |
| `POST /reports/:id/capture` | clinician, reviewer, admin | path id | `201` new, `200` same capture again (`created:false`) | content identity `(tenant, report, text sha, poppler version)`; the loser of a race returns the winner's row; no second event | 409 `not-uploaded`, 409 `source-missing` (pinned version gone), 409 `source-changed` (bytes, hash or any protected binding differ), 422 `UNSUPPORTED_SOURCE`, 500 `PIPELINE_MISCONFIGURED` |
| `GET /captures/:id` | all | path id | capture facts + latest decision; **text link only for clinician, reviewer, admin** (decision 19) | n/a | 404 |
| `POST /captures/:id/decision` `{decision, note?}` | **reviewer** | the capture id; hash and Poppler version are copied from the capture, never from the body | `201` | **not** idempotent by design: each decision is a new row, a later one supersedes | 409 `self-review` (accepting only), 409 `LEDGER_CONFLICT` for any database rule |
| `GET /reports/:id/download-url` | clinician, reviewer, admin (decision 19) | path id | `{url, expiresAt}` for the **pinned version** only | n/a, a new short-lived link each call | 404; 409 `not-uploaded` |
| `POST /reports/:id/evaluations` `{captureId, acceptanceId}` | clinician, reviewer, admin | the ids | `201` new, `200` the same evaluation again | evaluation identity key (existing): same capture, acceptance, knowledge and build give the same row | 409 `capture-not-accepted`, `stale-acceptance`, `text-hash-mismatch`, `dispute-active`; 503 `PIPELINE_BUSY`, `READER_UNAVAILABLE`, `LEDGER_BUSY` |
| `GET /evaluations` | all | `reportId`, `patientId` filters | list, no note text | n/a | n/a |
| `GET /evaluations/:id` | all | path id | evaluation | n/a | 404 |

Every evaluation response carries `clinicalUse: "not-approved"`, `scope` (`PIPELINE_SCOPE`), the knowledge set id, build version, the capture and acceptance
ids, a derived `state`, `acceptance: {id, decision, current}`, `advisory: {activeDisputes}` and `actionable` (always `false` in this stage: not approved, and
false in any case when the state is not active or a dispute is open). Correction history is empty until 5B-3.3.

## 4. The capture protocol (12.3 applied; PR 3.2b-1)

1. Resolve the report in the caller's tenant (`findById`); require `type = lab-pdf` and uploaded (`not-uploaded` 409). Keep its **protected bindings**: `type`,
   `patientId`, `sha256`, `objectVersion`, `storageKey`, `uploadedAt`, not deleted.
2. **Outside any transaction:** `getObject(key, {version: objectVersion, maxBytes: 10 MiB})`. Missing → 409 `source-missing` (never the latest). SHA-256 of the
   retrieved bytes must equal `report.sha256` and the response's version must equal `objectVersion`, else 409 `source-changed`.
3. `runner.capture(bytes, sha256)` → `{text, popplerVersion}` or a typed failure (section 5). Text is hashed (UTF-8) and its Unicode scalars counted (the table
   allows up to 100 000; more is 422 `UNSUPPORTED_SOURCE`).
4. If a capture with this identity already exists, return it (`200`, `created:false`) without touching storage again.
5. `putObject(textKey, text)`. The key is **content-addressed and deterministic**: `reports/<tenant hash>/<report id>/text/<text sha256>-<poppler>`; a retry writes
   identical bytes, so an orphan after a failed insert is harmless (stated limit).
6. **One transaction** (`insertCapture` takes the expected bindings itself, so a service cannot forget): `SELECT … FOR SHARE` the report row, re-read the
   protected bindings, compare with step 1 (any difference → 409 `source-changed`, nothing written), insert the capture and append its event. Migration 0010's
   trigger repeats the checks in the database.

No database transaction is held during steps 2 to 5 (tested via `pg_stat_activity`, section 8).

## 5. The text runner (PR 3.2b-1)

`TextCaptureRunner { capture(pdf: Buffer, sha256: string): Promise<{ text: string; popplerVersion: string }> }`, name recorded as `runner: 'fake'`.

- `FakeTextCaptureRunner` is a **recorded-text substitute only**: if the recomputed SHA-256 of the retrieved bytes equals a fixture's `source_pdf_sha256`, it returns that
  fixture's stored text (after checking `sha256(text) = stored_text_sha256`, and that `capture.json`'s Poppler version is the pinned one). It validates the integration
  from extraction text onward and says **nothing** about real PDF extraction.
- Unknown hash → `UNSUPPORTED_SOURCE` (422, a user-facing fact). Missing/unreadable/corrupt fixture directory or entry → `PIPELINE_MISCONFIGURED` (500, logged with codes
  only, never paths from user input). The fixture directory is checked at startup (refuse to start if unreadable) **and** each entry is read at request time, so later
  corruption is caught too.
- It hashes the **retrieved bytes**, not the stored hash, so replaced bytes can never borrow a fixture's text.
- Uploaded files are not inspected for being PDFs in this slice (the fake accepts only known hashes). The real runner needs a magic-byte check; noted for its plan.

## 6. The evaluation flow (PR 3.2b-2; plan v2 section 6 with 12.2, 12.5, 12.6, 12.7)

1. Gate and role. Resolve report, capture and the named acceptance in the tenant (404 otherwise); they must belong together.
2. Acceptance is `accepted` and is the **latest decision on that capture** (else `capture-not-accepted` / `stale-acceptance`). A newer, unaccepted capture of the same
   report does **not** invalidate it. Creating from a superseded acceptance is always 409, even if the result exists; history is read with `GET` (decision 14).
3. Read the stored text (bounded, outside any transaction), recompute SHA-256, compare with the capture's (else `text-hash-mismatch`).
4. Quick exit: any open or upheld dispute in the tenant → `dispute-active`. (Tenant-wide and deliberately blunt until the overlay exists in 5B-3.3; this is only an early exit.)
5. Reader, through the **limiter** and the reader's 8 s deadline, outside any transaction → `adaptReport` (database-backed acceptance store, section 7) → `evaluate` on the
   recorded inputs. Stored with the result: knowledge set id, build version, capture and acceptance ids, the adapter's source binding, and `PIPELINE_SCOPE`
   (`"synthetic-test-only/1"`) plus the SHA-256 of the fixture manifest, **inside `binding`** (so they are hashed into the ledger event; no migration).
6. Reader outcomes: `source-limit` and `candidate-or-frame-limit` are facts about this text and are stored as a `held` evaluation with that code. `source-time-budget` and
   `worker-error` are operational: **503 `READER_UNAVAILABLE`, nothing stored, no key consumed** (a repeating failure shows in logs and alerts, never as a record). Adapter
   holds (layout, alignment, binding mismatch, and so on) are stored as `held`.
7. **One transaction:** insert and append (the append takes the tenant head lock and keeps it to COMMIT), then, as a **separate statement after the append, under READ
   COMMITTED**, re-check for active disputes and abort with `dispute-active` if one now exists. A static test forbids folding the check into the append statement; a
   test asserts the isolation level; two-session tests cover both orders and the dismissed case (12.2).
8. `201` new or `200` existing. The loser of a concurrent insert reads the committed row in the same transaction and appends nothing: **one durable result per fingerprint**
   (the reader may have run more than once).

## 7. Wiring (PR 3.2b-2)

- `KNOWLEDGE_DIR` (required when enabled), loaded at startup with mode `non-production` (the switch is refused in production anyway); a load failure stops the start. No
  knowledge is loaded while disabled (a test proves it).
- `BUILD_VERSION` (required when enabled, 1 to 64 safe characters) is the stored `engineVersion`.
- `SubprocessReportReader({mode:'non-production'})`, with `verifyPinned()` at startup: any mismatching binding refuses the start (names only, never values).
- `ReaderLimiter`: `LAB_REPORT_MAX_CONCURRENT_READS`, default 2 (1 to 16), **per application process** (the pilot runs one; a multi-instance deployment needs a shared limit, a
  hosting-phase item). Full → immediate 503 `PIPELINE_BUSY` + `Retry-After: 5`, nothing queued. The slot is released in `finally` on every exit path. A client that
  disconnects does not cancel the read (bounded at 8 s); capacity returns afterwards. Stated, tested.
- `DatabaseCaptureAcceptanceStore.get(tenantId, id)` maps the stored acceptance projection to the adapter's record (reviewer = `createdBy`, no note text); `record()` throws:
  acceptances are created only by the decision endpoint.
- When disabled, controllers still register (so routes answer 503, not 404) and collaborators are optional providers; the gate runs before anything is touched.

## 8. How I verify

- **First commit of 3.2b-1, pushed as a draft before anything else is built:** a test in the `database-and-storage` job that runs the **real reader** on D01 through
  `SubprocessReportReader.read` and asserts the packet's bindings equal `PINNED_READER` (`generatorCodeHash` and the others), and that `verifyPinned()` returns no
  mismatches. It **fails**, never skips, if Python or the engine is missing, so a green CI run is evidence the intended reader ran with its dependencies. If it fails I fix
  the job before building more.
- **Unit and contract:** runner (every fixture, unknown hash, corrupt entry, missing directory, replaced bytes), limiter (cap, release on timeout/spawn failure/non-zero exit/
  thrown error/disconnect), acceptance store mapping, DTO mappers (no text, no key, no note), env validation for each new variable.
- **Disabled-gate matrix:** the route list is taken from the controllers' own metadata, so a route added later without the gate fails. With the switch off, every new route
  answers 503 `PIPELINE_DISABLED` with spies proving **zero** calls to the reader, object storage (no read, no write, no link), the ledger repository and the knowledge
  loader; 401/403 always win over 503.
- **Roles:** every row of the role table through HTTP with tokens carrying exactly those groups (including `clinician`+`reviewer`, `admin`+`reviewer`, `admin` alone), once as
  an independent person (accepted) and once as each of the four excluded identities (409 `self-review`); a missing role is always 403, never 409.
- **Capture races (two real sessions, barrier = the lock queue):** report change commits first → capture refused; capture commits first → change refused; each with a control.
  Concurrent identical captures → one row, one event.
- **Evaluation:** failed attempt then success with the same identity; N concurrent identical requests → one row, one event; replay returns the same record and appends
  nothing; same PDF in two tenants or two reports never shares a capture, text object or result; wrong-report capture refused; rejected capture; stale acceptance;
  text hash mismatch (text object replaced); dispute at the start and appearing at the barrier (both orders, plus dismissed); reader timeout and spawn failure → 503 and
  nothing stored; no database transaction open during a deliberately slow reader.
- **End to end over HTTP on the real database and the S3 emulator, D01 to D12:** presigned upload of the real `source.pdf`, complete, capture, decision by a second person,
  evaluation. The **independent oracle** is the hand-written `golden.json` (gene inputs, per-occurrence notes, and the engine's outcome, strength and wording for the two
  test drugs; D08 and D12 held). A fresh engine run on the recorded inputs is labelled a *persistence-consistency* check only (both could share a defect). The tenant's ledger
  chain verifies afterwards with the verifier login.
- **Logs and errors:** no report text, span text, note body, storage key or link in any log line or error body (a test captures logs for a full run).
- **Defect injection with controls** (all must be caught; equivalent mutants explained, as in 5B-3.1): drop each independence check; drop the latest-acceptance check;
  drop the stale-acceptance check; skip the byte re-hash; skip the pinned version; skip the expected-bindings comparison; skip the post-lock dispute check; fold the dispute
  check into the append; store `READER_UNAVAILABLE` outcomes; allow `enabled` in production; remove the gate from one route; remove a role from one route; return note text;
  drop a tenant scope; let the fake runner trust the stored hash instead of the retrieved bytes.
- Clean-state run before each PR: typecheck, lint, build, `knowledge:verify --production`, `test:infra`, `test:ci-config`, chunk check, gitleaks, three backend tiers, frontend
  tests; browser tests in CI.

## 9. Decisions only you can make

| # | Decision | Recommendation |
| --- | --- | --- |
| 17 | Split 3.2b into 3.2b-1 (evidence in) and 3.2b-2 (results out) | Yes |
| 18 | **Text object is not version-pinned.** The capture record has no column for the text object's version, and adding one changes the hashed projection (a migration plus a projection version bump). Instead the text key is content-addressed and re-hashed at evaluation (`text-hash-mismatch`). A reviewer's text link is therefore latest-by-key, not version-pinned | Accept for this stage; revisit with the real runner |
| 19 | Who may get file links (PDF and text): clinician, reviewer, admin; **not** reader. The earlier table said "all"; a PDF is the most sensitive artifact in the system | Yes, restrict |
| 20 | `dispute-active` is **tenant-wide** until the overlay exists | Yes (blunt and safe; nothing can raise a dispute over HTTP until 5B-3.3 anyway) |
| 21 | `source-limit` and `candidate-or-frame-limit` are stored as `held` evaluations (facts about the text); `source-time-budget` and `worker-error` answer 503 and store nothing | Yes |
| 22 | `actionable` is `false` for every evaluation while `clinicalUse` is `not-approved` | Yes (honest; the field becomes meaningful only after clinical sign-off) |
| 23 | No frontend screen in 3.2b; the pipeline is exercised by API tests only | Yes (a review UI is its own slice) |

Carried decisions 11 to 16 (versioning/pinning, four identities, named acceptance and "stale", POST from a superseded acceptance is always 409, six-year noncurrent retention,
synthetic scope recorded inside the evaluation) are applied as written in plan v2 section 12 and are already merged in 3.2a.

## 10. What I have not checked, and the risks

- **Not checked:** that the real reader's `verifyPinned()` and D01 read pass in the CI job (the first commit answers it); that a 20 KB PDF round trip through moto presigned PUT behaves
  like the small test objects (the end-to-end test will show it).
- **The limiter is per process.** A multi-instance deployment would multiply the cap.
- **Orphan text objects** are possible after a failed insert (harmless, content-addressed).
- **Reader and engine remain test-only**; the pipeline answers `clinicalUse: "not-approved"` everywhere and is refused in production. This slice does not change that.
- **Source-bound clinical context** (indication, population, specimen) is still deferred (spec section 14): the engine takes none, and no response claims otherwise.
- **No operational-failure store:** a repeating `READER_UNAVAILABLE` is visible in logs only until the observability work.
- **The break-glass role** for deleting object versions is still described, not created (carried from 3.2a).
- **Fixture directory as an installation dependency:** if the repo layout changes, the fake runner fails at startup with a clear message; it is not a runtime fallback.

## 11. Order of work

3.2b-1: (1) real-reader checkpoint, pushed as a draft, CI green before anything else; (2) shared-types DTOs and runner with tests; (3) repository changes
(expected bindings, `findAcceptance`, `findCaptureByIdentity`) with the two-session tests; (4) services and controllers; (5) gate/role/disabled matrices; (6) docs; (7) clean-state
run, defect injection, draft PR, subscribe, stop for review.
3.2b-2: (1) repository dispute re-check with its barrier tests first; (2) limiter and providers; (3) acceptance store; (4) evaluation service and controllers; (5) D01 to D12 end to end;
(6) negative suite and defect injection; (7) docs; (8) clean-state run, draft PR, subscribe, stop for review.
