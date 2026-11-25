# Plan: the usability protocol tests the app as it is now

Date: 2026-11-25

Plan only. The protocol for the founders' moderated sessions (F5) was written for spec 038, before the worklist home, Help, patient search,
the genomic profile and the medication notices. Tasks 2, 4 and 10 now test answers that have changed. Task 4's "the medication list was
not used" has two readings since the notices arrived. The plan rewrites five tasks and adds two: the notice (task 11) and the drug check
(task 12).

Found while planning: no session build can show a notice today, because the API loads only signed modifier lists and the synthetic ones
are unsigned. Three decisions are waiting: the session length (UP-D1), task 4's pass criterion (UP-D2) and the session data for the
notice (UP-D3).

Record: [the plan](../design/plans/usability-protocol-refresh.md). No code, test, fixture or protocol change yet.
