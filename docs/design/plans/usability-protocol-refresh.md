# Plan: the usability protocol tests the app as it is now

Date: 2026-11-25

Status: **plan only, waiting for the founder's decisions (section 4).** No document, code or test changes yet.

## 1. Why

`docs/design/clinical-workspace-usability-protocol.md` is the script for the moderated sessions (F5) the founders will run with
pharmacists and prescribers. It was written for spec 038, before:
- the worklist home (spec 049);
- Help (spec 051);
- patient search (spec 040);
- the genomic profile and the drug check (spec 044);
- the medication notices (spec 045);
- the chat's retirement (spec 052).

Run as written, three tasks test screens or answers that have changed:

| Task | As written | What changed |
| --- | --- | --- |
| 2 | "Can you ask this screen what the result means?" Passes when the participant says it does not answer questions | Help now takes typed questions. It answers how to use the app and refuses a question about a patient with a fixed sentence (spec 051, section 5) |
| 4 | "Did it use the medication list?" Passes when the participant says the medication list was not used | The guidance still rests on the genes alone. A row can now carry a notice that a current medication can change the gene: "A medication this patient takes can change this. … The guidance above is based on the genes alone and does not take this into account." (spec 045). Whether the medication list was "used" now has two answers |
| 10 | "From the home screen, what is waiting for you?" Passes when the participant names the follow-ups | The home also lists held results (spec 049) |

Two more tasks are stale in smaller ways:
- Task 1 attaches through the chat's flow. The upload page now has **Find a patient** and **Search all patients**.
- Task 9 finds a patient by scrolling. Search now exists.

Three things nothing in the protocol tests yet:
- the medication notice;
- **Check a drug before prescribing**;
- the glossary drawer.

The build section is out of date too. It calls for "the four slices on one branch", and it does not say that the profile needs a
gene-modifier list loaded (`GENE_MODIFIERS_DIR`).

**Found while planning: the notice cannot appear in a session build today.** The API loads a gene-modifier list only under the
production rules, which check two signatures against `KNOWLEDGE_SIGNER_KEYS` (`apps/backend/src/config/env.ts`, spec 045 PN-1). The
synthetic lists in `data/fixtures/knowledge/synthetic-modifiers/` are unsigned, and their README says the loader refuses them. Only the
backend's HTTP test shows a notice, by signing a copy with test signers (`signedModifierCopy` in `apps/backend/test/helpers/knowledge.ts`).
Task 11 below therefore needs session data that nothing prepares yet (UP-D3). Task 12, the drug check itself, does not: the check works
without a list, and only its notices need one.

## 2. What changes and what does not

| Part | Change |
| --- | --- |
| Title and opening paragraph | The protocol covers the app, not one spec. Each task names the spec it tests |
| Before the session | The build is `main`, with decisions and follow-ups switched on and a modifier list loaded. The data adds a patient on a medication that the synthetic list says changes a gene that patient's guidance rests on |
| Tasks 1, 2, 9, 10 | Rewritten to the current screens (section 3) |
| Task 4 | As UP-D2 decides |
| New tasks 11 and 12 | As UP-D1 decides |
| What to measure | Task 11 joins the "wrong reading" tasks, where one wrong reading is enough to stop a release |
| Accessibility pass | Adds the Help drawer and the glossary drawer: each is reachable by keyboard and returns focus when it closes |
| Wording a pharmacist approves | Adds the notice wording (spec 045 P-D6), the glossary (spec 044 G3) and the Help articles, each still a draft today |

Unchanged:
- tasks 3, 5, 6, 7 and 8;
- the three-minute limit;
- the participant mix;
- the recording rules;
- "No real patient is discussed";
- the rule that no Spanish clinical wording is added without a qualified reviewer.

## 3. Proposed tasks

| # | Task | Passes when | Watch for |
| --- | --- | --- | --- |
| 1 | "Attach this report for SYN-2041." | The report is stored for SYN-2041, and the participant says which patient before uploading | Choosing SYN-204; not using **Find a patient** when the list has more than one page |
| 2 | "Can you ask the app what this result means?" | The participant opens Help, and reads its answer as "Help does not answer questions about a patient", not as an answer | Taking a Help article as clinical advice; expecting Help to know the patient |
| 4 | "Which gene results did that guidance use? Does it take the patient's medications into account?" | As UP-D2 decides | Reading the notice as "the guidance was adjusted"; or missing the notice |
| 9 | "Find the patient with 20 results and open the last drug." | Finds the patient (by search or the list) and opens the drug without losing track of the patient | Losing the patient's identity while scrolling |
| 10 | "From the home screen, what is waiting for you? Is anything urgent clinically?" | Names the follow-ups and the held results; says an overdue reminder is a late task, and a held result is guidance not shown, not a clinical warning | Reading "Overdue" or "Held" as a clinical alarm |
| 11 (needs UP-D3) | "SYN-307 takes [the synthetic inhibitor]. Is there anything on this page about that?" | Finds the notice, says which gene and which guidance it concerns, and says the guidance does not take the medication into account | Reading the notice as a dose change or a contraindication; reading its absence on another row as "no interaction" |
| 12 | "Before prescribing [a synthetic drug] for SYN-307, check what this page says about it." | Uses **Check a drug before prescribing**, reads the result for that drug, and says nothing was saved | Believing the check recorded a prescription or a decision |

The synthetic drug and gene names come from the e2e fixtures, as they do in the existing data list. No real drug is named in a session.

## 4. Decisions for the founder

- **UP-D1. Session length.** Twelve tasks at up to three minutes each is longer than ten.
  - **Recommended:** keep all twelve in one session. Tasks 11 and 12 test the newest clinical words, and the stop-a-release rule needs
    them seen by the same five participants.
  - **Alternative:** keep ten tasks by dropping task 6 (the withdrawn result) and task 8 (the blocked follow-up save). Both are kept
    as browser tests already.
- **UP-D2. Task 4's pass criterion**, the medication question. This is a clinical reading, so it is yours and the co-founder's to
  word.
  - **Recommended:** the participant names the gene results, and says the guidance rests on the genes alone and does not take the
    medication into account, even where a notice says a medication can change the gene.
  - **Alternative:** split it in two. Task 4 keeps only the gene question, and task 11 carries the whole medication reading.

- **UP-D3. Session data for the notice (task 11).** No build today loads a modifier list without signatures.
  - **Recommended:** keep task 11 in the protocol, marked "only when the session build shows a notice", and make the session data its
    own slice with its own plan. That slice would be a local-only script that signs a synthetic list with throwaway test keys, as the
    backend test does, never with the founders' keys. Until it exists, a session skips task 11, and the record says so.
  - **Alternative:** leave task 11 out of the protocol until a signed list exists for another reason (the founders' signing keys).

## 5. The slice (one docs PR)

- `docs/design/clinical-workspace-usability-protocol.md`, as in sections 2 and 3 and the decisions.
- One status fragment.

No code, test, fixture or route changes. If the session data needs a new e2e fixture (a patient on a modifier), that is its own
slice.

## 6. How this was checked

Read from `main` at the time of writing:
- the protocol;
- spec 051 section 5;
- the notice words in `apps/frontend/src/lib/genomicProfileWords.ts`;
- the worklist sections in `HomeFollowups.tsx` and `HomeHeldResults.tsx`;
- the patient search in `PatientSearchField.tsx`;
- `GENE_MODIFIERS_DIR` and its signature rule in `apps/backend/src/config/env.ts`;
- `data/fixtures/knowledge/synthetic-modifiers/README.md` and `apps/backend/test/genomic-profile.e2e-spec.ts`.

No code ran. The e2e fixtures were searched for a patient on a modifier: only the backend HTTP test sets one up, with a test-signed
list (UP-D3).
