# Catalog guard: exact role membership and row ordering

Local fix on `fix/catalog-guard-role-matching`, based on main `62675ca`.
No publication, workflow change, backend wiring or deployment is authorized.

## Failure and correction

The Tier 3 job on `d6dccdb` failed at `ledger-catalog.pg-spec.ts:169`: the test
expected the tenant-scoped ledger predicate but received `true`. The query cast
`pg_policies.roles` to text, then `includes('telesphoros_ledger')` also matched
`telesphoros_ledger_verifier`. The verifier's independent read policy intentionally
uses `true`; selecting the first substring match made the assertion depend on
unordered catalog rows. The selector dates to `73423a92`, before F06/F07.

The affected query now preserves `roles` as `text[]`. Shared test assertions use
exact array membership and require one policy per application, verifier and
ledger role for each record/child/note table. Existing application tenant checks,
ledger tenant checks and SELECT-command checks remain intact. No migration,
grant, RLS policy, runtime behavior or clinical rule changes.

The 18 permanent regression controls exercise the actual assertions used by the
PostgreSQL guard: all six policy-row orders, an exact role later in a multi-role
array, unrelated tables, a missing ledger role, role-prefix collisions, duplicate
role policies, broadened tenant predicates and non-SELECT read policies. A verifier
policy cannot substitute for the ledger policy, and ordering cannot hide a bad one.

## Verification record

Full producer stdout/stderr and native exits are retained outside the checkout in
the task's `catalog-guard-verification` evidence directory. No resolved credentials
or database dumps belong in this record. Fresh local PostgreSQL 16.14/SCRAM and
Moto 5.2.4 use task-owned loopback services and synthetic fixtures only; the runtime
is Node 22.22.0 with the repository's pinned pnpm.

- Original selector: deliberate reversed-order failure reproduced before the fix.
- Focused run: 18 new regression tests and 19 real-PostgreSQL catalog tests passed.
- Backend typecheck, lint and build passed.
- Isolated substring-matching mutation: seven regression failures, as intended.
- Isolated removal of the ledger predicate/command assertion: two regression
  failures, as intended. Candidate source was never weakened by these controls.
- The first mutant attempt could not load SWC's native binding in the sandbox;
  with local native bindings enabled, it ran and failed the intended assertions.

| Wider verification | Result |
| --- | --- |
| Tier 1, memory API plus real database/S3 specs | 151 suites passed; 2,070 tests passed, 253 expected skips |
| Tier 2, PostgreSQL API plus S3 specs | 160 suites passed; 2,302 tests passed, 21 expected skips |
| Tier 3, PostgreSQL API and S3 uploads | All 162 suites passed; 2,322 tests passed, one expected skip |
| Required service-skip notices | None in any backend profile |
| Independent-recovery artifact validator | All three profiles passed |
| Application-recovery artifact validator | All three profiles passed |
| Worker suite | All 13 files and 123 tests passed; no missing-service notice |

Secret scanning of the exact staged diff, whitespace validation and protected-state
comparisons complete the local checks. Only task-owned PostgreSQL/Moto services
were stopped afterward; their cluster data and logs were retained.

Six fresh aggregate recovery artifacts are retained externally. They record the
pre-commit base `62675ca` at which verification ran; hashes bind the tested code
bytes to the eventual local commit. The fix's source bytes stayed unchanged
through all profiles. These are working-tree results, not exact-head GitHub CI.

No local result establishes exact-head GitHub CI or hosted acceptance. The six
required checks remain mandatory for any later publication. FD-7a, both F06/F07
source branches and the combined reference are preserved separately.

## Permanent review probes (2026-10-16)

The founder approved retaining all 16 probes from the read-only review of local
commit `b561217`. They are appended to `catalog-policy-assertions.spec.ts`, reusing
its existing fixtures and helper. The original 18 tests, assertion helper, catalog
query, migrations and runtime source are unchanged by this follow-up.

| Promoted controls | Cases |
| --- | ---: |
| Missing exact application/ledger/verifier role | 3 |
| Duplicate exact application/ledger/verifier policy | 3 |
| Empty role array for each role | 3 |
| Null application/ledger tenant USING predicate | 2 |
| Null application WITH CHECK | 1 |
| Valid and broadened duplicate ledger policies, both orders | 2 |
| Exact ledger role alongside nonmatching prefix names | 1 |
| Case-sensitive role equality | 1 |
| Total | 16 |

Fresh verification on the working tree based at `b561217` passed all **53 selected
tests**: 34 assertion tests and 19 actual PostgreSQL catalog tests, with zero
selected-test skips. Backend typecheck and lint passed. The native runner used
pinned Node 22.22.0/pnpm 10.28.0 and a fresh task-owned PostgreSQL 16 cluster with
SCRAM authentication, loopback binding and synthetic fixtures. Only that cluster
was stopped afterward; its data and logs were retained.

The ordinary Jest configuration announced that object-storage suites were not
running because TEST_S3_ENDPOINT was unset. No S3 suite was selected for this
focused run. This is not a full backend-profile acceptance claim: S3, the three
whole-backend profiles, worker, recovery validators, build and GitHub CI were not
rerun in this test-only follow-up. Their earlier results above remain historical.

Two fresh external defect controls ran all 34 assertion tests: restoring substring
matching caused eight test failures; removing the ledger command/predicate checks
caused three. Each returned native exit 1 from assertion failures, as intended.
Mutants were outside the checkout; the production assertion helper was unchanged.

Complete outputs, native exits, JSON test results, reviewed-to-permanent coverage,
tested source hashes and protected-state snapshots are retained in the external
`catalog-guard-permanent-probes` evidence directory. Publication still requires
separate approval and the six exact-head CI checks. FD-7a, F06/F07 and the combined
reference remain protected; no Actions or main-backend wiring change is included.

## Local current-main conflict resolution (2026-10-16)

The founder approved resolving the status-document conflict found between local
`8cecb6a` and current main `683867a442471b29f89b6f945cece755f527aad4`.
Main was merged locally into `fix/catalog-guard-role-matching`; no history was
rewritten. The only conflicting path was `docs/STATUS.md`. Its resolved contents
are exactly current main's status document plus the candidate's complete catalog
section. Both that section and main's browser-logo-readiness section are retained
verbatim; the remaining main status content is preserved.

All three catalog test/helper files are byte-identical to `8cecb6a`, retaining all
34 assertion probes and the original tenant/SELECT safeguards. Relative to the
merged main, the candidate still changes only those three test files and the
three existing status/verification/session records. Actions, main-backend wiring,
runtime, migrations, frontend and packages have no candidate diff against main.

Fresh focused verification on the resolved working tree passed **53/53 tests**:
34 assertion probes plus 19 real PostgreSQL catalog tests, with no selected skips.
Backend typecheck and lint passed. This used pinned Node 22.22.0/pnpm 10.28.0 and
a fresh task-owned PostgreSQL 16/SCRAM cluster on loopback port 58751 with only
synthetic fixtures. The ordinary Jest configuration announced unselected S3
suites were not running; no whole-profile/S3 acceptance is claimed. The prior
defect controls and wider verification remain historical results, not fresh runs.

Main was rechecked after verification and remained `683867a`. Complete permitted
outputs, native exits, source hashes, section-preservation checks and protected
snapshots are retained externally in `catalog-guard-status-resolution`. The owned
cluster is stopped after verification, with its data and logs retained. Local
verification does not establish exact-head GitHub CI or hosted acceptance.
No push, PR, deployment, Actions or main-wiring change is authorized by this work.

## PR #143 duplicate-assertion repair (local, 2026-10-16)

PR #142 is merged into main at `365d8ff`. PR #143's later main merge,
`efe7dc98f200414ef8ff760aad2dc7cc50db5e0c`, retained the array query and canonical
helper call alongside the previous inline assertions. Its old ledger lookup
compared `string[]` to `'{telesphoros_ledger}'`, causing TS2367 and a failed catalog
assertion. Prior verification at `4947957` did not cover that merged spec.

The founder approved a local repair and all 53 focused tests, typecheck and lint.
Work is on `fix/catalog-guard-duplicate-assertions`, directly from the inspected
OPEN PR head `efe7dc9`; the original local `fix/catalog-guard-role-matching` branch
remains at `4947957`. No merge or history rewrite was performed for this repair.

Before editing, backend typecheck reproduced TS2367 at `(171,38)`, native exit 2.
The full selected test baseline ran on real PostgreSQL: 52 passed, one catalog
assertion failed, native exit 1. The repair removes nine duplicate inline lines.
The shared helper is the single assertion path per table and retains exact role
membership, cardinality one, application tenant USING/WITH CHECK, verifier SELECT
and ledger tenant/SELECT checks. Both the 34-probe spec and helper are byte-for-byte
unchanged; the corrected catalog spec matches the previously verified `4947957`.

| Fresh verification | Result |
| --- | --- |
| Assertion probes | 34 passed |
| Real PostgreSQL catalog tests | 19 passed |
| Selected tests overall | 53 passed; zero failures/skips |
| Backend typecheck | Native exit 0 |
| Backend lint | Native exit 0 |

Verification used pinned Node 22.22.0/pnpm 10.28.0 and a fresh synthetic PostgreSQL
16/SCRAM loopback cluster on port 58761. Only that owned cluster was stopped after
verification; data/logs were retained. Existing services were untouched. Complete
producer stdout/stderr, native exits, JSON case results, baseline failures, fixed
source hashes and protected snapshots are retained externally in
`pr143-duplicate-assertions-fix`.

These are local working-tree results whose verified bytes match the local repair
commit. The ordinary Jest config announced unselected S3 suites were not running;
no selected test skipped. Full profiles, worker, recovery, build/image and GitHub
CI were not rerun for this focused repair. The remote PR remains unmodified and
needs separately authorized publication plus all six exact-head required checks.
No Actions, main wiring, runtime, migrations, protected-source, push, PR metadata,
merge or deployment changes are included.
