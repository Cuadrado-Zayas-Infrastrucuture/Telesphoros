# Gene modifier lists: the format and the loader (spec 045 N1)

Date: 2026-11-21

Spec 045 slice N1, the signed list the phenoconversion notice will read. Knowledge gains a third signed kind, `gene-modifier-list` (schema 1.3
only): one entry per ingredient and gene, with the RxNorm id, the HGNC id, `inhibitor` or `inducer`, `strong` or `moderate`, and the source's
table and row. The licence vocabulary gains `us-government-work` (P-D2); the list's own origin vocabulary is `fda` or `unknown`.
`loadGeneModifiers` reads a flat directory under the same rules as the knowledge loader (hash, two signatures, every problem reported), and
`GENE_MODIFIERS_DIR` loads at start, always under the production rules; it needs `KNOWLEDGE_SIGNER_KEYS` and the assessment or the pipeline,
and may not be a knowledge directory. The CPIC loader refuses a list by name. `knowledge:hash` and `knowledge:sign` read lists, and
`knowledge:verify-modifiers` checks a directory. Synthetic lists are in `data/fixtures/knowledge/synthetic-modifiers/`.

Nothing reads the list yet (N2), no real list exists (N0, the founders'), and no environment sets `GENE_MODIFIERS_DIR`. No route, response,
migration, engine rule, guideline file, frontend or Terraform changes. Validation note: `docs/clinical-validation/gene-modifier-list.md`.
