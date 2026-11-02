# Follow-up response summary verification
Date: 2026-11-02

Scope: the [physician-facing summary](../design/plans/followup-response-summary.md) under the founder's instruction to continue. [Counting rules](../design/followup-response-summary.md) are versioned as `followup-response-v1`. AI generated this change; screenshots were opened and visually inspected as described below. Synthetic data only. No migration, dependency, inference provider, external data release or deployment.

## Behavior evidence

The new real PostgreSQL HTTP test first failed with `expected 200, got 404`. Four new cases now prove all five response/missingness categories, closed-thread inclusion, retry deduplication, latest corrected assessment after reschedule/dismiss, complete counts beyond the 20-item list page, deleted-patient exclusion, tenant isolation, clinician/reviewer access, reader/admin/unauthenticated refusal and invalid-query rejection. The exact response assertion also excludes patient identifiers, labels and notes. All **15 follow-up HTTP cases** passed, including the preceding 11 recording/reminder cases.

A targeted mutation reversed the summary's latest-assessment ordering. The unchanged correction test failed because it counted the original improved response instead of the corrected unchanged response. The source was restored byte-for-byte and all 15 cases passed again. Existing forced RLS and ledger storage were used; no migration or role inventory changed in this slice.

The complete product-demo suite passed **18 cases** at 375×812 and 1280×800 against owned PostgreSQL, local Moto and the fake identity provider. The extended follow-up scenario opens the summary by keyboard, receives an injected 503, rejects an injected successful response with contradictory totals, then retries the real endpoint. The reminder link stays available throughout. It verifies missing-assessment counts before documentation and an improved response after saving/reloading the real follow-up. Expanded charts pass Axe WCAG A/AA checks; visible counts require no hover and the page has no horizontal overflow. Only failure responses are injected at the browser transport boundary; successful values come from the actual database/API.

A separate real-browser check before creating any follow-ups verified the empty clinic state, no table/bars and no Axe violations. This was a temporary verification script, not an added repository test. Final mobile response and desktop missing-assessment screenshots were opened and inspected. Labels, denominator, bar scale and counts fit the panel and the due list remains below the collapsible summary. Five screenshots, including the empty state, are retained under `/workspace/investor-demo-assets/followup-summary/` outside git.

## Checks and limits

Workspace typecheck, build and final lint/format passed. The first lint run caught the deliberately validated-but-unused empty query argument; an explicit use fixed it without suppressing a rule. The normal production build and synthetic demo build both passed branding.

The complete default workspace command failed in the same two unchanged subprocess-reader cleanup tests seen before this slice: backend **2,075 passed, 2 failed, 466 skipped**, with 154 suites passed, 2 failed and 26 skipped. Other packages passed 908 tests and the root script checks passed 47. Infrastructure had **284 passes and 1 failure**, the existing `spawnSync git EPIPE` Git-ignore test. CI configuration passed **217 checks**. These failures were not weakened or skipped to obtain a green result.

The independent frontend run passed **62 files / 694 tests**, plus **55 branding/preview checks**. Production chunk/foundation checks passed: 100.8 kB gzip entry within the 150 kB budget, 13 lazy page chunks and 145 components; synthetic interpretation and AI SDK code remain excluded from the normal build. The final status-fragment check passed **12 tests**.

The full PostgreSQL/S3 backend suites, private reader engine, hosted CI, live notification channels and clinical validation were not run. The selected real database tests and real-storage browser checks are separate evidence; they do not turn the default command's service/engine skips into passes. This slice counts documentation by follow-up thread, not clinical effectiveness, all eligible patients or validated treatment episodes. The live read is not a reproducible historical analytical release; Data Insights cohort definitions, source snapshots, operational grants and disclosure controls remain future work.

The owned synthetic run was `81ea5bf5-9309-4e64-a80a-676562b434d0`. Its exact blast-radius file was reviewed before UUID-scoped teardown, which returned `Owned teardown verified`. The separate disposable PostgreSQL test server was stopped. Logs are `/tmp/telesphoros-investor-tools/summary-*.log`; no public upload was performed.
