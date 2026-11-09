# Concurrent patient reads and deferred attachment roster
Date: 2026-11-09

The approved first frontend performance slice is based on main
`3c22c7561fcee17542c396ed2d197ccee90be8a7`. Identity and demographics already
started together; medications waited for both. All three now start together.
Identity must succeed before patient sections or write controls become visible.
Demographics and medications own their loading, errors and retries independently.
Changing patient resets the record owner and aborts old reads. Identity and
demographics replies naming a different patient are refused.

The mounted workspace conversation requests its attachment patient roster on
the first file selection. It retains that roster and its request across patient
navigation, attachment Undo and upload recovery. New chat still retires the old
conversation. The first attachment now pays the roster-read latency; an unused
composer or hidden conversation pays none. Authorization, authenticated
`no-store` caching, static-asset caching, upload cancellation, clinical decisions,
database queries, dependencies and CI configuration are unchanged.

## Matched local measurements

The opt-in [measurement procedure](../../apps/frontend/performance/README.md)
uses built code, the real API, fresh disposable PostgreSQL databases with an
application role and tenant memberships, the test identity provider and Moto.
Each synthetic patient has complete demographics and 20 active medications.
Node 22.22.0, Chromium 154.0.8037.57 and the same host were used for both runs,
with no other tests running. There are five samples per cell. The first visit is
after sign-in in a fresh browser context; a return visit uses browser history.
`readyMs` starts with the first patient read and ends when identity, demographics
and all 20 medications are visible. It excludes initial sign-in/page loading.

| Added CDP latency | Visit | Before median (range), ms | After median (range), ms |
| --- | --- | --- | --- |
| 0 ms | First | 107.6 (82.7–117.6) | 100.7 (93.7–116.5) |
| 0 ms | Return | 66.7 (53.9–85.4) | 70.1 (53.5–76.7) |
| 120 ms | First | 296.9 (293.8–303.6) | 216.0 (212.0–237.9) |
| 120 ms | Return | 290.3 (285.1–304.5) | 208.4 (206.6–222.5) |

At 120 ms added latency the median decreased about 27–28%. Without added latency,
the small samples overlap and the return median increased slightly. The median
spread between the three request starts fell from 153.2/133.4 ms to 0.0/0.1 ms
for first/return visits at 120 ms latency. Every first visit changed from one
unused roster request to zero. Direct warm API medians (five unthrottled reads
each) were identity 9.0 → 10.0 ms, demographics 12.1 → 11.5 ms and medications
10.2 → 11.4 ms; every measured response remained `private, no-store`. These are
small synthetic scheduling samples, not production, p95 or capacity evidence.

## Regression evidence

With only the initial regression tests applied to unchanged main, five tests
failed for the expected waterfall, coupled error state, stale navigation error
and eager roster behavior; seven controls passed. The final 15 cases also cover
401 session loss, wrong-patient replies, 403/404 identity refusal, late response
bodies and pending roster ownership. The focused patient, medication, workspace,
upload-lifecycle and authentication run passed 131 tests. Removing the new
identity visibility and response-patient checks caused four negative controls to
fail; the production guards were restored. These tests hold synthetic HTTP
responses at the boundary while using real frontend routing, auth, readers and
upload/recovery state. Real-service browser and workspace checks supplement them.

The initial structure check rejected two components in `PatientPage.tsx`; the
record component was moved to its own file and the unchanged check then passed.

| Check | Local result |
| --- | --- |
| Workspace typecheck, lint and build | Passed |
| Bundle and structure guards | Passed; entry 109.9 kB gzip against 150 kB budget, 14 lazy page chunks |
| Workspace tests with PostgreSQL 16 and Moto available | 5,841 passed; 763 backend profile-dependent cases skipped |
| Frontend subset of that workspace run | 993 Vitest tests and 55 brand/preview checks passed |
| Infrastructure guards | 456 passed |
| CI configuration guards | 237 passed |
| Engineering workflow guards | 5 passed |
| Status-fragment guards | 12 passed |
| Workspace/upload/report browser flows, mobile and desktop | 90 passed; 2 viewport-specific controls skipped |
| Real PostgreSQL patient/medication/workflow browser flows, mobile and desktop | 20 passed |

The workspace run uses the default memory API profile with the real PostgreSQL
and S3 service specs enabled. Its backend portion passed 3,591 tests; the 763
skips depend on other profiles or opt-in workflows. Five private reader-engine
specs were excluded because the engine is absent; these are not passes. The
standalone PostgreSQL/memory-object and PostgreSQL/S3 API profiles were not run
for this frontend slice. Native checks ran in the supported execution context
with SWC integrity checks intact.

Browser coverage includes authorization, patient creation, demographics history,
medication corrections/stops/conflicts, lost responses, upload cancellation and
recovery, patient merge/unmerge history, accessibility, and 20-medication lists
with expanded forms. Representative light/dark screenshots at mobile and desktop
widths were also inspected. The two browser skips select the navigation control
for the other viewport. One patient-suite invocation used the wrong CLI argument
order and ran no tests; the corrected invocation passed all 20. No test or
assertion was weakened. Unselected browser suites, hosted CI, production
capacity, actual cloud identity/storage and clinical acceptance are outside this
local evidence. No database changes, push, pull request, merge or deployment
were performed for this slice.
