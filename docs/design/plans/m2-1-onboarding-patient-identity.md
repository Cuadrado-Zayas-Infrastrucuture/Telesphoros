# M2.1: clinic onboarding and patient identity (plan)

Status: **M2.1a built on a local branch** (`claude/m2-1a-tenants-member-admin`; DP-1 to DP-6 answered yes by the founder on 2026-10-13; see [verification](../../verification/m2-1a-tenants-member-admin.md) and [Changes from this plan](#changes-from-this-plan-m21a)). **M2.1b is built on a local branch stacked on it** (`claude/m2-1b-patient-identifiers-link`; its [design note](m2-1b-identifiers-and-patient-link.md) carries the key-custody section this plan required, and lists where it differs from the text below; [verification](../../verification/m2-1b-patient-identifiers-link.md)). **M2.1c is still plan only.** Slice M2.1 of the [repo audit and build plan](repo-audit-and-build-plan.md), research task **T06** (audit findings **A04**, **A06**). Working agreement 1 requires the founder to approve each slice first. Kept as local branches at the founder's request (no push, so no CI spend).

T06 is too large for one pull request, so this plan splits it into three, each with its own verification and its own draft PR:

| Slice | Content | Detailed here? |
| --- | --- | --- |
| **M2.1a** | Tenant registry, a role matrix in which an organization administrator manages people but reads no clinical data, and member administration inside the application | yes |
| **M2.1b** | Patient identifiers scoped to an organization and a verified link between a report and its patient, required before evaluation | yes |
| **M2.1c** | Wrong-chart quarantine, and duplicate-patient merge and unmerge | outline only; gets its own plan after M2.1b |

Everything stays **synthetic**: the AWS BAA is not executed and nothing here lifts that. The decisions below are the ones the research package assigns to task T01 (intended use and role matrix), which is still open (milestone M0); each carries a recommendation so work can proceed on the synthetic pilot without pretending T01 is done.

## Problem, as the repository stands

1. **Onboarding is an operator runbook.** A clinic exists because someone ran `aws cognito-idp create-group` and `db membership grant` ([auth.md](../../auth.md#inviting-and-removing-people-runbook), [ops/membership.md](../../ops/membership.md)). There is no tenant registry, so nothing says which organizations exist, and the only way to administer members is a command run with the migration login. Decision DM-1 (M1.5) kept the API from changing membership "until a later slice with its own plan"; this is that plan.
2. **An organization administrator reads patient data.** `admin` is "what a clinician may" plus administration (the role table in [auth.md](../../auth.md#roles)); it is in every clinical write and read list. T06's acceptance criterion says the opposite: *a tenant admin does not automatically gain clinical read privileges*.
3. **A patient is a label.** `patients` holds only a synthetic `label` (letters, digits, hyphens, up to 40) and a tenant ([database.md](../../database.md)); there is no identifier, no assigning authority, and no way to say two records are the same person or that a report belongs to this person. The product never creates patients through its own interface (the browser tests make them through the API).
4. **Nothing verifies that a report belongs to the patient it is attached to.** The patient is chosen when the report is registered, a database foreign key keeps tenant and patient consistent, and the only trace of a wrong choice is the `wrong-patient` retraction reason on a correction ([records-and-corrections.md](../records-and-corrections.md)). An evaluation can be produced from an unverified link.

## M2.1a: tenant registry and scoped member administration

**Data.** A `tenants` table (`id`, `display_name`, `status` active or suspended, created time and by whom), never deleted. `tenant_memberships.tenant_id` gains a foreign key to it, so a membership can no longer name an organization that was never registered (the typo class [auth.md](../../auth.md#tenants) still warns about at the Cognito side). An operator command `db tenant create --id ID --name NAME --by NAME` registers one (DP-3). Existing synthetic tenants are registered by the same migration from the ids they already use.

**Role matrix (DP-1).** `admin` becomes **administration only**: it may invite people, change roles and remove people **in its own organization**, and read the organization's security events; it may not read or write patients, reports, recommendations, captures, evaluations or links. A person who needs both holds both (`admin` and `clinician`). `CLINICAL_READ_ROLES`, the write lists (`CAN_WRITE`, `CAN_CAPTURE`, `CAN_EVALUATE`) and `FILE_LINK_ROLES` lose `admin`; `GET /ledger/verify` stays `admin` (it returns counts and hashes, no clinical content). The audit plan notes this blast radius: every test and persona that uses an admin token for clinical work changes, and the frontend's `WRITER_ROLES`.

**Member administration in the application (DM-1's "later slice").** Three routes for `admin` only: change a member's roles, remove a member, and (DP-2) record an invitation. Rules enforced in a `SECURITY DEFINER` function that the application role may execute, not in controller code, so no future route can bypass them:

- only members of the caller's own organization (the function reads the organization from the transaction, as `security_event_append` does);
- **never oneself**: an administrator cannot change their own roles or remove themselves;
- **never the last administrator**: a change that would leave the organization with no active `admin` is refused;
- every change writes the same `security_events` the operator command writes (the trigger already covers it) with the administrator as the actor.

The application role still has **no write privilege on `tenant_memberships`**; it only executes the function. The operator command remains for break-glass and for the first administrator of a new organization.

**Invitations (DP-2).** An invitation is a record: organization, e-mail address kept only as a keyed digest plus a masked hint, roles, expiry, state. **The API still creates no Cognito account**: no application path can mint identities (the rule behind DM-1). A person with a pending invitation is created in Cognito and put in the organization's group by an operator command (`db invite fulfil`) today, and by the worker from M2.3 later; on first sign-in their membership is created from the invitation. Fresh-clinic acceptance (T06: "reaches the first patient without ad hoc SQL") is then: `tenant create`, create the first administrator's Cognito account and `membership grant --roles admin`, and the administrator does the rest in the application.

**Verification (M2.1a).** Tenant FK and registration; every rule above has a refusal test and a control that succeeds (own organization, another administrator changing roles, a reader refused); defect injection for each rule (allow self-change, allow removing the last administrator, read another organization, let `admin` read a patient); the role-matrix change is proved by the existing role tables in the test suites, rewritten by hand; the full local tiers and browser tier; docs (`auth.md` role table, `ops/membership.md`).

### Changes from this plan (M2.1a)

What was built differs from the text above in these ways; each is a consequence found while building, none changes a decision DP-1 to DP-6.

- **Backfill.** Migration 0019 registers the organizations named by existing `tenant_memberships` rows (created by `migration-0019`), not "the ids they already use" in every table. An organization that only owns records, with no member, is registered by `tenant create` before its first grant. A clinic with records but no members cannot have been using the API anyway (M1.5).
- **Suspended organizations (new).** `tenants.status` is enforced on every request: a suspended organization is refused (403, a `tenant-suspended` refusal event) and its administrators cannot administer. The plan registered the status but did not say who enforces it.
- **"Never the last administrator" is a backstop.** Because self-change is refused first and the actor must itself be an active administrator, the rule can only fire when two administrators act on each other at the same moment. A per-organization advisory lock serializes them; the loser is refused with `last-administrator` (409) or `not-administrator` (403), depending on when it read its own standing. The tests prove the invariant (one administrator remains) rather than a single error code, and each rule has an injected defect that fails a test.
- **Empty role sets are allowed** in `PUT /members/:sub/roles` (a member who can sign in and nothing else, as in M1.5b). Invitations also accept an empty set.
- **Security events for administration.** Role changes and removals made by an administrator are recorded by the existing membership trigger, with `actor_kind` `person` (the trigger now compares the transaction's actor with the row's `changed_by`). Creating, cancelling and fulfilling an invitation write **no** event: the M1.6 catalogue is fixed and changing it is its own decision. **Not built:** "admin may read the organization's security events". No route reads events for an organization; that needs the auditor's read path exposed with its own plan.
- **Terraform (the plan said it is untouched).** Making `INVITATION_DIGEST_KEY` mandatory in production means the API task definition must carry it, or the service cannot start. A secret *container* `api/invitation-digest-key`, its read permission for the service's execution role and its injection into the task were added in the existing pattern (value set by hand, never in Terraform), and the compute and profile guards were extended with controls. Nothing is applied.
- **Restore check.** The restore verification's row-level-security isolation check assumed every such table has a `tenant_id` column; `tenants` is keyed by `id`. The check now knows that, so a restored registry is checked for isolation too.
- **Frontend.** `admin` leaves `WRITER_ROLES`; a new `CLINICAL_READ_ROLES` guard closes the reports page to an administrator who holds no clinical role (the API already refuses them; the page now says so instead of showing an error). No screen for member administration was built: the routes are API-only in this slice.
- **Tests that encoded the old matrix were rewritten by hand** (about twenty, listed in the verification note), not loosened: where `admin` used to succeed, the test now asserts 403 and adds a control that `admin` plus a clinical role succeeds.

## M2.1b: scoped patient identifiers and a verified report link

> **Built; read the [design note](m2-1b-identifiers-and-patient-link.md) for what was built.** Where it differs from this section the note says so: uniqueness is over *active* identifiers, "unverified" is the absence of a decision for the current file (no stored row), per-organization keys are derived from one master, a mismatching match records nothing, and the evaluation gate is in the service and its transaction rather than a trigger.

**Identifiers (DP-4).** `patient_identifiers`: `tenant_id`, `patient_id`, `system` (the assigning authority, a short code the organization chooses, for example `hospital-a-mrn`), `value_digest`, `created_by`, `status` (active, withdrawn), unique on (`tenant_id`, `system`, `value_digest`). The digest is an HMAC-SHA-256 under a **per-organization key** held outside the database, so the same MRN in two organizations never produces the same stored value and cannot be matched globally, and a bare MRN or FHIR `Patient.id` is never a global identifier. **Recommendation: store the digest only, never the raw identifier.** The raw MRN stays in the clinic's own record system; the application matches exactly, and the clinic-chosen label remains the only human handle. A digest of a low-entropy identifier is still sensitive if the key leaks, so it is protected like patient data (row-level security, never logged, never in an event). If the founder prefers raw identifiers under row-level security, this slice changes to a column the application can display; that raises the regulatory bar and should wait for T01 and the BAA.

**Verified link.** `report_patient_links`: `report_id`, `patient_id`, the exact **file version** (`sha256`, `object_version`) the decision was made about, `status` (`unverified`, `verified`, `rejected`), `method` (`identifier-match`, `person-confirmed`), `decided_by`, `decided_at`, `basis_code`. A link is created `unverified` when a report is registered; a person records the decision.

- **`identifier-match`**: the person enters the identifier the report shows (it is digested on arrival and never stored); the application compares it with the patient's active identifiers; a match marks the link verified, a mismatch does not.
- **`person-confirmed`**: no identifier on the report (or none registered) so the person attests the link with a coded reason; it is recorded as the weaker method and shown as such.
- **Who (DP-5):** a `clinician` or `reviewer` who is **not** the report's creator or uploader (the same independence idea as the capture rule). An `admin` cannot verify.
- **Gate:** creating an evaluation for a report whose current file version has no `verified` link is refused with a stable reason (`patient-link-unverified`, 409). Replacing the file (a new version) makes the link `unverified` again.
- The link decision is a **ledger record** like captures and corrections (append-only, in the organization's hash chain, one event), so it cannot be silently changed; a later rejection is a new record, not an edit.

Automatic extraction of identifiers from the report text is **not** in this slice (task T10 owns constrained extraction); the person reads the report and types what they see.

**Verification (M2.1b).** The same identifier in two organizations is two different stored values and never matches across them; a match verifies, a mismatch and a withdrawn identifier do not; the uploader cannot verify their own report, nor can an `admin`; evaluation is refused until verified and allowed after (the existing evaluation suites gain the verification step by hand); a replaced file un-verifies; the link record is in the ledger and is covered by the ledger verifier; privacy scan (no raw identifier in any table, log, security event or response); migration, privilege, backup and restore checks; defect injection per rule.

## M2.1c outline (now its own plan: [m2-1c-wrong-chart-and-duplicates.md](m2-1c-wrong-chart-and-duplicates.md), split into c-1 quarantine and c-2 duplicates and merge)

Wrong chart: rejecting a verified link quarantines the report and requires reviewer action on every current evaluation (the existing `retraction` correction with reason `wrong-patient`). Duplicates: an ambiguous second registration of the same identifier goes to a review list instead of creating a patient; merge and unmerge are **alias records** resolved at read time, never a rewrite of `tenant_id` or `patient_id` on existing rows (those columns are immutable by trigger and referenced by the append-only records), each needing a second person.

## Decisions for the founder

| # | Decision | Recommendation |
| --- | --- | --- |
| DP-1 | Is `admin` administration only (no clinical read or write)? | Yes, as above. A person who needs both holds both roles |
| DP-2 | Invitations | A record in the application; Cognito accounts are still created outside the API (an operator command now, the M2.3 worker later) |
| DP-3 | Tenant registry | Yes: a `tenants` table, registered by an operator command; a membership must name a registered organization |
| DP-4 | Patient identifiers | Keyed digests only, per-organization key, no raw identifier stored; raw storage waits for T01 and the BAA |
| DP-5 | Who may verify a report-patient link | A clinician or reviewer who did not create or upload the report; evaluation is refused until verified; a new file version un-verifies |
| DP-6 | Order | M2.1a first, then M2.1b; M2.1c gets its own plan |

M0 (T01: intended use, supported reports, regulatory assessment, retention classes) is still undecided. Nothing here handles real patient data; each recommendation is chosen to be safe on the synthetic pilot and cheap to revise when T01 is decided.

## What this does not touch

Real patient data and the BAA; Cognito and Terraform (nothing applied); the worker and jobs (M2.3); report extraction (M3.1); the product screens for the review journey (M3.2); billing and entitlements (P1). M2.1a changes the role matrix but adds no new clinical capability.

## Risks to watch

- **Role-matrix blast radius** (DP-1): `admin` appears in the clinical role lists, the frontend's `WRITER_ROLES`, the browser personas (carol is admin), and many tests. The change is mechanical but wide, and it is the reason it comes first and alone.
- **First-administrator lockout**: the last-administrator rule must not trap an organization whose only administrator is the operator-created one; the operator command can always repair.
- **Per-organization key handling** (DP-4): where the key lives and how it rotates (rotation re-digests only if raw values are retained, which this design avoids, so a rotation would orphan existing identifiers). Needs a short key-custody note before M2.1b is built.
- **Depends on M1.5, M1.5b and M1.6** (membership authority, the role-required reads, security events). M2.1a is built on a local branch that contains all three; none is merged. Push order, when the founder allows pushing: M1.5, then M1.5b, then M1.6, then M2.1a.

## What I need from the founder

Yes or change on DP-1 to DP-6. With the recommendations as written, implementation is M2.1a as one PR, then M2.1b as another.
