# Unfinished uploads say so and can be cancelled or removed

Date: 2026-11-05

A report is registered before its file is sent, so every upload that failed on synthetic staging (2026-11-05) left a record behind. The chat panel's "Past reports" showed each one as "Received", the word for a report the system has, although its file never arrived. A failed upload could not be cancelled from the chat, although its own message said to cancel before starting over. A file attached to the message box could be removed only from inside the "Report details" panel.

What changed, frontend only:

- A report with no stored file (`fileUploaded: false`, already in the report list) reads "Upload not finished" in "Past reports", in the drawer of the same name and on the Reports page.
- Such a report has "Remove", with a second step to confirm. `removeUnfinishedReport` reads the report again first and refuses one whose file is stored; it then calls the existing `DELETE /reports/:id`.
- After a failed upload, "Report details" offers "Cancel upload". It asks the server to cancel the attempt (the existing `cancelOwnedUpload`, which requires the server's acknowledgement) and only then removes the report that never got its file. If the server does not acknowledge, nothing is removed and the reason is shown.
- The attached-file chip in the message box has its own remove button, with the same Undo as removal from the details panel.

Verification, Node 22.22.0: frontend lint, typecheck, `test` (776 tests, 55 script checks) and `format:check` pass. Six deliberate breaks each turned a test red: the status word ignoring `fileUploaded`, the chip's remove button missing, the cancel skipped before removal, removal after a refused cancel, a stored report not refused, and removal offered for a stored report. Files restored.

Not done: the backend still lets `DELETE /reports/:id` remove any report, including one with its file, a review or an assessment; only this screen limits it to unfinished uploads. Whether, and how, a stored report can be withdrawn is a records decision for the founder. Removing a report a person uploaded by mistake, after its file arrived, is therefore still not offered.
