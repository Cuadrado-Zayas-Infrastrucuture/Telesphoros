# M2.2b retire the direct-upload path: verification

Implementation on local branch `claude/m2-2b-retire-legacy-upload`, **stacked on M2.2a** (`claude/m2-2a-validated-intake`), the M2.2 plan branch, M2.1c-2 and the earlier M2.1 branches; none is a pull request yet (kept local at the founder's request). Plan and decisions DI-1 to DI-7 (yes to all, 2026-10-14): [m2-2-durable-intake.md](../design/plans/m2-2-durable-intake.md), which records where the build differs. Results below were captured locally on 2026-10-14. **Not pushed, no pull request, so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS.

## What was implemented

| Change | Where |
| --- | --- |
| The routes `POST /reports/:id/upload-url` and `/complete` are gone (404), with the service methods, the repository methods `recordUploadRequest` and `markUploaded`, the presigned-upload capability `ObjectStorage.createUploadTarget` (all four adapters), `reportObjectKey`, the setting `UPLOAD_URL_TTL_SECONDS` and the shared contracts for the upload link | `reports.controller.ts`, `reports.service.ts`, `storage/**`, `object-storage/**`, `config/env.ts`, `packages/shared-types/src/report.ts` (the declaration schema is now `reportFileDeclarationSchema`) |
| A lab PDF is gated on the pipeline at every step of the intake (declare, send, resume), as the retired completion was | `reports/intake/intake.service.ts` |
| Operator command `uploads sweep [--tenant ID] [--grace-seconds N] [--dry-run]`: closes abandoned attempts, returns their quota, deletes nothing from the bucket | `reports/intake/sweep.ts`, `db/cli.ts` |
| Terraform: the application policy may list a report's intake prefix (`s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`, only under `reports/*`); written, never applied | `infrastructure/terraform/iam.tf`, `guard.test.mjs` |
| The auditor command can filter by `intake.rejected` | `security-events/security-events-cli.ts` |
| Frontend: the product upload page and the local review page upload through the attempt routes in every build (no local-browser restriction, no storage origin for uploads); the experiment's patient is kept beside the retry state | `src/lib/api.ts`, `ownedStorageApi.ts`, `localReportApi.ts`, `storageMode.ts` |
| Local review verification scripts use the attempt routes | `scripts/local-review/verify-*.cjs` |
| Docs | `ops/report-upload.md` (rewritten), `database.md`, `design/local-storage-intake.md`, `ops/security-events.md`, `apps/backend/README.md`, the plan, STATUS |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/reports-upload.e2e-spec.ts` (rewritten, 14; memory, PostgreSQL, S3) | The old upload scenarios through the intake: register, declare, send, pin; the public shape leaks nothing; resuming a committed attempt is idempotent and a second attempt for an uploaded report is 409; (S3) exactly one object under `reports/<hash>/<id>/intake/<attempt>`; a checksum or size that differs from the declaration is refused and stores nothing (control: the right file is accepted); validation (content type, checksum, unknown fields); a reader is 403, another organization 404; authentication; **the old routes answer 404, signed in or not** |
| `test/lab-pdf-reports.e2e-spec.ts` (pipeline block rewritten) | Identity of requester and uploader is the person who declared and sent it; another clinician cannot send its bytes; a repeated resume changes nothing; a later write to the same key does not move the pin; mismatched bytes pin nothing; an unversioned store pins nothing; a captured report cannot change type or be deleted; with the pipeline off again declare, send and resume are 503 and the pipeline-on request works (control); isolation by tenant |
| `test/db/upload-sweep.pg-spec.ts` (5) | Closes an old declaration and an old stored attempt and returns exactly their quota; says which may have left an object; leaves a fresh one, a committed one and a held one; respects the grace period (control: a shorter one closes it), closes a cancelled attempt at once, dry run changes nothing; works with the application login (row-level security) and never touches another organization; deletes no report or committed row; refuses a grace outside its range; the command reports per organization and in total and refuses bad arguments |
| `src/storage/uploaded-at-pin.spec.ts` (4) | Only one SQL statement in the source sets `uploaded_at` (the commit, requiring a stored attempt); the only production writer of a new report builds it with no upload field; the in-memory store marks uploaded in its commit step only; none of the removed entry points exists anywhere in `src` |
| `test/db/repositories.pg-spec.ts`, `test/helpers/uploads.ts`, `recovery-seed.ts`, `lab-pipeline.ts` | The repository tests for "the first requester is kept, the upload is pinned once" now drive the attempt methods; fixtures that used the removed methods use `commitUpload`; `LabPipeline.uploadedLabPdf` goes through the intake, and `seededLabPdf` (a fixture no route can reproduce) gives the independence tests a requester and uploader who differ |
| `test/db/security-events.pg-spec.ts` | The auditor filter finds `intake.rejected` |
| Frontend unit: `api.test.ts` (rewritten), `localReportApi.test.ts` (rewritten), `ownedStorageApi.test.ts` | Declare, send through the API, read back; works in a production build on a real host; lost registration and lost transfer replies recover without a second transfer or second report; a fresh key after changing patient, type, file name or bytes; inconsistent registration or final report refused; a non-committed attempt is not success; no object-storage request is made; API errors never show the response |
| Browser: `e2e/upload.spec.ts` (rewritten), `foundation.spec.ts` | No request to object storage and no old route during an upload; lost replies recover one report with one transfer; a refused transfer keeps the form and replays the same declaration; a malformed file is refused and cannot show success; the keyboard test now uploads a valid file |

## Defect injection

Each rule was broken on purpose with a script that edits the source, runs the named tests and restores the file.

| Injected defect | Result |
| --- | --- |
| Sweep ignores the grace period | 2 failed |
| Sweep does not return the quota | 2 failed |
| Sweep reaches other organizations (tenant predicate removed) | 1 failed |
| Sweep counts every closed attempt as keeping an object | 2 failed |
| Sweep accepts a grace beyond a week | 1 failed |
| Lab PDF bytes accepted with the pipeline off | 1 failed |
| Lab PDF resume accepted with the pipeline off | 1 failed |
| Another statement sets `uploaded_at` | 1 failed |
| `intake.rejected` missing from the auditor filter | 1 failed (after adding the test) |
| Terraform listing statement removed, or widened beyond `reports/*` | guard test fails (1 of 32) |
| Frontend: input not validated before registering | 1 failed |
| Frontend: final report hash not checked | 2 failed |
| Frontend: a non-committed attempt counts as success | 1 failed |
| Frontend: bytes sent without the attempt revision | 1 failed |
| Frontend: a replayed declaration is created again instead | 2 failed |
| Frontend: the local experiment forgets its patient | 2 failed |

**Three defects survived and are not tested for, with the reason:** the sweep closing a *committed* attempt, closing an attempt a report points at, and closing one a writer holds. Each is also excluded by another condition of the same query (a committed attempt is never past its lease and a report only points at the key of a committed attempt; a writer holds an unexpired lease), so removing one clause alone changes no outcome; the database guard also refuses to modify a committed attempt. They are kept as defence in depth. One further injected frontend change (a request id suffix) was a no-op by construction and was replaced by the real defect in the last row but one.

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config`, `test:infra` | 35 of 35, 32 of 32 |
| Backend, in memory | 96 suites passed, 11 skipped; 1,389 tests passed, 253 skipped |
| Backend, PostgreSQL 16 plus Moto S3 | 154 suites, 2,230 tests passed (1 skipped); the three recovery suites refuse to run as root and are the next row |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Frontend unit | 22 files, 254 tests passed |
| Shared types | 24 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0022 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts` (failing before this slice, recorded in the M2.1a note) |
| `scripts/local-review/verify-upload.cjs` against Moto | all six checks pass (declaration, checksum, size, type, missing-then-recovered, success) |
| `uploads sweep --dry-run` through the built command line on a migrated database | runs, reports `would release 0 attempt(s)` for two organizations |

The smart-pilot package is untouched and was not re-run.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request.
- **Nothing here runs against AWS.** The new IAM statement is written and guard-tested, never applied; whether the real bucket policy, the load balancer timeout for a transfer of up to 60 seconds, and the task's memory allow the intake under load is not measured (M5.3).
- `scripts/local-review/verify-review.cjs`, `verify-operations.cjs` and `verify-poppler-review.cjs` were converted with the same helper as `verify-upload.cjs` and syntax-checked, but need the local review database and (for the last) Poppler, and were **not run**.
- The disposable local-run scope and its cleanup library remain (see the plan: an open question for the founder). `VITE_REPORT_STORAGE_ORIGINS` remains for downloads.
- Browser reload recovery (A08) is M2.2c; a reload still discards the in-flight attempt and can register a second report.
- The sweep returns quota but deletes no object; stored-but-uncommitted validated files stay until a break-glass act. There is no scheduler for the sweep; it is run by an operator.
- Structural validation is framing, not content, and is not malware scanning.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
