# Gene modifier lists: the format and the loader (spec 045 N1)

Spec 045 step 1 adds a factual notice when a current medication is a listed inhibitor or inducer of a gene a result used (phenoconversion,
notice only). Slice N1 adds only the signed list such a notice will read, and the loader. **No notice exists yet**: nothing reads the list
until slice N2, and no real list exists until the founders sign one (N0).

The clinical claims are about what the list can and cannot carry:

- **Strong and moderate only (P-D4).** The format has no `weak` value, so a weak modifier cannot be listed by mistake.
- **Inhibitor or inducer (P-D5)**, one entry per ingredient and gene. An ingredient listed twice for one gene, which would leave the notice to
  pick an effect or a strength, is refused within a list and across lists.
- **Matching by exact RxNorm id (PN-3).** The loaded set answers by RxNorm id only: a name, a different case or a trailing space finds
  nothing. The reviewer confirms each id is the ingredient (`IN`) concept; the format cannot check the term type.
- **Absence is not "none" (D8).** An ingredient that is not listed gets an empty answer, and the code says that never means it changes no
  gene's effect. The wording that tells the clinician so is slice N3's, from the founders (P-D6).
- **The production rules, always (PN-1).** The API loads `GENE_MODIFIERS_DIR` under the production rules whatever `NODE_ENV` says: reviewed,
  not synthetic, two valid signatures, the licence, redistribution and origin stated. A list that fails stops the start. With no directory
  set, nothing is loaded (PN-6).
- **Never CPIC knowledge (D2).** The CPIC loader refuses a list by name in any of its folders, the list loader refuses any other kind, and the
  setting may not point at a knowledge directory.

Evidence, all on invented content (`data/fixtures/knowledge/synthetic-modifiers/`, invented drugs and genes, `syn-` ids): schema tests for
each refusal with a passing control; loader tests for the lookups, the sort, immutability, every production refusal (synthetic, unreviewed,
one signer, an unlisted signer, no keys, content changed after signing, unknown origin) against a signed copy that loads; cross-list
conflicts; the directory's shape; the CPIC loader's refusal; the factory under each `NODE_ENV`; and the CLI. None of it has run yet: CI is
the first run (founder decision P2).

Not covered: no FDA content is read, copied or checked here; whether the FDA tables may be reused, and their version, are P-D2's to confirm
before N0's first list is signed. The licence value `us-government-work` records what the reviewer read; it grants no right.
