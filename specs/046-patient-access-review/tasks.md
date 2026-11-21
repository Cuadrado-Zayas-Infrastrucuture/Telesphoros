# Tasks: Patient access review (spec 046, working number)

| Task | Owner | Exit condition | State |
| --- | --- | --- | --- |
| T1 | Founder | Chooses (a) and approves the revised plan | Done 2026-11-21 |
| T2 | Maintainer | Database, API, interceptor, route-map and Settings tests written and seen to fail before the code | Open |
| T3 | Maintainer | Migration 0076, the interceptor line, the route and export, shared types, the Settings section; the tests pass | Open |
| T4 | Maintainer | Each new check broken once, its test seen red, then restored | Open |
| T5 | Maintainer | Full local loop; gitleaks | Open |
| T6 | Founder | Retention, custody and reviewer cadence of `security_audit_events` (AR-7); push on his word | Open |

Migration number: 0076 here, because versions must be contiguous (`apps/backend/src/db/migrator.ts:81`). The local follow-up closure branch
(spec 045) also holds 0076; whichever merges later renumbers.
