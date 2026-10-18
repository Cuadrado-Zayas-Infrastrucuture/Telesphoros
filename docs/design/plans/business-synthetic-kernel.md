# P1 synthetic business kernel — approved implementation scope

Approved by the founder on18 October2026: implement the exact memory-only synthetic business slice and inactive test vectors; report acceptance before a PR. Models,Harness²,deployment and spending remain disabled. The initial implementation authorization excluded a PR. The founder subsequently authorized reconciliation with current main and a draft PR after passing checks; merge and paid execution remain unauthorized.

Original approved base: `f3a112fbafb5fc683747a511e11685a4dbe86c63`. Reconciled base: `37d1e96c7e38c9eb9bd004b01e609df4b62dd36a` (PR #167 worker-test repair preserved without changes). Scope SHA-256: `d6bd70c866d7f2251c91642f5cc5635a6593aa80d1796a84d07d82b0af4d2fb7`.

## Boundary

Private @telesphoros/ai-service library; synthetic EN/ES SOP fixtures, fixed retrieval/draft/verifier/director graph, one repair, current fixture authority, byte-bound evidence, integer memory reservations, fenced memory state transitions and simulated audit/release. No API,UI,DB,S3,queue,worker,real authority,provider,model prompt,clinical input or production receipt.

Simulation outputs use synthetic.business-outcome.v1 and simulation: receipts. Scripted role callbacks are test-only implementations; no inference adapter exists. Canonical WorkflowPackage publication remains deferred; existing backend canonical JSON code is untouched. All runtime imports are local source,Zod or node:crypto.

Inactive vectors:120000ms,4logical role slots,28160projected tokens,250000allocated micro-units,1active per tenant/2fleet,1repair. Actual inference calls/tokens/charges0; pending scripted attempts are unknown and retain maximum reservation until observed. These are not live serving/cost measurements.

## Exact22-file allowlist

| File | Operation |
| --- | --- |
| `apps/ai-service/package.json` | ADD |
| `apps/ai-service/tsconfig.json` | ADD |
| `apps/ai-service/tsup.config.ts` | ADD |
| `apps/ai-service/eslint.config.mjs` | ADD |
| `apps/ai-service/vitest.config.mts` | ADD |
| `apps/ai-service/src/index.ts` | ADD |
| `apps/ai-service/src/contracts.ts` | ADD |
| `apps/ai-service/src/policy.ts` | ADD |
| `apps/ai-service/src/kernel.ts` | ADD |
| `apps/ai-service/src/budgets.ts` | ADD |
| `apps/ai-service/src/evidence.ts` | ADD |
| `apps/ai-service/test/helpers/memory-adapters.ts` | ADD |
| `apps/ai-service/test/fixtures/synthetic-sop.ts` | ADD |
| `apps/ai-service/test/contracts.test.ts` | ADD |
| `apps/ai-service/test/kernel.test.ts` | ADD |
| `apps/ai-service/test/budgets.test.ts` | ADD |
| `apps/ai-service/test/boundaries.test.ts` | ADD |
| `docs/design/plans/business-synthetic-kernel.md` | ADD |
| `docs/verification/business-synthetic-kernel.md` | ADD |
| `pnpm-lock.yaml` | MODIFY |
| `scripts/workspace-build/workspace.test.cjs` | MODIFY |
| `docs/STATUS.md` | MODIFY |

Workspace apps/* discovery and root recursive commands already include this package. Fixed producer list,root package manifest,CI and Docker stay unchanged. The lockfile adds only one importer,using existing resolutions.

## Executable contracts

RequestInput strict five-field parsing; immutable SyntheticWorkflowProfile; trusted Context/AuthorityPort; exact fixture source identities; CandidateDraft/DirectorVerdict; synthetic reservation/observation; Run/StorePort CAS; synthetic Outcome. Real model/corpus/evaluation admission,signatures,durable records,effects and live receipts remain P2/P3.

## Registered acceptance

29families,minimum58named negative/control cases. Each refusal has an independent positive control; hand-written expected bytes,counters,role order and grant/source maps are the oracle. One temporary guard defect per family must cause a named assertion failure,then be restored. Eight existing build-orchestration tests remain in place.

| ID | Refusal | Successful control | Guard defect |
| --- | --- | --- | --- |
| P1-01 | Add tenantId to the otherwise valid request. | Same request with only five allowed fields parses. | Remove strict unknown-field rejection. |
| P1-02 | Question includes a lone surrogate. | Well-formed 512-scalar fixture at permitted byte cap parses. | Remove surrogate validation. |
| P1-03 | Fixture admin has no business.sop.draft grant. | Same fixture actor with both explicit SOP grants completes EN and ES controls. | Treat admin role as business permission. |
| P1-04 | SOP lookup returns tenant-B source for tenant-A run. | Own entitled fixture source with same structural shape succeeds. | Skip source-owner/recipient intersection. |
| P1-05 | Barrier revokes fixture grant after admission, before source lookup. | No revocation passes current-authority check and lookup once. | Reuse admission snapshot for retrieval. |
| P1-06 | Revoke source eligibility after retrieval, before scripted draft callback. | Current eligible source permits scripted callback. | Remove post-retrieval currentness recheck. |
| P1-07 | Revoke requester after fixture director acceptance, before commitSimulation. | Unrevoked requester permits exact reviewed bytes. | Skip final authority check. |
| P1-08 | Revoke requester after simulated release, before same-run read/idempotent response. | Current authorized requester can read exact own fixture artifact. | Return cached body before auth check. |
| P1-09 | Reuse same tenant/requester/task/key with changed request bytes. | Same exact request returns same own simulated run; equal key in another scope never returns this body. | Key only by client idempotencyKey. |
| P1-10 | Profile override requests a fourth specialist. | Immutable retrieval/draft/verifier graph and director have allowed depth1/order. | Accept client-supplied graph/delegateRoles. |
| P1-11 | Available logical tokens cover draft but not both director allowances. | Full28160 token-vector capacity reserves once before first slot. | Reserve specialist only and allocate director later. |
| P1-12 | Three distinct tenants race for two fleet active slots. | Two active slots across distinct tenants pass; valid completion releases known-unused capacity. | Check then increment outside atomic memory store operation. |
| P1-13 | Advance injected clock past original120s, then reenter running state. | Complete just before original deadline with identical fixture work. | Reset deadline on transition/resume. |
| P1-14 | Evidence quote ends inside a multibyte UTF-8 character. | Exact source version/digest and aligned quote passes, EN/ES golden bytes. | Use JavaScript character indices as byte spans. |
| P1-15 | Fixture source asks the runtime to invoke an external send tool. | Ordinary admitted SOP query follows same immutable graph. | Dispatch an unregistered role/tool from source text. |
| P1-16 | Scripted director accepts a candidate whose recomputed body digest mismatches. | Same bytes/digests with mechanical pass permit valid review. | Let director accept override mechanical failure. |
| P1-17 | Scripted verdict references another candidate digest. | Verdict binds exact current run/candidate/evidence and own attempt. | Trust review digest without comparison. |
| P1-18 | One candidate claim has no verdict. | One supported verdict for every unique claim passes. | Count verdicts without verifying full claim-ID set. |
| P1-19 | Scripted director requests repair after the second draft. | One repair followed by valid second review can simulate release. | Reset repair count through a new child ID. |
| P1-20 | Late accepted scripted result uses old fence after cancellation. | Current fence completion before cancellation commits one outcome. | Ignore fence or allow outgoing terminal transition. |
| P1-21 | Audit port fails inside final commitSimulation. | Working audit commits matching outcome/audit/accounting in one memory operation. | Publish body then audit asynchronously. |
| P1-22 | Throw fixture error containing a unique synthetic canary from actor callback. | Non-content safe codes/run refs remain observable. | Serialize raw Error/message or source text into trace. |
| P1-23 | Scripted attempt lacks terminal usage observation. | Known synthetic attempt settles once with actualModelCalls=0; projected counters separate. | Default missing observation to0 and free reservation. |
| P1-24 | Run admitted before UTC day/month rollover continues after boundary. | New-window run uses new period while old active reservation still counts. | Clear active reservation on period rollover. |
| P1-25 | Change a role budget after the trusted fixture profile is registered. | Exact immutable profile/source byte identities pass. | Trust supplied profile digest after mutation. |
| P1-26 | Provide enable-model=true/provider endpoint or Harness2 activation field. | Fixture-only EN/ES workflow exercises scripted roles while live readiness remains MODEL_EXECUTION_DISABLED. | Add live provider fallback or environment enable path. |
| P1-27 | Add test/fixtures module to src/index.ts exports. | ESM/CJS/types exports contain allowed library API only; output is distinctly synthetic and no production ReleaseReceipt. | Export memory adapters/fixtures or real-release-shaped receipt. |
| P1-28 | Delete AI test script while root uses --if-present. | All four scripts present and root recursive workflow runs new workspace tasks; existing prebuild ordering preserved. | Remove manifest/script guard or successful placeholder test. |
| P1-29 | Scripted draft observation reports projected input+generated units above its role cap. | Exact role and28160 aggregate vector boundary passes; actual model tokens remain0. | Check only aggregate cap and ignore role cap. |

## Port trust and evidence

Memory adapters implement current grant/session/source checks and atomic commitSimulation with final current-authority guard,audit and reservation settlement. This proves calls/state math within one process,not Cognito,RLS,IAM,network isolation,crash durability or a production audit ledger. No frozen clinical or model evaluation is claimed.

## Verification

Run isolated typecheck/lint/test/build,build-orchestration,and root typecheck/lint/test/build/infra/CI/image guards; preserve full output and producer counts. Service tiers and six hosted required checks remain separate evidence before any later PR readiness. See [verification](../../verification/business-synthetic-kernel.md).
