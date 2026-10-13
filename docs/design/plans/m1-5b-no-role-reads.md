# M1.5b: members with no role cannot read clinical records

Status: **implemented on a local branch (not pushed).** The founder approved the rule on 2026-10-13 (decision DA-1 and DM-2 in the [M1.5 plan](m1-5-live-membership-revocation.md), which names this slice) and asked to start it the same day, so this note records what was done rather than asking again. Closes audit finding **I04**. Evidence: [verification](../../verification/m1-5b-no-role-reads.md).

## Problem

`docs/auth.md` said a member with no role "may see their tenant's data without changing anything", and nine read routes carried no `@Roles()`, so belonging to an organization was enough to read its patients, reports and results. The research package recommends the opposite.

## What changes

- A constant `CLINICAL_READ_ROLES` (`reader`, `clinician`, `admin`, `reviewer`) and `@Roles(...CLINICAL_READ_ROLES)` on the clinical read routes. The audit listed nine; reading the controllers found **eleven**: `GET /patients`, `/patients/:id`, `/reports`, `/reports/:id`, `/recommendations`, `/recommendations/:id`, `/captures/:id`, `/evaluations`, `/evaluations/:id`, `/cell-disputes`, `/cell-disputes/:id`.
- `GET /me`, the health probes and every write are unchanged.
- `docs/auth.md` role table.

## One departure from the wording of the approved recommendation

The recommendation said "reader, clinician or admin (`reviewer` additive and never enough alone)". Applied literally it would break flows that exist and are tested: `CAN_CAPTURE` and `CAN_EVALUATE` already let a reviewer-only person capture and evaluate, the reviewer browser persona reads the reports list and the local review pages, and a reviewer who may accept a capture must be able to open it. So any of the four roles qualifies, and only a member with **no** role is refused, which is what finding I04 describes. If the founder wants reviewer-alone refused, it is one constant and the affected flows (reviewer-only access to captures, evaluations, disputes and the reports list) would need a decision.

## Not touched

Membership and revocation (M1.5), writes, file links (`FILE_LINK_ROLES` already excludes reader), the frontend (a no-role member opening `/reports` sees the page's generic error; a dedicated message is a follow-up), the database and Terraform.

## Verification

A test walks the real route table and fails if any protected route other than `/me` lacks roles; each read is 403 for a member with no role and not 403 for each of the four roles; existing tests that encoded the old behavior were changed on purpose (patients, Cognito roles, the lab-report gate).
