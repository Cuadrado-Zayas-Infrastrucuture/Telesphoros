# Shared brand contract

The updated product/company identity uses Inter for readable editorial and application content, Poppins for existing wordmarks, dark teal text, seafoam surfaces and restrained component borders. Operational screens use a compact type hierarchy and opaque data surfaces.

## Required choices

| Element | Rule |
|---|---|
| UI body | `--font-family-sans` (locally bundled Inter) |
| Dashboard headings | `--font-family-ui-heading`, compact 500-weight hierarchy |
| Wordmarks | Existing Poppins `--font-family-heading` |
| Landing content | Existing Inter `--font-family-landing`; landing layout remains independent |
| Text | Reports use approved `--dashboard-foreground` (#173E47) and `--dashboard-muted-foreground` (#36515A); other surfaces use shared dark teal text. Decorative accent is not body text |
| Controls | Existing components and approved fills; minimum shared target 2.75rem (44px at the default root size) |
| Status | Semantic success/warning/error tokens, expressed as words; never decorative badges |
| Artwork | Exact approved company/product logos, original static DNA, unchanged mascot and bundled fonts |
| Data surfaces | Opaque, with clear borders and restrained depth; no blur over operational information |
| Accessibility | Visible focus, readable text and role/state labels; verify reflow and keyboard behavior |

The canonical values live in `apps/frontend/src/styles/tokens.css`. The reviewed policy in `apps/frontend/scripts/branding-policy.json` pins the core palette, font roles, minimum control token, required component/asset references and artwork/font SHA-256 hashes. An asset replacement requires deliberate founder review; hashes must not be regenerated as a workaround.

## Enforcement

`pnpm --filter @telesphoros/frontend check:brand` checks both frontend and SMART UI sources. It rejects token drift, changed assets, page-local font loading, literal colors outside tokens, external CSS/font imports, unapproved inline font/color declarations, foreign palette utilities, arbitrary Tailwind utilities, poor key contrast pairs, missing dashboard typography and removal of either build gate. Original DNA/mascot selectors cannot acquire animation or filters.

The `telesphoros-branding` Vite plugin runs this check in `buildStart`. Both frontend and SMART pilot configurations include it, so normal builds and direct `vite build --mode …` invocations are gated. Root workspace builds and CI already use those configurations. Backend-only builds do not produce a UI and do not need visual rules.

`pnpm --filter @telesphoros/frontend test:brand` runs mutation tests against in-memory copies of the real source/policy. The frontend test command includes those tests. They prove violations are rejected without changing real artwork or production data.

## Limits and review requirements

Static checks enforce a finite contract, not every possible CSS behavior. They do not certify clinical safety, accessibility, naming quality, layout or appearance. Verify actual computed fonts, contrast, touch targets and desktop/mobile states in a browser. Refer to existing browser acceptance tests for role-aware upload/download and development-route exclusions.

Approved spacing and typography should use shared utilities/tokens; adding a new component is not permission to invent another palette. Brand changes require explicit approval and a reviewed policy update with visual evidence. Existing permission and development boundaries remain authoritative.

The company page is currently a separate local sketch. It has no repository build pipeline yet. Apply this contract when that sketch is implemented in the company repository; this check does not pretend to guard external repositories or standalone HTML files.
