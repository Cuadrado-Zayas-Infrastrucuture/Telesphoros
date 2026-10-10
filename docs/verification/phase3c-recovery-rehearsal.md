# Phase 3C current-schema CLI recovery rehearsal

2026-10-10; founder authorized “go” after merged #56. Local source baseline `8848998`; the built production CLI is unchanged. The [retained JSON evidence](phase3c-rehearsal-evidence.json) records the exact rehearsal source hashes, built CLI hash, source/target configuration, backup identity, table counts, required object inventory, phase measurements and cleanup results. Local test source was uncommitted at this measurement; final PR-head CI is a separate acceptance record in the PR.

## Result and boundary

The built format 2 CLI backed up and uploaded a 13-migration database, restored it from the local S3 emulator into a separate freshly initialized PostgreSQL cluster, and verified database contents, privileges, tenant isolation and complete ledger chains. The Phase 3A catalog acceptance helper independently checked the restored constraints and query indexes. All six rehearsal tests passed; all nine recorded controls passed.

The source contains 18 tables / 1,177 rows, with three synthetic tenants, 306 patients/reports, 300 recommendations, six uploaded PDFs, six captures/acceptances, 24 evaluations, 72 result rows, 48 gene-state rows, 12 corrections (retraction/reinstatement), six disputes, three decisions and three verifier checkpoints. Ledger chains contain 60 events. Received core reports are metadata-only; no nonexistent uploaded file is claimed for them. The seeded history uses restricted application/verifier connections, existing report-upload repository transitions and real versioned object writes. Its fictional clinical wording is a fixture, not a clinical/model evaluation.

Exact pinned PDF versions and captured-text hashes were readable on primary storage after database recovery. Each PDF key has newer different bytes; acceptance retrieves the stored original version/hash. Missing exact versions and altered separately written bytes fail the same test-only evidence acceptance function used by the positive control. **No independent report-file copies were restored; complete application recovery remains false.** Capture text is hash-bound but the current schema does not pin its VersionId. The inventory records its observed version without inventing a schema guarantee.

## Measured baseline

| Volume | Exact bytes | Decimal GB | Binary GiB |
| --- | ---: | ---: | ---: |
| Source physical database | 11,025,431 | 0.011025431 | 0.010268233 |
| Plaintext custom dump (compressed pg_dump archive) | 246,953 | 0.000246953 | 0.000229993 |
| Encrypted archive | 247,006 | 0.000247006 | 0.000230042 |
| Signed manifest | 18,640 | 0.000018640 | 0.000017360 |
| Six required pinned PDF versions | 1,572,864 | 0.001572864 | 0.001464844 |
| Six required captured-text objects | 84 | 0.000000084 | 0.000000078 |

| Operation | Elapsed seconds | Denominator / meaning |
| --- | ---: | --- |
| Backup process | 0.299047 | Source physical database size; includes manifest collection, pg_dump, encryption and process overhead |
| Upload process | 0.207739 | Encrypted archive plus manifest transferred to loopback emulator |
| Remote restore CLI | 0.532159 | Archive plus manifest downloaded; decrypt, pg_restore and built-in verification included |
| Database verified, including independent catalog acceptance | 0.561955 | Source physical database size; report bytes excluded |
| Primary report/text availability check | 0.043503 | Required PDF and text logical bytes read; independent-copy recovery excluded |

Node 22.22.0, PostgreSQL 16.14, macOS arm64 / Apple M5 / 16 GiB RAM, local database directories and loopback Moto S3. Both PostgreSQL clusters have fsync and synchronous_commit on; the fresh target uses SCRAM authentication. JSON includes monotonic phase durations for pg_dump, encryption, upload, download, decrypt, pg_restore and verification plus temporary cleanup. Timing hooks wrap real compiled-module calls; they never substitute database, encryption or provider work. Overlapping phase/end-to-end timings must not be summed. Denominators distinguish physical database bytes, compressed archive bytes and logical file bytes.

This is an approximately 0.011 GB database procedure baseline. Random UUIDs/timestamps and database physical allocation cause small byte-count variation across runs. These numbers do not establish production throughput, RTO, GB-scale performance, live-provider durability or external custody. Do not extrapolate from them.

## Failure controls and cleanup

| Control | Required result |
| --- | --- |
| Target roles absent on a freshly initialized server | CLI exit 1 before creating a restore database; recreate only required NOLOGIN fixture groups, then positive restore |
| Wrong key | CLI exit 1 at manifest signature; remote provider read only |
| Provider-side manifest tamper | CLI exit 1 at signature; original bytes restored and healthy restore rerun |
| Provider-side archive bit flip | CLI exit 1 at archive checksum; original bytes restored and healthy restore rerun |
| Restored RLS disabled / application SELECT grant removed | Separate test-only post-pg_restore injections; CLI exit 1 on security/privilege verification; healthy restore after each |
| Signed/encrypted backup containing altered capture scalars | CLI exit 1 at complete ledger-chain verification; healthy original backup passes |
| Missing pinned report version / changed evidence bytes | Exact-version acceptance fails even when a newer object exists; original version/hash still passes |
| Every CLI refusal / positive throwaway control | Private download/decrypt workspace empty; target database list unchanged |
| Final cleanup | Owned retained restore database, synthetic source database and fresh target cluster removed; source fixture server and emulator are shut down by the local operator |

All fault controls act only on registered synthetic fixtures. The backup upload key only writes; the recovery key only lists/reads through the strict local gateway. No operational key material, resolved credentials, patient identifiers, primary file bytes or connection URLs appear in the retained record. Emulator bucket/key/version values refer only to generated synthetic files. Remote tampering writes new versions in owned emulator buckets, never deletes retained versions.

## Repeat the bounded rehearsal

Use an unprivileged OS account, PostgreSQL 16 **server and client** binaries (including initdb/pg_ctl), Node 22, and the repo's installed dependencies. Supply TEST_DATABASE_URL for a disposable loopback source cluster and TEST_S3_ENDPOINT for a local Moto instance. This suite refuses non-loopback endpoints and creates its own target cluster; it accepts no target data directory or target URL. PGBIN may select PostgreSQL 16 server tools. The source helper creates/drops only its random owned database.

```bash
# TEST_DATABASE_URL and TEST_S3_ENDPOINT are supplied in the environment, never pasted into logs.
# PGBIN points to PostgreSQL 16 tools when pg_config selects a different version.
RECOVERY_REHEARSAL_OUTPUT=/absolute/path/rehearsal.json \
  pnpm --filter @telesphoros/backend test --runInBand test/db/recovery-cli.pg-spec.ts
```

The suite builds dist/ before executing keygen, backup, upload and restore in separate Node CLI processes. Its output path retains synthetic evidence outside its temporary fixture tree. Do not run it against production/shared data or a real provider. Recreate fixture data instead of repairing or deleting any existing operational object/database. Existing CI runs the suite in all three database/storage tiers; final acceptance requires actual passing tier summaries and all required checks on the final head, not a green pipeline alone.

## Verification and follow-ons

Focused rehearsal: six tests passed in 14.334 s. Backend lint/typecheck passed; backend and required shared package builds run in the rehearsal. Complete local PostgreSQL/S3 regression: 113 suites / 1,719 tests passed with no skips in 163.844 s. The final safe CI metric emission was subsequently verified in the focused rehearsal. Final-head CI outcomes are recorded in the PR after actual log inspection.

Phase 3B #56 merged at `8848998`, with inspected final-head CI `38072875490`: default 1,531 passed / 182 profile skips, PostgreSQL 1,712 passed / one profile skip, PostgreSQL/S3 1,713 passed / no skips; all seven required checks passed. Phase 2 #51/#52/#53 documentation was already refreshed in #54; this does not grant blanket acceptance of subsequent phases.

A separate report-file recovery plan must evaluate independent retained copies, **S3 Object Lock Compliance Mode**, **Cross-Region Replication**, all referenced PDF versions and captured text, retained decryption keys, custody/BAA controls and the founder's single-Region policy exception. No file-copy architecture, scheduler, AWS/provider resource, retention/cryptography change, migration, deployment, production operation or clinical approval is included here. Whole-Phase-3 founder acceptance remains distinct from this bounded local rehearsal.
