# Patient medications UI (MD-b)

The patient page now has a capture-only Medications section. Compact rows show active entries first, source and optional year-month dates, with a local filter and active/stopped counts. Details opens clinician actions and version history. The layout was revised against a real 20-medication fixture after founder feedback about large cards.

Clinicians can add, stop and correct coded ingredients from the bundled list through a local type-ahead picker with prefix-ranked suggestions, keyboard/touch choice and no silent selection. The shared FDA Tall Man presentation keeps plain accessible names. Retries retain request IDs; stale corrections retain the draft and require reloading the current entry. Clinical readers see records and earlier versions without write actions; administrators and members without clinical roles do not see the patient page.

No clinical interpretation, drug–gene flags, backend schema or deployment change. See [verification](../verification/patient-medications-ui.md).
