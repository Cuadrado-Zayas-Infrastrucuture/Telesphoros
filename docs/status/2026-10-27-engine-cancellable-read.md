# Feature: a cancellable evaluation read (H2, local)

Date: 2026-10-27

H2 of the engine harness sequence, after H1 (durable admission, PR 80). Before this change a reader could not be told to stop: the worker's runner abandons a handler that ignores its abort signal when the timeout passes, and `ReportReader.read(text)` took no signal, so an abandoned evaluation could still read, hold a reader slot and store a result.

Changed: `ReportReader.read` takes an optional `{ signal }`. A cancelled read rejects with the signal's reason, never a `held` result (cancelling is the caller's decision, not a fact about the text). `SubprocessReportReader` never spawns for a signal that is already aborted, and on abort stops the process group the way the deadline does (SIGTERM, then SIGKILL after the grace period); the read settles on `close`, so only after the process has exited, and the `ReaderLimiter` slot is freed only then. `EvaluationsService.create` takes the same option: it takes no slot when already cancelled, passes the signal to the reader, and checks it again before storing, so a reader that ignores the signal and answers late stores nothing.

Proved, with a check that goes red when its guard is removed: no spawn when already cancelled; the whole tree (a shell that ignores SIGTERM and its grandchild) is gone when the read settles; the slot is still held inside the kill grace and free after; on real PostgreSQL (migrations, row-level security, the real ledger repository) with public fixture D01, a reader that ignores the signal and answers late stores nothing, a cancelled request can be made again and is then stored, and an already-cancelled one never reads (the last two tests fail on the code before this change). Settling on abort instead of on `close` returned early and left the process tree running (two processes stayed alive after the test run).

Not changed: the synchronous endpoint passes no signal, so its behaviour, status codes and held results are as before; clinical rules, holds and the D01 to D12 goldens; the H1 schema; the worker runner; the reader engine. The goldens and the real-engine specs need the engine, which is not in the public checkout: they were skipped (announced as ENGINE ABSENT), so this change is verified with stand-in commands only. Wiring a job handler's signal to `create` belongs to H3.

Local only until the pull request is opened.
