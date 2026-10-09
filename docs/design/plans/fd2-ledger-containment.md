# Plan FD-2: shared ledger containment

Status: **approved 2026-10-09 and built** (migration 0011; this document records the plan as approved, with the founder's three additions, and what the build changed).

## The problem (confirmed in the code)

`LedgerStatus` (`ledger/ledger-status.ts`) is plain memory in each process. The monitor latches it when a walk finds damage; the append gate (`assertOpen`) reads it. With two ECS tasks, task A can find damage and refuse writes while task B, which has not yet walked that tenant, keeps appending to the damaged chain. The load balancer does not help: it fails open when every target is unhealthy, so a latched, not-ready task can still receive traffic. Today's mitigation is "run one task"; the file's own comment says "a single-instance pilot does not notice". The one place every task already shares is the database, and `ledger_append` already takes the tenant's head-row lock, so the database is where the refusal belongs.

## What I will build

1. **Migration 0011 (expand-only: new tables and one stricter function; old and new application versions both work against it).**
   - `ledger_incidents` (append-only like the ledger tables, `refuse_mutation` trigger): `id`, `scope` (`tenant` | `global`), `tenant_id` (null for `global`), `kind` (the existing failure kinds, or `manual-hold`), `seq` (nullable), `source`, `detected_at`, `recorded_by` (the database login), `basis` (text, required for `manual-hold`).
   - `ledger_incident_clearances` (append-only): `incident_id` (unique, so an incident is cleared once), `cleared_at`, `cleared_by`, `basis` (required), `verified_checkpoint_id` (see 3).
   - "Open" = an incident with no clearance. No row is ever updated or deleted.
   - `ledger_record_incident(tenant, kind, seq, source)`: SECURITY DEFINER, EXECUTE only to `telesphoros_ledger_verifier`. Idempotent: if the tenant already has an open incident it writes nothing (keeps the first finding, as the latch does now). It writes **only** `scope='tenant'`.
   - `ledger_set_global_hold(basis)`: EXECUTE only to the existing `telesphoros_ledger_operator` role (the break-glass-style human role already used for redaction). Writes a `global` incident.
   - `ledger_clear_incident(incident, basis)`: EXECUTE only to `telesphoros_ledger_operator`. For a `tenant` incident it **refuses unless a `full` checkpoint for that tenant, recorded after the incident, exists** and records its id. Checkpoints are written only when a full walk finds no damage, so a still-damaged chain cannot be cleared by anyone, however privileged. A `global` hold needs only the basis (a human decision).
2. **Enforcement in the database.** `ledger_append` (the application-callable wrapper) takes the tenant's head-row lock first (inserting the head row if missing, as `ledger_append_internal` does), then refuses with a dedicated error code when the tenant has an open incident or any `global` incident is open. Checking after the lock means a write cannot slip between a check and its lock. `redaction` and `checkpoint` go through `ledger_append_internal`, not the wrapper, so an operator can still redact PHI and the verifier can still record checkpoints during an incident (I will assert this in a test; it is deliberate).
3. **Application.**
   - The monitor calls `ledger_record_incident` when a walk finds damage (in addition to today's log line, which still feeds the CloudWatch alarm), through the verifier connection (its login can execute exactly that function).
   - The in-memory latch becomes **per tenant** (`assertOpen(tenantId)`), as a fast path only; the database is the authority. A write whose transaction hits the database refusal maps to the existing `LedgerCompromisedError` (503, same contract).
   - The monitor reads open incidents at start and on each pass so a task learns of a sibling's finding even if its own walk has not reached that tenant yet.
   - **Start-up:** production still refuses to start when a check at start finds damage that is **not already recorded**. A tenant with an already-open incident is "contained": it is listed in the log, the instance starts, other tenants run. Without this, one contained tenant would make every deployment fail its start and the ECS circuit breaker would roll the service around forever.
   - **Readiness:** `/ready` ledger = `down` only for a `global` hold or a failed check at start; a tenant-only incident reports `contained` with a count (never tenant ids) and the instance stays ready. The `ledger-compromised` alarm is unchanged and still fires on the first finding.
   - A contained tenant keeps being walked; success after a human fixes things produces the checkpoint that `ledger_clear_incident` requires.
4. **Admin surface (small).** `GET /ledger/verify` already exists. I add nothing that clears an incident over HTTP: clearing and the global hold are database-function calls by the operator role, recorded in the ledger tables, not API endpoints (smaller attack surface; a runbook gives the exact commands).
5. **Docs.** Amend spec section 21 and `docs/ops/ledger-watch.md`; correct F3b / `api-hosting.md` ("a damaged task leaves rotation at once" is wrong: the load balancer fails open; the database refusal is what contains it); STATUS; remove "run one task" from the open list once tests pass. `docs/ops/ledger-roles.md` gets the new grants.

## What I will NOT touch

Hash-chain format and verification algorithm; `ledger_append_internal`; event types; record tables; Cognito/auth; the clinical hold; Terraform (no resource changes; one wording fix in docs). No endpoint that clears an incident. Reads are never blocked by an incident (same as today).

## Risks and how each is controlled

- **A false positive freezes a tenant's writes.** That is the intended fail-closed direction; the cost is a runbook step. Control: only a walk reporting `failed` records an incident (not `incomplete`, timeouts or connection errors, which never did latch).
- **Replacing `ledger_append`.** `CREATE OR REPLACE` keeps owner and grants; the restore-time privilege-facts comparison and the existing ledger-roles tests will show any drift. Migration is expand-only, so the old image keeps working against it during a rolling deployment (the old image simply does not read incidents; the database still refuses for it).
- **Operator role misuse.** Clearing needs a post-incident full checkpoint, requires a basis, and is itself an append-only row; the global hold is a deliberate human act. Two-person approval is not built (needs the second-reviewer decision in FD-8).
- **Lock behaviour.** The wrapper's extra head-row lock is the same lock the internal function takes a line later; no new lock order. The existing `lock_timeout` stays.

## How I will verify (all against real PostgreSQL; the schema is the point)

1. Database tier: append refused for the open tenant, allowed for another tenant; a `global` hold refuses everyone; clearing refused without a later full checkpoint, accepted with one; second clearance of the same incident refused; the verifier login can record but not clear; the operator login can clear but not record a tenant finding; the app login can do neither; `redaction` and `checkpoint` still work during an incident; incident rows cannot be updated or deleted.
2. **Two processes, one database:** process A records an incident; process B (which never walked) is refused on its next write. Restart B: still refused. Clear (with a real checkpoint): B writes again.
3. **In-flight write:** a write holding the head lock when the incident is recorded either commits before it or is refused after it, never interleaves (two connections, controlled ordering).
4. **All targets unhealthy:** a process that reports not-ready still serving requests (the fail-open case) cannot append to a contained tenant.
5. Defect injection with a green control: remove the check in `ledger_append`; check before the lock; allow clear without a checkpoint; let the app login record; let the verifier clear; scope the check to the wrong tenant; make `incomplete` record an incident. Each must turn a named test red.
6. Backup/restore: the new tables restore with ownership and grants preserved (privilege facts comparison), and a backup taken with an open incident restores with it still open.
7. Full static checks and all three backend tiers.

## Decisions for you

1. **Start-up with a contained tenant** (recommended above): start with it listed and contained, rather than refuse. The alternative (refuse) is stricter but makes any incident an outage for everyone.
2. **Readiness for a tenant-only incident** (recommended): stay ready, report `contained`. The alarm and the log line are the paging path.
3. **Clearing authority**: the existing operator role alone, with the post-incident full checkpoint as the technical control (recommended for now; two-person approval waits for the second reviewer in FD-8).
4. **Until this lands:** the Terraform *requires* at least two tasks in production (`api-compute.tf`, precondition on the service; the variable default is 1), so a production apply before this PR would run two tasks with per-process latches. Nothing is applied, and the synthetic profile (FD-3) runs one task, so no live risk exists today; I will not apply a production-profile root before FD-2 is merged. (I earlier said "production runs one task"; that was wrong for the production profile.)

Delivered as one PR (migration + enforcement + application + docs) because the pieces are not safe separately: a table nothing reads, or a refusal nothing writes, is the defect shape this repo already tests for.

## Founder's sign-off and additions (2026-10-09)

Decisions 1 to 4 approved as recommended. Three requirements were added and are built:

1. **Checkpoint versus incident race.** A checkpoint qualifies for clearing only if its walk **started after** the incident's `detected_at` (the
   database's clock) and reaches the failed sequence number. Built as `ledger_checkpoints.walk_started_at`, written by a new five-argument
   `ledger_record_checkpoint`; the four-argument form stays for older tasks during a rolling deployment and never qualifies. Proved with the real
   verifier held at its COMMIT while another walk records the incident (test/db/ledger-incidents.pg-spec.ts).
2. **The application role cannot reach the internal appender.** The brief named it `telesphoros_api`; in this repository it is `telesphoros_app`.
   Migration 0011 states the revoke, and `ledger-catalog.pg-spec.ts` and `ledger-incidents.pg-spec.ts` assert that it can execute exactly one ledger
   function, `ledger_append`.
3. **Rolling upgrade.** The check lives in PostgreSQL, so an older task is stopped too. It gets a plain 500 instead of 503 for the same refusal.

## What the build changed from this plan

- `ledger_record_incident` takes the tenant's head-row lock itself (not only `ledger_append`), so an in-flight write commits before the incident exists
  and no write commits after it; the plan only had the gate take the lock.
- The public `/ready` body says `contained` and carries **no count** (the plan said "with counts"): an unauthenticated body gains nothing from a number.
  The count is in the log line `ledger-contained-at-start`.
- A contained tenant that still fails a walk logs a warning (`ledger-incident-still-open`), not a second `ledger-compromised` error, so the alarm pages on
  the first finding rather than at every walk.
- The restore check's tenant-isolation step now judges only tables the application role has a policy on (the incident tables give it nothing).
