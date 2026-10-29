# Implementation Plan: a refusal made after the request's capability expired is still recorded, as that person

**Spec**: [spec.md](spec.md)

**Status**: Approved by the founder on 2026-10-29, D1 to D3 as recommended: a 5-minute grace, a narrow `Database.recordSecurityEvent`, and `dual` attributed from the capability.

## Summary

One migration gives `security_event_append` its own capability check, which accepts a capability that is not revoked and expired no more than five minutes ago. The function reads the organization and person from that check instead of `app_tenant_bound()` and `app_actor()`. The application stops stripping an expired capability before recording an event. Nothing else in the database or the application sees the grace.

## Technical Context

- PostgreSQL 16, row-level security, `tenant_binding_mode` `dual` today (0032).
- The function's body today: 0032 defines it with `public.app_tenant()` and `public.app_actor()`; 0047 repoints `app_tenant()` to `app_tenant_bound()` by rewriting the live definition (`0047:88-100`). The live body is read with `pg_get_functiondef` at build time, not from the migration text.
- The capability row is kept until the sweep removes it, five minutes after it expires (`0028:228-246`).
- Tests: `test/db/*.pg-spec.ts` on an ephemeral database, with the issuer login minting capabilities (`test/db/security-event-expired-capability.pg-spec.ts` is the model).

## Constitution Check

- Synthetic data only; no clinical logic; no real data.
- One migration with a down file, run on PostgreSQL as the non-superuser migrator.
- Fail closed: a capability the function cannot check records nothing, as today.

## Design

### The migration (next free number at build time)

- A new function `security_event_capability()` returning `(tenant_id, sub)`, `SECURITY DEFINER`, owned like `app_tenant_bound()`, executable by nobody but the owner of `security_event_append`:
  - no capability: in `guc` or `dual`, the settings, as `app_tenant_bound()` and `app_actor()` do today; in `capability`, nothing;
  - a capability: the row whose `token_hash` matches, `revoked_at IS NULL`, and `expires_at > statement_timestamp() - interval '5 minutes'`; nothing if the settings name another organization;
  - no check of the organization's status, like `app_tenant_bound()`: 0047 points this function at the bound form on purpose, so a suspended organization's refusal is still recorded (`0047:9-15`).
- `security_event_append` is replaced from its live definition, with its two lookups swapped for the new function, and refuses if the definition is not the expected one (as 0047 does).
- The down file restores the definition read before the change.

### The application (FR-004)

- `PostgresSecurityEvents` calls `asOrganizationWork(() => this.append(...))` again, without `withoutExpiredCapability`. That helper stays for now if anything else uses it; nothing else does today, so it is removed with its test.
- `Database.withTenant` refuses an expired capability with 503 (#114). Recording an event must not be refused, so the event path needs a way past that check that carries the expired capability into the transaction. The plan is a narrow `Database.recordSecurityEvent(tenantId, actor, sql, params)` that binds the capability even when expired and runs only the one statement. Decision D2.

### The guard (FR-003)

- A database spec reads the grace interval from the function's definition and the sweep's retention from its definition, and fails if the grace is longer. A control replaces the grace with 10 minutes and must be reported.

## Founder decisions (only the founder can make these)

- **D1: the grace window.** Recommended: 5 minutes, the sweep's retention, which also covers Node's default 300 s request timeout. Shorter keeps less residual power and loses refusals from the slowest requests.
- **D2: how the event write gets past `withTenant`'s expiry refusal.** Recommended: a narrow `recordSecurityEvent` on `Database`, used only by `PostgresSecurityEvents`, rather than an option on `withTenant` that other callers could pass.
- **D3: `dual` mode attribution.** Recommended: from the capability (FR-004), so `dual` behaves as `capability` will. The alternative keeps #127's fallback to the settings in `dual`.

## Not touched by this plan or its PRs

`app_tenant_bound()`, `app_actor()`, every policy, the other three repointed functions, the issuer, spec 012's job capability, capability lifetimes, the sweep, and the binding mode itself.

## Notes for whoever builds it

- Read the live function with `pg_get_functiondef`, not the migration text: 0047 rewrote it in place, and a search for `FUNCTION security_event_append` misses the `public.` form (2026-10-29).
- Run the refuse-if-unexpected guard as the migrator, not a superuser.
- Re-check the migration number against `main`, open pull requests and other worktrees right before the push.

## Complexity Tracking

None: one function, one replaced function, one narrow application path.
