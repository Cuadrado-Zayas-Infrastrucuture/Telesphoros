# Patient search on the server (spec 040)

Date: 2026-11-13
Status: draft. `plan.md` waits for the founder's approval; nothing is built. Source: gap F12, section 1 of
[specs/038 dependencies.md](../038-clinical-decision-workspace/dependencies.md), which the founder chose on 2026-11-13 as the first public
gap to specify. That file is not edited; this spec is the "own plan" its preamble asks for.

## Why

A clinician can find a patient only on the pages the screen has already loaded. `GET /patients` takes `page`, `pageSize`, `includeMerged`
and `order` (`patientListQuerySchema`, `packages/shared-types/src/patient-merge.ts:71-77`) and nothing that narrows the list. The roster
filters the loaded labels in the browser (`PatientRoster.tsx:44`) and, since spec 038 D17, says how many it has loaded and that more remain.
The two upload pickers (`WorkspaceConversation.tsx:308`, `UploadReportPage.tsx:309`) offer only the loaded pages, one "More patients" click
at a time. With 20 patients a page, a tenant of 400 patients needs 20 clicks to reach the oldest.

Names and dates of birth are encrypted per patient and are not searchable by design (spec 025); the list decrypts nothing
(`patients.service.ts:17`). The synthetic label is the only handle, so the label is the only thing searched.

## Scope

Synthetic data only. One optional query parameter on the existing list, then the roster, then the two pickers. No migration, no index, no new
route, no change to patient creation, merging, demographics, reports or any clinical output. Labels stay the
`patientLabelSchema` alphabet (`patient.ts:9-14`): letters, digits and hyphens, 1 to 40 characters.

| ID | Requirement |
| --- | --- |
| PS-1 | **One optional parameter on the list.** `GET /patients` accepts `labelContains` (D1), a text of 1 to 40 characters of the label alphabet (`^[A-Za-z0-9-]{1,40}$`), not trimmed. Without it the list answers exactly as today, byte for byte. |
| PS-2 | **Matching.** A patient matches when its label contains the text, ignoring case (D1). The alphabet is ASCII, so lower-casing has one answer in the database and in the browser. Only the caller's tenant's live patients are read: deleted patients never match, and merged-away patients follow `includeMerged` exactly as the unfiltered list does (D2). |
| PS-3 | **Same envelope, same paging.** The answer is the existing `{ data, meta }` of `PatientDto` list items. `meta.total` and `meta.totalPages` count matches only. `page`, `pageSize` and `order` behave as on the unfiltered list; a page past the last match is empty and still carries the matching total. No match is a 200 with an empty page and a total of 0, never a 404. |
| PS-4 | **Tenancy.** The search runs inside the list's tenant scope: `tenant_id` named in the statement and row-level security under it, as the list is (`postgres/patients.repository.ts:40-43`). Two tenants searching the same text each see only their own patients and their own total. |
| PS-5 | **Roles.** The roles that read the list today read the search: `reader`, `clinician`, `reviewer` (`CLINICAL_READ_ROLES`). A role-less member and an administrator alone get 403; no token gets 401. |
| PS-6 | **Refusals, and an older API.** A malformed text (empty, too long, outside the alphabet, given twice) is 400 `VALIDATION_ERROR` naming the field `labelContains` and never echoing the value. An API that does not know the parameter must answer 400, never ignore it, so an older API cannot return an unfiltered page that reads as a search result. The list's query schema is strict (`pagination.ts:7`), so an unknown parameter should already be refused; the first task proves it on the current API before anything relies on it. |
| PS-7 | **Literal text, parameterized SQL.** The text is a bound parameter; the only statement text that varies is a fixed fragment chosen in code, as the list's sort direction already is (`postgres/patients.repository.ts:51-52`). The match uses no `LIKE`, so a `%`, `_`, `'` or `\` that reached the repository past the schema would match only itself. |
| PS-8 | **The text stays out of records.** The search text is part of a patient label. It appears in no log line, error body, metric, audit record or ledger record. The API log already keeps route templates only and drops the query string (`logger-options.ts:29-33`); nothing new is logged. |
| PS-9 | **No schema change** (D3). No migration and no index: the tenant's rows are read through the existing `(tenant_id, seq)` index and filtered. The unfiltered list's statement text is unchanged, so its measured plan is unchanged. |
| PS-10 | **The roster searches the whole list only when it says so** (D4). Typing still filters the loaded rows at once, by the same rule as PS-2. While more pages remain, the field offers to search all patients. Only a 200 changes the scope sentence to say the whole list was searched, with the number of matches. Any other answer (400 from an older API, 401, 403, 429, 5xx, a network failure, or a body that fails the shared schema) keeps the loaded rows, the loaded-pages filter and its sentence, and adds one line saying the whole list could not be searched, with Retry. A text the shared schema refuses is never sent; the field says which characters it takes. |
| PS-11 | **The pickers search the same way** (slice C). Both upload surfaces get the same field above the picker. A 200 makes the picker's choices the matches; the patient already chosen stays a choice (`selectedPatient`, `PatientPicker.tsx:47`, `:63`). Any other answer keeps the loaded choices and says the whole list could not be searched. |
| PS-12 | **A newer answer always wins.** A search started after another replaces it: the earlier request is aborted, and an answer that arrives late is dropped, in the roster and in both pickers. |

## Decisions

| # | Decision | Options | Recommendation | State |
| --- | --- | --- | --- | --- |
| D1 | Match rule, and the parameter's name | (a) Prefix, `labelPrefix`, as dependencies.md §1 proposed. (b) Contains, `labelContains`, the rule the roster's filter already uses (`label.toLowerCase().includes(...)`, `PatientRoster.tsx:44`). (c) Both, chosen by a second parameter | (b). Labels in one tenant usually share their start (`SYN-…`), so a prefix search needs that start typed before it narrows anything, and `0042` finds nothing. And with (a), the same text would find different patients depending on whether the server answered (PS-10's fallback is the loaded filter, which matches anywhere). Neither rule can use an index on this database without a new one (D3), so (a) buys no speed | Open |
| D2 | Merged-away patients in a search | (a) As the unfiltered list: hidden unless `includeMerged=true`, each carrying `mergedInto`. (b) A search always includes them | (a). No new meaning for `includeMerged`, and the roster shows what it shows today. A search for a merged-away label finds nothing by default, as the roster's filter already does; showing "merged into …" in the roster needs the merge screens (M3.2) and is a follow-up | Open |
| D3 | An index for the search | (a) None: read the tenant's rows by `(tenant_id, seq)` and filter; measure at 1,502 patients in the query-plan suite. (b) A trigram index on `lower(label)` now (`pg_trgm`, a migration and an extension) | (a). The data is synthetic and the tenants small. A public migration now would take number 0075, which the private repository already uses (spec 039 D3), forcing a renumbering at the next merge. The suite records rows scanned and time for each statement; revisit when a real tenant's size or that record says the scan is slow | Open |
| D4 | When the roster asks the server | (a) On Enter or a "Search all patients" button, offered only while more pages remain; typing filters the loaded rows at once, as now. (b) As you type, after a pause, always. (c) As you type, only while more pages remain | (a). One request per deliberate search, a scope change the clinician chose, and no list that redraws under the pointer while typing. When every page is loaded, the loaded filter already searches everything and no request is needed | Open |
| D5 | Slices | (a) Three draft PRs in order: A the API and shared types, B the roster, C the two pickers. (b) A and B now; the pickers in a later spec. (c) One PR | (a). A is inert until B uses it and can ship alone. B and C each change a screen and each get a browser check the founder runs from written steps, as the 2026-11-13 decisions set for the workspace panels; C changes two upload surfaces that B does not touch | Open |

## Done when

1. Slice A: every test in `plan.md` was seen failing before the code and passing after, on the in-memory, PostgreSQL and PostgreSQL plus S3
   tiers; the version-rule test (PS-6) passed against the API before the change; each deliberate breakage turned its named test red.
2. Slice A: the query-plan suite measures the search with hand-written totals, and the unfiltered list's measurement is unchanged.
3. Slice B: the roster's tests cover a 200, each refusal class, a refused text that is never sent, and a late answer dropped; the browser
   suite searches a patient that is not on the first page; the founder's browser check is recorded.
4. Slice C: the same for both upload surfaces, and a chosen patient survives a search that does not match it.
5. Each slice: the required tiers pass in sealed jobs; a verification record in `docs/verification/`; one status fragment; the route
   description in `docs/lab-report-reader.md:247` names the parameter (slice A).

## Not in this spec

- Searching names, dates of birth or identifiers. Names and dates of birth are encrypted per patient; identifiers are stored as keyed
  digests and are never shown back (`patient.ts:6-7`). Each would be its own spec.
- Showing merged-away patients or a "merged into" line in a search (D2 (b)); the merge screens (M3.2).
- An index or migration (D3); fuzzy or typo-tolerant matching; ranking. Matches come in the list's own order.
- The other six entries of specs/038 `dependencies.md`, which stay documented and unbuilt.
- Any change to `dependencies.md` itself or to specs/038, which are dated records.

## Not checked

- That `patientListQuerySchema`, built with `.extend()` on a strict object, refuses an unknown parameter on `GET /patients`. No existing test
  sends one to this route (the demographics route has one, `patient-demographics.e2e-spec.ts:263`). PS-6 depends on it; the plan's first
  task proves it on the current API.
- How large a tenant the unindexed search serves quickly beyond the 1,502 patients the query-plan suite seeds. The suite records time and
  rows scanned; it sets no time limit.
- Edge logs. Today the load balancer has no access log (`infrastructure/terraform/api-edge.tf:145-164`) and no WAF logging configuration
  exists in the Terraform, so the query string is recorded nowhere outside the API, which drops it. If either is turned on later, the
  search text (a synthetic label fragment) would be in those logs. Read in this checkout's Terraform only; the applied state was not read.
- The release order on staging. Slice B works against an API without slice A (it falls back on the 400), but the founder's browser check
  of B needs A released first.
