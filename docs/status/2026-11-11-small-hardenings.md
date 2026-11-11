# Every closed route is tested without a token; the route pin had DELETE and PATCH swapped

Date: 2026-11-11

Three of the small hardenings from the founder's security checklist review (2026-11-11). Tests and build scripts, plus one response header.

- **Every route without a token.** `apps/backend/test/unauthenticated-routes.e2e-spec.ts` sends every route that is not `@Public()` a request
  with no `Authorization` header, with a non-bearer header, and with a bearer value that is not a token, and requires `401 UNAUTHORIZED` from
  each. Its control checks that exactly `GET /health` and `GET /ready` are public and that one answers without a token. `route-set.e2e-spec.ts`
  pins the same thing from metadata; this one sends the requests, so a guard change that leaves a route open fails here (shown by opening
  the `list` handlers in the guard: the test named each one).
- **Found while writing it:** `test/helpers/route-table.ts` named methods in the wrong order (`PATCH` before `DELETE`; Nest numbers DELETE 3
  and PATCH 4), so `test/route-set.json` listed the four DELETE routes of patients, identifiers, members and invitations as PATCH. The order
  is fixed and the file regenerated with `UPDATE_ROUTE_SET=1`; only those four labels changed. Who may call each route did not change.
- **`Permissions-Policy` on the API**: `camera=(), microphone=(), geolocation=()`, the same value as the web app's CloudFront policy, on
  every response including errors (`security-headers.e2e-spec.ts`).
- **No credential-shaped text in the published frontend.** `apps/frontend/scripts/check-bundle-secrets.mjs` scans a built bundle for value
  shapes (AWS access key ids, private keys, GitHub, Slack, Anthropic, OpenAI or Stripe and Google keys, JSON Web Tokens), printing the file
  and the kind but never the text. `scripts/staging/publish-frontend.sh` refuses to upload a set that has any, and
  `build-vercel-preview.sh` refuses to finish. gitleaks already checks the repository's history; this checks what a build is about to publish.
  The current build passes it, source maps included.

Proved: the new route test (4 cases over every closed route) and a mutant it catches; `route-set` and `no-role-reads` with the fixed
labels (44 tests together); the header test; the scanner's own tests (one sample per pattern, built from pieces so none sits in the
repository) and a publish test that a leaky bundle is refused with nothing uploaded; backend tier 1 (2238 passed); `pnpm test:infra` (462);
the frontend script tests (59). Not run in this session: the database tiers (nothing here touches storage).

Still open from the review: schema checks on the five hand-built responses (a separate pull request), the privacy policy (a draft, for
counsel), and the four tables left unforced (#371).
