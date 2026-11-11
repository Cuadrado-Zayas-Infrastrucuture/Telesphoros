# Observability gaps and backup options, reviewed

Date: 2026-11-11

The founder asked for a review of observability and for options to automate backups, which are done by hand today.
[The review](../design/plans/observability-and-backups.md) is proposed and not yet approved.

Observability, most important gaps first: every alarm reaches one email address and none reports recovery; the frontend has no error
reporting or outside check; the only outside probe runs once a day; there is no latency alarm; the burstable database has no
credit or memory alarm; a user's error cannot be traced to a log line; there is no cost alarm.

Backups: no restore of the real database has ever been done; staging keeps automated backups for one day; there is no copy outside the
account; no alarm reports a missing backup; pre-migration snapshots are never deleted. Options: AWS Backup with restore testing as the
floor, the existing off-site design (decisions B1 to B4 in [backup-scheduling-decisions.md](../design/plans/backup-scheduling-decisions.md),
still open), and small changes now (7-day retention, snapshot cleanup, a first point-in-time restore drill).

Also corrects the Report files row in [environments.md](../ops/environments.md): production keeps report files on GOVERNANCE with a six-year
minimum; only the audit bucket must be COMPLIANCE. No code, Terraform, CI or AWS change.
