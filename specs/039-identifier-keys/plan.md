# Plan: identifier keys for drugs and genes (spec 039)

Date: 2026-11-12
Status: NOT approved. Written with D1 to D5 as recommended; a different answer changes the parts named under each decision in `spec.md`.

## What exists, read for this plan at `ed9268a5`

| Piece | Where | What matters here |
| --- | --- | --- |
| Knowledge schema | `packages/cpic-schema/src/knowledge.ts` | Versions 1.2 and 1.3 (`:11`). `rxcui` on a guideline and `hgncId` on a gene map are optional in the shape and required on 1.3, refused on 1.2, by the refinement (`:149-158`, `:240`, `:395`). Identifier forms in `IDENTIFIER_FORMS` (`:52-59`), not exported: real RxNorm ids are digits, synthetic are `syn-rxcui-…` |
| Loader | `apps/backend/src/services/knowledge/knowledge-loader.ts` | One gene map per symbol (`:91-92`); guidelines keyed by drug and gene set (`:94-96`); production refuses 1.2 (`:79`); supersession compares drug names (`:180`). It never reads `rxcui` or `hgncId` |
| Knowledge set | `apps/backend/src/services/knowledge/knowledge-set.ts` | Gene maps by symbol (`:33`), guidelines grouped by drug name (`:34-39`); `gene()`, `guidelinesForDrug()`, `drugs()` (`:51-62`) |
| Engine | `recommendation-engine/recommendation-engine.ts` | Asked for drugs by name (`evaluationOptionsSchema.drugs`, `cpic-schema/src/evaluation.ts:43-45`); `identifiersFor` (`:136-145`) copies ids only when the guideline and every gene map are 1.3. Not changed |
| Stored results | migrations 0008, 0071; `storage/postgres/ledger-records.repository.ts:507-538`; `ledger/projections.ts:486` | `evaluation_results` has nullable `drug_rxcui`, `gene_hgnc_ids` (0071); `evaluation_gene_states` holds the symbol only. Not changed (D3) |
| Medications | migration 0066; `patient-medications/patient-medications.service.ts:59`; `packages/shared-types/src/drug-list.ts` | `drug_rxcui` required, digits; the drug list holds `IN` and `MIN` ids. The MD-6 boundary (`patient-medications/clinical-boundary.spec.ts:9-27`) keeps medication and knowledge code apart. Not changed |
| Fixtures | `data/fixtures/knowledge/` | `synthetic-identifiers` (five 1.3 files) is the only 1.3 set; `synthetic`, `synthetic-structured`, `test-only-reader` are 1.2. Their hashes and set ids are pinned; none is edited |

## The changes

1. **`packages/cpic-schema/src/knowledge.ts`**: `export` before `const IDENTIFIER_FORMS`. Nothing else, so every hash and parse is unchanged.
2. **`knowledge-loader.ts`**: after the existing per-file checks, three cross-file rules (IK-1) and one (IK-2), each a problem naming both files: `drug "<name>": <a> and <b> state different RxNorm ids.`, `<a> and <b> state the same RxNorm id for two drugs.`, `<a> and <b> state the same HGNC id for two genes.`, `drug "<name>": <a> is schema 1.2 and <b> is 1.3; a drug is identified in all its files or in none.` A drug name is already a closed lower-case form (`drugNameSchema`), so naming it prints no content. Run in every mode, before the set is built.
3. **`knowledge-set.ts`**: four read-only lookups (IK-3): `drugForRxcui(id)`, `rxcuiOfDrug(drug)`, `geneForHgnc(id)`, `hgncOfGene(gene)`, built once in the constructor from 1.3 files only. Plain `Map` lookups by exact key.
4. **`services/knowledge/identifier-map.ts`** (new, IK-4, IK-5): `mapRxNormIngredients(knowledge, ids: readonly string[]): IngredientMatch[]`, where `IngredientMatch` is `{ rxcui, status: 'matched', drug, guidelines: string[] }` or `{ rxcui, status: 'not-matched', reason: 'no-identified-guideline' | 'invalid-identifier' }`. The form check uses `IDENTIFIER_FORMS.rxcui`: synthetic form when every file of the set is synthetic, real form otherwise. `guidelines` are the ids of the drug's guideline files, sorted, superseded ones included and marked as the set marks them today (the caller decides which apply, as the engine does). No import but `KnowledgeSet` and `@telesphoros/cpic-schema`.
5. **`services/knowledge/identifier-map-boundary.spec.ts`** (new, IK-6): the module's imports are only those two; no file outside `services/knowledge` imports it. The walker recognises `import`, `import type`, `require` and a bare `import '…'`.

Not changed: the engine, `identifiersFor`, every migration and stored row, the ledger, the medications module and its MD-6 spec, the front end, `knowledge/cpic/`, every existing fixture.

## Fixtures (invented, written before the code)

`data/fixtures/knowledge/identifier-conflicts/`, one folder per case, each a complete small set that loads cleanly except for the one conflict:

| Folder | Case | Expected |
| --- | --- | --- |
| `one-drug-two-ids/` | two 1.3 guidelines for `drugq` (different gene sets) with different `rxcui` | refused, IK-1 |
| `two-drugs-one-id/` | `drugq` and `drugr` stating one `rxcui` | refused, IK-1 |
| `two-genes-one-id/` | gene maps `GENEA` and `GENEB` stating one `hgncId` | refused, IK-1 |
| `half-identified-drug/` | a 1.2 and a 1.3 guideline for `drugq` | refused, IK-2 |
| `control/` | a 1.3 drug with two guideline files and the same `rxcui`, and a 1.3 guideline over a 1.2 gene map | loads; the second has no identifiers on its results, as today |

`data/fixtures/knowledge/identifier-map/expected.json`: the invented id list and, for each, the hand-written answer against `synthetic-identifiers` plus the `control` set: matched ids; an id no guideline states; the id of a drug that exists only by name in a 1.2 set; a digits id against a synthetic set (`invalid-identifier`); for IK-5, a set built in the test from real-form invented ids (the `TEST_REAL_FORM_IDS` pattern spec 033's tests use) and a second digits id standing for a multiple-ingredient product (`no-identified-guideline`, the same path as any id no guideline states); a malformed id; a repeated id; and a name that equals a guideline's drug passed as an id (`not-matched`).

## Tests, written first and seen to fail

| Spec | Covers |
| --- | --- |
| `knowledge-loader.spec.ts` (added cases) | IK-1, IK-2: each conflict fixture refused with its rule; `control` loads; every existing case unchanged |
| `knowledge-set.spec.ts` (new or added) | IK-3: the four lookups, exact match, no case folding, 1.2-only drug has no id, unknown id has no drug |
| `identifier-map.spec.ts` (new) | IK-4, IK-5, IK-8, IK-9: the expected answers; order kept; repeated ids; nothing logged; same answers whatever order the files are read in |
| `identifier-map-boundary.spec.ts` (new) | IK-6 |
| existing suites | IK-7: pinned hashes, set ids, engine and MD-6 specs pass unchanged |

## Deliberate breakages

One at a time, in a sealed job, after a control run that must pass: each of the four loader rules removed; each lookup made case-insensitive; the mapping falling back to a name match; the form check removed; the order of answers changed; a forbidden import added to the mapping module; the boundary walker missing a bare import. Expected survivors named before the run.

## Verification

In sealed jobs, never on the host: the new and changed specs; `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `check:chunks`, `knowledge:verify --production --allow-empty`; `pnpm test:infra`, `pnpm test:ci-config`, `pnpm check:workflows`; the database and storage tier in three shards and the worker tier, because the constitution requires them even though no schema changes; gitleaks on the host. Records: `docs/verification/2026-11-12-identifier-keys.md` and `docs/clinical-validation/identifier-keys.md`. The pull request uses the template headings (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups).

## Not in this slice

Any caller of the mapping; spec 031's flags; HGNC ids on stored gene states (D3); asking the engine by id (D5); splitting combination products (D2); real identifiers; the private repository.
