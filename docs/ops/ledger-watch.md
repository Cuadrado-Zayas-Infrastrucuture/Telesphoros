# The ledger watch

Slice 5B-3.3c. The record log (the per-tenant hash-chained ledger of `docs/design/records-and-corrections.md` section 6) makes tampering
**evident**. This is the part that actually looks. Nothing here has been applied in AWS, and nothing here is connected to a real alarm yet
(see "The alarm" below).

## What it does

| When | What | If it finds damage |
| --- | --- | --- |
| **At start** | For every tenant, checks the chain from the latest checkpoint (a chain of at most 50 000 events is walked in full instead), within one total budget | **Production refuses to start.** Other environments log it and latch (below) |
| **Right after start** | One tenant at a time, walks the whole chain and records a `full` checkpoint when it is `ok` | Latches |
| **On a timer** (default every 24 h, jittered 10%) | The same full walk | Latches |
| **On request** (`GET /ledger/verify`, admin) | Checks the caller's own tenant, now | Latches, and says what it found |
| **After a restore** (`db:restore`) | Walks every tenant's whole chain as `telesphoros_ledger_verifier` | The restore is "not ok" |

**Latched** means: this process stops writing records until it is restarted. Readiness (`/ready`) fails on `ledger`; every request that would
append to the ledger gets **503 `LEDGER_COMPROMISED`** (no `Retry-After`: waiting cannot clear it), is rolled back and stores nothing; the
evaluation route refuses before it runs the reader. Reads, and writes that are not ledger records (for example creating a patient), carry on.
The latch is memory only and cannot be cleared by repairing the data: a person decides, by restarting after an investigation.

Only one verification runs at a time in a process. The walk reads one consistent snapshot (`REPEATABLE READ`, read-only), so it never blocks a
writer. Answers and log lines name **kinds of failure and sequence numbers, never a value from a record**, and no tenant is named in an error
that reaches a caller.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEDGER_VERIFIER_DATABASE_URL` | none | The verifier's **own** login (a member of `telesphoros_ledger_verifier` and of nothing else, never the application's: `docs/ops/ledger-roles.md`). **Required in production and when `LAB_REPORT_PIPELINE=enabled`**; if it is not set elsewhere the watch is off and `/ready` has no `ledger` entry. Refused if it equals `DATABASE_URL` or the store is not PostgreSQL |
| `LEDGER_STARTUP_BUDGET_MS` | 20000 | The checks at start may take this long **in total**, across every tenant (1 000 to 300 000) |
| `LEDGER_FULL_VERIFY_INTERVAL_HOURS` | 24 | Time between full walks (0 to 168). 0 turns the timer off; the walk after start still runs |

Validation errors name variables, never values.

## Readiness

`GET /ready` gains `ledger` when the watch is on:

- `up`: the check at start passed, a full walk has finished, none is running.
- `verifying`: the check at start passed and a full walk is running (or has not yet finished). **The instance is ready.**
- not ready (503, `details: [{field: "ledger", message: "unavailable"}]`): the check at start has not passed, or the log is latched.

It reads memory, so it cannot time out on the database.

## When it latches or refuses to start (runbook)

1. **Do not restart to "clear" it.** A restart clears the latch, and if the damage is real it will be found again (and production will refuse to
   start): that is the design, but the first job is to find out what happened.
2. Read the log line with `event: "ledger-compromised"`. It has `tenantId`, `source` (`startup`, `background`, `scheduled`, `on-demand`), `mode`,
   and `failures: [{kind, seq}]` (at most ten). The kinds are listed in `apps/backend/src/ledger/verifier.ts`: `seq-gap`, `prev-hash-mismatch`,
   `record-hash-mismatch`, `payload-mismatch` (a stored row no longer matches what its event recorded), `record-missing`, `row-without-event`,
   `head-mismatch`, `checkpoint-mismatch`, `note-digest-mismatch` and the rest.
3. Ask for the same answer from the other side: an admin of that tenant calls `GET /ledger/verify?full=true`.
4. Compare against the most recent good backup: `db:restore` of that backup now ends with the same walk (`ledger chain`), so a backup that passes
   is a known-good copy to compare with or recover from.
5. When the cause is understood and handled (data recovered, or the finding explained and accepted by whoever owns that decision), restart.
6. An incomplete check at start in production (`... : incomplete`) is not damage: the chain is larger than the budget allows on a cold start (no
   checkpoint yet), or the verifier login or the database could not be reached. Look for `ledger-verification-error` (the class and database code
   only). For size, raise `LEDGER_STARTUP_BUDGET_MS` once (up to 300 000); after the first background walk there is a checkpoint and starts are fast.

## The alarm

The watch writes one structured **error** line per finding (`event: "ledger-compromised"`). Turning that line into a page or an email is a
deployment task: the Terraform is written but never applied, and **no alarm on this log line exists yet**. Until the hosting phase connects one,
someone has to be reading the logs, or must treat `/ready` failing on `ledger` as the signal. This document will say so until it changes.

## Restore

`db:restore` (and `restore-remote`) gain a check named `ledger chain`. After the restore, for every tenant in the restored copy it walks the
**whole** chain as `telesphoros_ledger_verifier`, using the restore's own server credentials with `role` set to the verifier role, so no extra
credential is needed and the verifier's real policies and grants are exercised. It writes nothing (no checkpoint), so a throwaway restore stays a
throwaway. A restored ledger that fails, or cannot be walked to the end in 15 minutes per tenant, makes the restore "not ok". A backup from before
the ledger existed reports "not applicable: this backup predates the ledger" and still passes; a ledger with no events says so.

## How long it takes (measured)

MEASUREMENTS_PLACEHOLDER

## What this does not do

- It does not detect removal of the **newest** events, nor a whole chain rewritten consistently by someone with full owner access
  (specification 6.9). Anchoring each tenant's head outside the database is the follow-up that closes both.
- A checkpoint is a shortcut, not a control: it makes a start fast, and someone who can rewrite the chain can rewrite a checkpoint stored beside it.
  The control is the full walk.
- The latch is per process. Two instances each run their own walks and latch themselves, so they can briefly disagree.
