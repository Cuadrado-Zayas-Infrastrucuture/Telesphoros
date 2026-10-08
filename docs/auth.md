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
4. The app calls `GET /api/v1/me`; the **server** answers with the user's roles. The UI uses them to decide
   what to *show*. The API enforces every permission itself, whatever the UI shows.
5. Each API call carries `Authorization: Bearer <access token>`. The API verifies the signature against the
   user pool's published keys, then reads `cognito:groups`: role groups give roles, and **exactly one**
   `tenant:<id>` group names the user's organization. The tenant is what row-level security binds every query
   to (see [database.md](database.md)); the token's `sub` (the individual) is only recorded as the author of what
   they create.

## Roles

| Cognito group | Role | May |
| --- | --- | --- |
| `reader` | reader | read their own data |
| `clinician` | clinician | read, create, change, upload |
| `admin` | admin | what a clinician may; reserved for administration |
| (no role group) | none | sign in, and see their tenant's data without changing anything |

A group name the API does not know is **ignored**, so nothing can grant a role by accident.

## Tenants

A **tenant** is an organization whose members share its records. Membership is a Cognito group named
`tenant:<id>`, where `<id>` is lower-case letters, digits and dashes (1 to 63 characters, not starting with a dash),
for example `tenant:acme-pharmacy`.

- Every user must be in **exactly one** tenant group. None, two or more, or a malformed one is refused with
  **403** after sign-in: the account is known but not set up. The browser shows "Your account is not set up yet"
  with no retry button. (A forged or invalid token is still a plain 401, so an attacker learns nothing about tenants.)
- Colleagues in a tenant see and edit each other's patients and reports, and each record remembers its author
  (`created_by`, taken from the token, never from the request). Neither the tenant nor the author can change
  afterwards: a database trigger refuses it, even for the table owner.
- Another tenant's records are indistinguishable from records that do not exist (404).
- Tenant groups are **data created by the runbook below, not Terraform**, so onboarding an organization needs no
  infrastructure change. Access tokens carry group names but not custom attributes, which is why the tenant is a group.
- There is no tenant registry yet: a typo such as `tenant:acmee` simply makes a separate, empty tenant. It fails safe
  (that user sees nothing) but is easy to miss, so check the list of groups when onboarding.
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

**Sign-out** clears the app's memory *and* ends Cognito's session. **Revocation is not instant:** a token
already issued stays valid until it expires (at most 15 minutes), because the API verifies tokens offline.

## Production fails closed

The API refuses to start with `NODE_ENV=production` unless: the verifier is `cognito`, no development
issuer/key-set override is set, storage is PostgreSQL with SSL, files are in S3, and CORS origins are
`https://`. The frontend's production build refuses non-`https` settings.

## Inviting and removing people (runbook)

There is deliberately **no API endpoint** that creates users: an API that could mint accounts would be a
privilege-escalation path. Accounts are created by an administrator with AWS access.

```bash
POOL=<cognito_user_pool_id output>

# Invite (Cognito emails a temporary password; the person sets a new password and enrols an authenticator app)
aws cognito-idp admin-create-user --user-pool-id $POOL --username person@example.org \
  --user-attributes Name=email,Value=person@example.org Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username person@example.org --group-name clinician

# Onboard an organization once, then add each person to it (every user needs exactly one tenant group)
aws cognito-idp create-group --user-pool-id $POOL --group-name tenant:acme-pharmacy --description "Acme Pharmacy"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username person@example.org --group-name tenant:acme-pharmacy

# Move a person to another organization (they are refused between the two steps, by design: fail closed)
aws cognito-idp admin-remove-user-from-group --user-pool-id $POOL --username person@example.org --group-name tenant:acme-pharmacy
aws cognito-idp admin-add-user-to-group      --user-pool-id $POOL --username person@example.org --group-name tenant:other-org

# Change a role
aws cognito-idp admin-remove-user-from-group --user-pool-id $POOL --username person@example.org --group-name reader
aws cognito-idp admin-add-user-to-group      --user-pool-id $POOL --username person@example.org --group-name clinician

# Offboard (disable, then end every session; any access token already issued lapses within 15 minutes)
aws cognito-idp admin-disable-user          --user-pool-id $POOL --username person@example.org
aws cognito-idp admin-user-global-sign-out  --user-pool-id $POOL --username person@example.org
```

The **first administrator** is created the same way, from the console or CLI, by whoever applies the Terraform.
Role and tenant changes take effect when the person's next access token is issued (within 15 minutes), so a person removed from a tenant keeps access for up to that long unless you also run `admin-user-global-sign-out`.

## Passwords and email

- A forgotten password is recovered **by email only**, from Cognito's own "forgot password" page. The code and its
  lifetime are Cognito's; it is not configurable here. Verify the behaviour at first apply.
- When a password is **reset**, a small Lambda (`infrastructure/lambda/password-change-notifier`) emails the account
  owner: no links, no codes, only "your password was changed, contact your administrator if this was not you". It
  can never fail the reset: on any error it logs and lets the reset complete.
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
2. Confirm an ID token is refused by the API, a user with a tenant but no role group can sign in but change nothing, and a user with no tenant group (or two) gets 403 from `/api/v1/me`.
3. Confirm MFA enrolment is forced at first sign-in, and that SMS is not offered.
4. Confirm the invitation, a password-reset code, and the password-change notice actually arrive (SES out of the sandbox).
5. Confirm sign-out ends the session (the next sign-in asks for credentials) and note Cognito's real session lifetime.
6. Confirm the app's origin is allowed by CORS and a different origin is not.

## Known gaps

No audit log of sign-ins in our own database (Cognito's CloudTrail events only; Phase 10). No rate limiting on the
API yet (Phase 9); Cognito does its own lockout on repeated bad passwords. Password-change-while-signed-in is not
notified (above). The sign-in page is Cognito's, unbranded for now (web design is parked).
