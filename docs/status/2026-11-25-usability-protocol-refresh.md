# The usability protocol tests the app as it is now

Date: 2026-11-25

Built from the plan the founder approved on 2026-11-25 (UP-D1 to UP-D3 as recommended,
[plan](../design/plans/usability-protocol-refresh.md)). `docs/design/clinical-workspace-usability-protocol.md` now:

- runs twelve tasks in one session, each naming the spec it tests;
- has tasks 1, 2, 9 and 10 on the current screens: patient search, Help, and the worklist with its held results;
- passes task 4 when the participant says the guidance rests on the genes alone;
- adds task 11 (the medication notice) and task 12 (the drug check before prescribing). In a synthetic build the notice shows on the
  gene's card only, and the check says no guideline is loaded, because medications are real RxNorm drugs and the guidelines' ids are
  invented. The protocol says so, so neither surprises the moderator;
- skips task 11, and records the skip, until a build loads a test-signed synthetic modifier list;
- covers the Help and glossary drawers in the accessibility pass, and lists the notice, glossary and Help wording among what a
  pharmacist approves.

Open:
- the slice that prepares a test-signed list for sessions, which gets its own plan;
- the sessions themselves (F5).

No code, test or fixture change.
