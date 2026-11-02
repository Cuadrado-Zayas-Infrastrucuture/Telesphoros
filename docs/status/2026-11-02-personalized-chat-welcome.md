# Optional personalized chat welcome

Date: 2026-11-02

The empty chat now welcomes the signed-in user by an optional preferred name entered in Settings → Account. Without a name it shows “Welcome.” and retains the existing synthetic-report heading. The field accepts up to 80 characters and normalizes surrounding/repeated whitespace; saving an empty field removes the name.

The name lives in AuthProvider memory for this sign-in only. It is never sent to the API or saved in local/session storage, and the existing authentication clearing path removes it on sign-out, expired sessions and fresh sign-in. Reloading clears it. No identity-provider scopes, infrastructure, patient records or backend profile contracts changed.

Verification: the three new regression cases failed before implementation (missing name setter, Settings field and generic welcome). The focused AuthProvider, WorkspacePage and SettingsPage suites pass: 87 tests. Root check results are recorded below after completion. No production service or patient data was used.

Completed checks: root typecheck, lint/format check and build passed; infrastructure guards passed 285/285; CI configuration checks passed 217/217. The full frontend run passed 55 Node checks and 697 Vitest tests across 62 files. The initial typecheck caught an unsupported test-selector option, corrected without removing the assertion. Worktree dependency links were adjusted to resolve this checkout's shared packages.

Root tests are not fully green: backend had 2 failures in the unchanged report-reader subprocess wrapper/cancellation process-tree cleanup tests, 2075 passed and 471 skipped. Backend PostgreSQL, S3 and five reader-engine specs did not run because the required services/engine were absent. Worker PostgreSQL/S3 tiers also did not run. Other completed unit tiers passed: shared types 206, CPIC schema 48, fake IdP 7, jobs 20, password notifier 10, worker 151, AI service 347 and SMART pilot 188. Authentication/API dependencies in the new UI tests use the existing synthetic test harness; no live identity provider or production API was called. Browser E2E was not run for the application change.

Provider identity follow-up: an NPI and professional license belong in a separately verified provider profile, with jurisdiction and expiration. They are not sign-in secrets or proof of authorization. That profile and persistent preferred-name storage are outside this change.

Backend alignment checked against origin/main c7a4c9ee (unchanged upstream at verification): `/me` remains roles-only, `/me/profile` remains organization-only, and no preferred-name or credential property is sent to either endpoint. Targeted backend checks passed 27/27 across me.controller.spec.ts, me-profile.e2e-spec.ts and membership.e2e-spec.ts, covering strict profile responses, unauthorized callers, organization isolation, recovery binding and sign-out. These used the existing in-memory application harness and synthetic signed tokens, not live Cognito/PostgreSQL. Durable provider-profile storage and NPI/license verification remain follow-ups, not claims made by this UI.
