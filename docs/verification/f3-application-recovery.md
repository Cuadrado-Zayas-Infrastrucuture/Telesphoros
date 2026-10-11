# F3 verification — actual synthetic application paths

Approved base main `2a6022f` (merged F2 #63), branch `feat/f3-application-recovery`. Scope is the [F3 plan](../design/plans/f3-application-recovery.md); default production activation, clinical algorithms, schema, infrastructure, real records and spend are unchanged.

## Confirmed local checks

- Full backend on owned loopback PostgreSQL 16/SCRAM and Moto: **122 suites / 1,812 tests passed**, zero failures. Expected negative database/identity warnings do not establish deployment acceptance.
- Focused F2/F3 integration and resolver controls: **three suites / 37 tests passed**. F3 has 12 tests/13 recorded controls; each healthy fresh process records 12 named application control groups after assertions pass.
- Workspace build, lint and typecheck passed. Service-free workspace tests passed: backend **1,151 / 182 expected service/profile skips**, frontend **184**, other packages **74**. The full service run above supplies skipped coverage.
- CI guards **34 passed**, including executed pipeline fail/skip controls and positive/negative F3 artifact validation. No new required job or branch-protection change.

Final committed-head profile regeneration and artifact validation are recorded separately in the delivery evidence. The full service/workspace checks above initially exercised the edited working tree. The original implementation snapshot above precedes PR delivery. The separately authorized PR and inspected CI results are recorded below; local checks do not replace that evidence.

## Merged delivery evidence

Founder separately authorized opening draft [PR #64](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/64); it merged externally at `60a73aa62958ae9338624db4edeb06983535ac24` on 2026-10-11 00:24:26 UTC (2026-10-10 in Puerto Rico). Reviewed head `7038d5348c6a994b494b29c32d941e68dedfbd19`, tested PR checkout `718b4561308c2fbf01f5deef740f3281e0d039f7` and merged main share tree `441111232b9b3767272c757674185763177ed701`. No commits were pushed after merge.

All seven jobs of [CI run 38097362628](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38097362628) passed. Actual logs, not just badges, were inspected:

| Check | Observed evidence |
| --- | --- |
| Database/storage | Three backend tiers: 1,630 / 1,811 / 1,812 passed; 182 / 1 / 0 expected profile skips; zero failures or emitted missing-service notices |
| Workspace | Build/lint/typecheck passed; CI guards 34; service-free backend 1,151 passed, frontend 184, other packages 74 |
| Browser | 54 + 18 passed |
| Terraform/lint | 13 offline plan controls passed; tflint passed; no apply |
| Secrets | Full-history scan: zero leaks, no new exceptions |
| Image | 16 guards, build/attestations, vulnerability gate and actual provisioning/migration/two-task containment passed; no publish/deploy |

Downloaded all nine F1/F2/F3 aggregate profiles. F2/F3 strict validators passed against tested checkout `718b456`, including privacy whitelist, all three profiles, volume/time consistency and honest completeness flags. Each F3 profile contains 13 passing controls and two healthy measurements with 12 application groups, seven required objects and source physical DB **9,821,207 bytes**. F2 retains application completeness false; F3 synthetic application completeness is true while clinical approval/native replication remain false. F1 baseline records 12 controls/three measurements; F2 30/seven. CI keeps these aggregate artifacts seven days; that retention is not a live custody evidence sink.

## Actual acceptance evidence

Workers start with no HOME/XDG/ambient provider credentials, primary endpoint, local backup path or cached report bytes. A canonical private native cache contains executable dependencies only. Each worker verifies/restores the pinned DB backup and all seven required independent objects before mounting the adapter through the actual application module. A synthetic HTTP boundary denies application primary/copy reads and target writes; parent observations show zero primary requests and exact pins on successful object GETs.

The app uses a non-superuser, non-BYPASSRLS login, a separate ledger verifier and an application storage read credential. Actual authorized PDF/text URLs download hash-matching target versions; unauthenticated/reader/foreign-tenant requests refuse without touching storage. All report kinds are read through the application provider; metadata APIs preserve tenant/soft-delete visibility. Existing hand-written D01/D08 expectations match the real pinned Python reader/adapter/engine. Held results, `actionable=false`, unapproved clinical use, DB immutable evidence guards (`23000`), ledger validity and unchanged evidence inventory all pass. No standard-report download API is claimed.

Refusal controls require exact fixed codes for corrupted installed authentication, foreign DB/destination, missing startup PDF, post-start missing PDF/corrupt text and independent-copy missing/corrupt/malformed/incomplete listing. Fresh restore DBs/private download directories are checked after every successful/refused worker. Healthy recovery after faults reuses verified installed objects with zero write payloads.

## Observed repairs

| Observed failure | Diagnosis and repair |
| --- | --- |
| Initial Moto connection refused before fixture setup | Owned emulator process did not survive its launching shell; restart detached, retain PID/logs, leave shared services untouched |
| Missing-mapping fault fetched an unpinned latest catalogue | Pin the fault injector to the completion record's authenticated catalogue version; keep the exact-read assertion |
| Lint found an unused destructured bytes field | Return explicit metadata fields from `inspect`; preserve byte/hash verification |

No meaningful test, refusal guard, evidence identity constraint or allowlist was weakened.

## Limits and next priority

Application completeness is only the verified existing synthetic paths for this dataset. F2 still reports byte-only application completeness false. Production activation and a durable custodied loader handoff are not implemented; the application library is explicitly injected. Moto metadata and the synthetic permission gateway cannot prove AWS signature/IAM/Compliance/KMS/native replication. Cooperative cleanup does not establish power-loss cleanup. Byte timings plus small dataset denominators cannot establish production RTO/RPO or clinical release.

Next: [F4 preparation and prerequisites](../design/plans/f4-provider-custody.md); provider/custody operations only after all [founder deployment gates](../design/plans/report-file-recovery.md#founder-deployment-gates--required-before-f4) and a separately approved scope. Whole Phase 3 acceptance and broader clinical/release holds remain open.
