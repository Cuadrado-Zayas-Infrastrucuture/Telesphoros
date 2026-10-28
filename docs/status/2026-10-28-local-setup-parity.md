# Fix: local setup pins CI's Node, and the local PostgreSQL checks passwords (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (T1, T2).

**The problems.**
- **T1.** `engines` said `>=22`, and there was no `.nvmrc`. On Node 24 (Unicode 17), 58 backend suites failed at import, because the lab-report matcher (`apps/backend/src/services/report-adapter/unavailable-matcher.ts`) is pinned to Unicode 16. CI and the API image pin 22.22.0.
- **T2.** `apps/backend/scripts/dev-postgres.sh` created its cluster with trust authentication, so the specs that expect a wrong password to be refused (`issuer`, `issuer-client`, `issuer-server`, `request-capability`) connected and failed locally, and `provision-logins` skipped. CI's cluster checks passwords. On macOS the script also needed `LC_ALL`, or the postmaster failed with "postmaster became multithreaded during startup".

**The fix.**
- `.nvmrc` holds `22.22.0`, and `engines.node` is `>=22.22.0 <23`. A new check, `.github/ci/node-pin.test.mjs` (in `pnpm test:ci-config`), fails when `.nvmrc`, `NODE_VERSION` in `ci.yml` and `rescan.yml`, the API image tag, and the engines range disagree.
- The script creates its cluster with `--auth=scram-sha-256` and the password `postgres`, matching CI. The password goes to initdb through a short-lived file owned by the postgres user, not the command line. `start` and `url` print `postgres://postgres:postgres@127.0.0.1:$PORT/postgres`. The script sets `LC_ALL=C.UTF-8` unless one is set, and its missing-binaries message names the Homebrew path.
- `start` refuses a cluster whose `pg_hba.conf` still uses trust (one made by the old script), and says to run `reset`. **A developer with an existing cluster must run `dev-postgres.sh reset` once**; its data is disposable.
- `docs/STATUS.md`, `docs/database.md` and `docs/ops/synthetic-workflow-acceptance.md` show the new URL.

**Not changed.** The CI workflows, the API image, the matcher, the test helpers, Moto, and the historical plans and verification records that mention trust authentication.

**Still a warning, not a refusal.** `engine-strict` is not turned on. jsdom 30.1.3 (the frontend test environment) declares Node `^22.22.2 || ^24.15.0 || >=26.0.0`, so with it pnpm refuses CI's own 22.22.0. Moving the pin to a 22.x at or above 22.22.2, and then turning on `engine-strict`, is a separate change.

**Checked locally (macOS, Node 22.22.0, PostgreSQL 16.15).** A fresh cluster with `LC_ALL` unset: a wrong password was refused, `postgres` connected, and the five specs above passed (5 suites, 68 tests, none skipped). A cluster created by the previous script was refused by `start` with exit 1. `pnpm install` on Node 24.14.0 warned about the range. The pin check went red when `rescan.yml` was changed to another version and was then restored. Not checked on Linux or as root (`runuser`).
