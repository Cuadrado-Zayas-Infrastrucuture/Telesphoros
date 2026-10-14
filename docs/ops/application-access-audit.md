# Local application access audit (T04 slice)

This branch records application API events in a separate append-only PostgreSQL table. It is local synthetic proof, not a hosted audit service or G05/G09 acceptance. It does not change the clinical record ledger.

## Event meanings

| Event | Outcome | What it proves |
| --- | --- | --- |
| `api-auth` | `accepted` | The backend verified a bearer token for this request. It does **not** prove a new IdP sign-in or that a later role/membership check allowed the request. |
| `api-auth` | `refused` | The backend refused missing/malformed/invalid bearer credentials. Tenant, actor and object identifiers remain null because no identity was trusted. |
| `private-read` | `succeeded` / `refused` | An authenticated private GET completed or was refused after authentication. Public routes are excluded. |
| `download-link` | `succeeded` / `refused` | The report download-link route issued a link or refused it. The URL and its credentials are never stored. |

The restricted table stores event/outcome, validated tenant and actor identifiers, a static controller/handler key, optional opaque UUID, request ID and server timestamp. It stores no path, query, body, filename, patient name, token, download URL or raw exception. The application role has only `EXECUTE` on the constrained writer; the verifier role has read access. A protected GET waits for its audit write before the response is emitted; writer failure returns a generic 503. The audit table refuses update, delete and truncate, and its down migration refuses populated evidence.

## Limits and sequencing

- The current branch is based on `origin/main` at `98cd931` and uses migration `0016`. The separate, unmerged T03 branch also uses `0016` for live membership. **Both cannot be integrated unchanged.** Keep the branches separate now; after one is incorporated into the future baseline, renumber/rebase the other and repeat full migration-history and real-PostgreSQL verification before its PR or merge.
- Operator membership grant/change/removal events belong with T03's mutation transaction. They are not implemented here.
- True IdP sign-in/sign-out requires a provider event feed and protected custody. API authentication events must not be relabeled as logins.
- The audit store is protected by PostgreSQL grants and append-only triggers, but this local slice does not establish independent hosted custody, retention, delivery, reviewer access, or resistance to a compromised application credential forging calls to its writer.
- The IP limiter runs before authentication. Requests refused there, unmatched routes, and non-GET private operations do not receive a `private-read` event in this slice.
