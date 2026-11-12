# Tasks: identifier keys for drugs and genes (spec 039)

Date: 2026-11-12. None may start until `plan.md` is approved.

- [ ] T1 In a job, check that no existing test loads 1.2 and 1.3 guideline files of one drug into one set (IK-2); stop and report if one does.
- [ ] T2 Write the conflict fixtures and `identifier-map/expected.json` by hand; commit them before any code.
- [ ] T3 Write the new and added specs; run them and see them fail for the right reason.
- [ ] T4 Export `IDENTIFIER_FORMS` from `packages/cpic-schema`.
- [ ] T5 The four loader rules (IK-1, IK-2).
- [ ] T6 The four knowledge-set lookups (IK-3).
- [ ] T7 `identifier-map.ts` and its boundary spec (IK-4 to IK-6).
- [ ] T8 Deliberate breakages, one at a time, in a job.
- [ ] T9 Full local loop in sealed jobs, including the database and storage tier; gitleaks.
- [ ] T10 Verification record and clinical validation note.
