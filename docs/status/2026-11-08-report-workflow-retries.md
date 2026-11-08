# Report upload retries, merged history and status checks
Date: 2026-11-08

The workspace retains the registration request, report and upload-attempt identities after an interrupted response, so retrying reconciles the original upload. Success or acknowledged cancellation clears that progress; intentional later uploads receive new identities. Changing or removing an attachment keeps the previous failed upload cancellable, and cancellation blocks concurrent submission.

Report lists and stage counts accept the server's merged-patient group while preserving each report's original patient ID. Workspace status checks fetch the known report by ID rather than searching the first twenty oldest reports. Identifier conflicts compare patient UUIDs in PostgreSQL, so uppercase spelling no longer attempts to flag a patient as its own duplicate.

All four defects were reproduced before the fixes: two reports after a lost registration reply, rejected merged history and counts, a missing-list message for the twenty-first report, and HTTP 500 instead of 409 for an uppercase patient UUID (with and without a fresh registration request ID). Browser regressions use the existing PostgreSQL application role, real migrations, fake identity provider and Moto S3 harness; only response loss is injected. They cover merge/unmerge and unrelated-patient exclusion as well as retry reconciliation. Existing transport unit tests retain their stubbed API boundaries.

Verification results are recorded in the pull request. Synthetic data only; no deployment or clinical-use approval.
