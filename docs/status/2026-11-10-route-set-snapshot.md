# The route set is pinned

Date: 2026-11-10

Nothing recorded which routes the API has. A route could be added, removed or opened to another role without that change being visible as such in review.

`apps/backend/test/route-set.json` now lists every route with who may call it (`public`, `any-member`, or its roles) and which switch opens it. `apps/backend/test/route-set.e2e-spec.ts` reads the routes from the running application and fails when they differ from the file, naming what was added, removed or changed. The file has one route per line, so a change to one route is a one-line diff.

To accept a deliberate change, run `UPDATE_ROUTE_SET=1 pnpm --filter @telesphoros/backend exec jest test/route-set` and review the diff of the file. The update is refused when `CI` is set.

The walk that finds the routes moved from `no-role-reads.e2e-spec.ts` to `test/helpers/route-table.ts`, and both tests use it. No route, role or application code changed.

Today the file holds 81 routes: 2 public, 4 open to any signed-in member, and 75 that require a role. It pins what the API is, not what a partner may rely on; no route is promised to anyone by being listed.
