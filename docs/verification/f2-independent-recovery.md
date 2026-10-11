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
| Linux CI fresh workers exit before IPC or backup reads: fixed diagnostic category `native-binding`; minimal-environment startup reproduces missing native user cache | Give SWC an explicit private cache inside the owned fixture directory; canonicalize its path (macOS temporary paths may contain `/var` symlinks). Keep HOME/XDG and provider credentials absent, unexpected output fatal, and per-worker temporary cleanup assertions unchanged |

No production guard, meaningful assertion or test was removed to obtain green results.

## Integration and required local checks

- F1/F2/DB CLI regressions: **6 suites / 60 tests passed**.
- Complete PostgreSQL/S3 backend: **120 suites / 1,794 tests passed**, with no failures, missing-service notices or conditional password skips; the local fixture uses SCRAM. Existing negative controls emit expected database/identity warnings.
- Workspace lint, typecheck, production build and production knowledge-directory verification passed. Frontend chunk/foundation checks passed (145.2 kB entry gzip).
- Workspace service-free tests passed: backend **1,145**, frontend **184**, remaining packages **74**. Backend explicitly skips service-only tiers in this command; the complete service run above supplies that coverage. Initial sandbox refusal of the fake identity provider's loopback listener was classified as environment/permissions and repaired by running the same checks with permitted loopback access.
- Infrastructure guards **31 passed**; CI guards **31 passed**, including negative artifact/missing-profile controls. Final focused checks passed **22 tests in each of the three profiles**; the CLI validator accepted all three generated profiles against the current checkout HEAD. Staged gitleaks scan passed with zero leaks and no new allowlist entries.

Local JSON records the checkout HEAD, which was base main while the implementation was uncommitted; local checks cover the edited working tree. Required CI must generate and validate measurements at the actual reviewed PR checkout before delivery acceptance.

The three focused profiles were subsequently regenerated and validated at committed head `509bce6`. Draft PR #63's initial and diagnostic CI runs passed the other six checks but failed the F2 worker startup in Tier 1; later tiers correctly did not run. Those runs do not provide F2 acceptance evidence. The private native-cache repair passed the final CI run recorded below.

## Remaining limits

The fixtures prove synthetic translated-copy bytes only. Native identity is a separate unit contract. No AWS IAM/Compliance/KMS/native replication/custody proof, no application recovery or clinical release, no production RPO/RTO claim. Abrupt termination/power-loss DB cleanup is outside the cooperative interruption controls. F3 application and F4 provider/custody acceptance remain separate from this completed F2 delivery.

## Merged delivery evidence

[F2 PR #63](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/63) merged as `2a6022f653a56382f3e2c4299337144066d23856`. [Final CI run 38094880125](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38094880125) passed all seven checks at head `222955ae35e7ef3e31cdef4d3c2d778a5a338c43`. The tested PR checkout `bda879a3595b397e7bf71461eacb43d69e5db868` and actual main merge have the same tree `96996a9f5abad39de1ec9e79180dae053cb0e4c5`.

Inspected database logs show Tier 1 **1,612 passed / 182 expected profile skips**, Tier 2 **1,793 passed / one expected profile skip**, Tier 3 **1,794 passed / zero skips**, with zero failures/missing-service notices/conditional password skips. All three downloaded F2 artifacts passed the strict validator against the actual tested checkout; each contains 30 passed controls/seven measurements and application recovery false. F1 artifacts from that run each retained 12 passed controls/three measurements. Verify, browser, image, Terraform, advisory terraform-lint and full-history secret-scan logs were also inspected. No production recovery or clinical acceptance is inferred.
