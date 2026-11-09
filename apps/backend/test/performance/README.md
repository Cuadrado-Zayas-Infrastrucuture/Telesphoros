# Synthetic patient-read benchmark

This opt-in benchmark uses the existing PostgreSQL 16 fixture harness, real
migrations and ledgered repository writes. Reads use the restricted application
login with tenant binding and forced RLS. It creates three synthetic patients
with 20 medication entries each and 1, 5 or 50 versions per entry, plus a foreign
tenant control. Demographics histories are measured for context; they are not
changed by the medication query optimization.

Set `PATIENT_READ_BACKGROUND_PATIENTS=50` to add 50 patients in each of the two
tenants, each with 20 entries and five versions per entry. This adds 10,000
medication rows, for 11,121 total, so the measured patients no longer dominate
the table. The default is zero; integers from zero to 100 per tenant are allowed.
Background writes use the same real repositories and ledger constraints.

With the repository's pinned Node/pnpm and PostgreSQL client tools, start the
disposable local database as documented in `docs/STATUS.md`, then run from the
repository root:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres \
TEST_STORAGE=postgres PATIENT_READ_OUTPUT=/tmp/patient-read.json \
  pnpm --filter @telesphoros/backend exec jest --runInBand \
  --testRegex 'test/performance/patient-read\.bench\.ts$'
```

The `.bench.ts` suffix is excluded by the unchanged default Jest test pattern.
The command selects the benchmark explicitly and does not establish acceptance
of any unselected suite. S3 is not used; its missing-service notice is expected
for this isolated selection. Full service acceptance needs the normal profiles.

The fixture is analyzed before measurements. Each case records its first read
after fixture writes and 25 subsequent warm reads. Neither is a cold OS/disk
cache measurement. Repository timings include transaction/tenant setup, planning,
query execution, transfer and mapping; they are not complete HTTP or UI latency.
EXPLAIN ANALYZE/BUFFERS observes SQL captured from the real repository without
forcing index choices. Query parameters, predicates containing their values,
patient records and ciphertext are excluded from the output.

`encodedRepositoryBytes` is the size of JSON serialization of the returned
repository value, including Buffer's JSON representation. It is not PostgreSQL
wire bytes, HTTP response bytes or plaintext size. Only the count is retained.

Compare matched revisions with the same harness, runtime, fixture cardinalities
and idle host. Record variation and first-read/warm results separately. There
are no latency thresholds; independent expected versions, ordering and tenant
refusal checks must pass. These bounded local samples do not establish production
capacity, p95 latency or clinical acceptance.
