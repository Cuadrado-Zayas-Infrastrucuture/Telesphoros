# Plan: Usage calendar

Two pull requests, each off `main`: the backend and shared types first, then the page. The page PR waits for the backend one to merge.

## Spec amendment A1 (approved 2026-10-31, folded into spec.md D5 to D7)

D7 draws days after today, and days before the organization was created, as "not counted". The D6 reply cannot support that:

- **Today:** the page would have to work out today's date in Puerto Rico from the browser clock, which is the time zone conversion that USC-2
  keeps on the server.
- **Creation day:** `firstYear` names only the year, so in that first year the page cannot tell which days came before the organization
  existed.

A1 replaces `firstYear` with two dates, both in Puerto Rico time as `YYYY-MM-DD`: `firstDate` (the day the organization was created) and
`today`. The reply becomes `{ timeZone, year, firstDate, today, days }`. The picker takes its years from `firstDate` through `today`, so D5
holds unchanged. This adds one more date about the caller's own organization; it still carries no ids or names, so USC-3 holds.

## Backend PR (`feat/usage-days-api`)

| Area | Change |
| --- | --- |
| `packages/shared-types/src/usage.ts` | `usageDaysQuerySchema` (`year`: optional, exactly four digits) and a strict `usageDaysDtoSchema` (D6 with A1). `usageDtoSchema` does not change (D2). |
| `src/usage/usage-months.ts` | `usageYear(year)`: the `[from, to)` window from 1 January 04:00 UTC to the next 1 January 04:00 UTC. `puertoRicoDate(instant)`: `YYYY-MM-DD`. Both use the existing fixed offset, so it stays the one place to change. |
| `src/storage/usage.repository.ts` | Two new methods. `uploadsByDay(tenantId, from, to)`: days with at least one upload, oldest first. `createdAt(tenantId)`: when the organization was created. |
| `src/storage/postgres/usage.repository.ts` | `uploadsByDay`: one parameterized `GROUP BY` on the upload instant shifted by the offset (passed as a parameter, not a time zone name), in `withTenant` and also filtered by `tenant_id`. `createdAt`: `tenants.created_at` for the caller's own row, which the `tenants_own` policy already allows the application role to read. |
| In-memory `UsageRepository` | `uploadsByDay` from the report rows, as `activity` does. The in-memory store keeps no creation date for an organization (`TenantRecord` has none), so `createdAt` returns the earliest upload, or now if there is none. That difference applies only to the in-memory tier and is noted in the code. |
| `src/usage/usage.controller.ts` | `GET /usage/days`, `@Roles('admin')`, with a `ZodValidationPipe` on the query. No `year` means the current Puerto Rico year. A year before `firstDate`'s or after `today`'s gets 400 (D5). |

No migration is planned. `reports` has no index on `tenant_id` with `uploaded_at`, and the existing `/usage` month queries run without one.
Before the PR opens, `EXPLAIN (ANALYZE)` runs on a seeded local database (100,000 reports across 10 organizations). If the year query takes
more than 100 ms there, the PR adds an index migration on `reports (tenant_id, uploaded_at)`, taking the next migration number from the
directory at build time. Either way, the plan and timing go in the PR body. The 100 ms threshold is a proposal.

### Verification

- Unit tests:
  - `usageYear` for a normal year, a leap year (366 days) and the 04:00 UTC edges.
  - `puertoRicoDate` at 03:59 and 04:00 UTC, and at 03:59 UTC on 1 January, which falls in the previous year.
- PostgreSQL (`usage.pg-spec.ts`), through the application role:
  - Uploads are grouped by Puerto Rico day, at the same 03:59 and 04:00 UTC edges.
  - A deleted report still counts on its upload day.
  - A report that was never uploaded counts nowhere.
  - Days with no uploads are not listed.
  - Another organization's rows never count.
  - `createdAt` reads the caller's own organization.
- e2e on all three tiers:
  - An admin gets 200 and a reply that parses.
  - Every other role, and no role, gets 403; an anonymous request gets 401.
  - The reply is `no-store`.
  - `year` one before the first year, one after this year, or `20x6` gets 400.
  - No `year` answers the current year.
  - Two organizations see only their own uploads.
- Deliberate breaks, each expected to fail at least one test:
  - Dropping the offset from the grouping.
  - Widening the window end to `<=`.
  - Dropping the explicit tenant filter while reading as a superuser.
  - Accepting a year after this one.
- The full local loop (every CI tier) and gitleaks, before the PR opens.

## Page PR (`feat/usage-calendar`)

| Area | Change |
| --- | --- |
| `src/lib/usageDays.ts` | `loadUsageDays(apiFetch, year, signal)`, which parses the reply with `usageDaysDtoSchema`. A 404 means "unavailable", as in `loadUsage`. Imports `ApiFetch` as a type only, so the upload code stays out of this chunk. |
| `src/lib/usageCalendar.ts` | Pure layout. Weeks are columns, from Sunday to Saturday. Each cell is one of: counted (shade 1 to 4), zero, or not counted (D7). A day's shade is `ceil(4 × count ÷ busiest)` (D8). It also builds the monthly totals for the table (D9). |
| `src/components/usage/UsageCalendar*.tsx` | One component per file (the frontend's foundation rule). `UsageCalendar`: the section and the year picker (a native `select`, 44 px, hidden when there is only one year). `UsageCalendarLoader`: one year's request, with its own skeleton (`UsageCalendarSkeleton`), failure alert with Retry, and "Not available on this server yet" (scenario 7). `UsageCalendarYear`: the summary, the keyboard grid (D9 as amended by A2), the readout line, the "Fewer / More" key, and the monthly table. |
| `UsageReportView.tsx` | Puts the calendar below the monthly blocks and storage, which stay as spec 011 built them. A failure in either part does not hide the other. |
| `src/styles/tokens.css` | Shade tokens for both themes: four steps from `--muted` to `--primary`, plus a "not counted" style (an outline, no fill). Tokens only (USC-6). |

On a phone the grid scrolls sideways inside its own box; the page itself never scrolls sideways.

### Verification

- Unit (Vitest), `usageCalendar`:
  - A year has 365 or 366 cells, and 1 January falls on its weekday.
  - Days after `today` and before `firstDate` are not counted.
  - Shades split as D8 says, including a year whose busiest day has 1 upload.
  - The monthly totals match the days.
- Component (Vitest + axe), in both themes: loading, ready, failed with a Retry that works, unavailable, a year change that loads only the
  calendar, and no axe violations.
- Playwright (`e2e/usage.spec.ts`): an admin sees the calendar and the table; a non-admin still gets no Usage page.
- `check:chunks` and `check:brand` pass, and the Usage page stays its own lazy chunk (USC-7).
- A screenshot in light and dark mode, at desktop and phone widths, checked by eye for the shading, the "not counted" days and sideways
  scrolling.
- The full local loop and gitleaks, before the PR opens.
