# Plan: scheduling the database backup (decision sheet)

Status: **draft, awaiting founder decisions B1 to B4.** Snapshot 2026-10-19 against main `910defc`. **This is a plan only: no code, Terraform, image, workflow or AWS change, and nothing here is approved.** It authorizes no account access, spend, scheduler or real records.

## 1. Why this exists

The foundation-layers audit (layer 13, Availability & Recovery) left one engineering item: the backup command works, but **nothing runs it**. [offsite-backups.md](../../ops/offsite-backups.md) says so ("No scheduler yet. The job and its host belong to the hosting phase") and so does [backup-and-restore.md](../../ops/backup-and-restore.md) ("Scheduling: the daily run is not wired to a scheduler yet").

I first proposed building the schedule. Reading the files showed it is blocked by four decisions only the founder can make, so building now would guess at all four. This sheet lays out each decision, the options, and a recommendation.

What was read: the two ops pages above; `infrastructure/terraform/{profile,database,iam,variables}.tf`; `infrastructure/docker/api.Dockerfile`; [f4-provider-custody.md](f4-provider-custody.md); [fd3-synthetic-profile.md](fd3-synthetic-profile.md). Nothing was run, applied or priced.

## 2. What exists and what does not (checked)

| Piece | State on main |
| --- | --- |
| `db:backup` with encryption (format 2), signed manifest, `--upload`, `--remove-local` | Built; tested against an emulator; **not drilled against a real provider** |
| `backup-check --remote … --max-age-hours 26` (freshness, authenticity, Object Lock, key permissions) | Built; same limits |
| A scheduler for either command | **None** |
| A place to run it | **None.** The API image does not install `pg_dump`: its runtime stage only upgrades packages (`api.Dockerfile`), and restore needs a client at least as new as the server (`pg_dump`/`pg_restore` 16) |
| Second provider for the locked copy | **Not chosen.** The code is provider-neutral; a provider needs a BAA before any real patient data |
| AWS-side off-site resources | Written, never applied, **production profile only**: KMS key and locked bucket in `backup_region`, automated-backup replication, and a write-only `backup_job` policy that is created but attached to nothing (`profile.tf`, `database.tf`, `iam.tf`) |
| Synthetic (staging) profile | One Region, RDS backup retention **1 day**, **no** backups bucket (`profile.tf`: `offsite_count = 0`, `db_backup_retention = 1`) |
| Recovery point and time | A logical backup recovers to when it was taken; RDS point-in-time recovery is **not applied or drilled**; RTO is unmeasured (`backup-and-restore.md`, "Honest limits") |

Two constraints the options below must respect:

- **Founder requirement, 2026-10-08:** backups must not live on the same server as the database, "ideally with another provider" (`offsite-backups.md`). [f4-provider-custody.md](f4-provider-custody.md) adds that same-Region S3 report replication does not satisfy the different-provider database requirement and it must not be relaxed implicitly.
- **Single-Region constraint:** the written two-Region production profile "is not authorized under the documented project single-Region constraint" (`backup-and-restore.md`).

## 3. The four decisions

### B1. Where the second copy lives

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. A non-AWS S3-compatible provider with Object Lock** | The design already documented: write-only, read-only and admin keys, 30-day governance lock | Meets the founder requirement as written; no Region question; code is provider-neutral | Not chosen; needs a BAA before real data; egress cost for a restore is unknown; the documented 5 GiB single-upload ceiling applies |
| b. AWS second Region (the written production profile) | The existing Terraform | Already written; one vendor | Not authorized under the single-Region constraint; same vendor, so only half of "ideally another provider"; never applied |
| c. Defer: RDS automated backups only | Whatever retention the profile sets | No new vendor | Fails the founder requirement; point-in-time recovery is unproven; staging retention is 1 day |

**Recommendation: a.** Send the seven questions in `offsite-backups.md` ("Choosing the provider") to candidates first and record the answers with dates in that page. The first real drill can use **synthetic data**, so it needs no BAA; only real data does. I have not checked any provider's BAA or Object Lock terms and name none.

### B2. Where the job runs

The job must run on a host that is not the database host, needs a network path to the database, a PostgreSQL 16 client, and the built backend CLI.

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. A scheduled ECS task from a dedicated backup image** | New `backup` image (PG 16 client plus the built CLI), own task role, a schedule, no public ingress | Same pattern as the other tasks; the only option here with a path to a private database | A new image and IAM role; the admin database credential (needs `BYPASSRLS`, never the application role) lives in the task's secrets; adds to the AWS bill |
| b. Add `pg_dump` to the API image | One image | Fewer images | Puts the admin credential path and a database client in the internet-facing image, against the least-privilege split; rejected |
| c. A host outside AWS | A small machine near the provider | Independent of AWS | Needs a network path into a private database, which would mean exposing it; rejected |

**Recommendation: a**, as a separate image so `pg_dump` and the admin credential never sit in the API or worker. Assumptions to verify in the build slice: that a task in the chosen network can reach the provider's endpoint; and that the secrets reach the CLI in the form its `_FILE` settings expect (ECS injects secrets as environment variables, so the slice may need a small entrypoint or an environment-variable path).

### B3. The backup key

The key encrypts the backup and signs its manifest, and **losing it loses every backup made with it** (`backup-and-restore.md`, "The key"). The documented rule: two offline copies held by two different people, outside AWS and outside the provider.

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. One master key; two named offline custodians; a working copy in the backup task's secrets** | The existing rule plus the unattended copy the job needs | Works with the code as built; a custodian restores from the offline copy at the drill | Whoever can read that secret can read the backups' content; mitigated by a KMS key only the backup task role may use |
| b. Key held only by people, supplied at run time | | Nothing in AWS | Cannot run unattended; no nightly backup |
| c. Wrap the key with a cloud KMS | | Central control | Not supported by the code today; a new slice |

**Recommendation: a.** The decision only you can make is **who the two custodians are**. Record the names in your private location, not in the repository. The drill must restore from a custodian's offline copy, not the server copy.

### B4. The floor, and the production profile

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **a. Single Region; the provider copy is the off-site copy; RDS automated backups are the floor** | Remove the AWS second-Region resources from the production profile in a later slice | Consistent with the single-Region constraint and the founder requirement | A Terraform change to a written, never-applied profile; report-file recovery ([report-file-recovery.md](report-file-recovery.md)) is a separate track and must be reconciled |
| b. Authorize two Regions | Keep the written profile | Nothing to rewrite | Reverses a documented constraint; more cost and surface |
| c. Leave the profile as it is | | No work | Production stays unapplicable until this is settled |

**Recommendation: a**, as its own later slice. The synthetic staging profile stays as it is (one Region, 1-day retention, no backups bucket) and is not a recovery claim.

## 4. Things this sheet does not decide but the build must include

- **A failed or missing backup must reach a human.** A scheduled job that ends `incomplete` or does not run at all is silent unless alarmed. The freshness check (`backup-check --max-age-hours 26`) belongs on its own schedule with a path to the existing audit alarm topic. How a FAIL becomes a metric is a build-slice item.
- **Multipart upload.** The 5 GiB single-upload ceiling warns from 4 GiB; the documented follow-up is multipart, before it fails.
- **Rehearse under the scheduler, not a terminal** (a scheduler's environment differs from a shell's), and prove each guard goes red when broken.
- **Cost.** No figure is given here. Price the provider's storage, retention and restore egress from its published pricing before choosing, and the ECS task and image from the AWS Pricing Calculator.

## 5. Order, once you decide

1. **Provider questions** (no spend): send the seven questions; record answers.
2. **First real drill on synthetic data**, per the "First real drill" section of `offsite-backups.md`, against the chosen provider. This proves the upload, lock, permission and custodian-restore claims without AWS.
3. **Build slices, each its own plan and draft PR:** the backup image with a guard; the scheduled task, IAM and alarms in Terraform (written, not applied); the production-profile change if B4 = a.
4. **Staging rehearsal** only when the AWS phase is reopened (the BAA row in the staging worksheet is currently deferred, and the account is on a free plan that closes about 9 April 2027 per [fd3-synthetic-profile.md](fd3-synthetic-profile.md)).

## 6. What is not verified

No provider terms, prices, or AWS behavior were checked. Nothing was run. The ECS secrets-to-files behavior and network reachability in section 3 are assumptions to verify in the build slice.
