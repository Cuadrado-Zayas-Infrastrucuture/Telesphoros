# Plan: Usage (backend)

One pull request off `main`, backend and shared types.

| Area | Change |
| --- | --- |
| `packages/shared-types/src/usage.ts` | `usageDtoSchema`: `timeZone`, two `months` (this, last) with `reportsUploaded` and `evaluations.{evaluated,held}`, and `storage.{reportFiles,reportBytes}`. |
| `src/usage/usage-months.ts` | Puerto Rico month windows from a given instant, `[from, to)` in UTC. |
| `src/storage/usage.repository.ts` | `UsageRepository` (activity in a window, storage now), and the in-memory version, which reads the in-memory report rows. It has no evaluations, because the in-memory store keeps none. |
| `src/storage/postgres/usage.repository.ts` | Three parameterized aggregate queries in `withTenant`, each also filtered by `tenant_id`. |
| `src/usage/usage.controller.ts`, `usage.module.ts` | `GET /usage`, `@Roles('admin')`. |
| `storage.module.ts`, `app.module.ts` | Wiring. |

## Verification

- Unit: month windows at the 04:00 UTC edge, at year end, and at the very start of a month.
- PostgreSQL (`usage.pg-spec.ts`), through the application role:
  - Reports uploaded inside, before and after a window are counted only inside it; a deleted one still counts as uploaded but not as stored; a report never uploaded counts nowhere.
  - A real evaluation is counted.
  - Another tenant's rows never are.
- e2e on all three tiers: admin 200 with a parsed shape; 403 for every other role and for no role; 401 anonymous; `no-store`; two organizations see only their own uploads.
- Deliberate breaks, PostgreSQL spec:
  - Dropping the deleted filter fails 1 test; widening the window end to `<=` fails 1.
  - Dropping only the explicit tenant filter still passes, because row-level security isolates on its own.
  - Dropping it AND reading as a superuser (no row-level security) fails 2 tests, so the isolation tests do catch a leak.
