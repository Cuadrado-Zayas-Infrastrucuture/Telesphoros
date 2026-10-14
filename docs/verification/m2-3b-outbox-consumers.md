# M2.3b the outbox and the first two consumers: verification

Implementation on local branch `claude/m2-3b-outbox-consumers`, **stacked on M2.3a** (`claude/m2-3a-queue-core`, pull request #100) and everything beneath it; this slice is **not pushed and has no pull request** (kept local; no remote CI has run on it, so no required check is claimed). Plan and decisions DJ-1 to DJ-9 (yes to all, 2026-10-14): [m2-3-jobs-outbox-worker.md](../design/plans/m2-3-jobs-outbox-worker.md), which records where the build differs. Results were captured locally on 2026-10-14. Synthetic data only; nothing applied in AWS; no clinical record is read or written by any job.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0024: `outbox_events` (append-only but for one relay mark), `outbox_routes`, `file_verifications` (append-only for everyone); `outbox_append`, `outbox_relay`, `job_held`, `file_verification_target`, `file_verification_stale`, `file_verification_record`, `uploads_organization_run_id`, `uploads_sweep`, `job_uploads_sweep`; the queue role's tenant-scoped read policies on `reports` and `report_captures`; the seeded route and the two schedules | `apps/backend/migrations/0024_outbox_consumers.*.sql` |
| The upload commit writes its event inside its own transaction | `storage/postgres/reports.repository.ts` |
| One sweep, in the database: the operator command now calls it | `reports/intake/sweep.ts` |
| Production job definitions and the relay call | `packages/jobs` |
| Worker: the two consumers, the database and bucket access they are handed, a generic ticker (scheduler and relay), configuration for the bucket | `apps/worker` |
| Table classification (`OUTBOX_TABLES`, `VERIFICATION_TABLES`); the worker's S3-backed tests run in the existing CI step (the job already provides the emulator) | `append-only-tables.ts` |
| Docs | the plan ("as built"), `ops/jobs.md`, `ops/report-upload.md`, `database.md`, STATUS |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `worker/test/outbox.pg.test.ts` (9) | An event takes its organization from the transaction; a rolled-back change leaves none; a repeat leaves one; no organization bound or an unknown type is refused; neither the application nor the worker login can read, write or edit the outbox, the worker cannot forge an event and the application cannot relay; an event cannot be edited, deleted or truncated and is decided once; the relay makes one job per event (named by the event, flat payload, `system:outbox`) however many relays run at once; an unregistered organization is marked and creates nothing; an event with no route is marked and the batch goes on; a suspended organization still gets its job and the claim holds it until it is active; **the relay is atomic** (a job that cannot be made leaves the event pending, the next relay makes exactly one) |
| `worker/test/consumers.s3.test.ts` (16, real PostgreSQL and an S3 emulator) | The whole chain (event, relay, claim, handler, record): a matching file records `ok`; the **pinned version** is read even after a later overwrite and a delete marker; a missing version, different bytes, a different size and a different content type are each recorded with their reason and end the job dead without touching the object; a gone report succeeds without a record; the log names no key, version, hash or report id; a suspended organization's check is made, held, then runs once active; the daily re-check checks only its own organization, never-checked first then longest unchecked, leaves fresh reports alone until they age, and records every finding before ending dead; **the worker reaches these functions only through a job it holds** (wrong worker, wrong type, unknown or finished job refused; a record may name only the report its job names; reasons and outcomes are shape-checked; another organization's reports are not visible; the sweep cannot be called directly); the record is append-only for the owner and the application reads only its own organization's rows |
| `worker/test/worker-consumers.s3.test.ts` (3, the built worker process) | A committed event becomes a job and is verified with nothing else to start it (one clean, one changed); the schedule enqueues the sweep once per active organization per slot as `system:scheduler`; without a bucket the file jobs are not registered and the worker says so |
| `worker/src/handlers/consumers.test.ts` (14), `config.test.ts`, `boundaries.test.ts` | Every verdict branch of the handlers with fakes; production requires a bucket; the AWS SDK is imported in one file that has no write command and names a version |
| `backend/test/db/outbox.pg-spec.ts` (4) | The upload commit writes exactly one event for the report's organization, none for a declaration, a refused commit or a cancelled attempt, none when the transaction rolls back; the migration seeds the route and both schedules |
| `backend/test/db/upload-sweep.pg-spec.ts` (+3) | The scheduled job closes exactly what the operator command would, for its own organization only; the scope id is computed exactly as the application does; a cancelled attempt a writer still holds is left alone; the application login can no longer run the sweep |
| Migration-list specs, `schema-acceptance`, `ledger-catalog`, `backup-restore` | Updated for 0024 (counts, keys, checks, classification and policy inventory; the restore's row and policy baselines) |

## Defect injection

Each rule was broken on purpose with a script that edits the source or the migration, runs the relevant suites and restores the file (`inject9.py`; 42 defects).

| Injected defect | Result |
| --- | --- |
| The commit writes no event | 1 failed |
| The relay marks events without making jobs; makes jobs for unregistered organizations; skips suspended organizations; gives each job a random key; points at the wrong job type | 15, 1, 2, 1, 12 failed |
| The relay takes no row lock | 1 failed |
| An event can be deleted; a relayed event can change again | 1 and 1 failed |
| The application can run the relay; the worker can write an event | 1 and 1 failed |
| `job_held` ignores the worker; accepts any job type | 1 and 1 failed |
| A record may name any report | 1 failed |
| The stale list ignores how recently a report was checked | 1 failed |
| The stale list checks the checked first | survived at first; after adding the ordering test, 1 failed |
| The verification record can be edited; the application can write one; the application reads every organization's | 1, 1, 1 failed |
| The worker can run the sweep directly | 1 failed |
| The sweep closes an attempt a writer still holds | survived at first; after adding the test, 1 failed |
| The sweep ignores the grace period; closes attempts a report points at; the scope id differs; the sweep command does not use the function | 3, 1, 6, 6 failed |
| The schedules are not seeded | 1 failed |
| The re-check reads the latest object, not the pinned version | 2 failed |
| The hash, the size or the content type is not compared | 1, 1, 2 failed |
| A finding does not fail the job; a read failure is not retried; a missing file is reported as changed | 7, 1, 2 failed |
| The re-check ignores an abort; the stale job stops at the first finding | 1 and 1 failed |
| The inspector can write; a production worker may run without a bucket | 1 and 1 failed |
| The worker does not run the relay; does not run the scheduler | 1 and 1 failed |
| **Survived, judged equivalent:** a finished job still satisfies `job_held` | A finished job has no holder (`locked_by` is cleared), so the worker check already refuses it |
| **Survived alone, caught with its second guard removed:** the stale list ignores the job's organization | Row-level security on `reports` (the queue role's policy is scoped to the organization the job fixes) refuses the rows on its own; removing both the filter and the policy makes 2 tests fail |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:infra`, `test:ci-config`, `test:image` | 32, 36, 19 passed |
| In-memory tier (`pnpm test`, no services) | pass (backend 1,392; worker 41; jobs 13; frontend 291) |
| Worker on PostgreSQL and the S3 emulator | 112 passed, repeated twice |
| Backend on PostgreSQL uploading over S3, 153 suites | 2,206 passed, 1 skipped, 0 failed |
| Recovery suites (backup/restore, recovery CLI, application and independent recovery, restore check, catalogue, off-site restore) as an unprivileged user from a repository copy | 97 passed |

## What this does not show

- No remote CI has run on this slice. The container image rehearsal was not run (no Docker daemon here); 0024 adds nothing the image build or its rehearsal steps depend on beyond the existing migration run, which the provisioned-login tests do exercise.
- Real S3 behavior is not shown: the emulator returns the same errors for a missing version, but IAM, versioning on a real bucket and network failures are not.
- The worker has never run on ECS, has no database login in any environment, and no alarm exists for a dead job or a failed check (M2.3c).
- Throughput under real load, and the cost of the daily re-check reading up to 25 files per organization, are not measured.
- A failed check currently produces a dead job and a row, nothing more: no notification, no screen, no automatic response, by design.
