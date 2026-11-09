# Current medication reads across longer histories
Date: 2026-11-09

The next local performance slice starts from main
`3c22c7561fcee17542c396ed2d197ccee90be8a7`, independently of the unpushed frontend
branch. Current medication reads aggregate each entry's maximum version first,
then join the selected records in the same SQL statement and snapshot. This
removes a window calculation over complete historical records. The existing
historical-version query, DTOs, ordering, tenant parameters, RLS, authorization,
audit writes, freshness and cache policy are preserved. No migration or index is
added. See the [plan](../design/plans/patient-read-queries.md) and
[benchmark procedure](../../apps/backend/test/performance/README.md).

Two alternating original/candidate rounds used fresh matched fixtures on
PostgreSQL 16.15, Node 22.22.0 and the same idle host. Each patient had 20 medication
entries and 1, 5 or 50 versions per entry. These are repository timings, including
transaction/tenant setup, with 25 warm samples per round (50 per cell).

| Versions per entry | Original median | Candidate median |
| --- | --- | --- |
| 1 | 1.104 ms | 1.120 ms |
| 5 | 1.187 ms | 1.279 ms |
| 50 | 2.167 ms | 1.511 ms |

The longer-history median decreased about 30%; the five-version median increased
by 0.092 ms. There is no claim of an ordinary-history or whole-app speedup.
Longer-history EXPLAIN execution samples fell from 1.470/1.522 ms to
0.649/0.653 ms.

A second matched comparison added 100 background patients across two tenants,
each with 20 entries and five versions, for 11,121 medication rows. Two more
alternating rounds again used 25 warm samples per cell and fresh matched fixtures.

| Versions per entry | Original median | Candidate median |
| --- | --- | --- |
| 1 | 1.078 ms | 1.105 ms |
| 5 | 1.157 ms | 1.215 ms |
| 50 | 2.270 ms | 1.513 ms |

The extended-history improvement persisted at about 33% (0.757 ms), with each
candidate round faster than either original round. Five-version reads increased
by 0.058 ms. Extended-history EXPLAIN execution samples were 1.527/1.497 ms before
and 0.565/0.626 ms after. Retain this as a bounded long-history optimization;
ordinary-history and whole-app improvement remain unproven. The candidate avoids
sorting complete historical rows but reads the selected patient's rows twice.
First-read results and full sample ranges are retained separately; they are not
cold OS/disk measurements. No timing assertion or forced index plan is used.

Full-row DISTINCT ON candidates did not improve consistently and were rejected.
Demographics reads fetch encrypted fields for all versions; that separate
opportunity is deferred because changing their read contract would broaden this
slice.

The new PostgreSQL controls cover ordering by latest status/name with stable
entry ties, other-patient and other-tenant refusal, immediate visibility after
a committed correction, current/historical flags, coherent racing reads and
unchanged ledger counts after reads. They pass against the original behavior as
well as the candidate. Replacing maximum with minimum version made all three
freshness controls fail; the candidate was restored. All 15 database protections
also passed with the original query. Final focused database, HTTP and
authorization-fence acceptance passed 28 tests.

Production source commit `6718c37ec37abca9614542e1b1e8cdd33ab23134` passed typecheck,
lint, build, 456 infrastructure checks, 237 CI-configuration checks and five
workflow checks. The workspace run passed 5,829 tests, including 248 worker tests
and the memory backend profile. Backend results were:

| Profile | Passed | Skipped |
| --- | --- | --- |
| Memory | 3,594 | 763 |
| PostgreSQL | 4,249 | 108 |
| PostgreSQL/S3 | 4,355 | 2 |

Five additional private reader-engine specs were excluded in every profile.
The final profile's two skips are the memory-only merge refusal and separately
enabled decision-browser case. Both all-profile recovery validators passed all
six artifacts bound to the production source commit. Later changes extend the
opt-in benchmark, make a browser fixture independent of test order, and document
the results; the production query was restored and verified byte-for-byte after
every benchmark comparison.

The first selected browser run passed 19 tests and failed the mobile demographics
case before any medication read: its unchanged assertion expected a patient
counter on an empty roster. The existing page intentionally hides that counter
until a patient exists. The test now creates its own synthetic patient through
the existing authenticated fixture helper, retaining every assertion and timeout.
The rerun against a newly provisioned database passed all 20 mobile and desktop
flows, including demographics roles/tenant refusal, current and historical
medications, lost-save/concurrent-correction handling, upload recovery and merged
patient history. The fixture repair adds setup only; it changes no product code.
Final workspace typecheck, lint/formatting, CI-configuration guards and diff checks
passed after the benchmark extension and fixture repair.
Raw logs, plans, samples, the initial failure context, mutation results and
recovery artifacts are retained locally in
`/workspace/database-performance-validation`.

The disposable development database disables fsync, synchronous commit and full
page writes; this is not a production durability or cold-storage measurement.
Synthetic local checks do not establish hosted CI, cloud capacity or clinical
acceptance. The database branch remains local, without a push, PR or deployment.
The separate frontend branch was explicitly authorized for publication and
verified remotely at `4dff36622a0831f4ca17815ce608078d201fc0d7`; it is not included
in this database branch. The Mac vault is not mounted in this environment.
