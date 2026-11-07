# Treatment follow-up verification
Date: 2026-11-02

Scope: [treatment-linked documentation and in-app reminders](../design/plans/treatment-followups.md), implemented under the founder's instruction to continue. This work preserves the preceding local chat/patient workflow. All test records are synthetic; no deployment, inference provider, external notification or Data Insights export was used. AI generated the implementation and tests; visual inspection is recorded separately below.

## Behavior and test evidence

The new HTTP suite first failed with 404 because the follow-up endpoint did not exist. Its final 11 cases exercise the real Nest application, PostgreSQL migrations, application role, transactions and ledger verifier: documentation plus next task, idempotent/changed retries, concurrent edits, stale versions, reschedule/dismiss history, cross-patient medication refusal, cross-tenant HTTP and database reads, clinical roles, removed assignees, author-only amendments, invalid input, default-off and production write refusals, counts beyond 20 items and append-only application-role permissions. A fixed-clock SQL test covers local midnight and the New York daylight-saving transition. Assessment timezone is independent of the next task, including closed threads.

The same-patient medication guard was temporarily removed from the uncommitted migration for one isolated test run. The unchanged HTTP test failed with `expected 400, got 201`. The file was restored byte-for-byte; all 11 cases then passed. No mutated migration was used in the final demo stack.

Seven relevant PostgreSQL suites passed, **230 distinct tests**: follow-up HTTP, schema acceptance, migration execution, tenant binding, tenant capability permissions, real migrator rollback guards and existing use eligibility. Two combined runs reported 106 and 135 passes with the 11-case HTTP suite repeated. The populated follow-up rollback test uses a real non-superuser migrator hidden from rows by FORCE RLS, proves refusal and restored FORCE state, then proves empty rollback after deleting only its disposable fixture records. Catalog assertions retain explicit constraints, keys, indexes and policy counts.

The browser scenario creates a patient and medication, schedules an overdue task, returns to the preserved chat draft, opens the reminder panel, documents response and the next date, interrupts the first save at the browser transport boundary, retries against the actual API, then reloads/signs back in and reads the saved assessment and original schedule in history. It does not mock the repository or database. The fake identity provider and local Moto server are the existing controlled external-service substitutes.

Initial browser reload checks incorrectly assumed that the application retains its in-memory login and that the fake provider would show the account picker again. The corrected test follows the actual sign-in return and preserves the persistence assertions. A populated desktop sidebar exposed a keyboard-inaccessible report-history scroller; making the named scroll region focusable fixed the accessibility failure. A report-page unit fixture previously sent follow-up requests to its report-response counter; it now returns the distinct follow-up contract without changing the report error/retry assertions. The closed reminder panel also defers its hidden contents so it does not expose irrelevant alerts.

## Check results

| Check | Result |
| --- | --- |
| Relevant real PostgreSQL suites | 7 suites / 230 distinct tests passed; the 11 new HTTP cases passed again after restoring the guard mutation |
| Complete product-demo browser regression | 18 passed at 375×812 and 1280×800, including both follow-up cases; expanded forms/panels pass Axe and horizontal-overflow checks |
| Complete frontend unit suite | 62 files / 694 tests passed after the endpoint fixture correction; 55 branding/preview checks passed |
| Workspace typecheck, build, lint/format | Passed; final frontend build/typecheck and lint rerun after the component-file extraction |
| Production chunks and foundation | Passed: 99.8 kB gzip entry within the 150 kB budget, 13 lazy page chunks, synthetic interpretation and AI SDK excluded from normal production assets |
| CI configuration | 217 passed; the updated status fragments separately passed all 12 checks with subprocess access |
| Default workspace tests | Failed overall: backend 2,076 passed, 1 failed, 462 skipped; 155 suites passed, 1 failed, 26 skipped. The unchanged subprocess-reader test still reports a surviving child at its process-tree deadline. Other workspace packages passed 898 tests and the root script checks passed 47. Frontend was rerun independently as above after the workspace command stopped. |
| Infrastructure | Failed: final run 283 passed, 2 failed with `spawnSync git EPIPE` in the unchanged Git-ignore subprocess checks. The preceding run had 284 passes and one failure with the same error. No assertion or deadline was weakened. |

The foundation check initially refused several components in `FollowupsSection.tsx`; `FollowupValues` and `FollowupHistory` were moved to matching files. The final frontend build, typecheck, lint and foundation check pass; browser behavior was verified before this extraction, which changes no rendered markup or behavior.

Opened and visually inspected the mobile failed-save form, desktop reminder panel, final desktop follow-up/history and final mobile reminder panel. Six final screenshots are saved outside git in `/workspace/investor-demo-assets/treatment-followups/`. Labels, status words, assigned-to-me display and historical deadlines are readable; mobile has no horizontal overflow. Other clinicians' membership-reference display remains a prototype limit.

The owned demo runs were `34d0c567-00c3-4eda-a79e-da3a46d0ecad` and `839fbab9-677e-466e-bdbb-7d6029f62503`. Each exact blast-radius file was reviewed before UUID-scoped teardown; both returned `Owned teardown verified`. The separate disposable PostgreSQL test cluster at `/tmp/telesphoros-followup-pg` was stopped. Logs remain under `/tmp/telesphoros-investor-tools/followup-*.log`; no public repository upload or hosted release was performed.

## Limits

The complete PostgreSQL/S3 backend tiers, private report-reader engine, hosted CI and real notification channels are not covered by the selected database suites or browser tests. The default workspace command announces its service/engine skips; skipped tests are not passes.

Reminders are persistent in-app due lists refreshed on focus, visibility, save and a 60-second visible-view interval. There is no email, push or off-app delivery. Only the latest assessment can be amended by its author; earlier versions remain in history. A reminder links an exact recorded medication version, not a proven treatment episode or ingestion. Response categories are documentation, not validated outcome instruments or causal treatment-effect measurements. Optional decision references are checked by the API/database; decision selection on the patient page remains unimplemented. AI note drafting and chart/analytics projections remain separate work. Other clinician identities are still represented by membership references until a display-name directory is available.

Migration 0067 changes the ledger event catalog and requires coordinated migration/API/worker/verifier rollout before enabling `FOLLOWUP_WRITES`. The setting defaults off and production writes are refused. Existing synthetic-only eligibility remains unchanged; these records do not become authorized secondary-use data automatically.

The subsequent read-only [response-summary slice](followup-response-summary.md) adds a physician-facing chart with its own verification and counting rules. It does not change these storage or release limits.
