# Verification: LLM harness slice 3a (2026-10-25)

Scope: `apps/ai-service/{src,test}`, `specs/003-llm-harness/tasks.md`.

## Checks (Node 22.22.0)

- Tests written before the code that makes them pass: the receipt and trace tests failed (16 failures) while `runExplanation` returned no receipt; the keyed-digest and outcome-v2 tests were written against the modules before the run was changed.
- `apps/ai-service`: 20 files, 305 tests; `tsc --noEmit`, `eslint` and the root Prettier check clean.
- The tests found one bug in my first version: a detail string with no `: ` lost its first character (`cell-disputed` became `ell-disputed`). Fixed and covered.

## Broken on purpose (against trace-receipt, keyed-digest, outcome-v2 and explain tests, 106 tests)

| Mutation | Failing tests |
|---|---|
| A trace step carries the first 40 characters of the engine text | 3 (the leak scan twice, and the trace step test) |
| The keyed digest becomes a plain SHA-256 | 4 |
| Outcome v2 allows extra keys | 2 |
| Usage always reported as known | 2 |

Each file was restored and the 106 tests passed again.

## Known limits

- Nothing is stored. Whether a receipt can be written, read back and purged, and whether the fleet cap holds under concurrent runs, is slice 3b.
- The scan checks the strings it is given (every result string, phenotype, gene, drug, golden-case statement, the key and a model marker). Text it was not given is not covered.
- Digests of the evidence and output are keyed, but the key's custody (rotation, who holds it) is not designed here. A key change makes old and new digests incomparable.
- Hosted CI has not run.
