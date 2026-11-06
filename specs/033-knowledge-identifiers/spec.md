# Knowledge identifiers (spec 033)

Date: 2026-11-04
Status: Approved by the founder 2026-11-05 (D1 and D2 as recommended, D3 not included).

## Why

A drug or gene in a stored evaluation is a name today. This spec adds standard identifiers to the knowledge file format and to stored results, called K2 in [the data-model plan](../../docs/design/plans/pgx-data-model-and-data-products.md#6-what-to-do-now-and-what-not-to): RxNorm for drugs, HGNC for genes, the PharmVar release for allele definitions, and the origin of every guideline cell, so each signed cell can state which source's terms apply to it. It adds no graph store, reasoner or model call in a clinical path; the deterministic lookup engine stays.

This repository carries the format, the loader rules and invented fixtures only. Signed knowledge with real identifiers and origins is not part of this repository.

## Scope

Synthetic content only. No real CPIC, ClinPGx, PharmGKB or PharmVar content is fetched or written; `knowledge/cpic/` stays empty.

| ID | Requirement |
| --- | --- |
| K2-1 | Knowledge schema 1.3 sits beside 1.2. A 1.2 file parses exactly as today, so its content hash, every pinned fixture hash and every stored knowledge set id are unchanged. |
| K2-2 | A 1.3 guideline file names its drug's RxCUI (`rxcui`) and gives every cell an `origin`. A 1.3 gene map names the gene's HGNC id (`hgncId`) and its `origin`, and, when it lists alleles, the PharmVar release they were defined in (`pharmvarVersion`). See D2 for why identifiers sit where they are defined rather than on every cell. |
| K2-3 | `origin` is one of `cpic`, `pharmgkb`, `pharmvar`, `unknown`. A reviewed, non-synthetic file with any `unknown` origin is refused by the schema, so `knowledge:hash` will not print a hash for it and the loader refuses it in every mode. |
| K2-4 | Production refuses a reviewed, non-synthetic 1.2 file: it has no origin, which counts as `unknown`. No such file exists today. |
| K2-5 | Identifier forms (D1). Non-synthetic files use the real forms: RxCUI as digits (the form `patient_medications.drug_rxcui` already checks), `HGNC:` plus digits, and a dotted PharmVar release number. Synthetic files must use `syn-rxcui-…`, `syn-hgnc-…` and `syn-pharmvar-…`, and a real-form identifier in a synthetic file is refused, so an invented id can never look like, or collide with, a real one. |
| K2-6 | The recommendation engine copies the identifiers onto each drug result produced from 1.3 knowledge: the RxCUI, each gene's HGNC id and PharmVar release, and the cell's origin. A result from 1.2 knowledge is unchanged. Identifiers never change an outcome, a reason code, a hold or which cell is selected. |
| K2-7 | Migration 0071 adds nullable identifier columns to `evaluation_results`: `drug_rxcui`, `gene_hgnc_ids`, `pharmvar_versions`, `cell_origin`, with format checks and an all-or-none constraint. It inserts no rows. It is labelled `compat: breaking`: [database.md](../../docs/database.md#migration-labels) forbids an `expand` migration from adding a `CHECK` to an existing table, and the checks are the guard. The down file refuses to run while any row carries identifiers (repair forward), as 0070's does. |
| K2-8 | The identifiers are inside the ledger hash when present and absent from the hashed projection when null, the same rule 0070 used for `sourceKind`. Every existing evaluation's projection, hash and ledger walk are unchanged. |
| K2-9 | A third fixture set, `data/fixtures/knowledge/synthetic-identifiers/`, holds invented schema 1.3 content. `synthetic/` and `synthetic-structured/` stay byte-identical, because PDF evaluation tests pin the first and the staging image pinned to `767bd0b5` carries the second. |

## Decisions for the founder

| ID | Decision | Recommendation | State |
| --- | --- | --- | --- |
| D1 | Form of invented identifiers in synthetic fixtures | `syn-` prefixed forms, accepted only when `synthetic: true`; real forms refused there | Accepted 2026-11-05 |
| D2 | Where the identifiers live. The brief says "per cell". | RxCUI once per guideline file (one drug per file), HGNC id and PharmVar release once per gene map, `origin` per cell and per gene map. Every result still carries all four per cell (K2-6). Repeating a drug's RxCUI on every cell would allow two RxCUIs for one drug in one file. Spec 031 also asks for an exact RxNorm ingredient identifier per drug. | Accepted 2026-11-05 |
| D3 | Refuse a non-synthetic `origin: pharmvar` file under the public `knowledge/cpic/` (PharmVar content is CC BY-SA 4.0 with a no-sale site term) | Not included unless the founder asks for it | Not included (2026-11-05) |

## Contradictions found, and how this spec treats them

1. **K2 timing.** The founder decision of 2026-10-21 scheduled K2 for the first signed guideline, after confirming CPIC's identifier fields and closing R13. This slice adds the schema now, on synthetic content only. The founder approved this reading on 2026-11-05, with the format first and R13 kept as the gate for content: schema now, no real identifiers until the CPIC fields are confirmed at source and R13 is answered (task T10).
2. **Seeds and migrations.** Migrations hold schema and functions only. 0071 adds columns and constraints; fixture values live in fixture files and test setup.
3. **Disputes on the structured path.** The dispute overlay is applied only on the PDF evaluation path (`evaluations.service.ts`); the structured synthetic assessment from spec 032 S3 does not read disputes. Any later re-assessment work must say which path it re-checks. Nothing here depends on it.
4. **Pinned fixture hashes.** Moving the existing fixture sets to 1.3 would change hashes that tests and the pinned staging image rely on. K2-9 adds a third set instead.
5. **Spec 031 sequencing.** Draft spec 031 asks for an approved RxCUI mapping contract in signed knowledge before any medication–gene flag, after a clinical signer is named. This spec supplies the schema half of that contract only: no mapping content, flag, route or clinical output. Real mappings still need that signer.

## Not in this spec

Real identifiers or content; `knowledge/cpic/`; the release workflow, required checks and Terraform; the structured assessment's knowledge set; reading identifiers through the API; population fields (K2 in the data-model plan mentions them; nothing needs them yet); FHIR or CDS Hooks codings.

AI disclosure: Claude (Opus 5.5) drafted this specification from the repository at `767bd0b5`; the founder reviews and approves it.
