# Clinical decision workspace, slice 4: the home's follow-ups, accessibility checks, usability protocol

Date: 2026-11-12

Front end and documents only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md)
(D19, D20). It builds on slices 1 to 3. An AI tool (Claude Code) wrote this change.

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

**Not done, for all four slices:** no Playwright suite was run (the sandbox has no browser), so no rendered screen, theme, viewport,
zoom, contrast or screen reader was checked, and the browser specs edited in slices 1 and 2 are untested. The usability protocol has
not been run with anyone. An automated accessibility check passing is not a statement of conformance.
