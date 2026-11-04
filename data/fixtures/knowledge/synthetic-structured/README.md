# Synthetic knowledge for structured assessment

A second invented set, used only by the synthetic assessment of stored structured revisions (spec 032 S3). The base set in `../synthetic` is
left untouched because its content hash is part of every PDF evaluation test. This set exists because the only combined table there reads GENEA
and GENEE, and the structured contract carries GENEA to GENED only.

- `phenotypes/genea.json` and `phenotypes/geneb.json` are byte copies of the base files (a test fails if they drift).
- `drugz`: a combined GENEA x GENEB table (superseding the single-gene `drugz-genea`) with verified cells, one unverified cell, one explicit
  "No recommendation" cell, and combinations with no cell at all.
- `drugq`: a single-gene GENEA table with a verified cell, a second verified cell and an explicit "No recommendation" cell.

Every file is `synthetic: true`, so the loader refuses it in production mode. Nothing here is CPIC content or clinical advice.
