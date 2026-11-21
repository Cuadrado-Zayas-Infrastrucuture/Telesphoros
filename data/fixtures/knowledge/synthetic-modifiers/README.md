# Synthetic gene modifier lists (spec 045 N1)

Invented lists, used only to test the gene modifier list format and its loader. Nothing here is FDA content or clinical advice.

- The genes (`GENEA`, `GENEB`) and their `syn-hgnc-` ids are those of `../synthetic-identifiers`. The drugs (`drugm`, `drugn`, `drugp`)
  are invented and appear in no other fixture. Every identifier uses the `syn-` form the schema requires of a synthetic file.
- `syn-modifiers-a` lists one drug for two genes, out of gene order, so a test can see the set sort them; it states the origin `fda` and the
  licence `us-government-work`. `syn-modifiers-b` states `unknown` for its origin, licence and redistribution, which a synthetic file may.
- Effects and strengths cover `inhibitor` and `inducer`, `strong` and `moderate`. The labels test the format; they do not mean any drug
  changes any gene's effect.

Every file is `synthetic: true` and unreviewed, so the loader refuses it under the production rules, which the API always uses for
`GENE_MODIFIERS_DIR`.
