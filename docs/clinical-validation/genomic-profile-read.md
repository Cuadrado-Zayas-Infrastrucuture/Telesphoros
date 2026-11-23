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
