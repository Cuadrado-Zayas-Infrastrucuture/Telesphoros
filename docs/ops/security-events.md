# Security events: what is recorded and how to read it (operator runbook)

Added by M1.6 ([plan](../design/plans/m1-6-security-events.md), [verification](../verification/m1-6-security-events.md)). The application keeps an **append-only record of
security-relevant acts**, separate from the clinical ledger (clinical facts) and from the diagnostic logs (no durability promise). Synthetic data only; nothing
here has been applied in AWS.

## What is recorded

| Event type | Written by | When |
| --- | --- | --- |
| `membership.granted`, `membership.reinstated`, `membership.roles-changed`, `membership.removed`, `membership.sessions-revoked` | a trigger on `tenant_memberships`, in the same transaction as the change | the operator command ([membership.md](membership.md)) or any other change to a membership row; the `details` hold the roles before and after |
| `access.refused` (reason `no-membership`, `removed`, `token-revoked`, `authority-changed`) | the application | a valid token is refused by the membership checks ([auth.md](../auth.md#authority-and-revocation)), or a write is refused at commit because the caller's membership changed under it. One event per person, organization and reason per minute |
| `file.link.issued` | the application | a report download link or a capture text link is created. The event is recorded **first**: if it cannot be recorded the request answers 503 and no link is created |

Not recorded here: sign-ins and sign-outs (the API cannot see them; Cognito's events are in CloudTrail, [audit-trail.md](audit-trail.md)), refusals for a missing
role (diagnostic logs only), and clinical reads (the clinical audit stream, a separate slice). An event means "authorized and the link was created", not "the file was
downloaded": the download happens at the object store, which CloudTrail's S3 data events cover.

Each event holds: time, organization, type, outcome, who (`person:<sub>`, or `operator:<the --by name>`), what it was about (a person's `sub`, a report id or a capture
id), the request id (to find the diagnostic log line), the database user that wrote it, and a few short codes. **No token, URL, signed link, file name, label, free-text
reason, e-mail address or patient value is ever stored**: the table accepts only a short list of keys holding strings of at most 64 letters, digits and hyphens.

## Who can write and read

- The application's database login has **no privilege on the table**. It can only call `security_event_append()`, which takes the organization and the person from the
  transaction itself (so a request cannot record an event for someone else's organization or in someone else's name) and refuses every event type except the two above.
- Nobody can update, delete or truncate a row, the table owner included.
- Only `telesphoros_security_auditor` reads. Its login is created by a person, outside the repository (like the ledger operator): choose a real name and keep the secret in the
  secret manager.

```sql
CREATE ROLE security_auditor_login LOGIN PASSWORD '<from your secret manager>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_security_auditor;
```

## Reading events

```
DATABASE_AUDITOR_URL=<the auditor login's connection string> node dist/db/cli.js security-events list --tenant ID [--since 2026-10-13T00:00:00Z] [--type membership.removed] [--limit 100]
```

Newest first, one JSON object per line, then a count. Default 50 events, at most 500. There is no API route or screen for it.

## Retention and what protects it

Events are kept with no delete path in the application or the command. When the off-site copy is built (a later slice, to the Object Lock audit bucket), honor at least
the 2,190 days already set for the CloudTrail logs ([audit-trail.md](audit-trail.md)); say if a different period applies. Until then the record lives only in the database:
it is in every backup, and the restore check compares the table's owner and privileges. **A person who can disable triggers as the table owner can still rewrite it**; the
off-site copy is what closes that, and that is not built yet.

A restore server needs the `telesphoros_security_auditor` role to exist (like the ledger roles); the restore check names it if it is missing.

## If something looks wrong

| Symptom | Likely cause |
| --- | --- |
| Download links answer 503 | The event could not be recorded: the database is unreachable, or `security_event_append` is not executable by the application role. Links are refused on purpose until it is fixed |
| A membership change fails with an integrity error | The event insert failed (for example a constraint on the table was altered). The change was rolled back; nothing happened |
| No `access.refused` for a refusal | Throttled (one a minute per person and reason), or the database could not be reached; refusals never block the response |
