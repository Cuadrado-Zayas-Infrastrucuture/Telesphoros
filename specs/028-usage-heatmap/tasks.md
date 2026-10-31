# Tasks: Usage calendar

Spec amendment A1 (plan.md) was approved on 2026-10-31 and is part of spec.md D6.

## Backend PR (`feat/usage-days-api`)

- [ ] T001 `usageDaysQuerySchema` and `usageDaysDtoSchema` in shared-types (D6 with A1, USC-4)
- [ ] T002 `usageYear` and `puertoRicoDate` in Puerto Rico time, with unit tests (D4, USC-2)
- [ ] T003 `UsageRepository.uploadsByDay` and `createdAt`: in-memory and PostgreSQL (D1, D5, USC-1, USC-3, USC-5)
- [ ] T004 `GET /usage/days`, admin only, 400 for a year outside the range (D2, D5)
- [ ] T005 PostgreSQL spec and e2e on all tiers; deliberate breaks
- [ ] T006 `EXPLAIN (ANALYZE)` on 100,000 seeded reports; add the index migration only if the query takes more than 100 ms
- [ ] T007 Full local loop and gitleaks

## Page PR (`feat/usage-calendar`), after the backend PR merges

- [ ] T008 `loadUsageDays`, with 404 as unavailable (USC-4)
- [ ] T009 `usageCalendar` layout, shades and monthly totals, with unit tests (D7, D8, D9)
- [ ] T010 Shade and "not counted" tokens for both themes (D8, USC-6)
- [ ] T011 `UsageCalendar`: picker, grid, key, table, and its own states (D3, D4, D9, scenario 7)
- [ ] T012 Place it in `UsageReportView` below the monthly blocks; component and axe tests
- [ ] T013 Playwright; `check:chunks` and `check:brand`; light and dark screenshots at desktop and phone widths (USC-6, USC-7)
- [ ] T014 Full local loop and gitleaks
