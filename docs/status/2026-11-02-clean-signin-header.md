# Focused authentication screen header

Date: 2026-11-02

For signed-out visitors, authentication screens (`/signin`, `/auth/callback`, `/signed-out`, including trailing-slash variants) retain the product branding but omit the header navigation and account control. The sign-in page keeps its single primary action; signed-out users retain the page's sign-in link. Other routes and authenticated visitors retain their existing navigation.

The current main branch already includes dc472f4a, which suppresses a redundant header sign-in on `/signin`. The supplied staging screenshot still shows it, indicating an older deployed build. This change removes the remaining Overview detour too; deploying the reviewed frontend is necessary for staging to reflect it. No authentication request, return-to path, API/backend behavior, roles or identity-provider settings change.

Regression: entering `/workspace` initially failed the new test because the authentication header included Overview. The new contract verifies a navigation-free header, exactly one sign-in action and a `/workspace` return destination. Existing public-route assertions for the signed-out screen are updated to verify its single page-level sign-in link; existing route/accessibility tests remain enabled. Tests use the repository's synthetic identity and API harness.

Chromium review of the actual `/workspace` → `/signin` route with the repository E2E configuration passed at 390px and 1440px: one Sign in button, no header Sign in link, no Overview link, no header navigation, and no horizontal overflow. Automated axe reported zero violations. The local preview did not submit credentials or call a live identity provider. Focused sign-in and routing suites passed 23 tests.

Deployment note: docs/ops/frontend-publish.md describes a manual frontend publisher; CI and merging do not publish to the staging web bucket. The reviewed build must be published separately to make the fix visible there. No staging deployment or cloud mutation was performed for this change.

The full test run exposed an existing, valid contract for authenticated visitors to `/signed-out`: the header must still offer Reports. The cleanup is therefore limited to signed-out visitors, preserving that existing assertion and behavior. Root typecheck, lint/format and build passed; infrastructure guards passed 285/285 and CI configuration checks passed 217/217. The affected frontend checks are rerun after this refinement. The backend completed 156 suites / 2077 tests successfully; 27 suites / 471 tests were skipped for unavailable PostgreSQL/S3/reader-engine dependencies. Worker PostgreSQL/S3 tiers were also skipped. Other configured workspace unit tiers passed: shared types 206, CPIC schema 48, fake IdP 7, jobs 20, password notifier 10, worker 151, AI service 347 and SMART pilot 188.

A local desktop capture after selecting necessary-only storage is saved at docs/design/clean-signin/desktop.png. No paid service or live account was used.

Final affected-frontend rerun passed: typecheck, lint, 55 Node checks and all 695 Vitest tests across 63 files, plus the production build. Full application browser E2E and live Cognito were not run; local Chromium checks above exercised the real signed-out routes.
