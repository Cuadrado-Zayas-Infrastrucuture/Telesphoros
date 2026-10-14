# M2.2a validated intake in the organization scope: verification

Implementation on local branch `claude/m2-2a-validated-intake`, **stacked on the M2.2 plan branch** (`claude/m2-2-intake-plan`), which sits on M2.1c-2 and so on M2.1c-1, M2.1b and M2.1a. None of these is a pull request yet (kept local at the founder's request); M1.5, M1.5b and M1.6 are merged into `main`. Plan and decisions DI-1 to DI-7 (answered yes by the founder on 2026-10-14): [m2-2-durable-intake.md](../design/plans/m2-2-durable-intake.md), which also records where the build differs. Results below were captured locally on 2026-10-14. **Not pushed, no pull request, so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS.

## What was implemented

| Change | Where |
| --- | --- |
| Intake scope: a disposable local run keeps its rules and keys; without a run id the intake runs in the organization's scope in any mode. Keys `reports/<tenant hash>/<report id>/intake/<attempt id>`, an inventory per report, a reservation scope derived from the organization (its 100 MiB quota is the existing `report_upload_runs` row) | `src/reports/intake/scope.ts`, `local-policy.ts` (`assertIntakeAllowed`), `intake.service.ts` |
| A lab PDF is declared only while the pipeline is on (as the legacy routes require); a listing that fails or is unavailable answers 503 and reserves nothing (it was an unhandled 500) | `intake.service.ts` |
| A refused file is recorded as a security event `intake.rejected` (reason `structure`, `size`, `checksum`, `timeout` or `slow`; not a cancelled transfer) | `src/security-events/security-events.ts`, migration `0022_intake_rejected_event` |
| A report that has had an attempt is closed to the legacy `upload-url` and `complete` routes (`409 validated-intake-required`) | `reports.service.ts`, `ReportsRepository.hasAttempts`, `reportAttempts` (both stores) |
| Test helper option `organizationIntake` | `test/helpers/app.ts` |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/reports-intake-organization.e2e-spec.ts` (19; 15 on memory, 19 on PostgreSQL plus S3) | A valid VCF and JSON file is stored once under the report's `intake/` key with a real version and the same identities the legacy completion records (`uploaded_by`, `upload_requested_by`), downloads byte for byte (S3 tier); a malformed VCF, JSON or PDF writes **nothing** (no `putStream`, empty inventory, `uploaded_at` null), closes the attempt and leaves one security event holding only a short reason (the file name, hash, report id and attempt id are searched for and absent), repeated within a minute adds none; a different reason is a second event and a cancel is none; a transfer cancelled **while running** records no event (the service is driven directly with a body that waits); the quota per organization (ten declared 10 MiB files fill it, an eleventh is 409, another organization is unaffected, a cancelled one frees its share); a stray object under one report blocks that report only; a listing outage is 503 with nothing reserved, then works; the legacy upload link and completion refuse a report with an attempt while the upload link still serves one without (control), and a file with the right size, type and hash written straight to an attempt's key cannot be completed through the legacy route; a reader, a stale revision and another organization are refused; a lab PDF is 503 with the pipeline off; unauthenticated and reviewer callers are refused |
| Same file, pipeline block (PostgreSQL) | With the lab-report pipeline on, three fixture lab PDFs stored by the intake carry the creator, requester and uploader identities, a real version, and are captured by the existing route (201); a malformed PDF writes nothing, records the rejection, cannot be completed by the legacy route and cannot be captured |
| `src/reports/intake/scope.spec.ts` (3) | The organization id is a stable valid UUID unique per organization; the key sits under the report's `intake/` prefix and neither another report's, another organization's, a legacy key nor a captured-text key is under it; a local run is unchanged |
| `test/db/security-events.pg-spec.ts` (+2) | The application may record `intake.rejected` for the bound person, throttled per type and reason (the same word under the other type is its own event), with the same detail rules as a refusal (a fresh person each time, so the throttle cannot be what refuses); the down migration refuses with a recorded rejection, reverts with the deliberate setting, forgets the type, and comes back up |
| `test/local-storage-faults.e2e-spec.ts` | The test that documented an unhandled 500 on a listing outage now expects 503 |
| Migration lists (`migrations`, `ledger-migration`, `recommendation-integrity`, `report-evidence`, `report-registration`, `security-audit`, `recovery-cli`) | Know about 0022 (22 migrations) |

## Defect injection

Each rule was broken on purpose with a script that edits the source or the migration, runs the named tests on PostgreSQL plus S3 and restores the file. Two defects first **survived** (a cancelled transfer recorded as an event; the legacy completion not closed), which showed two weak tests; both were strengthened (the two tests above that drive the service directly and write straight to the key) and the defects then failed one test each.

| Injected defect | Result |
| --- | --- |
| A rejection is not recorded | 4 failed |
| A cancelled transfer is recorded | 1 failed (after strengthening) |
| The event carries the report id as its reason | 4 failed |
| Every organization shares one quota | 1 failed |
| The inventory is organization-wide, not per report | 7 failed |
| The key is outside the intake prefix (legacy shape) | 3 failed |
| A lab PDF is taken while the pipeline is off | 1 failed |
| The legacy upload link still serves a report with an attempt | 1 failed |
| The legacy completion still accepts a report with an attempt | 1 failed (after strengthening) |
| The organization scope is refused like a non-local run | 14 failed |
| The throttle ignores the event type | 1 failed |
| The application may record any event type | 1 failed |
| The new type is not in the table check | 2 failed |
| The down migration keeps rejections without the setting | 1 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config`, `test:infra` | 35 of 35, 31 of 31 |
| Backend, in memory | 95 suites passed, 11 skipped; 1,390 tests passed, 253 skipped |
| Backend, PostgreSQL 16 plus Moto S3 | 152 suites, 2,227 tests passed (1 skipped); the three recovery suites refuse to run as root and are the next row |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0022 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts` (failing before this slice, recorded in the M2.1a note) |

The frontend, shared-types and smart-pilot packages are untouched by this slice and were not re-run.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request.
- **Nothing here runs against AWS.** The application's Terraform policy has no `s3:ListBucketVersions` or `s3:ListBucketMultipartUploads`, which the inventory needs, so in AWS the intake would answer 503 until they are added. That Terraform change (with a guard test) is a prerequisite for M2.2b and was deliberately not made in this slice.
- No frontend uses the intake outside the local-run browser suite; the product upload page still uses the legacy routes, which remain open to a report with no attempt. The legacy routes, the local-run scope and the operator sweep for abandoned organization attempts are M2.2b. Until the sweep exists, an unknown object under a report's `intake/` prefix keeps that report's declarations at 503.
- A guard that no code path other than a committed attempt can set `uploaded_at` on a lab PDF waits for M2.2b (the legacy completion still can for a report with no attempt).
- Structural validation is framing, not content, and is not malware scanning. Capacity is per process (two concurrent intakes); the durable quota is what bounds reservations. Throughput and the load balancer timeout for a 60 s transfer are not measured (M5.3).
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
