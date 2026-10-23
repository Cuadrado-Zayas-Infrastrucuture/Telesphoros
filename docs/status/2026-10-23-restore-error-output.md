# Fix: a failing restore no longer prints row values (local)

Date: 2026-10-23

A candidate from the 2026-10-19 security audit, observed before the fix. When `pg_restore` failed while loading data, the restore check reported the first 300 characters of its error, and PostgreSQL's data-load errors quote the key (`DETAIL: Key (tenant_id, label)=(...) already exists.`) and the COPY context quotes the row. On a local cluster with a seeded marker value, the operator-visible text carried the tenant id and the patient label, and the full `pg_restore` error also carried the whole row line. That text goes to the terminal, into the log of a drill or job and into the restore report. It needs a restore that actually fails, and affects operator output only, not any API response.

`describeRestoreFailure` (`restore-failure.ts`) now decides what is shown: the exit code and, for a data-load failure (a `COPY failed` line or a `TABLE DATA` entry), only the table's name with a note that the database's message is withheld and the target server's log has it. A failure while creating objects keeps its first error line (schema text); `Command was:`, `DETAIL:` and `CONTEXT:` lines are dropped. Errors that did not come from `pg_restore` keep the old 300-character bound. `run()` and the other callers (`pg_dump`, `openssl`) are unchanged.

Verified: the new tests failed on the old behaviour (3 of 3 red), including one through the real `restoreAndVerify` path with a stand-in `pg_restore` that prints the observed text, and one with the real `pg_restore` on a conflicting throwaway database whose raw error is asserted to quote the row, so the test can fail. Six unit cases cover the data-load, INSERT-form, object-creation, over-long, file-problem and non-`pg_restore` shapes. Not changed: the errors the verification step throws after a successful restore (client messages without the DETAIL text), format-1 handling, migrations and CI.

Local only until the pull request is opened.
