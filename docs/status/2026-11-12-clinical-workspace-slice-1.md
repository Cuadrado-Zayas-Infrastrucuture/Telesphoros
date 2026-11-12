# Clinical decision workspace, slice 1: an honest surface

Date: 2026-11-12

Front end only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md).
An AI tool (Claude Code) wrote this change; the founder approved its plan on 2026-11-12.

- **A patient is chosen, never assumed.** The chat no longer attaches a report to the first patient the list loaded. The choice starts
  empty, "Choose the patient first." stops the upload, and the details say which patient the report will be stored for.
- **The chat says what it does.** The box and the welcome say that typed questions are not answered, and the welcome lists what can be
  done. A typed question still gets the note of specs/024 D3, and still makes no request.
- **Results are on the patient page without a click.** A current recommendation shows its decision and the controls with it. A result no
  decision can be recorded on says why, and keeps its history behind "Decision history". Wording of a result that is not current stays
  folded.
- **A citation is read, not dumped.** Guideline, version, table, row, column and verification state are labelled lines; a part the stored
  citation lacks reads "not recorded"; the source link is offered only for an `https` address. The stored form is under "Technical
  provenance".
- **Finishing is not a verdict.** "Assessment completed." is in the ordinary colour; it was green.

The patient page now reads the stored results when it opens, for the roles that could already open them, and reads decision history for
each result a decision can be recorded on. Before, both waited for a click.

Proved in the sealed sandbox: front-end typecheck, lint, build, `check:chunks` and `check:brand` pass; the front-end suite passes. Six
controls each turn their tests red (tasks.md T107). **Not run:** every Playwright suite (the sandbox has no browser), so no rendered
screen, theme, viewport, keyboard path or contrast was checked, and the two edited browser specs are untested. The backend tiers were not
run: no backend file changed.

**Correction, same day.** Before the push the backend memory, PostgreSQL, PostgreSQL and S3, and worker tiers were run on this commit
in sealed jobs, and passed (pull request #384 has the counts). The first hosted run then failed in `browser`:
`e2e/foundation.spec.ts`, "interactive controls meet the 44px minimum touch target", found the new "Open a patient" link in the chat
welcome at 17 pixels, on both viewports; the other 228 tests of that suite passed. The link now has the control height every other
control has. Because that suite failed, the two suites after it in the same step (`local-e2e` and `report-workspace`) did not run in
that hosted run. The pull-request `browser` job does not run `decision-e2e` or `product-demo-e2e` at all, so the two specs edited by
reading stay unverified whatever colour the job is, until someone runs `playwright.decisions.config.ts` and
`playwright.product-demo.config.ts` with a browser.
