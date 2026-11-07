# Synchronize browser upload recovery navigation with the rendered workspace

Date: 2026-11-03

PR #261's browser job failed three upload-navigation recovery checks. The original tests passed 30/30 ordinary repeated cases locally; throttling Chromium's CPU reproduced the missing interrupted-upload notice. Its error context showed the original populated form with an upload failure, not a remounted recovery form: History changed away and back before React committed the intermediate workspace route.

The navigation helper now additionally requires the upload dialog to unmount and the workspace question control to be visible before going Back, and requires the restored dialog to be visible afterwards. All original assertions remain: same recovery keys, no additional registration, identical retry declaration, no replacement by a late registration, and cancellation clearing only after the server acknowledges it. No arbitrary sleeps, retries, longer committed timeouts or production-code changes were introduced.

The local reproduction uses the real test-only identity provider, API, in-memory application storage and Moto S3 on isolated loopback ports. Slow-CPU diagnostic copies and port configuration are temporary and are removed before commit. No live service, account or cloud data was used.

Verification: the original helper failed 2 of 6 slow-CPU browser cases; the fixed helper passed all 6 under the same throttle. The committed tests (original 30-second timeout, no throttle or extra retries) passed 30/30 repeated cases across mobile and desktop. The unchanged original also passed 30 ordinary cases before the stress reproduction, confirming the failure is intermittent without controlling browser speed. All temporary diagnostic configuration, generated build and copied tests were removed. Other checks passed on the earlier PR head; CI will rerun on this test-only repair.
