# M2.2: one validated, durable intake path for every report (plan)

Status: **approved by the founder on 2026-10-14 (DI-1 to DI-7: yes to all, recommendations as written). M2.2a and M2.2b are built on local branches (`claude/m2-2a-validated-intake`, then `claude/m2-2b-retire-legacy-upload`, stacked; not pushed); M2.2c is not started.** Backlog T07 of the [build plan](repo-audit-and-build-plan.md); closes audit findings E04 (no structural validation on the legacy path) and A08 (upload recovery across a browser reload) and finishes founder decision DA-3 (recommended: retire the legacy path). Synthetic data only; nothing here lifts the BAA or clinical hold; nothing is applied in AWS.

## Problem, as the repository stands after M2.1c-2

Two ways to put a file into the reports bucket exist, and they do not overlap:

| | Legacy path (`POST /reports/:id/upload-url`, browser `PUT` to S3, `POST /reports/:id/complete`) | Validated intake (`POST|PUT|… /reports/:id/upload-attempts…`, L1/L2) |
| --- | --- | --- |
| Where the bytes go | Browser to the **final bucket key**, before anyone has looked at them | Through the API into an owned 0700 staging file, validated, then written to the bucket |
| What is checked | Size, content type and SHA-256, after the fact (`reports.service.ts` `completeUpload`) | Declared size, type and hash **plus bounded structure** (VCF, JSON syntax, PDF framing; `structural-validator.ts`), time and speed limits, before any bucket write |
| A bad file | Sits in the bucket (an unverified version exists) | Never reaches the bucket; the attempt ends `cancelled` with no bytes kept |
| Where it may run | Everywhere; the **only** path the lab-PDF pipeline can use (`assertEnabled`) and the only one production can use | **Only** a disposable local run: `assertLocalStorage` refuses production, requires `LAB_REPORT_PIPELINE=disabled`, a loopback database named `test_…`/`synthetic_storage_…`, a loopback bucket named `synthetic-storage-<run>` and `LOCAL_STORAGE_RUN_ID`; keys are `local-storage/<run>/<attempt>`; the sweeper (`cleanup.ts`) accepts only such a run |
| Browser recovery after a reload | None: state lives in the mounted form, a reload can register a second report ([ops/report-upload.md](../../ops/report-upload.md)) | The server keeps the attempt (`upload_attempts`, migration 0015) and offers `upload-state`, `resume`, `cancel`, but the browser forgets the attempt id on reload |

So the rigorous path cannot run where it matters, and the path that can run (production, and the lab pipeline) is the weak one. Lab PDFs, the only files that feed evaluations, go through the weak path today.

## Proposal in one paragraph

Make the validated intake the **only** way a report file reaches the bucket, in every mode including production and with the lab-report pipeline on; retire the presigned-PUT routes; replace the "disposable local run" scaffolding with the tenant-scoped rules the rest of the product uses; add an operator sweep for abandoned attempts; and let the browser remember an in-flight attempt across a reload so the person can resume or cancel it. No new clinical behavior, no change to the ledger, no change to what an evaluation or a link decision means: the report row, its pinned `object_version`, `sha256` and the upload identities (`created_by`, `upload_requested_by`, `uploaded_by`) keep their meaning.

## Slices (one pull request each, in this order, each stops for review)

| Slice | Content | Depends on |
| --- | --- | --- |
| **M2.2a** | Backend: the intake works in production mode and with the pipeline on, for all three report types; key layout and quota become tenant-scoped; `uploaded_by`/pinning/ledger-facing fields behave exactly as the legacy `complete` produced them; legacy routes still present but marked deprecated. Migration only if the attempt table needs it (see Touched). | answers to DI-1 to DI-5 |
| **M2.2b** | Retire the legacy routes (`upload-url`, `complete`) and `VITE_REPORT_STORAGE_ORIGINS`; the product upload page and the local review page use the attempt routes; sweep command for abandoned attempts; docs and runbooks updated. A breaking API change, internal to this repository (callers listed under Touched). | M2.2a, DI-1 |
| **M2.2c** | Frontend reload recovery (A08): the page keeps `{reportId, attemptId, revision, fileName, sizeBytes, sha256}` in `sessionStorage`, offers "Resume" (after the person re-selects the same file, matched by hash) or "Cancel", and never creates a second report for the same upload. | M2.2b, DI-6 |

## What is touched

- `apps/backend/src/reports/intake/*` (policy, staging, service, cleanup), `reports.service.ts` (legacy routes), `reports.controller.ts`, `config/env.ts` (`LOCAL_STORAGE_RUN_ID` and `LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS` rules), `object-storage/*` (key layout, inventory by prefix), `storage/**/reports.repository` (attempt methods), `db/cli.ts` (sweep command).
- Possibly one migration (0022) to drop the run-id coupling from `upload_attempts` and index the tenant-scoped reservation count; decided in the M2.2a detail once DI-3 is answered.
- Frontend `lib/api.ts`, `lib/ownedStorageApi.ts`, `lib/localReportApi.ts`, the upload page, and `storage-e2e`/`e2e` upload specs. Scripts `scripts/local-review/verify-*.cjs` and `apps/backend/test/*upload*`, `lab-pipeline.ts` helper (they call the legacy routes today).
- Docs: `ops/report-upload.md`, `ops/local-storage-*.md`, `design/local-storage-intake.md`, `database.md`, STATUS.

## What this does not touch

The ledger, projections and every event type; link decisions, quarantine and merges (M2.1); the lab-PDF reader and what it reads out of a PDF; the knowledge release; file download links; roles (`clinician` alone uploads, unchanged); Terraform (nothing applied; the bucket policy for browser PUT/CORS can be **removed** in a later infrastructure slice once the legacy path is gone, but this plan writes none of it); real PDF/OCR content analysis beyond the existing structural framing check; malware scanning (not claimed anywhere in this plan; a structural check is not an antivirus).

## Decisions only the founder can make

| # | Question | Recommendation |
| --- | --- | --- |
| DI-1 | Retire the legacy presigned-PUT path (DA-3) instead of adding the same checks to it? | **Yes.** A browser-to-bucket PUT cannot be validated before it is stored; copying the validator behind it would still leave unvalidated bytes in the bucket until a sweeper runs. |
| DI-2 | Bytes pass through the API (10 MiB maximum, at most 2 intakes per process, 60 s) rather than a quarantine bucket with a post-upload scan? | **Through the API**, as already built and measured (96 MiB RSS ceiling test). A quarantine bucket needs a second bucket, lifecycle rules and a scanner worker (M2.3 territory) and still stores unvalidated bytes. Cost: API capacity and the load balancer idle timeout must cover 60 s; to be confirmed in M5.3 load measurement, not claimed here. |
| DI-3 | Replace the run-scoped scaffolding with tenant-scoped keys (`reports/<tenant hash>/<report id>/<attempt>`) and a per-tenant quota? | **Yes.** The run-id rules exist to keep a test run from touching anything else; production needs the same safety from tenant scoping and row-level security. Default quota: 100 MiB of uncommitted reservations per tenant, as today per run. |
| DI-4 | Record a refused file (reason code only, no bytes, no filename) as a security event (`intake.rejected`)? | **Yes**, in the existing `security_events` store, so repeated bad uploads are visible to an auditor. |
| DI-5 | Must the lab-PDF pipeline use the new path before it is allowed anywhere beyond synthetic use? | **Yes**: M2.2a makes `LAB_REPORT_PIPELINE=enabled` and the intake compatible, and a test pins that a lab PDF cannot become `uploaded` any other way. |
| DI-6 | Reload recovery keeps identifiers (not the file, never a patient identifier) in `sessionStorage` and requires re-selecting the file? | **Yes.** A browser cannot keep a `File` across a reload; matching by SHA-256 on re-selection proves it is the same bytes. Sign-out clears the entry. |
| DI-7 | Order: M2.2a, M2.2b, M2.2c, one pull request each, and none pushed until you say (as for M2.1)? | As written. |

## M2.2a as built, and where it differs from the plan

[Verification](../../verification/m2-2a-organization-intake.md). The plan's wording is kept above; the build made these concrete:

1. **Two scopes live side by side until M2.2b.** The disposable local run (`LOCAL_STORAGE_RUN_ID`) keeps every L1 restriction and its keys; without a run id the intake works in the **organization scope** in any mode (`intake/scope.ts`, `assertIntakeAllowed`). M2.2b deletes the local-run scope together with the legacy routes, so no test or runbook has to change twice.
2. **Keys are `reports/<tenant hash>/<report id>/intake/<attempt id>`**, one level more specific than DI-3's sketch: the extra `intake/` segment keeps the per-report inventory from ever meeting the legacy key (`…/<report id>/<random>`) or the captured text (`…/<report id>/text/…`). The inventory before a new attempt is per report, so its cost does not grow with the organization.
3. **The quota is the existing `report_upload_runs` row**, with a fixed id derived from the organization, so no migration was needed for it: 100 MiB of uncommitted reservations per organization (database check), released when an attempt is committed or cleaned.
4. **A lab PDF still needs the pipeline** to be declared (503 while it is off), exactly as the legacy routes require. DI-5's "must use the new path" is met from the other side: once an attempt exists for a report the legacy upload link and completion refuse it (`409 validated-intake-required`), and a test pins that a malformed file written straight to the attempt's key cannot be completed through the legacy route. A guard that no *other* code path sets `uploaded_at` on a lab PDF waits for M2.2b, when the legacy routes go.
5. **DI-4 needed one migration, 0022**: security event type `intake.rejected` (reason codes `structure`, `size`, `checksum`, `timeout`, `slow`; never the file, name, hash or report), the same one-per-minute throttle per person, organization, type and reason. A transfer the person cancelled is not an event.
6. **A bucket that cannot be listed fails closed** (503, nothing reserved). The application's Terraform policy (`iam.tf`, written, never applied) grants `PutObject`, `GetObject` and `GetObjectVersion` only, **not** `s3:ListBucketVersions` or `s3:ListBucketMultipartUploads`, which the inventory needs. M2.2a changes no Terraform (as planned), so in AWS the intake would answer 503 until that is added. **Prerequisite for M2.2b**: add the two list actions (with a prefix condition on `reports/*`) and a guard test before the legacy routes are retired.

## M2.2b as built, and where it differs from the plan

[Verification](../../verification/m2-2b-retire-legacy-upload.md). Done as planned: the Terraform listing permissions (`iam.tf`, written, never applied, with a guard test); the routes `POST /reports/:id/upload-url` and `/complete`, the presigned-upload capability (`ObjectStorage.createUploadTarget`, `UPLOAD_URL_TTL_SECONDS`) and the repository methods behind them are deleted, and the old paths answer 404; the product upload page and the local review page upload through the attempt routes in every build; an operator command `uploads sweep`; a source-level test that only a committed attempt can set `uploaded_at`. Differences:

1. **The disposable local-run scope stays.** M2.2a said M2.2b would delete it. It is the foundation of the L3 rehearsal harness (`scripts/local-storage`: `demo:storage`, `test:storage-rehearsal`, `test:storage-recovery`, the storage browser suite and `LocalUploadCleanup`), which has its own cleanup receipts and run manifests; retiring the scope means retiring that harness, which deserves its own decision. The legacy *routes* are gone either way, so the harm the plan named (two parallel transports) is closed; what remains is one transport with two key layouts. **Open question for the founder:** keep the rehearsal harness (recommended while the product is synthetic-only), or schedule its removal.
2. **`VITE_REPORT_STORAGE_ORIGINS` stays, for downloads only.** A download is still a browser fetch of a signed link from the bucket, which the page checks against that list. Uploads no longer read it. Removing it needs downloads to stream through the API, a separate change.
3. **The sweep deletes nothing from the bucket.** Neither login may delete object versions (only the break-glass role), and a validated file that was stored but never committed is kept. The sweep returns the reservation, marks the attempt `cleaned` (its key stays known) and reports how many closed attempts may have left an object. The local-run cleanup, which does delete, remains for disposable runs.
4. **Requester and uploader are now one person.** An attempt belongs to the person who declared it and is committed with that person as uploader, so `upload_requested_by` and `uploaded_by` are equal for every intake report (the legacy path let them differ). The capture independence rule excludes the creator, requester, uploader and capturer, so it loses no protection; tests that needed distinct requester and uploader seed the evidence columns directly (`LabPipeline.seededLabPdf`, a fixture no route can reproduce).
5. **Lab PDFs are gated at every step**, not only when declared: sending bytes or resuming an attempt for a lab PDF answers 503 while the pipeline is off, as the retired completion did.
6. **Not done here:** the lab-PDF-pipeline-only uploaded guard in the database (a trigger) was replaced by the source-level pin; a database trigger would break every fixture that seeds a report directly, and no route can write the column now.

## Verification (what each slice must show before it is called done)

- **Tiers:** in-memory, PostgreSQL, PostgreSQL plus Moto S3, the three recovery suites as an unprivileged user, browser `e2e` and `e2e:storage` on a database migrated to the newest migration.
- **M2.2a:** a malformed VCF, JSON and PDF are refused with **no object and no version in the bucket** (inventory empty, including multipart); a valid file of each type is stored once with a real version, and the report row carries the same hash, version and identities the legacy `complete` produced; two tenants cannot see or exhaust each other's reservations (control: the same tenant can); a lab PDF uploaded this way is accepted by the existing capture route and a test proves nothing else sets `uploaded_at`; production-mode start-up works without any run id; a crash between write and commit is reconciled by `resume`/sweep and never leaves a committed row without its object. Control for every refusal.
- **M2.2b:** the legacy routes answer 404 (or 410, to be chosen), a static check shows no caller of them remains, `VITE_REPORT_STORAGE_ORIGINS` is gone from builds, and the sweep command removes only abandoned attempts past the grace period, never a committed or in-flight one.
- **M2.2c:** a browser test reloads mid-transfer and mid-"stored, not committed" and ends with exactly one report and one stored version; cancel after reload leaves nothing; sign-out clears the entry; no storage entry contains a patient identifier, file bytes or a token.
- **Defect injection** for every new rule, as in working agreement 6 (for example: validation moved after the write, a quota counted across tenants, a refused file leaving a version, a committed attempt swept, a second report created on reload).

## Known limits to carry forward

- Structural validation is framing, not content: a well-formed but wrong PDF is accepted here and is the reader's problem (M3.1).
- Capacity is per process (2 concurrent intakes); several API tasks multiply it, and the durable quota is what bounds reservations.
- Removing the browser-to-bucket path lets a later infrastructure slice delete the bucket's CORS/PUT allowances; until then they remain, unused.
- Retention of replaced versions (six years, existing decision) is unchanged.
