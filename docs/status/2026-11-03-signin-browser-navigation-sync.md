# Sign-in PR browser navigation synchronization

Date: 2026-11-03

PR #265's browser job (41548672393) failed two upload-recovery navigation cases: the interrupted-upload notice and acknowledged cancellation. Verify, image, secret-scan, service-memory, service-postgres-s3 and database-and-storage all passed on 70ea1c15. The failures have the same URL-before-React-commit race reproduced and repaired for #261/#264.

Apply the verified navigation helper here too: require the upload dialog to unmount and the workspace Question control to be visible before Back; require the restored dialog afterwards. Every original recovery-key, late-registration, identical retry and server-acknowledged cancellation assertion remains. No production code, retries, sleeps, longer deadlines, skipped tests, authentication or CI-policy changes.

The shared repair was proven with CPU-throttled Chromium (old helper 2 failures / 6 cases; fixed helper 6 passed), 30 ordinary repeated cases and hosted green browser jobs on the other repaired PRs. This branch is rechecked with its actual sign-in header and real loopback fake IdP, API and Moto S3. No live identity provider or cloud resource is used.

Branch-specific verification passed: rebuilt the normal E2E frontend, then ran all three recovery cases on both viewport projects with three repetitions (18/18 passed) against the real loopback stack. Existing source/unit/service checks passed on the prior head; fresh hosted CI must validate the pushed test-only correction. No generated screenshots or diagnostic files are included.
