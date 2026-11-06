# The migration runner's database tests get their own timeout

Date: 2026-11-06

CI on `main` `661512c9` went red in one place: `test/db/migrations.pg-spec.ts`, "reverts step by step, and can re-apply after a full revert", ran past Jest's 5-second default. Nothing failed an assertion. That test, like several others in the file, applies, reverts and re-applies every shipped migration, so its time grows with each migration; it takes about 1 second on a developer machine and passed on `29194ae2`, whose backend is identical. Of the last fifteen failed CI runs, this is the only one with this failure.

What changed: the file sets `jest.setTimeout(60_000)`, as the other database specs already do (120 and 180 seconds).

Verification, Node 22.22.0 and PostgreSQL 16.15: the file passes 36 of 36. With the timeout set to 100 ms on purpose, 24 tests and their hooks time out, which shows the setting governs them; restored, 36 of 36 again. Backend lint of the file, `typecheck` and `format:check` pass; gitleaks finds nothing in the file and catches a planted fake key.

Not done: the other backend tiers were not run (only this test file changed).
