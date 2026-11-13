# Clinical decision workspace: usability protocol

For [specs/038](../../specs/038-clinical-decision-workspace/spec.md). A short, moderated session with a pharmacist or prescriber on a
build with synthetic data only. It tests whether the screens can be used correctly, not whether the participant is right clinically.
Nothing here has been run yet.

## Before the session

- **Build:** the four slices on one branch, served as staging is (`vite build --mode e2e` without `VITE_LOCAL_STORAGE_INTAKE`), against
  an API on PostgreSQL with decisions and follow-up recording switched on. Staging itself cannot be used for tasks 4 and 5: it shows no
  decision controls and refuses follow-up writes.
- **Data, all synthetic:** two patients whose labels differ by one character (for example `SYN-204` and `SYN-2041`); one with a
  current recommendation, a result on hold for a missing gene result, a result with no guideline, and one withdrawn result; one patient
  with 20 or more results; one follow-up overdue and one due today, assigned to the participant.
- **Participants:** five, pharmacists and prescribers, none of whom built the screens. One should use a keyboard only; one should use a
  screen reader they already know.
- **Record:** screen and voice with consent. No real patient is discussed. Notes use the task number, never a participant's name.

## Tasks

Read each task aloud once. Do not point at the screen. Stop a task after three minutes.

| # | Task | Passes when | Watch for |
| --- | --- | --- | --- |
| 1 | "Attach this report for SYN-2041." | The report is stored for SYN-2041, and the participant says which patient before sending | Sending for SYN-204; not noticing that no patient was chosen |
| 2 | "Can you ask this screen what the result means?" | The participant says it does not answer questions, without typing one first | Typing a question and expecting an answer |
| 3 | "For SYN-204, what does the system recommend for the first drug, and where does that come from?" | Names the wording, the guideline and its version, and where in it | Reading "Assessment completed" as "safe"; opening Technical provenance to find the source |
| 4 | "Which gene results did that assessment use? Did it use the medication list?" | Names the gene results; says the medication list was not used | Assuming the medication list or age was used |
| 5 | "One drug has no recommendation. Why, and what happens next?" | Tells a hold from "no guideline"; names the reviewer's next step, or says none exists | Treating "no guideline" as "no problem"; expecting an owner or a due date |
| 6 | "Is the withdrawn result something you would act on?" | Says no, and why | Opening it and reading its wording as current |
| 7 | "Record that you are deferring this recommendation and want to look again on a date. Make sure you get a reminder." | A decision and a linked follow-up are both saved; the participant can say which of the two creates the reminder | Believing the review-by date alone creates a reminder |
| 8 | (Moderator blocks the follow-up save.) "What has been saved?" | Says the decision is saved and the follow-up is not | Believing both failed, or both succeeded; recording the decision again |
| 9 | "Find the patient with 20 results and open the last drug." | Opens it without losing track of the patient | Losing the patient's identity while scrolling |
| 10 | "From the home screen, what is waiting for you? Is anything urgent clinically?" | Names the follow-ups; says an overdue reminder is a late task, not a clinical warning | Reading "Overdue" as a clinical alarm |

## What to measure

- Completed without help, completed with a prompt, or not completed, per task.
- Every wrong-patient action in task 1 and every wrong reading in tasks 3, 5, 6 and 8, counted separately from slowness. One is enough
  to stop a release.
- Time to the first correct answer in tasks 3 and 5.
- The participant's own words for each outcome label and each evidence heading. A label two of five participants restate wrongly is
  rewritten.

## Accessibility pass, by a person

The automated checks find only what a rule can detect. On the same build, in a browser:

- Keyboard only: every task above; focus is always visible; after the follow-up step closes, focus is on the line that says what
  happened; no control is reachable only by pointer.
- Screen reader (VoiceOver with Safari, NVDA with Firefox): the result row announces the drug, the outcome and whether it is open; the
  evidence panel's parts are reachable as regions; the decision form announces its patient and drug.
- 200% and 400% zoom, and 320 pixels wide: no horizontal scroll outside the source comparison table; no text cut off.
- Light and dark themes: every status word is told apart by its words, not only its colour.
- A patient with 20 medicines and a drug name of 40 characters or more.

## Wording a pharmacist approves before release

The reasons no decision can be recorded (`decisionStanding`), the evidence panel's fixed sentences and its grouping of reasons into
"From the report" and "From the guidelines and definitions" (spec D11), the two-step follow-up sentences (D14, D15), and "Overdue means
the reminder's date has passed. It is not a clinical warning." No Spanish clinical wording exists; none is to be added without a
qualified reviewer.
