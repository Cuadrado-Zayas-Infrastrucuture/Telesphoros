# Fix: a refusal made after the request's capability expired is recorded as that person, in every binding mode (local)

Date: 2026-10-29

Spec 015 ([specs/015-security-event-grace](../../specs/015-security-event-grace/spec.md), founder decisions D1 to D3 as recommended). It closes the `capability`-mode half of audit A3 that [2026-10-28-security-event-expired-capability.md](2026-10-28-security-event-expired-capability.md) left open.

**The problem.**
- A request's capability lasts 60 seconds, but an upload can run for minutes, so some refusals (`timeout`, `slow`, `authority-changed` at commit) are recorded after it has expired.
- In `dual` mode #127 dropped the expired capability and the database fell back to the application's settings.
- In `capability` mode there is no fallback: the write was refused with `42501` and the event was lost (logged at `error`).

**The fix.**
- Migration 0058 adds `security_event_capability()`, the event writer's own check. It accepts a capability that is not revoked and expired no more than 5 minutes ago (D1), checks no organization status (as `app_tenant_bound()`), and returns nothing when the settings name another organization. Without a capability it falls back to the settings in `guc` and `dual` only. Only the owner of `security_event_append` may call it.
- `security_event_append` takes the organization and person from it. The migration restates the function from its live definition and refuses to run if that is not the one 0047 left; the down file restores it and drops the new function.
- `Database.appendSecurityEvent` (D2; `recordSecurityEvent` was already the access-audit writer) runs that one statement with the request's capability bound even when expired. `withTenant` still refuses every other transaction under an expired capability (#114).
- `PostgresSecurityEvents` uses it; `withoutExpiredCapability` is removed. In `dual` mode a refusal under a capability is now attributed from the capability, not the settings (D3).

**Not changed.** `app_tenant_bound()`, `app_actor()`, every policy, the other repointed functions, the sweep, the issuer, capability lifetimes and the binding mode (`dual`).

**The tests.** `test/db/security-event-grace.pg-spec.ts`, in `dual` and `capability` mode:
- a refusal under a capability expired 2 minutes ago is recorded for its organization and person, also when the settings name another person;
- one expired 6 minutes ago, a revoked one, and one with settings naming another organization are refused (`42501`); with no capability `capability` mode refuses;
- within the window a read of `patients` and `tenant_memberships` returns no rows (a valid capability reads the patient, the control);
- a refusal under a valid capability is recorded once and a second within the minute is throttled;
- the grace may not outlast the sweep's retention, read from both live definitions, with a 10-minute control.

Red before the change in `capability` mode (the app path logged `security-event-not-recorded`) and at the database level in both modes. With the migration's grace set to 10 minutes the guard and both 6-minute checks went red. Not verified in AWS.
