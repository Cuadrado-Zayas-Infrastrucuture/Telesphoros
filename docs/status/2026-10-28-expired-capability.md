# Fix: a request that outlived its capability is refused, not answered empty (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (A3).

**The problem.**
- A request is issued one capability (at most 60 seconds, `capability_purposes`) and every transaction it runs reuses it. `database.ts` set it even after it had expired.
- With an expired capability the database resolves no organization (`app_tenant_bound()`, 0047), so row-level security returns no rows and no error: a slow request answered 200 with an empty list, or 404.
- Reproduced on PostgreSQL: a read with an expired capability returned 0 of the organization's 3 patients.
- Latent today: the issuer is behind `enable_issuer` (default false) and nothing is applied in AWS. It becomes live when the issuer is switched on.

**The fix.** `withTenant` refuses a transaction whose request capability has expired with 503 ("This request took too long. Try again."), before taking a connection, and counts it as `expired`. A new request is issued a new capability. Requests without a capability, and background work, are unchanged.

**Not fixed here.** Security events written with an expired capability are still dropped (`security-events.ts:88-93`); recording them needs a path that does not depend on the capability, a separate change. A capability that expires between this check and the statement (milliseconds) still resolves nothing.

**The tests.** `test/db/expired-capability.pg-spec.ts`: a valid capability reads all 3 patients (control); an expired one is refused with 503 and counted as `expired`. Red before the fix (it returned 0 rows).

Not verified in AWS.
