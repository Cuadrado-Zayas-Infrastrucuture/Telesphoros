# Plan: spec 045, slice N3, the notice on the screen

**Status**: **draft, for the founder's approval.** Plan only: no code. Read against `main` at `90721a9`, which has slice N2 (the notices in
the profile response, PR #443) and the first part of spec 044 slice B (the screen, PR #440).

## What N3 delivers

The genomic profile screen shows the notices N2 sends, in plain words, and says what the check covers. In the founder's direction
(2026-11-21), the notice must be **clear to a prescriber or pharmacist with no PGx background, and simple and enjoyable to work with.**
So the row says it in everyday words first ("lowers", "raises"), and the technical terms (inhibitor, inducer, strong, moderate) and the
FDA source wait one step away in the evidence, like every other result on the screen (slice B, section 4).

Nothing else on the screen changes (PN-4): not a word, not a sentence, not the summary line.

## Where it appears

| Place | What it shows | Data |
| --- | --- | --- |
| **A medication row, or the drug checked before prescribing**, after the quoted recommendation, before "Why, and the evidence" | The notice: a short bold line and one sentence per gene and medication, in the amber of notices (D9). Always shown, never behind a button. | `check.contextNotices` |
| **The row's opened layers**, under "The evidence" | Where the notice comes from: the technical words, the source, its version, table and row, and a link to the FDA page (PN-7). | the same notices' `effect`, `strength`, `source` |
| **The gene's card** | The same notice, with a one-line source under it (the card has no opened layer). | `gene.contextNotices` |
| **Under "Current medications, checked"** | One line, always shown, saying what the check covers or that it is not running yet (D8, PN-5, PN-6); the ⓘ opens the full "About this check". | `modifierLists.loaded` |

## The words (draft; the founders' to approve and sign, P-D6)

All of them go in `apps/frontend/src/lib/genomicProfileWords.ts` with the rest of the screen's text, so the founders can rewrite them
without touching a component. English only until the founders write the Spanish (slice B, section 9).

| Case | Draft text |
| --- | --- |
| The bold line on a row or card | **A medication this patient takes can change this.** |
| Another medication, an inhibitor | "Paroxetine, which this patient takes, strongly lowers CYP2D6 activity. The guidance above is based on the genes alone and does not take this into account." |
| Another medication, an inducer | "Rifampin, which this patient takes, strongly raises CYP2C19 activity. The guidance above …" (the same second sentence) |
| Moderate | "moderately lowers" / "moderately raises" |
| The checked drug is its own modifier (N2 rule 2) | "Fluvoxamine itself strongly lowers CYP2C19 activity. The guidance above …" |
| No start recorded (D4) | adds "Its start date is not recorded." |
| On the gene card | "Paroxetine, which this patient takes, strongly lowers CYP2D6 activity. The result above is from the genes alone and does not take this into account." |
| The evidence (row) and the source line (card) | "Listed by the FDA as a strong inhibitor of CYP2D6." then "[source], version [v], [table], row [r]." and "Open the FDA source" |
| The line under the heading, a list loaded | "Medications that can change a gene's effect are checked against the FDA list of strong and moderate ones. That list is not complete." |
| The same line, no list loaded (or an older API that sends no `modifierLists`) | "Medications that can change a gene's effect are not checked yet." |
| ⓘ "About this check" (D8, as approved) | "This check names medications the FDA lists as strong or moderate inhibitors or inducers of the gene. The list is not exhaustive, and stopped medications and other causes, such as liver disease, are not checked." |

The drug and gene names in the table only illustrate the sentences; what the screen names comes from the signed list (N0), which this
plan does not write.

Several notices on one row read as one sentence each, in the order the server sends them (gene, then medication name). None of the text
says "safe", "no interaction", "not affected" or "none" (PN-5): a row with no notice says nothing about other medications, and the line
under the heading is shown whatever the list contains.

The word "phenoconversion" is not used on the row: it is the glossary's word (N3-D1).

## Decisions for the founders

- **N3-D1. The glossary entry "Phenoconversion".** The glossary does not exist yet: it is slice B part 2, with entries the founders write and
  sign (B-D4). **Recommendation: N3 ships without it, and the entry joins the glossary's first set** when slice B part 2 builds it. The
  alternative is to build the glossary here for one entry, which makes N3 the larger slice.
- **N3-D2. A line that is always visible, as well as the ⓘ.** D8 put the About text behind an ⓘ, but the screen's rule is that safety
  statements never go behind one (spec 041 D7), and "the list is not complete" and "not checked yet" are what stop an empty row reading as
  "no interaction". **Recommendation: yes**, the one-line summary under the heading is always shown, and the ⓘ keeps the full text.
- **N3-D3. Everyday verbs first.** "Lowers" and "raises" on the row, "inhibitor" and "inducer" in the evidence. **Recommendation: yes**, as the
  founder's direction asks. The alternative is the technical words on the row.
- **P-D6, still open.** All the text in the table above, and its Spanish. It stays marked as draft wording in the code until signed, as G3's
  is.

## Touched

| Path | Change |
| --- | --- |
| `apps/frontend/src/lib/genomicProfileWords.ts` | The words above, and `noticeSentence(notice, checkRxcui)`, `noticeEvidence(notice)`, `coverageLine(profile)` |
| `apps/frontend/src/components/patients/GenomicContextNotices.tsx` (new) | The notices on a row or card; one component per file (check-foundation) |
| `GenomicCheckRow.tsx`, `GenomicResultLayers.tsx`, `GenomicGeneCards.tsx`, `GenomicProfileBody.tsx` | Place the notices, the evidence, the line and the ⓘ (the existing `InfoButton`) |
| `GenomicProfileSection.test.tsx` | The tests below |
| `docs/clinical-validation/genomic-profile-read.md`, one status fragment | The screen's part of the notice |

## Not touched

No backend, schema, route, setting or knowledge change: the response already carries everything (N2). `GENE_MODIFIERS_DIR` stays unset
everywhere until N0's signed list exists, so **on staging every profile shows "not checked yet"** and no notice, which is the honest answer.
Not the glossary (N3-D1), not the reverse direction (a drug being considered as a modifier, N2-D1, a later slice), and not Spanish.

## Tests (working agreement 6)

- **Rendering:** a notice on a row, on the drug check and on a gene card; an inhibitor and an inducer; strong and moderate; the checked drug
  as its own modifier; a medication with no start recorded; two notices on one row, in order.
- **The evidence:** the technical words, the source, its version, table and row (a null row leaves it out), and the link, only once the
  layers are opened.
- **The line under the heading:** loaded, not loaded, and `modifierLists` absent, each with its text; the ⓘ opens and closes the About text.
- **PN-4:** a profile with notices renders every other text exactly as the same profile without them.
- **PN-5:** no rendered text, with or without notices or a list, contains "safe" (outside slice B's one "This does not mean it is safe."),
  "no interaction", "not affected" or "none".
- Each rule is broken in turn (a dropped notice, a wrong verb, the line hidden when no list is loaded) and a test must fail.
- **Usability (the founders, with a non-specialist):** "Tell me in your own words what the screen says about simvastatin." It passes when the
  participant names the other medication, says the guidance does not take it into account, and finds where the list comes from.

## How it will be verified

As for N1 and N2: the code is written here and **not run here** (founder decision P2); CI is the first run.
