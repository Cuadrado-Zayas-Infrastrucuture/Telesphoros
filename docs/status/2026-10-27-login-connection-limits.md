# Infrastructure: each login's connections checked against its own limit; the verifier login's limit raised to 20

Date: 2026-10-27

The connection budget (#87, #90) checked the services' total against what the server accepts. But `provision-logins` also gives each login its own `CONNECTION LIMIT` (`LOGIN_LIMITS` in `apps/backend/src/db/provision-logins.ts`). A login over its limit is refused ("too many connections for role") however much room the server has. Nothing compared the two.

Production runs at least two API tasks (`api-compute.tf`), and every API task holds a ledger-verifier pool of 3. At the deploy peak that is 12 verifier connections against a limit of 10. So every production deploy could have had verifier connections refused, and every production plan fails the new check unless the limit rises.

Changed:
- **The limits in Terraform.** `database-connections.tf` holds the five login limits (`login_connection_limits`) and each login's connections at the deploy peak (`login_connection_demand`): the app login counts the API pools, the verifier login the verifier pools, the worker login the worker pools, the issuer login the issuer pools, and the migrator login the migration task. A precondition on the database instance refuses a plan with any login over its limit and names the logins. `db_connection_demand` reports `per_login`.
- **The verifier limit.** The founder chose to raise only the verifier login's limit, from 10 to 20. It now fits up to three API tasks at the deploy peak. The others stay as they were:
  - the app login, 50, fits two API tasks at the default pool of 10;
  - the worker, 20, and the issuer, 10, fit one task each.

  Scaling past that means raising a limit, on purpose.
- **The guard.** `database-connections.guard.test.mjs` requires the Terraform limits to equal `LOGIN_LIMITS`, each login's demand to use the pool sizes the code opens, and the precondition to be present.
- **The docs.** `docs/database.md` gives the new limit and points to the check.

Proved:
- The guard rules failed before the change. Each was then seen to fail on a mutation: a code limit changed, a Terraform limit changed, a pool multiplier changed, a task count dropped, the over-limit list disabled, the precondition removed.
- `profiles.tftest.hcl`: the sum run now uses one worker and one issuer, and asserts every login's value. The two budget refusals use two API tasks, so only the budget is exceeded. Four new runs each put exactly one login over its limit, at a budget the sum fits. These plan runs need the pinned Terraform and its providers, so they first run in CI.

Not changed:
- The app, worker, issuer and migrator limits.
- The pool sizes and autoscaling.
- Any AWS resource. A live instance takes the new verifier limit the next time `provision-logins` runs, and reports it as a check.
