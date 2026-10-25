# Verification: LLM harness slice 2 (2026-10-25)

Scope: `apps/ai-service/{src,evals,test}`, `specs/003-llm-harness/{spec,tasks}.md`.

## Checks (Node 22.22.0)

- Tests written before the code: with `explain.ts`, `tasks.ts` and the readiness function absent, the three new test files failed on missing modules.
- `apps/ai-service`: 17 files, 257 tests pass; `tsc --noEmit` and `eslint .` clean. The pinned digests now include the repair and verifier templates, so the harness version changed.
- Gate report is unchanged in meaning: 34 golden cases and 18 attacks, none wrongly released, none effective (slice 1's gate still runs, on the new digests).

## Broken on purpose (T022), run against `test/explain.test.ts` and `test/tasks.test.ts` (76 tests)

| Mutation of the real source | Failing tests |
|---|---|
| R1 runtime: the real-data checks (`NOT_SYNTHETIC`, `NO_BAA`) removed from `explain.ts` | 4 |
| R1 declaration: `dataClass` of `pgx.explain.v1` changed to `no-phi` | 55 (the task no longer runs, and the registry test names `R1_CLASS_DISAGREES`) |
| R2: the sensors never called from `explain.ts` | 4 |
| R4: `S4` dropped from the listed checks | 2 |
| FR-005: the verifier's rejection ignored | 8 |

Each file was restored and the 76 tests passed again.

## Known limits

- The run is proven against in-memory doubles. A concurrent-run or crash-recovery property of the durable path is not shown here (slice 3).
- `readiness()` is a pure function; nothing calls it. The statement "the model path is dormant" rests on there being no real model client, not on `readiness()`.
- The verifier is exercised only with scripted replies. Whether a real model's verifier calls are useful is for the live runs (slice 4).
- Hosted CI has not run.
