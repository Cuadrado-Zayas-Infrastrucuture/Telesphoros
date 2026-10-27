# Database: a read-only `connection-limits` command for the live connection budget

Date: 2026-10-27

The connection budget (`infrastructure/terraform/database-connections.tf`, #87 and #90) compares the services' connections with `db_connection_budget`, which is meant to be read from the live instance. Until a reading exists it uses a per-class estimate, and production refuses the estimate. Nothing could take that reading: the database sits on private subnets, and none of the one-off tasks printed it. No RDS instance exists yet in `us-east-2` (the other regions refused the read, so their state is unknown).

Changed:
- `node dist/db/cli.js connection-limits` (`apps/backend/src/db/connection-limits.ts`) reads `max_connections`, `superuser_reserved_connections`, `reserved_connections` and `rds.rds_superuser_reserved_connections` (each "not set" where the server lacks it), and every login role's `CONNECTION LIMIT`. It prints them and the budget, which is `max_connections` less every reserved slot. It is read-only, uses the migrator login, and prints settings and role names only.
- `scripts/staging/run-task.sh connection-limits` runs it as the migration task, dry run by default.
- `docs/ops/staging-rehearsal.md` adds the step after the logins are provisioned: run it, then set `db_connection_budget` from it.

Proved, on Node 22.22.0 and PostgreSQL 16 (SCRAM):
- `test/db/connection-limits.pg-spec.ts` reads the values back equal to `pg_settings`, and a test login's limit of 7. The output names the budget to set and holds no connection string or password, and a stray argument is refused.
- `connection-limits.spec.ts` checks the sum with non-zero `reserved_connections` and RDS slots, which a local server does not have.
- `run-task.test.mjs` checks the new step's task, container and command, and its refusal of arguments.
- Each rule was seen to fail on a mutation: a reserved slot left out of the sum (all three, separately), the connection string printed, arguments ignored.

Not verified: the command on RDS itself. Whether `rds.rds_superuser_reserved_connections` exists on this engine version, and what the reading is, are known only once an instance exists.

Not changed:
- Terraform.
- The per-class estimates.
- The login limits in `provision-logins.ts`.
- Any AWS resource: nothing was run in AWS.

The command prints those login limits, which the connection budget does not yet check against the services' per-login demand. That check is a separate follow-up.
