# Planned: what must close before tenant binding moves to `capability` (DATA-01 slice 5)

Date: 2026-10-29

The move is spec 001's slice 5 (`specs/001-tenant-capability/plan.md`), gated by D4, D7 (seven days of synthetic staging with no capability-less request) and D8 (residual risks accepted in writing). Nothing here changes those gates or the mode, which stays `dual`.

- `specs/001-tenant-capability/tasks.md` gains a "Slice 5 readiness" list (R1 to R6) from a read-only inventory of `main` `f4f74dc`: the restore isolation check (already T029 and T031), the agentic synthetic member function that still writes the tenant setting (no task yet), the worker and API issuer settings that D7's window needs, the ai-service durable store (not determined), and the specs that pin `dual`.
- Paths that need no capability are listed beside it, so the list can be checked for gaps.
