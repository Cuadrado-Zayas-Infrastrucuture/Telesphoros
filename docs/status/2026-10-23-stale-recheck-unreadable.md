# The stale re-check no longer counts an unreadable file as checked (2026-10-23)

Date: 2026-10-23

**Implemented (migration 0035, labelled `breaking`).** From the foundation-layers audit (layers 3 and 12, Medium, confirmed; recorded in the 2026-10-21 status entry as needing a migration). `file_verification_stale` took the newest check time over every outcome, so a report whose only record was `unreadable` (the store could not be read) looked freshly checked and was not handed out again for 30 days; the job's own retry skipped it too. Now only `ok`, `missing` and `changed` count as checks; `unreadable` does not. Reports are handed out never-attempted first, then least recently attempted, so one that keeps failing goes to the back of the batch and cannot starve the others. One function body replaced (same signature, owner and grants); the down file restores the 0024 body.

**Tests, written first.** Three new tests in `apps/worker/test/consumers.s3.test.ts` were run against the old function and failed for the right reasons (expected two due reports, got none; expected four in order, got three; the retry left only `['unreadable']`), then passed with the migration: a report whose last read failed is due, while one just verified, found missing or found changed is not; the order described above; and a real handler run in which the store is down on the first attempt and back on the retry, which now looks at the same report again and ends with `['unreadable', 'ok']`.

**Risk and cost.** `CREATE OR REPLACE FUNCTION` is `breaking` under the migration lint: an older image keeps running but would hand reports out by the old rule until replaced. Nothing is deployed yet, so no outage window is spent. A file that stays unreadable adds up to three `unreadable` rows a day (the job's attempts). Handler code, schedules, the other functions and Terraform are unchanged.

**Not established.** Nothing observed in AWS. The batch order under a very large number of persistently unreadable reports was reasoned about and tested with four reports, not at volume.
