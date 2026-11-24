# Spanish for the "identity could not be loaded" wording: the plan

Date: 2026-11-24

A plan, `docs/design/plans/patient-identity-spanish.md`, for the Spanish of the five strings the patient page shows when the identity
cannot be read (#454). The signed-in app has no language choice and no localisation layer yet, so Spanish text on its own would never be
shown. Three decisions are put to the founder:

- S-D1, what the slice ships. The recommendation records the founders' signed Spanish beside the English, tested and not shown, until the
  app has a language choice.
- S-D2, a separate spec for Spanish in the signed-in app.
- S-D3, who writes and signs. The recommendation is the two pharmacist founders, with no machine translation.

The plan proposes no Spanish text. The founder approved S-D1 to S-D3 as recommended on 2026-11-24. The next step waits for the founders'
signed Spanish. No code change.
