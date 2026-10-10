# F1 catalogue verification — local protocol evidence

2026-10-10; base main `2b96033`, branch `feat/f1-evidence-catalogue`. Founder approved the separate local implementation. This page records the pre-CI working-tree checks; the published draft PR adds exact final head, required checks, inspected logs and downloaded artifact evidence. No AWS operation, production data, clinical acceptance or independent-primary-denied recovery ran.

## Exercised behavior

| Control | Actual evidence |
| --- | --- |
| Authenticated membership | Separate key/domain, encrypted checkpoint/catalogue/completion; altered bytes, wrong domain/key, unknown fields and malformed Unicode refuse |
| Verified snapshot | Real format 2 PostgreSQL restore verifies schema/privileges/ledger before callback; later live rows excluded; 108 refs across numeric keyset boundary, all types, captures and soft deletion; restricted app inventory role refuses |
| Cleanup | Failed authentication never runs callback; callback failure leaves no owned restore DB; bounded HTTP body is aborted and owned subprocess is terminated |
| Source resolution | Exact DB PDF pin; hash/type/size/scalar-bound historical text and unpinned VCF/JSON; oversized newer VCF skipped while older match verifies; missing PDF pin refuses despite latest substitute |
| Copy/resume | Five exact translated object mappings, version-bound retention/encryption metadata read with bytes; all lost PUT replies recovered by discovery/read-back; checkpoint interruption resumes frozen identities; second healthy run writes zero bytes |
| Refusal/healthy controls | Omitted authenticated membership, corrupt text, scalar drift, foreign/duplicate mappings, wrong/shared/missing keys, short retention/wrong encryption and truncated discovery refuse; healthy control rerun after faults |
| Discovery bounds | Terminal page 1,000 succeeds; truncated page 1,000 refuses without request 1,001; repeated/missing cursors, aggregate caps and monotonic deadlines refuse |
| CI posture | Existing failure/skip pipeline controls preserved; 28 CI configuration tripwire tests pass; exact-source TLS scan extended for the new compliant inventory connection, bypass controls unchanged |

## Checks and observed repairs

The six focused catalogue/S3/PG + crypto/backup/ledger suites passed **104 tests** before the last refinements. Final new-spec run passed **32 tests in three suites**, including the oversized-current-version control and strict final discovery/error handling. TLS guard passed all three controls. Backend build, typecheck and lint passed after final source edits. The full `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3` backend run passed **118 suites / 1,772 tests** in 171.085 seconds, with no actual missing-service notices. Two existing password controls internally announced skip on the trust-authentication local cluster (Jest still counts these bodies as passing); password-rotation/repair acceptance requires the password-authenticated CI cluster. The final manifest/key binding refinement then passed all **15 real PG/producer tests**.

Observed environment failures were resolved using existing tooling: frozen install fetched a missing local pnpm tarball; Node 22.22.0 and PostgreSQL 16 client paths matched CI (ambient `pg_restore` 18 emitted unsupported `transaction_timeout` on PG16); native SWC used a task-local cache instead of a denied user-cache path. No dependency resolution or repository workaround changed.

Moto returned HTTP 200 with an undecodable separate GetObjectRetention reply; the documented exact-version GET already returns version/retention/encryption headers. The adapter now verifies those fields with bytes from the same response, a stronger binding with no emulator-specific production bypass. An initial broad backend run found the existing TLS guard's connection inventory missing the new module: 1 failed / 1,589 passed / 182 intentionally skipped. The shared-builder bypass guard passed; adding the real compliant site to its expected inventory repaired the cause without weakening it.

## Measurement evidence and meaning

The actual producer fixture has **132 required payload bytes** across five objects: two PDFs (74 bytes), VCF (21), JSON (18), text (19). Artifact records exact source/restored physical DB bytes, encrypted archive/catalogue bytes, per-kind counts/bytes, copied/verified totals and monotonic restore/inventory, resolve, copy/verify, publish and total seconds. It records three healthy measurements (initial, no-write resume, healthy after faults), not a production RTO benchmark. See [runbook semantics](../ops/evidence-catalogue.md#aggregate-measurement-artifacts).

The local aggregate JSON passed a strict field whitelist/shape/unit/false-acceptance validation. Local runs occurred before commit, so their `gitHead` is base `2b96033` and identifies the pre-commit checkout only. Delivery evidence must use final CI artifact checkout/run metadata. CI retains aggregate-only `evidence-catalogue-measurements` for seven days across all three storage profiles; no raw catalogue, identifiers, object keys, contents, URLs or credentials are included.

## Limits and next slice

Moto proves metadata/protocol behavior only, not AWS Compliance lock, IAM, KMS, custody isolation, native replication or Region-loss recovery. The 15-minute budget is checked between phases/operations; local file hashing/crypto and owned cleanup are not forcibly preempted. Limits are ceilings, not a tested capacity promise. Returned catalogue objects contain confidential membership and must never be logged.

`independentBytesRecovered=false` and `applicationRecoveryComplete=false`: F1 reads primary when resolving/resuming and installs no app resolver/CLI/scheduler. F2 requires a separately approved primary-denied recovery rehearsal; F3/F4 and all founder deployment gates remain open. Owned fixtures are task-local and never use/stop the shared service. Original unrelated workflow files are preserved. See [approved plan](../design/plans/f1-evidence-catalogue.md).
