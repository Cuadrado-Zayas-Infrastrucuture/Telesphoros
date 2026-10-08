# Synthetic knowledge fixtures

Invented genes (GENEA-GENEE) and drugs (drugv-drugy) used only by tests. Nothing here is CPIC content
or clinical advice. Every file is `synthetic: true`, so the loader refuses it in production and it can
never be marked reviewed. Real content belongs in `knowledge/cpic/` (see `docs/cpic-integration.md`).

The cells cover every verification state on purpose: most are `verified`, one is `unverified`
(drugy-geneb, Medium), one is `disputed` and one `unverified` in the combined drugv table, and one
combination of the combined table has no cell at all.
