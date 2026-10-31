# Backup and restore runbook

## What is protected, and how

| Data | Mechanism | Status |
| --- | --- | --- |
| Database, logical | `db:backup`: consistent snapshot, authenticated encryption (format 2), signed manifest, off-site upload to a second provider with Object Lock | **Built and tested against an emulator; not yet drilled with a real provider** (`docs/ops/offsite-backups.md`) |
| Database, point-in-time | RDS automated backups + cross-region replication (Terraform) | **Staging: automated backups on, kept 1 day; the cross-Region copy is production-only, and its state cannot be read from the account. Production: written, never applied. Never drilled** ([environments.md](environments.md)) |
| Report files and captured text | S3 versioning (Terraform); exact PDF versions and text hashes in the DB | [Local F1 catalogue/copy library](evidence-catalogue.md) with PostgreSQL/Moto controls; independent primary-denied recovery and app recovery still unimplemented. See the [reviewed recovery design](../design/plans/report-file-recovery.md). |

The written two-Region production profile is not authorized under the documented project single-Region constraint. CRR evaluation in the recovery design is conditional on founder approval and verified platform/policy eligibility; same-Region copies cannot establish Region-loss recovery. No AWS policy/account eligibility was checked or changed by this plan.

## Commands

```bash
pnpm --filter @telesphoros/backend build

# Once: create the backup key (64 random hex characters, owner-only; refuses to overwrite an existing file).
pnpm --filter @telesphoros/backend db:keygen -- --out /run/secrets/backup.key
# Then copy it OFFLINE to two different people (see "The key" below). It is not in any backup and cannot be recovered.

# Back up (needs a role that can read every row: a superuser, or BYPASSRLS. Never the application role.)
export DATABASE_ADMIN_URL=postgres://<admin>@<host>/<db>
pnpm --filter @telesphoros/backend db:backup -- --dest /var/backups/telesphoros \
    --key-file /run/secrets/backup.key \
    --upload s3://<backups-bucket>/nightly --remove-local   # second provider: see docs/ops/offsite-backups.md

# Restore + verify into a THROWAWAY database (safe to run any time; this is the drill)
export DATABASE_ADMIN_URL=postgres://<admin>@<target-host>/postgres
pnpm --filter @telesphoros/backend db:restore -- --from /var/backups/telesphoros/backup-<timestamp> \
    --key-file /run/secrets/backup.key
```

`--passphrase-file` on `restore` exists only for old (format 1) backups. `backup` no longer accepts it, and a backup
made without `--key-file` is **not encrypted** (development and tests only; the command says so).

A format 1 manifest is plain, unsigned JSON, so `restore` **refuses** it unless you add `--allow-unauthenticated`: the
checksum and the list of required roles in it are only as trustworthy as whoever could write the backup folder. Add the flag
only for a backup you made yourself and kept private. Every backup made with `--key-file` is signed and needs no flag.

A real recovery: `restore ... --target-db telesphoros_restored` keeps the database; then point the application at it.
The target server must already have every role the backup names (`telesphoros_app` and, from migration 0005, the ledger roles, plus
the role that owns the tables): roles belong to the server, not the database, so a dump cannot carry them. `restore` checks this
first and stops, restoring nothing, with the list of missing roles. How to create them: `docs/ops/ledger-roles.md`. To restore from the off-site copy, give `--from s3://<bucket>/nightly --latest`
(or `…/backup-<timestamp>`); it downloads with the read-only key and verifies as below.

## What `restore` proves (exit code 1 if any step fails)

0. The manifest is well formed (every field has the expected type and shape; the dump's file name cannot point
   outside the backup directory) and, for a format 2 backup, **its signature verifies under your key**. A manifest
   edited by whoever stores the backup is refused before anything else runs.
1. The backup file's SHA-256 matches the manifest. For format 2, the file's own header agrees with the signed
   manifest, **every chunk authenticates** (a flipped byte, a missing, repeated or reordered chunk, a truncated file
   or extra data all fail), and the decrypted file matches the signed checksum.
2. `pg_restore` completes with no errors, into a brand-new database. If it fails, the report gives the exit code and, for a failure while
   loading data, only the **table's name**: PostgreSQL's own message there quotes the offending key and the row, and the report goes to the
   terminal and to the log of a drill or job (no patient data in logs). The full message is in the **target server's log**. A failure while
   creating objects keeps its first error line, which is schema text.
3. Tables present; **row counts equal the baseline**, including soft-deleted rows.
4. Applied migrations equal; constraint, index and trigger counts equal.
5. **Ownership and privileges** equal the record in the manifest (from the backup that first recorded them): who owns each table and
   function, and who may `SELECT`, `INSERT` or `EXECUTE` what. The restore keeps owners (no `--no-owner` on `pg_restore`) because the ledger's
   `SECURITY DEFINER` functions run with their **owner's** rights. A restore that gave them to a superuser would silently turn
   "the application can append to the ledger" into "the application runs code as a superuser". Backups made before this check
   existed are restored as before (without owners) and say so.
6. Row-level security is still enabled, forced and has the same policies, **and still isolates owners when acting as
   the application role** (no owner set: sees nothing; one owner set: sees exactly that owner's rows).
7. **`ledger chain`**: every tenant's whole ledger chain is walked in the restored copy, as `telesphoros_ledger_verifier` (chain, records and notes,
   both directions). It writes nothing. A restored ledger that fails, or cannot be walked to the end (15 minutes per tenant), makes the restore
   "not ok". A backup from before the ledger existed reports "not applicable" and passes. See `docs/ops/ledger-watch.md`.

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

That drill was run with format 1 (passphrase). Format 2 (below) is covered by automated tests, including a real format 1
backup kept in `tests/backup_fixtures/v1-encrypted/` that must keep restoring (with `--allow-unauthenticated`). **A format 2 drill with the real CLI
against the real second provider has not been run**; it is part of the next change.
Defects this drill and its tests found and fixed: backup files were created world-readable; a failed encrypted backup
left an **unencrypted dump** on disk; the manifest dropped the PostgreSQL version.

## Current-schema local format 2 rehearsal (2026-10-10)

The [Phase 3C rehearsal](../verification/phase3c-recovery-rehearsal.md) executes the built CLI against a 13-migration synthetic database and a separate fresh PostgreSQL target, with exact volume/timing evidence and refusal controls. It verifies pinned primary PDF bytes separately. It does not recover independent report-file copies or validate a live provider. Use its bounded procedure to repeat the local rehearsal; retain the live-provider/custody drill as a separate task.

## Honest limits

- **Recovery point:** a logical backup recovers to the moment it was taken (up to a day old if run daily). A
  point-in-time claim (minutes) belongs to RDS point-in-time recovery, which has **not been applied or drilled**. Do
  not quote it externally until a restore has been run in AWS.
- **Recovery time:** production RTO remains unmeasured. Phase 3C records exact byte counts and durations for a small local current-schema fixture; neither that baseline nor the historical six-row drill establishes recovery time at scale.
- **Scheduling:** the daily run is not wired to a scheduler yet (it belongs with the compute, Phase 6/7). Until it
  is, nothing runs this automatically.
- **Replay:** the signature proves a backup is genuine and unaltered; it does not prove it is the *latest*. Someone who
  can write to the bucket could put back an older, genuine backup (or hide a newer one). Object Lock on every upload and
  `backup-check --max-age-hours` (does last night's backup exist, is it authentic) answer that; see `docs/ops/offsite-backups.md`.
- **What the provider can see:** the manifest is readable, so a provider sees table names, row counts, the migration
  list, the database name, the PostgreSQL version and the backup time; it does not see any row, value or tenant id.
- Restoring needs a PostgreSQL client at least as new as the server (`pg_dump`/`pg_restore` 16 here).

## The backup format (version 2)

Written by `backup --key-file`. Read by `restore --key-file`. Version 1 backups (passphrase) still restore.

- **Encryption:** AES-256-GCM in 1 MiB chunks (`aes-256-gcm-stream/1`), so memory stays bounded however big the dump
  is. Each chunk is authenticated; the 37-byte file header (magic, version, chunk size, random salt, nonce prefix, key
  id) is authenticated as part of every chunk. The nonce carries the chunk number and a "final" flag, so a chunk cannot be
  moved, repeated or dropped, and cutting the file short (even exactly between chunks) fails.
- **Keys:** one 32-byte master key (the key file). Per backup, HKDF-SHA-256 with a fresh random salt derives the
  encryption key and, separately, the manifest signing key. The key id in the header and manifest lets you tell which
  key file a backup needs; it reveals nothing about the key.
- **Signed manifest:** the manifest carries an HMAC-SHA-256 over every other field. Restore checks it first.
- **Downgrade:** if you pass `--key-file`, a backup that is not format 2 is refused, so replacing a signed backup with an
  unencrypted one does not work. Always pass the key file when restoring real backups.

### The key

- Losing the key loses every backup made with it. There is no recovery path and no backdoor. That is the point.
- Keep **two offline copies held by two different people**, outside AWS and outside the backup provider. Do not store
  the key in the same bucket, account or password manager entry as the backups it protects.
- `keygen` never overwrites an existing file. To rotate, create a new key and use it for new backups; keep the old key
  for as long as any backup made with it must stay restorable (the key id tells you which).
- Test the custody: at the restore drill, the person holding the offline copy restores from it, not from the server copy.
