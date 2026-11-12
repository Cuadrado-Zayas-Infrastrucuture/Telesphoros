# Identifier keys for drugs and genes (spec 039)

Date: 2026-11-12
Status: draft. `plan.md` is NOT approved; no code may be written until it is (constitution I). Decisions D1 to D5 are open.

## Why

A drug in this system is a lower-case name and a gene is a symbol. Patient medications are stored by their RxNorm ingredient id (`patient_medications.drug_rxcui`), never by name. So the two cannot be joined, and nothing may join them by name: draft spec 031 (medication–gene review flags), requirement 3, asks for "the approved signed-knowledge RxCUI mapping contract" first, and forbids a case-insensitive name join as a shortcut.

Spec 033 (knowledge identifiers, K2, approved 2026-11-05) supplied the format half. A schema 1.3 guideline states its drug's RxNorm id (`rxcui`), a 1.3 gene map states its gene's HGNC id (`hgncId`), the engine copies both onto each result produced from 1.3 knowledge, and migration 0071 stores them on `evaluation_results`. Production already refuses any 1.2 file. Spec 033's own record says it supplied "the schema half of that contract only".

What is still missing, read at `ed9268a5`:

- The loader and the knowledge set key guidelines by drug name and gene maps by gene symbol, and never read the ids. Two files may give one drug two RxNorm ids, two drugs may share one, and two gene maps may share one HGNC id; all three load without a problem (`knowledge-loader.ts:91-96`, `knowledge-set.ts:33-39`).
- Nothing can answer "which guideline, if any, belongs to this RxNorm ingredient id?".

A data-migration audit of the business's AI plan, run for the founder on 2026-11-12, marked this HIGH: drugs keyed by name and genes by symbol in the knowledge and the stored results, with medications keyed by RxNorm id and no mapping between them.

## Scope

Invented data only. No real CPIC, RxNorm or HGNC content is fetched or written; `knowledge/cpic/` stays empty. No change to the knowledge format: `packages/cpic-schema` only exports its existing identifier forms (`IDENTIFIER_FORMS`, today private to `knowledge.ts`), so the mapping checks ids against the one definition. No change to the engine, any stored result, migration, ledger hash, route, screen or clinical output. No caller is wired to the mapping in this slice: spec 031's flags still need their clinical signer, intended use and signed mappings, and nothing here supplies those.

| ID | Requirement |
| --- | --- |
| IK-1 | **One drug, one RxNorm id; one gene, one HGNC id.** When the loader builds a set, every schema 1.3 guideline for a drug must state the same `rxcui`, no two drugs may state the same `rxcui`, and no two gene maps may state the same `hgncId`. Each is a load problem in every mode, naming both files and the rule. |
| IK-2 | **No half-identified drug** (D4). A drug with both a 1.2 and a 1.3 guideline file in one set is a load problem in every mode: a lookup by id would see only part of it. A 1.3 guideline over a 1.2 gene map stays loadable, as today, and its results carry no identifiers (`identifiersFor`, spec 033 K2-6). |
| IK-3 | **Lookups by id.** The knowledge set answers, by exact string equality with no case folding, trimming or fallback to a name: the drug for an RxNorm id, the RxNorm id of a drug, the gene for an HGNC id, and the HGNC id of a gene. A drug or gene known only from 1.2 files has no id, and an id the set does not hold has no drug or gene. |
| IK-4 | **The medication mapping contract** (spec 031 requirement 3; D1). A pure function takes the knowledge set and a list of RxNorm ids, as plain strings, and returns one answer per id, in the order given: either `matched`, with the drug and the ids of its guideline files, or `not-matched`, with a reason from a closed list: `no-identified-guideline` (the set holds no guideline with that id) or `invalid-identifier` (not an RxNorm id in the form the set's content uses: digits for real content, `syn-rxcui-…` for synthetic, spec 033 K2-5). It never matches by name: an id the set does not hold is `not-matched` even when the medication's name equals a guideline's drug name. A repeated id gets the same answer each time it appears. |
| IK-5 | **Multi-ingredient products do not match** (D2). The drug list holds ingredient (`IN`) and multiple-ingredient (`MIN`) RxNorm ids (`packages/shared-types/src/drug-list.ts:34`). A guideline names one ingredient, so a multiple-ingredient id finds no guideline and is `not-matched`, `no-identified-guideline`. Splitting a combination product into its ingredients needs RxNorm's relationship data and a reviewed table; it is a later spec. |
| IK-6 | **No caller yet; the medication boundary stands.** The mapping module imports only the knowledge set and the knowledge schema. Nothing outside `services/knowledge` imports it in this slice; a spec enforces both, and the spec that adds the first caller lifts that fence. Spec 029's boundary (`patient-medications/clinical-boundary.spec.ts`, MD-6) is unchanged and still passes: medication code imports no knowledge code, and knowledge code imports no medication code. |
| IK-7 | **Nothing that exists changes.** The engine, every stored evaluation, the ledger and its hashes, every knowledge set id and every pinned fixture stay byte-identical. The existing fixture sets are not edited; the conflict cases of IK-1 and IK-2 get new, test-only invented fixtures. |
| IK-8 | **Problems carry no content.** A load problem names the files and the rule. The mapping returns ids and reasons only; it logs nothing. |
| IK-9 | **Deterministic.** The same set and the same list give the same answers, in the list's order, whatever order the files were read in. |

## Decisions

| # | Decision | Options | Recommendation | State |
| --- | --- | --- | --- | --- |
| D1 | Where the mapping lives | (a) A pure module in `services/knowledge`, taking RxNorm ids as plain strings, so neither side imports the other. (b) In the medications module, which breaks spec 029's MD-6 boundary. (c) In `packages/shared-types` | (a). The same way the intelligence plan passes medicines to the engine: as plain values | Open |
| D2 | Multiple-ingredient medications | (a) Never match in this slice (IK-5). (b) Split them into ingredients now | (a). Splitting needs RxNorm relationship data, its licence reading and a reviewed table | Open |
| D3 | HGNC ids on stored gene states (`evaluation_gene_states`, symbol only today) | (a) Not in this slice. (b) A new migration now, ids stored when known, hashed only when present (as spec 033 K2-8) | (a). Every identified result already stores the HGNC id of each gene behind it (0071), the knowledge set can answer symbol to id (IK-3), and a public migration now would take number 0075, which the private repository already uses, forcing a renumbering at the next merge from public | Open |
| D4 | A drug with both 1.2 and 1.3 files in one set | (a) A load problem (IK-2). (b) Load it and treat the drug as unidentified | (a). A half-identified drug would let a lookup by id silently miss guidelines. Production already refuses 1.2, so this changes nothing there | Open |
| D5 | Asking the engine for drugs by RxNorm id | (a) Not in this slice: a caller maps ids to drugs with IK-4 and asks the engine by name, as today. (b) Add an id option to the engine's request now | (a). The engine and its request schema stay unchanged, and so do the schemas the private repository builds from them | Open |

## Done when

1. Each conflict case of IK-1 and IK-2 has an invented fixture the loader refuses with the named rule, and removing the rule turns a named test red.
2. The lookups of IK-3 and the mapping of IK-4 give hand-written expected answers on an invented knowledge set and an invented list of ids, among them a name that equals a guideline's drug but an id the set does not hold, an id known only from a 1.2 file, a multiple-ingredient-shaped id, a malformed id and a repeated id. The answers are written before the code.
3. Every existing suite passes unchanged, including the pinned fixture hashes and knowledge set ids, the engine and the MD-6 boundary.
4. A clinical validation note in `docs/clinical-validation/` records what the mapping does and does not decide (constitution IV).

## Not in this spec

- Any medication–gene flag, route, screen or clinical output: spec 031, which still needs its clinical signer.
- Real RxNorm or HGNC content, a drug list change, or a guideline for a combination product (D2).
- HGNC ids on stored gene states (D3) and asking the engine by id (D5).
- The offline report lookup's sertraline routing (`report-lookup/routing.ts:23`, `:67`), which names its drug and is reached only by specs.
- The private repository. Its curation registry already requires both ids on every drug and gene record and compiles them into 1.3 files; it will take this change when public is next merged into it.

## Not checked

- Whether any test loads 1.2 and 1.3 guideline files of one drug into one set, which IK-2 would now refuse. The first task checks before anything depends on it.
- How the front end, the FHIR pilot package and the stored-result readers use drug names. None of them is changed here; the study for this spec read them by search only.
