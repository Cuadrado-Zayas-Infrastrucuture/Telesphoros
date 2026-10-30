# Tasks: spec 020, slices E1a (data provenance) and E1b (eligibility records and function, synthetic only)

**Authorized:** E1a and E1b only (founder, 2026-10-29, E1 to E8 accepted as recommended). E2 (operator command for tenant terms) and E3 (the grants and withdrawals API) are **not** authorized; E3 waits for counsel's answers to questions 6 to 8.

Derived from [plan.md](plan.md). Each slice is its own branch and PR off a freshly fetched `main`. Migration numbers are read from `main`, the open PRs and other sessions' branches at build time and again right before the push.

## E1a: data provenance

### Slice plan (T102; founder, 2026-10-30)

Read at `main` `9fceca6f`. The create paths and columns are traced in the table below. There is no origin or provenance column anywhere today.

| # | Decision | Why |
| --- | --- | --- |
| P1 | Provenance attaches to **`report_captures`** and **`evaluations`**, not to `reports` (founder's choice). A capture's parent is its report. | Both are ledgered and both have the document's sha256 when they are created. A `reports` row is a legacy, unledgered declaration written before its PDF arrives. |
| P2 | One `data_provenance` row per fact, written in the same transaction as the fact. The record is append-only and ledgered, with a new event type `data-provenance`. The migration (0062) restates 0060's ledger set plus this one. | E7, FR-05 |
| P3 | `origin` is written by the server, never taken from a request. It is `synthetic` while the pipeline is refused in production (`apps/backend/src/config/env.ts`, `LAB_REPORT_PIPELINE`). `real` is allowed by the CHECK, but no code path writes it yet. There is no default. | R21, FR-07 |
| P4 | Provenance links to permissions and never encodes them: no purpose, consent or eligibility column. | E7 |

| Field (E7) | Capture | Evaluation |
| --- | --- | --- |
| origin | `synthetic` | `synthetic` |
| interpretation | null: the lab's own interpretation is not separated yet | `software-derived` |
| originating document | `pdf_sha256`; the report's object version | the capture's `pdf_sha256`, through its parent |
| receipt time | the report's `uploaded_at` | null: not a receipt |
| transformation | runner and poppler version | engine version and knowledge set |
| parent asset | the report | the capture acceptance |
| source organization and type, context, collection location | null, "not known yet": nothing collects them | null, same |

| # | Task | Requirement | Done when |
| --- | --- | --- | --- |
| T101 | Branch `feat/data-provenance` off a freshly fetched `main` | E8 | Branch tip equals `origin/main` |
| T102 | Slice plan: which facts carry provenance today (reports, evaluations), the provenance fields from E7 that have a value now, and those that stay null with a reason. Read the create paths first. | E7 | Plan lists each field with its source or "not known yet" |
| T103 | Migration: an append-only, ledgered, FORCE RLS `data_provenance` record linked to the fact it describes. `origin` is `synthetic` or `real`, required, with no default. Interpretation is `lab-assigned` or `software-derived`. It never encodes permissions (E7). The down migration refuses if any row exists, and is run as the migrator. | E7, FR-07 | PostgreSQL tier: insert, refusal of update and delete, RLS isolation, down guard |
| T104 | Write provenance where facts are created. Every row is `synthetic` while the pipeline refuses production (R21). A create path that cannot name its origin fails. | FR-03, FR-07 | A test per create path; a missing origin is refused |
| T105 | Ledger verify over rows created before and after the migration | FR-05 | Verify test green |
| T106 | Full local loop (typecheck, lint, test, build, test:infra, test:ci-config, backend default / PostgreSQL / PostgreSQL+S3, both Playwright suites), mutations on the required-origin check and the down guard, gitleaks | V | Counts recorded; skips listed |
| T107 | `docs/verification/data-provenance.md`, one status fragment, `docs/database.md` row | V | `pnpm test:ci-config` green |

## E1b: the four records and `use-eligibility-v1`, synthetic only

### Slice plan (founder, 2026-10-30: B1 to B5 accepted as recommended)

Read at `main` `f0a777e7`. Patients have no jurisdiction field, and nothing in the backend names one. Migration 0063.

| # | Decision | Why |
| --- | --- | --- |
| B1 | Each grant records its jurisdiction. The v1 allowlist (E4) holds only the synthetic code `ZZ` (ISO 3166 user-assigned) for every purpose. A real jurisdiction and purpose pair needs counsel, a new migration and a new policy version. | Patients have no jurisdiction. No real pair is approved, so nothing real can be eligible by accident. |
| B2 | A fifth append-only, ledgered record, `use_grant_validations` (who validated a grant, and when). A grant without one answers `grant-unvalidated`. | Append-only: a grant row cannot be updated to "validated" (E5). |
| B3 | The function takes the fact being used (a capture or an evaluation) and reads its `data_provenance`. A fact with no provenance (stored before 0062) answers `origin-unknown`. | Origin belongs to a fact, not to a patient (FR-07). |
| B4 | A grant records its `legal_authority` (`authorization`, `waiver`, `tpo`). Tenant terms record the data classifications they authorize. The function takes the classification as an input and returns both in its answer. Storing each use's decision is D07's. | E1: each decision records legal authority and classification; E1b has no per-use record. |
| B5 | Expiry kinds in v1: `date` and the research-only `no-expiration`. `event` expiry is refused by the database until a later slice records the event. | No program-end event is recorded anywhere yet. |

| # | Task | Requirement | Done when |
| --- | --- | --- | --- |
| T201 | Branch `feat/use-eligibility-records` off `main` after E1a merges | E8 | Branch tip equals `origin/main` |
| T202 | Migration: `use_grant`, `use_withdrawal`, `use_restriction` and `tenant_use_terms`, as in the plan's Records table. All are append-only, ledgered, tenant-scoped and FORCE RLS, with intervals (E2). A grant requires a signer, signer capacity, recorder and expiry rule (E3, E5), and is `recorded` until validated. A withdrawal is never effective before its recording time. | FR-02, FR-05, E3, E5 | PostgreSQL tier per table: constraints, append-only, RLS |
| T203 | The purposes vocabulary from E1. `model-*` purposes stay out until one is planned. Each decision records legal authority and data classification. | E1 | Unknown purpose refused at the database |
| T204 | SQL function `use_eligibility(tenant, patient, purpose, scope, at)` returning `eligible`, reason codes, evidence ids and the policy version `use-eligibility-v1`. It fails closed on: unknown purpose, unknown jurisdiction rule (E4 allowlist), missing terms, an expired, withdrawn or unvalidated grant, a restriction, and a real origin for any purpose but clinical care. | FR-01 to FR-03, FR-06, FR-07, E4 | One test per reason code, plus an eligible control |
| T205 | Interval replay: answers for past instants are reproduced after later grants and withdrawals (E2) | FR-02 | A table-driven test over a synthetic timeline |
| T206 | The per-patient lock: a withdrawal racing a use is never missed (E6). The use takes the lock, then calls the function in a fresh statement. | FR-04, E6 | Concurrency test with two connections |
| T207 | Synthetic fixtures only. Rows are written by tests and seed scripts; no API, no operator command and no UI (E2 and E3 are later slices). | E8 | `git grep` shows no controller or route for these tables |
| T208 | Full local loop, mutations on each fail-closed branch, gitleaks | V | Counts recorded; each mutation fails its test |
| T209 | `docs/verification/use-eligibility.md`, one status fragment, `docs/database.md` rows | V | `pnpm test:ci-config` green |

## Not in these slices

E2 (operator command for tenant terms), E3 (the grants API), any patient-facing form, any release logic (D07), and any real data.
