# Phase 3A verification

2026-10-10, baseline main `443e654`. Synthetic PostgreSQL 16.14 on the local build host, Node 22.22.0/Unicode 16; no live services or production data.

## Reproduced defect and result

On the original schema, the restricted application role inserted a recommendation naming patient B and patient A's report in one tenant. The regression expected SQLSTATE 23503 but the INSERT succeeded. Independent patient/tenant and report/tenant FKs permit that combination. Evaluations already enforce report/patient consistency through their own composite FK; recommendations now use the same engine-enforcement approach.

0012 adds `reports_tenant_patient_id_uq` and `recommendations_report_patient_fk` with `ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID`. 0013 validates in its own transaction. No old file is edited, no existing row is repaired, and no new application check/custom trigger is added. The requested tenant-first unique key supplements the existing differently ordered report keys; this adds storage/write cost. Existing keys are retained for their callers and FKs; consolidation would need separate evidence and scope.

The restricted role and a bypassing administrator must both accept matched rows and refuse same-tenant mismatches. Parent reassignment and child-reference updates fail; an unrelated status update succeeds. Legacy mismatches survive unchanged, new violations fail while NOT VALID, 0013 fails without undoing committed 0012, and the fixture-only repair allows validation. Rollback/reapplication and the existing checksum guard remain exercised. A blocker holding reports makes 0012 time out instead of waiting indefinitely; retry after releasing it succeeds. Both migrations use 2-second lock waits and 30-second statement limits, not a lock-free promise. Large populated instances may require an explicitly planned index-build/validation window; no such instance was changed.

## Acceptance matrix

All 18 current public tables are classified by the existing catalog guard. New acceptance checks independently specify all 29 FK mappings (ordered child/parent columns, delete/update actions, deferral and validated state), all 18 primary keys, all 25 unique constraints, the complete CHECK-name inventory, and 23 query-facing index definitions with valid/ready flags. CHECK/FK validation state is checked across the whole schema; semantic CHECK/trigger refusals reuse the existing behavioral suites rather than a new copy of their implementation. Counts below are inventory, not a substitute for those proofs.

| Table/class | FK / unique / CHECK counts | Relationships, exceptions and behavioral evidence |
| --- | --- | --- |
| patients, legacy | 0 / 1 / 3 | Tenant label uniqueness, immutable identity, restricted soft deletion; migrations/repositories/tenancy/RLS suites |
| reports, legacy | 1 / 3 / 13 | Patient/tenant FK, immutable uploaded/captured evidence; migrations/report-evidence/upload suites |
| recommendations, legacy | 3 / 0 / 3 | Patient/tenant, report/tenant and new tenant/patient/report FK; recommendation-integrity + repositories/migrations |
| schema_migrations, system | 0 / 0 / 0 | Text version PK; checksum/history/locking/transaction tests; intentionally no tenant or author |
| ledger_heads, controlled state | 0 / 0 / 3 | Tenant PK; guarded one-step advancement with the event; deliberately no child/event FK |
| ledger_events, ledger | 0 / 4 / 8 | Unique tenant sequence/previous hash and subject; bidirectional deferred event-row guards, append-only triggers/verifier |
| ledger_checkpoints, ledger | 1 / 1 / 4 | Deferred tenant/event FK; privileged checkpoint function and verification tests |
| event_notes, notes | 0 / 1 / 6 | Controlled column-level audited redaction; note guard/function tests |
| report_captures, record | 2 / 3 / 7 | Report/tenant and deferred event FK; file version/hash/identity guards |
| capture_acceptances, record | 3 / 1 / 5 | Capture/note/event tenancy; independent reviewer and evidence bindings |
| evaluations, record | 5 / 3 / 8 | Patient, report/patient/tenant, capture, acceptance and deferred event; evaluation guard + ledger DB tests |
| evaluation_results, child | 1 / 1 / 7 | Evaluation/tenant, unique ordinal; outcome/citation shapes and freeze guards |
| evaluation_gene_states, child | 1 / 1 / 4 | Evaluation/tenant, unique gene; state shape/freeze guards |
| corrections, record | 5 / 2 / 7 | Same-report evaluation/replacement, same-evaluation predecessor, note/event; chain/branch/author guards |
| cell_disputes, record | 2 / 1 / 4 | Note and deferred event; locator/digest controls and append-only protection |
| cell_dispute_decisions, record | 3 / 2 / 3 | Dispute/note/event; unique decision and independent reviewer |
| ledger_incidents, incident | 0 / 0 / 8 | Tenant/global scope deliberately supported; function-only insertion, invisible to app; incident suite |
| ledger_incident_clearances, incident | 2 / 1 / 2 | UUID-only incident/checkpoint FKs are deliberate global-scope exceptions; scope/identity/checkpoint validity checked by privileged functions |

Role policies, owners, definer search paths, callers and mutation protections remain enforced by `ledger-catalog.pg-spec.ts`, `rls.pg-spec.ts`, `ledger-database.pg-spec.ts`, `ledger-incidents.pg-spec.ts` and related suites. Legacy mutable tables have created/updated timestamps; append-only/system tables have their own class-specific fields. A universal “every table has tenant/author/updated_at” rule would be incorrect. Every FK is RESTRICT, but not every FK has a dedicated child index: append-only event references cannot be deleted by normal roles; query-facing indexes and parent uniqueness are verified separately. This PR does not add speculative indexes for those impossible application delete paths.

Defect controls modify only disposable database catalogs: weaken the composite FK while keeping its name/count, revert validation while retaining the FK, replace a query index with the same name but reversed columns, and remove a field CHECK. Each must fail acceptance and pass after rollback/reapplication. Restored green controls prevent an unrelated catalog-reader failure from masquerading as mutation detection.

## Query measurements

The test records SQL actually executed by repositories and reruns its SELECT/WITH statements with bound parameters using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` inside application-role tenant transactions. No queries are manually paraphrased. Samples use unnamed/custom parameterized statements, after ANALYZE; the initial repository call warms caches. This does not model generic prepared plans, concurrency, cold storage or production distribution. The retained raw JSON records SQL hashes, parameter types, complete plan trees, row estimates/actual rows, buffers and planning/execution times.

Three tenants, 1,500 core patients each, two reports and one recommendation per core report, plus two lab histories (60 and 5 evaluations each) per tenant. Each history has two acceptance decisions; every third evaluation has a retraction/reinstatement pair. Each tenant has 25 disputes, 13 with upheld decisions. Actual totals: 4,506 patients, 9,006 reports, 9,000 recommendations, 195 evaluations, 132 corrections, 12 acceptances, 75 disputes and 459 ledger events. Database size: 22,363,159 bytes (about 21.33 MiB), including indexes. This is not a GB-scale or capacity test.

24 workload samples, 55 actual SELECT/WITH statements. Core list/count sums ranged up to 1.272 ms in this local sample; filtered core parent/detail reads used existing indexes or the new referenced unique index. Small ledger tables often used sequential scans: correct counts and complete histories passed, and that is reasonable at this cardinality. The lower(label) lookup chose a tenant index with a residual label filter rather than the functional unique index; retain this measured limitation for larger-scale Phase 7/RLS planning rather than force a planner choice here. No optional performance index was added.

| Workload | SQL statements | Execution sum, ms | Shared hit blocks | Indexes observed |
| --- | ---: | ---: | ---: | --- |
| patients-list | 2 | 0.542 | 64 | patients_tenant_seq_idx |
| patient-label | 1 | 0.299 | 30 | patients_tenant_seq_idx |
| patient-detail | 1 | 0.007 | 3 | patients_id_tenant_uq |
| reports-list | 2 | 1.272 | 177 | reports_tenant_seq_idx |
| reports-by-patient | 2 | 0.030 | 8 | reports_tenant_patient_id_uq |
| report-parent-count | 1 | 0.012 | 4 | reports_tenant_patient_id_uq |
| report-detail | 1 | 0.008 | 3 | reports_id_patient_tenant_uq |
| recommendations-list | 2 | 1.256 | 213 | recommendations_tenant_seq_idx |
| recommendations-by-patient | 2 | 0.023 | 8 | recommendations_tenant_patient_idx |
| recommendations-by-report | 2 | 0.021 | 6 | recommendations_report_idx |
| recommendation-detail | 1 | 0.007 | 3 | recommendations_pkey |
| evaluations-page | 4 | 0.265 | 68 | Sequential/other nodes |
| evaluations-by-report | 4 | 0.251 | 68 | Sequential/other nodes |
| evaluations-by-patient | 4 | 0.246 | 68 | Sequential/other nodes |
| evaluations-current | 4 | 0.224 | 65 | evaluations_id_tenant_report_uq, evaluation_results_tenant_evaluation_idx, evaluation_gene_states_tenant_evaluation_idx |
| disputes-page | 3 | 0.182 | 12 | Sequential/other nodes |
| disputes-open | 2 | 0.114 | 8 | Sequential/other nodes |
| disputes-complete-safety-read | 3 | 0.186 | 12 | Sequential/other nodes |
| dense-latest-acceptance | 2 | 0.050 | 5 | Sequential/other nodes |
| dense-complete-corrections | 2 | 0.074 | 11 | Sequential/other nodes |
| dense-context-batch | 3 | 0.183 | 33 | Sequential/other nodes |
| sparse-latest-acceptance | 2 | 0.049 | 5 | Sequential/other nodes |
| sparse-complete-corrections | 2 | 0.072 | 11 | Sequential/other nodes |
| sparse-context-batch | 3 | 0.124 | 19 | evaluations_pkey |

## Executed checks and limits

- Initial mismatch regression failed against main because the mismatched INSERT succeeded; it passes after the migrations.
- Four targeted PostgreSQL suites (recommendation integrity, migrations, nonsuperuser migrations and report evidence): 59 tests passed. Final catalog/integrity controls after completing the inventory: 12 tests passed across two suites, including four rejected catalog mutations and restored green controls. Query measurement suite: both tests passed.
- Root `pnpm lint`, `pnpm typecheck` and `pnpm build` passed; backend lint was repeated after the final acceptance/test additions. `git diff --check` passed.
- Complete backend tier 1: 104 suites / 1,510 tests passed; 7 suites / 182 tests intentionally skipped under the default API storage profile, 108.070 seconds. One final catalog mutation was added afterward and passed in the 12-test targeted controls and following full tiers.
- Complete backend tier 2 (`TEST_STORAGE=postgres`): 111 suites / 1,692 tests passed, one test skipped under this profile, 146.599 seconds.
- Complete backend tier 3 (`TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3`): 111 suites / 1,693 tests passed, no Jest-skipped tests, 140.813 seconds. Both database and S3 environment variables were set in every tier; no tier printed `NOT RUNNING`.
- Separate from Jest's counters, the login-provisioning tests explicitly announce that two password-rotation/repair controls do not exercise password rejection on a trust-authentication cluster. This local cluster uses trust. Final-head CI must provide their password-authenticated PostgreSQL evidence; local green counts do not prove those controls.
- An initial native SWC cache permission failure was resolved with a task-local cache; sandbox localhost/shared-memory restrictions required approved execution outside the sandbox. The first full-tier run failed after the isolated PostgreSQL server had stopped (connection refusal); it is not counted as success. The retained-server rerun supplied the passing results above. An initial catalog reader returned PostgreSQL `name[]` as text; casting attribute names to `text` corrected decoding, and all restored acceptance controls then passed.
- The first CI run (`38069454400`, head `1e25be4`) reported seven successful jobs but its database logs contained two failed nonsuperuser migration tests in every tier. Two migration suites shared a cluster-wide login with different fixture passwords; trust authentication hid the collision locally. A new isolated SCRAM-authenticated cluster reproduced the collision (which suite fails depends on execution order). Both suites now own distinct randomly named logins and remove only those logins after their disposable databases. Five focused SCRAM suites then passed all 40 tests with `CI=true`, including password provisioning, both migration suites and integrity/catalog controls; no trust skip occurred. The old green run does not count as database acceptance.
- The workflow also masked producer failures in its `tee` pipelines. Founder approved a separate CI verification PR after reviewing the patch; it starts from main after externally merged #54. Each tier now sets `pipefail` and has executable failure/skip controls: the original scripts returned 0 for a simulated test failure; repaired scripts return 17, still reject missing services and accept passing producers. Guard tests fail on the original workflow (27/28) and pass on the repaired workflow (28/28). The follow-up also isolates both migration fixtures. Completed test summaries must be inspected directly before accepting a green check.

Final-head CI must verify all seven jobs, including browser/image/infra/security and all three backend tiers; these are not claimed as local browser/image runs. These measurements are evidence at the stated size, not latency guarantees or production capacity acceptance. Backup discovery, CLI recovery, object copies, product upload and live provider/scheduler acceptance remain open in 3B/3C/follow-on plans. No live migration or remediation was executed.
