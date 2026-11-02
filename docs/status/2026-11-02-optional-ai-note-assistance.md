# Optional AI assistance for follow-up notes
Date: 2026-11-02

Founder direction: inference can help with note-making, while the core product remains functional without inference. The [physician workflow plan](../design/plans/physician-chat-and-patient-record.md) now describes an explicit Help write note action, selected source context, an editable AI-assisted draft, original-text preservation and physician review before saving. Missing facts must not be invented; structured reminder dates remain physician-confirmed and scheduled by ordinary application code.

Manual records, uploads, follow-up documentation and reminders remain independent of model availability. The plan covers unavailable models, late responses, stale context, output review and synthetic evaluations. Documentation only: no model call, provider activation, patient-text transmission, spending or runtime implementation.
