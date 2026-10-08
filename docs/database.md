# Database and storage

PostgreSQL 16 holds metadata; object storage (S3) holds report files. **Synthetic data only** until the
AWS BAA is executed and the compliance prerequisites are complete.

## Schema (migrations `apps/backend/migrations/`)

| Table | Holds | Notes |
| --- | --- | --- |
| `patients` | synthetic label only | No name, date of birth or real identifier exists in the model, by design |
| `reports` | report **metadata**: type, filename, size, status, content type, SHA-256, storage key | The bytes are in S3, never here |
| `recommendations` | engine output (read-only through the API) | Written only by the rules engine (Phase 5) |
| `report_captures`, `capture_acceptances`, `evaluations` (+ `evaluation_results`, `evaluation_gene_states`), `corrections`, `cell_disputes`, `cell_dispute_decisions` | the records of the lab-report pipeline (migrations 0007 to 0009) | **Append-only** (nobody updates or deletes, the owner included); each row has its own event in the tenant's hash chain, committed in the same transaction. Not connected to any endpoint yet (5B-3.2). Design: `docs/design/records-and-corrections.md` |
| `event_notes` | every free-text note, kept out of the chain (0006) | Insert-only except one audited redaction |
| `ledger_events`, `ledger_heads`, `ledger_checkpoints` | the per-tenant audit chain (0005) | Written only by the ledger functions; verified by `src/ledger/verifier.ts` |

Rules enforced **by the database itself** (each is asserted by a test that tries to break it):

- **UUID primary keys** (`gen_random_uuid()`), matching the public ids in the API.
- **Every table has `tenant_id` (the organization that may see the row) and `created_by` (the individual who made it).**
  Every foreign key is **composite** (`id, tenant_id`), so a child row cannot point at another tenant's parent even if
  application code were wrong. Neither column can change after insert (a trigger refuses it, even for the table owner).
  (Migration 0003 renamed `owner_id` to `tenant_id`; each former owner became a tenant of one.)
- **Every foreign key states `ON DELETE RESTRICT`.** Clinical history is never silently cascaded away.
- **Soft delete** (`deleted_at`). The application role has no `DELETE` privilege at all. Soft-deleting a patient
  that still has live reports (or a report with live recommendations) is refused by a trigger, mirroring `RESTRICT`.
- **Unique:** one live label per tenant (case-insensitive; a soft-deleted row frees its label); one report per
  storage key (the same file cannot be registered twice).
- **Checks:** label and filename formats, size 1 byte to 10 MB, valid status/type/strength, lowercase hex SHA-256,
  and "uploaded implies key + checksum + content type".
- **`created_at` / `updated_at`** on every table; `updated_at` moves automatically unless the writer sets it.
- **`seq`** (identity) gives stable creation order for pagination, because timestamps can tie.
- **Indexes** on the tenant plus the filtered and ordered columns, and on every foreign key.

## Row-level security (defence in depth)

The API connects as a login role that is a member of `telesphoros_app`: **not** a superuser, **not** the table
owner, **no** `BYPASSRLS`, **no** `DELETE`/`TRUNCATE`/DDL. Each request runs in **one transaction** that first
executes `set_config('app.current_tenant_id', <tenant from the token>, true)` (transaction-local, so it cannot leak to the
next request on a pooled connection). The policies compare `tenant_id` to that setting; **if it is missing the role
sees nothing** (fail closed; code still setting the old `app.current_owner_id` therefore sees nothing either). Every query also names `tenant_id` explicitly, so two independent layers protect each
row. Tests prove each layer separately and together (`test/db/rls.pg-spec.ts`, `repositories.pg-spec.ts`).

| Role | Used by | Can |
| --- | --- | --- |
| table owner / admin | migrations, backup, restore (`DATABASE_MIGRATOR_URL`, `DATABASE_ADMIN_URL`) | everything; bypasses RLS (needed so a backup sees every row) |
| `telesphoros_app` (group) + a login user | the API (`DATABASE_URL`) | `SELECT/INSERT/UPDATE` on `patients`, `reports`; `SELECT/INSERT` on `recommendations`; read `schema_migrations`; **bound by RLS** |

The ledger adds four more `NOLOGIN` roles (`telesphoros_ledger`, `telesphoros_redactor`, `telesphoros_ledger_verifier`,
`telesphoros_ledger_operator`) with narrow rights; what each may do, how the migrator and the verifier and operator logins are
provisioned, and what a restore needs: [docs/ops/ledger-roles.md](ops/ledger-roles.md). Tests for them live in `apps/backend/test/db/ledger-*.pg-spec.ts`.

The login user and its password are provisioned **outside the repository** (locally by
`infrastructure/docker/postgres-init.sql`; in AWS by an operator step, with the password in Secrets Manager).

## Migrations

Plain numbered SQL, no ORM: `NNNN_name.up.sql` + `NNNN_name.down.sql`, applied by `src/db/migrator.ts`.

```bash
pnpm --filter @telesphoros/backend build                    # the CLI runs from dist/
export DATABASE_MIGRATOR_URL=postgres://<owner>@<host>/<db>
pnpm --filter @telesphoros/backend db:status
pnpm --filter @telesphoros/backend db:migrate               # apply pending
pnpm --filter @telesphoros/backend db:migrate:down          # revert the last one
```

- Each migration runs in **its own transaction**; a failure rolls back completely and names the migration.
- An **advisory lock** makes two simultaneous deploys safe (the second waits, then finds nothing to do).
- A **checksum** is stored; **editing an applied migration is refused**. Add a new migration instead.
- Versions must be contiguous and every migration needs a `down`.
- `/api/v1/ready` returns **503 while migrations are pending** or the database is unreachable; `/health` stays 200.

## Report files

Upload is two steps and the browser talks to storage directly:

1. `POST /api/v1/reports/:id/upload-url` with `{ contentType, sha256 }` returns a short-lived URL (default 5 minutes,
   one object, content type and length signed). The object key is generated by the server:
   `reports/<hash of tenant>/<report id>/<random>`.
2. The browser `PUT`s the file to that URL. Then `POST /api/v1/reports/:id/complete`: **the server streams the object
   back and checks its size, content type and SHA-256** before marking the report uploaded. It does not take the
   client's word for any of them.

Known gaps: a file that fails verification stays in the bucket until a lifecycle rule or a later cleanup job removes
it; there is no download endpoint yet; report files are versioned but **not** replicated to a second region by the
current Terraform.

## Requirement: backups live away from the database, ideally with another provider

Founder requirement (2026-10-08). **Built and tested against an emulator; not yet met in fact.** It is met when the
first real drill in `docs/ops/offsite-backups.md` has been run against the chosen provider. What exists:

- Backups are encrypted and signed on the backup host (chunked AES-256-GCM, signed manifest, key file held offline by
  two people; `docs/ops/backup-and-restore.md`), so the provider holds only ciphertext.
- Upload goes to any S3-compatible provider with its own `BACKUP_S3_*` credentials (the AWS credentials are never
  used), a separate upload-only key and read-only key, Object Lock on every object, and optionally no copy left on the
  job's disk. `backup-check` proves the set-up, including that the keys really are upload-only and read-only.
- Restore can read directly from the second provider and verifies exactly like a local restore.

Still open: which provider (founder, after reading its BAA); where the scheduled job runs (hosting phase); the first
drill with a real provider; multipart upload above 5 GiB. Any provider that holds backups of real patient data needs a
signed business associate agreement first. Until then backups contain synthetic data only.

## Running it locally

| You have | Do |
| --- | --- |
| Docker | `docker compose -f infrastructure/docker/docker-compose.yml up -d` (PostgreSQL 16 + MinIO) |
| No Docker | `apps/backend/scripts/dev-postgres.sh start` (a throwaway local PostgreSQL; trust auth, 127.0.0.1 only) |

## Tests

| Tier | Needs | Command |
| --- | --- | --- |
| Unit + e2e on the in-memory store | nothing | `pnpm --filter @telesphoros/backend test` |
| + schema, RLS, repositories, backup/restore, readiness on real PostgreSQL | `TEST_DATABASE_URL` | `TEST_DATABASE_URL=$(scripts/dev-postgres.sh url) pnpm --filter @telesphoros/backend test` |
| + the whole API suite running **on PostgreSQL** | same | `... test:db` |
| + the whole API suite uploading over the S3 protocol | `TEST_S3_ENDPOINT` + `TEST_OBJECT_STORAGE=s3` | `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 ... test` |

A plain `test` prints which tiers it skipped. **CI runs all three tiers** (the `database-and-storage` job in
`.github/workflows/ci.yml`) and fails the job if any tier reports `NOT RUNNING`: a green run without them says nothing
about the schema.
