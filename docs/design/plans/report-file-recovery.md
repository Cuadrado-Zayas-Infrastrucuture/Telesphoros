# Independent report-file recovery: design for review

Founder approved this **planning-only** slice with “go” on 2026-10-10. Baseline main `e550100` (merged #59), branch `chore/report-file-recovery-plan`. No application, schema, IAM, Terraform, scheduler or deployment change is authorized by this document. Future implementation and live operations need their own concrete scope and approval. Work stays sequential; no task graph or agents are required.

## Objective and completion boundary

Define how a database recovery point can recover every referenced report and captured-text object after primary storage becomes unavailable. Design completion means the repository evidence, copy alternatives, identity contract, refusal cases and next implementation slices are reviewable. It does **not** mean files have been backed up or recovered. The [Phase 3C rehearsal](../../verification/phase3c-recovery-rehearsal.md) explicitly leaves independent copies and complete application recovery false.

Threats: loss of the primary bucket or host; compromised application/operator credentials; overwritten keys and delete markers; missing historical versions; unusable encryption keys; incomplete or stale copy discovery. A separate bucket with the same unrestricted administrator is not adequate **custody isolation**. Immutability is a requirement of this threat model, not a claim that HIPAA universally mandates a particular AWS feature.

## Repository evidence

| Evidence | Actual behavior on merged main | Recovery consequence |
| --- | --- | --- |
| Uploaded reports | [ReportsService](../../../apps/backend/src/reports/reports.service.ts) verifies size/type/SHA-256 and stores the VersionId returned with those bytes. Lab PDFs require a real version; VCF/JSON may complete without one. | Include all completed types, including soft-deleted rows. A null version cannot be invented from the current key. |
| Captured PDF | [Migration 0010](../../../apps/backend/migrations/0010_report_evidence.up.sql) freezes uploaded file identity. [CapturesService](../../../apps/backend/src/lab-reports/captures.service.ts) reads the exact stored version. | Preserve the original reference; never rewrite `reports.object_version`, disable the guard or fall back to latest. |
| Captured text | Capture writes a deterministic [text key](../../../apps/backend/src/lab-reports/object-keys.ts), discards the returned version and records SHA-256/scalar count. Text links inspect current bytes; [evaluation](../../../apps/backend/src/lab-reports/evaluations.service.ts) also checks the current text hash. | The DB pins a hash, not a text VersionId. Preserve original UTF-8 bytes; re-running extraction is not evidence recovery. |
| Storage adapter | [ObjectStorage](../../../apps/backend/src/object-storage/object-storage.ts) and [S3ObjectStorage](../../../apps/backend/src/object-storage/s3-object-storage.ts) bind bytes/hash/version in one response, bound reads and refuse a missing requested version. No copy catalogue or recovery resolver exists. | Reuse these checks; recovery through translated versions needs a separately implemented resolver. |
| Primary bucket | [storage.tf](../../../infrastructure/terraform/storage.tf) writes private, KMS-encrypted, versioned storage with a 2190-day default noncurrent retention floor. Reports have no Object Lock or replication resource. [iam.tf](../../../infrastructure/terraform/iam.tf) gives the app read/write/version-read, no delete rights. | Written retention is not applied immutability. Privileged deletion and key loss remain threats; current-version retention is not a six-year immutable policy. |
| Database backup | [backup.ts](../../../apps/backend/src/db/backup.ts) exports a repeatable-read snapshot for facts and dump; the strict [format 2 manifest](../../../apps/backend/src/db/backup-manifest.ts) covers the DB archive, not report-file membership. | Use a separately versioned, authenticated evidence catalogue bound to a verified DB backup; do not silently extend format 2. |
| Existing rehearsal | [recovery-cli.pg-spec.ts](../../../apps/backend/test/db/recovery-cli.pg-spec.ts) and [verifyPinnedPdf](../../../apps/backend/test/helpers/recovery-evidence.ts) read primary objects after DB restore and report independent recovery false. | Extend future tests with an isolated copy and a denied primary endpoint; existing green DB tests cannot establish this design. |

History checked: `d713a5c` introduced PDF pinning; `5a06516` writes hash-bound text without persisting its version; `b760471` added the measured DB rehearsal; #58/#59 added registration retries and standard upload. This design reuses those mechanisms.

## Copy and retention options

AWS sources below were checked on 2026-10-10. No AWS account, Region eligibility, BAA, live policy or cost quote was inspected.

| Option | Identity and threat fit | Limits / decision |
| --- | --- | --- |
| Versioning in primary only | Existing exact-version reads resist accidental overwrites. | No independent failure domain or privileged-deletion protection; insufficient for this objective. |
| S3 Same-Region Replication into a separately controlled, Compliance-locked destination | S3 replication retains VersionIds and metadata; a replica can satisfy pinned PDF references without rewriting DB identity. Separate administration and destination encryption isolate primary credentials. | Evaluate under the current single-Region constraint. No protection against whole-Region loss. Cross-account capabilities and custody are unverified. |
| S3 Cross-Region Replication (CRR) into the same isolated retention model | Adds another Region while retaining replica identity. | **Conditional only:** project guidance prohibits cross-Region actions. Founder approval plus verified platform/policy eligibility is required; approval alone cannot override a provider restriction. Never apply the existing two-Region production profile under this constraint. |
| Independent S3-compatible provider or ordinary version-aware copy | Can separate provider/custody and use verified retained objects. Existing DB off-site tooling demonstrates encryption/authenticated manifests, not file backup. | Normal PUT/CopyObject produces new VersionIds. Requires an authenticated source→destination mapping and recovery read integration; a bucket switch or plain sync is insufficient. Provider/BAA/retention semantics remain unverified. |

Replication retains creation metadata and version IDs. Live replication covers new eligible objects; explicitly backfill historical referenced versions through Batch Replication and inspect completion. Do not assume a newly enabled rule protects old evidence. [Replication overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html), [Batch Replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-batch-replication-batch.html).

**Evaluate S3 Object Lock Compliance Mode** for every required destination version, catalogue and completion record. It prevents even root from deleting protected versions or shortening their retention during the fixed term; it does not prevent new versions/delete markers, deletion of the associated AWS account or loss of decryption access. Enabling Object Lock is irreversible. Verify exact mode and retain-until on actual versions; bucket defaults alone are not acceptance. With replication, source retention overrides destination defaults; without source retention, destination defaults apply. Reject replicas with inadequate retention. [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html), [retention/replication behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html), [lock and encryption considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html).

For deployment, prefer native version-preserving replication if the approved platform and custody support it; evaluate SRR first under the current constraint and keep CRR conditional.

**Local-to-production bridge:** F1 defines the catalogue needed to bind complete evidence membership to a DB recovery point for either copy architecture. F2 uses a test-only copy mapping/probe because the local Moto fixture does not exercise native AWS replication; it proves byte-recovery logic without claiming replica VersionId preservation or AWS Compliance enforcement. A production copy-mapping resolver remains a separately approved F3 alternative, not a mechanism selected merely to accommodate the emulator.

## Required identity and completeness contract

### 1. Bind the DB recovery point

- Restore and verify a specific format 2 backup into a disposable target; derive required membership from that immutable restored DB.
- Bind the catalogue to the signed DB manifest/archive digest, schema version, producer generation and creation time. Two independent live scans correlated by timestamp are insufficient.
- Use parameterized tenant predicates and the approved backup/inventory role for complete tenant coverage, including soft-deleted evidence. Product live-only pagination is not a backup inventory.

### 2. Record exact evidence

Catalogue each reference with:

- Report/capture identity; source bucket/key and DB version when present.
- SHA-256, exact bytes and content type; text scalar count and runner identity.
- Observed text version from the same verified read; destination bucket/key/version.
- Encryption/key identifier and retention mode/expiry.

Distinguish DB-pinned, hash-bound and observed identities. Include all completed VCF/JSON, captured PDFs/text and uploaded reports without captures. Count uncompleted registrations and unreferenced orphan text separately; do not promote them into required evidence or delete them.

### 3. Resolve unpinned records safely

- Accept text or a completed non-PDF without a DB version only when bytes match the restored DB hash and other recorded constraints.
- If current bytes fail, exhaust version-aware discovery before selecting a verified historical match. Record the observed version without backfilling immutable DB fields.
- Missing metadata or no match fails recovery. Never substitute latest, recapture text or use an ETag as SHA-256.

### 4. Verify before publishing

Stage copies → read every required destination version → compute hashes/volumes → verify retention/encryption → sign and publish the completion record. A partial set must never be published as complete.

Authenticity does not establish freshness. Compare producer generations with independently retained monitoring evidence; report the protected DB time and copy lag.

### 5. Cryptographic and logging constraints

- Authenticate and encrypt sensitive catalogues and identifiers. A digest alone is not authenticity.
- Reuse existing crypto patterns after scoped review; do not assume a new cryptographic scheme.
- Log aggregates only: no file content, raw tenant/report IDs or signed URLs.

### 6. Fail closed on discovery

Define page, object, byte, time and retry bounds before implementation. Proposed listing cap: **1000 pages**.

- `ListObjectsV2`: continuation-token pagination.
- `ListObjectVersions`: key/version-marker pagination. Preserve API semantics, including the literal `null` version marker when valid. [Version listing API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html).
- A terminal page 1000 is allowed.

Throw proposed typed `IncompleteEvidenceListingError` on any of:

- Missing required cursors.
- Repeated cursor or no progress.
- Timeout.
- Page 1000 still truncated.

Publish nothing after incomplete discovery. Claim neither completeness nor newest status from a partial window.

### 7. Recover identity without weakening evidence

- Native replicas must serve the original key/version and matching bytes from the designated recovery bucket.
- Ordinary copies require a signed one-to-one mapping keyed by original source identity. Reads/download links resolve only a verified destination version.
- Reject ambiguous mappings, arbitrary endpoints/keys, latest fallback and DB rewrites.
- Text reads must serve hash-bound bytes despite a newer bad version/delete marker. This needs a future adapter change; bucket configuration alone does not solve it.

### 8. Prove primary independence

- Deny primary access before positive acceptance. Start a fresh recovery process without cached primary bytes; assert zero successful primary reads.
- Restore DB, catalogue and files using recovery credentials/custodied keys only. Verify every required object and existing ledger/catalog/RLS/ACL checks.
- One missing required file keeps `applicationRecoveryComplete=false`.
- Label a test-only mapping probe `independentBytesRecovered`. Claim full application recovery only after actual API/file-link/evaluation paths work under the restricted application role. Existing clinical holds stay in force.

## Custody, operational and cost gates

Separate application, copy producer, recovery reader and destination administrator identities. Application credentials must not read/write/delete recovery storage, shorten locks, change destination policy or disable/delete its key. Recovery reader cannot write/delete. Protect both destination decryption and catalogue signing keys from primary administrators; keep tested offline custody/recovery procedures. KMS replication needs explicit encrypted-object selection, destination key configuration and scoped source/decrypt plus destination/encrypt permissions; a configured rule is not proof of working replication. [Encrypted replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-config-for-kms-objects.html).

Require private storage, encryption in transit/at rest, least privilege and scoped service resource conditions; encrypted audit logging, CloudTrail data events, copy failure/lag metrics and freshness alerts must cover primary and recovery paths. Audit trails must not include report content. Denied delete tests belong to disposable synthetic canaries, never real retained evidence. [S3 security guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html).

### Founder deployment gates — required before F4

- [ ] **Infrastructure:** permitted Region/platform path and destination custodian/provider; platform/policy eligibility verified.
- [ ] **Compliance:** BAA coverage verified before any real records are handled.
- [ ] **Policy:** approved retention, deletion and legal-hold policies.
- [ ] **Recovery objectives:** RPO/RTO targets and accepted Region-loss limitations.
- [ ] **Financial:** approved budget based on verified volume/Region/class estimates, including the drill.
- [ ] **Custody:** designated key custodians and tested recovery procedures.

The repository's 2190-day noncurrent floor is an existing safeguard, **not a legal retention determination**. Do not inherit DB backup retention (14/30 days) for evidence. Compliance retention cannot be shortened to roll back a bad deployment; approve synthetic canary volume/retention and retained costs first.

Cost review must count all retained versions and catalogue copies, growth/overwrites, replication PUTs and backfill jobs, inter-Region transfer for CRR, inventory/read/hash verification, KMS and audit/metrics, retrieval and minimum archive durations. **Budget retrieval and data-transfer costs during the F4 drill itself**, including repeated controls. SRR still incurs destination storage and requests; a cold archive adds recall time to RTO. No dollar estimate without approved volume/Region/class. [S3 pricing](https://aws.amazon.com/s3/pricing/).

## Next implementation slices and acceptance

These are prerequisites and verification requirements, **not scheduled work or software-enforced retry limits**. All tasks below are pending until separately approved; acceptance checks below are proposed and have not run.

| Task | Prerequisite | Owner / relevant files / deliverable |
| --- | --- | --- |
| F1 catalogue | Design reviewed; local contract approved | One agent; DB backup/evidence helpers and object-storage contract; authenticated catalogue and completion/refusal logic. |
| F2 independent-byte rehearsal | F1 | One agent; recovery seed/target helpers and a new focused spec; separate primary/copy/recovery buckets and test-only mapping/probe. |
| F3 application recovery | F2; identity path approved | One agent; storage resolver/module and API acceptance tests; migrations only if independently justified. |
| F4 provider/custody drill | F3; all founder deployment gates satisfied | Operator/custodians; separately scoped infrastructure/runbooks and retained provider evidence. |

### Acceptance criteria — proposed, not yet run

- **F1:** snapshot membership covers all report types/soft-deleted rows and observed text versions; discovery is bounded; completion is signed; interrupted copy resumes idempotently. Test under isolated PostgreSQL/Moto fixtures.
- **F2:** primary is denied; native-version and translated-identity contracts are distinguished honestly; corrupt/missing evidence, stale/partial catalogue and wrong mapping refuse. Re-run healthy controls after faults. No claim of native AWS replication.
- **F3:** the restricted app role reads exact PDF/text/standard-report bytes and authorized links bind verified versions. Tenant isolation, clinical holds and evidence guards remain intact.
- **F4:** live synthetic retention, permissions, encryption, backfill and lag checks pass with primary denied; restored API paths and offline custody work; provider evidence is retained. Production operations still require separate authorization.

### Required F2/F3 refusal and recovery controls

- Newer different source/destination versions and delete markers; a missing pinned PDF despite a latest substitute being present.
- Exact text corruption and completed unpinned VCF/JSON.
- Tampered, missing, duplicate or foreign mapping; omitted soft-deleted reference.
- Lost copy reply and safe resume.
- Truncated listings, repeated cursors and hard-cap boundaries.
- Wrong/missing decryption or signing key; insufficient retention.
- Interrupted recovery and cleanup of owned temporary files.

Environment failures are not permission/retention passes.

### Measurement evidence

Record source physical DB bytes, archive/catalogue bytes, unique required PDF/text/VCF/JSON bytes and object counts, copied/verified/transferred totals separately; exact bytes plus decimal GB and binary GiB. Pair monotonic inventory/copy/download/verification/DB/end-to-end durations with their volume denominator, concurrency, runtime, storage and key/custody assumptions. Keep database recovery, independent byte recovery and application acceptance separate. Small synthetic timings do not establish production RTO; async replication does not establish zero RPO.

### Existing baseline commands — before F1

**Do not run these expecting F1–F4 functionality to exist; they are the baseline to ensure main is unbroken before beginning F1.**

```bash
pnpm --filter @telesphoros/backend build
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend test --runInBand --runTestsByPath test/db/recovery-cli.pg-spec.ts
```

The focused spec exercises **existing DB/primary evidence only**. Provision helper-owned loopback targets and set both `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` before the spec/service tiers; absent services mean skipped work, not acceptance.

The existing three CI backend tiers use those service URLs; tiers two/three add `TEST_STORAGE=postgres` and then `TEST_OBJECT_STORAGE=s3`. Future new-spec names/commands must be documented when implemented; no file-recovery CLI exists today.

Iterate from observed failures with focused checks, then required integration CI and actual service logs. Reassess after three unsuccessful repairs, repeated identical failures without new evidence or no measurable progress; classify implementation/environment/requirements/permissions. Stop for a missing decision/authorization only when it blocks the next approved slice. See [planning verification](../../verification/report-file-recovery-plan.md).
