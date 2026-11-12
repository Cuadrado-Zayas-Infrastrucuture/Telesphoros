# Clinical decision workspace, slice 2: a selected result and its evidence

Date: 2026-11-12

Front end only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md)
(D9 to D13). It builds on slice 1, which is merged (pull request #384). An AI tool (Claude Code) wrote this change.

- **Results are rows; one is open.** Each stored result's row always shows the drug, the outcome in words and the phenotype. The first
  result the API marks current opens when the page is read; a result that is not current is never opened for the reader. Only the open
  result reads its decision history, so a patient with twenty results makes one such read, not twenty.
- **The evidence is beside the result.** "Why this applies", "Show the source", "What is missing?" and, when there is something to say,
  "What changed?" are views of fields the stored result carries. Nothing is generated and nothing is taken from the knowledge loaded now.
  A gap in the guidelines is labelled apart from a gap in the patient's report, and a gene with no recorded state is never read as normal.
- **The decision form names its patient and drug.**

Two things a pharmacist decides before release: the table that says which reasons are about the report and which about the guidelines
(spec D11), and the new sentences (the reasons no decision can be recorded, the evidence panel's fixed lines).

Proved in the sealed sandbox: front-end typecheck, lint, build, `check:chunks` and `check:brand` pass; the front-end suite passes. Nine
controls each turn their tests red (tasks.md T205). **Not run:** every Playwright suite (the sandbox has no browser). The two-column
layout, the widened patient page and the row buttons were not seen in a browser.

**Before the pull request.** After slice 1 merged, this change was replayed on `main` as one commit; the code the controls ran on is
unchanged. On that commit the verify tier, the backend memory, PostgreSQL, PostgreSQL and S3 tiers and the worker tier passed in sealed
jobs, and the secret scan found nothing (the pull request has the counts). Slice 1's first hosted run failed on a link under the
44-pixel target, which no unit test measures, so this slice's one new control, the result's row button, was read against that rule: it
carries the control height, and so does the source link the evidence panel shows. That is a reading, not a measurement.
`decision-e2e/patient-decisions.spec.ts` gained one step by reading (open the row that is not current). No pull-request or nightly job
runs that suite, so it stays unverified until a person runs `playwright.decisions.config.ts` with a browser.
