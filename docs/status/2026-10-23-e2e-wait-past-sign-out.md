# Fix: browser tests wait past the sign-out second before signing in again (local)

Date: 2026-10-23

Making sign-out reach the server (the sign-out path fix) turned a silent no-op into a real cut-off, and the API refuses a token issued in the same second as the cut-off (`issuedAt <= tokensValidAfter`, whole seconds). Two browser tests sign out as `alice` and then sign in as `alice` again almost at once: `auth.spec.ts` "signing out" (its own re-sign-in) and `upload.spec.ts` "signing out clears an interrupted upload", whose successor "a different verified caller after a 401" starts with a fresh `alice` sign-in. Whenever both fell in one second the new token was refused and the page stayed on `/auth/callback` until the 30 s timeout, so the `browser` job failed intermittently on unrelated pull requests.

The tests now call `waitPastSignOutSecond` (1.1 s, in `e2e/helpers.ts`) after a product sign-out, the same wait the backend sign-out spec uses. The API rule is unchanged: it is the security control.

Verified locally with the CI worker count (`--workers=1`), `auth.spec.ts` and `upload.spec.ts` on both profiles: without the change 4 runs failed 2, 2, 2 and 4 tests, every one of them one of those four predicted (the two tests on each profile); with the change 5 of 5 runs passed 50 of 50. A first attempt with Playwright's default worker count (several workers sharing `alice`) showed unrelated failures from concurrent sign-outs and is not representative of CI. Not covered: the whole browser suite and the hosted job were not run here.

Local only until the pull request is opened.
