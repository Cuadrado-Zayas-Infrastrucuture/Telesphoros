# Follow-up inbox filters verification
Date: 2026-11-02

Scope: the [approved-workflow continuation](../design/plans/followup-inbox-filters.md), using synthetic fixtures only. AI generated implementation and tests. No migration, notification channel, provider call, secondary-use eligibility or deployment change.

## API evidence

Four new real PostgreSQL HTTP cases cover filtering before the 20-row page boundary; two pages with no duplicated entries; authenticated assignment; unchanged whole-clinic counts; latest-version reschedule, reassignment and closure; due-today in Pacific/Kiritimati and Pacific/Pago_Pago; removed assignees; tenant/clinical-read roles; invalid, repeated and history-mixed parameters; and refusal of inbox selectors on patient-history reads.

The baseline reproduction failed with HTTP 400 where the new filtered request required 200. An initial command omitted `TEST_STORAGE=postgres` and skipped the suite; that run is not behavior evidence. After implementation, all **19 HTTP tests passed**. A targeted mutation replaced the assignment restriction with a condition that admitted other assignees. The unchanged test failed because “mine and overdue” returned a colleague's reminders. The file was restored byte-for-byte, and all **19 tests passed again**.

The SQL applies parameterized selectors before LIMIT/OFFSET. “Me” comes from the authenticated principal, never a caller-supplied clinician ID. Counts continue to cover the clinic; status uses the existing database-time/IANA-timezone function. The patient-history contract and write guards remain unchanged.

## Browser and checks

The final full product-demo regression passed **36 cases** at 375×812 and 1280×800, including all six new filter cases, existing report upload, direct follow-up entry and response-summary flows. The initial browser run exposed a test locator problem: an exact wrapping-label selector did not find the Assignment select. It was corrected to the accessible combobox role/name, retaining every behavior assertion. The interrupted-read case already passed with the status control. The next full run passed all six new cases but failed two existing first-page checks because the new scenarios left earlier overdue fixtures in the shared clinic. Each new case now deletes only its own created patient through the API in `afterEach`; the final regression used a fresh owned stack. Existing assertions are unchanged.

The browser scenarios use the actual API/database, local S3 emulator and fake identity provider. One case deliberately delays a real response and injects a single HTTP 503 at the transport boundary to exercise cancellation/retry. No component under test or database is mocked.

Workspace typecheck, lint/format and build passed. The synthetic demo build and normal production chunk/foundation checks passed: 101.4 kB gzip entry against the 150 kB budget, 13 lazy page chunks and 147 foundation components. The normal build still excludes synthetic interpretation and AI SDK source maps.

Visual inspection of the final mobile and desktop filtered panels confirmed readable controls and clinic-scope labels with populated lists. Accessibility and horizontal-overflow assertions passed. Final screenshots are retained outside git at `/workspace/investor-demo-assets/followup-filters/mobile-filtered-reminders.png` and `desktop-filtered-reminders.png`.

An initial concurrent check run had **283 infrastructure passes and 2 Git `spawnSync EPIPE` failures**, plus **216 CI passes and 1 subprocess-cleanup failure** in unchanged files. Targeted isolated reruns passed all five Git-ignore cases and the one signalled-process case, without modifying the tests or infrastructure. Final serial runs passed **285 infrastructure checks and 217 CI checks**, including the status fragments. These final passes do not erase the initial intermittent failures.

Root `pnpm test` failed at the unchanged `subprocess-report-reader.cancel.spec.ts` process-tree cleanup assertion: backend **2,076 passed, 1 failed, 470 skipped** (155 suites passed, 1 failed, 26 skipped). The other previously failing subprocess-wrapper case passed in this run. The remaining cancellation failure is unresolved. Other completed tiers passed: workspace scripts 47, password notifier 10, CPIC schema 48, jobs 20, fake IDP 7, shared types 137, AI service 347, worker 151 and SMART pilot 188. The separately completed frontend tier passed **694 tests across 62 files**, plus **55 branding/preview checks**.

The full PostgreSQL/S3 backend suites, absent private reader engine, hosted CI and clinical validation are not part of this local slice. Selected HTTP/browser storage evidence does not turn default service-tier skips into passes. No cross-clinic analytics or Data Insights export was enabled.

Both owned browser runs (`6ed4096b-a3ae-4088-92ef-5adce8f59a28` and final `2d8942d4-2adc-4651-b18b-574e60aa967a`) were removed through UUID-scoped teardown after reading their written blast-radius records; both reported `Owned teardown verified.` The separate disposable PostgreSQL cluster at `/tmp/telesphoros-inbox-pg` was stopped with its own `pg_ctl`. No foreign service or shared database was removed. Local logs are `/tmp/telesphoros-investor-tools/inbox-*.log`. No public upload, PR or deployment was attempted.
