# Upload page retirement (local, approved 2026-10-15)

1. Start a race-only branch from main; preserve the reviewed F06 and F07 branches.
2. Reproduce F06-R01 through the real upload page, router and auth provider.
3. Retire started upload progress on page exit, independently of sign-in and request abort.
4. Guard late responses and parsed bodies before changing progress, recovery or making another request.
5. Preserve eligible saved recovery for a new page; retain server acknowledgement for cancellation.
6. Verify StrictMode cleanup replay, navigation, retry, reload and cancellation on desktop/mobile.
7. Verify a disposable composition with frozen F06 and its old/cached-client compatibility controls.
8. Record evidence and a local commit only; no push, PR, merge, deployment, schema, role, CORS or /me change.

The founder approved this scope before implementation. No new product decision was needed. See [verification](../../verification/upload-navigation-retirement.md).
