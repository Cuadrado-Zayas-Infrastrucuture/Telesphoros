# Tasks: spec 019, slice D02a (acknowledgements); D02b follows

**Authorized:** D02a, then D02b (founder, 2026-10-29, P2 to P7 accepted as recommended). D02b tasks are written once D02a merges.

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
