# Fix: a refusal made after the request's capability expired is still recorded (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (A3, the security-events half; the read half was fixed in #114).

**The problem.**
- `PostgresSecurityEvents` writes a refusal as organization work, which keeps the request's capability (at most 60 seconds).
- If the refusal came after that capability had expired, the write was refused with 503 (#114). Before #114 the database resolved no organization and `security_event_append` raised. Either way the error was caught and only logged at `warn`, and the event was lost.
- Where it can happen: an intake rejected as `timeout` or `slow` after a long upload, or the `authority-changed` refusal of a long write at commit.
- Latent today: the issuer is behind `enable_issuer` (default false), so requests carry no capability.

**The fix.**
- `withoutExpiredCapability` (`auth/authority-context.ts`) runs its work without the request's capability once it has expired, and changes nothing otherwise. Only `PostgresSecurityEvents` uses it.
- Without a capability the database binds the organization that `withTenant` names in the `guc` and `dual` modes (`app_tenant_bound()`, 0047), the same as other work without one. The database is in `dual` (0032). The transaction is counted as missing, with reason `expired`.
- An event that still cannot be recorded is logged at `error`, not `warn`.

**Not changed.** The 503 for every other transaction under an expired capability (#114). `asOrganizationWork`, which keeps the capability on purpose for cleanup and sweep work. The SQL functions and the binding mode.

**Open, then closed by spec 015.** In the `capability` binding mode, a transaction with no capability resolves no organization, so such an event would still be lost (logged at `error`). Spec 015 closes it: the event writer accepts a recently expired capability, and `withoutExpiredCapability` is gone ([2026-10-29-security-event-grace.md](2026-10-29-security-event-grace.md)).

**The tests.** `test/db/security-event-expired-capability.pg-spec.ts`:
- a refusal under a valid capability is recorded and the capability is bound (the control);
- a refusal after the capability expired is recorded and counted as `expired`.

Red before the fix (0 rows), and red again with the wrapper removed. Not verified in AWS.
