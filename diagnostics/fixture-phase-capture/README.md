# One-job fixture phase capture

This is a temporary diagnostic branch. Do not merge this workflow or treat its result as a PR acceptance check.

Local preparation is authorized. **Publishing is not authorized:** the first push creating
`chore/native-x64-fixture-capture-20261018` starts its one native x64 job. The exact branch
filter, `event.created` check and attempt-1 guard suppress later pushes and reruns. No PR,
main change, AWS credentials, deployment or timeout increase is required.

The workflow copies the existing memory job's bootstrap/setup and invokes the original
`runProducer` with its unchanged full pnpm command. The 30-minute shared deadline, global
watchdog, per-step watchdog, default five-second hook deadline and all tests stay intact.
The new commit is the run identity; source hashes and a depth-2 checkout prove application,
dependency and original CI code still match baseline `37d1e96` (also equal to failing #168).

The preload adds one setup module in memory. It does not edit the backend configuration.
The setup observer reuses the prototype/timing approach from the completed local workload,
and the existing offsite observer's descriptor-preserving export clone. It records fixture
and actor operation starts, four-second active phases, migration IDs, CPU/heap, GC and event
loop delay. An independent process records PostgreSQL backend IDs, wait classes, blockers
and checkpoint counters. Nested phase durations overlap; do not sum them.

Records contain fixed phases and numeric counters, never SQL, arguments, connection strings,
environment dumps or error messages. They stream to the job log and to bounded files.
The final verifier checks source/run identity, full selection/order, native status, observer
registration and monitor health. A failed test remains a failed job even when its trace is
complete. Missing/incomplete evidence cannot qualify as a pass. Bounded partial evidence
remains uploadable when verification fails; hard cancellation can prevent the final upload,
so the already-streamed starts are also needed. Artifact retention is one day, target <10MiB.

Before publishing, run with Node 22.22.0:

```sh
node --test diagnostics/fixture-phase-capture/*.test.cjs diagnostics/fixture-phase-capture/*.test.mjs
node diagnostics/fixture-phase-capture/verify-workflow.mjs
node --test .github/ci/*.test.mjs
actionlint .github/workflows/fixture-phase-capture.yml
git diff --check
```

Offline controls use disposable synthetic directories/child processes only. Their deletion
loses no source or archived evidence and can be recovered by rerunning the controls.
They cover rejected promises, callback/class identity, the unchanged four-second probe,
sampler shutdown, no payload serialization, native failure preservation, source/selection
fences and the one-job trigger. They do not establish native CI runtime performance.

After local review, obtain separate approval for the concrete push and a single-run budget
(expected 10–15 runner-minutes, about $0.06–$0.09 over quota; existing timeout 30 minutes).
Do not run automatic retries. Preserve downloaded evidence before any later cleanup.
The original setup-timeout cause remains unproven until the native trace identifies it.
