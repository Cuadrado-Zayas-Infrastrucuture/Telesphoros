# Privacy policy (DRAFT)

> **Draft for counsel. Not reviewed, not approved, not published.** Written on 2026-11-11 from what the code and infrastructure in this
> repository do on that date (sources in the last section). It must not be linked from the product or the company site until counsel has
> reviewed it and the founder has approved it. Text in [square brackets] is for the company to fill in; nothing here names a person.
> When the product changes what it collects, this draft changes in the same pull request.

**[Company legal name]** ("we") · Effective date: **[not yet in effect]** · Contact: **[privacy contact address]**

## 1. What Telesphoros is today

Telesphoros is pre-release pharmacogenomic decision-support software. It is **not approved for clinical use** and is not offered to the
public. Today it runs only as a closed test environment ("staging"), by invitation, for people working on the product.

- **No real patient data.** Every patient, report and result in Telesphoros is synthetic, made up for testing. Real patient information,
  including protected health information, must not be entered, and we do not ask for it.
- **No real users.** There is no public sign-up. Accounts exist only for people we invite to test the product; nobody else can create one.
- We have not signed a business associate agreement with our hosting provider, and Telesphoros is not used by or for any healthcare
  provider, health plan or patient. Before that changes, this policy will be replaced, not edited.

## 2. What we collect

About the people we invite to test it:

| What | Why | Where it is kept |
| --- | --- | --- |
| Email address, used as your sign-in name | To invite you and let you sign in | Our sign-in service (Amazon Cognito) |
| An authenticator-app registration (required second factor) | To protect your account | Our sign-in service |
| Your account's role and organization in the test environment | To decide what you may see and do | Our database |
| Sign-in and security events, and a record of requests | To keep the service secure and working, and to investigate problems | Our logs and audit trail |

The request records note which kind of request was made (for example "list patients"), when, by which account, and with what result.
They do not record request contents, web addresses with their parameters, passwords or sign-in tokens.

We also store the **synthetic** test records that testers create (made-up patients, reports and results). They describe no real person.

We do not collect real names, dates of birth, health information or payment details from anyone, and we do not use advertising or
analytics trackers.

## 3. Your browser

- **Sign-in:** while you sign in, your browser keeps a short-lived value in session storage that ends with the browser tab. Your sign-in
  token is kept in the page's memory only, not in cookies or browser storage.
- **Preferences:** display preferences (such as light or dark theme and sidebar layout) are saved in your browser's local storage **only if
  you allow it**, and you can change that choice at any time.
- **Uploads:** an unfinished upload may keep a small record in session storage, for at most one hour, so it can be resumed. It holds no file
  name, file content or token.

## 4. How we use it, and who else sees it

We use this information only to run, secure and improve the test environment. We do not sell it, rent it or share it for advertising.

It is processed by our hosting and infrastructure provider, Amazon Web Services, in the United States (region us-east-2), which runs the
servers, database, file storage, sign-in service and email for us. [Counsel: list any other processor, for example the company website's
host, if this policy is meant to cover it.] We may disclose information when the law requires it.

## 5. How long we keep it

- Accounts: until you or we close the account. [Counsel and founder: set the period after closing.]
- Service logs: up to 365 days. Audit records: as long as the law and our security obligations require [counsel: set the period].
- Synthetic test records: as long as the test environment needs them; the test environment can be erased as a whole.

## 6. How we protect it

Data is encrypted in transit and at rest with keys we manage, sign-in requires a second factor, each organization's records are separated
in the database, and access is limited to what each role needs. No system is perfectly secure; if we learn of a breach that affects you,
we will tell you as the law requires.

## 7. Your choices and rights

You can ask us to see, correct or delete your account information, or to close your account, by writing to **[privacy contact address]**.
[Counsel: add the rights that apply in the places testers are, for example under state privacy laws.]

## 8. Children

Telesphoros is not meant for anyone under 18, and we do not knowingly collect information from children.

## 9. Changes

We will update this policy when what we collect changes, and change its effective date. Before Telesphoros handles any real patient data
or opens to anyone beyond invited testers, it will get a new policy (and, where required, a notice of privacy practices), reviewed by counsel.

---

## Sources (for the reviewer; not part of the policy)

Each statement above was checked against this repository on 2026-11-11 (`main` `f105272`):

- Synthetic only, not approved for clinical use, BAA not executed: `CLAUDE.md`; `docs/ops/environments.md` (staging table).
- No self sign-up, invite-only, authenticator-app second factor, email as username: `infrastructure/terraform/cognito.tf`
  (`allow_admin_create_user_only = true`, MFA required, software token only).
- What request logs keep and leave out: `apps/backend/src/logger-options.ts` (route template, method, status, timing, tenant and user ids; no
  path, query, body or headers; `Authorization` and cookies redacted); worker: `packages/jobs/src/log.ts`.
- Browser storage: `apps/frontend/src/auth/authClient.ts` (token in memory; sign-in state in session storage),
  `apps/frontend/src/lib/storageConsent.ts` (preferences only with consent), `apps/frontend/src/lib/uploadRecovery.ts` (one hour, no file
  name, token or bytes).
- No analytics or advertising trackers: no such package or script in `apps/frontend`; the web app's content security policy allows
  connections only to the API and the sign-in service (`infrastructure/terraform/web.tf`).
- Region and provider: `infrastructure/terraform/variables.tf` (`us-east-2`), `docs/ops/environments.md`.
- Log retention 365 days (API, worker): `api_log_retention_days` default in `infrastructure/terraform`; audit trail retention in
  `infrastructure/terraform/audit.tf`.
- Encryption and per-organization separation: KMS keys in `infrastructure/terraform/kms.tf`, `database.tf`, `storage.tf`; row-level security
  catalog test `apps/backend/test/db/tenant-rls-catalog.pg-spec.ts`.

Not covered by this draft: the company website (`telesphoros-site`, a separate repository and host), which may set its own cookies.
