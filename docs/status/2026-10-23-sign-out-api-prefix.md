# Fix: sign-out called a path that does not exist (local)

Date: 2026-10-23

Found by the security audit. `AuthProvider` ended the server-side sessions with `POST {apiBaseUrl}/me/sign-out`, but the API is served under `/api/v1` and every other call carries that prefix. The server answered 404, `send` returns a response rather than throwing, so the `.catch` never ran and the failure was silent: the browser signed out and the person's older tokens stayed valid until their 15-minute lifetime ended, which is the behaviour AUTH-03 was meant to remove. The call now goes to `/api/v1/me/sign-out`.

Reproduced before the fix against the real backend app (a throwaway spec, not kept): `GET /api/v1/me` 200, `POST /api/v1/me/sign-out` 204, `POST /me/sign-out` 404. The unit test matched the URL with a suffix pattern, so it passed on the wrong path; it now answers and asserts the full URL, and goes red (2 failures) on the old path. The deployment edge routes `/api/*` and `VITE_API_BASE_URL` is a bare origin, so nothing rewrites the old path.

Not covered: the browser suites were not run for this change; the deployed edge was not probed.

Local only until the pull request is opened.
