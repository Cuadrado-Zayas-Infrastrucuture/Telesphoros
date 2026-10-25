# Implementation Plan: A harness that lets a model explain a verified engine result, and nothing else (HARN)

**Branch**: `docs/spec-003-llm-harness` (this document); one `feat/…` or `chore/…` branch per slice | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-llm-harness/spec.md`

**Status**: **Draft. The plan itself is not approved yet.** The founder decided D1 to D10 on 2026-10-25 (see "Founder decisions"). No slice may start until the founder approves this plan; opening the draft PR is the request for that review.

## Summary

Add the parts of the harness the kernel does not have, in the order that proves each before the next depends on it. First an offline evaluation harness with a scripted model, so the sensors and the gate exist and are proven to fail when broken. Then the explanation contract, the sensors and the "fail to the engine text" path. Then the durable outcome v2, real usage counters and the trace. Only then a Bedrock adapter, behind the readiness gate, run on synthetic data and reviewed by the pharmacist. The existing `runSynthetic` kernel is not changed: the real path is a sibling that reuses its ports, fencing, idempotency and caps.

## Technical Context

**Language/Version**: TypeScript 6, Node >= 22 (`apps/ai-service`, `"type": "module"`, dual ESM and CJS build with `tsup`); `zod` ^4.6.7; `vitest`.

**Primary Dependencies**:
- Phases 1 to 3: none new.
- Phase 4: `@aws-sdk/client-bedrock-runtime`, exact version and a release at least two weeks old, in the hashed lockfile. No other model or agent package (D4).

**Storage**: PostgreSQL through new numbered migrations, labelled `breaking` or `expand` as the lint requires. v2 outcomes keep digests and reason codes only (FR-014). The existing `agentic_synthetic_*` tables stay as they are.

**Testing**:
- `vitest` unit tests for contracts, sensors, graders and the prompt-provenance rule.
- The evaluation gate: golden set, injection corpus and a broken-copy test per sensor, offline, with no model call and no network.
- The `*.pg.test.ts` tier for budgets and the durable path, and the three-tier rule for anything that touches the schema.
- gitleaks before every PR.

**Target Platform**: The same Node service as today. Nothing applied in AWS.

**Constraints**:
- Synthetic data only; no real PHI anywhere (constitution II).
- The AWS BAA is not executed; the model path stays dormant (FR-012).
- At most 3 hosted CI runs per PR; one draft PR per slice off `main`, never stacked.
- `specs/**` is not on the docs-only list in `.github/ci/scope.mjs` (`docsPath` covers `docs/**/*.md` and root `*.md`), so a PR that touches `specs/` runs the full hosted pipeline.

**Scale/Scope**: Four code slices plus founder work. Roughly 12 new source files in `apps/ai-service`, one or two migrations, one evaluation directory, no change to the engine, the ledger or the frontend.

## Constitution Check

| Principle | Result |
|---|---|
| I. Plan first, approved by the founder | Passes once this plan is approved; `tasks.md` is derived from it. |
| II. Synthetic data only; secrets and PHI never leave | Passes: FR-001, FR-009, FR-011 and the dormant gate. The trace and receipt hold digests, never text. |
| III. Inbound content is untrusted data | Passes by construction: FR-001 gives inbound text no way into the prompt. |
| IV. Tests earn their keep | Passes: every sensor and gate rule has a broken copy; hand-written golden cases are the oracle; the database tiers run for the durable slice. |
| V. Report outcomes faithfully | Verification records go in `docs/verification/`, with what was skipped. |

**Gate result**: passes, with no exception to a standing rule.

## Project Structure

### Documentation (this feature)

```text
specs/003-llm-harness/
├── spec.md
├── plan.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/ai-service/
├── src/
│   ├── contracts.ts            # + explanation, statement and outcome v2 schemas (v1 untouched)
│   ├── explain.ts              # new kernel path: runExplanation (sibling of runSynthetic)
│   ├── fallback.ts             # fixed text per engine outcome and reason code (FR-002, FR-006)
│   ├── prompts/                # versioned templates, each with a digest (FR-001, FR-010)
│   ├── evaluators/             # sensors S1 to S6, glossary, contradiction lexicon (FR-004)
│   ├── model-clients/          # ModelPort, scripted stand-in, then the Bedrock adapter (phase 4)
│   ├── trace.ts                # per-step trace and receipt, digests only (FR-009)
│   └── policy.ts               # readiness conditions (FR-012)
├── evals/                      # golden cases, attack corpus, runner and graders (FR-013)
└── test/                       # unit, provenance, scan and pg tests
docs/verification/              # what was run in each phase
docs/clinical-validation/       # the validation note required before any release
```

## Design

### The shape of a run

1. **Admit** exactly as `runSynthetic` does: idempotency key, fenced state, authority check, deadline, budget reservation.
2. **Gate on eligibility** (FR-002). A result that is not `shown`, or is "No recommendation", returns fixed text and ends the run with no model call.
3. **Build the prompt** from the closed set only (FR-001), recording the template digest.
4. **Draft**: one model call through `ModelPort`, with a pinned model ID and a response schema. Usage is read from the provider's own report.
5. **Sensors** S1 to S6 run in code. Any failure is a hold with a reason code, or one repair attempt within the caps.
6. **Verify**: a second call that can only add a hold.
7. **Release** the explanation only after both pass, authority is current and the deadline has not passed. The caller always receives the engine text first.
8. **Any failure** at any step returns the engine text alone with a reason code. The failure path is one function with one test per reason code.

### The sensors

Each sensor is a pure function with hand-written positive and negative cases and a broken copy. S1 reuses the byte-span check of `checkCandidate` (`evidence.ts:19-26`). S2 to S6 are new. They are lexical by design and say so: they prove a statement uses only the result's own terms and numbers and does not reverse its directive words; they do not prove meaning. That limit is the reason the guideline text is always shown beside the explanation and the pharmacist's golden set exists.

### Outcome v2

A separate schema from `synthetic.business-outcome.v1`, with its own evidence kind, real counters, the harness version and the digests. It stores no text (FR-014). The synthetic schema and tables are not changed, so the synthetic proofs keep passing.

### Budgets

The in-memory class stays a test double and a test makes it unusable as a fleet control. Real caps live in the database, as the durable path already does; the new counters (calls, input and output tokens, charge) are added in a migration with a test under concurrency.

### Evaluation gate (R3)

`apps/ai-service/evals/` holds the cases and the runner. The runner needs no network and no model: it feeds scripted outputs, correct and wrong, through the real kernel path and the real sensors, and compares to the hand-written expectation. It is wired into the existing `verify` job and selected by path in `scope.mjs`, so the required check names do not change (D7). Phase 4 adds a separate manual, approval-gated live run against the real model; it is a report, never a required check.

### Golden set and attack corpus

Cases are hand-written from the synthetic fixtures (`GENEA` to `GENEE`, invented drugs) shaped like real guideline cells. The founder, as pharmacist, marks candidate explanations acceptable or not; those marks become the oracle (D5). An answer key written by a model proves nothing, so no model writes expectations. The attack corpus starts from the OWASP prompt-injection and disclosure patterns and grows with each finding.

### Rollout: slices (each its own draft PR off `main`, never stacked, merged in order)

| Slice | Contents | Needs |
|---|---|---|
| 1 | Evaluation harness, scripted model, sensors S1 to S6, golden set and attack corpus (first cut), prompt-provenance and scan tests, wired into `verify` | D6 to D8 partly |
| 2 | Explanation contract, `runExplanation`, fixed-text fallback, readiness conditions in `policy.ts`, tests for R1, R2, R4 | Slice 1 |
| 3 | Outcome v2 and counters, trace and receipt, database caps under concurrency, R5 conformance | Slice 2; a migration |
| 4 | Bedrock adapter behind the gate, pinned model, in-region refusal test, a manual live-run script, the shadow review file | Slice 3; D4; Bedrock access (unverified) |
| Founder | Marks the golden set, sets thresholds (D8), reviews shadow output, records counsel's view (D10), decides readiness | After slice 4 |

## Founder decisions (only the founder can make these)

**Decided 2026-10-25** (founder, verbatim): *"the model explains verified engine output only, no model-driven tools, synthetic data, direct Bedrock client, and I will review the golden cases as the pharmacist."*

- **D1 scope:** explain only. **D2:** no model-driven tools. **D3:** synthetic data only. **D4:** direct Bedrock Converse in us-east-2. **D5:** the founder reviews the golden cases.

**Decided 2026-10-25** (founder, verbatim): *"Approve the recommendations for D6 to D10 as written: no stored text, gate inside verify, thresholds after slice 1, English first, counsel before readiness."*

- **D6 stored text: no in v1** (FR-014). The caller may store it under its own retention, which R5 then governs.
- **D7 where the gate runs: inside the existing `verify` job, selected by path,** so the ruleset and required check names stay as they are. (The alternative, a new required check, would need a ruleset change through `gh api`.)
- **D8 thresholds: decided after slice 1 produces real numbers,** not before: the release rate for acceptable explanations, the tolerable hold rate, and trials per case.
- **D9 languages: English first.** Spanish needs its own glossary, sensors and the founder's review; it follows as its own slice.
- **D10 regulatory: counsel is asked before readiness** whether this is non-device clinical decision support, with the product's behaviour as written here. This plan does not decide it.

## Not touched by this plan or PR

The engine and the knowledge files, the ledger and its hash chain, the schema work in progress, `runSynthetic` and the `agentic_synthetic_*` tables, Terraform, the AWS account, the BAA, the frontend, and the `PGX_CLINICAL_HOLD_LIFTED` sentence until slice 2 makes it real.

## Complexity Tracking

| Item | Why it is needed | Simpler alternative rejected |
|---|---|---|
| A sibling kernel path, not a change to `runSynthetic` | The synthetic kernel's proofs stay valid and the literal `0` counters stay a guard for synthetic runs | Editing the synthetic kernel would weaken the proofs it already has |
| Two layers after the model (sensors, then verifier) | Code cannot prove meaning; a model alone cannot be trusted | Sensors alone miss semantic drift; a verifier alone is the model's own word |
| A template-only control arm | The model must justify itself against a no-risk baseline | Skipping it would measure the model only against itself |
