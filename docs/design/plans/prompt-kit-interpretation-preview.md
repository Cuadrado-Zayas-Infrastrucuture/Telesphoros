# Prompt Kit explanation preview

Approved by founder in this conversation on 2026-10-13: “Go ahead with the development preview using Prompt Kit, keeping our branding and synthetic responses only.”

## Scope

Use vendored, MIT-licensed Prompt Kit input/message primitives with the existing Telesphoros tokens and controls. A selected report links to a separate, authenticated `/local-interpretation` development route. This route receives no report ID, patient ID, file content or router state. Show fictional report context beside hand-authored sample explanations and honest fixture attribution. No fabricated guideline citations or pharmacologic recommendations.

Same existing protected-route authentication as other DEV previews; exploring fixtures does not confer upload, download, review or clinical permissions. Restrict rendering to DEV on 127.0.0.1, and exclude route, link and fixtures from production assets. Preserve existing storage-mode boundaries.

Prompt Kit is the UI layer. No Vercel AI SDK/model transport, provider credentials, clinical prompt, endpoint, data persistence or telemetry is added. Unknown questions receive a fixed fallback. The initial preview kept one current exchange; the approved continued iteration below expands it to six bounded exchanges. It offers simulated loading/stop/error/retry/reset, and clears on unmount. Existing dashboard changes stay intact.

## Method and acceptance

1. Inspect repo call sites/history and upstream source/license; use pinned components without introducing a second theme.
2. Implement the local preview and report link; no production/backend/auth/schema/deployment changes.
3. Verify no request/storage side effects, production exclusion, cancellation/reset/unmount, source labels, keyboard and IME handling, and report-context isolation.
4. Inspect desktop/mobile images, axe results, 200% text, reduced motion and regression suites; repair issues before declaring completion.

Live model integration and actual PGx interpretation remain separate founder decisions requiring clinical/evaluation/privacy scope. No new PR, deployment or merge requested by this slice. Current uncommitted dashboard branch is retained; fetched main advances only with #92's separate planning document. Before delivery, reconcile with then-current main and review the complete intention.

## Source

Prompt Kit: https://github.com/ibelick/prompt-kit/tree/5a9496635cc0e1bf7679fe2a9e35d9b36b99c08a (retrieved 2026-10-13). Provenance/adaptations and MIT notice: `apps/frontend/src/components/prompt-kit/README.md` and `LICENSE.md`.

## Approved continued iteration (2026-10-13)

Founder requested more Prompt Kit components and a visible Telesphoros logo, plus verification of OpenAI SDK and Vercel AI SDK. Continue the existing synthetic scope: restore the existing shield/Rx raster unchanged; add bounded conversation history, scoped local attachment metadata preview (existing writer roles only), bundled source-image preview, local feedback, source/method/tool disclosures, staged loading/shimmer and a functional latest-message control. Process summaries are visibly simulated, not raw chain-of-thought. No file bytes, SDK integration, API transport, live model, real clinical evidence or production workflow is added. Verify SDK docs and record a future architecture recommendation separately. Shared header branding changes apply existing pages and require their browser regression.

## Approved continuation: Vercel AI SDK (2026-10-13)

Founder requested “apply Vercel AI SDK” and confirmed the synthetic-only plan with “ok”. Replace the manual chat lifecycle with real `useChat`, using an in-memory synthetic transport. Preserve Prompt Kit presentation, branding, bounded messages, permissions, no report inputs and production exclusion. Verify actual package API/Node compatibility, stop/reset/unmount cleanup, retry without duplicates, no network/storage calls, accessibility and browser regressions. No live provider, clinical prompt or model, credentials, server endpoint, deployment or production workflow change is authorized by this continuation. This supersedes the earlier SDK-package exclusion only.
