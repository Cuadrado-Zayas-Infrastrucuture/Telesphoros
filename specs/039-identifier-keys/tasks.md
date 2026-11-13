# Tasks: identifier keys for drugs and genes (spec 039)

Date: 2026-11-12. `plan.md` approved by the founder on 2026-11-12, with D1 to D9 as recommended.

- [x] T1 In a job, with IK-1 and IK-2 applied as a throwaway patch, list every existing test they refuse: once with the helper unchanged, and once with the helper changed as IK-7 says, so the signed copies cannot hide another refusal. Also list any test that pins the content hash of a signed test copy. Stop and report anything beyond the signed copies IK-7 names.
  - Done 2026-11-12 in sealed jobs, with the four loader rules and the constructor check as a throwaway patch (never committed). Nothing beyond the signed copies.
  - Helper unchanged: 24 tests refused, every one a signed copy from `reviewedCopyOf`: `knowledge-loader.spec.ts` 12, `knowledge-locate.spec.ts` 7, `recommendation-engine.spec.ts` 2, `cli.spec.ts` 1, `lab-reports.module.spec.ts` 1, `test/db/knowledge-signatures.pg-spec.ts` 1. Every problem they print is "the same RxNorm id for two drugs" (82 lines) or "the same HGNC id for two genes" (80); none is IK-2, "different RxNorm ids" or the constructor's check.
  - Helper changed (per-name ids): the default tier passes (166 suites, 2,257 tests, 32 suites skipped without Postgres); the Postgres and storage tier passes in shards 1/3 (104 suites, 1,503 tests) and 3/3 (104 suites, 1,604 tests, 1 skipped). Shard 2/3 had one failure, `test/lab-reports-capture.e2e-spec.ts` "while the CPUs are busy" (3 of the 4 batches it needs within 60 s). It fails the same way with no patch at all, run alone at 3 CPUs, so it is not this change; T9 runs it again.
  - Pinned hashes: no test pins the hash or set id of a signed copy. The helper-using specs hold no 64-hex literal, snapshot or old test id (the only hits are a floating-point value in `phenotype-engine.spec.ts` and the direct insert at `evaluation-result-identifiers.pg-spec.ts:194`, which does not use the helper), and every helper test passed with the ids changed.
- [ ] T2 Write the conflict fixtures and `identifier-map/` by hand; commit them before any code.
- [ ] T3 Write the new and added specs; run them and see them fail for the right reason.
- [ ] T4 Add `isRxcuiForm` to `packages/cpic-schema`, and change `toSchema13` (IK-7).
- [ ] T5 The four loader rules (IK-1, IK-2).
- [ ] T6 The four knowledge-set lookups (IK-3).
- [ ] T7 `identifier-map.ts` and its boundary spec (IK-4 to IK-6).
- [ ] T8 Deliberate breakages, one at a time, in a job.
- [ ] T9 Full local loop in sealed jobs, including the database and storage tier; gitleaks.
- [ ] T10 Verification record and clinical validation note.
