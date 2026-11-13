# Identifier keys for drugs and genes (spec 039)

Spec 039 makes the RxNorm id of a drug and the HGNC id of a gene a key the knowledge set can be trusted on, and adds the contract that turns a
medication's RxNorm ingredient ids into the knowledge set's drugs. It changes no result. The engine is still asked for drugs by name; no
outcome, reason code, hold, cell selection, wording, strength or stored row changes; nothing calls the mapping, and nothing is shown to a
clinician.

## What it decides

- **One id, one drug; one drug, one id.** The loader refuses, in every mode, a set where two drugs state one RxNorm id, one drug states two,
  two genes state one HGNC id, or a drug is described by both schema 1.2 and 1.3 files (so identified in some files and not others). Each
  refusal names the drug and both files. Before this, nothing read the ids, and a lookup by id would have taken whichever file came last.
- **An exact match, never a name.** The mapping matches an id only to the drug whose guidelines state it. A drug's name is never tried as an
  id, even a name spelled like one; a drug name given as an id is refused as `invalid-identifier`; case and spaces are not folded.
- **Superseded tables are named.** A matched drug lists every guideline file it has, and a file that a combined table replaces names that
  table, so a caller cannot show the narrower table on its own. This is the engine's own rule, read the same way.

## "Not matched" is not "no guidance" (D6)

`not-matched` says only that no guideline in this knowledge set states the id. It never means that no pharmacogenomic guidance exists for
the drug. It is the answer for: a drug this set has no guideline for; a drug whose guidelines are still schema 1.2 and state no id; an id
RxNorm has since retired or remapped (a medication records the drug list's RxNorm release, a guideline records none yet); and a
combination product when the guidelines state only its ingredients' ids. A caller (spec 031) must not present it as "no interaction" or "no
recommendation". The guideline's RxNorm release is recorded with the first real content (intelligence plan, phase 4).

## The curation rule (IK-5, D2, D8)

The mapping cannot tell an ingredient id from a combination id: it matches whatever id a guideline states. So the safety of a match rests on
curation, which nothing in this repository checks:

- A guideline states the RxNorm id of the drug its source names: the single ingredient (`IN`), never a salt, brand or product id.
- Where the source's drug is itself a combination, the guideline states the combination's (`MIN`) id. CPIC's drug records give two such
  drugs: sulfamethoxazole / trimethoprim (10831) and fluticasone / salmeterol (284635). A medication of that combination then matches the
  guideline; a medication of either ingredient alone does not.
- Combination products are not split into ingredients (D2). A medication stored as a combination is matched only by a guideline that states
  the combination's id; it is not matched to the guidelines of its ingredients. Splitting needs RxNorm relationship data, its licence
  reading and a reviewed table, in a later spec.

The rule belongs in the private curation registry, where the first real guidelines are entered.

## Evidence (all on invented content)

- Hand-written fixtures: `data/fixtures/knowledge/identifier-conflicts/`, one set per conflict and a control, with the exact problem
  expected for each in `expected.json`; `data/fixtures/knowledge/identifier-map/`, a set with a superseded table and a drug named like an
  identifier, and the expected answer for each invented id. Each was written before the code.
- Every conflict set loads with the loader as it was, so each is refused only for its one conflict; the control (one drug in two files with
  one id, a 1.3 guideline over a 1.2 gene map, a drug with only 1.2 files) still loads.
- Each rule, each lookup's exact match, the name fallback, the form check, the superseded marks, the order of answers and each import the
  boundary watches was removed or broken on purpose, one at a time, and each turned a test red
  (`docs/verification/2026-11-12-identifier-keys.md`).

## Not covered

No real RxNorm or HGNC id is used or checked. The mapping is a mechanism only: approving it for clinical use stays with spec 031's named
clinical signer, before any caller (D7). A pharmacogenomic locus with no HGNC id (for example the CYP2C cluster variant in the warfarin
guideline) cannot be a schema 1.3 gene map until a format decision says how it is identified (D9). HGNC ids are not added to stored gene
states (D3), and the engine is not asked by id (D5).
