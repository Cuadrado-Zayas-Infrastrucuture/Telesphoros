# Dashboard guided workflows

Approved scope: check the dashboard and add relevant questionnaire patterns (founder, October 15, 2026). Baseline: current main 23f17c4.

- Touch: UploadReportPage, ReportsPage, a shared QuestionnaireProgress component, token-based native-progress styling in workspace.css, status/verification notes and focused interaction/browser tests.
- Add optional three-step upload guidance, validation before navigation, review summary and retained native file input; keep the existing full form available.
- Add filename and storage-status filtering of the loaded report page only, explicit scope/counts, and reset/empty states. Never imply organization-wide search.
- Preserve: API calls, schemas, recovery/cancellation, clinical gates, role checks, routes, branding tokens, artwork and landing. No new dependencies, external services, persistence, backend or infrastructure changes.
- Founder-only decisions: deployment and clinical release; neither is part of this change. No PR requested.
- Risks: hidden fields losing values/focus; filtering leaving stale details; responsive layout. Controls: keep inputs mounted, focus steps/errors, clear selection on filter changes, test both form modes and desktop/mobile.
- Verify: frontend tests, lint, typecheck/build, brand rejection suite, permission checks and browser reflow/keyboard/expanded states. Report skipped database/S3 tiers; no schema change.

## Approved sidebar revision

Founder approved the sidebar/chat/drawer layout and requested Prompt Kit components. Reuse existing Prompt Kit source adaptations and the existing SDK synthetic transport; do not change model/prompt/transport behavior. Touch workspace layout/navigation, Reports presentation, SyntheticAssistant presentation, a shared native context drawer, shared layout sizes/styles, and interaction/browser tests. Keep the public landing, backend, authorization, recovery and synthetic/DEV boundaries intact. Move chat to its existing dedicated route, reports to their own work surface, and report metadata/example evidence to drawers. Verify native modal Escape/focus return, retained conversation across drawer actions, desktop/mobile and 200% reflow, brand rejection, build and permission checks.
