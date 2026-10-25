# Verification: LLM harness slice 3b-1 (2026-10-25)

Scope: `apps/backend/{migrations/0048,src/db,test}`, `apps/ai-service/{durable,test}`, docs, `specs/003-llm-harness/tasks.md`.

## Environment

Node 22.22.0, PostgreSQL 16.15 (Homebrew tools first on PATH), `LC_ALL=en_US.UTF-8`, my own cluster on loopback port 54433 (SCRAM, `max_connections=200`), created for this run and not shared with another session. `TEST_STORAGE=postgres`. No S3 emulator: the object-storage specs did not run.

## Checks

- Migration written before its spec; the spec was then written and run (41 tests). The red evidence is the mutations below, not a pre-migration run.
- `test/db/agentic-explain-receipts.pg-spec.ts`: 41 tests pass.
- Down guard: a new case in `down-guards-as-migrator.pg-spec.ts` (the non-superuser migrator login): a populated table is refused, the refusal rolls back whole, the exact setting allows it.
- `apps/ai-service`: `receipt-store.test.ts` (6, in the default run) and `durable/receipt-store.pg.test.ts` (3, local-only, against my cluster): every kind of ending `runExplanation` produces (nine) is accepted by the database and reads back equal, so the TypeScript shape and the SQL checks agree.
- The first full backend tier (`TEST_STORAGE=postgres`, 207 suites) found four failing suites (12 tests), all caused by this change, fixed here: the migration lint (`REVOKE` and a `TRUNCATE` trigger in an `expand` migration, so relabelled `breaking`), the schema-acceptance primary-key and check-constraint pins (which also failed `report-registration`), and the 0031 revert test's list of removed functions. The second full run: 201 suites passed, 6 skipped (the report-reader engine and object storage are absent in this repository or locally), 2666 tests passed, 0 failed.
- The root `pnpm test` then found one more pin: `test/durable-surface.test.ts` lists the durable modules and their import allowlist; `receipt-store.ts` and its two imports (`../src/outcome-v2`, `./postgres`, a type) were added to it on purpose. Prettier reformatted three test files; the DB specs were rerun after (102 passed, and the 3 local-only adapter tests).
- Final loop (Node 22.22.0): `typecheck`, `lint` (with the Prettier check), root `pnpm test` (ai-service 21 files, 311 tests), `test:infra`, `test:ci-config` 203 of 203, gitleaks no findings.

## Broken on purpose (against the 41-test spec)

| Mutation of `0048` | Failing tests |
|---|---|
| The tenant and requester check removed from the append function | 1 |
| Updates allowed by the row guard | 1 |
| The retention floor removed from the row guard | 2 |
| The evidence digest check accepts any prefix | 2 |
| The key-set check removed from the append function | 1 |
| A text column added with no check | 2 |

The file was restored after each and the 41 tests passed again.

## Known limits

- The functions refuse a caller with no capability. The worker login has no way to present one today (the worker side binds through an internal binding that is not built), so the worker's EXECUTE grant is unusable until it is. Review question for the schema session.
- The purge is per organization and has no scheduler; nothing runs it.
- Retention is a constant in the trigger and the purge function (2190 days). Changing it is a migration.
- The digest key's custody and rotation are not designed here.
- Nothing in a running service calls the store yet.
- Hosted CI has not run. The object-storage specs did not run locally.
