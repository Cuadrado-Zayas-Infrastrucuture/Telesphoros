# Telesphoros UI — strict branding rules

- Follow the global workflow and permission rules; this file adds UI constraints.
- Read `../../docs/design/branding.md` before changing UI. Use the existing components and shared tokens.
- Inter is the content font. Dashboard headings use `--font-family-ui-heading`; wordmarks retain Poppins.
- Define fonts and literal colors only in `src/styles/tokens.css`. Do not add inline fonts/colors, external font services, foreign palette utilities or arbitrary Tailwind values.
- Preserve approved logo, mascot and font files. Never recolor, redraw, animate or filter them. Retired artwork (listed under `retiredAssets` in `scripts/branding-policy.json`, including the watermarked DNA image) must never return, under any filename.
- Blur only through `components/motion-primitives/ProgressiveBlur` at a scroll edge, with the scrolling content padded by `--size-blur-edge`. No glass, frosted panels or blurred backdrops; the brand gate rejects them.
- Keep button fills and semantic status colors distinct from decorative brand accents. Status is expressed as words.
- Keep controls at least 44px high, visible keyboard focus and readable contrast. Browser-check desktop/mobile and expanded states; Reports primary details and composer must fit together at 1280×800 with default text size.
- Both Vite configurations must include `brandingPlugin`. Do not bypass, weaken or silently regenerate the policy to make a failing build pass.
- A rebrand requires explicit founder approval, a reviewed update to `scripts/branding-policy.json`, and new visual/contrast evidence.
- Synthetic examples remain synthetic. Preserve role-aware actions, guarded routes and development-only AI boundaries.
- Run build, lint, relevant permission tests and brand rejection tests; report checks not run.
