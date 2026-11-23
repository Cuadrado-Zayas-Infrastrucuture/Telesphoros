# Feature Specification: Patient access review (AR)

**Feature Branch**: `feat/patient-access-log`

**Created**: 2026-11-21

**Status**: Revised plan approved by the founder 2026-11-21 ("Approve revised plan"), replacing the first plan for decision #2 of the
2026-11-16 clinical UX and adoption audit ("(a) Access log + review"). The working number 046 is unsettled: public `main` took 044 on
2026-11-21, and two local branches hold 044 (release clinical review) and 045 (follow-up closure notice). Whichever merges later renumbers.

**Input**: Access to patients is organisation-wide by design (`docs/auth.md:49-50`). The first plan proposed a new access table. Reading the
code showed that one already exists. `SecurityAuditInterceptor` (`apps/backend/src/auth/security-audit.interceptor.ts`, global in
`app.module.ts:60`) writes every authenticated private GET to `security_audit_events` (migration 0016, widened by 0037, 0052 and 0072), with
the organisation, the person, a static route key, the path's id, the request id and the server time. It fails closed: a read whose row cannot
be stored is withheld. What is missing is review: only `telesphoros_ledger_verifier` can read the table, nobody is shown it, and the evaluations
list (`GET /evaluations?patientId=`) records no patient at all, because its patient is in the query, not the path.

## Decisions

- **D1, no new table.** The review reads `security_audit_events` through one function. The table's grants, its writer, the read path and
  fail-closed behaviour do not change.
- **D2, admin only, checked in the database.** The function refuses anyone but a current `admin` of the bound organisation, checked against the
  live membership, not the request.
- **D3, ids, not labels.** The `admin` role sees no clinical data (`apps/backend/src/usage/usage.controller.ts:11-13`), and patient labels are
  shown only to clinical roles. So the review shows patient ids, member ids, route keys, outcomes and times. Showing labels to admins would widen
  what the role may see, which needs its own decision. (The approved plan listed "the patient label already shown in lists"; this is the one
  departure, made because it would change role semantics.)
- **D4, patients resolved in the application.** The function returns audit rows; the API resolves each row's patient through queries already
  bound to the organisation: the path id for patient routes; the evaluation's or report's patient for `/evaluations/:id` and `/reports/:id`;
  the recorded `patientId` for the evaluations list. The ledger role, which owns the audit table, gets no new table access.

## Requirements

| ID | Requirement |
| --- | --- |
| AR-1 | **Migration 0077.** `access_review_admin_current(tenant, sub)`: true only for an active organisation and an active membership whose roles include `admin`; executable by `telesphoros_ledger` only. `security_audit_review(actor, subjects, from, to, limit, offset)`: SECURITY DEFINER, owned by `telesphoros_ledger`, executable by `telesphoros_app` only. It takes the organisation and the caller from `app_tenant()` and `app_actor()`, refuses (`insufficient_privilege`) when either is missing or the caller is not a current admin, and returns only `private-read` and `download-link` rows of that organisation, newest first, at most 201 per call. The down migration drops both functions. |
| AR-2 | **The evaluations list records its patient.** The audit row of `EvaluationsController.list` takes `patientId` from the query as its subject when it is a UUID. Every other route is unchanged: still the path's id, or none. |
| AR-3 | **Review route.** `GET /api/v1/access-review` (admin only): by patient (`patientId`) or by member (`member`), and a date range (`from`, `to`, at most 92 days), paged (`page`). Each row: time, member, route key, event, outcome, the subject kind (`patient`, `evaluation`, `report` or `other`), the subject id and the resolved patient id (or none). |
| AR-4 | **Export.** `GET /api/v1/access-review/export` (admin only), the same filters, `text/csv`, at most 5,000 rows, with a header and the same columns. |
| AR-5 | **Settings.** An "Access review" section in Settings, for admins only: a patient id or a member, a date range, the rows, previous and next, and "Download CSV". Status in words, no badges. |
| AR-6 | **No clinical content.** Neither the function, the route, the export nor the page holds drug, gene, phenotype, recommendation or report text, a file name, a label, or a URL. |
| AR-7 | **Left open.** Retention of `security_audit_events`, independent custody and the reviewer cadence stay open, as `docs/ops/application-access-audit.md` says. This slice gives the reviewer a way in; it decides neither how long rows live nor how often someone looks. |

## Acceptance tests

| ID | Test | Must fail when |
| --- | --- | --- |
| T-1 | Database: an admin of the bound organisation reads its own read rows; another organisation's rows never appear | the tenant filter is dropped |
| T-2 | Database: a clinician, a removed admin, and a call with no person bound are refused | the admin check is dropped or reads the request |
| T-3 | Database: write and sign-in rows are not returned; the actor, subject and time filters hold; at most 201 rows | a filter or the cap is dropped |
| T-4 | API: a clinician opens a patient, its evaluations list, an evaluation and a report's download link; the admin's review by that patient lists all four, each resolved to the patient | a route is not resolved, or the evaluations list records no patient |
| T-5 | API: the review and the export answer 403 to a clinician and 503 without PostgreSQL; the export is CSV with the header and no label or clinical text | a non-admin reads the review, or the export carries content |
| T-6 | Interceptor: the evaluations list's subject is its `patientId`; another route with a `patientId` in its query keeps none | the change reaches other routes |
| T-7 | The route-key map covers every GET handler of the patient-scoped controllers | a patient route is added without being classified |
| T-8 | Settings: the section shows only to admins, lists rows, downloads CSV, says when nothing matched or the review failed; axe clean | a non-admin sees it, or a failure looks like "no access" |

## Out of scope

Care-team access and break-glass; lists (the patients list, the follow-up inbox) as patient reads; retention, custody and cadence (AR-7);
showing labels to admins (D3).
