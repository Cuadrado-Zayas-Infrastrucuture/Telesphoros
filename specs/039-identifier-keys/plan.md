# Plan: identifier keys for drugs and genes (spec 039)

Date: 2026-11-12
Status: approved by the founder on 2026-11-12, with D1 to D9 as recommended ("Approve as recommended"). Written with them; a different answer changes the parts named under each decision in `spec.md`.

## What exists, read for this plan at `ed9268a5`

| Piece | Where | What matters here |
| --- | --- | --- |
| Knowledge schema | `packages/cpic-schema/src/knowledge.ts` | Versions 1.2 and 1.3 (`:11`). `rxcui` on a guideline and `hgncId` on a gene map are optional in the shape and required on 1.3, refused on 1.2, by the refinement (`:149-158`, `:240`, `:395`). Identifier forms in `IDENTIFIER_FORMS` (`:52-59`), not exported: real RxNorm ids are digits, synthetic are `syn-rxcui-…` |
| Loader | `apps/backend/src/services/knowledge/knowledge-loader.ts` | One gene map per symbol (`:91-92`); guidelines keyed by drug and gene set (`:94-96`); production refuses 1.2 (`:79`); supersession compares drug names (`:180`). It never reads `rxcui` or `hgncId` |
| Knowledge set | `apps/backend/src/services/knowledge/knowledge-set.ts` | Gene maps by symbol (`:33`), guidelines grouped by drug name (`:34-39`); `gene()`, `guidelinesForDrug()`, `drugs()` (`:51-62`) |
| Engine | `recommendation-engine/recommendation-engine.ts` | Asked for drugs by name (`evaluationOptionsSchema.drugs`, `cpic-schema/src/evaluation.ts:43-45`); `identifiersFor` (`:136-145`) copies ids only when the guideline and every gene map are 1.3. Not changed |
| Stored results | migrations 0008, 0071; `storage/postgres/ledger-records.repository.ts:507-538`; `ledger/projections.ts:486` | `evaluation_results` has nullable `drug_rxcui`, `gene_hgnc_ids` (0071); `evaluation_gene_states` holds the symbol only. Not changed (D3) |
| Medications | migration 0066; `patient-medications/patient-medications.service.ts:59`; `packages/shared-types/src/drug-list.ts` | `drug_rxcui` required, digits; the drug list holds `IN` and `MIN` ids; a stored medication keeps the list version, from which the term type can be recovered. The MD-6 boundary (`patient-medications/clinical-boundary.spec.ts:9-27`) stops knowledge code importing medication code; in the other direction its patterns `services/engine` and `services/interpreter` match no folder, so nothing stops medication code importing knowledge code today. Not changed |
| Fixtures | `data/fixtures/knowledge/` | `synthetic-identifiers` (five 1.3 files) is the only 1.3 set; `synthetic`, `synthetic-structured`, `test-only-reader` are 1.2. Their hashes and set ids are pinned; none is edited |

## The changes

1. **`packages/cpic-schema/src/knowledge.ts`**: a new exported function, `isRxcuiForm(value: string): boolean`, true when the value matches either form in `IDENTIFIER_FORMS.rxcui`. The constant stays private: `as const` does not freeze an object, and the schema reads it on every parse, so exporting it would let any consumer weaken validation for the whole process. Every hash and parse is unchanged.
2. **`knowledge-loader.ts`**: after the existing per-file checks, three cross-file rules (IK-1) and one (IK-2), each a problem naming both files: `drug "<name>": <a> and <b> state different RxNorm ids.`, `<a> and <b> state the same RxNorm id for two drugs.`, `<a> and <b> state the same HGNC id for two genes.`, `drug "<name>": <a> is schema 1.2 and <b> is 1.3; a drug is identified in all its files or in none.` A drug name is already a closed lower-case form (`drugNameSchema`), so naming it prints no content. Run in every mode, before the set is built.
3. **`knowledge-set.ts`**: four read-only lookups (IK-3): `drugForRxcui(id)`, `rxcuiOfDrug(drug)`, `geneForHgnc(id)`, `hgncOfGene(gene)`, built once in the constructor from 1.3 files only. Plain `Map` lookups by exact key. The constructor throws when the files break IK-1, because two callers build a set without the loader (`dispute-overlay.ts:85`, `test/helpers/report-lookup.ts:85`) and a `Map` would otherwise keep the last file silently. The loader reports the same conflict first, as a problem naming the files, so a loaded set never reaches that throw. IK-2 and the supersession rules stay the loader's only: of the two direct callers, the dispute overlay copies a loaded set and the report-lookup helper builds 1.2 files only.
4. **`services/knowledge/identifier-map.ts`** (new, IK-4): `mapRxNormIngredients(knowledge, ids: readonly string[]): IngredientMatch[]`, where `IngredientMatch` is `{ rxcui, status: 'matched', drug, guidelines: { id: string; supersededBy: string | null }[] }` or `{ rxcui, status: 'not-matched', reason: 'no-identified-guideline' | 'invalid-identifier' }`. An id is well formed when `isRxcuiForm` accepts it, in either form, whatever the set holds; a well-formed id no guideline states is `no-identified-guideline`, in a synthetic, real, mixed or empty set alike. `guidelines` lists every guideline file of the drug, sorted by id, with `supersededBy` worked out from the `supersedes` fields of the set's files, as the engine does (`recommendation-engine.ts:59`), so a caller cannot take a superseded file for a current one. No import but `KnowledgeSet` and `@telesphoros/cpic-schema`.
5. **`services/knowledge/identifier-map-boundary.spec.ts`** (new, IK-6): the module imports only those two; no file outside `services/knowledge` imports it or names `drugForRxcui`, `rxcuiOfDrug`, `geneForHgnc` or `hgncOfGene`; no file under `patient-medications/` imports from `services/`. The walker reads `import`, `import type`, `export … from`, `require`, dynamic `import()` and a bare `import '…'`, and inline source strings in the spec prove each form is seen (not files on disk, which the type check and MD-6's own walk would read).
6. **`apps/backend/test/helpers/knowledge.ts`** (IK-7): `toSchema13` gives each drug name and each gene symbol its own real-form id beyond any assigned range, derived from the name so the same drug always gets the same id: `99` followed by ten digits for an RxNorm id, `HGNC:9` followed by six digits for an HGNC id, with a check that two names never share one. No test imports `TEST_REAL_FORM_IDS`; only the helper reads it, so it keeps `pharmvarVersion` and drops the two ids it no longer uses.

Not changed: the engine, `identifiersFor`, every migration and stored row, the ledger, the medications module and its MD-6 spec, the front end, `knowledge/cpic/`, every committed fixture.

## Fixtures (invented, written before the code)

`data/fixtures/knowledge/identifier-conflicts/`, one folder per case, each a complete small set that loads cleanly except for the one conflict:

| Folder | Case | Expected |
| --- | --- | --- |
| `one-drug-two-ids/` | two 1.3 guidelines for `drugq` (different gene sets) with different `rxcui` | refused, IK-1 |
| `two-drugs-one-id/` | `drugq` and `drugr` stating one `rxcui` | refused, IK-1 |
| `two-genes-one-id/` | gene maps `GENEA` and `GENEB` stating one `hgncId` | refused, IK-1 |
| `half-identified-drug/` | a 1.2 and a 1.3 guideline for `drugq` | refused, IK-2 |
| `control/` | a 1.3 drug with two guideline files and the same `rxcui`; a 1.3 guideline over a 1.2 gene map; and a drug whose files are all 1.2 | loads; the second has no identifiers on its results, as today; the third has no id (IK-3) and its name never matches (IK-4) |

`data/fixtures/knowledge/identifier-map/`: a small invented 1.3 set and `expected.json`, the invented id list with the hand-written answer for each. The set holds a drug with a superseded file and its successor, and a drug whose name is spelled like an id (`syn-rxcui-drugr`, which the drug-name schema allows) but whose `rxcui` is another value. The list holds: matched ids; an id no guideline states; the id spelled like that drug's name (`no-identified-guideline`, which a name fallback would match); a well-formed digits id, which this synthetic set does not hold (`no-identified-guideline`); a malformed id (`invalid-identifier`); a plain drug name (`invalid-identifier`); and a repeated id. A drug known only from a 1.2 file is checked against the `control` set.

## Tests, written first and seen to fail

| Spec | Covers |
| --- | --- |
| `knowledge-loader.spec.ts` (added cases) | IK-1, IK-2: each conflict fixture refused with its rule; `control` loads; every existing case unchanged |
| `knowledge-set.spec.ts` (new or added) | IK-3: the four lookups, exact match, no case folding, 1.2-only drug has no id, unknown id has no drug; a set built directly that breaks IK-1 throws |
| `identifier-map.spec.ts` (new) | IK-4, IK-8, IK-9: the expected answers; order kept; repeated ids; superseded files marked; nothing logged; the same answers from a `KnowledgeSet` built with its files in reversed order (the loader sorts files before reading, `knowledge-loader.ts:201-208`, so order is tested on the set itself) |
| `identifier-map-boundary.spec.ts` (new) | IK-6, with a control file for each import form |
| `test/helpers/knowledge.ts` callers | IK-7: every signed test copy loads under IK-1; two drugs never share a test id |
| existing suites | IK-7: pinned hashes, set ids, engine and MD-6 specs pass, unchanged except for the helper |

IK-5 has no test of its own: the mapping cannot tell a combination product's id from an ingredient's, so a test of it would run the same path as any unknown id and could not fail. It is a curation rule, recorded in the clinical validation note.

## Deliberate breakages

One at a time, in a sealed job, after a control run that must pass: each of the four loader rules removed; the constructor's conflict check removed; each lookup made case-insensitive; the mapping falling back to a name match; the form check removed; `supersededBy` always null; the order of answers changed; a forbidden import added to the mapping module; a lookup called outside `services/knowledge`; a `services/` import in a medication file; the boundary walker missing each import form; the helper giving every drug one id again. Expected survivors named before the run: the reversed-order test of IK-9, which no single change can turn red, because the set sorts each drug's files (`knowledge-set.ts:38`), the mapping sorts by id and conflicts are refused; it is kept as a record of the property.

## Verification

In sealed jobs, never on the host: the new and changed specs; `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `check:chunks`, `knowledge:verify --production --allow-empty`; `pnpm test:infra`, `pnpm test:ci-config`, `pnpm check:workflows`; the database and storage tier in three shards and the worker tier, because the constitution requires them even though no schema changes; gitleaks on the host. Records: `docs/verification/2026-11-12-identifier-keys.md` and `docs/clinical-validation/identifier-keys.md`. The pull request uses the template headings (Summary, What this does NOT touch, How it was verified, Safety invariants, Follow-ups).

## Not in this slice

Any caller of the mapping; spec 031's flags and their clinical sign-off (D7); HGNC ids on stored gene states (D3); asking the engine by id (D5); splitting combination products (D2); recording an RxNorm release on guidelines (D6); real identifiers; the private repository, which runs its whole loop again when it next merges public.
