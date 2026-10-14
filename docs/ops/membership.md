# Membership: who may do what (operator runbook)

Added by M1.5. Cognito proves **who** a person is (and enforces MFA); the table `tenant_memberships` says **what they may do now**. The API
reads that table on every protected request, so a change here is effective on the person's very next request, on every API instance. The
design and the guarantees (including the commit boundary for writes) are in [auth.md](../auth.md#authority-and-revocation). Synthetic data
only; nothing here has been applied in AWS.

## Who can run it

Only an administrator with AWS access, as a **one-off task with the migration login** (`DATABASE_MIGRATOR_URL`, the table owner), the same way
as `migrate` and `provision-logins` ([api-hosting.md](api-hosting.md#the-database-logins-db-provision-logins)). There is no API endpoint for any
of this, by design: the API's own database login can only read the table, so nothing a request does can grant or remove anyone *except* through the
member-administration functions an organization's administrators use ([auth.md](../auth.md#member-administration-in-the-application-m21a)), which
are confined to their own organization, never themselves and never the last administrator. This command remains for the first administrator of an
organization, for break-glass, and for everything the application cannot do.

```
node dist/db/cli.js membership <command> --tenant ID --sub SUB ... --by NAME [--reason TEXT]
```

| Command | What it does |
| --- | --- |
| `grant --roles LIST` | Adds a person to an organization, or reinstates a removed one. Refused if they are already active here or active in another organization |
| `set-roles --roles LIST` | Replaces an active member's roles. Effective on their next request; they do not need to sign in again |
| `remove` | Ends access on their next request and refuses every token issued up to now. The row stays |
| `revoke-sessions` | Refuses every token issued up to now without removing the person or changing roles (they sign in again). Use after a lost device or a suspected leak |
| `show` | Prints the person's standing as the API sees it |

`LIST` is comma separated from `reader`, `clinician`, `admin`, `reviewer` (empty means no roles). `--sub` is the Cognito user's `sub`
(`aws cognito-idp admin-get-user ...`). `--by` is your name and `--reason` a short note; both are stored on the row, and the next change overwrites
them (the append-only trail is M1.6). The command prints one line per change and never a connection string or a token.

## Procedures

**Onboard a person.** 1) Create the Cognito account and add it to exactly one `tenant:<id>` group ([auth.md runbook](../auth.md#inviting-and-removing-people-runbook)).
2) `membership grant --tenant <id> --sub <sub> --roles clinician --by "<you>" --reason "..."`. The `--tenant` is the `<id>` part of the group name:
the two must agree or the person gets 403.

**Offboard a person.** `membership remove` **first** (this is the step that ends API access), then disable the Cognito user and run
`admin-user-global-sign-out`. If the order is reversed the person keeps API access until the next request after `remove`.

**Change a role.** `membership set-roles`. A downgrade also refuses a write the person had in flight (403, once), so nothing commits under the
old roles after the change.

**Reinstate.** `membership grant` again. Tokens issued before the removal stay refused (the person signs in once).

**Move a person to another organization.** `remove` in the old one, change the Cognito `tenant:` group, `grant` in the new one. They are refused
between the steps.

**The first deployment starts empty.** Nobody can use the API until the organization is registered and its first administrator is granted:
`tenant create`, the Cognito account, then `membership grant --roles admin`. A one-time import of existing Cognito users is not provided.

## Organizations and invitations

A membership must name a **registered organization** (a foreign key to `tenants`): a typo in `--tenant` is refused instead of creating an
organization nobody can see. Organizations are never deleted; they are suspended.

```
node dist/db/cli.js tenant create   --id ID --name NAME --by NAME
node dist/db/cli.js tenant list
node dist/db/cli.js tenant suspend  --id ID --by NAME
node dist/db/cli.js tenant activate --id ID --by NAME
node dist/db/cli.js invite list     --tenant ID
node dist/db/cli.js invite fulfil   --id INVITATION_ID --email ADDRESS --sub SUB --by NAME     # needs INVITATION_DIGEST_KEY
```

`ID` is lower-case letters, digits and hyphens and must equal the `<id>` of the Cognito `tenant:<id>` group. A **suspended** organization is
refused on every request (403) until `tenant activate`: use it to stop all access for an organization at once without touching its people.
Migration 0019 registered the organizations that already had memberships; an organization that only has records (no member) is registered by
`tenant create` before its first grant.

**Onboard a new clinic.** 1) `tenant create`. 2) Create the Cognito group `tenant:<id>` and the first administrator's account in it. 3) `membership grant --roles admin`.
From there the administrator invites and manages the others in the application.

**Fulfil an invitation.** The administrator records the invitation (address, roles). You create the person's Cognito account in the organization's
group, then `invite fulfil` with the address the administrator invited and the new account's `sub`. A wrong address, an expired, cancelled or
already fulfilled invitation, or a person who is already an active member is refused and changes nothing. `INVITATION_DIGEST_KEY` must be the
application's key, or no address will match.

## If something is wrong

| Symptom | Likely cause |
| --- | --- |
| A person gets 403 on every call | No active membership in the organization their token names, or the Cognito `tenant:` group and `--tenant` disagree. Run `show` |
| A person gets 401 after being reinstated | They are still using a token issued before the removal; signing in again fixes it |
| Everyone gets 503 | The API cannot read `tenant_memberships` (database down or saturated). Protected routes refuse by design; `/health` stays up and `/ready` shows the database |
| `grant` says "active member of another organization" | Remove them there first; a person is active in one organization at a time |
| A 401 right after signing in, repeating for about a second | The token was issued in the same second as a revocation; it clears on the next sign-in. Clock differences between Cognito and the database can lengthen this by their size |

The revocation instant compares whole seconds of the token's `iat` (Cognito's clock) with the database's `now()`. A token issued in the same
second as a revocation is treated as revoked. Clocks that disagree by more than a few seconds would shift that window; both services are NTP-synchronized.

## Local browser tests on PostgreSQL

The browser suite on the in-memory store needs nothing (the development mirror grants the test personas). The PostgreSQL browser suite
(`e2e:storage`) needs its personas granted first; see [local-storage-browser.md](local-storage-browser.md#memberships).
