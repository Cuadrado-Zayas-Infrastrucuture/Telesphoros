# F2 verification — synthetic independent bytes

Approved base main `3c1e191`; branch `feat/f2-independent-recovery`. No application/schema/clinical/production change. Verification uses new task-owned loopback PostgreSQL 16 with SCRAM and Moto, pinned Node 22.22.0, and a separately owned fresh recovery cluster.

## Confirmed local evidence

- GitHub ruleset `24691287` now requires `image` plus the five existing checks. Full before/after comparison confirmed every other existing rule/condition/bypass field unchanged; effective main checks were read back. This is an authorized live GitHub setting change, not an AWS operation.
- Focused F2 run: **2 suites / 22 tests passed**, 30 aggregate controls and seven healthy recovery measurements. Every healthy run recovered all five required objects through real HTTP, verified the restored DB and exact installed target bytes, and recorded zero primary requests.
- Copy/backup reader denied primary GET and copy PUT. Separate loader is scoped to its target bucket. Fresh workers carry no producer result/cache/local backup path or direct emulator endpoint. Returned recovery metrics keep application recovery false.
- Refusal controls include missing exact PDF despite a latest substitute, corrupt exact text/catalogue, authenticated invalid/omitted/foreign mappings, stale binding, partial generation, wrong/missing keys, encryption/retention drift, interrupted recovery and incomplete listing boundaries.
- A fresh resume installs remaining target objects after interruption; a subsequent healthy run verifies them with zero write payloads. A separate target prefix ensures the lost-write-reply control actually performs PUTs.
- Each worker's restore database and private temporary files are checked after success/failure. Original unrelated workflow setup remains untouched.

## Observed failures and repairs

| Observed evidence | Repair / reassessment |
| --- | --- |
| Duplicate tenant patient label | Generate distinct labels |
| Label exceeds existing 40-character constraint | Use the existing `SYN-` plus UUID convention |
| Attempt to recreate built-in `pg_database_owner` | Reassess setup against the CLI rehearsal; extract/reuse its existence-checked role provisioning |
| Bucket listing's trailing slash misclassified as object GET | Classify nonempty path components; exact object GETs still require versions |
| Artificial cap cursors passed into Moto and lost the final object | Cache the actual first terminal page inside the test-only pagination injection; preserve the 1,000-page software boundary |

No production guard, meaningful assertion or test was removed to obtain green results.

## Integration and required local checks

- F1/F2/DB CLI regressions: **6 suites / 60 tests passed**.
- Complete PostgreSQL/S3 backend: **120 suites / 1,794 tests passed**, with no failures, missing-service notices or conditional password skips; the local fixture uses SCRAM. Existing negative controls emit expected database/identity warnings.
- Workspace lint, typecheck, production build and production knowledge-directory verification passed. Frontend chunk/foundation checks passed (145.2 kB entry gzip).
- Workspace service-free tests passed: backend **1,145**, frontend **184**, remaining packages **74**. Backend explicitly skips service-only tiers in this command; the complete service run above supplies that coverage. Initial sandbox refusal of the fake identity provider's loopback listener was classified as environment/permissions and repaired by running the same checks with permitted loopback access.
- Infrastructure guards **31 passed**; CI guards **31 passed**, including negative artifact/missing-profile controls. Final focused checks passed **22 tests in each of the three profiles**; the CLI validator accepted all three generated profiles against the current checkout HEAD. Staged gitleaks scan passed with zero leaks and no new allowlist entries.

Local JSON records the checkout HEAD, which was base main while the implementation was uncommitted; local checks cover the edited working tree. Required CI must generate and validate measurements at the actual reviewed PR checkout before delivery acceptance.

## Remaining limits

The fixtures prove synthetic translated-copy bytes only. Native identity is a separate unit contract. No AWS IAM/Compliance/KMS/native replication/custody proof, no application recovery or clinical release, no production RPO/RTO claim. Abrupt termination/power-loss DB cleanup is outside the cooperative interruption controls. Required CI delivery evidence remains pending until a reviewed PR run exists.
