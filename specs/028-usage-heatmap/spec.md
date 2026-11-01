# Feature Specification: Usage calendar (USC)

**Feature Branch**: `docs/spec-028-usage-heatmap` (this spec); the build is two PRs, backend first, then the page

**Created**: 2026-10-31

**Status**: Approved 2026-10-31. The founder chose D1 to D4 from the options offered: reports uploaded, a new route, a plain grid with no
chart library, and a calendar year with a year picker. D5 to D9 were proposed with them and approved as written ("Approve D5–D9"). Amendment A1 (plan.md), approved the same day ("Approve A1"),
replaced D6's `firstYear` with `firstDate` and `today`, so the page can draw D7 without working out dates itself. Amendment A2, approved while
building the page, replaced D9's single image with a keyboard grid and hides the year picker when there is only one year.

**Input**: The founder wanted a calendar heatmap on the Usage page, like the evilcharts heatmap. `GET /usage` (spec 010) returns only this
month so far and last month, so there is nothing per day to draw.

This spec replaces spec 011's D3 ("plain numbers… no chart") for the new section only. The two monthly blocks and storage stay as spec 011
built them.

## Decisions

- **D1, what a cell counts (chosen):** reports uploaded that day, with the same meaning as spec 010 D3: reports whose upload completed
  (`uploaded_at`) that day, including reports deleted since. Evaluations are not drawn.
- **D2, route (chosen):** a new route, `GET /api/v1/usage/days?year=YYYY`, for `admin` only, for the caller's own organization. `GET /usage`
  and `usageDtoSchema` do not change. That schema is a strict object, so a new field in its reply would make a page still running the old
  code reject the whole reply as broken.
- **D3, drawing (chosen):** a plain grid built from the design tokens, with no chart library. It adds no dependency and the Usage chunk grows
  only by its own code.
- **D4, period (chosen):** one calendar year in Puerto Rico time (1 January to 31 December, 365 or 366 days), with a year picker. With no
  `year`, the route answers the current Puerto Rico year.
- **D5, which years (approved):** from the Puerto Rico year of the organization's `tenants.created_at` to the current Puerto Rico year. The
  reply carries both ends (D6), so the picker needs no second request. Any other year, or a value that is not a four-digit year, gets 400.
- **D6, reply shape (approved):** `{ timeZone, year, firstDate, today, days: [{ date: 'YYYY-MM-DD', reportsUploaded }] }` (A1).
  `firstDate` is the day the organization was created and `today` is today, both Puerto Rico dates as `YYYY-MM-DD`. Only days with at least
  one upload are listed, oldest first; a day that is not listed had none. It is parsed against a new strict `usageDaysDtoSchema` in shared-types.
- **D7, days that cannot have counts (approved):** days after `today`, and days before `firstDate`, are drawn as "not counted",
  in a style distinct from zero, so an empty future does not read as a quiet month.
- **D8, shading (approved):** zero, then four steps that split 1 up to the year's busiest day evenly. A small organization still sees a range
  of shades. The colors come from the existing tokens in both themes, with a "Fewer / More" key. The palette stays neutral, like the rest of the
  page, so no shade reads as a warning.
- **D9, accessible version (approved, amended by A2):** the grid follows the ARIA grid pattern (`role="grid"`), labeled with the year's total
  and its busiest day. It is one tab stop; the arrow keys move a day up or down and a week across, and every day is named, such as "Thursday,
  14 May 2026: 9 reports uploaded". A line below it repeats the day being pointed at or focused. Below that, a visible table lists each
  month's uploads for the chosen year. A2 replaced a single `role="img"`: a focusable image is not a valid widget, and the grid lets a
  keyboard or screen reader user reach each day's count, so no information is only available by hovering.

## Out of scope

- Evaluations, held results or storage over time.
- A breakdown per person, export, billing, quotas and limits.
- Any other chart, and any chart library (D3).
- Changing `GET /usage` or the monthly blocks.

## User Scenarios & Testing

1. **An administrator reads this year (P1).** **Acceptance:** each day with uploads is shaded by its count, and the month table matches the
   sum of those days. Days after today read "not counted".
2. **An earlier year (P1).** **Acceptance:** the picker offers every year from the organization's first year to this one, and choosing one
   loads that year. A leap year shows 366 days. An organization whose first year is this year sees no picker (A2).
3. **Another organization's activity (P1).** **Acceptance:** it never appears in the counts.
4. **A non-administrator (P1).** **Acceptance:** a reader, clinician, reviewer or member with no role gets 403; an anonymous request gets 401.
   The page shows no calendar to them, as spec 011 D1 already hides the whole page.
5. **Day edges (P2).** **Acceptance:** an upload at 03:59 UTC counts on the previous Puerto Rico day, and one at 04:00 UTC on the new day.
   An upload at 03:59 UTC on 1 January counts in the previous year.
6. **A year outside the range (P2).** **Acceptance:** `year=` one before the first year, one after the current year, or a value like `20x6`
   gets 400.
7. **An older API (P2).** **Acceptance:** if `/usage/days` answers 404, the calendar section reads "Not available on this server yet" and the
   monthly blocks and storage still show. If the calendar fails to load, its own alert offers Retry and the rest of the page stays as it is.

## Requirements

- **USC-1** Every query is parameterized and filtered by the caller's tenant id. On PostgreSQL it runs through the application role under
  row-level security, as spec 010 USE-1 does.
- **USC-2** Days are grouped in `America/Puerto_Rico` on the server, so the page does no time zone conversion, as with spec 010's months.
- **USC-3** Counts only: no patient, report, person or file names, and no ids.
- **USC-4** The reply is `Cache-Control: private, no-store`, like every authenticated response, and the page parses it with
  `usageDaysDtoSchema`.
- **USC-5** The in-memory store answers the route too, from its report rows, so every test tier can run it.
- **USC-6** Brand rules hold in both themes: tokens only, status as words, 44 px targets for the picker, and no axe violations (spec 011 USP-1).
- **USC-7** The Usage page stays a separate lazy chunk, and `check:chunks` keeps passing.

## Open questions

- Whether `reports` has an index that serves `tenant_id` with an `uploaded_at` range for a whole year. The plan checks it with `EXPLAIN` on a
  seeded database before choosing whether a migration is needed. Not checked yet.
