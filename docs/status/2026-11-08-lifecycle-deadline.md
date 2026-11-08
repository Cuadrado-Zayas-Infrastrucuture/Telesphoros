# The fixture-lifecycle control states its own deadline

Date: 2026-11-08

[2026-11-07-report-registration-deadline](2026-11-07-report-registration-deadline.md) gave `report-registration.pg-spec.ts` a 30-second budget (`jest.setTimeout(30_000)`). The fixture-lifecycle control, `scripts/test-fixtures/lifecycle.test.cjs`, runs that file's "fails migration on bounded lock contention" test with an injected delay, and its `late-lock` case needs the test to run past its deadline: it asserts exit 1 and `Exceeded timeout of 5000 ms for a test`. With 30 seconds there is no timeout, so `pnpm --filter @telesphoros/backend test:fixture-lifecycle` failed on every run.

Pull-request CI did not show it. The control runs only in `service-postgres`, and `.github/ci/scope.mjs` leaves that job to the nightly and manual runs; the change and every `main` run after it skipped it. A private-repository sync found it before the next nightly.

What changed:

- **`apps/backend/test/helpers/spec-deadline.ts`.** A spec that needs more than Jest's default passes its budget through `specDeadline(ms)`. It returns that budget, or the deadline in `FIXTURE_TEST_TIMEOUT_MS` when the control sets one; any other value stops the run.
- **`report-registration.pg-spec.ts`** keeps its 30 seconds, as `jest.setTimeout(specDeadline(30_000))`.
- **The control** states its deadline, `DEADLINE_MS = 5000` (Jest's default), passes it to every child it starts, and asserts its timeouts at that deadline.
- **`.github/ci/lifecycle-deadline.test.mjs`**, run by `pnpm test:ci-config` and so on every pull request, checks that every spec the control runs takes any budget of its own through `specDeadline`, and that the control states and asserts its deadline. It reads text, so a timeout passed as the third argument of `it()` is not caught.

What did not change: Jest's five-second default and the guard that keeps it, the 30-second budget in normal runs, and which pull requests run `service-postgres`.

Verification, Node 22.22.0, a dedicated PostgreSQL 16 cluster:

| Tree | `test:fixture-lifecycle` alone |
| --- | --- |
| `main` `62f50f3b` | red: `late-lock` |
| `main` with the spec as before 2026-11-07's change | green |
| this change | green, twice |

Each part was broken once and a test turned red (9 of 9); breaking the helper or the spec's call also turns the real control red. `test:ci-config` 227 of 227, typecheck and lint pass.
