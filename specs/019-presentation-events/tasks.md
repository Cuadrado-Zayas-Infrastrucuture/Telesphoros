# Tasks: spec 019, slices D02a (acknowledgements) and D02b (render capture)

**Authorized:** D02a, then D02b (founder, 2026-10-29, P2 to P7 accepted as recommended). D02a merged as PR #176 (`88a524e`). The D02b tasks are at the end; the founder accepted R1 to R3 on 2026-10-29.

Derived from [plan.md](plan.md). D02a copies spec 006 D01b (`clinician_result_decisions`, migration 0055) wherever the two agree, and differs only where P5a and P5b require it.

## Slice decisions (within the approved plan)

| # | Decision | Why |
| --- | --- | --- |
| A1 | A **sibling** `GET /evaluation-results/:id/acknowledgements`. The D01b decision history is not changed. | Founder, 2026-10-29: keeps spec 006's tested API as it is. |
| A2 | The result **version** is the result row itself: evaluation results are immutable, so a correction or re-evaluation creates new rows. The **basis version** is the D01b basis (`active`, `retracted`, `superseded`, `quarantined`, `disputed`, `not-current`), computed by the same SQL and stored with the acknowledgement. | P5a. It reuses `BASIS_SQL` instead of a second definition. |
| A3 | `kind` is `review` or `retraction-reviewed`. `review` is refused when the basis includes `retracted`; `retraction-reviewed` is accepted only when it does. | P5a |
| A4 | The client sends the basis it displayed. If the server's basis differs at commit, the answer is **409** `acknowledgement-basis-changed`, checked after the ledger append, as D01b does. | P5a, and the D01b ordering guarantee |
| A5 | Uniqueness: `(tenant, created_by, result_id, review_task, kind)`. `review_task` is a closed vocabulary, with `result-review` the only value in v1. A replay with the same request id and hash returns the stored row (200). A new request for an existing key answers 409 `already-acknowledged`. | P5b; no duplicate review and no false success |
| A6 | Clinician-only to write (and re-checked against the live membership in the trigger). Reading is for `CLINICAL_READ_ROLES`, as D01b's GET is. P6's care-relationship rule needs a care-team model that does not exist yet; it is recorded as an open item, not approximated. | P6 |

## D02a tasks

| # | Task | Requirement | Done when |
| --- | --- | --- | --- |
| T001 | Branch `feat/result-acknowledgements` off a freshly fetched `main`. Read the next free migration number from `main`, the open PRs and other sessions' branches. | P7 | Branch tip equals `origin/main`; number recorded |
| T002 | Migration `result_acknowledgements` (`-- compat: breaking`), shaped like 0055: composite FKs to the result, evaluation and patient; the A5 unique key; `kind` and `review_task` CHECKs; the stored basis; request id and hash; a BEFORE INSERT trigger binding tenant and actor and requiring a live clinician membership; refusal of mutation; ENABLE and FORCE RLS with the same three policies and grants; and a new ledger event type `result-acknowledgement`. The ledger CHECKs and `ledger_event_row_exists()` restate the **current** set from the newest migration that restated it, not 0021's or 0055's. The down migration refuses a populated table, using the NO FORCE / FORCE pattern, and restates the prior set. | P3, P5a, P5b | PostgreSQL tier: constraints, append-only, RLS, ledger verify, down guard as the migrator |
| T003 | Register the table: `EVENT_TYPE_FOR_TABLE`, a projection loader, the `record` class in `append-only-tables.ts`, and the brittle inventories (schema acceptance, tenant-binding policy count, tenant-capability regex, down-guards, gate route list, controller count) | P3 | Typecheck and every inventory test green |
| T004 | Shared types: request and response schemas (`resultId`, `kind`, `reviewTask`, `displayedBasis`, `requestId`) and the error reasons | A3 to A5 | Schema tests refuse each malformed field |
| T005 | Repository and service: replay before any check; result binding; insert; ledger append; the basis comparison (A4) last, in a fresh statement. Errors map to 404, 403, 409 (`acknowledgement-basis-changed`, `already-acknowledged`, `request-id-reused`) and 400. | P4, P5a | Unit and PostgreSQL tests per path |
| T006 | Controller: `POST /evaluation-results/:id/acknowledgements` (clinician, 201 new, 200 replay) and `GET` (A1, A6), returning each acknowledgement with its stored basis and the current basis, so a review made before a retraction reads as historical | A1, A6, P5a | e2e: tenancy 404, reader and reviewer 403 on POST, replay, attribution |
| T007 | Frontend `ReviewedControl({ resultId })`. Its states: `Review` (or `Retraction reviewed` on a retracted basis), sending, `Reviewed` with who and when, refused on 409 with a refresh, and failed. It shows success only after the server's 201 or 200 (P4). | P4, P5a | Component tests for every state; axe clean |
| T008 | A test-only page mounted only in the e2e build, listing synthetic fixture results by id with no clinical text, each with a `ReviewedControl` | P1 | The production build has no route to it (build check) |
| T009 | The five verification scenarios from the plan, on synthetic fixtures: two clinicians and two versions; a retraction while open (409, then only `Retraction reviewed`); a patient change invalidates pending actions; duplicate delivery and network loss; a cross-tenant or sponsor user | Plan, Verification scenarios | One test each |
| T010 | Mutations: drop the basis comparison, drop the clinician role check, drop the A5 unique key; each must fail its test | V | Each mutation fails, and the log shows the expected assertion |
| T011 | Full local loop (typecheck, lint, test, build, test:infra, test:ci-config, backend default / PostgreSQL / PostgreSQL+S3, both Playwright suites) and gitleaks | V | Counts recorded; skips listed |
| T012 | `docs/verification/result-acknowledgements.md`, one status fragment, and updates to `docs/database.md`, `docs/auth.md` and `docs/design/records-and-corrections.md` | V | `pnpm test:ci-config` green |

## Open items (not built in D02a)

- **P6 care relationship:** no care-team or relationship model exists. Until one does, the review summary follows `CLINICAL_READ_ROLES`, tenant-scoped, which is what D01b does.
- **Materiality (P5b):** the clinical owner defines which changes create a new review obligation. In v1 a new result row (a new evaluation) is the only trigger.

## Not touched

The clinical result view, the engine, evaluations, the meaning of spec 006 decisions and their API, the SMART pilot, `security_audit_events`, Terraform and CI configuration.

## D02b: render capture

### Slice decisions (founder, 2026-10-29)

| # | Decision | Why |
| --- | --- | --- |
| R1 | One `exposure` row per episode, written when `render-v1` is met, then append-only `duration` rows (`seq` >= 1) with continuous and cumulative visible milliseconds. No row is ever updated. | P2 (durations for the 1, 2 and 3 second comparison), P3 (append-only), P4 (first exposure promptly, durations batched) |
| R2 | Two measurement paths: `viewport` (at least 50% of the summary region in view, in a visible tab) and `focus` (keyboard or assistive-technology focus inside the region, in a visible tab). Each needs 1 continuous second and is recorded with its path. | P2, the assistive-technology path |
| R3 | The browser test routes the API on the test-only page, so viewport, visibility and focus are measured by a real browser. The server is proven by the jest API and database tests. | No evaluations exist in the e2e backend |
| R4 | Found in build review: a `duration` whose `exposure` is not stored is **skipped and counted** (`withoutExposure`), and the rest of its batch is stored. The trigger still refuses one that reaches the table. | One queue serves every row on the page: refusing the batch would drop other rows' exposures every 5 s while the orphaned episode lasts |

### Tasks

| # | Task | Requirement | Done when |
| --- | --- | --- | --- |
| T101 | Branch `feat/result-render-capture` off a freshly fetched `main`. The next free migration (0061) is checked on `main`, the open PRs and other sessions' branches. | P7 | Number recorded |
| T102 | Migration `result_render_events`: append-only (refuse UPDATE, DELETE and TRUNCATE), **not** ledgered, ENABLE and FORCE RLS, grants as the other record tables. Columns: episode id, `seq`, `kind` (`exposure` or `duration`), result, evaluation and patient (composite keys as 0060), viewer, the viewer's roles and membership version (copied by a trigger from the live membership, any clinical read role), `measurement` (`viewport` or `focus`), `rule_version` (`render-v1`), `schema_version`, `capability` (what the browser supported), client occurrence time, client send time, server receipt time, continuous and cumulative milliseconds. Unique on (tenant, viewer, episode, seq); seq 0 is the exposure. No content column. The down migration refuses a populated table, as 0060 does. | P2, P3, FR-02, FR-03, FR-06, FR-07 | PostgreSQL tier: constraints, append-only, RLS, down guard as the migrator |
| T103 | Shared types: a strict batch schema (at most 50 events, no extra fields) | FR-07, P4 | Schema tests refuse each malformed or extra field |
| T104 | `POST /api/v1/result-renders` for `CLINICAL_READ_ROLES`. All-or-nothing: any result outside the tenant is 404 and stores nothing. A stored (episode, seq) is skipped, so a retried batch stores nothing twice; the answer counts stored and already-stored events. A `duration` row needs its `exposure`. Clock uncertainty is the server receipt minus the client send time. | FR-02 to FR-04, FR-06, P4 | e2e: tenancy, roles, idempotent batches, order |
| T105 | Hook `useResultRender(resultId, regionRef)`. It uses `IntersectionObserver` (threshold 0.5) and `visibilitychange` for `viewport`, and `focusin` and `focusout` for `focus`. An episode is created after 1 continuous second; a change of patient, result or visibility ends it. The exposure is sent at once and durations in batches, using `fetch` with `keepalive` on page hide (no `sendBeacon`). Retries are bounded, and the buffer holds ids and times only. Failures are never shown to the clinician. | P2, P4 | Unit tests with fake timers: under 1 s gives nothing, 1 s gives one episode, a hidden tab or a reset gives none, focus is its own path |
| T106 | The test-only page gives each row a recommendation-summary region with synthetic ids only, and attaches the hook | FR-01 | Page test |
| T107 | Playwright (the main e2e suite, API routed, R3): a row in view for at least 1 second sends exactly one exposure; one in view for less sends none; a hidden tab sends none | P2, R3 | Spec green |
| T108 | Mutations: the threshold, the visibility condition, the role check, the tenant check, the idempotency key | V | Each fails its test at the expected assertion |
| T109 | Full local loop from the CI workflow's own step list, and gitleaks | V | Counts recorded; skips listed |
| T110 | `docs/verification/result-render-capture.md`, one status fragment, a `docs/database.md` row | V | `test:ci-config` green |

### Open items (not built in D02b)

- **Retention:** the period for render rows is set before any real data, with counsel (question 10).
- **Coverage and lag reporting** (P4: upload failures, ingestion lag, coverage) are later analytics. D02b stores what they need.
- **Comprehension** is validated separately with clinicians (P2); no render is evidence of it.
