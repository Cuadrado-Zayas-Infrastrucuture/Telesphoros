# Authentication and permissions

Sign-in is **Amazon Cognito** (invite-only, authenticator-app MFA required). The API never sees a
password: it verifies a signed access token. **Synthetic data only**, and nothing in Cognito has been
applied: the Terraform is written and validated, and the BAA is still pending.

## How a sign-in works

1. The user opens a protected page and is sent to `/signin`. They click **Sign in**.
2. The browser goes to Cognito's sign-in page (authorization-code flow with PKCE). Cognito checks the
   password, asks for the authenticator code, and sends the browser back to `/auth/callback?code=…`.
3. The app redeems the one-time code for tokens. It keeps **only the access token, in memory**, and
   replaces the callback URL in the history so the code does not linger.
4. The app calls `GET /api/v1/me`; the **server** answers with the user's roles. A separate authenticated `GET /api/v1/me/recovery-scope` supplies the upload-recovery binding when supported. The UI uses the roles to decide
   what to *show*. The API enforces every permission itself, whatever the UI shows.
5. Each API call carries `Authorization: Bearer <access token>`. The API verifies the signature against the
   user pool's published keys, and reads the person (`sub`), when the token was issued (`iat`) and **exactly one**
   `tenant:<id>` group from `cognito:groups`. That proves **who** the caller is. **What they may do** is read from the
   database on every request: their row in `tenant_memberships` (see [Authority and revocation](#authority-and-revocation)).
   The organization is what row-level security binds every query to (see [database.md](database.md)); the token's `sub`
   (the individual) is only recorded as the author of what they create.

## Roles

A person's roles are values in their membership row, set by the operator command (`db membership`, [ops/membership.md](ops/membership.md)).
The API **ignores the role groups in the token**: adding someone to a Cognito group grants nothing by itself.

| Role | | May |
| --- | --- | --- |
| `reader` | | read their organization's clinical records (patients, reports, recommendations, evaluations) |
| `clinician` | | read, create, change, upload; register and withdraw a patient's identifiers; decide whether a report belongs to its patient (not for a report they registered or uploaded) |
| `admin` | | **administration only** (M2.1a): list the organization's members, change their roles, remove them, and record invitations, in **its own organization** and never itself. It reads and writes **no** clinical data: patients, reports, recommendations, captures, evaluations, disputes and file links are 403. `GET /api/v1/ledger/verify` stays `admin` (counts and hashes, no clinical content). A person who needs both holds both roles |
| `reviewer` | | decide whether a report belongs to its patient (not for a report they registered or uploaded); accept or reject a text capture of a lab report (slice 5B-3.2). It **adds** to whatever else the person holds and is never implied by another role: an `admin` alone cannot accept, and neither can a `clinician` alone. The person who created, uploaded or captured a report can never accept its capture, whatever roles they hold |
| (no roles) | none | sign in and call `GET /api/v1/me`, nothing else: every read of patients, reports, recommendations, captures, evaluations and disputes is 403 (finding I04; a member of an organization is not thereby allowed to read its records) |

A role the table does not know cannot be stored (a check constraint refuses it), so nothing can grant a role by accident.

## Tenants

A **tenant** is an organization whose members share its records. Two things must agree for a person to be let in: the
identity provider puts them in a Cognito group named `tenant:<id>` (`<id>` is lower-case letters, digits and dashes, 1 to 63
characters, not starting with a dash, for example `tenant:acme-pharmacy`), **and** they have an active membership row for that same
organization in our database.

- Every user must be in **exactly one** tenant group, and have an **active membership** in that organization. None, two or
  more, or a malformed group, or no active membership there, is refused with
  **403** after sign-in: the account is known but not set up. The browser shows "Your account is not set up yet"
  with no retry button. (A forged or invalid token is still a plain 401, so an attacker learns nothing about tenants.)
- Colleagues in a tenant see and edit each other's patients and reports, and each record remembers its author
  (`created_by`, taken from the token, never from the request). Neither the tenant nor the author can change
  afterwards: a database trigger refuses it, even for the table owner.
- Another tenant's records are indistinguishable from records that do not exist (404).
- Tenant groups are **data created by the runbook below, not Terraform**, so onboarding an organization needs no
  infrastructure change. Access tokens carry group names but not custom attributes, which is why the tenant is a group.
- There is no tenant registry yet: a typo such as `tenant:acmee` in Cognito, or in the membership command, no longer silently
  makes a separate working tenant: the two would disagree, so the person gets 403 until both name the same organization.
- A tenant id is permanent once records exist; renaming one is a data migration, not an edit.

## Where tokens live

| Thing | Where | Why |
| --- | --- | --- |
| Access token | JavaScript memory only | An XSS bug can still read memory, but nothing persists to be stolen later |
| ID token, refresh token | discarded right after sign-in | The app never needs them |
| PKCE verifier and `state` | `sessionStorage`, until the callback completes | They must survive the redirect; they are not tokens |
| Cognito's own session | Cognito's cookie on its domain | A page reload signs the app out *locally*; the next sign-in is then instant |

A browser test asserts that no token appears in `localStorage`, `sessionStorage`, cookies or IndexedDB.

## Lifetimes

| | Lifetime | Note |
| --- | --- | --- |
| Access token | 15 minutes | The API also refuses a token issued more than an hour ago |
| After 15 minutes | | The app notices (or the API answers 401) and starts a new sign-in, which Cognito completes silently while its own session lasts |
| Cognito's session | set by Cognito | Verify the actual value at first apply; it decides how often people re-enter credentials |

**Sign-out** first calls `POST /api/v1/me/sign-out`, which cuts off every token this person holds in their own organization
(migration 0033, `member_sign_out()`: it changes only the caller's own active membership row). Then it clears the app's memory
and ends Cognito's session. A cut-off token is refused on its next request. A failed call does not block the sign-out: this
browser still leaves, and the access token lapses within its 15-minute lifetime. The cut-off is for all devices of that person
in that organization, not only this one. A sign-in after the cut-off, in the same second, is refused: the cut-off is whole seconds.
Removal and a role change also take effect on the person's very next request (see below).

## Authority and revocation

Added by M1.5 ([plan](design/plans/m1-5-live-membership-revocation.md), [verification](verification/m1-5-live-membership-revocation.md)).

**The database decides what a person may do, on every protected request.** After the token proves identity, `AuthGuard` reads
the person's row in `tenant_memberships` (no allow decision is cached, so every API instance sees a change at once):

| Condition | Answer |
| --- | --- |
| no active row for the token's organization (never granted, removed, or granted in another organization) | **403** |
| the token was issued at or before the row's revocation instant (`tokens_valid_after`, whole seconds) | **401**: the browser signs in again and gets a newer token |
| the lookup itself fails (database down, timeout, pool exhausted) | **503**, nothing is done. Not 401: that would send the browser round a sign-in loop during an outage |
| otherwise | the request runs with the **row's** roles |

**The commit boundary for writes.** The guard's read happens before the handler, so a removal could land while a write is in
flight. Every database transaction that is part of a request **and wrote anything** therefore locks the caller's membership row
*shared* and compares its version with the one the request was admitted under, just before `COMMIT`
(`membership_assert_current`, called from `Database.withTenant`). Removing a person or changing their roles is an `UPDATE` of
that row, which waits for the lock. So **a write either commits before the removal commits, or is rolled back whole with 403; none
commits after it.** Data already returned to the person before the removal cannot be recalled. A role change that does not
affect the route still refuses an in-flight write once (403); the retry succeeds. Read-only transactions take no lock.
Work with no request behind it (background and organization-owned processing) is not tied to a person and is not checked; neither is the close-out of a transfer that did not complete (it records that nothing was stored and releases the organization's quota reservation), so a person removed mid-upload leaves nothing stranded.

A removed person's row is kept, never deleted, and `tokens_valid_after` only moves forward, so reinstating someone does not revive
a token issued before their removal.

**What is recorded.** The security-event record ([ops/security-events.md](ops/security-events.md)) keeps who was granted, re-roled, removed or had their sessions revoked (by a database trigger, in the same transaction as the change), and every refusal by the checks above (once a minute per person and reason). File links are recorded by the application access audit, not here. It holds identifiers and short codes only, and only the auditor role can read it.

Not in this slice: an application logout endpoint and browser sessions (M5.1). The membership row itself still keeps only the latest change's author and reason; the full history is in the security-event record. No authenticated route skips the membership check.

**Development.** On the in-memory store (no database, `STORAGE_DRIVER=memory`, never production), the membership mirrors the
verified token's claims so a local server and the browser tests have people to check. PostgreSQL never mirrors; the tests that prove
authority run without the mirror.

## Production fails closed

The API refuses to start with `NODE_ENV=production` unless: the verifier is `cognito`, no development
issuer/key-set override is set, storage is PostgreSQL with SSL, files are in S3, and CORS origins are
`https://`. The frontend's production build refuses non-`https` settings.

## Inviting and removing people (runbook)

There is deliberately **no API endpoint** that creates users or organizations: an API that could mint accounts would be a privilege-escalation
path. Since M2.1a an organization's own administrators manage the people already in it through the application (below); creating the
account, the organization and the first administrator stays with an operator. Two steps, both by an administrator with AWS access: Cognito proves who the person is, and
`db membership` says what they may do. The full procedure, with the exact commands, is in [ops/membership.md](ops/membership.md).

```bash
POOL=<cognito_user_pool_id output>

# 1. Cognito: create the account (emails a temporary password; the person sets a new one and enrols an authenticator app)
aws cognito-idp admin-create-user --user-pool-id $POOL --username person@example.org \
  --user-attributes Name=email,Value=person@example.org Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
# Onboard an organization once, then put each person in it (every user needs exactly one tenant group)
aws cognito-idp create-group --user-pool-id $POOL --group-name tenant:acme-pharmacy --description "Acme Pharmacy"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username person@example.org --group-name tenant:acme-pharmacy

# 2. The database: grant the membership (--sub is the Cognito user's `sub`), as a one-off migrator task
db membership grant --tenant acme-pharmacy --sub <sub> --roles clinician --by <your name> --reason "new clinician"

# Change a role (the person's next request, no sign-out needed)
db membership set-roles --tenant acme-pharmacy --sub <sub> --roles reader --by <your name> --reason "moved to read-only"

# Offboard: remove first (effective on their next request, on every API instance), then close the account
db membership remove --tenant acme-pharmacy --sub <sub> --by <your name> --reason "left the organization"
aws cognito-idp admin-disable-user          --user-pool-id $POOL --username person@example.org
aws cognito-idp admin-user-global-sign-out  --user-pool-id $POOL --username person@example.org
```

### Member administration in the application (M2.1a)

An `admin` of an organization has `GET /api/v1/members`, `PUT /api/v1/members/:sub/roles` (a full replacement; an empty list leaves a member
who can sign in and nothing else), `DELETE /api/v1/members/:sub`, and `POST|GET /api/v1/members/invitations` and
`DELETE /api/v1/members/invitations/:id`. The rules are enforced by `SECURITY DEFINER` database functions, not by controller code, so no
route added later can bypass them. The API's database login has **no write privilege** on `tenant_memberships`, `tenants` or `invitations`;
it can only execute these functions, and each takes the organization and the acting person from the transaction, never from the request:

- **own organization only.** Another organization's person is `404`, the same answer as nobody;
- **never oneself.** An administrator cannot change or remove themselves (`409 member-self`); another administrator must;
- **never the last administrator.** A change that would leave the organization with no active administrator is refused (`409 last-administrator`). Two
  administrators acting on each other at the same moment are serialized by a per-organization lock: one succeeds, the other is refused, and one remains;
- the organization must be **active**: a suspended organization is refused on every request, administrators included (`403`, a `tenant-suspended` security event).

Every change is a membership security event whose actor is the administrator (`actor_kind` `person`); the operator command's changes are `operator`.

**Invitations are a record, not an account.** The administrator records an address and the roles; the API stores only a keyed digest
(HMAC-SHA-256 under `INVITATION_DIGEST_KEY`, required in production) and a masked hint such as `j***@example.org`, never the address. At most 100
are pending per organization, they expire after 14 days, and a second pending invitation for the same address is refused (`409 invitation-pending`).
Nothing in the API creates a Cognito account or a membership from an invitation. The operator creates the account and runs
`db invite fulfil --id ID --email ADDRESS --sub SUB --by NAME`, which checks the address against the digest and grants the membership with the
invited roles and marks the invitation fulfilled in one transaction ([ops/membership.md](ops/membership.md#organizations-and-invitations)).

The **first administrator** of an organization is created the same way, by whoever applies the Terraform: `db tenant create`, the Cognito account from the console or CLI,
then `db membership grant ... --roles admin`. Until a person has a membership they are refused with 403, so the first deployment
starts with nobody able to use the API. Moving someone to another organization is `membership remove` there, a change of Cognito
tenant group, then `membership grant` in the new one; they are refused between the steps, by design (fail closed).

## Passwords and email

- A forgotten password is recovered **by email only**, from Cognito's own "forgot password" page. The code and its
  lifetime are Cognito's; it is not configurable here. Verify the behaviour at first apply.
- When a password is **reset**, a small Lambda (`infrastructure/lambda/password-change-notifier`) emails the account
  owner: no links, no codes, only "your password was changed, contact your administrator if this was not you". It
  can never fail the reset: on any error it logs and lets the reset complete. Either "notice lost" line (no email on the
  account, or the send failed) raises the `password-notice-lost` alarm on the audit topic, because the user does not know
  ([lambda.tf](../infrastructure/terraform/lambda.tf); its tests keep the filter and the handler's lines in agreement).
  Its log group keeps 90 days, encrypted with the service-logs key.
- **Gap:** a password changed while signed in (Cognito's `ChangePassword`) does **not** trigger that email, and this
  app offers no such screen. Closing it needs a CloudTrail/EventBridge rule; it is a follow-up.
- Mail goes through **SES**. A new SES account is in the **sandbox** and only delivers to verified addresses: request
  production access before inviting real users, or invitations and resets will silently not arrive.

## What is verified, and what is not

Verified here: the verifier against a fake identity provider with real RSA keys (forged keys, the HS256
public-key confusion attack, `alg: none`, ID tokens used as access tokens, wrong client, expiry, rotation, outage),
the whole API suite and the browser login flow against that provider, the production fail-closed rules, the
notifier, and Terraform `validate` plus a guard on the security settings.

**Not verified:** anything against **real Cognito** (the token's exact claims are taken from AWS's documentation),
real email delivery, `terraform plan`/`apply`, and Cognito's own session and code lifetimes.

### First-apply checklist (after the BAA, a reviewed `terraform plan`, and an apply)

1. Sign in once as a real invited user. Decode the access token (do not paste it into a website) and confirm
   `iss`, `token_use=access`, `client_id` and `cognito:groups`; confirm the API accepts it (`GET /api/v1/me`).
2. Confirm an ID token is refused by the API, a user with a tenant group but no membership row gets 403 from `/api/v1/me`, a member with no roles can sign in but change nothing, a user with no tenant group (or two) gets 403, and `db membership remove` makes the same access token refused on the next request.
3. Confirm MFA enrolment is forced at first sign-in, and that SMS is not offered.
4. Confirm the invitation, a password-reset code, and the password-change notice actually arrive (SES out of the sandbox).
5. Confirm sign-out ends the session (the next sign-in asks for credentials) and note Cognito's real session lifetime.
6. Confirm the app's origin is allowed by CORS and a different origin is not.

## Known gaps

No audit log of sign-ins in our own database (Cognito's CloudTrail events only; Phase 10), and membership changes are recorded in the security-event record (it is in the same database; an off-site Object Lock copy is a later slice). The membership checks were proved against a fake identity provider and a local PostgreSQL, not real Cognito or RDS. API rate limiting exists
but is per process ([ops/rate-limiting.md](ops/rate-limiting.md)); Cognito also does its own lockout on repeated bad passwords. Password-change-while-signed-in is not
notified (above). The sign-in page is Cognito's, unbranded for now (web design is parked).


## Upload recovery binding (F06, local integration)

`GET /api/v1/me` remains exactly `{ roles }`, including for old/cached clients whose parser rejects extra fields. `GET /api/v1/me/recovery-scope` separately returns the strict `{ recoveryScope }` capability under the same verified-token/current-membership guard. The scope is a deterministic SHA-256 correlator of the verified organization and subject, with a versioned domain separator. It is not an authorization credential, and cannot grant access; every API operation still checks membership, roles and tenant isolation. No raw organization/subject/email or bearer token is placed in the tab recovery record.

The new frontend checks permissions first, then the capability. A 404 from an older backend clears both recovery-record versions and creates an in-memory-only session guard: ordinary sign-in and same-page upload retry continue, but reload recovery is disabled. A 401/403, outage, network failure or malformed successful capability reply fails sign-in without a redirect loop. A rollback to an older backend therefore removes stored recovery safely; late callbacks remain retired even without a persistent scope. Already-built roles-only clients can use the repaired backend without fetching the new endpoint. This preserves their sign-in contract; it cannot retrofit the new ownership, expiry or callback guards into previously compiled JavaScript. Those clients must refresh to receive the recovery fix; hosted cache and rollout behavior still require separate acceptance. The earlier local F06 bundle that required a scope inside `/me` was never shipped and is superseded by this replacement branch.

The v2 tab record is offered only after the separate capability verifies the caller/organization. Another caller/organization, legacy v1 data, malformed data, future timestamps and records at least one hour old are discarded before the upload route mounts. The one-hour deadline starts at the first successful metadata save, is preserved across reload/reauthentication and retries, and removes idle metadata by timer (with read/focus checks for suspended tabs). A 401 or local token expiry retires old work while preserving the same caller's eligible record; explicit logout clears both versions. Retired upload callbacks cannot overwrite or clear a later session's record. Recovery still asks for the original patient and file, and reconciles original registration/declaration keys and server state before completion or cancellation.

Upload progress also retains a separate page lifetime: navigating away retires pending callbacks even if the same sign-in continues. Both page and authenticated-session checks run at request, response-body and persistence boundaries. Page retirement preserves eligible stored recovery for the next page and does not end the signed-in session.

Expiration removes browser metadata only. It does not cancel a server attempt or delete a report/file; existing server cleanup remains responsible. Client-side storage/clock tampering is outside this convenience boundary and never bypasses server authority. No clinical, database, role or retention policy changes are included.
