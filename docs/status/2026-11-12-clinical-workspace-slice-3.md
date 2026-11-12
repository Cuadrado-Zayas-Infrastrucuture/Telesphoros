# Clinical decision workspace, slice 3: decision with follow-up, source comparison, filter scope, render events

Date: 2026-11-12

Front end only, written and tested, **not released**. Specification: [specs/038-clinical-decision-workspace](../../specs/038-clinical-decision-workspace/spec.md)
(D14 to D18). It builds on slices 1 and 2. An AI tool (Claude Code) wrote this change.

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
