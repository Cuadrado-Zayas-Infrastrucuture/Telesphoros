# The genomic profile read (spec 044, slice A)

`GET /patients/:id/genomic-profile` gathers a patient's genes from their current, verified evaluations and checks each current medication
against the stored results, by RxNorm id. It changes no result: no engine runs, no outcome, reason code, hold, cell selection, wording,
strength or stored row changes, and nothing is written. Every response says `clinicalUse: "not-approved"`. Nothing here is approved for
clinical use, and nothing is shown to a clinician until slice B.

## What it decides

- **Only verified evidence.** A current, active evaluation whose patient link a second person verified feeds the profile and the checks. One
  whose link is unverified is listed as awaiting review and used nowhere; a rejected link never appears.
- **Disagreement is shown, never settled.** Two sources that resolve a gene differently make the gene `conflict`, with both sources listed,
  and every check whose result used that gene says `conflict: true`. A source that could not resolve a gene beside one that did is listed and
  is not a conflict.
- **An exact RxNorm id, never a name.** A medication matches a result only when the medication's RxCUI equals the RxCUI stored on the result
  (migration 0071). A result from schema 1.2 knowledge has none and matches nothing; a synthetic `syn-rxcui-` id can never equal a real one.
- **Four words, in a fixed order** (founder decision P1): `review` if any matching result is shown, else `held`, else `no-recommendation`
  (abstained or no published recommendation), else `no-guideline-loaded`. Every matching result is listed with its outcome, so a held result
  beside a shown one stays visible. `knowledgeChanged` says when the guidelines a result used are no longer the loaded ones.

## "No guideline loaded" is not "safe"

`no-guideline-loaded` says only that no current, verified result of this patient carries the medication's RxNorm id. It is the answer for:
a drug the loaded guidelines do not cover; a drug whose guidelines are schema 1.2 and state no id; a drug the knowledge set gained after the
patient's evaluation (then `knowledgeChanged` is true); and **a combination product whose guidelines state only its ingredients' ids**.
Spec 039 D2 does not split combinations into ingredients, so a combination medication (`MIN`) such as an ingredient pair is checked only
against a guideline that states the combination's own id. A caller must not present any of these as "no interaction", "normal" or "safe";
slice B's wording (spec 044 G3) and its handling of combinations are founder decisions.

## Evidence (all on invented content)

- `apps/backend/src/genomic-profile/genomic-profile.builder.spec.ts`: rules 1 to 6 on hand-written inputs, each expectation written from the
  inputs beside it, including a medication whose name matches a result's drug but whose RxCUI differs, a `syn-rxcui-` result beside a real
  medication, a held result beside a shown one, and a profile with no guideline for any medication.
- `apps/backend/test/genomic-profile.e2e-spec.ts`: over real PostgreSQL and S3 with the synthetic assessment on, the profile of a stored
  structured assessment agrees with the stored evaluation, a recorded medication reads `no-guideline-loaded` (the synthetic knowledge is
  schema 1.2), and the read writes no evaluation or medication; with both switches off it answers 503; the roles, the tenant boundary and
  the query's RxCUI form are refused as the plan says.
- `apps/backend/src/patient-medications/clinical-boundary.spec.ts`: only the genomic profile imports both the medication service and the
  evaluation service, and it imports no engine, adapter, reader, interpreter or loader.

**Not yet shown:** that each rule's test turns red when the rule is removed. The code was written in a cloud session where no code may run
(founder decision P2), so the defect injections the working agreements ask for are still to be done, in the sealed sandbox or by hand
before merge.

## Not covered

No real RxNorm id, gene or guideline is used. Combination products are not split (spec 039 D2). The evaluation DTO does not yet carry
`drugRxcui`, and by founder decision B-D3 it will not: the profile route is where it is read.

## Spec 045 N2: the phenoconversion notice (facts only)

The profile can now carry, on a medication's row, on a drug checked before prescribing and on a gene's card, a notice that a current,
active medication of the patient is listed by a signed gene modifier list as a strong or moderate inhibitor or inducer of the gene's protein
(founder decisions P-D1 to P-D5, N2-D2). It is worked out when the profile is read and never stored.

Clinical claims, each with a test in `genomic-profile.builder.spec.ts` (hand-written expectations, invented genes and lists):

- **Only what the result rests on.** A row's notice needs a gene its matching results used; a row with no matching result has none, whatever
  the patient takes. A modifier of another gene gives none on the row, and is shown on that gene's card instead.
- **Only current, active medications** are modifiers: a stopped one, or an earlier version of the record, gives none (P-D3).
- **Exact RxNorm id only** (PN-3): a medication with the same name and another id gives none.
- **Nothing else changes** (PN-4): with the notices and the loaded-lists flag removed, the response equals the one built without lists.
- **Absence is said, not hidden** (PN-6): with no list loaded, no notice appears anywhere and `modifierLists.loaded` is false, so the screen
  can say that interactions are not checked yet.
- **The source is named** (PN-7): each notice carries the list, its version, URL, table and row as loaded.

The service test and an end-to-end test over PostgreSQL and S3 (a list signed by test keys, loaded under the production rules) show the
route carries the notice on the card and writes nothing (PN-8). As before, the tests run first in CI (founder decision P2); the defect
injections are still to do.


## Spec 045 N3: the notice on the screen (draft wording)

The genomic profile screen now shows N2's notices (plan `specs/045-phenoconversion-notice/plan-slice-n3.md`, founder decisions N3-D1 to
N3-D3, 2026-11-23). **Its wording is a draft awaiting the founders' signature (P-D6)**, in `apps/frontend/src/lib/genomicProfileWords.ts`.

Clinical claims, each with a test in `GenomicProfileSection.test.tsx` (invented genes, drugs listed against nothing real, an invented list):

- **Said where the guidance is, in everyday words.** On the row, after the quoted recommendation and without opening anything: "A
  medication this patient takes can change this.", then "[Medication], which this patient takes, strongly lowers [gene] activity. The
  guidance above is based on the genes alone and does not take this into account." "Raises" for an inducer, "moderately" for moderate,
  "[Drug] itself" when the drug is its own modifier, and "Its start date is not recorded." when it is not. The same sentence on the drug
  checked before prescribing, and on the gene's card with its source.
- **The source one step away** (PN-7): under "Why, and the evidence", the source's own terms ("listed as a strong inhibitor of [gene]"),
  the list, its version, table and row, and a link that is shown only for an `https` address.
- **Absence is never "none"** (PN-5, PN-6, N3-D2): a line always shown under the medications heading says the check uses the FDA list of
  strong and moderate ones and that list is not complete, or, with no list loaded or no `modifierLists` in the response, that it is not
  checked yet. The ⓘ gives spec 045 D8's full text. No rendered text, with or without notices or a list, says "safe" (outside slice B's
  one sentence that says the opposite), "no interaction", "not affected" or "none".
- **Nothing else changes** (PN-4): with the notice texts removed, the page's text equals the same profile's without notices.

On staging no list is loaded (`GENE_MODIFIERS_DIR` is unset until N0's signed list exists), so every profile says "not checked yet". The
glossary entry "Phenoconversion" waits for the glossary itself (slice B part 2, N3-D1). As before, the tests run first in CI (founder
decision P2); the defect injections are still to do.

## Spec 044 slice B part 2a: the glossary (draft entries)

The genomic profile's words now open a glossary in the side drawer (plan `specs/044-genomic-profile-medication-check/plan-slice-b2.md`,
founder decisions B2-D1 to B2-D3, 2026-11-23). The entries live in `packages/help-content/src/glossary.en.json`. **Every entry is a draft,
not yet reviewed by a pharmacist (B2-D2), and the drawer says so on each one.**

Claims, each with a test (`packages/help-content/src/glossary.test.ts` and `GenomicProfileSection.test.tsx`; invented genes and patients):

- **General education, never reassurance.** No entry says "safe", "no interaction", "not affected" or "none". Entries are plain text,
  with no markup or links.
- **Signed means two named pharmacists and a date.** A signed entry with fewer is refused at load, and so is a draft that names a signer.
  The foot of each entry says which it is.
- **Nothing is guessed.** A screen word opens an entry only when it equals one of the entry's aliases, ignoring letter case and repeated
  spaces. "Synthetic Poor", "Poor" and "Likely Poor Metabolizer" stay plain text.
- **The screen's sentences are unchanged.** "Because GENEA is Poor Metabolizer in this patient's report." reads whole with the value as a
  button, and the drawer's text is in the page only while it is open.

As before, the tests run first in CI (founder decision P2).

## Spec 044 slice B part 2b: "Record a decision", the signed-knowledge label and the browser tests

Founder decisions B2-D4 and B2-D5, 2026-11-23. Claims, each with a test (`GenomicProfileSection.test.tsx`, `genomic-profile.builder.spec.ts`,
`e2e/genomic-profile.spec.ts`; invented genes, patients and wording):

- **A decision is recorded in one place.** Under each result's evidence, "Record a decision on this result" opens that result in the
  patient's results list (`?result=`), where the existing decision form is. The profile itself writes nothing.
- **Where decisions are off, the screen says so.** In the synthetic staging the control is a disabled button, with "Decisions are not
  switched on in this environment." beside it in plain text.
- **The signed-knowledge label is where it is true.** Each profile result carries its evaluation's stored `scope`, copied unchanged. A row
  with a result made with the signed, real knowledge shows K2c's approved label once, under the drug's name. A row whose results carry
  another scope or none does not.
- **In a real browser,** at 375 and 1280 px and in light and dark, the section has no sideways scroll and no WCAG A or AA violation (axe,
  colour contrast included). Every control is a 44 px target, and the headings go down one level at a time. By keyboard, the evidence,
  a glossary word and the list of words open, and Escape returns focus to where it was.

The mobile width is the browser suite's 375 px baseline, narrower than the plan's 390 px. As before, the tests run first in CI (founder
decision P2).

## Spec 045 N4: a drug being considered that would change a gene's effect (draft wording)

Plan `specs/045-phenoconversion-notice/plan-slice-n4.md`, founder decisions N4-D1 and N4-D2 (2026-11-24). **The wording is a draft
awaiting the founders' signature (P-D6).**

Claims, each with a test (`genomic-profile.builder.spec.ts`, `GenomicProfileSection.test.tsx`, `test/genomic-profile.e2e-spec.ts`;
invented genes and lists):

- **Only for the drug being considered.** A `?rxcui=` check of a drug listed against gene G names:
  - the current, active medications whose matching results rest on G, in name order;
  - the checked drug itself, when its own results rest on G.

  The current medications' rows never carry it (N4-D2).
- **Only when it matters (N4-D1).** With nothing affected there is no notice. A stopped medication, a row with no matching result, and
  another drug in the list are never counted.
- **Not for a drug already taken.** A checked drug the patient already takes gets no candidate notice. Its effect is N2's notice on the
  rows (rule 8, an addition to the plan made while building it).
- **In everyday words, with the source one step away.** For example: "Fluvoxamine strongly lowers CYP2C19 activity. The guidance for
  clopidogrel, which this patient takes, is based on CYP2C19 and does not take this into account." The source's own terms, list, version,
  table and row are under "Why, and the evidence". No rendered text says "safe", "no interaction", "not affected" or "none".
- **Nothing else changes** (PN-4, the N2 comparison now also removes `candidateNotices`). With no list loaded there is none (PN-6). Reading
  writes nothing (PN-8).

As before, the tests run first in CI (founder decision P2).
