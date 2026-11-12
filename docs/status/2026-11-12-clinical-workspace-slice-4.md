# Clinical decision workspace, slice 4: the home's follow-ups, accessibility checks, usability protocol

Date: 2026-11-12

Front end and documents only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md)
(D19, D20). It builds on slices 1 to 3, which are merged (pull requests #384, #385 and #386). An AI tool (Claude Code) wrote this change.

- **The home lists the follow-ups assigned to the person signed in**, for clinicians and reviewers: patient, medication, when the
  reminder is due and in which timezone, and the way to open it. It is the first three from the inbox's own read; the sidebar keeps the
  full list. An overdue reminder is a late task, and the section says it is not a clinical warning.
- **Results on hold are not on the home.** The API has no read that returns only those across patients, so a list built in the browser
  would be silently incomplete. It is entry 3 of [dependencies.md](../../specs/038-clinical-decision-workspace/dependencies.md).
- **Automated accessibility checks** on the home, on the patient page with a result and the decision form open, and on the source
  conflict; a keyboard test of the result rows; a focus test of the line that reports the follow-up step's outcome.
- **A usability protocol**, [clinical-workspace-usability-protocol.md](../design/clinical-workspace-usability-protocol.md): ten moderated
  tasks on synthetic data, what counts as a failure, the pass a person makes in a browser, and the wording a pharmacist approves.

Proved in the sealed sandbox: front-end typecheck, lint, build, `check:chunks` and `check:brand` pass; the front-end suite passes.
Controls, each applied alone, each turning a test red: the home listing every clinician's follow-ups; overdue not explained; the list
shown to a reader; a failed read shown as loading; broken list markup (caught by the automated accessibility check); a look-alike drug
name not in its Tall Man form; a result row reporting the wrong state; a definition list with a stray child on the patient page (caught
by the automated accessibility check).

**Before the pull request.** After slice 3 merged, this change was replayed on `main` as one commit. On that commit the verify tier, the
backend PostgreSQL tier, all three shards of the PostgreSQL and S3 tier and the worker tier passed in sealed jobs, and the secret scan
found nothing (the pull request has the counts). In the backend memory tier one test failed: `test/db/readiness.pg-spec.ts`, "turns NOT
ready when the database disappears", ran past its 5-second timeout while three sandbox jobs shared the machine. Run on its own in the
same job, the file passed (11 tests). This change touches no backend file.

The home list reads again when the window regains focus, through the same hook the sidebar's Follow-ups entry already uses on every page
that has the sidebar, the home included, to show its count. The hosted test "a typed question gets the note, never an answer, and sends
no request" in `e2e/workspace-home.spec.ts` records every request once the page is idle, so a window focus event during it would fail
it. It has passed in every hosted run with the sidebar's read already on that page, and this adds a second read on the same trigger.
Playwright 1.64.1 also turns on focus emulation for every page, so the page counts as focused from the start, and typing into a field
does not reach a listener on the window. That is evidence from earlier runs and a reading of the code, not a browser run of this change.
The list's link and its retry button carry the control height.

**Not done, for all four slices:** no Playwright suite was run (the sandbox has no browser), so no rendered screen, theme, viewport,
zoom, contrast or screen reader was checked, and the browser specs edited in slices 1 and 2 are untested. The usability protocol has
not been run with anyone. An automated accessibility check passing is not a statement of conformance.
