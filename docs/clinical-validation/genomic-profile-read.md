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
`drugRxcui`; slice B adds it, releasing the frontend first.
