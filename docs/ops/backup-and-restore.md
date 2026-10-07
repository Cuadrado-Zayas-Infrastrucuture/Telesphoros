# Backup and restore runbook

## What is protected, and how

| Data | Mechanism | Status |
| --- | --- | --- |
| Database, logical | `db:backup`: consistent snapshot, encrypted, optional off-site upload (separate region, Object Lock) | **Built and drilled** (below) |
| Database, point-in-time | RDS automated backups + cross-region replication (Terraform) | **Written, never applied, unproven** |
| Report files | S3 versioning (Terraform) | **Not backed up by this tool; not replicated to a second region.** A known gap |

## Commands

```bash
pnpm --filter @telesphoros/backend build

# Back up (needs a role that can read every row: a superuser, or BYPASSRLS. Never the application role.)
export DATABASE_ADMIN_URL=postgres://<admin>@<host>/<db>
pnpm --filter @telesphoros/backend db:backup -- --dest /var/backups/telesphoros \
    --passphrase-file /run/secrets/backup-passphrase \
    --upload s3://<backups-bucket>/nightly --kms-key-id <backup-kms-key-arn>

# Restore + verify into a THROWAWAY database (safe to run any time; this is the drill)
export DATABASE_ADMIN_URL=postgres://<admin>@<target-host>/postgres
pnpm --filter @telesphoros/backend db:restore -- --from /var/backups/telesphoros/backup-<timestamp> \
    --passphrase-file /run/secrets/backup-passphrase
```

A real recovery: `restore ... --target-db telesphoros_restored` keeps the database; then point the application at it.
The target server must already have the `telesphoros_app` role (migration 0002 creates it, or run
`infrastructure/docker/postgres-init.sql`'s first block). Fetch an off-site backup first with
`aws s3 sync s3://<backups-bucket>/nightly/backup-<timestamp> <dir>`.

## What `restore` proves (exit code 1 if any step fails)

1. The backup file's SHA-256 matches the manifest (and, if encrypted, so does the decrypted file).
2. `pg_restore` completes with no errors, into a brand-new database.
3. Tables present; **row counts equal the baseline**, including soft-deleted rows.
4. Applied migrations equal; constraint, index and trigger counts equal.
5. Row-level security is still enabled, forced and has the same policies, **and still isolates owners when acting as
   the application role** (no owner set: sees nothing; one owner set: sees exactly that owner's rows).

The baseline is read **inside the same exported snapshot `pg_dump` uses**, so a busy database cannot cause false
alarms (a test commits rows between baseline and dump and the restore still verifies).

## The drill (executed 2026-10-07)

Environment: PostgreSQL 16.15 on the build host, `moto` S3 emulator, the built `dist/` CLI and server. **Not AWS.**

1. `migrate up` on an empty database: applied 0001, 0002; a second run: "nothing to apply".
2. Booted the real server on PostgreSQL + S3 as the restricted application role; created two users' patients and
   reports over HTTP, uploaded a file for each through the presigned flow, completed both (`fileUploaded=true`).
   Each user saw only their own patient.
3. `backup --passphrase-file ... --upload s3://drill-backups/nightly`: 4 tables, 6 rows, encrypted, files mode `0600`,
   both objects in the off-site bucket (manifest last).
4. `restore`: 9 of 9 checks passed (`RESTORE VERIFIED`), exit 0, throwaway database dropped, no leftovers.
5. Negative controls: a corrupted backup file was refused (exit 1); a missing passphrase was refused (exit 1).

Defects this drill and its tests found and fixed: backup files were created world-readable; a failed encrypted backup
left an **unencrypted dump** on disk; the manifest dropped the PostgreSQL version.

## Honest limits

- **Recovery point:** a logical backup recovers to the moment it was taken (up to a day old if run daily). A
  point-in-time claim (minutes) belongs to RDS point-in-time recovery, which has **not been applied or drilled**. Do
  not quote it externally until a restore has been run in AWS.
- **Recovery time:** unmeasured. The drill used six rows; it proves the procedure, not the duration at scale.
- **Scheduling:** the daily run is not wired to a scheduler yet (it belongs with the compute, Phase 6/7). Until it
  is, nothing runs this automatically.
- **Encryption:** AES-256-CBC with a PBKDF2-derived key from a passphrase file: confidential, but **not
  authenticated**; tampering is caught by the SHA-256 in the manifest, which is itself not signed. The off-site bucket
  adds SSE-KMS and Object Lock. Moving to an authenticated scheme (KMS envelope or `age`) is a follow-up.
- **The passphrase** must live in a secrets manager, never next to the backups. **Losing it loses every encrypted backup.**
- Restoring needs a PostgreSQL client at least as new as the server (`pg_dump`/`pg_restore` 16 here).
