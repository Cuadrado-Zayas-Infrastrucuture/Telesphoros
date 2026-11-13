# Identifier keys for drugs and genes (spec 039), 2026-11-12

Branch `docs/spec-039-identifier-keys`, from public main `ed9268a5`. Every check below ran in sealed, offline sandbox jobs (the
`telesphoros` job image), never on the host, except gitleaks. All content is invented. Nothing was pushed when this was written.

## What changed

- `knowledge-loader.ts`: `checkIdentifierKeys` refuses, in every mode, one drug stating two RxNorm ids, one RxNorm id for two drugs, one
  HGNC id for two genes (IK-1), and a drug with both schema 1.2 and 1.3 files (IK-2). Each problem names the drug and both files, never an id.
- `knowledge-set.ts`: `drugForRxcui`, `rxcuiOfDrug`, `geneForHgnc`, `hgncOfGene`, exact lookups from 1.3 files only; the constructor refuses
  the IK-1 conflicts for sets built without the loader (IK-3).
- `identifier-map.ts` (new): `mapRxNormIngredients`, one answer per id in the order given (IK-4). No caller (IK-6).
- `packages/cpic-schema`: `isRxcuiForm` exported; the identifier forms stay private.
- `test/helpers/knowledge.ts`: each drug and gene of a signed test copy gets its own real-form id (IK-7).
- Fixtures: `data/fixtures/knowledge/identifier-conflicts/` and `identifier-map/`, each with a hand-written `expected.json`.

Not changed: the engine and `identifiersFor`, every migration and stored row, the ledger, the medications module and its MD-6 spec, the
front end, `knowledge/cpic/`, every fixture that existed.

## Order of work

| Commit | Step |
| --- | --- |
| `eae50f1c` | Plan approved by the founder, D1 to D9 as recommended |
| `8447beb2` | T1: which existing tests the rules refuse, before any code |
| `2ebbc41a` | T2: fixtures and expected answers, written by hand |
| `07522e9f` | T3: specs, seen failing against the code as it was |
| `c2aaef4c` | T4 to T7: the code |
| `d3783edf` | T8: deliberate breakages; two tests strengthened |

## T1: the existing tests the rules refuse

The four loader rules and the constructor check, as a throwaway patch that was never committed:

- With the helper unchanged, 24 tests were refused, every one a signed copy from `reviewedCopyOf`: `knowledge-loader.spec.ts` 12,
  `knowledge-locate.spec.ts` 7, `recommendation-engine.spec.ts` 2, `cli.spec.ts` 1, `lab-reports.module.spec.ts` 1,
  `test/db/knowledge-signatures.pg-spec.ts` 1. Their problems were all "the same RxNorm id for two drugs" (82 lines) or "the same HGNC id
  for two genes" (80): the helper's single test ids. None was IK-2 or "different RxNorm ids".
- With per-name ids in the helper, the default tier passed (166 suites, 2,257 tests) and so did the Postgres tier, apart from the load test
  named below, which failed the same way with no patch.
- No test pins the hash or set id of a signed copy.

## T2 and T3: fixtures before code, specs seen failing

With the loader as it was, all six fixture sets loaded, so each conflict set is refused only for its one conflict. With the throwaway rules,
each folder's problems equalled its `expected.json` exactly.

Against the code as it was, every added test that tests new behaviour failed for that reason: no problem reported for each conflict, in
either mode; `drugForRxcui is not a function`; the constructor did not throw; `Cannot find module './identifier-map'`; the mapping module
missing for the boundary; `isRxcuiForm is not a function`. The tests that passed then were the answers-file check, the control set loading,
the boundary's walker controls, the two fences that already held, and the check that the identifier forms stay private.

## T8: deliberate breakages

One change at a time, each applied only where its text occurs exactly once, after a control run that passed (70, 17, 69 and 12 tests),
restored and checked clean after each. All 31 single changes turned a test red:

| Change | Turned red |
| --- | --- |
| L1 to L4: each loader rule removed; L5: the check never called | the refusal of that conflict, in both modes, and the IK-8 test |
| H1, H2: one RxNorm id, or one HGNC id, for every signed copy again | the loader's signed-copy tests (13 and 12 tests), beginning with "accepts properly signed-off, non-synthetic content" |
| S1 to S3: each constructor check removed | the refusal of sets built without the loader |
| C1 to C4: each lookup made case-insensitive | the exact-match test |
| M1: a fallback to drug names | the written answers; the no-name test; the reversed-order test |
| M2: the form check removed | the written answers and four more |
| M3: `supersededBy` always null | the written answers; the supersession test; the id-order test; the reversed-order test |
| M4: answers sorted instead of in the order given | the written answers; the repeated-id test and four more |
| M5: files not sorted by id | the id-order test |
| B1: a forbidden import in the mapping module | "imports only the knowledge set and the schema package" |
| B2, B3: a lookup called from `lab-reports/`; the mapping re-exported from `test/` | "nothing outside services/knowledge …" |
| B4: a medication file importing `services/` | "no medication file imports from services/" |
| W1 to W5: the walker missing `from`, `import()`, `require()`, a bare import, an import across lines | the walker controls |
| P1 to P3: `isRxcuiForm` real form only; the forms exported; trimming and case folding | the matching `cpic-schema` test |

Two tests were added while listing the breakages, before they ran, because no test could have caught the change otherwise. M5 survived
until a test held a drug whose files sort differently by id than by genes. And the IK-9 test compared the answers from a reversed set only
with the written answers: with both sorts removed, the reversal restored the written order and the test passed, so it now also compares with
the same set's own answers.

The expected survivor, as planned: no single change turns the IK-9 order test red. D0, the set no longer sorting a drug's files, left it
green (D0 was caught by the id-order test, which relies on that sort). D1, both sorts removed at once, turned it red.

## T9: the full loop, on the final tree

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` (every package, then `format:check` over all source) | exit 0 |
| Root tests | 47 of 47 |
| Workspace tests (no services) | exit 0. Backend 169 suites, 2,291 passed, 563 skipped (32 suites need Postgres or S3; 5 specs need the reader engine, which this repository does not hold); frontend 1,065 and 59; ai-service 349; shared-types 253; smart-pilot 188; worker 151; jobs 20; cpic-schema 69; fake-idp 7; the two Lambdas 22 and 10 |
| `pnpm build` | exit 0 |
| `check:chunks` | entry chunk 110.1 kB gzip, budget 150 kB |
| `knowledge:verify --production --allow-empty` | exit 0 (no guidelines ship) |
| `test:infra`, `test:ci-config`, `check:workflows` | 470 of 470; 238 of 238; 5 of 5 |
| Demo personas, `test:image` | 7 of 7; 49 of 49 |
| Postgres and S3 tier, shard 1/3 | 105 suites, 1,515 passed |
| Shard 2/3 | 1,312 passed, 1 skipped, 1 failed: `test/lab-reports-capture.e2e-spec.ts`, see below |
| Shard 3/3 | 1,620 passed, 1 skipped, 1 failed: `test/db/readiness.pg-spec.ts`, see below |
| Worker tier on Postgres (`tsup`, then `vitest run`) | 20 files, 248 passed |
| gitleaks (repository config) | every commit on the branch since `ed9268a5`, and the changed paths on disk: no leaks |

The two failures, neither in a file this change touches:

- `lab-reports-capture.e2e-spec.ts`, "concurrent identical requests … while the CPUs are busy": a throughput test, needing 4 batches in
  60 s; it completed 2 here. Run alone at 3 CPUs on the tree with no change at all (T1), it failed the same way (3 batches), so it fails in
  this sandbox without this change.
- `readiness.pg-spec.ts`, "turns NOT ready when the database disappears": the 5 s test timeout, under three shards at once. Run alone in the
  same job: 11 of 11, that test 3.7 s.

## Not run

- `test:ig`: the FHIR validator needs Java and a network download; nothing here touches FHIR.
- The browser tier: the job image has no Chromium; nothing here touches the front end.
- Hosted CI, until the branch is pushed. The private repository runs its whole loop at its next merge from public.
