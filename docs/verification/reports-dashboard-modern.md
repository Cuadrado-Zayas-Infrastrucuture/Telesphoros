# Modern reports dashboard verification

Verified locally on October 13, 2026. Branch `feat/reports-dashboard-modern`, based on current main `d7569aa7ac33aa3b37871a486f85ed72e0f12fc0`. The previous staged branding branch remains untouched. See the [approved plan](../design/plans/reports-dashboard-modern.md).

## Implemented behavior

Existing report records appear in a stable-height, 20-record list with independently paginated patient options. Filtering, refreshing or changing pages clears prior rows and selection immediately; canceled replies cannot restore them. A selected report shows human-readable metadata, with identifiers/timestamps in a native disclosure. Desktop shows list and detail together; mobile shows one at a time, and Back restores focus to the originating report. Pending pagination controls stay mounted and retain focus while refusing duplicate activation.

The screen reuses `ownedStorageApi.listReports` and `downloadReport`. The list helper adds an optional validated patient filter and checks page/count/patient agreement. It introduces no new endpoint or second transport. The existing attachment path still checks link origin/expiry and file size/SHA-256, omits storage credentials/referrer and revokes temporary blob URLs. Upload transfer/attempt/cancellation logic is unchanged.

Upload is visible to clinician/admin; verified downloads to clinician/reviewer/admin; reader has metadata only. Roles remain additive. Server authorization remains authoritative. `/reports` still requires the existing owned-storage opt-in, and its browser transport still refuses production/non-loopback use. DEV-only pages remain behind `import.meta.env.DEV` and outside production chunks. No review queue, capture action, clinical result or processing action was added.

Shared branding uses dark teal `#225560`, seafoam `#DCEBE7`, stone `#E8E7E2` and off-white `#F5F6F7`. Poppins is locally bundled for headings; the system font remains for operational text. The full company name and square/genome symbol identify Cuadrado Zayas Infrastructure, while Telesphoros remains the product wordmark. Status is expressed as words, without badges or pills. Fifteen checked text/control token pairs meet their 4.5:1 text or 3:1 control threshold; automated browser checks found no WCAG 2.0/2.1 A/AA violations in the exercised views.

## Checks

| Check | Evidence |
| --- | --- |
| Frontend units | 222 passed across 19 files, including additive roles, stale-response refusal, safe read/download failures, duplicate-download prevention, native disclosure, focus return and owned-route registration. |
| Workspace regression | 1,729 passed: 22 build/operations guards, 9 notifier, 36 CPIC schema, 22 shared types, 7 fake IdP, 222 frontend, 186 SMART pilot and 1,225 backend. Backend explicitly skipped 201 service-dependent tests across nine suites with external database settings unset. |
| Workspace build/typecheck/lint | Passed; final frontend typecheck/lint also passed after browser-test adjustments. |
| Production chunk/foundation guards | Passed; entry gzip 146.2 KiB against 150 KiB budget, eight lazy page chunks, 45 component modules. DEV screens excluded. |
| Owned storage browser acceptance | 24 passed: 12 cases at 375px and 1280px, using actual API, fresh PostgreSQL 16 restricted `storage_app` role, fake IdP and versioned Moto 5.2.3. |
| Standard browser regression | Final 56 passed under the existing five-worker configuration, including real HTTP VCF/JSON transfers, credential/referrer isolation, route/role restrictions, keyboard controls, minimum touch targets and accessibility. |
| DEV browser regression | 18 passed at both viewport sizes, covering the existing local upload/review/operations flows. |
| Visual review | Inspected actual desktop/mobile list and verified-file detail views; no page-level horizontal overflow at 375px or 200% text in the exercised dashboard states. |
| Diff whitespace | `git diff --check` passed. |

The owned test run was `9fd66fae-7287-4c88-b07c-76dabca5f04c`. PDF, VCF and JSON downloads matched uploaded bytes; file GETs included a pinned version and no application authorization, cookie or referrer. Reader file-link requests were refused and foreign-tenant records were unavailable. Reviewer downloaded but could not upload. Capture returned 503 with clinical processing disabled. Recovery/cancel/malformed-file controls retained their existing assertions. The runner's written blast-radius check and PID/start receipts confined teardown to this generated disposable stack; its removed tombstone survives. No live AWS or shared database was contacted.

The actual [desktop detail view](../design/previews/reports-dashboard-modern-desktop.jpg) and [mobile detail view](../design/previews/reports-dashboard-modern-mobile.jpg) are included for PR review. List screenshots and computed contrast results are exported with the original workstation delivery under `outputs/telesphoros-modern-implementation` alongside its original-base binary patch. They contain generated synthetic records only. Browser screenshot UUIDs are fixture labels, not real patient identities.

## Failures, repairs and limits

The first frontend unit run found duplicate exact “Sign in” links after adding the overview CTA. The CTA became “Sign in to continue”; the next unit run passed all 222 tests.

The first owned-stack setup failed readiness because the explicit shell PATH omitted macOS `/usr/sbin`, which contains `lsof`. Its generated run was removed by the runner. Including the normal system tool directories let a fresh owned run reach readiness; application/runner source was not changed.

The first standard browser run passed 54 tests but timed out in the two existing helix-image checks. The error snapshot still contained the illustration, and built output had its expected 1440×810 dimensions. Both tests passed in isolation unchanged; the full same-concurrency rerun passed all 56 in 13.9 seconds. The timeout's cause remains unresolved; no assertion or product behavior was weakened to mask it. The DEV regression passed separately afterward. Existing Vite bundle-size notices and DEV React hydration warnings were non-failing; the repo's actual gzip guard passed.

These checks are local synthetic evidence, not hosted-service, production, clinical, HIPAA or complete accessibility certification. Backend/schema/infra were not changed. The operations browser configuration intentionally excludes the separate version-pin admission scenario; the pinned-version download assertions in the exercised intake cases passed. Full backend PostgreSQL/S3 regression tiers and remote CI are not claimed by this UI slice.

## Draft PR preparation on current main

The founder requested draft PR delivery on October 13, 2026. The implementation was rebased onto `aec4bbf`, which includes the separately merged migration-readiness fix and planning documents. The only conflict was adjacent STATUS entries; both the dashboard entry and incoming main entries were retained. A source comparison against the original dashboard commit showed no frontend or SMART UI changes from the rebase. The PR diff has no backend, infrastructure, authentication-policy or route-registration edits.

After rebasing, workspace build, typecheck and lint passed; production chunk/foundation guards again passed at 146.2 KiB gzip with eight lazy pages and 45 component modules. Workspace regression again passed 1,729 tests, explicitly skipping the same 201 backend service tests. A fresh restricted-role PostgreSQL 16/versioned Moto 5.2.3 owned stack reached readiness and passed all 24 storage/dashboard browser tests in 23.5 seconds. Its run `a5aaa86b-e429-419d-8e8b-587a6ff1a0a8` was removed by the owned runner after its written blast-radius check. The 56 standard and 18 DEV browser results above remain evidence from before the rebase; no changed dashboard source invalidates them, but they are not presented as reruns on this updated base. Remote CI is a separate PR acceptance gate.
