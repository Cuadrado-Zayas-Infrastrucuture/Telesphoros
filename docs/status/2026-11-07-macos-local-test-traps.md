# Two macOS traps in the local backend tiers

Date: 2026-11-07

On a Mac, the database and S3 tiers can fail for reasons that have nothing to do with the branch. "Running things locally" in `docs/STATUS.md` now exports two variables before the tiers run.

1. **PostgreSQL 18 client tools first on the PATH.** Homebrew's `libpq` puts `pg_dump`, `pg_restore` and `pg_config` 18 ahead of PostgreSQL 16. A dump made by `pg_dump` 18 sets `transaction_timeout`, which a 16 server does not know, so `pg_restore` fails ("FAIL pg_restore"; "unrecognized configuration parameter"). `test/helpers/recovery-target.ts` asks `pg_config` for its server tools, refuses anything but 16, and reports it as "Could not initialize the isolated recovery target". Fix: `export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH`.
2. **No UTF-8 locale in the environment.** The same helper runs `initdb` and `pg_ctl` for its own cluster. On macOS, without a UTF-8 locale this fails with the same "Could not initialize" message. `apps/backend/scripts/dev-postgres.sh` sets `LC_ALL` for itself, but the helper does not. Fix: `export LC_ALL=C.UTF-8`.

Verification on `main` `859e964a`, Node 22.22.0, a dedicated PostgreSQL 16.15 cluster and moto, with no other cluster or emulator shared:

| Run | Specs | Result |
|---|---|---|
| PATH with 16 first, `LC_ALL` and `LANG` unset | `recovery-cli`, `application-recovery`, `independent-recovery` | 37 of 37 fail, every one "Could not initialize the isolated recovery target" |
| the same, with `LC_ALL=C.UTF-8` | the same three | 37 of 37 pass |
| `LC_ALL=C.UTF-8`, Homebrew PATH unchanged (`pg_restore` 18.3) | the 14 specs that use backup, restore or the recovery target | 75 fail (38 in six backup and restore suites, all 37 recovery tests), 63 pass, 12 skipped |
| the same, with PostgreSQL 16 first on the PATH (`pg_restore` 16.15) | the same 14 | 138 pass, 0 fail, 12 skipped |

`pnpm test:ci-config` passes (it includes the documentation link check and the status fragment guard), and gitleaks finds nothing in the change and catches a planted fake key.

Not touched: code, including the recovery helper (setting the locale there itself is a possible separate change), CI, Terraform and AWS. The full tiers were not re-run; only documentation changed.
