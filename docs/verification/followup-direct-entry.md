# Direct follow-up entry verification
Date: 2026-11-02

Scope: the founder's continued physician-workflow direction, implemented as the [direct-entry slice](../design/plans/followup-direct-entry.md). AI generated this change and its tests. Existing local work is preserved. No migration, backend contract, inference provider, external notification or publication is introduced.

## Behavior evidence

Six new scenarios run against the existing owned PostgreSQL/Moto/fake-IDP stack, using real authenticated patient/medication/follow-up APIs for fixture creation. They cover a thread beyond the patient's first 20 entries, reloading its latest version after reschedule, saving only that thread, preserving the chat draft, closed reminders without a form or extra record, reviewer read-only history, stale-save refusal with retained physician text, cancel navigation, failed-read retry, invalid UUIDs and a thread belonging to another patient. Successful save and cancel remove only the `followup` parameter; unrelated query parameters survive.

The baseline without the new action failed because the expected Open follow-up link did not exist. Two earlier setup attempts are not counted as behavior evidence: importing the runtime shared-types barrel hit a JSON-import-attribute incompatibility in the browser test runner, and the pagination helper initially tried to advance past its disabled last page. Fixtures now read the repository's bundled drug-list JSON directly, as the existing medication browser suites do, and the helper stops at the final page while retaining the exact-target assertion.

All **12 focused browser cases** passed at 375×812 and 1280×800. A targeted mutation removed the closed-reminder condition from the editor guard. The unchanged closed-reminder test failed with `expected 0 forms, received 1`. The source was restored byte-for-byte; the final regression uses the restored guard. No mutated production artifact is retained as the final build.

The selected editor reads once for its patient/thread, aborts on unmount, and holds its version while editing. It does not subscribe to background follow-up refreshes. The stale-save case changes the thread through the real API, triggers window focus, then proves that save still uses the loaded version and receives a conflict without losing the note or inserting another record. The current-entry read also checks patient ID, thread ID and the server's current flag before presenting an editor. API authorization and optimistic writes remain the existing backend responsibility.

## Final checks

- Full product-demo browser regression: **30 passed**, covering desktop and mobile, including the 12 direct-entry cases and existing chat/upload/response-summary flows. Expanded forms and read-only states passed their accessibility and horizontal-overflow assertions.
- Workspace typecheck, lint/format and build: **passed**. Final frontend lint, synthetic demo build, chunk budget and foundation checks also passed (100.9 kB gzip entry against a 150 kB budget; 13 dynamic pages, 147 foundation components).
- Infrastructure: **285 passed**. CI configuration: **217 passed**. Status fragments: **12 passed**.
- Root `pnpm test`: **failed** at the backend with **2,075 passed, 2 failed, 466 skipped**. The same previously observed subprocess process-tree cleanup assertions failed in `subprocess-report-reader.cancel.spec.ts` and `subprocess-report-reader.wrapper.spec.ts`; neither file was changed. These failures remain unresolved. Other completed tiers: workspace scripts 47, password notifier 10, CPIC schema 48, jobs 20, fake IDP 7, shared types 137, AI service 347, worker 151 and SMART pilot 188 passed.
- Separate frontend suite: **694 passed** across 62 files, plus **55 passed** branding/preview checks. It was run separately because the root command stopped at the backend failures.

Visual inspection of the final mobile selected entry and desktop closed entry confirmed visible patient/medication context, readable wrapping, a compact documentation form and accessible return/history controls. Six final screenshots are retained outside the repository in `/workspace/investor-demo-assets/followup-direct-entry/`, including `mobile-selected-followup.png` and `desktop-closed-followup.png`. No real patient data was used.

After inspecting its written blast radius, owned synthetic stack `653337db-9da6-4e7c-a3cb-9a9ea6b2ea61` was removed through the UUID-scoped teardown. Initial attempts met the monitor's operation lock; a bounded retry retained all ownership checks and completed with `Owned teardown verified.` No foreign service or shared database was removed. Local evidence logs are `/tmp/telesphoros-investor-tools/entry-*.log`; no push, public preview or deployment was attempted.

The browser failure/retry scenario injects one 503 at the HTTP transport boundary, then uses the real endpoint. Other records and permissions use the actual application and database. The fake identity provider and local S3 emulator remain the existing controlled substitutes. The full backend PostgreSQL/S3 suites, private reader engine, hosted CI and clinical validation are outside this frontend-only change; service-tier skips in the default command are not passes.
