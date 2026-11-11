# Measuring performance before changing anything

Status: **approved by the founder on 2026-11-11 with the recommended decisions** ("go with your recommendations"): D1 yes, D2 as listed,
D3 wait, D4 not now, D5 no; D6 (targets) stays the founder's, after the numbers. Written the same day after the founder asked to measure
before deciding on any performance work (a language change, a framework adapter, query or index changes). Nothing in AWS was read or
changed while writing it. Slice 0 is the founder's to run; slice 1 is the first build slice.

## Objective and completion boundary

Find out, with numbers, where time goes in the API and the database, so a later decision about improvements rests on data instead of
guesses. The plan is done when, for each route that matters, there is a p50 / p95 / p99 latency figure from staging and a matching local
figure from a repeatable script, the database's share of that time is known for the slowest routes, and the founder has written down a
target for each.

The plan does **not** decide or make any improvement. It does not change the language, the framework, a query, an index, a task size or
an instance class. Each of those, if the numbers call for it, gets its own plan.

## What already exists (read on 2026-11-11, `main` `5062c34`)

| What | Where | What it already gives |
| --- | --- | --- |
| A request log line for every API request | `apps/backend/src/logger-options.ts` | `route` (the route template, never the path), `responseTime` in ms, `res.statusCode`, `req.method`, `tenantId`. It already goes to the `/ecs/telesphoros-staging-api` log group. Latency per route can be read from it today with CloudWatch Logs Insights, with no code change |
| Container Insights on the API cluster | `infrastructure/terraform/api-compute.tf` (`containerInsights = enabled`) | CPU and memory per task and per service |
| Load balancer and database metrics | AWS default metrics; alarms in `api-compute.tf` and `database-alarms.tf` | `TargetResponseTime`, 5xx and 502/504 counts; RDS `CPUUtilization`, `DatabaseConnections`, `ReadLatency` / `WriteLatency`, `FreeableMemory`, and `CPUCreditBalance` (the staging database is `db.t4g.micro`, a burstable class) |
| A local load rehearsal | `scripts/readiness/local-load.cjs` | Two API instances against a disposable PostgreSQL 16, three synthetic tenants. It measures **one** route only (`GET /patients?page=1&pageSize=20`) |
| A patient-read benchmark | `apps/backend/test/performance/patient-read.bench.ts` | Repository-level timings for patient reads with 1, 5 and 50 history versions; opt-in, no threshold |

What is **not** there: no recorded staging latency anywhere in `docs/` (searched for p95, latency and CPU figures; only test timeouts
appear); no per-query database statistics (Performance Insights is off for the synthetic profile, `profile.tf`, and `pg_stat_statements`
is not created by any migration); no load-balancer access logs (and this plan does not propose them, see D5); no frontend timing.

## Evidence gathered while planning (local, 2026-11-11)

Run in this session's cloud container (4 vCPU, 15 GiB, Node 22.23.4, PostgreSQL 16 from `apps/backend/scripts/dev-postgres.sh`), after
`pnpm install --frozen-lockfile` and `pnpm build`:
`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres node scripts/readiness/local-load.cjs <scratch file>`, three
times. The evidence files stayed in the session's scratch directory; nothing was committed from them.

| Phase (`GET /patients`, page of 20) | Concurrency | Requests | Errors | Requests/s | p50 / p95 / p99 (ms), run 1 | p50 / p95 / p99 (ms), run 2 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Baseline | 4 | 120 | 0 | 228 / 234 | 16.9 / 24.5 / 29.0 | 15.9 / 23.3 / 27.4 |
| Bounded sustained (30 s) | 8 | 10,758 / 10,899 | 0 | 358 / 363 | 21.8 / 30.3 / 35.8 | 21.5 / 30.4 / 36.3 |
| Spike | 24 | 240 | 0 | 372 / 382 | 60.6 / 91.1 / 96.9 | 61.0 / 95.7 / 102.6 |
| Recovery | 4 | 120 | 0 | 351 / 342 | 11.0 / 14.5 / 16.1 | 11.4 / 15.0 / 16.8 |

How to read it:

- These are about twice the 2026-11-01 figures in [production-readiness-2026-11-01.md](../../verification/production-readiness-2026-11-01.md)
  (baseline p50 7.0 ms there). The machine is different, so the two sets cannot be compared; only runs on the same machine can.
- Throughput stops rising between 8 and 24 concurrent requests while latency triples. Each instance's pool holds 4 connections, so 24
  requests share 8 connections. That fits waiting for a connection, but it is an **inference**: the script does not record pool waits.
- One route says nothing about the other 80 in `apps/backend/test/route-set.json`.

**Run 3 failed, and the failure is a real defect, not noise.** The rehearsal's replay check sends 16 simultaneous `POST /patients` with
the same `requestId` and expects 16 × 201 with one patient. A probe (a scratch copy of the script that stops after that check and records
each non-201 answer) was run 15 more times: 14 passed, 1 failed in the same way. Across 18 runs, 2 failed (about 1 in 9). In each failure
one of the 16 got `409 CONFLICT "A patient with that label already exists."` while the database still held exactly one row. Reading the
code: `PatientsService.create` (`apps/backend/src/patients/patients.service.ts`) first looks up the request id (`findByRequest`), then
checks the label (`assertLabelFree`). A retry that runs the first lookup before the winner commits and the second after it finds no request
id but does find the label, the winner's own row, and answers 409 instead of replaying. The repository's `insertOrReplay` already handles
this race; the pre-check in the service runs before it. No duplicate is stored, but a client retrying its own request is told it
conflicted with itself. It also makes the rehearsal fail about 1 run in 9, so it has to be fixed before the rehearsal can be trusted for
measuring (D1).

## Slices

Each slice is its own draft pull request off `main`, after the founder approves this plan. They are ordered so the cheapest, most
informative step comes first.

### Slice 0: read staging as it is (founder-run, read-only, no code)

Before anything against staging, the founder runs `scripts/staging/staging-status.sh` and pastes its table here. **Not done yet; this
plan has not seen it, so it does not know what staging runs today.**

```
<paste the staging-status table here>
```

Then, with the staging identity (confirm with `aws sts get-caller-identity --query Arn` first), over the last 14 days:

1. Latency per route, from the request log lines that already exist. CloudWatch Logs Insights on `/ecs/telesphoros-staging-api`:

   ```
   fields route, req.method, responseTime, res.statusCode
   | filter ispresent(responseTime)
   | stats count(*) as n, pct(responseTime, 50) as p50, pct(responseTime, 95) as p95, pct(responseTime, 99) as p99,
           max(responseTime) as slowest by req.method, route
   | sort p95 desc
   | limit 40
   ```

   The query reads route templates, timings and status codes only. Logs Insights charges by data scanned; at staging's volume this
   should cost cents, but the founder decides.
2. From CloudWatch metrics, daily maximum and average: the load balancer's `TargetResponseTime` (p95, p99); the API and worker services'
   CPU and memory (Container Insights); the database's `CPUUtilization`, `CPUCreditBalance`, `DatabaseConnections`, `ReadLatency`,
   `WriteLatency` and `FreeableMemory`.
3. Record the results in this document. A read the organization's policy refuses is written down as unknown, not as zero.

What this tells us: which routes are slow on staging at all, and whether the database is running out of CPU credits or memory. Staging
traffic is the founder's own synthetic use, so it shows real latency under light load, not capacity.

### Slice 1: fix the replay race (code, backend only)

Only if D1 is approved. In `PatientsService.create`, when a request id is given, a label clash whose row carries the same request id and
the same request hash is answered as a replay; anything else stays a 409. Proof, following the working agreements: a test that forces the
interleaving (lookups held at the two points) fails before the change and passes after; the existing replay, changed-payload and
label-conflict tests still pass; all three backend tiers run; then the local rehearsal 30 times in a row with no failure.

Does not touch: the database, the patient API's shape, other routes.

### Slice 2: measure more routes, locally (test and script code only)

Extend the local rehearsal, or add a sibling script next to it, so it measures the routes that matter (D2) instead of one. For each route:
requests, errors, p50 / p95 / p99 / slowest, and requests per second, as JSON. Two additions that answer the questions slice 0 cannot:

- **Database time per query**, from `pg_stat_statements` in the **disposable local cluster only** (needs
  `shared_preload_libraries = 'pg_stat_statements'` in `dev-postgres.sh` or a flag passed when the script starts it). The evidence keeps
  the normalized query text, call counts and total and mean times. The data is synthetic, but the script still drops any statement that is
  not normalized.
- **Waits for a pool connection**, counted per route, so the inference above becomes a measurement.

Each run's machine (CPU count, memory, Node and PostgreSQL versions) goes into the evidence, because numbers from different machines
cannot be compared.

Does not touch: application code, migrations, Terraform, CI. Running it in CI is a follow-up, not part of this slice.

### Slice 3: per-query statistics on staging (Terraform and possibly a migration; only if D3 is approved)

Only if slices 0 and 2 leave the database as the open question. Two options, both off today:

- **(a) RDS database monitoring.** The synthetic profile turns Performance Insights off. Before proposing it, check what AWS offers for
  `db.t4g.micro` today, and at what price (Performance Insights or its CloudWatch Database Insights successor). Its 7-day retention is
  the cheapest setting. A Terraform change and an `INFRA` apply, which the founder runs.
- **(b) `pg_stat_statements` on the staging database.** RDS normally preloads the library, but `CREATE EXTENSION` needs `rds_superuser`,
  and the migrator is not one. So this would be a one-off administrator step or a migration with its own review. Query text is normalized,
  but utility statements can keep literals. The data is synthetic, but the same setting would carry into production, so the founder decides
  with production in mind.

### Slice 4: a short, controlled load run on staging (only if D4 is approved)

Only if the founder wants capacity figures for the hosted setup (one Fargate task, `db.t4g.micro`, real Cognito, the WAF). Synthetic
tenants only, a fixed ceiling and duration written down before the run (for example 5 minutes at the slice 2 concurrency), at a time the
founder picks, watched from the slice 0 metrics, with WAF rate rules left as they are. It needs a plan of its own for tokens and for what
counts as "stop now".

### Slice 5: targets (founder, docs only)

With the numbers in hand, the founder writes a target per route group (for example: reads p95 under X ms on staging, uploads under Y s).
Only then does any improvement get proposed, each measured against these targets with the same scripts, before and after.

## Decisions only the founder can make

| | Decision | Recommendation |
| --- | --- | --- |
| D1 | Fix the replay race (slice 1) before measuring further | **Yes.** It is a correctness defect a user can see (a 409 on their own retry), and it makes the rehearsal fail about 1 run in 9 |
| D2 | Which routes count | Patient list and detail, report list and detail, report upload and capture, the synthetic assessment, sign-in round trip. Slice 0 adds any that turn out slow |
| D3 | Per-query statistics on staging, and which kind | **Wait** until slices 0 and 2 are read. If needed, prefer (a), which changes no schema, once its price for this class is known |
| D4 | A load run against staging | **Not now.** Decide after slice 2; staging is one task on a burstable database, so its capacity is known to be small |
| D5 | Load-balancer access logs | **No.** They record full request paths and query strings, which the API's logger deliberately never records; the request log line already carries route timing |
| D6 | Targets per route group | The founder's call, after the numbers (slice 5) |

## What this plan does not touch

No language, framework, query, index, task size, instance class or alarm change. No apply in any slice except slice 3, and only after D3.
No real patient data anywhere; staging stays synthetic, and the AWS BAA is still not executed. No new log fields: the measurements use fields
already on the allowlist in `logger-options.ts`.

## How it will be verified

- Slice 0: the founder pastes the staging-status table and query results here; the agent checks each figure against its source and
  writes unknowns as unknown.
- Slice 1: a failing-then-passing test that forces the interleaving, all three backend tiers, 30 clean rehearsal runs.
- Slice 2: the script refuses a non-loopback database, as the current one does; a deliberately slowed query (a `pg_sleep` in a scratch
  copy) must show up as the top statement and the slowest route, so the script is shown to catch what it claims to.
- Slices 3 and 4: plans of their own.
