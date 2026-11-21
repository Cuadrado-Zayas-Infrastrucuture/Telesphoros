# Plan: spec 044, slice B, the screen

**Status**: **approved by the founder on 2026-11-21: B-D1 to B-D4 as recommended (section 12). G3, the wording, is still open.** Plan only: no code. Read against `main` at `7f5f3cf` and slice A (PR #427) on
2026-11-21. Mock-up: [Genomic profile screen mock-up](https://claude.ai/artifact/F3uy2hnPATBE5GvCDs3Hap), four screens, synthetic patient
SYN-0042, placeholders where CPIC wording goes.

## 1. Who it is for, and the problem

Prescribers and pharmacists (spec 044 GP-N1), most of whom are not PGx specialists (founder, 2026-11-21: *"Physicians and most
pharmacists are not as technical with PGx, how can we make it easy for them to understand what their screen shows?"*). Diplotypes,
star alleles and activity scores mean little to them. They think in drugs: "can this patient take this?"

## 2. The rule that bounds every choice below

**CPIC's words stay the authority, quoted exactly.** The screen changes only what comes first, what is hidden until asked for, and what a
term means. No model writes or rewrites clinical text (gap analysis D2 = A), and every result keeps its basis one step away, as the FDA's
criterion 4 asks (M0.1 section 2).

## 3. The screen (mock-up screens 1 and 4)

In this order, under the patient banner (**B-D1**: this puts medications first, ahead of the order spec 044 D1 gave):

1. **One summary line**: "1 of 4 current medications has guidance to review". Counts only; never "all clear" or "no issues".
2. **A notice when a report waits for review**: "1 report is waiting for review. A second person has not yet confirmed that it belongs to
   this patient, so nothing from it is used below." (from `awaitingLinkReview`)
3. **Current medications, checked**: one row per current, active medication, drug name first, then the word, then layer 1.
4. **Check a drug before prescribing**: the existing drug field (ingredient or brand name); the answer is a row like the others, and
   "Nothing is saved."
5. **Genomic profile**: one card per gene, the phenotype in words, the source report and date, and "Confirmed by a reviewer". Genes a
   medication's guideline needs but no confirmed report includes read "Not tested".

Every section answers in place when the route answers 503 ("The genomic profile is not available in this environment.") or fails ("Could
not read the genomic profile. Retry."), and the rest of the patient page still works.

## 4. Three layers per medication (mock-up screen 2)

| Layer | Shown | Source |
| --- | --- | --- |
| **1. What to know** (always) | The word; CPIC's recommendation, quoted; its strength; one line "Because SLCO1B1 is decreased function in this patient's report." | `check.results[].recommendationText`, `strength`, and the gene and phenotype |
| **2. Why** (opened) | CPIC's own implication text for this phenotype, quoted; a link to the term's glossary entry | `check.results[].implication` |
| **3. The evidence** (opened) | Gene, phenotype as reported and the laboratory's translation version, diplotype as printed, report and date, who confirmed it, guideline and version, table and row, signers, "Guidelines changed since?" | the result's `citation`, the profile's gene sources |

When a result has no implication text, layer 2 says "CPIC gives no separate implication for this result." Slice K must therefore copy each
cell's implication where the guideline prints one (a requirement for its authoring).

## 5. The words, and the sentence each always carries (G3)

| API | Word on screen | Sentence (draft; the founders' to approve, in English and Spanish) |
| --- | --- | --- |
| `review` | **Guidance to review** | (the quoted recommendation is the sentence) |
| `held` | **Held** | The reason code's fixed message and its reviewer action, as the result screens already show them (`REASON_MESSAGES`) |
| `no-recommendation` | **No recommendation** | "CPIC publishes no recommendation for this result." |
| `no-guideline-loaded` | **No guideline loaded** | "The loaded guidelines do not cover this drug. This does not mean it is safe." |
| `knowledgeChanged` | a notice on the row | "The guidelines have changed since this result was made. A pharmacist must check whether it still applies." (today's wording, `resultStatus.ts`) |
| `conflict` | a notice on the row | "Two reports disagree about [gene]. Both are shown under the evidence." |
| `capped` | a notice on the section | "Showing results from the first [n] reports. Open Reports for the rest." |

Colour is never the only signal: every state is a word, the amber of Held and of notices passes contrast, and "Guidance to review" uses the
action teal, never the signal tangerine (`branding.md`). Results made with signed knowledge carry K2c's label.

## 6. A glossary, opened from ⓘ (mock-up screen 3)

General education about terms, the same for every patient, never about this patient. First terms: phenotype, diplotype, star allele,
decreased / increased / poor function, normal / intermediate / poor / rapid / ultrarapid metabolizer, activity score, Guidance to review,
Held, No guideline loaded. Each entry is written and signed by the founders (who and when shown at its foot), kept as reviewed content in
the repository, and is the same source the help assistant (slice A3) will answer from. The mock-up's text is a draft and says so.

## 7. Combination products (B-D2)

Spec 039 D2 does not split combinations, so a combination medication (`MIN`) is checked only as the combination and reads "No guideline
loaded" even when a guideline for one of its ingredients is loaded.

| Option | What it means |
| --- | --- |
| **a. Say so on the row (recommended now)** | Under every `MIN` medication: "Combination product: checked only as the combination. Its ingredients are not checked separately." |
| b. Check each ingredient | Needs RxNorm relationship data, its licence and a reviewed table (spec 039's later spec); a larger slice |

## 8. Data and release

- **The route** from slice A, `GET /patients/:id/genomic-profile`, and `?rxcui=` for a check. No new route.
- **`drugRxcui` on the evaluation DTO (B-D3).** Slice A moved it here, frontend first. The screen does not need it: the route already
  matches by RxCUI. **Recommendation: drop it** unless another screen needs it.
- The medication's type (`IN` or `MIN`) comes from the bundled drug list the frontend already holds.
- Released frontend first is not needed: slice B only reads a route slice A already serves.

## 9. Spanish

Every fixed string of this slice lives in one file, English and Spanish side by side. The Spanish is written by the founders, not machine
translated. Until it exists, the screen is English, as the rest of the app is today.

## 10. Decisions on a result (spec 044 D9)

"Record a decision" appears under layer 3, disabled with "Decisions are not switched on in this environment." wherever the server refuses
them (staging today). Enabling them is direction plan F4, not this slice.

## 11. Tests

- **Words:** each API word renders its word and sentence; no rendered text contains "safe", "no interaction", "normal response" or "OK"
  (GP-5); the summary line counts only `review`.
- **States:** 503, failure, `capped`, `awaitingLinkReview`, `conflict`, `knowledgeChanged`, a `MIN` medication, empty medications.
- **Check a drug:** brand name picks its ingredient; the request carries that RxCUI; nothing is written.
- **Layout and access:** browser tests at 390 and 1280 px, light and dark, keyboard only; 44 px targets; headings in order.
- **Usability:** spec 044 section 9's tasks, plus one for non-specialists: "Tell me in your own words what this screen says about
  simvastatin." It passes when the participant names the guidance, that it rests on the patient's SLCO1B1 result, and where the evidence is.

## 12. Decisions for the founders

- **B-D1.** Medications first, then the check, then the genomic profile. **Decided: yes.** It amends spec 044 D1's order.
- **B-D2.** Combination products (section 7). **Decided: a**, the sentence under every `MIN` medication.
- **B-D3.** Drop `drugRxcui` from the evaluation DTO. **Decided: yes.** It amends spec 044 D7 and slice A's plan, which had moved it here.
- **B-D4.** The glossary as signed, reviewed content in the repository, shared with the help assistant. **Decided: yes**; the founders
  write and sign each entry.
- **G3, still open.** The words and sentences in section 5, and the first glossary entries, in English and Spanish.

## 13. Not touched

The API, the engine, knowledge, decisions and follow-ups on staging, the worklist home (A1) and the help assistant (A3).
