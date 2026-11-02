# Report attachment details over chat
Date: 2026-11-02

Selecting or dropping a report in `/workspace` now opens a compact accessible dialog for patient, optional note and synthetic confirmation. Dismissal preserves the attachment; confirming starts the existing upload protocol and displays progress/status in the conversation. The ordinary Upload navigation item is removed; Reports upload actions point to chat. Legacy upload/recovery routes remain.

This is the initial [chat intake slice](../design/plans/chat-report-details.md), not completion of the founder's expanded [chat and patient-record design](../design/plans/physician-chat-and-patient-record.md). Moving all patient creation to the patient page, replacing other clinical navigation with panels, preserving drafts across patient navigation, and recording both treatment outcomes and recommendation decisions remain planned.

Verification: 685 frontend tests and two actual PostgreSQL/Moto browser flows passed, including desktop/mobile accessibility, draft dismissal/reopening, explicit confirmation and one uploaded report. Typecheck and build passed. Broader repository checks retain unrelated process-cleanup and process-start failures; details are in [verification](../verification/chat-report-details.md). No clinical processing, schema or deployment change.
