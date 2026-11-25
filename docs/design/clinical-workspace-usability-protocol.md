# Usability protocol

A short, moderated session with a pharmacist or prescriber on a build with synthetic data only. It tests whether the screens can be used
correctly, not whether the participant is right clinically. Nothing here has been run yet.

First written for [specs/038](../../specs/038-clinical-decision-workspace/spec.md). Revised on 2026-11-25 for the app as it is now
([plan](plans/usability-protocol-refresh.md)): the worklist home (spec 049), Help (spec 051), patient search (spec 040), the genomic
profile and the drug check (spec 044) and the medication notices (spec 045), with the chat retired (spec 052). Each task names the spec it
tests.

## Before the session

- **Build:** `main`, served as staging is (`vite build --mode e2e` without `VITE_LOCAL_STORAGE_INTAKE`), against an API on PostgreSQL
  with decisions and follow-up recording switched on and the synthetic assessment enabled. Staging itself cannot be used for tasks 7 and
  8: it shows no decision controls and refuses follow-up writes.
- **The medication notice (task 11)** shows only when the API has a gene-modifier list loaded (`GENE_MODIFIERS_DIR`). The API loads a
  list only under the production rules, which check its signatures, and the synthetic lists in
  `data/fixtures/knowledge/synthetic-modifiers/` are unsigned. No build prepares a signed synthetic list yet; that is its own slice
  (plan UP-D3). **Until it exists, skip task 11 and write "skipped: no notice in this build" in the record.** Never sign a list with
  the founders' keys for a session.
- **Data, all synthetic:**
  - two patients whose labels differ by one character (for example `SYN-204` and `SYN-2041`). One has a current recommendation, a
    result on hold for a missing gene result, a result with no guideline, and one withdrawn result;
  - one patient with 20 or more results, and enough patients that the list has more than one page;
  - one follow-up overdue and one due today, assigned to the participant, and one held result;
  - for task 11, `SYN-307`, whose guidance rests on `GENEA` and who takes `drugm`, which the synthetic list `syn-modifiers-a` names
    as a strong `GENEA` inhibitor;
  - for task 12, a synthetic drug `SYN-307` does not take, with synthetic guidance.

  The genes and drugs are the invented ones of the fixtures (`GENEA`, `drugm`). No real drug is named in a session.
- **Participants:** five, pharmacists and prescribers, none of whom built the screens. One should use a keyboard only; one should use a
  screen reader they already know.
- **Record:** screen and voice with consent. No real patient is discussed. Notes use the task number, never a participant's name.

## Tasks

Read each task aloud once. Do not point at the screen. Stop a task after three minutes. All twelve run in one session (plan UP-D1).

| # | Task | Passes when | Watch for |
| --- | --- | --- | --- |
| 1 | "Attach this report for SYN-2041." (spec 040, 052) | The report is stored for SYN-2041, and the participant says which patient before uploading | Choosing SYN-204; not using **Find a patient** when the list has more than one page; not noticing that no patient was chosen |
| 2 | "Can you ask the app what this result means?" (spec 051) | The participant opens Help, and reads its answer as "Help does not answer questions about a patient", not as an answer | Taking a Help article as clinical advice; expecting Help to know the patient |
| 3 | "For SYN-204, what does the system recommend for the first drug, and where does that come from?" (spec 038, 044) | Names the wording, the guideline and its version, and where in it | Reading "Assessment complete" as "safe"; opening Technical details to find the source |
| 4 | "Which gene results did that guidance use? Does it take the patient's medications into account?" (spec 044, 045) | Names the gene results, and says the guidance rests on the genes alone and does not take the medications into account, even where a notice says a medication can change the gene | Assuming the medication list or age was used; reading a notice as "the guidance was adjusted" |
| 5 | "One drug has no recommendation. Why, and what happens next?" (spec 038) | Tells a hold from "no guideline"; names the reviewer's next step, or says none exists | Treating "no guideline" as "no problem"; expecting an owner or a due date |
| 6 | "Is the withdrawn result something you would act on?" (spec 038) | Says no, and why | Opening it and reading its wording as current |
| 7 | "Record that you are deferring this recommendation and want to look again on a date. Make sure you get a reminder." (spec 038) | A decision and a linked follow-up are both saved; the participant can say which of the two creates the reminder | Believing the review-by date alone creates a reminder |
| 8 | (Moderator blocks the follow-up save.) "What has been saved?" (spec 038) | Says the decision is saved and the follow-up is not | Believing both failed, or both succeeded; recording the decision again |
| 9 | "Find the patient with 20 results and open the last drug." (spec 038, 040) | Finds the patient, by search or the list, and opens the drug without losing track of the patient | Losing the patient's identity while scrolling |
| 10 | "From the home screen, what is waiting for you? Is anything urgent clinically?" (spec 049) | Names the follow-ups and the held results; says an overdue reminder is a late task, and a held result is guidance not shown, not a clinical warning | Reading "Overdue" or "Held" as a clinical alarm |
| 11 | "SYN-307 takes drugm. Is there anything on this page about that?" (spec 045; skip until the build shows a notice) | Finds the notice, says which gene and which guidance it concerns, and says the guidance does not take the medication into account | Reading the notice as a dose change or a contraindication; reading its absence on another row as "no interaction" |
| 12 | "Before prescribing [the task 12 drug] for SYN-307, check what this page says about it." (spec 044) | Uses **Check a drug before prescribing**, reads the result for that drug, and says nothing was saved | Believing the check recorded a prescription or a decision |

## What to measure

- Completed without help, completed with a prompt, not completed, or skipped (task 11 only, as above), per task.
- Every wrong-patient action in task 1 and every wrong reading in tasks 3, 5, 6, 8 and 11, counted separately from slowness. One is
  enough to stop a release.
- Time to the first correct answer in tasks 3 and 5.
- The participant's own words for each outcome label, each evidence heading and the notice. A label two of five participants restate
  wrongly is rewritten.

## Accessibility pass, by a person

The automated checks find only what a rule can detect. On the same build, in a browser:

- Keyboard only: every task above; focus is always visible; after the follow-up step closes, focus is on the line that says what
  happened; no control is reachable only by pointer. The Help drawer and the glossary drawer open and close by keyboard, and each
  returns focus to what opened it.
- Screen reader (VoiceOver with Safari, NVDA with Firefox): the result row announces the drug, the outcome and whether it is open; the
  evidence panel's parts are reachable as regions; the decision form announces its patient and drug.
- 200% and 400% zoom, and 320 pixels wide: no horizontal scroll outside the source comparison table; no text cut off.
- Light and dark themes: every status word is told apart by its words, not only its colour.
- A patient with 20 medicines and a drug name of 40 characters or more.

## Wording a pharmacist approves before release

- The reasons no decision can be recorded (`decisionStanding`).
- The evidence panel's fixed sentences, and its grouping of reasons into "From the report" and "From the guidelines and definitions"
  (spec D11).
- The two-step follow-up sentences (D14, D15).
- "Overdue means the reminder's date has passed. It is not a clinical warning."

Also awaiting signature, and still marked as drafts on screen:
- the medication notice's words (spec 045 P-D6);
- the glossary (spec 044 G3);
- the Help articles and the refusal sentence (spec 051).

No Spanish clinical wording exists; none is to be added without a qualified reviewer.
