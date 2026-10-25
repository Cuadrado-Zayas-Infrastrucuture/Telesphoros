# Tasks: A harness that lets a model explain a verified engine result, and nothing else (HARN)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder**. It is not approved yet, so `/speckit-implement` must not run against this file until it is. Decisions D1 to D10 were made on 2026-10-25; D8 (the numeric thresholds) is a decision to take after phase 1 produces numbers.

**Tests**: Required by the spec (SC-001 to SC-008). In each phase the test tasks come first, and each must be seen failing before the implementation lands.

**Organization**: One phase per slice in plan.md, one draft PR per phase off `main`, never stacked. `[P]` marks tasks that can run in parallel within a phase (different files, no dependency). Hosted CI is capped at 3 runs per PR.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Slice 1, the evaluation harness, the sensors and the gate (US1, US2, US3, US4) — needs D7; D8 later

### Tests first

- [ ] T001 [P] [US1] `evals/golden/` holds at least 60 hand-written cases from the synthetic fixtures. Each has the engine result, a candidate explanation, and the expected release or hold with the reason. Seeded wrong kinds: invented drug, changed strength, flipped direction, added number, dropped caveat, wrong gene, advice beyond the guideline. The founder marks a sample before they count (D5). **First cut done (34 cases, none marked by the pharmacist); the 60 is still to reach.**
- [ ] T002 [P] [US3] `evals/attacks/` holds at least 30 attacks (hostile report fields, instructions in a phenotype string, a file name, a note, a locale value, markup, a request to reveal the prompt). A scripted model obeys every instruction it sees; the expectation is "no effect". **First cut done (18 attacks); the 30 is still to reach.**
- [x] T003 [P] [US1] One unit file per sensor S1 to S6 with hand-written positive and negative cases, and a **broken copy** of each sensor that the test must catch.
- [x] T004 [P] [US3] The prompt-provenance test: build prompts from hostile inputs and fail if any string is not derived from the closed set of FR-001.
- [x] T005 [P] [US2] One test per engine outcome and reason code: no model port call and the fixed text (control: a `shown` result does call the port).
- [x] T006 [P] [US4] A gate test: remove one sensor's check, then change a template without its digest. Each turns the runner red.

### Implementation

- [x] T007 `src/model-clients/` : `ModelPort` and a scripted stand-in (correct, wrong and obedient modes). No network. The port has no tool parameter, and a test fails if one is added (LLM06).
- [x] T008 `src/evaluators/` : sensors S1 to S6, the glossary file with its digest, the contradiction lexicon with its digest.
- [x] T009 `src/prompts/` : the first template and the provenance builder. The template digest is checked by a test.
- [x] T010 `src/fallback.ts` : fixed text per outcome and reason code.
- [x] T011 `evals/run.ts` : runs the cases through the real sensors and compares to the expectation; prints counts (cases, held, released, wrongly released), never case text.
- [x] T012 Wire `evals/run.ts` into the existing `verify` job and add its paths to `.github/ci/scope.mjs` so a harness change selects it (D7). `test:ci-config` covers the scope rule with a broken copy. **Done differently: no `scope.mjs` change was needed. Any non-docs change already runs `verify` in full; T044 pins that.**
- [x] T013 `docs/verification/` record: what ran, counts, what was skipped.
- [x] T044 [P] [US4] Test first: changing the model ID, SDK version, decoding setting or token cap in any file that holds it selects the evaluation gate (FR-013); the test goes red when that file is dropped from the scope rule. Then add those files to `.github/ci/scope.mjs` with the T012 change.
- [ ] T045 The OWASP coverage table in spec.md is checked against the tests that exist: a row naming a test that does not exist fails review; `docs/verification/` records any row still empty.

**Checkpoint**: the founder reviews the first golden cases and the sensor list before any contract change.

## Phase 2: Slice 2, the explanation contract and the failure path (US1, US2, US5, US7)

### Tests first

- [x] T014 [P] [US5] One test per failure reason code (timeout, invalid structure, cap, authority lost, sensor hold, verifier hold, refusal): the engine text is returned unchanged and no model-written word is.
- [x] T015 [P] [US7] The readiness gate: with each FR-012 condition false in turn, `liveReadiness()` stays closed.
- [x] T016 [P] R1 `phi` data class declared in code; a test fails when a task has no declaration or reaches a provider without a BAA; synthetic-only marker refused if absent.
- [x] T017 [P] R2 each output guard has a production caller; a test fails when one has none.
- [x] T018 [P] R4 each task's output class is declared and its listed checks match.

### Implementation

- [x] T019 `src/contracts.ts` : explanation, statement (`quote`, `restate`, `gloss`) and verdict schemas; no markup, links or code (FR-003, FR-015). The v1 schemas are untouched. **Done in `src/explain-contracts.ts` and `src/evaluators/types.ts`, not `contracts.ts`: the synthetic contracts fix `purpose` to `business-assistance`.**
- [x] T020 `src/explain.ts` : `runExplanation`, reusing admission, fencing, idempotency, caps and boundary checks from the kernel (FR-007).
- [x] T021 `src/policy.ts` : the readiness conditions; the code reads `PGX_CLINICAL_HOLD_LIFTED`, which today nothing reads. **Done as `readiness(conditions)` in `policy.ts`: the boundary guard bans `process` in `src`, so the flag is passed in; the env read moves to the Bedrock adapter.**
- [x] T022 Break each of R1, R2 and R4 on purpose and record the red run.

## Phase 3: Slice 3, outcome v2, real counters, trace and receipt (US6) — needs D6; a migration

### Tests first

- [x] T023 [P] [US6] The scan test: no result text or phenotype string appears in any trace, receipt or log from the golden run.
- [x] T024 [P] [US6] Unknown usage holds the run; a provider that reports none is `USAGE_HELD`.
- [ ] T025 [P] [US6] PostgreSQL tier: the fleet and tenant caps hold under concurrent runs; a test fails if the in-memory budget class is wired as a fleet control.
- [x] T026 [P] R5 conformance: no explanation text is stored (FR-014); a test fails if an outcome v2 row carries text. **Done for the row shape in slice 3a (the v2 schema has nowhere to put text); the database row check follows the migration in 3b.** **The database half done in 3b-1: the receipts table has no column that can hold text (catalog test) and refuses a plain digest.**

### Implementation

- [ ] T027 Migration (new number, down file, lint label) for the v2 outcome and counters tables; digests and reason codes only. Run the three backend tiers. **Receipts table done as migration 0048 (slice 3b-1); the run, usage and cap tables follow in 3b-2, so this stays open.**
- [x] T028 `src/trace.ts` : per-step trace and receipt with the pinned model ID, digests and counters (FR-009, FR-010). **Done as `trace.ts`, `receipt.ts` and `outcome-v2.ts`.**
- [ ] T029 Break the caps and the scan on purpose; record the red runs. **Scan and keyed digest broken in slice 3a; the caps follow in 3b.** **Slice 3b-1 also broke the tenant check, the update guard, the retention floor, the digest check, the key-set check and the column check on purpose.**
- [x] T043 [P] [US6] Keyed digests (FR-009): evidence and output digests are HMAC-SHA-256; a plain SHA-256 of a known evidence value does not match the stored digest; the key comes from the secrets store and is absent from the repository (gitleaks). Written before T028 and seen failing.

## Phase 4: Slice 4, the Bedrock adapter and shadow mode (US7, US8) — needs D4 and Bedrock access

### Tests first

- [ ] T030 [P] A `global.*` profile is refused; a cross-region profile is refused unless a recorded allowlist entry names that exact ID and its destination regions; an alias or `latest` model ID is refused (FR-010, FR-016).
- [ ] T042 Before this phase writes any adapter code, a read-only check in the account (founder signs in): is the chosen model offered on demand in us-east-2 or only through a profile, which destination regions, and does the organization policy allow each. The result is recorded in `docs/verification/` and the founder approves the path (FR-016).
- [ ] T031 [P] The adapter reads usage from the provider's own report and fails closed without it.
- [ ] T032 [P] The adapter has no destination other than the Bedrock runtime endpoint in us-east-2.

### Implementation

- [ ] T033 `src/model-clients/bedrock.ts` using `@aws-sdk/client-bedrock-runtime` (exact pinned version), Converse API with a response schema. Credentials from the task role, never a key.
- [ ] T034 A manual, approval-gated live-run script. It is a report, never a required check, and refuses non-synthetic input.
- [ ] T035 The shadow review file: for N synthetic cases, the explanation, the sensor results and the template-only control side by side, for the founder to mark.
- [ ] T036 `docs/verification/` record of the live run with counts, cost and what was not verified.

## Phase 5: Founder (no code)

- [ ] T037 Mark the golden set and the shadow output as pharmacist (D5).
- [ ] T038 Set the thresholds and k (D8) from the phase 1 numbers and commit them to `docs/verification/` **before the first live run** in phase 4 (SC-008); never from live results.
- [ ] T039 Record counsel's view on the FDA clinical decision support criteria (D10).
- [ ] T040 Execute the AWS BAA before any real data. Write `docs/clinical-validation/` for the first release.
- [ ] T046 Specify and build the post-release monitor (releases and holds by reason code, an alert on a hold-rate change) and rehearse a rollback to the previous pinned model; its own spec if it exceeds a slice. Required by FR-012.
- [ ] T047 Write the clinician-facing "how this explanation is produced and checked" document (FR-012); counsel reads it with the D10 question.
- [ ] T041 Decide readiness. The readiness flag stays closed until FR-012 is entirely true.

## Dependencies & Execution Order

- Phase 1 first: it creates the sensors and the gate that every later phase relies on. Phase 2 needs phase 1; phase 3 needs phase 2; phase 4 needs phase 3.
- Within a phase, tests first, seen failing; `[P]` tasks may run together.
- Phase 5 runs alongside phases 3 and 4 and gates enabling anything.
- Nothing here changes the engine, the ledger, the synthetic kernel or the AWS account.
