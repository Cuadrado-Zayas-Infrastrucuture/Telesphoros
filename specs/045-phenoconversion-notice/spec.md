# Feature Specification: A notice when a current medication may change a gene's effect (phenoconversion, step 1) (PN)

**Feature Branch**: `claude/045-phenoconversion-notice` (this specification); each slice its own branch and pull request off `main`

**Created**: 2026-11-21

**Status**: **Approved by the founder on 2026-11-21: P-D1 to P-D5 as recommended (section 6). P-D6, the wording, is still open.
Specification only: no code, knowledge file or clinical hold changes.** It carries out
step 1 of spec 006's deferred item D08 (phenoconversion): **a factual notice only**, with no adjusted phenotype (founder, 2026-11-21:
"write the D08 plan, step 1 notice only").

**Input**: the founder asked how phenoconversion will be expressed. Phenoconversion is when a patient's response differs from what their
genotype predicts, most often because another drug they take inhibits (or induces) the same enzyme or transporter.

## 1. What is already decided (read 2026-11-21)

- **Spec 006 D08**: phenoconversion is its own clinical-logic slice with its own validation note.
- **Spec 032, contracts**: "Genotype-derived phenotype and context-adjusted interpretation (for example inhibitor exposure) remain separate,
  each with its evidence and rule version. Unknown medication timing cannot be replaced with 'current'."
- **Spec 032, case A12**: an inhibitor that starts or stops makes a new context; the original genotype and laboratory phenotype never change.
- **The knowledge format cannot express clinical context** (status note 2026-10-24); this spec does not ask it to: the notice is not a
  recommendation cell.
- **The genomic profile** (spec 044, slice A, PR #427) already reads a patient's current medications beside their results, and is the one
  module the MD-6 boundary allows to do so.

## 2. What step 1 does, and does not do

**Does:** when a medication's guidance rests on a gene, and another medication on the patient's current list is a listed inhibitor or inducer
of that gene's protein, the row says so, with the source:

> Paroxetine, on this patient's current medication list, is a strong CYP2D6 inhibitor (FDA table of substrates, inhibitors and inducers,
> [version], [table]). The guidance above is based on the genotype alone and does not account for it.

**Does not:** compute an adjusted phenotype, choose a different CPIC cell, change a word, hold a result, or say anything about a medication
that is not listed. The genotype result stays exactly as the laboratory reported it. Step 2 (an adjusted phenotype shown beside the
genotype one, from a signed adjustment rule) is a later spec.

## 3. Proposed decisions for approval

- **D1, the source of the list.** The FDA's *Drug Development and Drug Interactions: Table of Substrates, Inhibitors and Inducers* (and its
  clinician-facing examples page), which classes inhibitors as strong (raises a sensitive index substrate's exposure at least five-fold) or
  moderate (two- to five-fold). It covers the CYP enzymes and the transporters, including OATP1B1, the protein SLCO1B1 encodes. FDA states the
  lists are not exhaustive. As a US federal work it is expected to be free to reuse; that is to be confirmed (P-D2) before the first file is
  signed.
- **D2, the list is signed knowledge.** A new knowledge kind, the **gene modifier list**: one entry per ingredient (RxCUI, `IN` only), the
  gene whose protein it affects (HGNC id), the effect (`inhibitor` or `inducer`), the strength as the source states it, and the source
  locator. Reviewed and signed by two pharmacists like every other knowledge file, loaded under the production rules, and kept in its own
  folder, never inside `knowledge/cpic/`.
- **D3, what triggers a notice.** A medication row or a drug check whose matching results used gene G, and a **current, active** medication
  on the patient's list whose ingredient RxCUI is listed against G. The modifier may be the checked drug itself. Exact RxCUI only; a
  combination product is not split (spec 039 D2), and the row of a combination modifier says so.
- **D4, timing.** Only active medications count. An active medication with no recorded start adds "Its start is not recorded." Stopped
  medications are not used in step 1, even recently stopped ones; the "About this check" text says so (decision P-D3).
- **D5, which strengths.** Strong and moderate, as the source labels them; weak ones are not shown (decision P-D4).
- **D6, inhibitors and inducers.** Both, each in its own words ("inhibitor", "inducer"); the sentence is the same (decision P-D5).
- **D7, nothing is calculated or stored.** The notice is worked out when the profile is read, from the current medication versions and the
  loaded list; it is not stored. A decision recorded on a result (spec 006) records what was shown when that is built.
- **D8, absence never reads as "none".** No notice says nothing about medications that are not listed. The ⓘ "About this check" says: "This
  check names medications the FDA lists as strong or moderate inhibitors or inducers of the gene. The list is not exhaustive, and stopped
  medications and other causes, such as liver disease, are not checked." While no modifier list is loaded, it says instead: "Medications that
  can change a gene's effect are not checked yet."
- **D9, on the screen.** A notice on the row and on the gene's card, like "Guidelines changed": not a new word, no colour of its own beyond the
  amber of notices, and its source one step away. A glossary entry, "Phenoconversion", written and signed by the founders.

## 4. Requirements

| ID | Requirement |
| --- | --- |
| PN-1 | The list loads only under the production rules: reviewed, not synthetic, two valid signatures, a licence and redistribution that are not `unknown`. A synthetic list may use only `syn-` identifiers, as other knowledge does. |
| PN-2 | A notice appears only when a matching result's `genes` include the listed gene, and the modifier is a current, active medication of this patient. A test gives a modifier for a gene the result did not use, a stopped modifier, and a modifier of another patient, and expects no notice in each. |
| PN-3 | Matching is by RxCUI only, the same rule as spec 044 GP-4. |
| PN-4 | The genotype-derived gene state, the word, the matching results and every other field are identical with and without a notice. A test compares the two responses field by field. |
| PN-5 | No text says "no interaction", "safe" or "not affected"; the About text is shown whatever the list contains. |
| PN-6 | With no list loaded, the profile answers as today and the About text says interactions are not checked yet. |
| PN-7 | The notice names its source, version and locator; the evidence layer shows them. |
| PN-8 | Nothing is written: no ledger event, no stored notice. |

## 5. Slices

| Slice | What | Depends on |
| --- | --- | --- |
| **N0, the first list (founders)** | Strong and moderate inhibitors and inducers of **SLCO1B1 (OATP1B1)** and **CYP2C19**, from the FDA tables, reviewed and signed by both pharmacists. SLCO1B1 first because simvastatin is the first signed guideline; CYP2C19 for the next pairs. CYP2D6 follows its guideline's activity-score format decision. | D1, P-D2, the signing keys |
| **N1, the format and loader** | The gene modifier list kind in `packages/cpic-schema`, the loader, a `GENE_MODIFIERS_DIR` setting loaded under the production rules, synthetic test lists | D2 |
| **N2, the notice in the profile** | `contextNotices` on each check and gene of the genomic profile response, from the builder (spec 044 slice A) | N1; PR #427 merged |
| **N3, the screen** | The notice, the About text and the glossary entry, in slice B's layout | N2; spec 044 slice B |

The profile response is parsed strictly by the frontend, so N2 adds `contextNotices` as optional and the frontend that reads it is
released before or with the API that sends it.

## 6. Decisions only the founders can make (open)

- **P-D1.** Approve step 1 as described: a notice only, no adjusted phenotype. **Decided: approved.**
- **P-D2.** Confirm the FDA tables may be reused in the product, and whether the knowledge licence vocabulary gains a value for a US
  government work (today: `cc0-1.0`, `cc-by-4.0`, `cc-by-sa-4.0`, `proprietary`, `unknown`). **Decided: the vocabulary gains a value
  for a US government work** (slice N1). Reading FDA's own reuse terms on its pages, and recording what they say in the list's
  provenance, is a check the reviewing pharmacist makes before the first list is signed (slice N0); a list whose terms were not read
  is not signed.
- **P-D3.** Recently stopped modifiers: not in step 1 (recommended), or within a window the founders set per drug. **Decided: not in
  step 1.** Some inhibitors act for
  weeks after they are stopped; a window is a clinical rule and needs its own source.
- **P-D4.** Strong and moderate only (recommended), or weak as well. **Decided: strong and moderate only.**
- **P-D5.** Inhibitors and inducers together (recommended), or inhibitors first. **Decided: together.**
- **P-D6, still open.** The notice's wording and the glossary entry, in English and Spanish.

## 7. Out of scope

An adjusted phenotype or any change to the recommendation shown (step 2); causes other than medications (liver or kidney disease,
inflammation, age, pregnancy); drug-drug interactions that do not involve a gene the result used; dosing; interruptive alerts; any model
text.

## 8. How this was verified

Read on 2026-11-21: spec 006 (D08, research R17), spec 032 (contracts README, acceptance A12, coverage C02, C11, C27),
`docs/status/2026-10-24-schema-context-and-allele-status-gap.md`, `packages/shared-types/src/patient-medications.ts` (status and start
and stop months), the knowledge folders, and spec 044 with slice A. The FDA source was found by a web search; its full tables, current
version and reuse terms were **not** read and are P-D2's to confirm. Nothing was run.

Sources: [FDA, Drug Development and Drug Interactions: Table of Substrates, Inhibitors and Inducers](https://www.fda.gov/drugs/drug-interactions-labeling/drug-development-and-drug-interactions-table-substrates-inhibitors-and-inducers);
[FDA, Examples of Drugs that Interact with CYP Enzymes and Transporter Systems](https://www.fda.gov/drugs/drug-interactions-labeling/healthcare-professionals-fdas-examples-drugs-interact-cyp-enzymes-and-transporter-systems);
[an analysis of FDA inhibitor classifications against clinical pairs (PMC7292748)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7292748).
