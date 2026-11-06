# Synthetic knowledge with identifiers (schema 1.3)

A third invented set, used only to test schema 1.3 (spec 033, slice 1): standard identifiers and the origin of each cell. The sets in
`../synthetic` and `../synthetic-structured` stay on schema 1.2 and byte-identical, because PDF evaluation tests pin the first set's content
hash and the staging image carries the second.

- The genes, drugs, phenotypes and cells are those of `../synthetic-structured`, with the schema 1.3 fields added and the provenance source
  relabelled. Nothing else differs.
- Identifiers are invented and use the `syn-` forms the schema requires of a synthetic file (`syn-rxcui-…`, `syn-hgnc-…`, `syn-pharmvar-…`).
  None is, or could be mistaken for, a real RxNorm, HGNC or PharmVar identifier.
- Cell origins cycle through `cpic`, `pharmgkb`, `pharmvar` and `unknown` in file order, so every value appears. Both gene maps say
  `pharmvar`. The labels test the schema; they do not mean any content came from those sources.

Every file is `synthetic: true`, so the loader refuses it in production mode. Nothing here is CPIC, PharmGKB or PharmVar content or clinical advice.
