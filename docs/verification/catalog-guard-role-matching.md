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
