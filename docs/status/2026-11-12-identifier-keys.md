# Identifier keys for drugs and genes (spec 039)

Date: 2026-11-12

A drug's RxNorm id and a gene's HGNC id are now keys the knowledge set can be trusted on. The loader refuses, in every mode, a set where one
drug states two RxNorm ids, one RxNorm id names two drugs, one HGNC id names two genes, or a drug has both schema 1.2 and 1.3 files; each
problem names the drug and both files, never an id. The knowledge set answers four exact lookups (`drugForRxcui`, `rxcuiOfDrug`,
`geneForHgnc`, `hgncOfGene`) from 1.3 files only, and its constructor refuses the same conflicts for sets built without the loader.
`mapRxNormIngredients` turns a medication's RxNorm ingredient ids into the set's drugs: one answer per id in the order given, matched with
every guideline file and the table that supersedes it, or not matched with a reason; it never matches a drug name, and nothing calls it yet.
`not-matched` never means that no guidance exists. No outcome, reason code, hold, wording, migration or stored row changes, and the engine
is still asked for drugs by name.

What changed: `knowledge-loader.ts`, `knowledge-set.ts`, the new `identifier-map.ts` and their specs (with a boundary spec for the mapping);
`isRxcuiForm` in `packages/cpic-schema`; `test/helpers/knowledge.ts`, which now gives each drug and gene of a signed test copy its own
real-form id; new invented fixtures `data/fixtures/knowledge/identifier-conflicts/` and `identifier-map/`, with hand-written expected
answers; `docs/clinical-validation/identifier-keys.md`; the spec, plan and tasks in `specs/039-identifier-keys/`.

Verification, in sealed offline jobs: 31 deliberate breakages each turned a test red; `pnpm typecheck`, `lint`, `test`, `build`,
`check:chunks`, `knowledge:verify --production --allow-empty`, `test:infra` 470 of 470, `test:ci-config` 238 of 238, `check:workflows`
5 of 5, `test:image` 49 of 49; backend default tier 2,291 passed; PostgreSQL and S3 tier in three shards, 4,447 passed, with two failures in
files this change does not touch (a load test that fails the same way with no change, and a readiness timeout under three shards that
passes alone); worker tier 248 of 248; gitleaks clean. Record: `docs/verification/2026-11-12-identifier-keys.md`.

Not done: no caller of the mapping, and its clinical approval stays with spec 031's named signer; no real identifiers; no HGNC ids on
stored gene states; combination products are not split; `test:ig`, the browser tier and hosted CI have not run.
