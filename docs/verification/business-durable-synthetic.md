# P2 local verification ledger

Candidate base: P1 PR #169 head `827e7a6`; branch `feat/durable-synthetic-local`; local-only and uncommitted. P1 is not on `origin/main`. This is an interim record, **not** the P2 acceptance receipt.

Verified on 2026-10-18 against a newly owned PostgreSQL 16.14 Unix-socket fixture, with TCP disabled and `fsync`, `synchronous_commit`, and `full_page_writes` all on:

- Existing repository migrator applied all 28 migrations in a fresh disposable database. Migration 0028 made ten tables, eight forced-RLS tenant tables and ten synthetic triggers. Empty down/up passed; nonempty down refused and left its row intact.
- Actual restricted app and worker login connections had no direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE rights on any new table and neither had SUPERUSER or BYPASSRLS.
- Wrong source digests and later body/version/digest mutation, DELETE and TRUNCATE CASCADE were rejected. One-way eligibility revocation passed. Begun invocation evidence could be filled once and not rewritten, deleted or truncated. Synthetic outcome and audit rows also rejected update, delete and truncate.
- The owned postmaster was stopped in immediate mode with a synthetic transaction open and restarted. Committed capacity/source rows survived; the uncommitted bucket row was absent. This proves this fixture's software crash recovery, not power-loss durability or business-run recovery.
- A restricted app login could set the existing custom tenant GUC and obtain a positive `membership_assert_current` result for a synthetic row. The approved P2 boundary therefore remains trusted in-process fixture-only; this is a documented activation blocker.
- Restricted app admission produced one run, one full reservation and one ID-only existing-queue job in a single transaction. A repeated exact request returned the same IDs; a changed tuple refused. The stored request and source tuple preimages and SHA-256 digests matched JavaScript UTF-8 bytes. A test-only reservation trigger caused a checked failure; a fresh connection found no orphan job, run, reservation or bucket. Two simultaneous exact requests admitted once.
- Direct SQL calls rejected malformed object shape, JSON nulls, scalars and numeric impersonation of string fields before any admission. Current membership version, disabled grant and revoked source blocked repeat admission. In a separate disposable database, tenant-day and fleet-month budget edges refused without jobs/runs, and three simultaneous tenants acquired only the two permitted fleet slots, with a single slot per tenant.
- Pure ai-service tests passed 71/71 and existing jobs tests passed 13/13. The explicit PostgreSQL suite passed 7/7 across two planned test files. Typecheck, lint and build passed after these changes. Native stdout/stderr and exit codes are retained locally for the package checks and owned-cluster evidence. These are local partial-slice checks, not the P2 delivery gate.

### 2026-10-19: claim through settlement

Owned PostgreSQL 16.14 fixture `40331244-aceb-4fb8-bf02-21a0cea541ca` (private socket, TCP off, fsync/synchronous_commit/full_page_writes on). The migration applies all 28 migrations, and the existing smoke (empty down/up, nonempty-down refusal, immutability, admission, tuple parity) still passes with the 33 new functions. The explicit PostgreSQL suite passes **18/18**: admission 5, budgets 2, and a new lifecycle file with 11 tests. Those cover: first-accept release with full settlement to the original buckets and a gap-free audit; one persisted repair → second attempt, and second repair → `REPAIR_EXHAUSTED`; a `hold` verdict refusing repair-pending, release-pending and `begin(draft,2)`; a forged release refused by both the adapter and direct SQL; idempotent finish with a changed proposal refused; forged fence/claim/attempt/worker refused for load and queue control; malformed SQL inputs returning `INVALID_INPUT`; release → reclaim with the same worker and attempt raising the fence, refusing the old stamp and holding with zero dispatch; lease loss → dead job → `QUEUE_DEAD` hold; queue-wait expiry; revoked grant blocking readback while the outcome stays stored; a direct `job_enqueue` orphan failed dead; per-login EXECUTE grants, definer and search_path; and cancel with known usage (settled) versus unknown usage (full reservation and permit retained, worker refused `STALE_CLAIM`).

Guard-removal proof (local temporary edits, restored by hash): removing the claim-fence comparison, the persisted-repair predicate, settlement in the terminal commit, or the grant-enabled check each made its target test fail. Pure ai-service tests 71/71, typecheck, lint and build all exit 0.

### 2026-10-19: Runner integration and crash recovery

Rebased locally onto P1 `89fd611` (P1 itself rebased onto main `8316121`; both patch sets unchanged in range-diff). Fresh owned fixture `4c0ca200-494e-448c-981e-b7c473d34b9e`. The explicit PostgreSQL suite passes **25/25**; the new `recovery.pg.test.ts` adds 7:

- **P2-12:** the existing worker `Runner`, constructed explicitly in the test (no `main`, no Ticker), runs the synthetic job through the fenced `SyntheticJobQueue`: claim, heartbeat, run, acknowledge. One `succeeded` attempt by `runner-p2`; `requested_by` stays the requester, never the system actor; the requester ID, source text and question never appear in Runner logs. `PRODUCTION_JOBS` does not contain the synthetic type.
- **P2-12/P2-17 shutdown:** Runner stop during the draft actor releases the job. The stale observation is refused; a second Runner's claim sees the unknown marker and fails the job dead without replaying the actor (1 draft call total). The next claim holds the run `QUEUE_DEAD` with the full reservation and permit retained.
- **P2-17 crash:** a dedicated child worker process SIGKILLed after a committed `begin` leaves the durable unknown marker; recovery keeps the full reservation. Killed before any `begin`, the run is held with known-zero usage and settles once.
- **P2-18:** SIGKILL after the committed outcome but before queue acknowledgement leaves the job running, then dead; readback returns the same outcome with the same digest, and no second outcome or replay occurs.
- **P2-24:** a checked error after `finish` inside a test-owned transaction, and a connection dropped before COMMIT, both leave no outcome, audit event or settlement (fresh-connection check). The same decision then commits exactly once.
- **P2-25:** the caller destroys its connection immediately after sending COMMIT and sees no response. On this cluster the COMMIT landed (proven by a mutation: with `finish` idempotency removed, the retry is refused). Exact readback returns the outcome, the retried `finish` returns the identical outcome, and actors ran exactly twice.

Lease-expired jobs with `maxAttempts 1` are made dead by the existing `job_claim`; the claim sweep now holds those runs with the generic reason `QUEUE_DEAD` (renamed from `LEASE_EXPIRED`, since a job also dies when the kernel fails it). Additional mutations: removing `finish` idempotency or the dead-job sweep each fails its target tests. Fixture data is seeded only by tests through `test/helpers/durable-pg.ts`; the migration seeds nothing.

### 2026-10-19: time, lock waits, membership boundaries and capacity races

Same local candidate plus one SQL fix. Fresh owned fixture `2c7525ff-9144-49f3-b918-f7cdc2048d36`. The explicit PostgreSQL suite passes **48/48** across 7 files; the 23 new tests are:

- **P2-27 (fix):** the deadline, lease and grant-expiry checks used to run before the membership and source locks, so a step that waited on either lock could commit after expiry. Each worker step now calls `agentic_synthetic_fresh` after its last lock. Four held-lock tests: grant row while the grant expires, membership row while the grant expires, source row while the original deadline passes, and queue row while the lease expires. Each blocks the worker (barrier: `pg_stat_activity` reports a lock wait), lets the expiry pass, releases, and gets the refusal with no state, slot or outcome change.
- **P2-28:** while a scripted actor is paused, no app or worker login has an open transaction and the worker holds no lock. App cancel returns in under 1 s, and the late observation is refused. Positive control in the same test: an open worker transaction is seen by both probes.
- **P2-16:** the original admission time and deadline survive release, reconnect and reclaim. Past 120 s nothing dispatches. A deadline that passes mid-run stops the director dispatch even though the process signal is still live. A database clock earlier than the last guarded decision fails closed, a reclaim never moves that guard back, and the fenced queue release refuses too.
- **P2-07:** with the actual worker login and no request context, membership is bumped or removed before each of the 10 protected boundaries of the accept path. Each boundary refuses `NOT_AUTHORIZED`, no actor is dispatched after the revocation, no outcome or settlement occurs, and app readback and cancel refuse. A control run with the valid version releases.
- **P2-11:** a revocation that commits while `finish` waits on the membership lock denies the finish. A `finish` that holds the lock first commits exactly once; the revocation waits for it, and later readback refuses.
- **P2-20:** four connections racing for one tenant get one permit with no partial job, run or reservation rows. A dispatch with unknown usage keeps its permit through cancel; three more tenants then race for the one remaining fleet slot (one wins), and a fifth is refused with nothing written.

Guard-removal proof (temporary edits, restored by hash, each run with per-test permit isolation):

| Mutant | Tests that fail |
|---|---|
| No fresh recheck | membership-lock and source-lock waits (2) |
| Grant expiry compared with transaction start | membership-lock wait (1) |
| Deadline compared with transaction start | source-lock wait (1) |
| Backward-clock checks removed | backward clock (1) |
| Claim rewinds the guard | backward clock (1) |
| Membership not checked | all 10 P2-07 boundaries, both P2-11 orderings, membership-lock wait (13) |
| Tenant in-flight cap raised to 2 | both P2-20 tests (2) |

### 2026-10-19: leases, fencing and recovery races

Two SQL fixes, found by these tests. The worker login still holds EXECUTE on the shared legacy queue functions, and P2 must not change those shared objects, so both fixes live in the synthetic layer:

- **Stale stamp revival (fixed).** A legacy `job_release` followed by a legacy `job_claim` left the worker ID, queue attempt, `claim_id` and fence all unchanged, so an old stamp's callbacks would have been accepted again. Each run now records the exact existing-queue claim instance (`claim_started_at` = `jobs.started_at`), and `claim_guard` requires it. Known limit: a single transaction that runs the synthetic claim, a legacy release and a legacy claim reuses `now()`; that stays the same worker in the same transaction, not a stale one.
- **Permit leak (fixed).** A legacy `job_succeed` could finish the queue job while the run was still live, and the sweep only handled `dead` jobs. The claim sweep now holds any non-terminal run whose job is `dead`, `succeeded` or `cancelled` (`QUEUE_DEAD`).

Fresh owned fixture `0eebccb4-df4c-4ccc-ae15-49cedd7fedcd`. The explicit PostgreSQL suite passes **57/57** across 8 files; the new `leases.pg.test.ts` adds 9:

- **P2-13:** the legacy release + claim case above. A stamp from an uncommitted claim makes the waiting load see the rollback (`STALE_CLAIM`); the committed claim then runs to one released outcome.
- **P2-14:** after release and reclaim on another connection with the same worker ID and attempt, the old stamp's load, sources, advance, begin, observe, finish, heartbeat, succeed, fail and release all fail. The new claim sees the unknown marker and refuses without calling an actor.
- **P2-15:** an actor reply after lease loss (heartbeat refused) records nothing. An actor that ignores the AbortSignal is not retried. After the jobs die, the sweep holds both runs with the full reservation and permit kept.
- **P2-19:** with real lock ordering in both directions. Finish first: the waiting cancel finds the released outcome and adds nothing. Cancel first: the waiting finish is fenced out. Exactly one outcome and one settlement either way.
- **P2-35:** current and stale `succeed` race on separate connections, and only the current stamp acknowledges. No unfenced fallback for another queue instance or worker ID. A caller-requested retryable failure stays nonretryable (`dead`).
- **Legacy `job_succeed` under a live run:** the next claim holds the run and frees the permit.
- **P2-28 lock order:** five rounds, each racing two finishes, two app cancels and a claim sweep, in alternating issue order, produce no deadlock, lock-timeout or other error, and exactly one outcome per run.

Guard-removal proof (temporary edits, restored by hash):

| Mutant | Tests that fail |
|---|---|
| Claim-instance binding removed | P2-13 legacy release + claim (1) |
| Sweep handles only `dead` | legacy `job_succeed` leak (1) |
| Cancel keeps fence and claim | P2-19 cancel-first, P2-28 paused-actor cancel, existing cancel test (3) |
| Queue control unfenced | 7 tests that use stale queue control (P2-13, P2-14, P2-16 backward clock, P2-19 cancel-first, P2-35, two lifecycle tests) |

### 2026-10-19: budget accounting

Fresh owned fixture `1d8d0531-31cb-46e7-a5b7-1ccb592e212e`. The explicit PostgreSQL suite passes **63/63** across 9 files; the new `budgets-accounting.pg.test.ts` adds 6. One kernel change: with no observation, the kernel now records no artifact, so the refusal is `USAGE_UNKNOWN` instead of `INVALID_INPUT`. The accounting was already conservative; only the reported reason was wrong.

- **P2-21:** these direct SQL observations are refused `INVALID_INPUT` with nothing charged: over the per-role maximum (draft 4097 input, 769 generated), negative, fractional, 10-digit, string-typed, missing or extra keys, 2^53+1 and `0.0` sent as exact JSON text, array, string and number. The exact draft maximum is accepted; an exact repeat is idempotent; any change is `INVALID_EVIDENCE`. Four maximal slots observe exactly 28160 and settle the full 250000 once.
- **P2-22:** a missing observation keeps the full reservation and the permit across reconnect, lease expiry and the dead sweep (held, unsettled, one permit in flight).
- **P2-23:** a run re-dated to the last day of the previous month settles its full cost to those original day and month buckets. The current period stays empty, and the same tenant's next run reserves only in the current period.
- **P2-36:** reserved + consumed + 250000 equal to the limit is admitted; one unit more is refused with no run written. A second settlement of the same run raises the invariant error and charges nothing. A missing capacity row refuses admission (`CAPACITY_REFUSED`), and the fixed limits cannot be changed or made NULL.

Guard-removal proof:

| Mutant | Tests that fail |
|---|---|
| Draft per-role bound removed | P2-21 malformed and over-bound (1) |
| Settlement charged to today's buckets | P2-23 (1) |
| Exact remaining budget refused (`>=`) | P2-36 edge (1) |
| Settlement allowed twice | P2-36 edge (1) |

### 2026-10-19: digest parity and the attempt-two matrix

One SQL fix. Admission sorted sources by the database's default collation, and that order is part of the evidence preimage. On a non-C database (most managed PostgreSQL defaults), or after an OS collation update, the same sources could produce a different digest, and an exact repeat request would be refused. The sort is now `COLLATE "C"` (byte order). The owned fixture is initialised `--locale=C`, so the test simulates the risk by switching the source column to ICU `en-US-x-icu`.

The explicit PostgreSQL suite passes **68/68** across 10 files; the new `digests-repair.pg.test.ts` adds 5:

- **Golden vectors:** a Spanish request with quotes, backslash, slash, newline, tab, U+0001, DEL, U+2028, an astral emoji and a combining accent. Sources have escaped ids and versions. The SQL request and evidence preimages, the TypeScript `JSON.stringify` output and a hand-written expected string are byte-identical; digests match. The SQL draft input digest equals the TypeScript one, and the run releases end to end.
- **NUL and lone surrogates:** refused `INVALID_INPUT` by the adapter. Sent as raw JSON to the SQL function, the parameter cast itself errors (SQLSTATE class 22) and no run is written.
- **Attempt-two matrix:** a verdict with swapped evidence or candidate digest is refused. `begin(draft,2)` is refused while reviewing and in repair-pending, and with attempt-1, wrong-run or wrong-evidence input digests, a stale fence or a stale sequence. The exact `begin(draft,2)` succeeds once; a duplicate is refused. A NUL in a terminal proposal errors at the cast with no outcome.
- **Changed source after the persisted repair:** the kernel is refused `SOURCE_UNAVAILABLE` at repair-pending, with exactly two actor calls and no outcome.
- **Byte order under a locale collation:** with the column on ICU (where `a` sorts before `B`), the evidence preimage still matches the byte-order golden.

Guard-removal proof:

| Mutant | Tests that fail |
|---|---|
| `COLLATE "C"` removed | byte order under ICU (1) |
| `begin` input-digest check removed | attempt-two matrix (1) |

### 2026-10-19: boundaries, schema and roles

No product code changed. **75 → 76** unit tests and **72/72** PostgreSQL tests across 11 files.

- **P2-01:** the root entry's full import graph (subdirectories included; the P1 check scans only top-level `src/*.ts`) reaches only `src/`, `zod` and `node:crypto`. P2 changed two P1 files: `package.json` (the jobs dependency, `pg` dev dependencies and test scripts) and the P1 boundary test's allowlist that pins them. `src/` is unchanged from P1.
- **P2-02:** durable modules import only an allowlist (`zod`, `node:crypto`, `@telesphoros/jobs`, two P1 modules and each other) and use no `process`, network, timer, `globalThis` or dynamic import. Importing all five and building the job starts no timer, request or environment read. **Open decision:** the spec's inert *subpath export* is not added. The package still exports only `.`, which is stricter, and adding one is an owner choice.
- **P2-03:** every `JobQueue` method is fenced by `SyntheticJobQueue` except `stats` and `workerSeen` (read-only bookkeeping). A new shared queue method fails the test until it is reviewed.
- **P2-29:** none of the app, worker, verifier, operator or auditor logins is superuser, bypasses RLS or can create roles or databases. Each gets `42501` on SELECT and DELETE of all ten synthetic tables. Only app (3) and worker (8) hold synthetic EXECUTE. The tables are owned by NOLOGIN `telesphoros_jobs`.
- **P2-30:** temp shadow tables named `jobs`, `tenants`, `tenant_memberships`, `agentic_synthetic_runs` and `agentic_synthetic_grants` (proven live for unqualified names), plus a spoofed worker tenant setting, change nothing `load` returns. The spoofed setting is restored afterwards. An app tenant or actor setting that disagrees with the caller is refused. Every synthetic function body schema-qualifies its calls and tables (scanner with positive control).
- **P2-32/P2-34:** a full catalog snapshot (relations, columns and collations, functions with ACL, config and source hash, triggers, policies, constraints, schema ACL) taken after down shows 0028 changes only its own objects. The one exception is documented: `EXECUTE` on the shared `membership_assert_current` for `telesphoros_jobs`, which down revokes. Up after down restores the catalog exactly. The whole attempt, rolled back, leaves nothing. No synthetic schedule or job exists after migration.
- **P2-33:** the durable suite refuses (`OWNED_PG_CONFIG_REQUIRED`) with no manifest, and with a manifest outside the owned control directory plus an ambient URL. The controller's own refusal tests run in the gate.

Guard-removal proof: a timer in `durable/job.ts` (both P2-02 tests), a root export of a durable module (P2-01), the queue's `release` override removed (P2-03), the fixture's manifest check removed (P2-33), down keeping the shared grant (P2-32/34), one unqualified helper call (the qualification scan and 34 runtime tests), and direct worker SELECT on runs (P2-29). Each failed its target.

**Dependency-tree finding:** `p2-local`'s root, backend and jobs `node_modules` were symlinks (created 09:11) into the P1 worktree, so earlier "fresh" P2 installs wrote into P1's tree. P2's lockfile only adds packages, and P1's store still holds the same 838 entries, but the two worktrees were not independent. `p2-local` now has its own real install; P1's tree was not modified by the fix.

### 2026-10-19: P2-38 local delivery gate

**Verdict: PASS** on candidate `4113a95` (base P1 `89fd611`), fixture `1d8d0531-31cb-46e7-a5b7-1ccb592e212e`, with `p2-local`'s own dependency install. Native outputs stay in the owned evidence directory (`gate-e9afa89e….json`, mode 0600). Every producer exited 0:

| Producer | Result |
|---|---|
| Candidate clean | `git status` empty |
| Diff allowlist | 33 files, all under ai-service `durable/`, `test/`, package/tsconfig/durable config, 0028 up/down, the two P2 docs, lockfile |
| Lockfile allowlist | +9/−0 lines, the ai-service importer only (`@telesphoros/jobs`, `pg`, `@types/pg`) |
| Runner = lockfile | vitest 5.0.3 = 5.0.3; no shared `node_modules` |
| ai-service test, typecheck, lint, build | 76/76; 0; 0; 0 |
| Root bundle isolated | no synthetic, jobs, `pg` or durable reference in `dist/index.{js,cjs}` |
| jobs, worker, workspace orchestration | 13/13, 49/49, pass |
| Fixture controller self-test | 6/6 |
| Durable PostgreSQL suite | 72/72 across 11 files |
| Migrate smoke | exit 0 |
| Migration seeds nothing | 0 INSERT/COPY outside function bodies; planted control detected |

The gate can go red: with one stray untracked file it reported FAIL (candidate-clean, plus the durable file allowlist test).

**P2-37 guard sweep on this exact candidate:** 26 one-at-a-time mutants, each restored by hash. 25 fail their target tests. Mutants: claim fence; claim-instance binding; queue-control fencing; cancel fence; repair predicate; settlement; grant-enabled; membership; fresh recheck and its two transaction-start variants; backward clock; guard rewind; dead-only sweep; draft bound; settle-to-today; exact budget edge; settle twice; tenant cap; byte order; begin input digest; down keeping the shared grant; unqualified call; worker SELECT. **Not red: removing the reservation/bucket row locks in `lock_accounts`.** Every reserving or settling writer already holds the capacity singleton lock, and `begin`/`observe` serialize on the run row, so that lock is redundant defense in depth and no test can fail on its removal alone.

Not covered by this gate: the hosted CI and preview workflows (local-only by approval); the inert subpath export (open owner decision); and unforgeable session authority, which is the activation blocker and needs its own design.
