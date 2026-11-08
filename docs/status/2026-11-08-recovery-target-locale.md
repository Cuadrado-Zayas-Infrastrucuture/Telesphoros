# The recovery target sets its own locale

Date: 2026-11-08

`apps/backend/test/helpers/recovery-target.ts` runs `initdb` and `pg_ctl` for its own PostgreSQL 16 cluster. On macOS, without a UTF-8 locale in the environment, that cluster never starts, and all 37 tests in `recovery-cli`, `application-recovery` and `independent-recovery` fail with "Could not initialize the isolated recovery target". The workaround was an `export LC_ALL=C.UTF-8` line in "Running things locally" ([2026-11-07 fragment](2026-11-07-macos-local-test-traps.md)).

What changed: the helper passes `LC_ALL` to its `initdb` and `pg_ctl` calls, keeping a value the developer already set and otherwise using `C.UTF-8`, as `apps/backend/scripts/dev-postgres.sh` does. The `LC_ALL` line is removed from "Running things locally"; the PATH line (PostgreSQL 16 client tools first) stays, because backup and restore resolve `pg_restore` from the PATH. In [database.md](../database.md), the macOS note now says which servers set their own locale, and the verification matrix no longer asks for `LC_ALL` on the database tier.

Verification, rebased onto `main` `8a679391` (the recovery runs were on `a4bd71d0`; nothing between them touches these files), Node 22.22.0, a dedicated PostgreSQL 16.15 cluster and moto, PostgreSQL 16 first on the PATH, `LC_ALL`, `LANG` and `LC_CTYPE` unset:

| Run | Result |
|---|---|
| the three recovery suites, unchanged `main` | 37 of 37 fail, "Could not initialize the isolated recovery target" |
| the same, with the change | 37 of 37 pass |
| the change with its `C.UTF-8` default removed on purpose | 37 of 37 fail again; restored, they pass |
| the 14 specs that use backup, restore or the recovery target | 138 pass, 0 fail, 12 skipped |
| backend `pnpm test` with the database and S3 specs (`TEST_DATABASE_URL`, `TEST_S3_ENDPOINT`), on `8a679391` plus the change | 3533 pass, 0 fail, 757 skipped; no `NOT RUNNING` line, no timeouts |

Not touched: product code (`src/db/restore.ts` and the backup command), the helper's `pg_config` lookup, `scripts/local-storage` and `scripts/local-review` (they set their own locale or none), CI and Terraform. Tiers 2 and 3 (`TEST_STORAGE=postgres`, with and without S3 uploads) were not run locally; CI's database and storage job runs them on Linux.
