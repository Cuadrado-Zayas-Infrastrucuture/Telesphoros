# Implementation Plan: Progressive blur at scroll edges (PBE)

**Spec**: [spec.md](spec.md) · **Approved**: 2026-10-27 by the founder

## Approach

1. **Gate first.** Add the blur rule to `findBrandViolations` with an allow-list of two paths. Write the mutation tests before the rule and watch them fail.
2. **Vendor the component.** Copy `components/core/progressive-blur.tsx` from `ibelick/motion-primitives` at `92e944c0fee66006b4184bbaa5fef35ae3383bf7` (MIT), the same source the registry serves (checked byte for byte on 2026-10-27). Adapt it the way `components/prompt-kit/` was adapted:
   - a plain `div` instead of `motion.div`, so no new dependency
   - mask stops in `var(--foreground)` and `transparent` instead of `rgba(255,255,255,…)`, which the gate rejects; a mask reads alpha only, so the visual result is the same
   - `border-radius: inherit` in the stylesheet instead of the arbitrary `rounded-[inherit]` utility
   - `aria-hidden`, a layer clamp (2 to 8) and a strength clamp (0.5px per layer)
3. **Stylesheet.** `styles/progressive-blur.css`, imported from `index.css`: edge placement, the `--size-blur-edge` bound, and the opaque fallbacks.
4. **Token and policy.** Add `--size-blur-edge: 3rem` to `tokens.css` and pin it in `branding-policy.json`.
5. **Docs.** `branding.md` (Data surfaces row and Enforcement), `apps/frontend/AGENTS.md`, the `tokens.css` comment, and a README with the licence beside the component.

## Decisions

- **D1 Allow-list, not a heuristic.** Two paths may contain blur. That is easy to read in review, and widening it needs a reviewed change to the gate.
- **D2 Content padding is guidance, not enforcement.** The gate cannot know which container scrolls. The README and branding docs require the container to pad by `--size-blur-edge`; slice 3 checks this in the browser.
- **D3 No visual evidence in slice 1.** Nothing renders the component yet. Slice 3 provides browser screenshots and contrast checks where it is used.
