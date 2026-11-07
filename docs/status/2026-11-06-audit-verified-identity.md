# The access audit records who the database verified, beside who the API said (DATA-01 slice 4)

Date: 2026-11-06

DATA-01 slice 4 ([specs/001-tenant-capability](../../specs/001-tenant-capability/tasks.md), T027 and T028; founder decision D6). Before this, `security_audit_record` stored whatever tenant and person the API passed. A caller with the application's credentials could attribute an audit row to anyone.

**What changed.**
- **Migration 0072** (`breaking`, because the writer is redefined; an older image calls the same signature and keeps working):
  - adds `verified_tenant_id` and `verified_actor_sub` to `security_audit_events`. The existing `tenant_id` and `actor_sub` are now the claimed identity;
  - adds `security_audit_capability()`, a capability-only lookup owned by `telesphoros_capability` and callable by the writer's owner only. It never falls back to the settings and checks no organization status;
  - `security_audit_record` fills the verified columns from that lookup.
  - Its `down` refuses while any row holds a verified identity, unless `telesphoros.allow_audit_drop=yes`.
- **`Database.recordSecurityEvent`** binds the request's capability in the same single statement. Call sites are unchanged, and the write is not counted in `capabilityStats`, so D7's capability-less count is unaffected.
- **Docs:** [application-access-audit.md](../ops/application-access-audit.md) explains the two identities, and [the verification record](../verification/tenant-capability.md) gives the tests and mutants.

**Departures from the task text.** Identity comes from the capability-only lookup, not `app_tenant()`/`app_actor()`: those fall back to the settings in `dual` mode, and `app_tenant()` drops a suspended organization. No new claimed columns were added; the existing two serve.

**Limits.**
- `api-auth` `accepted` is recorded before the guard asks for a capability, so it never has a verified identity.
- Staging runs no issuer, so every verified field there is NULL until it does.
- The binding mode stays `dual`.
- Not verified in AWS.
