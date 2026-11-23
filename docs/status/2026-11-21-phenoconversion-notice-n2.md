# Phenoconversion notice in the genomic profile (spec 045 N2)

Date: 2026-11-21

The genomic profile response can now say, as facts, when a patient's current, active medication is listed by a signed gene modifier list
(N1) as a strong or moderate inhibitor or inducer of a gene's protein. The response gains three optional fields: `contextNotices` on each
medication check, on the `?rxcui=` check and on each gene card, and `modifierLists.loaded`.

- A row's notice needs a gene its matching results used. A row with no matching result has none.
- Matching is by exact RxNorm id.
- Nothing else in the response changes, and nothing is stored.

Founder decisions of 2026-11-21: N2-D1, a drug being considered as a modifier of current medications, is a later slice. N2-D2, inhibitors and
inducers are both included. The wording (N3) is to be clear to someone with no PGx background, and simple to work with.

`GENE_MODIFIERS_DIR` is still unset in every environment, so on staging the response only gains `modifierLists: { loaded: false }`. The screen
that shows the notice is N3.
