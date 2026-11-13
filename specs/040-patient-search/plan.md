# Plan: patient search on the server (spec 040)

Date: 2026-11-13
Status: approved by the founder on 2026-11-13, with D1 to D5 as recommended ("Approve as recommended"). Written with them; a different
answer would change the parts named under each slice below.

## What exists, read for this plan at `a4de0bee`

| Piece | Where | What matters here |
| --- | --- | --- |
| List query schema | `packages/shared-types/src/patient-merge.ts:70-78` | `patientListQuerySchema` extends `paginationQuerySchema` with `includeMerged` and `order`. Lives in the merge file, which is why dependencies.md names it |
| Pagination | `packages/shared-types/src/pagination.ts:7-10`, `:17`, `:34-36` | `z.strictObject`: unknown keys refused, and `.extend()` keeps it (`patients.e2e-spec.ts:215` refuses `sort=label`); `listOrderSchema`; `buildMeta` |
| Label alphabet | `packages/shared-types/src/patient.ts:9-14` | Trimmed, 1 to 40, `^[A-Za-z0-9-]+$`. dependencies.md said 1 to 64; no label is longer than 40, so a longer text could match nothing |
| Controller | `apps/backend/src/patients/patients.controller.ts:30-35` | `@Roles(...CLINICAL_READ_ROLES)`, `ZodValidationPipe(patientListQuerySchema)`, passes the whole query to the service |
| Read roles | `apps/backend/src/auth/clinical-read.ts` | `reader`, `clinician`, `reviewer`; `admin` is not a clinical role |
| Service | `apps/backend/src/patients/patients.service.ts:17`, `:21-27` | No key provider (the list decrypts nothing); `list` passes page, order and `includeMerged` to the repository and attaches coded demographics |
| Repository contract | `apps/backend/src/storage/patients.repository.ts:12` | `list(tenantId, page, options?: { includeMerged })`. In memory, `:40-42`: the tenant's rows, sorted, sliced; no merges exist in memory |
| PostgreSQL list | `apps/backend/src/storage/postgres/patients.repository.ts:50-78` | One statement: the page (`:65-66`) with the total as a scalar subquery (`:63-64`); a second count only for a page past the end (`:70-75`). Sort direction is a fixed word chosen in code (`:51-52`). `findByLabel` compares `lower(label) = lower($2)` (`:92`) |
| Indexes | `apps/backend/migrations/0001_core_tables.up.sql:36-37`, renamed in `0003_tenancy.up.sql:24` | Unique `(tenant, lower(label))` and `(tenant, seq)`, both `WHERE deleted_at IS NULL` |
| API log | `apps/backend/src/logger-options.ts:29-33` | Request serializer keeps id and method only; route templates, never the URL or query |
| Patient API tests | `apps/backend/test/patients.e2e-spec.ts` | Tenancy `:49-75`, order and a refusal that never echoes `:77-91`, envelope `:192-222`; runs on the in-memory and PostgreSQL tiers (`createTestApp`, `usingPostgres`) |
| Merge tests | `apps/backend/test/patient-merge.e2e-spec.ts:168`, `:188`, `:223` | `includeMerged=true` reads; PostgreSQL only |
| Query plans | `apps/backend/test/db/query-plans.pg-spec.ts:41-42`, `:139-178`, `:183` | Seeds `SYN-1` to `SYN-1502` in one tenant; `measure` records each statement's plan, rows scanned and time, and the SQL's hash |
| Log privacy test | `apps/backend/test/api-log-privacy.e2e-spec.ts:45` | Proves request values stay out of the HTTP log, with a query string only on a 400 |
| Front-end client | `apps/frontend/src/lib/api.ts:51-62` | `listPatients` checks the envelope and that `pageSize` is 20; maps any failure to one message |
| Roster | `apps/frontend/src/components/patients/PatientRoster.tsx:44`, `:61-79`, `:117-121` | Contains filter on loaded rows; field and scope sentence shown above 5 patients; "No match among loaded patients". No test file today |
| Roster's pages | `apps/frontend/src/hooks/useWorkspacePatients.ts` | Pages newest first, an `AbortController` per session, patients added locally kept |
| Picker | `apps/frontend/src/components/PatientPicker.tsx:47`, `:63` | Native select; keeps `selectedPatient` as a choice when it is not in `patients`. Callers own requests |
| Picker callers | `components/workspace/WorkspaceConversation.tsx:44`, `:308`; `pages/UploadReportPage.tsx:73`, `:309` | The first uses `useWorkspacePatients`, the second `usePatientPages` (`hooks/usePatientPages.ts`) |
| Browser suite | `apps/frontend/playwright.config.ts:8`, `:46` | Runs the real backend build on port 3010 |
| Route description | `docs/lab-report-reader.md:247` | Says what `GET /patients` reads; gets one clause for the parameter |

## Slice A: the API and shared types (one draft PR)

1. **`packages/shared-types/src/patient.ts`**: `patientLabelSearchSchema`, a string of 1 to 40 characters matching `^[A-Za-z0-9-]+$`, not
   trimmed and not transformed. Messages name the rule, never the value. Exported beside `patientLabelSchema`, so the browser checks a text
   with the same rule before sending it.
2. **`patient-merge.ts:71-77`**: `patientListQuerySchema` gains `labelContains: patientLabelSearchSchema.optional()`. A repeated parameter
   arrives as an array and fails the string rule.
3. **`patients.repository.ts`**: `list`'s options gain `labelContains?: string`. In memory: filter the tenant's rows by
   `label.toLowerCase().includes(text.toLowerCase())` before sorting and slicing, so the total counts matches.
4. **`postgres/patients.repository.ts:50-78`**: when `labelContains` is given, a fixed fragment chosen in code,
   `AND strpos(lower(p.label), lower($5)) > 0`, is added to the page's `WHERE`, and the same predicate on `q` to the total subquery and on
   `p` to the past-the-end count (there `$3`). The text is always a bound parameter. Without it the statement text is unchanged, so the
   unfiltered list's plan and SQL hash in the query-plan suite stay the same. `strpos` and not `LIKE`: no wildcard exists to escape.
5. **`patients.service.ts:21-27`**: pass `labelContains` through. The controller needs no change.
6. **`docs/lab-report-reader.md:247`**: one clause naming `labelContains` and its rule.
7. Records: `docs/verification/2026-11-NN-patient-search-api.md`, `docs/status/2026-11-NN-patient-search-api.md`.

### Tests, written first and seen to fail

| Test | Where | Covers |
| --- | --- | --- |
| T0 An older API refuses the parameter | `patients.e2e-spec.ts:215` (existing) and a one-off probe | PS-6. The existing case already holds the rule for any unknown parameter (`sort=label`) and stays. Before any change, `?labelContains=SYN` is sent to the API at `a4de0bee` on both tiers and its 400 goes in the verification record. If it answers 200, stop: an older API ignores the parameter, the front end cannot tell its page from a search result, and that comes back to the founder as a decision before any code |
| T1 The rule, in the shared schema | `packages/shared-types/src/shared-types.test.ts` (added cases) | PS-1. Accepts `a`, `SYN-0`, 40 characters. Refuses empty, 41 characters, ` SYN`, `SYN%`, `SYN_1`, `S'1`, `Jane Doe`, an array |
| T2 Matching | `patients.e2e-spec.ts` | PS-2. Matches in the middle and at the end of a label; ignores case both ways; a deleted patient never matches |
| T3 Paging | `patients.e2e-spec.ts` | PS-3. With `pageSize=2`: a text matching 0 (200, empty, total 0), 1, and 5 patients (pages 1 to 3, `totalPages` 3, page 4 empty with total 5); `order=desc` reverses the matches |
| T4 Tenancy | `patients.e2e-spec.ts` | PS-4. Tenants A and B each create `SYN-T-1` and `SYN-T-2`; each search returns only its own ids and a total of 2 |
| T5 Roles | `patients.e2e-spec.ts` | PS-5. Reader and reviewer 200; role-less and administrator-only 403 (tokens from `signToken`, `test/helpers/tokens.ts:18`); no token 401 |
| T6 Refusals | `patients.e2e-spec.ts` | PS-6. Each malformed text and a repeated parameter: 400 `VALIDATION_ERROR`, field `labelContains`, the value absent from the body |
| T7 Merged-away patients | `patient-merge.e2e-spec.ts` (added case) | PS-2, D2. A merged-away patient's label is not found by default and is found with `includeMerged=true`, carrying `mergedInto` |
| T8 Literal text at the repository | `apps/backend/test/db/` (new pg-spec) and an in-memory spec | PS-7. The repository called directly, past the schema, with `%`, `_`, `'` and `\`: total 0 while patients exist, and no database error |
| T9 Measured | `query-plans.pg-spec.ts:180` (added measurements) | PS-9. The tenant holds `SYN-1` to `SYN-1500` and two patients labelled `SYN-` and 8 random hex digits (`seedLabReport`). `syn-15` gives the 12 seeded matches (`SYN-15`, `SYN-150` to `SYN-159`, `SYN-1500`) plus each random label that contains it, counted from the two labels read back; `SYN-1500` gives 1 plus the same; `XYZ` gives 0 (no hex digit is X or Z); one statement each; `patients-list` still 1,502, and its recorded SQL hash the same as before the change (compared in the verification record) |
| T10 Not logged | `api-log-privacy.e2e-spec.ts` (added request) | PS-8. A 200 response to a request with a query string carrying the marker; the marker absent from the log |

### Deliberate breakages (slice A)

One at a time, in a sealed job, after a control run that must pass. Each must turn the named test red:

| Breakage | Red |
| --- | --- |
| Predicate left out of the page | T2 |
| Predicate left out of the total subquery | T3 (total) |
| Predicate left out of the past-the-end count | T3 (page 4), PostgreSQL tier |
| `lower()` dropped on either side | T2 (case) |
| `strpos` replaced by `LIKE $5 || '%'` without escaping | T8 (`%` matches everyone) |
| The schema's alphabet widened to allow `%` and `_` | T1 |
| The list's query schema made non-strict | T0 (`patients.e2e-spec.ts:215`) |
| `includeMerged` ignored when searching | T7 |
| The request serializer given the URL | T10 |

Expected survivor, named before the run: `tenant_id = $1` removed from the page statement on PostgreSQL. Row-level security still hides
the other tenant, so T4 stays green there; it is the second of two independent layers (`postgres/patients.repository.ts:40-43`), already
covered by `test/db/rls.pg-spec.ts` and `test/db/tenant-rls-catalog.pg-spec.ts`. The in-memory tier has no second layer and goes red.

## Slice B: the roster (one draft PR, after A)

1. **`apps/frontend/src/lib/api.ts`**: `searchPatients(apiFetch, text, page, signal)`: checks the text with `patientLabelSearchSchema`
   first and refuses without a request; sends `page`, `pageSize=20`, `order=desc` and `labelContains` (`encodeURIComponent`); checks the
   envelope as `listPatients` does. It returns the page, or a failure that says only whether the whole list could be searched.
2. **`apps/frontend/src/hooks/usePatientSearch.ts`** (new): one search at a time; a new search aborts the last and a late answer is dropped
   (PS-12); "More matches" pages the current search.
3. **`PatientRoster.tsx`**: typing filters loaded rows at once, as now. While `hasMore`, a "Search all patients" button sits beside the
   field and Enter does the same (D4). On a 200 the list shows the matches and the scope sentence becomes "Searched all patients: N match."
   Clearing the field returns to the loaded list. On any other answer the loaded filter and its sentence stay, and one line says the whole
   list could not be searched, with Retry. A text outside the alphabet shows "Letters, numbers and hyphens only." and is not sent.
   Status as words in colour, no badges, the project's tokens (`text-muted-foreground`, `text-destructive`).

Tests first: `PatientRoster.test.tsx` (new; `fetch` replaced at the boundary, as `PatientIdentification.test.tsx:70` does): a 200 with
matches beyond the loaded pages and the sentence; 400, 401, 403, 429, 500, a network failure and a malformed body each keep the loaded
filter and say the whole list was not searched; a refused text makes no request; a second search's answer wins over a slower first; no
button when every page is loaded. Browser: a new `apps/frontend/e2e/patient-search.spec.ts` against the real backend, creating 25 patients
and finding the oldest. Breakages: the sentence claiming "all" on a non-200; the fallback removed; the text sent unchecked; the abort
removed. Each turns a named test red.

## Slice C: the two pickers (one draft PR, after B)

`PatientSearchField` (new), the field, button and status line from slice B, placed above the picker in `WorkspaceConversation.tsx:308` and
`UploadReportPage.tsx:309`, each using `usePatientSearch`. While a search holds, the picker's `patients` are the matches and the chosen
patient stays a choice through `selectedPatient`. `PatientPicker` itself does not change. Tests: both surfaces search, fall back, and keep a
chosen patient that the search does not match; `PatientPicker.test.tsx` unchanged and passing. The upload browser suites
(`upload.spec.ts`, `upload-navigation.spec.ts`) gain one search each.

## Verification (every slice)

In sealed `opensandbox-pilot` jobs, never on the host: the new and changed tests; `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build`; the database and storage tier in its shards and the query-plan suite (slice A); the browser suite (slices B and C);
`pnpm test:infra`, `pnpm test:ci-config`, `pnpm check:workflows`. A tier that prints its skip notice is reported as a skip, never a pass.
Gitleaks before each PR. Slices B and C: the founder's browser check from written steps, recorded in the verification record. The pull
request uses the template headings (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups). No staging
change is planned here; a release is its own step and starts from `scripts/staging/staging-status.sh`.

## Not changed

Every migration and index; the unfiltered list's statement; patient creation, replacement, deletion and merging; demographics and their
encryption; reports, evaluations, the ledger and every clinical output; `PatientPicker`; specs/038 and its `dependencies.md`; the private
repository, which takes this at its next merge from public and runs its own loop.
