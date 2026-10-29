# Feature Specification: Usage page (USP)

**Feature Branch**: `feat/usage-page` (the frontend half of Usage; the API, `GET /usage`, merged as #134, spec 010)

**Created**: 2026-10-28

**Status**: Approved 2026-10-28 ("Yes, build it"), with the wording proposed in the plan: months named, the current one marked "so far", and one line on Puerto Rico time and what storage counts.

**Input**: Administrators had an API for their organization's usage but no page to read it on.

## Decisions

- **D1, who:** `/usage` is behind `RequireRole anyOf={['admin']}`, the first admin-only page. Its links appear only to administrators. The API refuses everyone else regardless.
- **D2, content:** this month so far and last month, each with reports uploaded and evaluations (with results, held); then storage (files, and total size in readable units).
- **D3, form:** plain numbers in a description list, no chart. Two months read more clearly as numbers.
- **D4, states:** loading skeleton; an alert with Retry when loading fails; "Not available on this server yet" for an older API that answers 404; a reply that breaks the contract is treated as a failure.
- **D5, links:** Usage in the site header and the workspace sidebar, and an Administration section in Settings, all for administrators only.

## Out of scope

- Billing, limits, charts, and any breakdown per person.
- Any backend change.

## User Scenarios & Testing

1. **An administrator reads usage (P1).** **Acceptance:** both months and storage appear with the API's numbers, named in Puerto Rico months.
2. **Anyone else (P1).** **Acceptance:** a clinician, reader or reviewer, or a member with no role, sees no Usage link, and `/usage` shows the existing "not allowed" page without calling the API.
3. **Failure (P2).** **Acceptance:** a 500 shows an alert and a Retry that works; a 404 shows "Not available on this server yet".

## Requirements

- **USP-1** Brand rules hold in both themes: tokens only, status as words, 44 px targets; no axe violations.
- **USP-2** The reply is parsed with `usageDtoSchema`.
