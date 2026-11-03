# Reconcile duplicated upload navigation after the skeleton branch merge

Date: 2026-11-03

PR #264 passed its browser and database/service checks at ad8b7e59. Merge commit 9733bfd1 combined its upload navigation helper with the independently repaired helper from main, retaining both sequences. After the first Back reopened the upload dialog, the second sequence required that dialog to be absent again. All six recovery browser cases therefore failed deterministically at that contradictory assertion in hosted run 41555866916.

The current merged-head failure was reproduced locally before changing the test. Restore the single helper already in main: close the upload panel, verify workspace URL, verify actual panel unmount and visible Question control, go Back exactly once, and verify the upload URL and restored panel. The entire test file now matches main's version, avoiding a competing helper edit in this PR. All original recovery-key, late-registration, idempotent retry, cancellation-acknowledgement and sign-in assertions remain. No retries, sleeps, longer deadlines, skipped tests or production-code changes.

Verification uses the built frontend, test-only identity provider, API and disposable Moto S3 on loopback. No real credentials or cloud resources are used.

The deterministic pre-fix browser reproduction failed at the second dialog-absence assertion, exactly matching hosted CI. With the helper reconciled, all three original recovery cases passed on mobile and desktop with three repetitions (18/18). The status-fragment guards also passed. Other hosted verify/image/service/database checks passed on 9733bfd1; fresh CI validates this test-only repair separately. The complete local browser command is also rerun, with results recorded in the PR.
