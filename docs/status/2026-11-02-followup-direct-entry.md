# Direct entry from a reminder to its follow-up
Date: 2026-11-02

Each reminder in the chat-side Follow-ups panel now has an Open follow-up action. It opens the selected thread on the existing patient record and loads its current version independently of the patient's first list page. Clinicians get the documentation form for an open reminder, with visible patient/treatment context; reviewers get the recorded entry and history. Closed reminders stay read-only when opened through this shortcut.

The form keeps the loaded version while the physician writes. Concurrent changes remain subject to the existing server version check and retain the draft on refusal. Cancel/save clears only the selected-thread query parameter and returns to the normal patient follow-up section. Invalid, missing or wrong-patient targets show a safe error; interrupted reads can retry. Opening a link does not create an assessment or complete a reminder. The chat draft survives a return from the patient record.

Frontend routing/UI only: existing patient, history and recording APIs are reused, with no schema, clinical rule, inference provider or external notification change. [Plan](../design/plans/followup-direct-entry.md), [verification](../verification/followup-direct-entry.md).
