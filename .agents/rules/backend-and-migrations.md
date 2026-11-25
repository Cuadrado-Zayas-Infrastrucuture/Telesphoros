---
trigger: glob
globs: "apps/backend/**/*.ts, apps/worker/**/*.ts, apps/backend/migrations/*.sql"
description: Backend API, worker, PostgreSQL RLS, ledger, and migration rules for NestJS and PostgreSQL 16.
---

# Backend, Worker & Database Rules

Read `docs/database.md`, `docs/auth.md`, and `docs/design/records-and-corrections.md` when touching persistence, identity, or ledger paths.

## Tenant Isolation & Security
- Derive tenant identity and roles from the verified principal and live database membership (`tenant_memberships`); never trust client-supplied tenant IDs.
- Use parameterized SQL exclusively and preserve forced Row-Level Security (RLS) on every tenant table; application roles must never bypass RLS.
- Never log PHI, raw patient identifiers, secrets, signed URLs, or unredacted `error.message` fields (API logs pass the pino allowlist).
- Preserve actor separation (e.g., uploader cannot verify patient links or accept their own capture) and version-pinned S3 object reads (`SHA-256` + storage version).
- Append-only record tables and the per-tenant hash-chained ledger must never be updated in place; corrections and disputes are new ledgered records.

## Migrations
- Every schema change is a new sequential pair: `apps/backend/migrations/NNNN_slug.up.sql` and `NNNN_slug.down.sql`. Never edit an applied migration.
- Include `-- compat: expand` or `-- compat: breaking` in the leading comment block (enforced by `apps/backend/src/db/migration-lint.ts`).
- Check exact migration CLI scripts in `apps/backend/package.json`: `pnpm --filter @telesphoros/backend db:migrate`, `db:migrate:down`, `db:status`.

## Verification
- A mocked or in-memory test run proves nothing about SQL, RLS, or ACLs. Run real PostgreSQL 16 and S3 tiers when touching DB, storage, roles, or workers:
  - `pnpm --filter @telesphoros/backend test`
  - `TEST_STORAGE=postgres pnpm --filter @telesphoros/backend test`
  - `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm --filter @telesphoros/backend test`
  - `pnpm --filter @telesphoros/worker test`
- Prove application-role tenant isolation, not only superuser queries.
