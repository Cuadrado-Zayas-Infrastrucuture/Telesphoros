# M1.6: security-event audit store (plan)

Status: **implemented on a local branch (stacked on the local M1.5 branch, not pushed).** The founder answered yes to DS-1, DS-2, DS-3 and DS-4 on 2026-10-13 and asked to start. Slice M1.6 of the [repo audit and build plan](repo-audit-and-build-plan.md), closing research-audit finding **I06** and the security half of task **T04**. Evidence: [verification](../../verification/m1-6-security-events.md). Kept local at the founder's request (no push, so no CI spend); the branch is based on the local M1.5 branch because the trigger sits on the table M1.5 creates.

## Problem

The application leaves no durable, tamper-resistant record of security-relevant acts:

- Who was added, removed, re-roled or had their sessions revoked ([M1.5](m1-5-live-membership-revocation.md) keeps only the latest author and reason on the membership row; the next change overwrites them).
- Who was refused access, and why (today only a diagnostic log line, which is not a record: it is rotated, not append-only, and carries no guarantee).
- Who was issued a link to a stored file (report download, capture text), the nearest thing the product has to an export.

What exists and is not enough: the **clinical ledger** (a per-organization hash chain of lab-report records and corrections; it records clinical facts, not security acts), **CloudTrail** ([ops/audit-trail.md](../../ops/audit-trail.md): AWS account and S3 object activity, written but never applied), and **diagnostic logs** (redacted, no durability promise). The research package asks for three separate streams: clinical audit, security audit, and diagnostics. This slice builds the security audit stream; it does not touch the other two.

## Design

### 1. The store: `security_events` (one migration)

Append-only, never updated or deleted by anyone (the same `refuse_mutation` triggers the ledger tables use, including TRUNCATE). One row per event:

| Column | Meaning |
| --- | --- |
| `id`, `seq` | uuid and an identity column for stable order |
| `occurred_at` | server time, set by the database |
| `tenant_id` | the organization the event is about; null only for events that belong to none |
| `event_type` | from a fixed list enforced by a CHECK (below) |
| `outcome` | `succeeded`, `refused` |
| `actor_kind`, `actor_ref` | `person` (the token's `sub`), `operator` (the `--by` name the command was given), `system`. `actor_ref` is never a token, address or e-mail |
| `subject_kind`, `subject_ref` | what it was about: a person's `sub`, or a report or capture id (a UUID; never a filename, label or any patient detail) |
| `request_id` | correlates with the diagnostic log line for the same request |
| `details` | a small JSON object limited to a per-type allowlist of keys (for roles: the before and after role names; for refusals: a reason code; for links: the report or capture id and the link lifetime) and capped in size, enforced by a CHECK. No free text from a request |
| `db_user` | `session_user` of the writing connection, so an event written by an operator login is distinguishable |

**No token, URL, signed link, query string, request body, file name, label or patient value is ever stored**; the allowlist and a test that runs every flow and scans every stored event for such strings enforce it.

### 2. Who can write and read

- The **application role has no privilege on the table**. It can only call `security_event_append(...)`, a `SECURITY DEFINER` function that takes the organization and the person **from the transaction's own settings** (the same `app.current_tenant_id` and `app.current_actor` that `withTenant` already sets), never from its arguments. So the API cannot record an event for another organization or in someone else's name, and cannot write an event type outside the list.
- Membership changes are recorded by a **trigger on `tenant_memberships`** (written by the operator command with the owner login), in the same transaction as the change. So a grant, role change, removal or revocation cannot happen without its event, including a change made with hand-written SQL by the owner. (An owner can still disable a trigger; that is the residual risk in DS-2.)
- **Reading** is restricted to a new `NOLOGIN` role `telesphoros_security_auditor`, whose login is provisioned outside the repository by a person (like the ledger operator). No API route, no UI. The operator command gains `security-events list --tenant ID [--since TIME] [--type T] [--limit N]`, printing the same allowlisted fields.

### 3. What is recorded (the event catalogue)

| Event type | Written by | When | If recording fails |
| --- | --- | --- | --- |
| `membership.granted`, `membership.reinstated`, `membership.roles-changed`, `membership.removed`, `membership.sessions-revoked` | trigger on `tenant_memberships` | the operator command changes a row | the change fails (same transaction) |
| `access.refused` with reason `no-membership`, `removed`, `token-revoked`, `authority-changed` (a write refused at commit) | application (guard, commit check) | a valid token is refused by M1.5's checks | best-effort, never blocks (the request is already refused); throttled to one event per person, organization and reason per minute so a refused caller cannot flood the table |
| `file.link.issued` (report download link, capture text link) | application | after authorization, **immediately before** the link is created | **fail closed**: no link without its event (DS-3) |

Deliberately **not** recorded here: successful sign-in and sign-out (the API cannot see them; Cognito's events are in CloudTrail), refusals for a missing role (frequent and not security events; they stay in diagnostics), and every clinical read (that is the *clinical* audit stream, a separate slice with its own access rules). "Invitations" are Cognito's act, not the application's; the application's equivalent, the membership grant, is recorded. There are no exports other than file links today; a future export route must write `export.*` events (the type list is extended by a migration, which forces that review).

### 4. Durability and tamper evidence

Inside the database: append-only triggers, no application privileges, a restricted reader, and the table is in every backup (the backup and restore checks compare ownership and privileges, so a restore that loses the protections is refused). **Outside the database** (an Object Lock copy so a database administrator cannot quietly rewrite history) is **not** in this slice: it belongs with the audit-trail infrastructure and needs a founder decision on retention and destination (DS-2, DS-4).

## Decisions for the founder

| # | Decision | Recommendation |
| --- | --- | --- |
| DS-1 | Scope of the first catalogue | Exactly the table above: membership changes, membership refusals, file-link issuance. Not sign-ins (Cognito), not role-based 403s, not clinical reads |
| DS-2 | Tamper evidence | Append-only triggers plus privilege separation now; **no per-event hash chain** (the clinical ledger already pays that cost for clinical facts, and an owner who can disable a trigger can also rewrite a chain they control). A later slice copies events to the Object Lock audit bucket. The alternative, a per-organization hash chain verified by the existing verifier role, costs a second chain, a verifier pass and incident handling for little added protection against the one actor it would need to stop |
| DS-3 | If the file-link event cannot be recorded | Refuse the link (fail closed, 503), because a link nobody can account for is the exact case the record exists for. Refusals and other best-effort events never block |
| DS-4 | Reading and retention | Operator command with a restricted auditor login only (no API or screen yet). Keep every event with no delete path; the floor to honor when the Object Lock copy is built is the 2,190 days already set for the CloudTrail logs ([audit-trail.md](../../ops/audit-trail.md)). Say if a different period applies |

## What this does not touch

The clinical ledger and its verifier, CloudTrail and Terraform (nothing applied), diagnostic logging rules, the frontend, token verification, and the M1.5 authority logic beyond adding the throttled refusal events and the trigger. No change to what any role may do.

## Verification plan

| Check | Proves |
| --- | --- |
| Operator command sequence (grant, set-roles, remove, reinstate, revoke-sessions) yields exactly one event each, in order, with the right before and after roles, `actor_ref` the `--by` name and `db_user` the migration login; an UPDATE made with hand-written SQL by the owner also yields its event | membership events are complete and cannot be skipped through the command |
| A change whose event insert is forced to fail (injected) rolls the membership change back | atomic with the change |
| A removed person's old token and an unknown member's token each yield one `access.refused` with the right reason; a flood of 200 refused requests yields one event; a different person or reason yields another | refusal events and the throttle |
| Report download and capture text links yield `file.link.issued` with the right ids before the link exists; with the insert forced to fail the response is 503 and no link was created | fail closed for exports |
| The API login cannot SELECT, INSERT, UPDATE, DELETE or TRUNCATE the table; calling the function cannot name another organization or person; an unknown event type or a disallowed details key is refused; the owner cannot UPDATE, DELETE or TRUNCATE | write and tamper boundaries |
| Only the auditor role reads; `security-events list` prints only allowlisted fields | restricted read |
| Every flow above, then a scan of all stored events for tokens, `http`, signed-URL parameters, file names, labels and the patient label strings used in the tests | privacy |
| Backup and restore of a database holding events keeps the table, rows, owner and privileges (the restore rehearsal's privilege comparison); migration up and down; schema acceptance and catalog classification updated | durability and drift |
| Defect injection (working agreement 6): remove the trigger; let the application name its own tenant; drop the append-only trigger; make the link event best-effort; store the URL in `details`. Each must turn a named test red | each rule is real |
| Full local regression: typecheck, lint, build, `test:infra`, `test:ci-config`, the three backend tiers (recovery tests as an unprivileged user), the browser tier | nothing else moved |

## Files expected to change

New: migration `0017_security_events.{up,down}.sql` (after M1.5's 0016), a security-events module (service, repository, event-type list), the operator `security-events` command, `docs/ops/security-events.md`, specs and a verification note.
Changed: the membership guard and commit check (throttled refusal events), the two file-link services, `Database` settings for the actor (already present), `append-only-tables.ts`, schema acceptance and catalog tests, the recovery and backup fixtures' role lists, `docs/auth.md`, `docs/database.md`, `docs/STATUS.md`, this plan.

## Risks to watch

- **Depends on M1.5 being merged**: the trigger is on a table M1.5 creates, and the migration number follows its 0016. Implementation starts after that merge.
- **File links gain a write** (the event), so a link request now takes M1.5's commit-time membership lock; a removed person can no longer obtain a link in a race, which is the intended result.
- **Event volume**: refusals are throttled, link events are one per link, membership events are rare. Nothing here writes per clinical read.
- **A new restricted role** touches the privilege lists (`privilege-facts`, the restore's required roles, the test cluster setup); the change is mechanical and the restore check proves it.
- Events say "authorized and the link was created", not "the file was downloaded": the download happens at the object store, outside the application (CloudTrail's S3 data events cover that).

## Changes from this plan

1. **Event details use only letters, digits and hyphens** (at most 64 characters per string), which excludes URLs, dotted names, tokens and spaces by construction; the allowlist of keys is `reportId`, `captureId`, `reason`, `roles`, `before`, `after`, `ttlSeconds`, `kind`.
2. **The `authority-changed` refusal is recorded from `Database.withTenant` after the rollback** through a hook the recorder sets, as organization work (the refused person's own authority must not decide whether their refusal is written), with the request id captured first.
3. **`CapturesService.pdfLink`**, a third link-issuing method that no route calls today, records the same `file.link.issued` event so a future route cannot issue a link unrecorded; it has no test of its own for that reason.
4. **A new in-memory recorder** serves development and tier 1 with the same throttle; production requires PostgreSQL.

## What I needed from the founder

DS-1, DS-2, DS-3 and DS-4: all four answered yes on 2026-10-13.
