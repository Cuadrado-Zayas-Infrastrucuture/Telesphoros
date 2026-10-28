# Feature Specification: Progressive blur at scroll edges, and nowhere else (PBE)

**Feature Branch**: `chore/brand-progressive-blur` (slice 1 of 3; the reports funnel and the assistant conversation follow, each on its own branch off `main`)

**Created**: 2026-10-27

**Status**: Approved 2026-10-27. The founder chose to change the brand rule ("Change the rule") rather than leave blur out or limit it to decorative pages, and approved the three-slice plan.

**Input**: The founder asked for Motion Primitives' progressive blur (https://motion-primitives.com/docs/progressive-blur) in the Telesphoros app. `docs/design/branding.md` says data surfaces have "no blur over operational information", and `apps/frontend/src/styles/tokens.css:94` repeats it. The brand gate (`apps/frontend/scripts/check-branding.mjs`) has no blur check at all: the rule is prose only. On `main` `cbbbe7b` no frontend or SMART UI source uses `backdrop-filter`, `filter: blur()` or a Tailwind blur utility.

## The problem

- The founder wants a softer scroll edge on long operational lists and conversations, which the current rule forbids.
- The current rule is not enforced. Any file could add a blur today and the build would pass.
- Unbounded blur over operational data (reports, gene results, chat answers) makes text illegible where people read it. That is the harm the old rule prevented, and it must stay prevented.

**Rule (replaces "no blur over operational information"):** blur exists only as a progressive edge on a scroll container, through one component. It is decorative and hidden from assistive technology, at most `--size-blur-edge` (3rem) deep and 3.5px strong. The container pads its content by the same depth, so nothing is under blur at rest. Readers who ask for reduced transparency, and browsers without `backdrop-filter`, get an opaque fade in `--background` instead. Every other blur is rejected by the build.

## Out of scope (slice 1)

- Using the component on any screen. The assistant conversation (slice 3) is the first user.
- Glass, frosted panels, blurred modal backdrops and blurred images. They remain forbidden.
- The `motion` dependency. Upstream uses `motion.div` only as a pass-through, so the adaptation is a plain `div`.
- Any token colour, font, artwork or contrast pair. None change.

## User Scenarios & Testing

### User Story 1: blur cannot spread past the edge component (Priority: P1)

A contributor adds `backdrop-blur-md` to a report card, or `filter: blur(4px)` to a stylesheet. **Acceptance:** `pnpm --filter @telesphoros/frontend check:brand` fails and names the file. The same blur inside the edge component passes.

### User Story 2: the edge never hides what someone is reading (Priority: P1)

**Acceptance:** the component is `aria-hidden`, ignores pointer events, is bounded to `--size-blur-edge`, and clamps its strength to 3.5px whatever props it gets. With reduced transparency, or without `backdrop-filter` support, it renders no blur layers, only an opaque fade.

### User Story 3: the rule is written where people look (Priority: P2)

**Acceptance:** `docs/design/branding.md`, `apps/frontend/AGENTS.md` and the `tokens.css` comment state the new rule. The policy pins `--size-blur-edge`.

## Requirements

- **FR-001** The gate rejects `backdrop-filter`, `backdropFilter`, any `blur(` value and Tailwind `blur` or `backdrop-blur` utilities in every frontend and SMART UI source except `components/motion-primitives/ProgressiveBlur.tsx` and `styles/progressive-blur.css`.
- **FR-002** `branding-policy.json` pins `size-blur-edge: 3rem`; the gate rejects a change to it.
- **FR-003** `ProgressiveBlur` renders 2 to 8 layers, clamps the per-layer step to 0.5px (3.5px at most), and is `aria-hidden`.
- **FR-004** `progressive-blur.css` bounds the overlay to `--size-blur-edge` and swaps the blur for an opaque `--background` fade under `prefers-reduced-transparency: reduce` and `@supports not (backdrop-filter)`.
- **FR-005** The vendored source keeps its MIT licence and records the pinned upstream commit.

## Success Criteria

- **SC-001** Each new gate test fails with the rule removed and passes with it.
- **SC-002** The unchanged repository still passes the gate, and every existing brand test still passes.
- **SC-003** The component tests pass, and fail when the clamp or `aria-hidden` is removed.
- **SC-004** The full local loop passes: typecheck, lint, test, build (with the gate and chunk budget), `test:infra`, `test:ci-config` and gitleaks.
