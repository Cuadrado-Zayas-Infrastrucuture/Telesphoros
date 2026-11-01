# Patient medications UI verification

Date: 2026-11-01. MD-b starts from merged MD-a, `main` at `3dacfb4` (PR #244).

## Behavior

The patient page reads the existing medication API separately from demographics. Active entries precede stopped entries, with source and optional month dates visible. Compact rows, active/stopped counts, and case-insensitive local filtering support a patient with 20 medications. One Details disclosure opens actions and history instead of repeating a large action card for every entry. Touch targets remain at least 44px.

Clinicians add, stop and correct a bundled coded ingredient; Stop keeps the ingredient fixed. Names use the shared FDA Tall Man helper with plain accessible names. The local type-ahead suggests up to six ingredient names after two letters, ranks prefix matches first, and supports arrow keys/Enter, Escape and touchscreen choice. Typing or changing search text does not retain a drug code: an explicit choice is required. No free-text drug, dose, route, frequency or clinical interpretation was added. The API boundary replaces failures with fixed messages; drugs and drafts are not written to URLs, titles, browser storage or diagnostics. A draft keeps the same request ID on retry, and a stale correction does not silently retry against a newer version. Earlier versions are read from the existing versioned API. A patient change hides the previous patient's content while the new read is pending.

## Verification and evidence

Eleven focused UI tests cover order/source/dates, Tall Man and accessible names, reader/reviewer permissions, retry identity, stop versions and history, rejected stale edits, invalid/free-text/reversed-month input, expanded-form accessibility, patient navigation isolation, explicit keyboard choice, and invalidation of a prior selection after further typing. API fetch doubles remain in these component tests; real API behavior is exercised by the browser tests.

Real browser tests use the existing storage-e2e configuration, a newly provisioned PostgreSQL 16 database with a non-owner application login and real migrations/RLS, the fake RS256 identity provider, Moto S3, and the production-built UI. They cover clinician capture and history, same-tenant reviewer reads, other-tenant refusal, admin/no-role route refusal, and a lost response after an actual committed write followed by an idempotent retry. Independent browser contexts produce a real stale-correction conflict. No backend response is mocked for these cases; the lost-response control only aborts the first response after forwarding the actual request.

The 20-entry fixture is constructed through the actual authenticated API, then verified through the UI: 16 active and four stopped, case-insensitive filtering, bounded collapsed row height and no horizontal overflow. Axe checks run in light and dark with no rules disabled. Finite color transitions finish before measurement; a transient mixed-theme frame had produced contrast findings in an initial run. Earlier test failures caused by hard navigation dropping the app's memory-only session and by reusing the fake issuer's SSO cookie were corrected in test navigation/context setup. Initial failed logs remain separate from passing runs.

Three deliberate defects were detected: granting clinical readers write controls, removing the Tall Man visual form, and generating a new request ID on retry. Each failed its relevant assertion; the original source was restored. There were no weakened assertions, adjusted clinical holds, timeout increases or branding-policy changes.

All six required repository commands passed during implementation: typecheck, lint, workspace test, build, infrastructure guards (215) and CI configuration guards (217). After the density revision, affected type/lint, frontend regression/branding tests, builds and chunk checks were rerun. Complete PostgreSQL/S3 backend profiles, FHIR, image rehearsal and the full unrelated browser suite were not rerun for this frontend slice. Five unavailable private-reader specs remain excluded as configured; service-dependent unit-run skips are not passes.

Local command logs are under `/workspace/recovery/md-b-*`. Initial implementation required-check results are `md-b-required-results.txt`. Final compact browser logs are `md-b-compact-browser-desktop2.log` and `md-b-compact-browser-mobile.log`. Screenshots at 390, 768 and 1280 pixels, light and dark, are under `/workspace/recovery/md-b-visual/medications-20-*`; expanded forms use `medications-*`. These local paths are session evidence, not hosted links. The six 20-entry previews were sent to the founder in chat before commit, per T504.

No merge, deployment, real patient data, clinical approval, live external terminology search, ISMP-only entries or model integration is included.

## Final local results

- Frontend regression: 62 test files / 679 tests passed, plus all 55 branding/preview script controls. Typecheck, lint, production builds and chunk/foundation checks passed after the type-ahead revision. An initial typecheck found unsupported component-test query options; those were corrected without changing assertions.
- Real medication browser flows: four passed across mobile and desktop after the type-ahead revision, including actual touchscreen selection and keyboard choice.
- Compact 20-entry fixtures: passed at desktop and mobile, including 390/768/1280 light/dark screenshots, row density, filter and reflow. Demographics regressions passed on both viewport projects during the slice; the mobile case also passed after the density revision.
- Predictor screenshots: `/workspace/recovery/md-b-visual/medication-picker-light.png` and `medication-picker-dark.png`; final medication logs: `md-b-predictor-browser.log` and `md-b-picker-preview.log`.
