# H4 slice 2 verification: cancelling an evaluation request that has not started

Date: 2026-10-28

Scope: spec 007 slice 2, migration 0054. Synthetic fixtures only (public D01 through the test stand-in reader); real restricted-role PostgreSQL 16, the real queue functions, and an S3 emulator for the storage tier. Every run below is on the committed candidate with a clean tree, Node 22.22.0 and pnpm 10.28.0 from a frozen offline install.

## Seen failing first

With the migration set aside (mutation M0), the cancel suite and the down-guard case fail. The new table also failed four existing catalogs until it was registered, which is what they are for: the tenant-policy vacuity list and the policy count (51 to 53), the reviewed schema inventory (key, relationship and check), and the classification of every public table (`src/db/append-only-tables.ts`, with the cancellation check asserted like H3's completion check).

## Meaningful failures and repairs

- The first draft gave three refused people no membership, so they were refused for being nobody rather than by the rule. Each is now a member (mirrored from their token by one request), and the cross-organization case uses a member of the other organization.
- Planning the mutations showed one check could never fail a test: the trigger compared the request's requester with the record, which the job helper already checks against the person acting. It was removed; the record must still name the person acting. Two tests were added for checks that had none: a colleague calling the job helper directly, and a requester who has lost their write role.
- The first full loop failed one existing test in every backend tier: the 0031 revert's catalog comparison in `test/db/tenant-capability.pg-spec.ts` names every object the revert removes, and did not name the two new functions; its second case then failed because the first had left the database reverted. The names were added, and the whole loop was rerun from the start on the amended candidate.

## Results on the candidate

| Run | Result |
| --- | --- |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:infra`, `test:ci-config`, `check:workflows` | exit 0 |
| backend, in memory, with services | 2996 passed, 289 skipped |
| backend, PostgreSQL | 3264 passed, 21 skipped |
| backend, PostgreSQL and S3 | 3284 passed, 1 skipped |
| worker, with services | exit 0 |
| F2 and F3 recovery validators | exit 0 |
| Gitleaks on the commit | no leaks |

The new suite runs only on PostgreSQL. The concurrent cancel/claim test ran 12 rounds per tier; both outcomes occurred in each (9 cancels won, 3 claims won), and every round had exactly one winner.

## Mutations

Each was applied alone, the cancel suite (or the down-guard spec) run on PostgreSQL, and the file restored byte for byte. All eleven were caught: the migration removed; the helper ignoring who queued the job; the helper ignoring the job's state; the record allowed to name someone else; no write-role check; a record written without cancelling the job; the append-only guard removed (with update and delete granted, so the trigger alone is under test); no row lock in the helper; a cancelled job read as unavailable; EC001 not mapped to 409; the down migration dropping populated cancellations.

The row-lock mutation was caught by the race test, where the cancel then failed with a raw database error instead of a 409: the jobs table's own shape constraint still refused a cancelled job that was running, so the queue stayed consistent. Catching it depends on the interleaving; in this run it was caught.

## Not verified

- No route and no browser use (slice 3).
- The worker was run only in the test process, never as `start:evaluation-worker`, and never deployed.
- No hosted CI run yet.
