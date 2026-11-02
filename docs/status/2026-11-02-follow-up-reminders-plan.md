# Follow-up documentation with reminders
Date: 2026-11-02

Founder clarification: outcomes are easy follow-up documentation, with reminders so physicians do not forget. The [physician workflow plan](../design/plans/physician-chat-and-patient-record.md) now uses a patient-page Follow-up section, a short note, optional linked recommendation decision, next date and responsible clinician. Saving completes the current task and schedules the next reminder atomically. Due/overdue reminders appear in a compact chat panel and on the patient record; documenting, rescheduling and dismissing are distinct actions.

This is a requirements update. The existing queue/outbox/worker provides a foundation, but physician follow-up storage, reminder handlers and reminder UI are not implemented here. No reminder was scheduled or sent, and no external notification channel was connected.
