# L3 owned synthetic storage operations

This runtime provides a separate storage-only demonstration. It uses Node 22, PostgreSQL 16, Moto **5.2.3**, the existing fake identity provider, and L2's browser build. It accepts only synthetic data. Clinical processing stays disabled. It does not call AWS or make a production-readiness claim.

## Start and verify

Install the repository dependencies and the pinned local runtimes. `LOCAL_PG_BIN` must name an absolute PostgreSQL binary directory; `MOTO_SERVER` must name the absolute Moto executable in its Python environment. `lsof` and `ps` must be available. On macOS, set `CHROMIUM_PATH` to the installed Playwright Chromium binary for rehearsal.

```sh
pnpm demo:storage:build
pnpm demo:storage
```

The foreground launcher reports the generated run UUID and browser address. The fixed loopback ports are PostgreSQL 54481, Moto 5557, API 3010, IDP 4010, and browser 4173. An occupied port is a refusal; the runner never stops a process by its port. The review runner can share some port numbers but cannot run concurrently; it is never reset or stopped by this runner.

Each invocation creates a new private `.local-storage/runs/<UUID>/` directory and an independent control receipt under `.local-storage/control/`. PostgreSQL owns its **own cluster**, database and roles inside that run, with loopback trust authentication for disposable synthetic use. The API uses a non-owner `storage_app` login without superuser, role/database creation, or RLS bypass. Migrations and the protected-evidence inventory use the separate owned-cluster administrative identity. The fake personas upload in tenant `alpha`; reader `bob` belongs to `beta`.

The runner rejects inherited production mode, enabled clinical processing, and overrides of Moto's multipart minimum. It passes an explicit child environment and dummy storage credentials, with metadata credential lookup disabled. `MOTO_DISABLE_GLOBAL_CORS=true` is set in that environment so Moto cannot use its global Flask fallback to admit an origin excluded by the bucket's policy. API/IDP/web/Moto/PostgreSQL bind only to `127.0.0.1`. Service readiness checks require a matching recorded listener PID before contacting the endpoint. It does not reuse an existing database or emulator.

The GET-only shared download policy is a separate local F07 fix and is not part of this main-based launcher-control branch. Until F07 is merged and integrated, this runner and the older review launcher retain the bucket methods declared on main. Disabling Moto's global fallback does not prove S3 method enforcement; verify actual policy readback and browser GET/PUT controls separately. See [launcher verification](../verification/local-launcher-cors.md).

```sh
pnpm test:storage-ops
pnpm test:storage-recovery
pnpm test:storage-rehearsal
```

The operations command tests ownership refusals and controlled scheduling. The full rehearsal requires all real local dependencies; it fails rather than skipping them. It runs L2 browser assertions against the L3-owned stack, explicit multipart and HTTP faults, actual writer crash/restart, clock checks, and full setup/teardown/restart acceptance. It saves aggregate JSON in `.local-storage/rehearsal.json` and private browser diagnostics beside it. `L3_EVIDENCE` can select another evidence file. Do not publish private logs without checking their contents.

`test:storage-recovery` is the targeted native regression, also included in the full rehearsal. It runs the foreground launcher and checks failed status persistence, admission close/reopen, lock-coordinated maintenance, repeated restart commands and normal shutdown. It fails on missing dependencies and saves `.local-storage/recovery.json`; `L3_RECOVERY_EVIDENCE` selects another evidence file. Hosted CI runs the operations unit controls; these native lifecycle checks remain local-only.

## Reconciliation and recovery

Startup measures host, PostgreSQL `clock_timestamp()`, and the owned Moto HTTP Date (native process, same host clock). Timing-sensitive startup refuses clock skew or measurement duration over five seconds. No provider clock is changed. A separate test clock exercises the exact lease/grace boundary; monotonic intake deadlines remain independent.

Before accepting traffic, the API worker runs the existing `LocalUploadCleanup` operations library using the owned receipt and complete existing catalogue inventory across tenants, including soft-deleted pins and text references. The ordinary policy remains one-hour lease plus 24-hour grace. Safely cancelled attempts retain the existing prompt-cleanup semantics. The worker schedules another non-overlapping sweep every 15 minutes after completion. It records bounded aggregate outcomes; failures preserve the durable stalled-admission state, close the API listener (including failures before the database can be reached), and are retried on the next interval. The listener reopens only after an affirmative reconciliation. An unknown or unavailable inventory never authorizes deletion.

The success outcome must be durably written before admission opens. A status-write or directory-sync failure closes the actual API listener even if database reconciliation succeeded; retry requires a durable success. Failed atomic writes remove only their own exclusive temporary and preserve the destination. The foreground health monitor acquires the operations lock before reading manifests or checking PIDs, defers to a live maintenance holder, and checks health again after release. Lock publication exposes a complete receipt, never an empty file.

Intake staging uses a separate private `stage/` directory; browser/compiler caches use `tmp/`. Restart reconciliation checks each staging receipt and retains live writers or unexpected entries. It removes a dead writer's owned staging only after receipt validation. Journal eligibility still uses authoritative database time and the existing grace checks.

```sh
node scripts/local-storage/start.cjs sweep <run-UUID>
node scripts/local-storage/start.cjs restart-api <run-UUID>
pnpm demo:storage:teardown <run-UUID>
```

`sweep` signals only the verified API worker and waits for a new recorded reconciliation outcome. It exposes no HTTP operations endpoint. `restart-api` stops only the recorded API worker, reconciles before reopening its listener, and keeps the owned database/Moto intact. SIGINT/SIGTERM on the foreground launcher quiesce and tear down the run. A killed launcher leaves durable process receipts; use the explicit teardown command, then start a **new UUID**. The launcher monitors worker health and cleans up on an unexpected worker exit. Cleanup has bounded stop deadlines and returns failure with retained resources if ownership or residual-resource checks fail. Never repair this by killing a port or deleting a name prefix.

## Written teardown blast-radius check

Before any teardown, setup writes `blast-radius.md` inside that exact run, identifying its directory, ports, database, role and bucket. Inspect that record when operating an existing run.

- **Loss:** every synthetic byte, metadata row, simulated IAM identity/policy/credential, object version, incomplete multipart upload, cache and staging file belonging to that run.
- **Boundary:** the run's private directory and matching receipted process identities. Both the manifest and independent control copy, directory inode/owner/mode, process start identity and complete filesystem preflight must agree. Unexpected root entries and symlinks refuse before the first signal.
- **Order:** close API intake and sweep work; stop web/IDP; stop the owned Moto and PostgreSQL processes; check ports and filesystem; remove only the exact run directory. Removing the private cluster removes its database and roles without issuing DROP against any shared cluster.
- **Recovery:** fresh setup and the inert synthetic fixtures recreate the demonstration. The control tombstone and aggregate evidence remain outside the removal boundary. Repeated completed teardown is harmless.
- **Protected:** existing review/clinical services, shared clusters/emulators, foreign processes/ports/sentinels, production data, AWS, and all other directories. A refusal retains resources and requires inspection, never a broad cleanup fallback.

This full-stack disposal is intentionally different from an orphan sweep: sweeps preserve committed pins; explicit disposal destroys the complete disposable run after ownership verification.

## Multipart and emulator limits

The browser still uses L1's validated single PUT. The rehearsal's **test-only writer** first calls the existing streaming validator, then explicitly assembles a 6 MiB inert file from a 5 MiB part and a 1 MiB final part. Part ETags are assembly identifiers only. Full-file SHA-256, size, MIME, version and revision-bound pinning are checked through the existing repository and authenticated API resume/download paths. No browser multipart credentials or production multipart service is introduced.

Fault evidence distinguishes rejection by Moto from refusal by application verification. It includes out-of-order arrival, replacement/retry, missing part, wrong ETag, undersized non-final part, reordered/truncated content, over-limit assembly, lost completion/abort reply, unknown receipt, newer version and interrupted writer. Full disposal seeds simulated IAM/policy/credential, bucket-policy, object and incomplete-upload state and checks a fresh emulator for inheritance.

**Observed limitation:** Moto 5.2.3 can serve a signed URL after its expiry. The rehearsal records the actual HTTP status and flags an emulator gap rather than passing provider expiry. Empty simulated IAM state after restart is state-disposal evidence, not an AWS authorization or custody proof. G01, AWS, deployment and real-record approvals remain separate.
