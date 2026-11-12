# Clinical decision workspace, slice 3: decision with follow-up, source comparison, filter scope, render events

Date: 2026-11-12

Front end only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md)
(D14 to D18). It builds on slices 1 and 2, which are merged (pull requests #384 and #385). An AI tool (Claude Code) wrote this change.

- **A decision can lead straight to its follow-up.** A new decision offers "Then schedule a linked follow-up (optional)". They stay two
  saves: the decision first, then the existing follow-up form as step 2, opened only for the decision the server stored. Each outcome is
  reported. A failed follow-up save is retried alone, as the same request. A cancelled one leaves "Decision saved. No follow-up was
  scheduled, so no reminder exists for it." Nothing makes a follow-up required, and nothing here enables follow-up recording where it is
  paused: there the option is not offered and the form says why.
- **The review-by date says what it does.** It records an intention and creates no reminder; it is offered to step 2 as the follow-up's
  date.
- **Conflicting sources are compared beside the choice.** Report id, which upload, revision, saved time and findings held, from the saved
  history. What each source reports for a finding is not in that history, and the table says so.
- **The patient filter says how far it reaches.** It searches the loaded pages; no server search exists.
- **The open result's display is measured** (specs/019), in builds where decisions are on. Display is not reading, agreement or a
  decision. The queue now stops for the session when the API says the route is switched off, instead of retrying a refusal.

Proved in the sealed sandbox: front-end typecheck, lint, build, `check:chunks` and `check:brand` pass; the front-end suite passes twice
in a row. Nine controls each turn their tests red (tasks.md T306). **Not run:** every Playwright suite (the sandbox has no browser), and
nothing against a real API: the new flow is proved against a stand-in for the HTTP boundary only.

**Before the pull request.** After slice 2 merged, this change was replayed on `main` as one commit. On that commit the verify tier, the
backend memory and PostgreSQL tiers and the worker tier passed in sealed jobs, and the secret scan found nothing (the pull request has
the counts). In the PostgreSQL and S3 tier, shards 1 and 3 passed. In shard 2 one test failed in both runs, the second with no other
job running: `test/lab-reports-capture.e2e-spec.ts`, the race "while the CPUs are busy", requires four raced batches inside its
60-second budget and the sandbox fitted three. No request in it returned a wrong answer. Run as a file on its own it passed, with
exactly four. This change touches no backend file, and the same backend code passed that shard on slice 2's commit. Why the sandbox
sits at that floor is not established.

The hosted browser suites were read against this change, not run: `e2e/result-renders.spec.ts` uses the summary region's default name
and never answers 503, so neither the new name setting nor the new stop rule reaches it, and no hosted suite touches the patient
filter or the conflicting-sources review. This slice adds no link or button; its new controls are the shared checkbox and input.
`decision-e2e` and `product-demo-e2e` were read the same way (the names they select by are unchanged), and no hosted job runs them.
