# Database roles of the audit ledger

Slice 5B-3.1 adds the ledger (`docs/design/records-and-corrections.md`). Its guarantees come from **who can do what**, so the roles are
part of the design, not a deployment detail. Nothing here has been applied in AWS; this describes what the migrations create and what an
administrator must provide.

## The roles

| Role | Login? | Created by | What it can do |
| --- | --- | --- | --- |
| `telesphoros_app` | no (its login is created by `db provision-logins`) | migration 0002 | The application. `SELECT` and `INSERT` on the record tables and notes, `SELECT` on the ledger, `EXECUTE` on `ledger_append` (the gate) only: **not** `ledger_append_internal`, and nothing that records, holds or clears an incident (a catalog test pins it). No `UPDATE`, `DELETE`, `TRUNCATE`; cannot write the ledger; cannot read the incident tables. |
| `telesphoros_ledger` | no | migration 0005 | Owns the ledger tables and the ledger functions. Reads the record tables only through explicit, tenant-scoped read policies. |
| `telesphoros_redactor` | no | migration 0006 | Owns the redaction function. `UPDATE` on three columns of `event_notes` (body, redacted_at, redaction_basis_code), and nothing else. |
| `telesphoros_ledger_verifier` | no (group) | migration 0005 | Reads every tenant's ledger and records, and the incident tables. May execute exactly two functions: `ledger_record_checkpoint` and `ledger_record_incident` (0011). Writes no record. |
| `telesphoros_ledger_operator` | no (group) | migration 0006 | May execute `redact_event_note`, and (0011) `ledger_set_global_hold` and `ledger_clear_incident`; reads the incident tables. Runbook use only, never an API: no application code calls these (a static test pins it). See [ledger-watch.md](ledger-watch.md). |
| `telesphoros_security_auditor` | no (group) | migration 0018 | Reads the security-event record (`SELECT` on `security_events`) and nothing else. Its login is provisioned by a person, outside the repository, like the operator's. See [security-events.md](security-events.md). |

The **application**, **verifier** and **migrator** logins are created by `db provision-logins` (FD-4, [api-hosting.md](api-hosting.md#the-database-logins-db-provision-logins)); the **operator** login is provisioned outside the repository, by a person. Each login is a
member of exactly its one group and of nothing else. The verifier login must **not** be a member of `telesphoros_app`: it would then
inherit the right to append.

```sql
-- Example (run by an administrator; choose real names and secrets, never commit them):
CREATE ROLE ledger_verifier_login LOGIN PASSWORD '<from your secret manager>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_ledger_verifier;
CREATE ROLE ledger_operator_login  LOGIN PASSWORD '<from your secret manager>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_ledger_operator;
```

The verifier login's connection string is the application's `LEDGER_VERIFIER_DATABASE_URL` (docs/ops/ledger-watch.md). It is **required in
production and whenever the pipeline is enabled**, and the application refuses to start if it is missing or if it equals `DATABASE_URL`. This is
the first place the verifier login is used by a running process, so it must exist before the first production start (a hosting-phase task:
nothing is provisioned in AWS yet). The restore check does not need it: it uses the restore's own server credentials with `role` set.

## The migrator

The migrations create the ledger's objects under `SET LOCAL ROLE telesphoros_ledger` (and `telesphoros_redactor`), so each owns what it
should. The migrator therefore needs the right to `SET ROLE` to them. A superuser already has it. For an ordinary migrator with
`CREATEROLE`, the migrations grant themselves `WITH SET TRUE, INHERIT FALSE` when the roles are new; when an administrator created
the roles first, grant it once:

```sql
GRANT telesphoros_ledger   TO <migrator> WITH SET TRUE, INHERIT FALSE;
GRANT telesphoros_redactor TO <migrator> WITH SET TRUE, INHERIT FALSE;
```

Without the membership the migration stops with a clear error and leaves nothing half-applied (tested). **Not verified:** a migrator that
must create the roles itself on a server where none exist (the test cluster shares roles between test workers); the first real
deployment should run `migrate` once on an empty server and read the result.

## Restoring on a new server

Roles are per server, so a backup cannot carry them. Before `db:restore`, create on the target server every role the backup names:
`telesphoros_app`, the roles above, and the role that owns the tables (the migrator). `db:restore` checks and stops, restoring nothing,
if any is missing. The manifest lists them (`privileges.roles`).

## Containing and reopening a tenant (runbook; never an API)

Migration 0011 (FD-2) puts the record log's "damaged" state in the database, where every API task sees it. The verifier login records a tenant
incident when a walk fails; `ledger_append` then refuses that tenant's writes in every task. An operator can stop every tenant, and can reopen a
tenant once a full verification that began after the incident has passed. The commands and the rules are in [ledger-watch.md](ledger-watch.md).

```sql
-- as the operator login
SELECT ledger_set_global_hold('why, up to 500 characters');          -- every tenant refused until cleared
SELECT ledger_clear_incident('<incident id>'::uuid, 'what was done'); -- a tenant incident needs a later passing full walk
```

## Redacting a note (runbook; never an API)

An operator, not the application, can replace a note's text with a tombstone after a documented decision (the basis code is one of
`phi-in-note`, `legal-order`, `other-approved`). The event, the tombstone and the basis commit together or not at all; the chain still verifies.

```sql
BEGIN;
SELECT set_config('app.current_tenant_id', '<tenant>', true), set_config('app.current_actor', '<operator sub>', true);
SELECT redact_event_note('<note id>'::uuid, gen_random_uuid(), 'phi-in-note');
COMMIT;
```

Verify afterwards with the ledger verifier. Keep the decision record (who, when, why) in your own compliance records, not in the database.
