# Tasks: patient search on the server (spec 040)

Date: 2026-11-13. `plan.md` approved by the founder on 2026-11-13, with D1 to D5 as recommended.

## Slice A: the API and shared types

- [ ] A1 T0 against the API as it is (`a4de0bee`), in a sealed job, on the in-memory and PostgreSQL tiers: `GET /patients?labelContains=SYN`
  answers 400, and the existing `sort=label` case passes. If it answers 200, stop and bring it back to the founder (plan, T0).
- [ ] A2 Write T1 to T10; run them against the code as it is and see each fail for the reason it tests (T5's refusals and T8's
  past-the-schema calls may pass today; say which).
- [ ] A3 `patientLabelSearchSchema` and `labelContains` in `packages/shared-types` (PS-1, PS-6).
- [ ] A4 The repository contract, the in-memory list and the PostgreSQL list (PS-2, PS-3, PS-4, PS-7, PS-9); the service passes the
  parameter through.
- [ ] A5 Deliberate breakages, one at a time, after a control run that passes (plan, "Deliberate breakages (slice A)").
- [ ] A6 Full local loop in sealed jobs, including the database and storage tier in its shards and the query-plan suite; gitleaks.
- [ ] A7 `docs/lab-report-reader.md:247`; verification record; status fragment.

## Slice B: the roster (after slice A's PR)

- [ ] B1 to B5, written from the plan when slice A is merged.

## Slice C: the two pickers (after slice B's PR)

- [ ] C1 to C4, written from the plan when slice B is merged.
