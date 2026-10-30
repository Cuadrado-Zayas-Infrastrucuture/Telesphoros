# The ledger watch

Slice 5B-3.3c, with containment shared through the database since FD-2 (migration 0011). The record log (the per-tenant hash-chained ledger of
`docs/design/records-and-corrections.md` section 6) makes tampering **evident**. This is the part that actually looks. Nothing here has been
applied in AWS, and nothing here is connected to a real alarm yet (see "The alarm" below).

## What it does

| When | What | If it finds damage |
| --- | --- | --- |
| **At start** | Reads the open incidents, then checks every tenant that is not already contained from its latest checkpoint within one total budget (a tenant with no checkpoint is walked from the start, which that budget must cover). Then, within **half as much time again**, walks in full each chain of at most 50 000 events, as many as fit; the rest are checked from their checkpoint only and left to the walk right after start (the log says how many: `ledger-startup-full-walks-deferred`) | A **new** failure in either step is contained and recorded, and **production refuses to start** (the replacement start finds it recorded and goes on). A check that cannot finish, in the first step, also refuses a production start. A full walk that does not fit never does. Other environments log and carry on |
| **Right after start** | One tenant at a time, walks the whole chain and records a `full` checkpoint when it is `ok` (a contained tenant too: that checkpoint is the evidence for clearing) | Contains the tenant |
| **On a timer** (default every 24 h, jittered 10%) | The same full walk | Contains the tenant |
| **On a shorter timer** (every 60 s) | Reads the open incidents again | Mirrors them (a sibling task's finding, a person's clearance) |
| **On request** (`GET /ledger/verify`, admin) | Checks the caller's own tenant, now | Contains the tenant, and says what it found |
| **After a restore** (`db:restore`) | Walks every tenant's whole chain as `telesphoros_ledger_verifier` | The restore is "not ok" |

## Containment (FD-2): what "contained" means

A walk that finds damage records an **incident** in the database (`ledger_incidents`, written only by `ledger_record_incident`, which only the
verifier login may call). From the moment that call returns, `ledger_append` (the one function the application may call to write a record)
**refuses every write for that tenant, in every task**, inside its own transaction and right after it takes the tenant's head-row lock
(SQLSTATE `LC001`, answered as **503 `LEDGER_COMPROMISED`**, no `Retry-After`: waiting cannot clear it). The row written by the refused request
is rolled back with it, and the evaluation route refuses before it runs the reader. Reads, redactions, checkpoints, and writes that are not
ledger records (for example creating a patient) carry on. **Other tenants carry on too.**

- **The database is the authority; each process's memory is a fast path.** A task that never walked the tenant is stopped by the database at its
  first write; a restart changes nothing, because the incident is still open. (An older image, during a rolling deployment, gets a plain 500
  instead of the 503 for the same refusal.)
- **No write commits for the tenant after the incident exists.** `ledger_record_incident` takes the same head-row lock first, so a write that is
  already in flight finishes (and commits) before the incident is recorded, and every write queued behind it sees the incident.
- **Only a person reopens writes**, with `ledger_clear_incident` as the operator login (below). It is refused unless a **full** verification of
  that tenant that **began after the incident was recorded** (the database's clock) has passed and reaches the failed sequence number. A walk that
  was already running when the damage was found cannot clear it by finishing later; a chain that is still damaged cannot be cleared by anyone,
  because a checkpoint is written only after a walk that found nothing wrong.
- **A global hold** (`ledger_set_global_hold`, operator only) stops writes for every tenant until it is cleared; clearing it is a decision, not a
  walk. Writes already in flight for other tenants may still commit; every write that starts after the hold is recorded is refused.
- If the database cannot be told (unreachable when the damage is found), the process keeps refusing on its own and retries at its next sync; the
  log line `ledger-incident-record-failed` (class and code only) says so.

Only one verification runs at a time in a process. The walk reads one consistent snapshot (`REPEATABLE READ`, read-only), so it never blocks a
writer. Answers and log lines name **kinds of failure and sequence numbers, never a value from a record**, and no tenant is named in an error
that reaches a caller.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEDGER_VERIFIER_DATABASE_URL` | none | The verifier's **own** login (a member of `telesphoros_ledger_verifier` and of nothing else, never the application's: `docs/ops/ledger-roles.md`). **Required in production and when `LAB_REPORT_PIPELINE=enabled`**; if it is not set elsewhere the watch is off and `/ready` has no `ledger` entry. Refused if it equals `DATABASE_URL` or the store is not PostgreSQL |
| `LEDGER_STARTUP_BUDGET_MS` | 20000 | The checkpoint checks at start may take this long **in total**, across every tenant (1 000 to 300 000). Full walks of small chains get half of it again, so the whole check at start takes at most one and a half times this |
| `LEDGER_FULL_VERIFY_INTERVAL_HOURS` | 24 | Time between full walks (0 to 168). 0 turns the timer off; the walk after start still runs |

Validation errors name variables, never values.

## Several tasks: how the full walks are spaced out

Every task walks the whole ledger for itself, once after start and then on its timer; that is deliberate (a checkpoint is a shortcut, not an independent control, and each task's own view should rest on its own check). Left alone, N tasks started together would all walk at the same moment and load the database N times over. Two things space them out:

- **A random delay after start.** The walk that follows the check at start begins after a random delay of up to 60 seconds (`BOOT_PASS_JITTER_MS`). The check at start itself, which decides whether the task starts, is not delayed.
- **One walk at a time.** A task takes a database advisory lock (`telesphoros:ledger-full-walk`) on a connection of its own for the length of its walk (start and timer alike). A task that finds it taken retries about every 10 seconds, for up to 30 minutes (`PASS_LOCK_WAIT_MS`), then **walks anyway** and logs `ledger-pass-lock-timeout`. A lock it cannot ask for at all is logged as `ledger-pass-lock-error` and the walk goes ahead. The lock therefore only ever delays a check; it is never the reason one does not happen. It is freed when the walk ends or when the task's connection closes (a killed task frees it).

While a task waits its turn its `ledger` readiness stays `verifying`, which is ready. The waits and the timeout are fixed constants, not environment settings. Not verified under real load or in AWS: how long N walks take end to end on production-sized chains.

## Readiness

`GET /ready` gains `ledger` when the watch is on:

- `up`: the check at start passed, a full walk has finished, none is running.
- `verifying`: the check at start passed and a full walk is running (or has not yet finished). **The instance is ready.**
- `contained`: at least one tenant's record log is stopped; the others are not. **The instance is ready**, because the other tenants keep working.
  The public body names no tenant and no count; the log line `ledger-compromised` (and the alarm) is how a person finds out.
- not ready (503, `details: [{field: "ledger", message: "unavailable"}]`): the check at start has not passed, or a **global hold** is open.

It reads memory (mirrored from the database every 60 s), so it cannot time out on the database. Do not read "ready" as "no incident": a load
balancer keeps sending traffic to a task that is ready, and the database refuses the contained tenant's writes whichever task they reach.

## When a tenant is contained, or production refuses to start (runbook)

1. **Do not look for a way to "clear" it by restarting.** A restart changes nothing: the incident is in the database, and if the damage is real a
   walk finds it again. The first job is to find out what happened.
2. Read the log line with `event: "ledger-compromised"`. It has `tenantId`, `source` (`startup`, `background`, `scheduled`, `on-demand`), `mode`,
   and `failures: [{kind, seq}]` (at most ten). The kinds are listed in `apps/backend/src/ledger/verifier.ts`: `seq-gap`, `prev-hash-mismatch`,
   `record-hash-mismatch`, `payload-mismatch` (a stored row no longer matches what its event recorded), `record-missing`, `row-without-event`,
   `head-mismatch`, `checkpoint-mismatch`, `note-digest-mismatch` and the rest. A tenant that is already contained and still fails logs
   `ledger-incident-still-open` (a warning) at each walk; it does not page again.
3. See what the database holds, as the operator login (`telesphoros_ledger_operator`; the login is provisioned outside the repository, like the
   verifier's, see [ledger-roles.md](ledger-roles.md)):
   ```sql
   SELECT i.id, i.scope, i.tenant_id, i.kind, i.failed_seq, i.source, i.detected_at, i.recorded_by
     FROM ledger_incidents i
    WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id)
    ORDER BY i.seq;
   ```
4. Ask for the same answer from the other side: an admin of that tenant calls `GET /ledger/verify?full=true`.
5. Compare against the most recent good backup: `db:restore` of that backup ends with the same walk (`ledger chain`), so a backup that passes is a
   known-good copy to compare with or recover from. A backup taken during an incident restores with the incident **still open**.
6. **To stop every tenant at once** (for example while you investigate something wider): as the operator login,
   `SELECT ledger_set_global_hold('why, in your own words, up to 500 characters');`. Readiness goes down on every task within a minute.
7. **To reopen a tenant**, when the cause is understood and handled (data recovered, or the finding explained and accepted by whoever owns that
   decision): wait for (or ask for, with `GET /ledger/verify?full=true`) a full walk that passes, so a `full` checkpoint exists that began after the
   incident, and then, as the operator login,
   `SELECT ledger_clear_incident('<incident id>', 'what was done, up to 500 characters');`.
   The database refuses with "No full verification that started after the incident has passed" until the evidence exists. For a global hold the same
   call needs only the basis. Every task notices within a minute; none needs a restart. The clearance is a row of its own (who, when, why, and the
   checkpoint that proved it), and nothing is ever deleted.
8. An incomplete check at start in production (`... : incomplete`) is not damage: a chain with no checkpoint yet is larger than the budget allows on a cold start, or the verifier login or the database could not be reached. (Many small tenants no longer cause this: their full walks are deferred, not required.) Look for `ledger-verification-error` (the class and database code
   only). For size, raise `LEDGER_STARTUP_BUDGET_MS` once (up to 300 000); after the first background walk there is a checkpoint and starts are fast.
   **A chain longer than 1 000 000 events is different**: a full walk stops at that limit and answers `incomplete` however much time it is given, so it never
   records a checkpoint and raising the budget does not help. The watch says so with an **error** line `ledger-chain-over-size` (tenant, mode, events
   checked; no values) on every pass, instead of the generic `ledger-verification-incomplete` warning that means "ran out of time". It is not damage:
   nothing is latched or contained. A tenant that already has a checkpoint is still checked from it; one that does not stays unverified. The remedy is a
   code change (walking in resumable segments), not configuration.
9. A damage that cannot be repaired in place (the ledger and its record tables are append-only, even for the owner) means recovering that tenant's
   data from a verified backup; clearing needs the full walk to pass on whatever is then in the database.

## The alarm

The watch writes one structured **error** line per finding (`event: "ledger-compromised"`). Turning that line into a page or an email is a
deployment task. The alarm is written ([ops/api-hosting.md](api-hosting.md), `api-compute.tf`: a metric filter on the line and an alarm into the audit topic), and the
alarm **exists in synthetic staging** (into the audit topic, which has one confirmed email address; [environments.md](environments.md)). It has
never been fired on purpose. Until it is tested, someone has to be reading the logs, or must treat `/ready` failing on
`ledger` as the signal. A test pins that the application writes `event` at the top level of its JSON log line (the field the alarm matches).

Two more lines now have a metric filter and an alarm into the audit topic (`api-compute.tf`), applied in synthetic staging like the first:

| Alarm | Line | Raised by | Means |
|---|---|---|---|
| `api-ledger-verification-error` | `ledger-verification-error` (error) | one line in 15 minutes | The check could not run (the verifier login, the network, missing tables), at start or in a background pass. Nothing is known about the record log until one succeeds. |
| `api-ledger-chain-over-size` | `ledger-chain-over-size` (error) | one line in an hour | A tenant's chain is longer than one walk covers. Not damage; a checkpoint does not help. |

How often they repeat: CloudWatch notifies when an alarm changes state, not on every line. While the over-size line keeps arriving (once per full pass, about a day apart) the alarm stays in ALARM after the first notification and says nothing more; it returns to OK after a quiet hour and notifies again at the next pass. That is the default chosen here; a different rule (a reminder every day, say) is a decision for the founder.

`ledger-verification-incomplete` (a walk ran out of time) is **deliberately not alarmed**: it is expected on every cold start while the first walk runs (`/ready` reports `verifying`), so an alarm on it would fire on every deploy. A walk that never completes shows as `ledger-chain-over-size` or `ledger-verification-error`, which are alarmed. `ledger-incident-record-failed` (a finding could not be written to the database) is not alarmed either: it is retried every minute, the finding itself already raised `api-ledger-compromised`, and a database that cannot be written trips the readiness and database alarms.

## Restore

`db:restore` (and `restore-remote`) gain a check named `ledger chain`. After the restore, for every tenant in the restored copy it walks the
**whole** chain as `telesphoros_ledger_verifier`, using the restore's own server credentials with `role` set to the verifier role, so no extra
credential is needed and the verifier's real policies and grants are exercised. It writes nothing (no checkpoint), so a throwaway restore stays a
throwaway. A restored ledger that fails, or cannot be walked to the end in 15 minutes per tenant, makes the restore "not ok". A backup from before
the ledger existed reports "not applicable: this backup predates the ledger" and still passes; a ledger with no events says so.

## How long it takes (measured)

Full walks of one tenant's chain, measured in slice 5B-3.3c on the CI-sized development machine (4 vCPU Xeon 2.1 GHz, 16 GB, PostgreSQL on the same
machine, nothing else running). The events are real records written through the application: a capture, an acceptance and an evaluation (with its
result and gene-state rows) per report, so each event is checked against its stored rows in both directions.

| Events in the chain | Full walk | Walk from a checkpoint (1 new event) |
| --- | --- | --- |
| 10 002 | 0.95 s | 6 ms |
| 50 001 | 5.4 s (4.8 s on a second run) | 58 ms |
| 150 000 | 14.7 s (14.2 s on a second run) | 122 ms |

The cost is linear, about 0.1 ms per event (10 000 events a second). The lightest possible events (checkpoints only) were 0.25 s at 10 001 and
1.3 s at 50 001, so real records are the right thing to plan with.

What the defaults rest on:

- **Walk in full at start up to 50 000 events** (about 5 s each), **within half the start budget**: stronger than trusting a checkpoint, and bounded. Before this limit existed the walks shared the one 20 s budget, so tenants whose small chains summed past roughly 200 000 events made every production start fail with `incomplete`. What does not fit is deferred to the walk that begins right after start, and a failure found there contains the tenant as any other finding does. The trade is a short window in which such a chain has been checked from its checkpoint only, which is the check a start relied on before this slice for every larger chain.
- **Start budget 20 s**: covers a cold start (no checkpoint yet) of roughly 190 000 events on this machine. A database across a network adds a round
  trip per 200-event batch, so allow a safety factor of three, about 60 000 events; far above a pilot's size. If production refuses to start with
  `incomplete`, raise `LEDGER_STARTUP_BUDGET_MS` once (the limit is 300 000, about 1.5 million events here); the first background walk then records a
  checkpoint and later starts take milliseconds.
- **Background and timer walks: 15 minutes per tenant.** **Admin check: 30 s** (about 300 000 events; a larger chain answers `incomplete`).
- **Restore check: 15 minutes per tenant.**

Not measured: a database on another host, a chain beyond 150 000 events, and walk speed or writer latency while writes are happening. A walk reads
one read-only snapshot, which by design takes no lock a writer waits on, but that is a property of the design and was **not** tested under load in
this slice.

## What this does not do

- It does not verify a chain longer than 1 000 000 events in full: the walk stops at that limit (`incomplete`, reason `size`) and the watch names it with `ledger-chain-over-size`. Resuming a walk across passes is a possible later slice if chains ever approach the limit; nothing in the pilot data is near it.
- It does not detect removal of the **newest** events, nor a whole chain rewritten consistently by someone with full owner access
  (specification 6.9). Anchoring each tenant's head outside the database is the follow-up that closes both.
- A checkpoint is a shortcut, not a control: it makes a start fast, and someone who can rewrite the chain can rewrite a checkpoint stored beside it.
  The control is the full walk.
- **Two-person authorisation** of a clearance or a hold is not built: the operator role alone may do either (the evidence rule for a tenant incident
  is technical; a global hold is a decision). It waits for the second reviewer (FD-8).
- **Not tested in AWS.** The behaviour is proved against a real PostgreSQL (two sessions, a restart, a restore), not against RDS or a real
  load balancer; the clock used by the clearance rule is one database's clock (a failover to another host with a different clock could skew it by
  the clock difference).
- The checkpoint's walk start time is stored beside the checkpoint but is **not part of its hashed payload** (changing that is a hash-version
  change). The table is append-only and only the verifier's function writes it, but a verifier login that lies could write a false start time; that
  login is already trusted to say "this chain is sound".
