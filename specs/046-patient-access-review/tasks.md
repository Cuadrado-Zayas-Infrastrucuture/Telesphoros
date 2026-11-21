# Tasks: Patient access review (spec 046, working number)

| Task | Owner | Exit condition | State |
| --- | --- | --- | --- |
| T1 | Founder | Chooses (a) and approves the revised plan | Done 2026-11-21 |
| T2 | Maintainer | Database, API, interceptor, route-map and Settings tests written and seen to fail before the code | Done 2026-11-21 on `ef7f8eb4` with the tests only: PostgreSQL run 5 of 5 suites failed (11 tests: the function's four cases, the API flow, the interceptor's list patient, `./route-keys` missing); memory e2e 3 of 3 failed; the Settings test could not load |
| T3 | Maintainer | Migration 0076, the interceptor line, the route and export, shared types, the Settings section; the tests pass | Done: PostgreSQL 25 of 25 (database 4, API 3, e2e 3, interceptor, route keys), memory 18 of 18, frontend 23 of 23 (section 5, Settings with the two new cases); typecheck, lint, format clean; `UPDATE_ROUTE_SET=1` regenerated the two hand-written route lines exactly. The API test switches the lab-report pipeline on: with it off, the evaluation routes answer 503 at their gate guard, before the audit interceptor runs, so no row is written |
| T4 | Maintainer | Each new check broken once, its test seen red, then restored | Done: 13 breakages, all red (no tenant filter, no admin check, writes returned, no cap, any role as admin, the app calling the admin check, the list recording no patient, every route taking the query patientId, an unclassified evaluation read, a clinician reviewing, member rows not resolved, a failure shown as no reads, the section shown to everyone) |
| T5 | Maintainer | Full local loop; gitleaks | Done 2026-11-21: `tele_loop.py <wt> pr` chose every tier (18 backend inputs, 4 worker inputs); all exited 0. Verify: 0 failing (CI configuration 245, infrastructure 478, scripts 57, frontend 97 files); memory 3,733 passed; PostgreSQL 2,012 and 2,381; PostgreSQL + S3 2,092 and 2,407; worker passed; no failed suite. gitleaks clean over the branch, its control flagged a planted token. Browser tier not run |
| T6 | Founder | Retention, custody and reviewer cadence of `security_audit_events` (AR-7); push on his word | Open |

Migration number: 0076 here, because versions must be contiguous (`apps/backend/src/db/migrator.ts:81`). The local follow-up closure branch
(spec 045) also holds 0076; whichever merges later renumbers.
