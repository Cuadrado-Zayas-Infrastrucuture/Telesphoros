# A guard for CI checks that cannot go red

Date: 2026-11-08

The simplify audit of 2026-11-07 found checks that passed whatever happened: a lint job that could not fail, a seed test skipped in the only job that ran it, a Postgres suite no workflow ran, and a test naming a file that does not exist.

`.github/ci/can-go-red.test.mjs`, run by `pnpm test:ci-config`, now fails on each of those four shapes. An exception is written at the top of that file with its reason, and an entry that stops matching fails too.

What changed:

- **`terraform-lint`** no longer sets `continue-on-error` and is a required check. The ruleset file lists it; the live ruleset has to be re-imported after merge before it blocks one.
- **The demo seed** runs on a real PostgreSQL in `service-postgres`, after a backend build. That job runs nightly and on manual runs, so a break shows up there. The half that needs no database stays in `verify`.
- **`test:durable:pg`** and seven other test scripts are listed as local-only, each with its reason.
- **`scope.test.mjs`** names `model-clients/port.ts` in place of a `config.ts` that never existed.

What did not change: which runs get skipped. `terraform-lint` has the same skip condition as `terraform`.

Each rule was shown red on the tree before its fix and green after it, and the seed test passed for real: 8 of 8, none skipped, on PostgreSQL 16.
