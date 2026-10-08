# Test-only knowledge for the lab-report adapter

> **TEST ONLY: synthetic stand-ins, not CPIC content, not clinical advice.**

These files let the adapter tests run the twelve development reports (D01 to D12) through the real engine. They use the
real gene symbols CYP2C19 and CYP2B6 and the phenotype wording of the hand-off captures, because the reader's
registry names exactly those two genes; the allele tables and guideline cells are invented. Every file is
`synthetic: true`, so the loader refuses it in production and it can never be marked reviewed. Never copy any of it into
`knowledge/cpic/`. Real content is added only through the reviewed process in `docs/cpic-integration.md`.

| File | What |
| --- | --- |
| `phenotypes/cyp2c19-test-only.json`, `cyp2b6-test-only.json` | Two alleles (`*1` normal, `*2` none) and three canonical phenotypes. `*Z` is deliberately not defined |
| `guidelines/drugq-cyp2c19.json` | One gene: two verified cells and one unverified |
| `guidelines/drugr-cyp2c19-cyp2b6.json` | Two genes: two verified cells and one disputed |
