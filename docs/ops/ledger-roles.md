# Database roles of the audit ledger

Slice 5B-3.1 adds the ledger (`docs/design/records-and-corrections.md`). Its guarantees come from **who can do what**, so the roles are
part of the design, not a deployment detail. Nothing here has been applied in AWS; this describes what the migrations create and what an
administrator must provide.

## The roles

| Role | Login? | Created by | What it can do |
| --- | --- | --- | --- |
| `telesphoros_app` | no (its login is provisioned outside) | migration 0002 | The application. `SELECT` and `INSERT` on the record tables and notes, `SELECT` on the ledger, `EXECUTE` on `ledger_append` only. No `UPDATE`, `DELETE`, `TRUNCATE`; cannot write the ledger. |
| `telesphoros_ledger` | no | migration 0005 | Owns the ledger tables and the ledger functions. Reads the record tables only through explicit, tenant-scoped read policies. |
| `telesphoros_redactor` | no | migration 0006 | Owns the redaction function. `UPDATE` on three columns of `event_notes` (body, redacted_at, redaction_basis_code), and nothing else. |
| `telesphoros_ledger_verifier` | no (group) | migration 0005 | Reads every tenant's ledger and records. May execute exactly one function, `ledger_record_checkpoint`. Writes no record. |
| `telesphoros_ledger_operator` | no (group) | migration 0006 | May execute `redact_event_note`. |

Logins for the **verifier** and the **operator** are provisioned outside the repository, like the application's login. Each login is a
member of exactly its one group and of nothing else. The verifier login must **not** be a member of `telesphoros_app`: it would then
inherit the right to append.

```sql
-- Example (run by an administrator; choose real names and secrets, never commit them):
CREATE ROLE ledger_verifier_login LOGIN PASSWORD '<from your secret manager>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_ledger_verifier;
CREATE ROLE ledger_operator_login  LOGIN PASSWORD '<from your secret manager>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_ledger_operator;
```

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
`telesphoros_app`, the five above, and the role that owns the tables (the migrator). `db:restore` checks and stops, restoring nothing,
if any is missing. The manifest lists them (`privileges.roles`).

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
