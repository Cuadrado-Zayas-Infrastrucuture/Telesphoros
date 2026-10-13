# Modern reports dashboard and shared branding

Founder approved implementation with “go” on October 13, 2026, following the researched desktop/mobile sketch. Base: current main `d7569aa`, including owned synthetic storage browser and operations work. Branch: `feat/reports-dashboard-modern`; the previous staged branding checkout is preserved separately.

## Scope

1. Apply approved shared palette, Poppins headings, full-name company endorsement and square/genome company mark.
2. Present existing report metadata in a bounded list with patient filtering and a desktop detail panel. On mobile, selection opens a full-width detail view and Back returns focus to its source row.
3. Reuse existing 20-record report reads and independently paginated patient reads; extend the existing list helper rather than introducing a second transport.
4. Keep verified-file downloads through the existing owned-storage verifier, for clinician/reviewer/admin only. Upload remains clinician/admin; readers view metadata only. Preserve additive roles and safe failure messages.
5. Preserve loading/error height, clear stale rows/selection, ignore canceled replies, expose technical metadata in a native disclosure, and retain keyboard controls.

## Do not touch

No backend, database schema, tenant/auth policy, upload/download byte verification, infrastructure, clinical processing, real data, dependency change, or production action. Keep `/reports` registered only by the existing owned-storage opt-in; keep development routes under `import.meta.env.DEV`. Do not merge or rewrite the previous staged branch. No PR/push/deployment unless separately requested.

## Verification

Run frontend typecheck, lint, meaningful unit/refusal controls, production build and chunk/foundation guards. Verify desktop/mobile/200% text, keyboard and contrast with the actual browser stack. Run owned storage acceptance against a fresh disposable restricted-role PostgreSQL/Moto stack: verified PDF/VCF/JSON download, reader/reviewer permissions, no clinical processing or legacy fallback. Run standard product/development regressions and workspace checks appropriate to shared tokens. Report every skipped tier and external-service limitation.

## Decisions and provenance

The founder selected this visual direction and authorized implementation; no blocking visual decision remains. Brand source: refreshed v0.4 assets/tokens, prepared branding branch. Research: [Linear refresh](https://linear.app/now/behind-the-latest-design-refresh), [Vercel dashboard](https://vercel.com/changelog/dashboard-navigation-redesign-rollout), [CMS principles](https://design.cms.gov/guidelines/design-principles/). Sketch controls for role/state previews are excluded from application code.

## Draft PR delivery

On October 13, 2026, the founder explicitly requested a draft PR for this reviewed dashboard and shared branding. Commit/push/draft creation are authorized; merge, deployment and production actions remain outside scope. The branch was rebased onto current main `aec4bbf`, retaining its readiness fix and plan documentation. The only conflict was adjacent STATUS entries; both sets were preserved. Dashboard and shared UI source stayed identical to the locally reviewed implementation. The delivery includes two synthetic screenshot previews and refreshed local verification.
