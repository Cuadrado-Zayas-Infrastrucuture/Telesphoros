# Verification: no raw genomic data (VCF uploads removed)

Date: 2026-10-28 to 2026-10-29. Branch `feat/remove-vcf-uploads`, built on `main` `fefcb31` and re-verified after rebasing onto `main` `828f8b3` (migration renumbered 0056 to 0057, because spec 012's 0056 merged first). Local only, not pushed. Status: [2026-10-28-no-raw-genomic-data.md](../status/2026-10-28-no-raw-genomic-data.md).

**What was claimed:**
- `vcf` is no longer a report type anywhere: shared schema, structural validator, frontend choices, database CHECKs.
- Migration 0057 refuses to run, and changes nothing, on a database holding a VCF report or upload attempt; it never rewrites a row.
- Evidence catalogues and recovery checks count three kinds: `lab-pdf`, `structured`, `text`.
- `structured` (the curated JSON report) and `lab-pdf` keep working.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster with password checking), Moto (the CI pin) on its own port, Chromium for Testing 1248.

## Tests

- `apps/backend/test/db/no-raw-genomic-data.pg-spec.ts` (new, 2):
  - at head, a `vcf` report is refused with SQLSTATE 23514 on `reports_type_valid`, and a `vcf` upload attempt on `report_upload_attempts_type_check`; `structured` and `lab-pdf` rows are accepted (positive controls);
  - a database migrated through 0056 that holds a VCF report refuses `migrateUp`: 0057 is not recorded, the row is still `vcf`, and the old CHECK still lists `vcf`. An empty database applies 0057.
- `structural-validator.spec.ts`: the constructor refuses `vcf`, `VCF`, `pdf` and `''`; `structured` and `lab-pdf` still build.
- `lab-pdf-reports.e2e-spec.ts`: `POST` with a `vcf` report answers 400; a structured report still answers 201.
- `shared-types.test.ts`, `productUploadSchema.test.ts`, `uploadReportSchema.test.ts`, `types/report.test.ts`: `vcf` and `.vcf` refused in create, patch and DTO; no `text/x-vcf` content type; structured accepted.
- Browser: `e2e/foundation.spec.ts` and `storage-e2e/storage.spec.ts` check that no `vcf` option is offered, in the normal and the owned-storage build.
- Every other test that used VCF as an ordinary upload now uses structured JSON. Where the swap would have turned a "changed type" case into a no-op (the old value already equalled the new one), the case now changes to `lab-pdf` instead (registration, PATCH, repositories, worker content-type mismatch).
- A leak check in `reports-intake-organization.e2e-spec.ts` looked for the VCF header text, which no sample contains any more; it now uses a canary string inside the malformed JSON it sends.

## Mutation checks (each must turn its test red; every file restored and its hash re-checked)

| Mutation | Test | Result |
| --- | --- | --- |
| Remove the validator's constructor guard | `structural-validator.spec.ts` | red |
| 0057 keeps `vcf` in `reports_type_valid` | `no-raw-genomic-data.pg-spec.ts` | red |
| 0057 keeps `vcf` in `report_upload_attempts_type_check` | `no-raw-genomic-data.pg-spec.ts` | red |
| Shared `REPORT_TYPES` offers `vcf` | shared-types tests | red |
| Frontend `REPORT_TYPES` offers `vcf` | `types/report.test.ts` | red |
| Application recovery accepts 6 objects (the old per-kind counts) | `.github/ci/guard.test.mjs` | red |

## Full local loop

| Step | Result |
| --- | --- |
| build, typecheck, lint (incl. Prettier), root tests, infra tests, smart-pilot, branding, demo seed | pass |
| CI config tests | 207/207 |
| Frontend unit | 478/478 |
| Worker (real Postgres and Moto) | 241/241 |
| Backend, default tier | 3083 passed, 360 skipped |
| Backend, `TEST_STORAGE=postgres` | 3422 passed, 21 skipped |
| Backend, Postgres and S3 | 3442 passed, 1 skipped |
| Reader-engine listed check | pass |
| Playwright `e2e` (three configs) | 138, 30 and 2 passed |
| Playwright `e2e:storage` (on `fefcb31`) | 26 passed, 6 failed, 1 did not run; **the same 6 fail on unmodified `fefcb31`** (see below); not rerun on `828f8b3` |
| L3 storage rehearsal (on `fefcb31`) | failed at its Playwright step (see below); not rerun on `828f8b3` |
| gitleaks (history and directories) | no leaks |

Every other step above was rerun on `828f8b3` after a fresh `install --frozen-lockfile` (frontend 478, worker 241, CI config 207, Playwright 138, 30 and 2), and all six mutations were caught again. After #149 (frontend skeletons) and #150 (Terraform) merged, the branch was rebased onto `a1f9eb2` and the steps they could affect were rerun: install, build, typecheck, lint, infra, CI config, branding, gitleaks, frontend 482/482 and Playwright 144, 30 and 2, all passing.

**Red before this change (a finding, not a baseline):** on an unmodified `fefcb31` worktree, with a fresh migrated database and seeded memberships, `e2e:storage` fails the same 6 tests (reader metadata, pagination and reviewer access, and report-interactions, each at both viewports). Likely cause, not proven: the failing tests sign in a second persona in the same browser, and the fake identity provider's account picker never appears. The report-interactions test counts 2 reads where it expects 1; its cause is unknown. The L3 rehearsal runs the same `storage-e2e` suite in its Playwright step, so it most likely fails for the same reason; the rehearsal was not run on the baseline.

**Preview images:** the browser suite regenerates 12 images under `docs/design/previews/`. They are committed, because the landing and workflow previews showed `SYN-001.vcf` and `SYN-003.vcf` and now show PDF names.

## Not verified

- Hosted CI.
- The rehearsal on the baseline.
- Migration 0057 against a database that already holds real VCF rows outside tests: none exist (synthetic data only).
