# Synthetic report revision inspection — 032 S2b1

Date: 2026-11-02

## Implemented

A pure shared-contract function inspects up to 100 already authorized, byte-verified synthetic report snapshots for one internal tenant/patient scope. It retains exact source IDs, SHA-256 hashes and object versions, groups laboratory series, and distinguishes identical duplicate uploads from changed content at the same revision. An inconsistent series is held with explicit reason codes, including reused issuer identities, missing revisions/predecessors, changed patient/accession/specimen, reversed issue times and ineligible/withdrawn lifecycle states.

Only a complete eligible chain produces a candidate for independent review. Its references name the latest revision alone; missing or uncertain findings never inherit older calls. Different laboratories stay separate and the patient profile remains unreconciled. No current clinical result or acceptance is granted. Input order does not affect the result, original content is compared without normalizing it, and caller objects remain unchanged.

This independent main-based slice does not depend on open draft #262. See the [bounded plan](../design/plans/pgx-revision-reconciliation.md).

## Verification

The initial 33 public-contract tests failed because the export did not exist. The final shared-contract suite passed 244 tests in 8 files, including 38 lineage cases. Hand-written expectations cover scope rejection, duplicates/conflicts, identity drift, missing/branched histories, terminal states, uncertain findings, the 100-source bound, all six permutations of a three-revision history and immutable inputs. One added uncertainty case initially named the fixture's finding incorrectly; giving that synthetic amendment an explicit distinct finding ID corrected the setup and preserved the intended no-backfill assertion.

Two isolated guard-removal controls failed as intended: removing internal scope comparison accepted a foreign tenant snapshot (one failing case); removing same-revision content/hash comparison accepted changed content as a candidate (two failing cases). The intact function passed all 38 cases. The temporary mutation worktree was removed. No mocks or new dependencies were added.

| Command | Local result |
| --- | --- |
| `pnpm typecheck` | Exit 0 across the workspace. Shared-contract typecheck also passed after positioning the independent export away from #262's addition. |
| `pnpm lint` | Exit 0, including formatting. |
| `pnpm test` | Exit 0 across packages. Shared contracts: 244 passed; default backend: 2,077 passed / 471 skipped; frontend: 694 passed plus 55 brand/deployment guards; worker: 151 passed. |
| `pnpm build` | Exit 0 across the workspace. |
| `pnpm test:infra` | 285 passed. |
| `pnpm test:ci-config` | 217 passed. |

Node 22.22.0 and pnpm 10.28.0; based on main `c7a4c9ee`. PostgreSQL/S3 and worker service tiers were not run for this pure contract change; their default-profile skips are not acceptance. Five absent-reader-engine specs were explicitly excluded by the existing configuration. No browser or clinical tests were run because this slice has no UI, service integration or clinical rule change. Local checks are not exact-commit hosted CI or clinical review.

## Limits and next work

This is deterministic inspection, not persisted reconciliation. The caller must enforce authorization, complete source enumeration, exact object/hash verification, current review state and transaction-time freshness. The function does not authenticate an issuer, verify a claimed hash, write an idempotent import/ledger event, schedule affected-assessment tasks, normalize findings, select across laboratories or perform clinical interpretation. A09/A10 end-to-end acceptance remains open. Next integrate these rules with immutable revision/finding persistence and independent acceptance, then contextual synthetic assessments. No UI, API, database schema, guideline, inference, cloud or real-data gate changes are included.
