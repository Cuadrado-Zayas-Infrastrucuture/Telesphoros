# Deliberate breakages: the catalogue and how to run it

Date: 2026-11-25

Several verification records end with "Open: the breakages". Each slice's plan or spec names a few rules that a test must guard, and
asks that someone break each rule on purpose and watch the guarding test go red. No code runs in a cloud agent session, so those
breakages were never done. This page and `scripts/breakages/` turn them into one list that the founder's sandbox job can run in one go.

## What is here

- `scripts/breakages/catalogue.json`: 82 entries. Each has the rule in plain words, the file, the exact text to find (it must
  occur once), what to put in its place, the command that runs the guarding tests, and the test title expected to go red.
- `scripts/breakages/run.mjs`: applies one entry at a time, runs its command, and always puts the file back. Before the first entry of
  each command it runs that command unbroken (the control); an entry only counts when its control was green.
- `scripts/breakages/results.json`: written by the runner, never committed (it is in `.gitignore`).

The entries come from: spec 045 slices N2, N3 and N4 (the phenoconversion notices); spec 044 slice B2; spec 049 W1 and W2 (the worklist
home); spec 051 H1 and H2 and spec 053 C1 and C2b (Help and its model lane); spec 040 slices B and C (patient search); and spec 052 RC1a and RC1b (retiring the chat). The `source`
field of each entry names the plan section it came from; "designed" means the plan named the rule but not the breakage, so the
breakage was written for it. RC1a entries marked "adapted" test the rule as it stands after RC1b removed the drawer.

## How to run it (sealed sandbox only)

The runner edits source files and runs tests, so it runs only inside an OpenSandbox job, never on the host
([agent policy](../ops/agent-policy.md)):

1. `job_start(runtime="telesphoros")`, then `job_upload_repo`.
2. `job_exec`: `tele-services` (PostgreSQL and the S3 emulator, needed by the `backend-postgres` tier).
3. `job_exec`: `node scripts/breakages/run.mjs`. It runs every tier except `browser` and prints a table. `--tier`, `--id` and `--list`
   narrow or list it.
4. Copy the table into the results below, then `job_end`.

Exit code 0 means every entry was caught. Anything else is a finding to look at, not a failure to retry.

| Tier | Entries | Needs |
| --- | --- | --- |
| `frontend-unit` | 38 | Nothing beyond the image |
| `backend-memory` | 11 | Nothing beyond the image |
| `package-unit` | 11 | Nothing beyond the image |
| `backend-postgres` | 4 | `tele-services` running |
| `browser` | 3 | Playwright and a browser; the job image may not have one. Run with `--tier browser` where a browser exists, or leave for CI on a branch |

## What each outcome means

| Outcome | Meaning |
| --- | --- |
| `caught` | The command failed and its output names the expected test. The rule is guarded. |
| `SURVIVED` | The command passed with the rule broken. No test guards the rule: a gap to fix with a test. |
| `red-elsewhere` | It failed, but not visibly on the expected test. Read the tail in `results.json`: often still a catch by another test, sometimes a type or compile error that hides the real question. |
| `control-red` | The command was already red unbroken. Fix that first; the entry says nothing yet. |
| `find-matches-N` / `file-missing` | The code moved since the entry was written. Update the entry. |

Expected survivor, named in advance: **W1-5** (another tenant's held evaluations). Removing the tenant condition from the query may
still be hidden by row-level security, which is the point of having both. A survivor there says the query alone is not what keeps
tenants apart, not that tenants leak.

## Results

Not run yet. The founder runs it in a sandbox job and fills in the last column.

| Breakage | Slice | Tier | Rule | Outcome |
| --- | --- | --- | --- | --- |
| N2-1 | N2 (spec 045) | backend-memory | Only current, active medications can be modifiers on a row; a stopped or non-current one never gives a notice (rule 1, D4, P-D3). | |
| N2-2 | N2 (spec 045) | backend-memory | A notice needs the modifier to be listed against a gene the row's matching results used (PN-2). | |
| N2-3 | N2 (spec 045) | backend-memory | A row with no matching result has no genes and so no notice, whatever the patient takes (rule 3). | |
| N2-4 | N2 (spec 045) | backend-memory | A gene's card carries a notice for every current active medication listed against that gene (rule 4, D9). | |
| N2-5 | N2 (spec 045) | backend-memory | With no modifier list loaded the profile says so and carries no notices (rule 7, PN-6). | |
| N2-6 | N2 (spec 045) | backend-memory | Each notice carries the list's source locator (table and row) exactly as loaded (PN-7). | |
| N3-1 | N3 (spec 045) | frontend-unit | The row says an inhibitor 'lowers' and an inducer 'raises' gene activity (N3-D3). | |
| N3-2 | N3 (spec 045) | frontend-unit | Every notice the server sends is shown on the row, in the order sent; none is dropped. | |
| N3-3 | N3 (spec 045) | frontend-unit | The coverage line under the medications heading is always shown, 'not checked yet' included (N3-D2, PN-6). | |
| N3-4 | N3 (spec 045) | frontend-unit | The gene's card gives each notice's source on the line under it (PN-7). | |
| N3-5 | N3 (spec 045) | frontend-unit | A null source row is left out of the evidence's source line, never printed as 'row null' (PN-7). | |
| N3-6 | N3 (spec 045) | frontend-unit | The evidence links a notice's source only over https; any other scheme is named but not linked. | |
| N4-1 | N4 (spec 045) | backend-memory | A candidate notice with nothing affected is left out (N4-D1, rule 3). | |
| N4-2 | N4 (spec 045) | backend-memory | A checked drug the patient already takes gets no candidate notice (rule 8). | |
| N4-3 | N4 (spec 045) | backend-memory | candidateNotices appear only on the ?rxcui= check, never on a current medication's row (rule 1, N4-D2). | |
| N4-4 | N4 (spec 045) | backend-memory | The checked drug itself is listed as affected (self: true) when its own results rest on the gene (rule 2). | |
| N4-5 | N4 (spec 045) | frontend-unit | When only the checked drug is affected, the screen speaks of its own guidance alone. | |
| N4-6 | N4 (spec 045) | frontend-unit | The checked drug's candidate notice puts its source terms and locator under the row's opened evidence (PN-7). | |
| B2-1 | B2 (spec 044) | package-unit | A glossary entry marked signed must name at least two pharmacists. | |
| B2-2 | B2 (spec 044) | package-unit | A draft glossary entry may not name any signers. | |
| B2-3 | B2 (spec 044) | package-unit | Every glossary signature carries a real ISO date. | |
| B2-4 | B2 (spec 044) | package-unit | An alias belongs to one entry only, compared ignoring letter case and repeated spaces. | |
| B2-5 | B2 (spec 044) | package-unit | A screen string opens a glossary entry only on a whole-alias match; nothing is guessed. | |
| B2-6 | B2 (spec 044) | frontend-unit | The glossary drawer says 'Draft: not yet reviewed by a pharmacist.' on an unsigned entry. | |
| B2-7 | B2 (spec 044) | frontend-unit | In the synthetic staging, 'Record a decision' is a disabled button with its sentence beside it. | |
| B2-8 | B2 (spec 044) | frontend-unit | The signed-knowledge label shows only on a row with a result made with the signed knowledge scope. | |
| B2-9 | B2 (spec 044) | backend-memory | Each profile result carries its evaluation's stored scope, copied unchanged (B2-D5). | |
| B2-10 | B2 (spec 044) | browser | A glossary word on the screen is a 44 px target. | |
| W1-1 | W1 (spec 049) | backend-postgres | The PostgreSQL list really applies the disposition filter. | |
| W1-2 | W1 (spec 049) | backend-postgres | The evaluations service passes the disposition parameter on to the ledger read. | |
| W1-3 | W1 (spec 049) | package-unit | The disposition parameter accepts only held or evaluated; any other value is a 400. | |
| W1-4 | W1 (spec 049) | backend-postgres | meta.total counts the whole filtered set, not the rows on the page. | |
| W1-5 | W1 (spec 049) | backend-postgres | Another tenant's held evaluations never appear in the filtered list. | |
| W2-1 | W2 (spec 049) | frontend-unit | A reader is not shown follow-ups, and the follow-ups route is never asked for them (WL-6). | |
| W2-2 | W2 (spec 049) | frontend-unit | The held-results count is the server's meta.total, never the length of the page (WL-4). | |
| W2-3 | W2 (spec 049) | frontend-unit | An empty held-results section says so in its fixed sentence (WL-3). | |
| W2-4 | W2 (spec 049) | frontend-unit | If one section fails, the page and the other section stay up (WL-1). | |
| W2-5 | W2 (spec 049) | browser | Every control on the worklist, each held-result line included, is a 44 px target (WL-10). | |
| H1-1 | H1 (spec 051) | package-unit | An article that says signed names at least two pharmacists, and a draft names none. | |
| H1-2 | H1 (spec 051) | package-unit | The patient-question refusal sentence follows the same signing rule as an article. | |
| H1-3 | H1 (spec 051) | package-unit | Article text is plain: no web address outside links. | |
| H1-4 | H1 (spec 051) | package-unit | An article cannot link to a route that has a parameter, such as the patient page. | |
| H1-5 | H1 (spec 051) | package-unit | No article reassures: none says safe, no interaction, not affected or none. | |
| H2-1 | H2 (spec 051) | frontend-unit | Help checks for a patient question before it searches, and does not search one (spec 053 C1: in answerFor). | |
| H2-2 | H2 (spec 051) | frontend-unit | A refused question shows the fixed refusal sentence from packages/help-content. | |
| H2-3 | H2 (spec 051) | frontend-unit | A match is weak when the best result covers fewer than half the words. | |
| H2-4 | H2 (spec 051) | frontend-unit | An article is never listed for a role it excludes. | |
| H2-5 | H2 (spec 051) | frontend-unit | A quoted draft article shows the draft line. | |
| H2-6 | H2 (spec 051) | browser | Nothing the person types is sent: asking makes no API request. | |
| C1-1 | C1 (spec 053) | frontend-unit | The refusal is decided before any search: searching first and refusing only when nothing matches is caught. | |
| C1-2 | C1 (spec 053) | frontend-unit | The conversation is cleared when the drawer closes (spec 053 section 1). | |
| C1-3 | C1 (spec 053) | frontend-unit | Only the last 20 exchanges are kept on screen (C1-D2). | |
| C1-4 | C1 (spec 053) | frontend-unit | A chosen article joins the conversation with no message from the person, who typed nothing (C1-D1). | |
| C1-5 | C1 (spec 053) | frontend-unit | A blank box sends nothing. | |
| C2-1 | C2b (spec 053) | package-unit | HC1: a cited passage must be a byte-exact span of the cited article. | |
| C2-2 | C2b (spec 053) | package-unit | HC2: a cited article must have been in the prompt. | |
| C2-3 | C2b (spec 053) | package-unit | HC3: every meaning-carrying word of a sentence must be in its cited passage (HC-D5). | |
| C2-4 | C2b (spec 053) | package-unit | HC4: an answer never names a drug from the bundled list. | |
| C2-5 | C2b (spec 053) | package-unit | HC5: an answer never reassures. | |
| C2-6 | C2b (spec 053) | package-unit | HC6: an answer has no markup or links. | |
| C2-7 | C2b (spec 053) | package-unit | The refusal rule runs before the model: a refused question never reaches it. | |
| C2-8 | C2b (spec 053) | package-unit | The model's out-of-scope flag becomes the refusal and never releases anything (HL-D3). | |
| C2-9 | C2b (spec 053) | package-unit | Any failing check on any sentence withholds the whole model answer (HL-D1). | |
| C2-10 | C2b (spec 053) | package-unit | Outside the evaluation, an article signed by a test signer counts as unsigned (C2-D1). | |
| PSB-1 | Patient search B (spec 040) | frontend-unit | On any answer but a 200 the roster's scope sentence never claims that all patients were searched. | |
| PSB-2 | Patient search B (spec 040) | frontend-unit | A failed search of the whole list keeps the loaded rows and their filter on screen (the fallback). | |
| PSB-3 | Patient search B (spec 040) | frontend-unit | A search text outside the label alphabet is refused in the browser and never sent. | |
| PSB-4 | Patient search B (spec 040) | frontend-unit | A new search, or a change of text, aborts the request of the search before it (PS-12). | |
| PSB-5 | Patient search B (spec 040) | frontend-unit | A late answer to an earlier search is dropped and never replaces the newer matches (PS-12). | |
| PSC-1 | Patient search C (spec 040) | frontend-unit | While a 200 search holds on Attach a report, the picker's choices are the matches. | |
| PSC-2 | Patient search C (spec 040) | frontend-unit | The chosen patient stays a choice through a search that does not match it (PS-11). | |
| PSC-3 | Patient search C (spec 040) | frontend-unit | Enter in the patient search field searches and never submits the upload form around it. | |
| PSC-4 | Patient search C (spec 040) | frontend-unit | On any answer but a 200 the upload picker keeps its loaded choices (the fallback, PS-10). | |
| RC1A-1 | RC1a (spec 052) | frontend-unit | The worklist's Attach a report quick action opens the upload page, not the chat (RC-2). | |
| RC1A-2 | RC1a (spec 052) | frontend-unit | The Reports page's Attach a report link opens the upload page, not the chat (RC-2). | |
| RC1A-3 | RC1a (spec 052) | frontend-unit | The empty report list's Attach the first report link opens the upload page (RC-2). | |
| RC1A-4 | RC1a (spec 052) | frontend-unit | Attach a report is a page of its own at /reports/upload (adapted: the drawer no longer exists after RC1b). | |
| RC1A-5 | RC1a (spec 052) | frontend-unit | The account menu's Settings entry opens the Settings page at /settings (adapted). | |
| RC1A-6 | RC1a (spec 052) | frontend-unit | Settings is a page of its own at /settings (adapted). | |
| RC1B-1 | RC1b (spec 052) | frontend-unit | The sidebar has no Chat entry for any role (RC-6). | |
| RC1B-2 | RC1b (spec 052) | frontend-unit | An old /chat link or bookmark lands on the home, never on an error (RC-5, RC-D2). | |
| RC1B-3 | RC1b (spec 052) | frontend-unit | The home holds no box for typed questions (RC-1). | |

## How this was checked

In the cloud session, without running code: a script read each entry and confirmed that its file exists, that its find text occurs
exactly once, that its command names a test file that exists, and that the expected title occurs in that file. No test was run and
no breakage was applied.
