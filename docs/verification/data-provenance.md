# Verification: data provenance (spec 020, E1a)

Date: 2026-10-30. Branch `feat/data-provenance` off `main` `9fceca6f` (D02b merged). Local only, not pushed. Plan: spec 020 `plan.md` (E7) and `tasks.md`, E1a slice plan P1 to P4 (founder, 2026-10-30: provenance on captures and evaluations, not on `reports`).

**What was claimed:**
- A new ledgered record `data_provenance` (migration 0062, event type `data-provenance`): append-only, FORCE RLS, one row per capture and per evaluation, written in the fact's own transaction.
- `origin` is required with no default and set by the server (`currentDataOrigin`): `synthetic` only outside production with the pipeline enabled; it throws otherwise and never answers `real`.
- The field values of the slice plan's table; the four source fields stay null; no purpose, consent or eligibility column.
- The ledger verifies across the migration (T105).

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster), Moto on its own port, the Playwright Chromium build. The report-reader engine is absent, as in every public checkout.

## Tests (synthetic fixtures; the oracle is the database, read as the administrator, or the database's own refusal)

- `apps/backend/test/db/data-provenance.pg-spec.ts`:
  - the repository: one row per fact with the table's values; the capture as parent when an evaluation relied on no acceptance; no second row for an existing (idempotent or raced) fact; a missing origin refused in code with nothing stored; `real` allowed by the database;
  - the table: the exact column list; `origin` NOT NULL with no default; append-only (UPDATE, DELETE, TRUNCATE) and FORCE RLS; tenant isolation with a positive control;
  - about 20 direct INSERTs as the application role, each refused with its pinned error code and constraint name, plus a well-formed control refused only by the unique key;
  - T105: a tenant with captures from before 0062 and facts after it verifies `ok`; altering a provenance row turns the check red (`payload-mismatch`), and restoring it returns `ok`.
- `apps/backend/test/data-provenance.e2e-spec.ts`, over HTTP: capture, synchronous evaluation and queued-worker evaluation each store exactly one row; a request body naming `origin: 'real'` stores no `real` row.
- `apps/backend/src/ledger/data-origin.spec.ts`: `currentDataOrigin` throws for production, an unknown or missing `NODE_ENV`, and a disabled pipeline.
- `captures.service.spec.ts`: the origin is named before any file is read; in production nothing is read, stored or ledgered.
- `down-guards-as-migrator.pg-spec.ts`: a populated table is refused by the down migration **as the non-superuser migrator**, with a positive control that the same down passes once the table is empty.
- Inventories and counts updated: schema acceptance, tenant binding (policies 58 to 60), tenant capability, down guards, the recovery fixture (`data_provenance` 30, `ledger_events` 90), and the hard-coded event counts of the ledger specs (each new capture and evaluation now adds one event).
- `infrastructure/docker/rehearsal-driver.cjs`: its seeded capture now names `origin: 'synthetic'`; without it the image rehearsal's ledger writes would be refused in code.
- **Compat label `breaking`:** the ledger's event-type set is restated with one more type, and the lint matches the keyword TRUNCATE in the required refusal. Nothing an older image reads or writes changes.

## Mutation checks (scratch edit, run, then restored and sha256-matched)

| Mutation | Result |
| --- | --- |
| `origin` given DEFAULT `'synthetic'`, and the column and `requireDataOrigin` dropped from both INSERTs | caught: "no origin refused in code", the `column_default` assertion, a direct INSERT with no origin (23502 expected), and `real` stored as synthetic |
| Down guard removed | caught: the populated down expected "Refusing to drop populated data provenance"; the ledger CHECK still refused it, less clearly |
| Provenance skipped on the queued path only | caught: the queued-worker e2e test; capture and sync tests stayed green |
| Capture provenance write skipped (rerun independently by the parent session) | caught: 8 tests in the two provenance specs |

## Full local loop (`9fceca6f` plus this change; every local step of the CI `verify` job, listed from `.github/workflows/ci.yml`)

| Step | Result |
| --- | --- |
| typecheck, lint, build, `pnpm test` (workspace), `test:demo-seed`, `check:chunks`, `knowledge:verify --production`, shared-types build, `check:workflows` | pass |
| `test:ci-config` | 207 / 207 |
| `test:infra` | 157 / 157 |
| `check-without-reader.sh --measure --listed` | pass |
| `test:fixture-lifecycle` | 9 pass, 2 fail (tests 6 and 8): the same two fail on unchanged `main` on this machine; cause unproven, not caused by this change |
| worker | 241 / 241 |
| frontend | 539 / 539 |
| backend default / PostgreSQL / PostgreSQL+S3 | 3215 / 3662 / 3682 passed, 0 failed (of 3683) |
| Playwright `e2e` | 161 passed and 3 skipped, 38 passed, 2 passed |
| Playwright `e2e:storage` | 33 passed |
| gitleaks over the changed directories | no leaks |
| Docker image rehearsal (`rehearsal.cjs` on a local linux/amd64 build of `api.Dockerfile`) | pass; with the driver's `origin` reverted it fails at the tenant-containment step (exit 1), so the driver change is required |
| FHIR IG validation (`smart-pilot test:ig`) | not run: no Java 21 here; this change does not touch the SMART pilot |

## Not covered

- **The production refusal of `currentDataOrigin`** is tested at unit level only; `env.ts` already refuses a production app with the pipeline on.
- **The request-field test** asserts that no `real` row is stored, not whether the extra field is refused or stripped.
- **Facts before 0062** have no provenance row, by design. The database does not require one per fact; the code does.
- **Rollout:** the verifier reads every record table, so the migration and the verifier must ship together.
