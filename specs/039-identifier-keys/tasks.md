# Tasks: identifier keys for drugs and genes (spec 039)

Date: 2026-11-12. `plan.md` approved by the founder on 2026-11-12, with D1 to D9 as recommended.

- [ ] T1 In a job, with IK-1 and IK-2 applied as a throwaway patch, list every existing test they refuse: once with the helper unchanged, and once with the helper changed as IK-7 says, so the signed copies cannot hide another refusal. Also list any test that pins the content hash of a signed test copy. Stop and report anything beyond the signed copies IK-7 names.
- [ ] T2 Write the conflict fixtures and `identifier-map/` by hand; commit them before any code.
- [ ] T3 Write the new and added specs; run them and see them fail for the right reason.
- [ ] T4 Add `isRxcuiForm` to `packages/cpic-schema`, and change `toSchema13` (IK-7).
- [ ] T5 The four loader rules (IK-1, IK-2).
- [ ] T6 The four knowledge-set lookups (IK-3).
- [ ] T7 `identifier-map.ts` and its boundary spec (IK-4 to IK-6).
- [ ] T8 Deliberate breakages, one at a time, in a job.
- [ ] T9 Full local loop in sealed jobs, including the database and storage tier; gitleaks.
- [ ] T10 Verification record and clinical validation note.
