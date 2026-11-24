# Phenoconversion notice: a drug being considered (spec 045 N4)

Date: 2026-11-24

"Check a drug before prescribing" now says when the drug being considered is listed as a strong or moderate inhibitor or inducer of a gene
that this patient's guidance rests on. It names the current medications whose guidance rests on that gene, and the drug's own guidance when
that does too. For example: "Starting this medication can change other guidance. Fluvoxamine strongly lowers CYP2C19 activity. The guidance
for clopidogrel, which this patient takes, is based on CYP2C19 and does not take this into account." The source is under the evidence.

How it behaves:

- **Shown only when something is affected (N4-D1).**
- **Only on the check (N4-D2).** The current medications' rows are unchanged.
- **Not for a drug the patient already takes,** which the N2 notice covers.
- **No change on staging:** no list is loaded there, so nothing shows.

The response gains an optional `candidateNotices` on the check. The wording is a draft awaiting the founders' signature (P-D6).
