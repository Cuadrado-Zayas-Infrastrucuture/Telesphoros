# Disputed-cell evaluation listing

Owner-approved engineering scope: a read-only listing, including an explicit historical-identity-unverified category. Synthetic data only; no clinical approval or training release.

`GET /api/v1/cell-disputes/:id/evaluations` is available to clinician, reviewer and admin behind the existing pipeline gate. An unknown or foreign dispute is 404. The query accepts `limit` (1–100, default 50) and `afterSeq` (a nonnegative signed-bigint decimal string, default 0); unknown query fields are rejected.

The stored dispute supplies guideline id, version, content hash, table, row and nullable column. The inquiry does not require that guideline to be loaded today and works for open, upheld and dismissed disputes. Version, labels and hashes are exact; an omitted column and null are equivalent.

New evaluations record `binding.cellProvenance = {version: "cell-provenance/1", files: [{guidelineId, guidelineVersion, contentSha256}]}` from the actual loaded base knowledge. This metadata is inside the immutable projection hashed by the existing ledger and evaluation identity. The overlay changes verification only. The engine, citation schema and public evaluation contract are unchanged. Existing records are never rewritten.

The repository pages evaluations having a matching stored result citation (id/version/locator), using an explicit tenant condition on both evaluations and results. The service then classifies each citation:

- `exact-file`: the recorded provenance supplies one unambiguous matching hash.
- `historical-identity-unverified`: no usable file identity was recorded. Missing, malformed or conflicting metadata cannot prove a match. This is a review candidate, not a confirmed exposure.
- A usable recorded hash that differs is excluded.

An entry contains evaluation/report ids, creation time, current correction state, and matching result indexes with drug, outcome, identity category and `wordingExposed`. Shown results and published “No recommendation” results may carry wording; held citations do not. No patient id, genotype, recommendation wording, note body or source text is returned or logged by this endpoint. All entries remain non-actionable and not approved for clinical use. Retraction and supersession do not remove historical entries.

Pagination advances over citation candidates before hash exclusions, so a page can be empty and still have `nextAfterSeq`. Follow that cursor until null; null means this live scan is exhausted at that moment, not that the entire system has no affected results. New appends may appear on later requests. Correction state is read at request time, not a frozen multi-page snapshot. No automatic correction, retraction or approval occurs.

No migration or backfill is needed. This listing does not establish completeness of source extraction, clinical correctness, or production readiness. Independent real-capture validation and the clinical gates remain pending.

## Verification

All three backend tiers passed with real PostgreSQL 16 and Moto 5.2.3: 1,300 / 1,479 / 1,480 tests. Tier 1 reserves 180 API tests for later tiers; tier 2 reserves one S3-specific test; tier 3 skips none. All 13 deliberately injected defects were caught and each source restored byte-for-byte. Typecheck, lint, build and all 20 shared-contract tests passed. See [the verification record](cell-usage-listing-results.json).

The first complete run failed 22 backup/restore tests because PATH selected a newer pg_dump than the PostgreSQL 16 server. Pinning the PostgreSQL 16 client tools and repeating from a fresh disposable cluster repaired the environment; no application code was changed for that failure. These results are local engineering checks; required PR CI and owner review still gate merge.
