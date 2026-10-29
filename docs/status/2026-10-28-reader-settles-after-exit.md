# Fix: a report read settles once its process has exited, even if a descendant holds the output open (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (O2).

**The problem.**
- `SubprocessReportReader` settled a read only on the child's `'close'` event, which waits for the pipes as well as the exit.
- The deadline and cancellation kill the whole process group. A descendant that left the group (`setsid`) is out of reach of that kill; if it kept stdout open, `'close'` never came, the read never settled, and its `ReaderLimiter` slot was never freed. With every slot taken, every evaluation is refused.
- Reproduced with a stand-in command: the read hung past the test's 15 s timeout, with a 30 s deadline.

**The fix** (`apps/backend/src/services/report-reader/subprocess-report-reader.ts`).
- After `'exit'`, once the pipes have been silent for one kill grace (default 1 s) without `'close'`, the read stops reading, kills what is left of the group, and fails as `worker-error` with cause `output-held-open` (logged as `report-reader-failure`, no text).
- Every chunk that still drains after the exit restarts that wait, so a slow pipe is not mistaken for one held open.
- By decision, the output is discarded even after a clean exit: a reader that left a process behind is not trusted.

**Not changed.** A process that has not exited keeps its slot (the cancel test), and so does one that never exits even after SIGKILL. The deadline, the group kill, the output and stderr limits, result parsing, the limiter and the Python sidecar.

**The tests** (`subprocess-report-reader.wrapper.spec.ts`).
- An escaped grandchild holds stdout and the child exits 0: the read settles in under 5 s, held as `worker-error`, logged `output-held-open`. It hung before the fix.
- Control: an escaped grandchild writes for about a second and then closes the pipe: the read waits for `'close'` (at least 900 ms) and fails on the output, not as `output-held-open`. With the re-arm on drained chunks removed, it settled at 352 ms and went red.
- The tests kill only the processes they started, by recorded pid, in `afterEach`.
- Reader and limiter specs 36 of 36. The whole backend suite on PostgreSQL 16 and Moto: 252 suites passed, 0 failed, 2 skipped (`local-storage-bounds`, `local-storage-cleanup`, which skip under `TEST_STORAGE=postgres`); 3338 tests.

- With the real engine: the report-reader engine is not in this checkout, and CI runs without it. The branch was exported to a scratch directory with the private clone's `knowledge/lab-report-reader/v2-handoff` and `sidecars/report-reader` copied in (read only, deleted afterwards), on Node 22.22.0. `subprocess-report-reader.spec.ts` (the real engine through the real sidecar, D01 to D12, packets from the pinned reader) passed 46 of 46, with no read failing as `output-held-open`: the engine's worker does not outlive the CLI. The reader, limiter, cancel and checkpoint specs passed too. Two `handoff-import.spec.ts` checks failed only because of the export (not a Git repository; `knowledge/lab-report-reader/README.md` not copied).

**Not verified.** Not in AWS.
