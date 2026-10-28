# Fix: a write refused for its role leaves an access-audit row (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (A2).

**The problem.**
- `RolesGuard` recorded a refusal only for a GET. Guards run before interceptors, so the interceptor that records a `private-write` row never ran for a refused write.
- A reader's POST, PUT, PATCH or DELETE left only `api-auth accepted`, so privilege probing on write routes left no trace. The runbook listed this as a gap and said such refusals went to `access.refused`, but that event covers only membership refusals.
- Recording the refusal in the guard alone is not enough: 0037's CHECK allows `private-write` only as `accepted`, so on PostgreSQL the row is refused and the request answers 503 instead of 403. The in-memory store has no CHECK, so every memory-tier test stays green.

**The fix.**
- The guard records `private-write` `refused` for a refused POST, PUT, PATCH or DELETE, with the route and the opaque path id (`writeEvent`, now taking an outcome). Never a body, field or value. HEAD and OPTIONS still record nothing; refused reads are unchanged.
- Migration 0052 widens `security_audit_kind` to allow `refused`, added NOT VALID as 0037 did; 0053 validates it without blocking writers. 0052 is labelled breaking only because the lint treats any DROP as such: a release that includes it is a breaking release (an outage window).
- 0052's down refuses while refused-write rows exist unless `telesphoros.allow_audit_drop=yes`; with it, 0037's CHECK goes back NOT VALID and the rows stay as evidence.
- `docs/ops/application-access-audit.md` describes the new outcome and corrects the membership note.

**The tests.**
- `security-audit.pg-spec.ts`: a reader's POST and DELETE answer 403 and leave `private-write` `refused` with the route and path id, and no label. Red before the change (no row); with the guard change but without 0052 it answered 503, as predicted.
- The CHECK test now accepts `refused` and still rejects `succeeded`. A new test proves 0052's down refuses with evidence, reverts only with the setting, and leaves the old CHECK NOT VALID.
- `roles.guard.spec.ts` (new): each write method, GET unchanged, HEAD and OPTIONS record nothing, an allowed write records nothing in the guard.
- Breaking the down guard or removing the guard's new branch turns these tests red.
- Three specs pinned 0051 as the newest migration (`down-guards-as-migrator`, `evaluation-requests`) or a fixed revert count (`migrations.pg-spec`). They now ask `test/helpers/migration-history.ts`, so the next migration needs no edit there.

Not verified in AWS.
