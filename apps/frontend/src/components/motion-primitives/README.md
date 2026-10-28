# Motion Primitives adaptations

Source: https://github.com/ibelick/motion-primitives/blob/92e944c0fee66006b4184bbaa5fef35ae3383bf7/components/core/progressive-blur.tsx
MIT © 2024 ibelick. License retained beside these components. The registry entry (`npx motion-primitives@latest add progressive-blur`) served the same file on 2026-10-27.

`ProgressiveBlur` is the only place the app may blur ([spec 005](../../../../../specs/005-progressive-blur-edge/spec.md)); the brand gate rejects blur anywhere else. Changes from upstream:

- A plain `div` instead of `motion.div`. Upstream used it only as a pass-through, so the `motion` dependency is not added.
- Mask stops are `var(--foreground)` and `transparent` instead of `rgba(255, 255, 255, …)`. A mask reads alpha only, so the result is the same and no literal colour enters a component.
- The blur and mask are set as custom properties and applied in `styles/progressive-blur.css`, which also replaces the arbitrary `rounded-[inherit]` utility.
- `aria-hidden`, `pointer-events: none`, 2 to 8 layers, and at most 0.5px a layer (3.5px deepest).
- The overlay is bounded to `--size-blur-edge` (3rem). With `prefers-reduced-transparency: reduce`, or without `backdrop-filter` support, it draws an opaque fade in `--background` instead.

Use it inside a `relative` scroll container (or its non-scrolling wrapper), on the edge where content leaves. Pad the scrolling content by `--size-blur-edge` on that side, so nothing is under blur at rest. Never use it over a panel, card, dialog or image as glass.

The opaque fallback fades to `--progressive-blur-ground`, which defaults to `--background`. A container on another surface sets it to that surface, as the chat frame does with `--panel`, so the fade never draws a grey band on white.
