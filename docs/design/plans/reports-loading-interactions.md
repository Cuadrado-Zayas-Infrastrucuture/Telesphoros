# Reports loading and interaction polish

Founder authorized implementation after the seven-reference design review: apply dashboard loading and interaction improvements while preserving shared branding, CMS principles, permissions and development-only boundaries. This slice starts from main `0e7e8d8`; dashboard PR #85 was already merged. Public landing and company pages remain separate work.

The founder subsequently requested changing the buttons and substantially iterating the design using those references. This extends the same uncommitted slice to the shared Button presentation, dashboard panel/toolbar/table/detail styling and presentation tokens. Core brand colors and fonts remain; an opaque white panel neutral, subtle elevation and 44/48/56px button sizes are added. Existing screens inherit the Button styling, so their standard and DEV browser suites are included in verification. See [the design iteration record](../../verification/reports-design-refinement.md).

## Scope

- Show decorative report-shaped skeleton rows inside the existing bounded table, with one live loading message and static reduced-motion rendering.
- Keep patient filtering easy to reverse, provide direct retry/first-page recovery, and retain focus when recovery controls disappear.
- Preserve report selection/detail focus and make keyboard-focused rows easier to follow.
- Offer the empty-list upload link only through the existing writer-role check.

No backend, API/schema, authentication/tenant policy, download verification, route registration, clinical processing, production configuration or dependency changes. No deployment. No new scheduling, search or AI feature. No further founder decision is needed for this approved scope.

## Verification

Run frontend unit tests, typecheck, lint, production build and chunk/foundation guards. Exercise the owned synthetic PostgreSQL/Moto stack at mobile and desktop widths, including a delayed/failed read, stable layout/focus, reduced motion, accessibility, filter recovery, existing upload/download permissions and clinical refusal. Inspect captured loading/error/detail views. Record actual results and limitations in the verification note.
