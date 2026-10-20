# P1 synthetic business kernel — local verification

**P1 pure-memory acceptance passed on18 October2026 (historical counts below, base `37d1e96`). Restarted on 2026-10-20 on branch `feat/synthetic-business-kernel-p1` off `main` `0f0aff4`; see the last section for what was re-run. No merge authorized.** User approved the exact22-file slice and inactive test vectors. No model,Harness²,deployment or spending activation.

## Producer evidence

| Check | Actual result |
| --- | --- |
| Runtime | Node22.22.0,Unicode16.0 (matches CI pin) |
| P1 package acceptance |56passed,0failed,0skipped across4files |
| Build orchestration |10passed,0failed,0skipped;2new P1 cases plus8existing |
| P1 registry coverage |29families;all58registered refusal/control names passed |
| Guard defects |29/29families killed by named assertions under pinned runtime;31distinct guard proofs including source-only entitlement and safe-integer overflow;all mutants restored |
| Package typecheck/lint/build |Passed;ESM,CJS,and both declaration formats |
| Root typecheck/lint/test/build |All passed;AI package discovered by recursive commands |
| Infrastructure guards |119passed,0failed |
| CI configuration guards |144passed,0failed |
| Image guards |23passed,0failed |

Each mutation has its patch,original/mutant hash,full stdout/stderr,producer exit and named assertion failures retained in the local implementation evidence bundle. The final baseline was rerun after restoring mutants. The source-only entitlement case keeps business grants intact and removes source entitlement before draft dispatch.

## Exact commands

```text
pnpm --filter @telesphoros/ai-service typecheck
pnpm --filter @telesphoros/ai-service lint
pnpm --filter @telesphoros/ai-service test --reporter=json --outputFile=<owned-evidence>/acceptance-final.report.json
pnpm --filter @telesphoros/ai-service build
pnpm test:build-orchestration
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:infra
pnpm test:ci-config
pnpm test:image
```

## Failures and repairs preserved

- Final numeric boundary review found that two individually safe integer observations could overflow their aggregate. Unsafe sums now become unknown and retain the full reservation. A dedicated boundary assertion and temporary removal of this guard proved the repair.

- Initial TypeScript checking exposed an ES2023 library declaration mismatch for the Node string well-formedness primitive. The new package uses ES2024 declarations with ES2022 output;Node22supports that primitive. Type checking now passes.
- Offline lock-only resolution lacked cached metadata. The new importer therefore copies only existing reviewed specifier/resolution pairs. All prior importers,package snapshots and overrides are byte-identical.
- Frozen offline install accepted the lockfile but lacked an esbuild0.28.2 tarball. No download or version change was made. Validation used isolated APFS copies of the existing installed dependency tree,with the new importer linked to exact existing versions. A clean frozen installation remains unverified locally.
- Restricted sandbox runs could not bind loopback or inspect native process identity. Native process/loopback tests were rerun with local permissions and without cloud credentials/service endpoints.
- An initial Node24run used Unicode17and failed the backend's explicit Unicode16guard;one native CLI test also failed to reach readiness. After switching to installed,CI-pinned Node22.22.0,all root checks above passed without changing excluded files. Earlier failures remain in the evidence bundle.

## Evidence limits

Root memory tests explicitly skipped11backend database/object-store suites (253tests). Worker PostgreSQL/S3 files were not selected because their service endpoints were absent. No real DB/S3/IAM/Cognito,production outbox/worker,hosted CI,Linux service profile,clinical validation,model inference/quality/tokenizer/cost/readiness or deployment test is claimed. These local checks do not establish production readiness.

Inference calls,tokens and charges are0because no model adapter exists. Scripted projected attempts are separately tracked,including unknown states that retain reservations. This is not remote provider metering or OS egress certification. No API/UI or product consumer was added.

[Approved scope and registered acceptance](../design/plans/business-synthetic-kernel.md). Local full evidence is retained under the implementing chat's `work/p1-evidence`;the external results packet supplies hashes,per-family results and a reviewable patch. No raw test log or environment value is included here.

## Current-main reconciliation and draft delivery

The founder authorized reconciliation and a draft PR on 18 October 2026. Main advanced only through PR #167, adding worker settlement tests and documentation. Those changes are preserved. The approved 22-file P1 delta, runtime sources, inactive vectors and acceptance cases are unchanged; the overlapping STATUS document retains both entries. The complete 12-command local verification matrix is rerun against this reconciled tree, with full producer receipts in the separate reconciliation report.

The first attempt's draft head used `[skip ci]` to preserve a no-spend instruction. That attempt (PR #169) was closed unmerged on 2026-10-20. The restart drops the skip instruction because the founder authorized hosted CI for this draft PR on 2026-10-20. No workflow, ruleset or required gate is changed. Merge readiness is not claimed. Models, Harness², deployment and spending remain disabled.

## Restart verification (2026-10-20)

Branch `feat/synthetic-business-kernel-p1` off `main` `0f0aff4`, local run on Node 22.22.0 with an owned PostgreSQL 16 and a moto S3 emulator. The counts above are from the first attempt and are not reused.

| Check | Result |
| --- | --- |
| Install (frozen lockfile), typecheck, lint | Passed |
| Workspace tests | Passed; `apps/ai-service` 61 passed (56 from the first attempt plus 5 added below) |
| `test:infra`, `test:ci-config` | Passed |
| Backend memory tier | 2314 passed |
| Backend PostgreSQL tier | 2549 passed on the final tree. An earlier run on the commit before the added tests had 1 failure, `offsite-restore.pg-spec.ts`, which counts `restore-*` directories in the shared OS temp directory before and after and so depends on no other process touching it. This branch changes no backend file; the rerun on a quiet machine passed |
| Backend PostgreSQL + S3 tier | 2569 passed |
| Worker | 169 passed |
| `tofu test` | Fails locally (OpenTofu 1.12.6 against CI's Terraform 1.16.5), as on every branch; this branch changes no `infrastructure/` file |

The memory tier, S3 tier and worker ran on the kernel commit before the five tests below were added; those tests touch only `apps/ai-service`.

**Injected-defect checks (10 planted defects, kernel budget and fence code):** 8 caught by a named assertion, 2 survived and are equivalent. Five were caught on the first pass (slot cap, duplicate-usage guard, unknown-usage guard, fleet cap, commit-time authority recheck). Three survived because no test exercised the guard (reserving a completed run again, a changed authority generation alone, a fence change alone), so five tests were added and those three are now caught. The two survivors are redundant by construction: the total-token ceiling is already implied by the four-slot cap and the per-role caps (2 x 4864 + 2 x 9216 = 28160), and the repair-cap check is already implied by the two-pass loop bound with the same reason code.

**Not verified:** hosted CI; browser end-to-end tests; any model, database adapter, API, UI or job integration (none exists); production readiness; the first attempt's strict-$2 hosted-cost and app-event gate (see STATUS).
