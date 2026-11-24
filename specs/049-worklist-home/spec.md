# Feature Specification: the worklist home (direction plan slice A1) (WL)

**Feature Branch**: `claude/049-worklist-home-spec` (this specification); each slice its own branch and pull request off `main`

**Created**: 2026-11-24

**Status**: **draft, awaiting the founder's approval of W-D1 to W-D5 (section 7). Specification only: no code, route, setting, migration
or knowledge change.** It carries out slice A1 of [the pharmacist-first direction plan](../../docs/design/plans/pharmacist-first-product-direction.md)
(decision N2: "the clinical home is a worklist by role"), now that spec 044 (the genomic profile) and spec 045 (the phenoconversion notice,
through N4) have come first, as GP-N2 ordered.

The founder's direction still bounds every choice: **clear to a prescriber or pharmacist with no PGx background, and simple and enjoyable
to work with.** For a home, that means: open the app and see what needs you, in plain words, with each line one click from where the work
is done.

## 1. What is there today (read from `main` at `123d377`, 2026-11-24)

- **The home is a chat.** A signed-in reader, clinician or reviewer lands on `/workspace` (`signedInHome`, `lib/localWorkspace.ts:22`),
  whose centre is `WorkspaceConversation`. On staging it is an upload form in a chat frame: a typed question gets "Questions cannot be
  answered here." (direction plan section 1; spec 038 F02). Admin lands on `/usage`.
- **The only list of work across patients on the home** is `HomeFollowups`: the first three follow-ups assigned to the person signed in
  (`GET /followups?assignment=mine&status=all`, spec 038 D19), inside the chat's welcome. Its own comment calls it "the one list of work
  across patients the API has".
- **The sidebar** (`WorkspaceSidebar.tsx`): "New chat", Patients, Reports, Follow-ups (with the overdue and due-today count), Usage, recent
  reports, the account menu. Reports and Follow-ups are pages (spec 041 slice C, merged).
- **The queues the API already has**, and where the work on each is done:

  | Queue | Route | Roles | On synthetic staging | A screen in the clinical app where the work is done |
  | --- | --- | --- | --- | --- |
  | Follow-ups | `GET /followups` | clinician, reviewer | works (read) | yes: the patient page, `?followup=` |
  | Held results | none: `GET /evaluations` carries `disposition` and `holdCode` but cannot filter on them | reader, clinician, reviewer | works with `SYNTHETIC_ASSESSMENT` | yes: the patient page, its results |
  | Possible duplicate patients | `GET /patient-duplicates` | reader, clinician, reviewer | works | **no**: only `LocalOperationsPage` (local build) |
  | Merges waiting for a second person | `GET /patient-merges?status=pending` | reader, clinician, reviewer | works | **no**: as above |
  | Disputed guideline cells | `GET /cell-disputes` | reader, clinician, reviewer | 503 `PIPELINE_DISABLED` | **no**: as above |
  | Reports held for a wrong patient link | `GET /patient-link/quarantine` | reviewer | 503 `PIPELINE_DISABLED` | **no**: as above |
  | Reports whose findings wait for review | none: the review state is per report | clinician, reviewer | per report only | yes: the report |

## 2. What A1 does

1. **The home becomes the worklist.** A signed-in reader, clinician or reviewer lands on it. It is one page, in a fixed order, of the
   sections below that the person's roles can read. Admin keeps `/usage`.
2. **Every line opens where the work is done.** A queue with no such screen in the clinical app is not on the home yet (W-D3): a line
   that cannot be acted on teaches people to ignore the list.
3. **Quick actions** at the top, the three things people start the day with: **Find a patient** (the existing search, spec 040), **Add a
   patient**, **Attach a report** (the existing drawer). They are links to what exists, with the same roles.
4. **The chat leaves the centre** (W-D2). The help assistant that replaces it is slice A3.
5. **Nothing is inferred.** The home orders nothing by urgency, adds no clinical logic and writes nothing.

## 3. The sections (A1)

| Order | Heading (plain words) | Who sees it | Each line says | It opens | Source |
| --- | --- | --- | --- | --- | --- |
| 1 | **Follow-ups due** | clinician, reviewer | patient label, medication, "Overdue" or "Due today" or the date, and its timezone (as `HomeFollowups` does today) | the patient page at that follow-up | `GET /followups?assignment=mine&status=all`, first five |
| 2 | **Held results** | reader, clinician, reviewer | patient label, the report's file name, and the hold in its fixed words ("Held: …", the existing `holdCode` wording, never report text) | the patient page at its results | `GET /evaluations?current=true&disposition=held` (W-D4), first five |

Under each section: "All follow-ups" (the existing page) or, for held results, "N held results in all" with the server's total.

## 4. Rules

| # | Rule |
| --- | --- |
| WL-1 | Each section is its own read, with its own route's role and gate. One failing never blanks the page or another section. |
| WL-2 | A section that could not be read says so, in words, with a Retry that reads that section only. It never looks empty. |
| WL-3 | An empty section says it is empty in a fixed sentence ("No follow-ups are due for you." / "No results are held."). Nothing on the home says or implies "safe", "no interaction", "not affected" or "none" about a patient. |
| WL-4 | A count is the server's own total (`meta.total`, or `counts` for follow-ups), never worked out from a partial page. |
| WL-5 | The order of sections and of lines is fixed: the server's order (follow-ups: those needing a new owner first, then by due date, as `GET /followups` already sorts; held results: as `GET /evaluations` already sorts). Nothing ranks by clinical urgency. The follow-ups' existing sentence stays: "Overdue means the reminder date has passed. It does not indicate the level of clinical urgency." |
| WL-6 | A section the person's roles cannot read is not requested and not shown: no 403 in the network log, no greyed-out heading. |
| WL-7 | A section switched off in this environment (a 503 the server marks as switched off, such as `PIPELINE_DISABLED`) is handled as W-D3 decides, never as an error and never as empty. |
| WL-8 | Nothing is written, stored or counted: no ledger event, no new table, no analytics. |
| WL-9 | The patient's label is shown as the rest of the app shows it (the Reports list's lookup, falling back to the identifier as it does); the home never shows report text or a span. |
| WL-10 | Every control is a 44 px target; headings go h1, h2, h3; it reads at 375 and 1280 px, light and dark, with no WCAG A/AA violation (as the genomic profile's browser tests check). |

## 5. Navigation

- **The home's address** is `/workspace`, the address every "home" link and `signedInHome` already use, so no bookmark or link breaks.
- **The sidebar:** "New chat" becomes **Home** (`/workspace`). Patients, Reports, Follow-ups and Usage stay. Where the chat goes is W-D2.
- **"Back to chat"** (`BackToChatLink`, five places) becomes **"Back to home"**, to the same address.
- The command bar of the direction plan (section 5) is not in A1.

## 6. Slices

| Slice | What | Touches |
| --- | --- | --- |
| **W1, the held-results filter** | An optional `disposition` filter (`held` or `evaluated`) on `GET /evaluations`, applied in the ledger query, in both stores. Same route, roles and gate. | `packages/shared-types` (`lab-report.ts`), the evaluations service and both repositories, their tests in three tiers |
| **W2, the home** | The worklist page, the quick actions, the sidebar's Home, "Back to home", the chat moved as W-D2 decides, `HomeFollowups` folded into section 1 | `apps/frontend` only; unit tests and a browser test |

W1 ships first, or W2 ships with section 2 waiting on it. Each gets its own plan, as earlier slices did, only if the founder asks; this
specification is written to be the plan for both.

## 7. Decisions for the founder

- **W-D1. One route that gathers the queues, or the home reads each queue's own route.** The direction plan said "one read endpoint".
  - **Recommended:** the home reads each queue's own route, in parallel. Every section keeps the role, gate and tenant scope that route
    already has and is already tested for; one section failing cannot fail another (WL-1); no new route, permission or response shape.
  - **Alternative:** a new `GET /worklist` that calls each queue and returns the sections. One request, but a new route whose role
    checks must repeat every queue's, and a new place to get them wrong.
- **W-D2. Where the chat goes until the help assistant (A3) replaces it.**
  - **Recommended:** it moves to its own address, `/chat`, reached from the sidebar as "Chat". Nothing in it changes; A3 replaces it.
    Specs 024 D3 and 038 D3 are amended here only as far as "the chat is not the home".
  - **Alternative:** remove it now. Report upload stays reachable ("Attach report"), but a few people may use the chat's flow today, and
    A3 would then add a panel where nothing was.
- **W-D3. Queues with no screen in the clinical app** (duplicates, merges, disputes, wrong-patient links).
  - **Recommended:** not on the home in A1. Each joins the home in the slice that gives it a screen where the work is done, which is a
    clinical-workflow slice of its own (merges and links touch patient identity). Rule WL-7 is then built and tested for them when they
    come.
  - **Alternative:** show their counts now as read-only lines that open nothing. The home would then show work no one can do from it.
- **W-D4. Held results in A1.** It is the most useful queue for a pharmacist, and N2 names it, but it needs the small API filter in W1.
  - **Recommended:** yes, with W1.
  - **Alternative:** A1 ships with follow-ups only, and held results follow.
- **W-D5. Who gets the worklist as their home.**
  - **Recommended:** reader, clinician and reviewer (everyone with clinical read). A reader sees held results only, since follow-ups
    are clinician and reviewer. Admin keeps `/usage`.
  - **Alternative:** clinician and reviewer only; a reader keeps landing on the chat.
- **Still open, not needed for A1:** F5, the first usability sessions (the direction plan recommends running one with pharmacists before
  A1 is fixed; the home can be built and changed after).

## 8. Not touched

- No new clinical logic, ranking, inference or wording about a patient's results. The hold words are the existing fixed ones.
- No new role, permission, migration, setting, Terraform or knowledge change. W1 is a filter on an existing read.
- The queues of W-D3, the help assistant (A3, A4), the command bar, decisions on staging (B1, F4), medication review (B2).
- Spanish: the home's fixed strings stay in English beside the rest of the screen's until the founders write the Spanish.

## 9. Tests (working agreement 6)

- **W1, three tiers:** `disposition=held` returns only held, current evaluations of this tenant; `evaluated` only evaluated; absent
  returns both as today; another tenant's held evaluation never appears; `meta.total` counts the filtered set; an unknown value is a 400.
- **W2, unit:** each section for each role (WL-6: a reader's page requests no follow-ups); loading, empty (its fixed sentence), failed
  with Retry reading that section only (WL-2), and one section failing while the other shows (WL-1); the counts are the server's (WL-4);
  each line's link; no rendered text contains "safe", "no interaction", "not affected" or "none" (WL-3); Home and "Back to home" in the
  sidebar; the chat at its new place (W-D2).
- **W2, browser** (`e2e/worklist-home.spec.ts`): 375 and 1280 px, light and dark, no sideways scroll and no axe violation; keyboard only
  from the quick actions to a line; 44 px targets and heading order (WL-10). The e2e API's follow-ups answer 503 on the in-memory store,
  so, as the genomic profile's browser test does, the test serves the two reads from a synthetic fixture and says why.
- **Defect injections:** a section's failure blanking the page; a count from the page length; a reader requesting follow-ups; an empty
  section with no sentence. Each must fail a test.
- **Usability (the founders, with a non-specialist):** "You have just signed in. What needs your attention today, and how would you
  start on it?" It passes when the participant names the due follow-up and the held result and opens one without help.

## 10. How it will be verified

As for N1 to N4: the code is written here and **not run here** (founder decision P2), and CI is the first run, including the new browser
test in the `browser` job and W1's PostgreSQL tiers in `database-and-storage`. The defect injections join the open list.
