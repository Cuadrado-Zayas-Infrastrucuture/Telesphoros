# The worklist home, W1: a held-results filter on the evaluations list (spec 049)

Date: 2026-11-24

`GET /evaluations` takes an optional `disposition` (`held` or `evaluated`), applied in the ledger query. It composes with `current`,
`reportId` and `patientId`, and `meta.total` counts the filtered set. Any other value is a 400. The route's roles, gate and tenant scope
are unchanged. This is what the worklist home's "Held results" will read (`disposition=held&current=true`, slice W2).

Tests:

- The repository (PostgreSQL) tier uses hand-written stored states: held, evaluated, and held then evaluated. It also checks that no other
  tenant's evaluations are listed, as a superuser.
- The HTTP tier's oracle is the hand-written golden expectations of D01 to D12. It covers paging, bad values, and another tenant.

No migration, setting, role or frontend change. The docs row for the route says so in `docs/lab-report-reader.md`.
