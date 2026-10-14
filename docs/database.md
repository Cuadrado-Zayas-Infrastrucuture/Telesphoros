# Database and storage

PostgreSQL 16 holds metadata; object storage (S3) holds report files. **Synthetic data only** until the
AWS BAA is executed and the compliance prerequisites are complete.

## Schema (migrations `apps/backend/migrations/`)

| Table | Holds | Notes |
| --- | --- | --- |
| `patients` | synthetic label only | No name, date of birth or real identifier exists in the model, by design |
| `reports` | report **metadata**: type, filename, size, status, content type, SHA-256, storage key, and (0010) the verified object version and who requested and completed the upload | The bytes are in S3, never here. Once uploaded, the file's identity cannot change; once captured, neither can the type, name, patient or deletion mark (enforced by trigger `reports_evidence_guard`). That last rule reads captures as the calling role, so it covers every application path; a table owner that is not a superuser and sets no tenant sees no captures and is not covered |
| `recommendations` | engine output (read-only through the API) | Repository insertion exists; general production engine ingestion remains Phase 5 work. Migrations 0012/0013 bind tenant, patient and report through a composite FK |
| `report_captures`, `capture_acceptances`, `evaluations` (+ `evaluation_results`, `evaluation_gene_states`), `corrections`, `cell_disputes`, `cell_dispute_decisions` | the records of the lab-report pipeline (migrations 0007 to 0009) | **Append-only** (nobody updates or deletes, the owner included); each row has its own event in the tenant's hash chain, committed in the same transaction. Not connected to any endpoint yet (5B-3.2). Design: `docs/design/records-and-corrections.md` |
| `event_notes` | every free-text note, kept out of the chain (0006) | Insert-only except one audited redaction |
| `ledger_events`, `ledger_heads`, `ledger_checkpoints` | the per-tenant audit chain (0005) | Written only by the ledger functions; verified by `src/ledger/verifier.ts` |
| `tenant_memberships` | who belongs to which organization, with which roles (0017) | The authority the API checks on every request ([auth.md](auth.md#authority-and-revocation)). One row per person per organization, **never deleted** (a removed person's row is the revocation record); at most one active row per person. The API login can only `SELECT` its own organization's rows (RLS, not forced so the owner can write across organizations); changes come from the operator command ([ops/membership.md](ops/membership.md)). A trigger bumps `version` on every change and refuses moving the key or moving `tokens_valid_after` backwards. `membership_assert_current(sub, version)` (`SECURITY DEFINER`, execute for the API role only, reads only the organization the transaction is bound to) locks the row shared so a removal cannot commit after a write that checked it |
| `security_events` | the security-event record (0018): membership changes, refused access, and the issuing of file links | **Append-only** (nobody updates, deletes or truncates, the owner included). The application role has **no privilege on the table**: it calls `security_event_append()` (`SECURITY DEFINER`, takes the organization and person from the transaction, refuses every event type but refusals and file links). Membership events are written by a trigger on `tenant_memberships` in the same transaction as the change. Only `telesphoros_security_auditor` reads it. `details` is limited to a few keys holding short letter-digit-hyphen strings, so no token, URL or patient value fits. Not part of the clinical ledger. See [ops/security-events.md](ops/security-events.md) |

Rules enforced **by the database itself** (each is asserted by a test that tries to break it):

- **UUID primary keys** on clinical API records, matching their public ids. Ledger heads and migration history instead use tenant/version keys.
- **Tenant records have `tenant_id` (the organization that may see the row) and `created_by` (the individual who made it).**
  Clinical parent foreign keys are **composite** (`id, tenant_id`), so a child row cannot point at another tenant's parent even if
  application code were wrong. Neither column can change after insert (a trigger refuses it, even for the table owner).
  (Migration 0003 renamed `owner_id` to `tenant_id`; each former owner became a tenant of one.)
- Global containment/clearance and system tables deliberately have different fields and relationship rules; see the [complete table-class acceptance matrix](verification/phase3a-data-integrity.md). Recommendations now reference `reports(tenant_id, patient_id, id)`, so two different patients in one tenant cannot be joined by independent FKs.
- **Every foreign key states `ON DELETE RESTRICT`.** Clinical history is never silently cascaded away.
- **Soft delete** (`deleted_at`). The application role has no `DELETE` privilege at all. Soft-deleting a patient
  that still has live reports (or a report with live recommendations) is refused by a trigger, mirroring `RESTRICT`.
- **Unique:** one live label per tenant (case-insensitive; a soft-deleted row frees its label); one report per
  storage key (the same file cannot be registered twice).
- **Report registration retries (0014):** an optional UUID `requestId` on `POST /api/v1/reports` reserves `(tenant_id, created_by, creation_request_id)` atomically. The immutable fingerprint covers the original patient ID, type, filename and byte size. Same key/input returns the current report with its original ID (201); changed input or a soft-deleted report returns 409. Other creators/tenants have separate key namespaces; omitted keys retain ordinary creation. Keys and fingerprints are internal, never report DTO fields. Metadata corrections do not overwrite the original fingerprint, and a trigger forbids rekeying or changing it. This does not deduplicate file contents or retain client retry state across browser restarts.
- **0014 rollback:** preserves report rows but removes retry identities. Populated identities refuse rollback unless the operator explicitly sets `telesphoros.allow_report_retry_drop=yes` after a blast-radius review/export/recovery plan; reapplying 0014 alone cannot recover removed identities. The setting does not grant DDL privileges. Lock waits are bounded at two seconds; migration execution at thirty seconds. No operational rollback or shared-data change is authorized by the synthetic tests.
- **Checks:** label and filename formats, size 1 byte to 10 MB, valid status/type/strength, lowercase hex SHA-256,
  and "uploaded implies key + checksum + content type".
- **`created_at` / `updated_at`** on the legacy mutable tables; `updated_at` moves automatically unless the writer sets it. Append-only and system tables use class-specific fields.
- **`seq`** (identity) gives stable creation order for pagination, because timestamps can tie.
- **Indexes** support tenant/filter/order and parent uniqueness; exact query-facing definitions and real query plans are checked. Some append-only event FKs deliberately lack a dedicated child index; application roles cannot delete those parents.

### Recommendation relationship migration (0012/0013)

0012 adds the tenant/patient/id uniqueness to reports and a `NOT VALID` FK from recommendations; it enforces new references without changing historical rows. 0013 validates in a separate transaction. Both bound lock waits to 2 seconds and statements to 30 seconds. `NOT VALID` avoids the initial historical-row scan, not all locking; referenced uniqueness still requires an index build. If legacy mismatches exist, 0013 fails and rolls back while 0012 remains committed. Pending 0013 keeps readiness at 503; the catalog acceptance gate also rejects `convalidated=false`. Stop: do not reassign patients, delete/soft-delete rows or run a quarantine script automatically. Founder approval of a specific tenant-scoped, evidence-preserving remediation script is required before any operational repair and retry. Clean synthetic databases validate automatically. Rollback of 0013 recreates the enforced unvalidated FK; rollback of 0012 removes it and the added unique constraint. Nothing here was applied to a live/shared database.

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
The stored lab PDF is pinned to an object version and protected by the database; see [docs/ops/report-evidence.md](ops/report-evidence.md).

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
- `/api/v1/ready` returns **503 while migrations are pending, history disagrees with the shipped versions/checksums, or metadata cannot be read**. It reuses the migration runner's strict history validator with the existing read-only application grant; it never applies migrations or repairs history. `/api/v1/health` stays 200. Failures keep the generic readiness envelope and existing two-second deadline.
- **Strict artifact compatibility:** an older binary refuses an unknown newer migration, including an additive one. Checksums cover both the `up` and `down` SQL. Preserve applied files and investigate mismatches; do not normalize history to silence readiness. This does not establish rolling-upgrade compatibility, inspect the physical schema, verify migration timestamps, or change startup/request admission. The separate compatibility contract remains open; see [T02 verification](verification/t02-readiness.md).

## Database TLS

One setting decides how every database connection is encrypted: `DATABASE_SSL` (`disable`, the default, for local development and tests; `require` in AWS, and production refuses anything else).

- **The connection URLs carry no TLS parameters.** Any `ssl...` or `uselibpqcompat` parameter in `DATABASE_URL`, `LEDGER_VERIFIER_DATABASE_URL`, the migrator or admin URL is refused, by name only (the message never quotes the URL). The reason: node-postgres lets URL parameters *replace* an explicit `ssl` object, so `?sslmode=disable` connected without TLS and `?sslmode=no-verify` switched verification off even when the code asked for verification. In libpq (`pg_dump`, `pg_restore`), `sslmode=require` encrypts but does not verify the certificate.
- `require` means TLS 1.2 or newer with the certificate chain and host name verified against the system authorities plus `NODE_EXTRA_CA_CERTS` (the RDS authority bundle goes there in the image).
- The command-line tools get the same guarantee through `PGSSLMODE=verify-full`, `PGSSLROOTCERT` (from `DATABASE_SSL_CA`, else `NODE_EXTRA_CA_CERTS`) and `PGSSLMINPROTOCOLVERSION=TLSv1.2`; with no authority file they refuse rather than connect unverified.
- Every `Pool` and `Client` is built from `pgClientConfig(url)` in `src/db/tls.ts`; `connection-guard.spec.ts` fails the build for any file that builds one another way.
- Proved against real TLS (`test/db/tls.pg-spec.ts`: a throwaway authority, a matching and a mismatched certificate, an untrusted authority, and URLs carrying `sslmode`), and by breaking the code in eleven ways with a green control. **Not verified:** a connection to a real RDS instance (nothing is applied in AWS).

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

## Scheduling the real-service test suites

When `TEST_DATABASE_URL` is set, the backend Jest configuration runs one suite at a time. All suites share one PostgreSQL instance; host CPU-count worker defaults can overload it with concurrent migrations, restores and checkpoints. The restore advisory lock only excludes other participating restore suites, not unrelated database suites.

This controls scheduling, not coverage: existing test deadlines and assertions remain, as do multi-session/writer concurrency tests within a suite. Unit-only runs retain Jest's worker defaults. Do not override the service-run worker count to gain speed without rerunning the resource-contention controls. See [verification](verification/restore-test-scheduling.md).
