# Feature Specification: The patient's genomic profile and a medication check (GP)

**Feature Branch**: `claude/gracious-wright-1u4guu` (this specification); each slice below gets its own branch and pull request off `main`

**Created**: 2026-11-21

**Status**: **Approved by the founder on 2026-11-21 ("Approved"), decisions D1 to D9 as written. G1 answered in part: the other co-founder
holds the second knowledge-signing key. Specification only: no code, migration, knowledge file or clinical hold changes.** Slice A's plan is
[plan-slice-a.md](plan-slice-a.md). It takes
over the draft [spec 031](../031-medication-gene-flags/spec.md) (medication–gene review flags), whose proposed decisions are carried into
section 4 for approval, and it is slice A2 plus B2 of the
[product direction plan](../../docs/design/plans/pharmacist-first-product-direction.md), merged and moved first.

**Input**: the founder, 2026-11-21: *"We need to focus our efforts on making it easier for clinicians to use this tool and to actually boost
productivity with less trial and error medication use backed by patient genomic profile."*

## 1. Why

Trial-and-error prescribing is reduced at one moment: when a clinician chooses or reviews a drug, they see what this patient's genes mean for
it, with the basis, in one step. Today that takes several steps and stops short:

- A patient's results are on the patient page (`PatientClinicalSections`), one evaluation at a time, with the decision controls a few
  disclosures deep (spec 038 F03). Nothing gathers the genes across reports into one profile.
- The medication list (spec 029) and the results sit side by side and never meet. MD-6 forbids any output that combines a medication with a
  genotype or phenotype, on purpose, until an approved scope like this one supersedes it (spec 031, requirement 6).
- There is no way to ask "what about this drug?" before it is prescribed.

## 2. Decisions recorded (founder, 2026-11-21)

| # | Decision | Replaces or amends |
| --- | --- | --- |
| **GP-N1** | **The screens serve prescribers and pharmacists**: the prescriber choosing a drug and the pharmacist reviewing a list, on one patient screen. | Amends N1 of the direction plan (a pharmacist-led service first) |
| **GP-N2** | **This work comes first**, before the worklist home (A1) and the help assistant (A3). | Reorders section 7 of the direction plan |
| **GP-N3** | **Both co-founders are pharmacists.** The founder is the first clinical signer for knowledge content; the other co-founder is a candidate second signer. Production loads a knowledge file only with signatures from two distinct signers ([cpic-integration.md](../../docs/cpic-integration.md), audit CLIN-01), so two pharmacists can meet that rule. | Answers spec 031's "pharmacist/clinical signer: not yet appointed" for the first signer; the second is decision G1 |

## 3. What already exists (read 2026-11-21)

| Need | In the repository | Gap |
| --- | --- | --- |
| Genes and phenotypes per evaluation | `evaluationDtoSchema.geneStates` (gene, state, phenotype, diplotype, activity score, reason code); `current`, `state`, `advisory.patientLink`, the knowledge-change advisory | No view across a patient's evaluations |
| A result per drug | The engine evaluates every drug in the knowledge set by default (`recommendation-engine.ts`, `knowledge.drugs()`); every result is stored with outcome, reason code, strength, verbatim wording and citation | none |
| The drug's identity on a result | `evaluation_results.drug_rxcui` (migration 0071, spec 033), set from schema 1.3 knowledge; synthetic knowledge must use `syn-rxcui-…`, which no real drug matches | The API does not return it (`evaluationResultDtoSchema` has `drug` text only) |
| The medication's identity | `patient_medications.rxcui`, chosen from the bundled RxNorm list (spec 029) | none |
| Real guidance | Signed knowledge loader; CPIC content is CC0 for the six named API endpoints (data-products plan, R13-CPIC) | `knowledge/cpic` is empty: M2.4 |
| A decision and a follow-up from a result | Clinician decisions (`cdr-v1`), acknowledgements, follow-ups | Decisions sit behind `LAB_REPORT_PIPELINE`, which production refuses, so staging cannot record one (direction plan F4) |

**What staging will show.** Until real content is signed and loaded, the only knowledge on staging is synthetic, its drugs carry `syn-rxcui-`
identifiers, and so every real medication reads "No guideline loaded". That is correct and safe. It also means the value of this work shows
only once M2.4 lands, which is why the content track (section 6) runs beside the screens.

## 4. Proposed decisions for approval

- **D1, one patient screen, three parts, in this order under the patient banner:** the **genomic profile**, the **current medications,
  checked**, and **check a drug**. Demographics and follow-up stay where they are, below.
- **D2, the profile is built from evidence a second person verified.** It lists each gene once, from current, active evaluations whose
  patient link is `verified`: phenotype, diplotype or activity score as the report gave them, the source report and its date. Evaluations
  whose link is `unverified` are listed apart as "Awaiting patient-link review" and never feed the profile; a `rejected` link never appears.
  Two current sources that disagree on a gene show both with the word **Conflict**, never one chosen. "Not tested" (no source names the gene)
  and "Tested, not resolved" (a source names it and the engine could not map it, with its reason code) are different words.
- **D3, a medication is matched to a result by RxCUI only**, the medication's ingredient RxCUI equal to the result's `drug_rxcui`. No name,
  brand, case-folding or fuzzy match (spec 031 requirement 3). Results from schema 1.2 knowledge carry no RxCUI and match nothing.
- **D4, five words for a medication, and never "safe":**

  | Word | When | What opens on demand |
  | --- | --- | --- |
  | **Review** | A matching result is `shown` | The guideline's verbatim wording and strength, the genes and phenotypes it used, the citation and its signers |
  | **Held** | A matching result is `held` | The reason code's fixed wording and the reviewer's action |
  | **No recommendation** | `abstained` or `no-published-recommendation` | What the guideline says about why |
  | **No guideline loaded** | No current result carries this RxCUI | "The loaded guidelines have nothing for this drug. This is not a finding that it is safe." |
  | **Guidelines changed** | Beside any word, when the knowledge-change advisory is `changed` | Which set was used and that the loaded set differs |

  "Review" is passive: no interruption, no modal, no colour that reads as an alarm (the signal colour is never a result, `branding.md`). It
  says there is guidance to read, not what to do (M0.1 I3).
- **D5, check a drug before prescribing.** The existing drug field (ingredient or brand name, spec 041 D1) picks an ingredient; the answer
  uses the same words as D4, for this patient. Nothing is saved: the drug is not added to the medication list, and the check is not a record.
- **D6, no engine run on the screen.** The check reads stored evaluations only; it never evaluates anew, so it cannot produce a result that
  is not already in the ledger. A drug the knowledge set gained after the evaluation reads "No guideline loaded" with "Guidelines changed".
- **D7, the join happens on the server**, in one read-only route, `GET /patients/:id/genomic-profile`, returning the profile, the checked
  medications and, with `?rxcui=`, one checked drug. Tenant-scoped, roles `reader`, `clinician`, `reviewer`, read only. It returns identifiers,
  outcomes and fixed wording, and never logs a medication, gene, phenotype or patient value (spec 031 requirement 4). The result DTO also gains
  the stored `drug_rxcui`, so the evaluation pages and this route agree.
- **D8, MD-6 is superseded by this scope only.** Its test changes from "no module combines a medication with a genotype" to "only the
  genomic-profile service reads both, and the engine, any interpreter and any verifier import neither" (spec 031 requirement 6).
- **D9, from a "Review" row, one step to record a decision and a follow-up**, using the existing decision vocabulary and follow-up form.
  Where the server refuses decisions (staging today), the row says so and offers nothing (spec 041 D4 pattern). Enabling them on synthetic
  staging is direction plan decision F4 and its own plan.

## 5. Requirements

| ID | Requirement |
| --- | --- |
| GP-1 | The route answers only for a patient of the caller's tenant; a foreign or unknown id is 404, as every patient route is. |
| GP-2 | The profile uses only current, active evaluations with a `verified` patient link (D2). A test holds an `unverified` and a `rejected` evaluation out of it. |
| GP-3 | A conflict between two current sources on one gene is shown, never resolved. A test gives two sources different phenotypes and expects both. |
| GP-4 | Medication and drug matching is by RxCUI equality only (D3). A test gives a medication whose name matches a result's drug but whose RxCUI differs, and expects "No guideline loaded". |
| GP-5 | Every medication gets exactly one of the D4 words; no other word, and none of "safe", "no interaction", "normal" or "OK", appears anywhere on the screen. A test searches the rendered text. |
| GP-6 | A synthetic result (`syn-rxcui-…`) never matches a real medication. A test loads synthetic knowledge and a real-RxCUI medication. |
| GP-7 | The route performs no write and runs no engine (D6). A test asserts it calls neither the engine nor any repository write. |
| GP-8 | Nothing about a medication, gene, phenotype or patient is written to logs, security events or URLs other than the route's own path and the `rxcui` query. |
| GP-9 | The screen works with 20 medications and 15 genes at 390 px and 1280 px, light and dark, keyboard only and with a screen reader; text is the signal, never colour alone. |
| GP-10 | With no guideline loaded for any medication, the profile still shows genes from evaluations and every medication reads "No guideline loaded"; nothing errors. Where evaluations cannot be read at all (both evaluation switches off), the route answers 503 like `GET /evaluations` and the screen says the profile is unavailable. |

## 6. Slices

| Slice | What | Depends on |
| --- | --- | --- |
| **A, the read** | `drug_rxcui` on the result DTO; `GET /patients/:id/genomic-profile`; MD-6 test replaced (D8). Backend and shared types; no migration | Approval of D1 to D8 |
| **B, the screen** | The three parts on the patient page (D1 to D5), against slice A | A |
| **C, from guidance to a decision** | D9: decision and follow-up from a "Review" row | B; direction plan F4 |
| **K, the first real content (M2.4)**, in parallel | A small first set of CPIC gene–drug pairs, authored and reviewed by the founder, signed by two pharmacists with two KMS keys, loaded where the profile reads it. Its own plan: which pairs, the signer keys (`knowledge-signing.tf`), the review procedure and a clinical-validation note | G1, G2 |

Slices A and B can be built and tested now, on synthetic data. Slice K is what makes them useful.

## 7. Decisions only the founders can make (open)

- **G1. The second signer.** **Answered 2026-11-21 (founder): the other co-founder holds the second signing key.** Still open, and
  separate: whether the same person becomes the named second approver that the two-person rules wait for (M0.1 I5 d, approval tiers D-A7, the
  second-reviewer decision FD-8). One person may hold several seats; who holds which is the founders' decision.
- **G2. The first gene–drug pairs.** Suggested for slice K, all with published CPIC guidelines: CYP2C19 with clopidogrel; CYP2C19 and CYP2D6
  with the SSRIs (sertraline is already on the founder's waiting list); SLCO1B1 with simvastatin; DPYD with fluoropyrimidines. The founders
  choose, and the choice is checked against the current CPIC guideline versions when slice K is planned.
- **G3. The wording in D4**, word by word, in English and Spanish. The founders are the clinical owners of it.
- **G4. Who sees the profile.** Settled by the approval of D7: all clinical read roles, `reader` included, as the patient page does today.

## 8. Out of scope

Interruptive alerts; dosing calculators; any model-written text; VCF or variant calling (M0.1 I2); CDS Hooks and EHR launch; the worklist
home (A1) and the help assistant (A3); patient-facing output (a device under the FDA guidance, M0.1 I1); real patient data, which still waits
on the AWS BAA and every release gate.

## 9. Success measures

Run with [the usability protocol](../../docs/design/clinical-workspace-usability-protocol.md) method, synthetic data, five participants
(prescribers and pharmacists):

1. **"Can SYN-204 take drug X?"**: answered from the patient page in under 30 seconds and two interactions, for a drug with guidance, one
   held, and one with no guideline loaded.
2. **No misreading of absence**: no participant reads "No guideline loaded" as "safe".
3. **No wrong patient**: with two labels differing by one character, no participant answers for the other patient.
4. Later, with real content and real use: medication changes recorded after a "Review", and follow-up responses, through the existing
   follow-up summary and, when governed, Data Insights. Those are the evidence of less trial and error; this slice only makes them possible.

## 10. How this was verified

Read on 2026-11-21: specs 029 (MD-6), 031, 033 (migration 0071), 038 and 041; `docs/cpic-integration.md` (review and sign-off, loader rules);
`packages/shared-types/src/lab-report.ts` (evaluation and result DTOs), `patient-medications.ts`; `apps/backend/src/services/recommendation-engine/recommendation-engine.ts`;
`apps/backend/migrations/0071_evaluation_result_identifiers.up.sql`; `apps/frontend/src/pages/PatientPage.tsx`; the direction plan and its
sources. Not verified: how the knowledge-change advisory is computed per result, the decision and follow-up routes' behaviour on staging
beyond their gates, and anything about CPIC guideline versions for G2. Nothing was run.
