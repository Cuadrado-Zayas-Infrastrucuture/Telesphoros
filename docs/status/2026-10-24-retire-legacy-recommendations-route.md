# Legacy GET /recommendations route retired (2026-10-24)

Date: 2026-10-24

**Implemented.** `GET /api/v1/recommendations` and `GET /api/v1/recommendations/:id` are removed: the controller, module, service and mapper under `apps/backend/src/recommendations/`, their registration in `AppModule`, and the README row. Every method on that path now answers 404 `NOT_FOUND`, pinned by `test/recommendations.e2e-spec.ts` (with a live clinical read as the control). Why: nothing in production ever wrote the table behind the route (the only inserts are in tests; the rules engine returns results that are stored in `evaluation_results`), so the route could only answer "none" for a patient who may have evaluated results, in a single-gene shape the evaluation model replaced. Six other specs used the route as a generic probe path (unauthenticated 401, removed member 403, no-role 403, `no-store`, tenant claim, controller inventory); the path is removed from those lists and the inventory count is 18 controllers.

**Not changed:** the `recommendations` table and its migrations (`0001`, `0002`, `0003`, `0012`, `0013`), the `recommendation-integrity` and repository database specs, `RecommendationsRepository` and its `insert`, the shared DTO types, and every evaluation route. Dropping the repository, the table and the DTOs is a separate change, to be made once no deployed database is known to hold rows.

**Assumption.** No external client calls the route. None exists in the frontend, packages or tests, but deployed traffic was not visible from the repository.
