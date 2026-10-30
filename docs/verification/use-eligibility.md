# Verification: use eligibility records and `use-eligibility-v1` (spec 020, E1b)

Date: 2026-10-30. Branch `feat/use-eligibility-records` off `main` `f0a777e7` (E1a merged). Local only, not pushed. Plan: spec 020 `plan.md` and `tasks.md`, E1b slice plan B1 to B5 (founder, 2026-10-30, accepted as recommended).

**What was claimed:**
- Five ledgered records (migration 0063): `use_grants`, `use_grant_validations` (B2), `use_withdrawals`, `use_restrictions`, `tenant_use_terms`. All append-only, tenant-scoped, FORCE RLS, one ledger event each.
- `use_eligibility(...)`, policy `use-eligibility-v1`: fails closed with sorted reason codes and evidence ids; v1 allows only the synthetic jurisdiction `ZZ` (B1); reads the fact's `data_provenance` (B3); returns legal authority and classification (B4); expiry `date` or research-only `no-expiration` (B5).
- Answers as of an instant from what was recorded by then (T205); a per-patient lock so a withdrawal racing a use is never missed (T206).
- No writer outside tests and seed fixtures (T207).

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster), Moto on its own port, the Playwright Chromium build, Docker 29.6.2. The report-reader engine is absent, as in every public checkout.

## Tests (synthetic fixtures; the oracle is the database, read as the administrator, or the database's own refusal)

- `apps/backend/test/db/use-eligibility.pg-spec.ts`: **83** tests.
  - Per table: each CHECK refused with its pinned code and constraint name; append-only (UPDATE, DELETE, TRUNCATE); FORCE RLS with tenant isolation and a positive control; actor binding; self-validation refused; a back-dated withdrawal refused; `event` expiry and `no-expiration` outside research refused; an unknown purpose refused.
  - The function: one test per reason code (14), asserting the exact list; a multi-reason test; an eligible control for a capture fact and one for an evaluation fact.
  - Replay (T205): a synthetic timeline (grant, validation, restriction, withdrawal, a later back-dated grant) re-asked at every past instant after all later records exist.
  - Race (T206): two connections; the withdrawal waits on the lock a use holds, and no use answers eligible after a withdrawal that committed before its ask; positive control included.
  - The ledger verifies a chain holding all five event types, goes red when one row is altered, and returns to `ok` when restored.
- `apps/backend/src/ledger/use-eligibility-no-writer.spec.ts` (T207): scans every non-test source file under `apps`, `packages`, `scripts`, `infrastructure`, `sidecars` and `ml`; only the three ledger registration files may name these tables or the function, and no controller or route exists for them. Positive controls included.
- `down-guards-as-migrator.pg-spec.ts`: the down migration refuses a populated database **as the non-superuser migrator**, with a positive control that it passes empty.
- Inventories updated: schema acceptance, tenant binding (policies 60 to 70), tenant capability, down guards. The E1a "verifies across the migration" test pinned `0062` as the newest migration; it now reverts and re-applies through `data_provenance` by name.

**Reason codes:** `unknown-purpose`, `unknown-classification`, `no-terms-in-force`, `terms-purpose-not-authorized`, `terms-classification-not-authorized`, `no-grant`, `grant-not-yet-effective`, `grant-expired`, `grant-withdrawn`, `grant-unvalidated`, `restriction-in-force`, `jurisdiction-not-allowed`, `origin-unknown`, `origin-not-allowed`.

## Mutation checks (scratch edit, run, then restored and sha256-matched)

| Mutation | Result |
| --- | --- |
| The `grant-withdrawn` reason removed | caught: 6 tests, among them `grant-withdrawn`, the replay test and both lock tests |
| `created_at <= at` dropped from the grant lookup | caught: the replay test (T205) |
| A second allowlisted jurisdiction (`US`) | caught: `jurisdiction-not-allowed` and the multi-reason test |
| The real-origin check removed | caught: `origin-not-allowed` and the multi-reason test |
| The lock in the withdrawal trigger removed | caught: both T206 lock tests |
| Down guard removed | caught: the E1b down-guard test |
| The restriction check disabled (rerun independently by the parent session) | caught: `restriction-in-force`, the multi-reason test and the replay test |

## Full local loop (`f0a777e7` plus this change; every local step of the CI `verify` job, listed from `.github/workflows/ci.yml`)

| Step | Result |
| --- | --- |
| typecheck, lint, build, `pnpm test` (workspace), `test:demo-seed`, `check:chunks`, `knowledge:verify --production`, shared-types build, `check:workflows` | pass |
| `test:ci-config` | 207 / 207 |
| `test:infra` | 157 / 157 |
| `check-without-reader.sh --measure --listed` | pass |
| `test:fixture-lifecycle` | 9 pass, 2 fail (tests 6 and 8): the same two fail on unchanged `main` on this machine; cause unproven, not caused by this change |
| worker | 241 / 241 |
| frontend | 539 / 539 |
| backend default / PostgreSQL / PostgreSQL+S3 | 3220 / 3750 / 3770 passed, 0 failed (of 3771) |
| Playwright `e2e` | 161 passed and 3 skipped, 38 passed, 2 passed |
| Playwright `e2e:storage` | 33 passed |
| Docker image rehearsal (`rehearsal.cjs` on a local linux/amd64 build of `api.Dockerfile`) | pass |
| gitleaks over the changed directories | no leaks |
| FHIR IG validation (`smart-pilot test:ig`) | not run: no Java 21 here; this change does not touch the SMART pilot |

## Not covered

- **Isolation level:** `use_eligibility_lock` returns the time read after the lock, which a caller passes as `at`. That is safe in READ COMMITTED, the application's level; a REPEATABLE READ caller would read a snapshot taken before the lock.
- **Tenant terms take no lock.** A later terms version supersedes an earlier one, and nothing ends terms early, so no race was found; E2 (the operator command) should revisit it.
- **Down guard per table:** validations and withdrawals are never populated without a grant, so the guard is exercised through terms, restrictions and grants.
- Three `*_by_actor` CHECKs are unreachable through the triggers and have no test of their own.
- E5's proof that the patient received a copy, its recipients and its intake time are not stored yet; they belong with E3's form.
