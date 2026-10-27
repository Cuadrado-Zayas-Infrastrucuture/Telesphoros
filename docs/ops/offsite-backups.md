# Off-site backups: the second provider

Requirement (founder, 2026-10-08): backups must not live on the same server as the database, ideally with another
provider. This page is how that is set up, checked and restored. The code is provider-neutral (any S3-compatible
object store with Object Lock); **which provider is chosen is still open**, and a provider must have signed a BAA
before any real patient data is sent to it. Until then, backups contain synthetic data only.

Format and encryption of the backup itself: `docs/ops/backup-and-restore.md`.

## The design in one paragraph

A scheduled job on a host that is **not** the database host runs `backup --upload`. The dump is encrypted and the
manifest signed on that host (the provider never sees plaintext or the key). The copy is uploaded with a key that can
**only write**, every object carries an Object Lock retention (30 days, governance mode), and, with `--remove-local`,
the job's disk keeps nothing. Restores use a different, **read-only** key. A third, **admin** key is used only at
setup to inspect the bucket. The AWS credentials that run the application are never used for any of this.

## Settings (all `BACKUP_S3_*`)

| Setting | Meaning |
| --- | --- |
| `BACKUP_S3_ENDPOINT` | The provider's S3 endpoint. Must be `https` (plain `http` only to localhost, for tests). Unset means AWS S3. |
| `BACKUP_S3_REGION` | Default `us-east-1`. |
| `BACKUP_S3_FORCE_PATH_STYLE` | `true` for providers that need `endpoint/bucket/key` addressing. |
| `BACKUP_S3_SSE` | Default none: the file is already encrypted on our side. `AES256` or `aws:kms` only if the target insists. |
| `BACKUP_S3_KMS_KEY_ID` | Sent with `BACKUP_S3_SSE=aws:kms`. The Terraform backups bucket encrypts with the backup key by default, so leave both unset there; its policy refuses `AES256`, any other key, and `aws:kms` named without this key id (S3 would use the AWS-managed key). |
| `BACKUP_LOCK_MODE` / `--lock-mode` | `GOVERNANCE` (default) or `COMPLIANCE`. |
| `BACKUP_RETAIN_DAYS` / `--retain-days` | Default 30. Applied to **every object** at upload. |
| `BACKUP_S3_<ROLE>_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY` | For each role `UPLOAD`, `READ`, `ADMIN`. Each also accepts the same name ending `_FILE` (path to a file holding the value), which is the preferred way on a server. Never pass keys on the command line. |

Governance mode lets a privileged user shorten or remove a lock; compliance mode lets **no one** (including the
provider and us) until it expires. Start with governance while the set-up is being proven; move to compliance
deliberately, once you are sure of the retention and the cost of keeping 30 days of backups, because it cannot be undone.

## Commands

```bash
# Back up, copy off-site, keep nothing on this host (runs on the backup host, with DATABASE_ADMIN_URL)
db:backup -- --dest /var/backups/telesphoros --key-file /run/secrets/backup.key \
    --upload s3://<bucket>/nightly --remove-local

# The copy failed earlier and the local backup is still on disk: retry it
node dist/db/cli.js upload --from <dir> --to s3://<bucket>/nightly --key-file /run/secrets/backup.key

# Is the set-up right? (setup, and monthly)
node dist/db/cli.js backup-check --remote s3://<bucket>/nightly --key-file /run/secrets/backup.key --max-age-hours 26

# Daily monitoring: nothing is written, only freshness and authenticity are checked
node dist/db/cli.js backup-check --remote s3://<bucket>/nightly --key-file … --max-age-hours 26 --skip-canary

# Restore from the second provider (READ key only; the key file comes from the offline custodian)
db:restore -- --from s3://<bucket>/nightly --latest --key-file <offline-copy>
db:restore -- --from s3://<bucket>/nightly/backup-2026-10-08T03-00-00-000Z --key-file <offline-copy>
```

`restore` from `s3://` downloads into a private temporary folder and runs the same verification as a local restore
(signature first, then every chunk, row counts, migrations, schema, row-level security). The folder is removed when the
process ends normally, on an error, on an uncaught exception, and on SIGINT, SIGTERM and SIGHUP. SIGKILL cannot be
trapped; the next restore removes our own leftover folders older than six hours.

`--latest` exhausts the backup-prefix listing before selecting a complete backup. If `IsTruncated` is true but the
next continuation token is null/missing/empty, or page 1,000 is still truncated, discovery throws
`IncompleteBackupListingError`. Recovery exits 1 before downloading objects or touching the target database; it never
falls back to a complete backup found in that partial window. A terminal page 1,000 is accepted. `backup-check` also
reports FAIL for incomplete discovery. Investigate the listing/provider or name an independently verified backup
explicitly; a manual backup choice does not establish newest status. See [Phase 3B verification](../verification/phase3b-backup-discovery.md).

## What `backup-check` proves

Each line is PASS, WARN, FAIL or SKIP. Exit code 1 on any FAIL.

1. **key file**: valid, owner-only; shows the key id.
2. **bucket reachable, versioning, Object Lock** (needs the admin key): the bucket exists, versioning is on, Object Lock
   is enabled (it can only be enabled when a bucket is created), and the default retention, if any.
3. **upload key can upload**: a small synthetic canary is encrypted with the real key, signed, and uploaded with the
   same code as a real backup. If the bucket has no Object Lock the provider refuses it, so this item fails.
4. **read key can read back**: the canary is downloaded with the read key, the signature verified and every chunk authenticated.
5. **upload key is upload-only**: with the upload key's own credentials, list, read and delete are attempted; each must
   be **refused by the provider**. If any succeeds this is a FAIL naming it.
6. **read key is read-only**: write and delete are attempted with the read key and must be refused.
7. **newest backup is authentic / recent / headroom**: the newest complete backup exists, its signature verifies under
   your key, it is not older than `--max-age-hours`, and its size is below the single-upload ceiling. This is also the
   answer to "an older genuine backup was put back" and "last night's job silently stopped".

The canary is a few kilobytes and is retained for **1 day** (`--canary-retain-days` to change), not the 30 days of a
real backup, so repeated set-up tests do not pile up. It lives under `<prefix>/_canary/`, never under a `backup-…`
name, so it can never be mistaken for a backup.

## Limits, stated plainly

- **5 GiB per backup** for now (a single upload). A warning appears from 4 GiB, in the job's output and in
  `backup-check`. Multipart upload is the follow-up; do it before the warning turns into a failure.
- **No scheduler yet.** The job and its host belong to the hosting phase. Until then nothing runs this automatically.
- **Replay:** the signature proves a backup is genuine, not that it is the latest. The freshness check catches an old
  backup standing in for a new one, and Object Lock stops stored backups from being deleted or overwritten during retention.
- **A provider can see:** object names (`backup-<UTC time>`), sizes and times, and the manifest's table names, row
  counts, migration list, database name and PostgreSQL version. Never row data, tenant ids or the key.
- **Provider behaviour is tested against an emulator** behind a stand-in that enforces per-key permissions and rejects
  the headers stricter providers reject. It is not a real Backblaze, Wasabi or AWS. **The first real drill (below) is
  what turns "tested" into "works".**
- The read key's `backup-check` probe, if the key turns out to be writable, leaves one empty object named in the
  finding; delete it with the admin console.

## Choosing the provider: questions to put to each candidate

Send these before reading any marketing page. The answers go in this document with the date.

1. Do you sign a BAA for object storage, and for which regions/products does it apply? Send the BAA text.
2. Is Object Lock (WORM) in scope of the BAA and available in **governance and compliance** mode with per-object
   retention headers? Can the minimum retention be 1 day (canaries)?
3. Can I create **separate keys limited to put-only, read-only (list + get), and bucket administration**, scoped to
   one bucket?
4. Breach-notification terms and timing; sub-processors; data location; what happens to data on termination (return/deletion).
5. Do you accept `Content-MD5` on PutObject, and how do you report `ETag` (MD5 or not)?
6. Do you reject the AWS SDK's default checksum headers (`x-amz-checksum-*`, `aws-chunked`)? (We turn them off.)
7. Egress/retrieval cost for a restore drill and for a real restore.

## First real drill (run once a provider is chosen and its BAA is signed or synthetic data is used)

Use a **new bucket with Object Lock enabled at creation**, three keys (upload-only, read-only, admin), and synthetic data.

1. `keygen`; give one offline copy each to two custodians. Record the key id here (not the key).
2. Set the `BACKUP_S3_*` settings on the backup host (file-based secrets).
3. `backup-check` with the admin key: expect every line PASS. Any FAIL is the finding; fix the provider set-up, not the check.
4. `backup --upload … --remove-local`: confirm the host keeps nothing and the bucket holds two locked objects.
5. Try to delete an uploaded object from the provider's console and with the admin key: it must be refused during retention.
6. `restore --from s3://… --latest` on a different machine, with the key from the custodian's offline copy.
7. `backup-check --skip-canary --max-age-hours 26` the next day: PASS, and no new objects.
8. Record the date, provider, region, sizes and durations here. Until this is done, the off-site copy is **tested, not proven**.
