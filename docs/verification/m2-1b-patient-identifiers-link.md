# M2.1b patient identifiers and a verified report link: verification

Implementation on local branch `claude/m2-1b-patient-identifiers-link-v2`, **stacked on the local M2.1a branch** (`claude/m2-1a-tenants-member-admin-v2`, not yet a pull request; M1.5, M1.5b and M1.6 are merged into `main`), because it adds to the role matrix and the tenant registry of M2.1a and its migration follows M2.1a's 0019: this slice is migration **0020**. It was first written on a stack of local branches (as migration 0019) and moved here by cherry-pick; the earlier branch `claude/m2-1b-patient-identifiers-link` is kept locally as the old stack. Design, the key-custody section and where it differs from the plan: [m2-1b-identifiers-and-patient-link.md](../design/plans/m2-1b-identifiers-and-patient-link.md). Results below were captured locally on 2026-10-14 on the moved branch. **Not pushed, no pull request yet (kept local at the founder's request), so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS; nothing tested against real Cognito or RDS.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0020: `patient_identifiers` (keyed digest only; one active holder per number; the one change is active to withdrawn, once, by the person making the request), `report_patient_decisions` (a ledger record naming the exact file and patient; triggers for independence and currency), the ledger learns event type `patient-link-decision` | `apps/backend/migrations/0019_patient_identifiers_and_link.{up,down}.sql` |
| Key derivation and digest (HKDF per organization from one master, HMAC-SHA-256, exact-match normalization) | `patient-identity/identifier-digest.ts`, `config/env.ts` |
| Identifier routes (register, list, withdraw) and their repositories (in memory and PostgreSQL) | `patient-identity/*`, `storage/patient-identifiers.repository.ts`, `storage/postgres/patient-identifiers.repository.ts` |
| Link routes (state, decide) and the ledger record: projection, repository, event type | `patient-identity/patient-link.service.ts`, `ledger/ledger-types.ts`, `ledger/projections.ts`, `storage/postgres/ledger-records.repository.ts` |
| The gate: the evaluation is refused (409 `patient-link-unverified`) before the reader runs, and again inside the storing transaction after the ledger lock | `lab-reports/evaluations.service.ts`, `storage/postgres/ledger-records.repository.ts` |
| Terraform: secret container for `IDENTIFIER_DIGEST_KEY`, read by the service's execution role, injected into the task; guards extended (nothing applied) | `infrastructure/terraform/api-compute.tf` and its guards |
| Classification, shared types, a button on the DEV-only local review page, the three local-review verify scripts | `db/append-only-tables.ts`, `packages/shared-types/src/patient-identity.ts`, `apps/frontend/src/pages/LocalReviewPage.tsx`, `scripts/local-review/verify-*.cjs` |
| Docs | `ops/patient-identifiers.md`, `ops/api-hosting.md`, `lab-report-reader.md`, `design/records-and-corrections.md` (3.6a), `database.md`, `auth.md`, STATUS, the plan |

No new dependency.

## Tests added

| Test | Proves |
| --- | --- |
| `src/patient-identity/identifier-digest.spec.ts` (5) | The digest equals values computed by an independent implementation (HKDF and HMAC written from their definitions in Python); another organization, system or key gives another value; white space and letter case are ignored and punctuation is not; full-width forms fold; the system and value cannot borrow from each other |
| `src/patient-identity/identifier-logging.spec.ts` (2) | The request logger writes only the request id and method, so a body, query or header cannot carry an identifier into a log; a control shows the assertion can fail |
| `src/lab-reports/evaluation-gate.spec.ts` (2) | Nothing in production source but the evaluations service creates evaluations, and that service always names the link decision it relied on |
| `test/patient-identifiers.e2e-spec.ts` (18; memory and PostgreSQL) | Register, list and withdraw without the value or the digest in any response; the same number under different case or spacing is one identifier (409 `identifier-in-use`) while different punctuation or another system is another; the refusal for a number held by the same or another patient is identical and names no holder; organizations are separate and another organization's patient is 404; ten malformed bodies are 400 and echo no value; withdrawal frees the number and the row stays listed; the role matrix (clinician only writes; reader and reviewer read; administrator alone and no role are refused); on PostgreSQL a scan of every table finds neither value and every digest is 32 bytes |
| `test/patient-link.e2e-spec.ts` (27; PostgreSQL, pipeline on) | The state starts unverified; the report's creator, upload requester and uploader are each refused (409 `self-review`) and record nothing, a bystander succeeds; roles (administrator alone, reader, no role refused); a match verifies (any case or spacing) and shows as the stronger method; a wrong value, another system, another patient's identifier, a withdrawn one and a near miss are 409 `identifier-mismatch` and write **no** decision and **no** event; the same number in another organization never matches; attestation and rejection with coded reasons; ten malformed bodies are 400; a repeated decision is 200 and writes nothing new; two people at once leave a valid chain; each decision has its own ledger event with no identifier anywhere in the database and the verifier accepts the chain; a replaced file makes the link unverified, keeps the old decision visible as out of date and blocks evaluation until a new decision; the gate refuses evaluation until verified, allows it after, refuses after a rejection and allows again after a second look (the same evaluation comes back); an unaccepted capture still answers `capture-not-accepted` first; with the pipeline off both routes are 503 for a permitted role and 403 for one that is not |
| `test/db/patient-identity.pg-spec.ts` (16) | The application login cannot edit, delete or truncate identifiers; even the owner cannot edit a digest, withdraw twice, return to active, or withdraw in another person's name; one active holder per number with separate organizations and systems; malformed rows refused; row-level isolation; the decision table refuses the registering people, a file or patient the report does not have, an identifier that is withdrawn or another patient's, and (with the row triggers off so only the CHECK speaks) every shape outside the frozen vocabulary while accepting every legal one; append-only even for the owner; the repository refuses a decision about a changed file and stores it with its event, returns the same record for the same decision; storing an evaluation refuses (`PatientLinkUnverifiedError`) when a newer decision exists, a rejection, a replaced file, or no such decision |
| `src/config/env.spec.ts` (+2), shared-types (+3), `LocalReviewPage.test.tsx` (+2), `ledger-catalog.pg-spec.ts` (+1) | Production refuses a missing or malformed key; the contracts; the page's button; the new table's privileges (a column grant for withdrawal only) |
| Terraform guards (+controls) | The key is injected from its secret (never plain), readable by the service only, encrypted with the data key; each proved by weakening the text |

### Existing tests changed by hand

The lab-report helper `reviewedCapture` now has the reviewer verify the link (and takes `verified: false` for the tests of the gate); `ledger-watch` counts one more event; `ledger-database.pg-spec` seeds one decision (event counts moved by one); migration lists in six specs moved to 0020, and reverting 0020 now needs the audit setting like the other audit migrations; the schema acceptance helper, the interceptor inventory (16 controllers) and the restore check (see below) know the new tables and controllers.

## A defect the tests found in my own migration

The first version of the decision table's CHECK accepted an attestation with **no reason** (`basis_code` NULL made the whole expression NULL, and a CHECK accepts NULL). The shape test, which turns the row triggers off so only the CHECK can answer, failed; the fix is an explicit `basis_code IS NOT NULL`. Injected defect S11 below restores it to prove the test. A second test was too loose at first (it accepted any `23xxx` code, so a later, unrelated ledger-event failure satisfied it): injected defect S3 got past it, and the test now requires the table's own code.

## Defect injection

Each rule was broken on purpose with a script that edits the source or migration, runs the named tests and restores the file (no backup file left; the unmutated suites re-run green).

| Injected defect | Result |
| --- | --- |
| The table lets the registering people decide | 1 failed |
| The service stops refusing the people who took part | 1 failed |
| The table accepts a decision about a file the report no longer has | 1 failed (after tightening the test, above) |
| An identifier that does not match is accepted | 2 failed |
| The key is not specific to the organization | 3 failed |
| Normalization also strips punctuation | 4 failed |
| Evaluation does not require a verified link | 2 failed |
| The storing transaction does not re-check the link | 1 failed |
| A decision about an earlier file still counts | 1 failed |
| Two patients may hold the same active number | 4 failed |
| A missing reason passes the CHECK (NULL semantics) | 1 failed |
| An administrator alone may decide | 1 failed |
| An administrator alone may read identifiers | 1 failed |
| The request logger writes the body | 1 failed |
| The digest is returned to the caller | 7 failed |
| A withdrawn identifier still matches | 1 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config` | 35 of 35 |
| `test:infra` | 31 of 31 |
| Backend, in memory | 92 suites passed, 10 skipped; 1,359 tests passed, 229 skipped |
| Backend, PostgreSQL 16 plus Moto S3 | 144 suites, 2,130 tests passed (the three recovery suites run separately) |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Frontend unit | 22 files, 263 tests passed |
| Smart-pilot package | 9 files, 186 tests passed |
| Shared types | 25 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0020 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts` (waits for the old report list's "Next reports" button; failing before this slice, recorded in the M2.1a note) |

These results are from the branch after it was moved onto the M2.1a branch as migration 0020 (2026-10-14); the earlier results on the old stack were within a few tests of these. The defect-injection runs below were done before the move and not repeated; their guarding tests ran in the full runs.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request yet. Nothing ran against real Cognito, RDS, Secrets Manager or ECS; the Terraform change is checked only by the repository's text guards, not by `terraform plan`.
- **Key rotation is not built.** Replacing `IDENTIFIER_DIGEST_KEY` orphans every stored identifier (raw values are not kept). The column that would carry a key version exists; the procedure is written, not exercised.
- **The evaluation gate is not a table trigger.** It is in the evaluations service and re-checked inside the storing transaction. A caller that wrote evaluations through the repository without naming a decision would bypass it; a test pins that the service is the only such caller in production source, and the future worker (M2.3) must go through the service.
- Registering and withdrawing an identifier writes no ledger record or security event (the row keeps who and when); only the link decision is a ledger record, as the plan said.
- Nothing yet quarantines the existing evaluations of a report whose link is later rejected, and duplicates are only refused (409), not reviewed or merged: M2.1c.
- No screen: the routes are API-only, except a button on the DEV-only local review page. The local review launcher (`pnpm demo:review:setup`) appears not to grant memberships or register organizations, which the API has required since M1.5 and M2.1a; the three verify scripts were updated for the new step but not run. That is queued as its own task.
- The restore verification's row-level-security isolation check was already taught that `tenants` is keyed by `id` in M2.1a; `patient_identifiers` and `report_patient_decisions` use `tenant_id` and needed no change.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
