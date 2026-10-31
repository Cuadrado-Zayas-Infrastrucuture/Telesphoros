# Expired capabilities are removed, by the worker, every minute

Date: 2026-10-31

**Implemented (spec 026, PR A).** Migration 0065 adds `capabilities_sweep_run(p_limit)`, owned by the queue's definer role and executable by the
worker login only. It calls the existing `tenant_capabilities_sweep` (0028, unchanged, with its five-minute retention) and returns how many rows it removed
and whether a full batch was removed. The worker runs it on its own timer, every `WORKER_CAPABILITY_SWEEP_SECONDS` (60) with a batch of
`WORKER_CAPABILITY_SWEEP_LIMIT` (1000), and logs every run: `capability-sweep-ran` (`count`, `outcome` `behind` or `current`) and
`capability-sweep-failed`. `provision-logins` checks that the worker can run the caller and still cannot run the sweep itself.

**One change from the plan.** The plan computed `behind` by checking for rows still past the retention. The function's owner can run the sweep but cannot
read the capability table, so `behind` means "a full batch was removed" instead: at worst one run says `behind` when exactly a batch was left, and the next
says `current`. No privilege was added.

**Not established.**
- The alarms (failing, stale, behind) are PR B. Until they are applied, a stopped sweep reaches no one.
- The staging backlog has not been measured (D5); it is read once, read-only, before the release.
- Nothing is released or migrated in any environment.
