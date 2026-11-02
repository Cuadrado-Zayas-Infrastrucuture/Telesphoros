# Chat report details verification

Date: 2026-11-02

Local changes on `docs/investor-demo-preparation`, application base `e07619ec`. AI-assisted implementation. The founder requested chat as the primary UI, a small attachment-details view before upload, and subsequently clarified a patient-only separate clinical page with both treatment outcomes and recommendation decisions. The last requirement is captured in the [expanded design](../design/plans/physician-chat-and-patient-record.md); this record covers only the initial intake-dialog slice.

Current consolidation evidence is in [physician workspace verification](physician-workspace.md). The counts below describe the earlier intake-dialog checkpoint.

## Evidence

- Two new behavioral unit tests failed first because the attachment did not open a dialog. Both passed after implementation. They check no upload on selection, draft preservation across dismissal, explicit confirmation and returning status to the conversation.
- Frontend suite: 62 files, 685 tests passed, including existing role, retry, cancellation and validation controls. Existing HTTP/submission mocks in the UI unit tests remain; the browser flow below uses real local services.
- Two browser cases passed at 375×812 and 1280×800 using the owned PostgreSQL 16.13/Moto 5.2.4 stack, fake identity provider and real API. They verify no report declaration before confirmation, dismiss/reopen, one declaration, received status in chat, no route change, axe WCAG A/AA checks and no horizontal overflow.
- Desktop and mobile screenshots were opened and visually inspected. Copies: `/workspace/investor-demo-assets/chat-intake/desktop.png` and `mobile.png`.
- Product build, workspace build and typecheck passed. Lint identified a missing explicit note-label association; it was corrected and the full lint/format run passed. The final lint run is recorded in `/tmp/telesphoros-investor-tools/chat-lint-verified.log`.
- Default full workspace tests failed in the backend subprocess-tree timeout cleanup control: backend 2,076 passed, 1 failed, 451 skipped; 155 suites passed, 1 failed, 25 skipped. The optional reader and unconfigured full database/S3 tiers were not run. This failure was also present before this UI work.
- Infrastructure: 283 passed, 2 failed with `spawnSync git EPIPE` in unchanged Git-ignore guard controls. CI config: 216 passed, 1 process-signal timing failure. Focused rerun of those two guard files: 45 passed, 1 `spawnSync git EPIPE` failure in another unchanged Git-ignore control; the CI signal case passed on rerun. These runs do not establish a fully green repository.
- Existing full workspace-home browser coverage was updated for the new navigation/button labels but not run in full. The two new actual-storage cases are the browser evidence for this slice.

The owned run `3cd30e88-73dc-41a3-aaf7-24c8f654eab7` used synthetic data with clinical processing disabled. Its exact blast-radius document was reviewed before UUID-scoped teardown, which returned `Owned teardown verified`. No AWS, model, clinical knowledge, schema or deployment change occurred.

The final explicit label association was added after browser capture; it changes no layout or upload behavior. It is checked by lint, not a second browser recording. Patient creation is still available in the existing label-only attachment path and sidebar. Outcomes persistence and the final two-screen navigation are not implemented by this slice. At that checkpoint, nothing had been committed, pushed or merged.
