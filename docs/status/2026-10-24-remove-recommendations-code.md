# Dead recommendations code removed; the table stays (2026-10-24)

Date: 2026-10-24

**Implemented.** The `RecommendationsRepository` (abstract, in-memory and PostgreSQL), its registration in `StorageModule`, the `RecommendationRecord` type, and the `RecommendationDto` and list-query schemas in `@telesphoros/shared-types` are removed. Nothing in production code called them after the `GET /recommendations` route was retired. The repository spec and the query-plan spec lose their recommendation parts; the query-plan evidence no longer counts the table. `RECOMMENDATION_STRENGTHS` stays, because the engine spec checks the engine's own strength list against it.

**Not changed:** the `recommendations` table, its migrations (`0001`, `0002`, `0003`, `0008`, `0012`, `0013`), `LEGACY_TABLES`, and every spec that talks to the table by SQL (`rls`, `tenancy-migration`, `migrations`, `recommendation-integrity`, `schema-acceptance`, `tenant-binding`, `backup-restore`, `recovery-seed`). The table still exists, so an older image keeps working. `docs/verification/tenant-capability.md` still names the deleted repository file in a historical count; it is a dated record and was left as written.

**Next, a separate change.** Migration `0039` (label `breaking`) would replace `block_report_soft_delete()`, which still reads `recommendations`, then drop the table and update the specs above. It waits for the founder's confirmation that no database holds rows.

**Verified (local):** typecheck, lint, build, `test:infra`, `test:ci-config`, tiers 1 to 3 (2,630 / 2,632 / 2,652 passed), fixture lifecycle (11), worker (234). Re-adding a reference to the removed type makes typecheck fail (checked, then restored). Hosted CI has not run.
