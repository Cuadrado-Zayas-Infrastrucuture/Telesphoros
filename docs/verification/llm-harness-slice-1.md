# Verification: LLM harness slice 1 (2026-10-25)

What ran, what it found, and what it does not show. Scope: `apps/ai-service/{src,evals,test}`, one guard test, one CI scope test, a devDependency.

## Gate report on the committed harness

| Measure | Value |
|---|---|
| Golden cases | 34: 8 acceptable, 26 seeded wrong (invented drug 2, changed strength 2, flipped direction 4, added number 2, dropped caveat 3, wrong gene 2, advice beyond the guideline 3, altered or out-of-range quote 2, markup or link 1, second person 1, bad structure 2, too long 1, directive in a restatement 1) |
| Wrongly released | 0 of 26 |
| Held for the wrong sensor (expected sensor did not report) | 0 of 26 |
| Acceptable cases held | 0 of 8 (the acceptable cases were written to pass: this is not a hold rate) |
| Attacks | 18: 7 inbound, 6 hostile shape, 5 obedient-model output; effective: 0 |
| Pharmacist-marked cases | 0 of 34 |
| Harness version | digest of the template, lexicon and glossary digests, printed by the gate |

## Checks run (Node 22.22.0, `apps/ai-service`)

- New tests written before the code and seen failing: with `src/evaluators`, `src/prompts`, `src/model-clients` and `src/fallback.ts` moved aside, 6 new test files failed on missing modules and the 81 existing tests passed.
- After the code: 14 files, 157 tests pass; `tsc --noEmit` and `eslint .` clean.
- First-green spot check by hand: the sensor reasons for all 34 cases were dumped and read. Every acceptable case released with no reason; every wrong case held for its intended sensor. Several wrong cases are also held incidentally by S6 (dropped qualifier), so a bare gloss on a result with a caveat is always held. This is the strictness the spec accepts, and it means the hold rate on real glosses will be high.
- Broken copies, run as tests: each of S1 to S6 replaced by a no-op (6), a missing sensor, a leaky builder, a lax builder, each pinned digest changed (3), a wrong-sensor expectation, and an empty gate. All turned the gate red.
- Mutation of the package guard: `src/evaluators/zz-mutant.ts` containing `fetch(...)` turned `boundaries.test.ts` red; the file was removed.
- `test:ci-config` 203 of 203 (one test added: harness paths are never documentation-only; its control shows a model ID kept in `docs/**/*.md` would skip the gate).

## Known limits (stated, not solved)

- The sensors are lexical. A directive at the end of a sentence with nothing after it is not paired and passes if the result uses that word; a re-ordering that keeps every word and pairing passes.
- Number and direction words are matched by family and by exact next word, so a harmless paraphrase is held. The draft glossary decides how many good glosses survive.
- The prompt-injection controls cover inbound fields, hostile shapes and an obedient model's output. A hostile string inside the signed guideline text itself is out of scope (the knowledge is signed and reviewed).
- The case author, the sensor author and the oracle are the same person until D5 is done.

## Not run

Backend, PostgreSQL, browser and Terraform tiers (no schema or runtime change; the PR does touch `.github/`, so hosted CI will run Terraform jobs). Hosted CI has not run. A default shell on this Mac has Node 24.14.0, where `test:ci-config` fails one test ("a signalled CLI fails and kills its child process group…") on this tree and on clean `main`; on Node 22.22.0 all 203 pass. The mechanism was not investigated.
