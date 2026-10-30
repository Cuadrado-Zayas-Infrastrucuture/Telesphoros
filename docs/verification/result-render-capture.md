# Verification: result render capture (spec 019, D02b)

Date: 2026-10-29. Branch `feat/result-render-capture` off `main` `88a524e` (D02a merged). Local only, not pushed. Plan: spec 019 `plan.md` and `tasks.md`, D02b section, with R1 to R3 accepted by the founder on 2026-10-29 and R4 found in build review.

**What was claimed:**
- `POST /api/v1/result-renders`: a strict batch of at most 50 events, for the clinical read roles.
- A new append-only table `result_render_events` (migration 0061), **not** ledgered, FORCE RLS.
- One `exposure` row per episode under `render-v1`, then `duration` rows. Two paths, `viewport` and `focus`, each needing one continuous second in a visible tab.
- All or nothing on tenancy (404). Idempotent retries. A duration without its exposure is skipped and counted (R4).
- The hook `useResultRender`, a send queue (`fetch` with `keepalive`, no `sendBeacon`), and a summary region on the e2e test-only page.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster), Moto on its own port, the Playwright Chromium build. The report-reader engine is absent, as in every public checkout.

## Tests (synthetic fixtures; the oracle is the database, read as the administrator, or the database's own refusal)

- `apps/backend/test/result-renders.e2e-spec.ts`: **11**, over HTTP.
  - Tenancy: one foreign result in a batch answers 404 and stores nothing.
  - Roles: admin 403. A role dropped from the live membership is refused although the token still claims it.
  - Idempotency: retried and concurrent batches each store an event once.
  - R4: a lost exposure does not take another result's exposure down with it.
  - Strict schema: a content field, an extra field, an oversized batch and an exposure under one second are each 400.
  - The answer is three counts and nothing else.
- `apps/backend/test/db/result-render-events.pg-spec.ts`: direct SQL as the application role.
  - The composite keys.
  - The trigger's actor binding and live-role check (`RR001`), and its exposure check (`RR002`, on another path too).
  - The CHECKs, append-only (UPDATE, DELETE and TRUNCATE), RLS, and the repository paths.
- `down-guards-as-migrator.pg-spec.ts`: a populated table is refused by the down migration **as the non-superuser migrator**.
- `ledger-catalog.pg-spec.ts`: the new class `RENDER_EVENT_TABLES`. It checks forced RLS, SELECT and INSERT only, one tenant policy, and the three triggers, and that the table is in no ledger class.
- `packages/shared-types/src/result-renders.test.ts`: **36** schema cases.
- `apps/frontend/src/hooks/useResultRender.test.tsx` and `ResultAcknowledgementsTestPage.test.tsx`, with fake timers:
  - under one second sends nothing, and one second gives one exposure;
  - a hidden tab or a reset gives none;
  - focus is its own path;
  - the keepalive flush on page hide.
- `apps/frontend/e2e/result-renders.spec.ts`: **3 tests on 2 projects**, API routed (R3).
  - In view for one second sends exactly one exposure; less sends none; a hidden tab sends none.
  - The hidden-tab case sets `document.visibilityState` and fires a real `visibilitychange`: headless Chromium never reports a hidden page. The viewport, IntersectionObserver and timers are the browser's own.
- Inventories updated:
  - schema acceptance;
  - tenant binding: policies 57 to 58;
  - tenant capability;
  - down guards;
  - the gate route list;
  - the controller count: 22 to 23.
- **Compat label `breaking`:** the lint matches the keyword TRUNCATE, which the required TRUNCATE refusal contains. In effect the migration only adds a table, and the header says so.

## Mutation checks (scratch edit, run, then restored and sha256-matched)

| Mutation | Result |
| --- | --- |
| Hook threshold 1000 to 0 ms | caught: "under one second sends nothing" (and 6 more) |
| Visibility condition dropped | caught: "a hidden tab sends nothing", and the keepalive test |
| Route roles plus `admin` | caught: admin on an unknown result expected 403, got 404 |
| Trigger role filter removed | caught: `RR001` expected, the table's role CHECK answered instead |
| Tenant "not found" check removed | caught: 404 expected, server error; repository error type |
| `ON CONFLICT DO NOTHING` removed | caught (rerun independently by the parent session): the retried and concurrent batch tests, `:126` and `:137` |
| Unique key dropped | caught: a retried batch stored twice |
| R4 reverted (an orphan duration refuses the batch) | caught (parent session): `:153` expected 200 |

## Full local loop (`88a524e` plus this change; every local step of the CI `verify` job, listed from `.github/workflows/ci.yml`)

| Step | Result |
| --- | --- |
| typecheck, build, `pnpm test` (workspace), `test:demo-seed`, `check:chunks`, `knowledge:verify --production`, shared-types build, `test:infra`, `check:workflows` | pass |
| lint | failed once on Prettier in two edited test files; formatted, then pass (and those two specs rerun: 41 / 41) |
| `test:ci-config` | 207 / 207 |
| `check-without-reader.sh --measure --listed` | pass |
| `test:fixture-lifecycle` | 9 pass, 2 fail (tests 6 and 8): the same two fail on unchanged `main` on this machine; cause unproven, not caused by this change |
| worker | 241 / 241 |
| frontend | 539 / 539 |
| backend default / PostgreSQL / PostgreSQL+S3 | 3193 / 3611 / 3631 passed, 0 failed (of 3632) |
| Playwright `e2e` | 161 passed and 3 skipped, 38 passed, 2 passed |
| Playwright `e2e:storage` | 33 passed |
| gitleaks over the changed directories | no leaks |
| FHIR IG validation (`smart-pilot test:ig`) | not run: no Java 21 here; this change does not touch the SMART pilot |

## Not covered

- **The threshold and visibility mutations were checked against the unit tests only**, not against Playwright.
- **A real hidden tab** in a headed browser; headless Chromium cannot produce one.
- **Retention** (counsel question 10), **coverage and lag reports**, and **comprehension** are open items in `tasks.md`.
