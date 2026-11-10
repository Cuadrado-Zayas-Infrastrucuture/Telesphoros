# Tasks: Follow-up forms say when recording is paused

One API read, one shared type, front-end changes. No schema, migration, deployment setting or infrastructure change. The plan is the decisions in [spec.md](spec.md).

- [x] T001 Shared types (D2, D6): `followupAvailabilitySchema`, `FollowupAvailability`, `FOLLOWUP_WRITES_PAUSED`.
- [x] T002 API (D2, D6): `FollowupsService.recordingEnabled()` used by the write and by `GET /followups/availability`; the paused 503 carries the reason; `test/route-set.json` lists the route.
- [x] T003 API tests: the paused-writes test in `patient-followups.e2e-spec.ts` also asserts the reason and the availability answer in all three states (setting off; setting on; setting on in production mode).
- [x] T004 Front end (D3-D6): `readFollowupAvailability` and the 503 wording in `lib/patientFollowups.ts`; `useFollowupRecording`; `FollowupsSection` and `FollowupsList` honor `paused`.
- [x] T005 Front-end tests: `lib/patientFollowups.test.ts` and `components/patients/FollowupsSection.test.tsx` (on, paused, a form link while paused, an API without the read). The paused tests fail when the pause is neutralized.
- [x] T006 Walked 2026-11-10 in a production-style build (`vite build --mode e2e`, API on a synthetic PostgreSQL, `FOLLOWUP_WRITES` unset): the patient record's Follow-up section showed the notice, the list and Refresh, and no form button; `GET /followups/availability` answered 200. Not walked in the browser: the recording-on state (covered by the unit and API tests).
- [x] T007 Local results 2026-11-10: `pnpm typecheck` clean; `pnpm lint` clean; front end 81 files, 1006 tests passed; API `patient-followups.e2e-spec.ts` and `route-set.e2e-spec.ts` 28 passed on PostgreSQL 16. Controls: the two paused front-end tests fail with the pause neutralized; the route-list test fails without the new entry.
- [ ] T008 Before the PR: the remaining CI tiers locally and gitleaks 8.30.1 over the branch.
