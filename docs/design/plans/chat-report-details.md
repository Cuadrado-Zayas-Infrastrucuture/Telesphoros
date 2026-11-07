# Chat-first report intake

Date: 2026-11-02

Founder direction: chat is the primary UI. Choosing or dropping a report opens a small details view; complete remaining information there before upload. Upload is not a separate destination in ordinary navigation.

Implementation: reuse the existing chat intake, patient picker, patient creation, synthetic confirmation and upload protocol. Move the attachment details into the shared accessible modal drawer, preserving the file and note when dismissed. Sending from the chat with a pending file reopens its details; only confirmation there starts transfer. Close after successful transfer and display progress/status in the conversation. Remove the separate upload navigation item and point Reports upload actions at chat. Retain the legacy page temporarily for existing recovery links and old clients; retiring its recovery protocol requires a separate migration, not deleting a valid recovery path.

No backend, clinical, model, schema, deployed setting, branding or permission change. Remaining information means the fields already required for intake: patient selection or a synthetic patient label, file identity/type and synthetic-only confirmation. Existing demographics remain on the patient record.

Verify attachment opens a dialog without sending, dismissal retains the draft, reopening requires explicit confirmation, and upload succeeds back in the conversation. Keep existing role, validation, retry and cancellation assertions. Run focused tests before/after, shared navigation tests, browser checks on mobile/desktop and required repository checks. Show the actual chat and open form to the founder before publishing. No deployment or merge is authorized by this slice.
