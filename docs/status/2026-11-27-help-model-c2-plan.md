# Spec 053 slice C2: plan for Help's model path, dormant

Date: 2026-11-27

[The plan](../../specs/053-help-chat/plan-slice-c2.md) builds the help lane in three pull requests, with a scripted stand-in as the only
model and nothing in the product calling it:
- **C2a** moves the refusal rule and the search into `packages/help-content`, so the browser and the server share one copy. Nothing on
  screen changes.
- **C2b** adds the help task, prompt, output contract, checks HC1 to HC6 and `runHelpAnswer` with its fallback to the curated answer, in
  `apps/ai-service`.
- **C2c** adds the evaluation set and the help gate in `verify`.

Open for the founder: C2-D1 (the evaluation corpus while no article is signed), C2-D2 (three PRs or one) and C2-D3 (who drafts the
evaluation questions). Plan only: no code or test change.
