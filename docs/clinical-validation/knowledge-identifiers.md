# Knowledge identifiers (spec 033)

Knowledge schema 1.3 adds an RxCUI to each guideline, an HGNC id, an origin and (for genes mapped from alleles) a PharmVar release to each gene map, and an origin to each guideline cell. The engine copies them onto each result that has a citation, and the result row stores them inside the ledger hash (migration 0071).

The clinical claim is a negative one: identifiers change no outcome, reason code, hold, cell selection, wording or strength. They are read only after the cell is chosen, from the same guideline and gene maps, and a result from schema 1.2 knowledge is unchanged.

Evidence, all on invented content:

- Over every combination of the two genes' phenotypes, the results from `data/fixtures/knowledge/synthetic-identifiers/` equal the results from `data/fixtures/knowledge/synthetic-structured/` once the identifiers are removed. The two sets hold the same cells; a loader test checks that they differ only by the 1.3 fields and the provenance label.
- Expected identifiers for a shown cell, an unverified (held) cell and an explicit "No recommendation" cell are written by hand from the fixture files. Where no cell applies, or a gene is missing so the table is held without a citation, no identifiers are given.
- A guideline whose gene map is still schema 1.2 gets no identifiers, so a result never mixes a 1.3 drug id with a gene that has none.
- Removing the copy, the gene-map version check or the origin copy each turns a test red.

Not covered: no real RxNorm, HGNC or PharmVar identifier is used or checked; the real formats are to be confirmed against CPIC's own fields before the first signed file. Identifiers are not yet returned by the API or shown to anyone.
