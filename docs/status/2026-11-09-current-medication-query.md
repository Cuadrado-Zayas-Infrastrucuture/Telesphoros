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
0.649/0.653 ms. Full-row DISTINCT ON candidates did not improve consistently and
were rejected. Demographics reads fetch encrypted fields for all versions; that
separate opportunity is deferred because changing their read contract would
broaden this slice.

The new PostgreSQL controls cover ordering by latest status/name with stable
entry ties, other-patient and other-tenant refusal, immediate visibility after
a committed correction, current/historical flags, coherent racing reads and
unchanged ledger counts after reads. They pass against the original behavior as
well as the candidate. Replacing maximum with minimum version made all three
freshness controls fail; the candidate was restored. Initial focused database
and HTTP acceptance passed 27 tests. Full repository and three-profile service
acceptance are recorded separately when complete; these initial checks alone
do not establish that acceptance. The private reader engine is unavailable.

Synthetic local measurements do not establish hosted CI, cloud capacity or
clinical acceptance. Nothing in this slice authorizes a push, PR or deployment.
