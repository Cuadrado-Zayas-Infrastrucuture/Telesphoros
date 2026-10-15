# Plan: motion and drawn visual elements on the product landing

Status: **draft, plan only; nothing built.** Requested 2026-10-15: "keep the current design, focus on other aspects such as adding some motion and visual elements that prevent the page from looking too static." The founder first asked for alternative sketches using the [taste-skill](https://github.com/Leonxlnx/taste-skill), then chose to keep the approved landing. This plan adds motion and code-drawn elements to that landing without changing its layout, copy, palette, fonts or artwork.

## Starting point (measured on `main`, 2026-10-15)

Slice A of the [UI polish plan](ui-polish-landing-and-dashboard.md) gave the landing a transform-only scroll rise (`useLandingMotion`, `data-reveal`), control feedback and a reduced-motion fallback. The skill's inspector counted 19 moving elements, which passes its floor of 8 and its warning at 16. The page still reads as static for three reasons:

- **Every block moves the same way**: one 20px rise with the same timing. The skill's motion reference names this the most common sign of generated motion.
- **Nothing moves on its own after the first scroll.** The approved DNA and mascot must stay still (AGENTS.md: never animate them, and `e2e/landing.spec.ts` pins the DNA's `animation-name: none` and its rotation).
- **The capability section is three blocks of text** with no picture, and the walkthrough changes scenes without showing what changed.

## What is added

All of it uses transform and opacity only (opacity only on decorative, `aria-hidden` elements, never on text, so the axe contrast audit stays real at every frame). All of it is gated behind the existing `is-motion` class, so content is complete and readable without script, in old browsers and under `prefers-reduced-motion`. Values live in `tokens.css`, colours come from existing tokens, and no dependency is added.

1. **Signature moment: the hero headline rises out of a mask.** Each of its two authored lines slides up from behind its own baseline on load (about 900ms, 110ms apart). This is the one loud move. The paragraph, actions and note then follow with the existing rise.
2. **A particle field drawn in code** (`LandingParticles`, about 36 small dots in the brand accent and soft-text tokens) behind the hero copy and, more faintly, behind the closing panel. It echoes the particle DNA without touching it: the DNA image, its rotation, blend and position are unchanged. Dot positions come from a fixed list, not random numbers at render, so the layout and screenshots are stable. See decision M2 for how it moves.
3. **Scroll cue.** The hero's "Explore the workspace below ↓" arrow nudges down three times and then stops.
4. **The walkthrough shows what changed.**
   - The active-step marker slides between Upload, Check and Find instead of jumping.
   - Intake: the file card settles from a slight scale when the format changes.
   - Check: the two checklist rows arrive in order, the check mark pops in, and a **fictional digest line** (`SHA-256 · fictional example`, decision M4) settles last. The real product compares size, type and SHA-256 of the stored file ([M2.3b](../../STATUS.md)); this illustrates that idea with an invented value labelled as such.
   - Find: the details panel slides in from the side when a different record is chosen.
5. **Three code-drawn interface fragments in the capability rows**, one per row, built from the product's own vocabulary and tokens (`aria-hidden`, with no new claims):
   - "Keep the patient and report connected": a patient chip and a file chip joined by a connector that draws across.
   - "Find a file. Check its status.": three fictional file rows arriving one by one, with one marked verified.
   - "Meet the PGx assistant preview": a sample question, typing dots (three cycles, under five seconds), then a fixed sample answer bubble reading "Sample response. Not connected to your reports."
6. **Varied entrances.** Capability rows and FAQ questions arrive row by row instead of as one block. Headings, text and fragments keep the existing reading-order stagger.
7. **FAQ.** The "+" turns into "×" when a question opens. The answer slides open where the browser supports `::details-content` with `interpolate-size`, and opens instantly elsewhere.
8. **Off-screen pause.** Anything still running pauses when its section leaves the viewport (IntersectionObserver toggles `animation-play-state`).

## Not touched

Layout, copy (other than the labelled fictional digest and the sample answer in decision M3), palette, fonts, logo, particle DNA, mascot and `scripts/branding-policy.json` with its hashes. Also untouched: role-aware actions, routes, permissions, the backend, upload and download behaviour, development-only AI boundaries, the Reports and Upload screens, deployment and real data. The company page is not in this repository: the Vercel project could not be read from this session (403 on deployments, 404 on the project) and `cuadradozayasinfrastructure.com` does not resolve yet, so it needs its source before any plan.

## Decisions only the founder can make

- **M1. Particle field.** Recommended: **yes**, in the hero and faintly in the closing. Alternative: hero only, or none.
- **M2. How the particles move.** Recommended: **scroll-linked**. They settle into place over about 1.2 seconds on load, then drift a few percent only as the visitor scrolls (`animation-timeline: view()`, static where unsupported). Nothing moves on its own for more than five seconds, so WCAG 2.2.2 needs no pause control. Alternative: a slow continuous drift, which reads as more alive but **requires a visible pause button** in the hero.
- **M3. Capability fragments.** Recommended: **yes**, all three, including the fixed sample answer and its "not connected" label. Alternative: the first two only, leaving the assistant row as text.
- **M4. Fictional digest in the Check step.** Recommended: **yes**, labelled fictional. Alternative: the check animation without a digest.
- **M5. Headline mask reveal.** Recommended: **yes**. The lines are clipped for under a second on load. Alternative: keep the current rise.
- **M6. Walkthrough autoplay.** Recommended: **no**. Steps changing by themselves would announce through `aria-live` without being asked, and would need a pause control. The changes in item 4 add motion only when the visitor acts.

## Files expected to change

`src/styles/tokens.css` (motion durations, easing and particle tokens), `src/styles/landing.css`, `src/styles/landing-workflow.css`, a new `src/styles/landing-motion.css`, `ProductLanding.tsx`, `LandingProductPreview.tsx`, `hooks/useLandingMotion.ts`, a new `components/landing/LandingParticles.tsx` and `components/landing/LandingFragments.tsx`, and `e2e/landing.spec.ts`. If the brand check refuses positions set through inline custom properties, positions move to CSS rules; the check is not weakened.

## Verification

- `pnpm --filter @telesphoros/frontend` typecheck, lint, `check:brand` and its mutation tests, unit tests, production build and `check:chunks` (entry stays under the 150 kB gzip budget).
- Standard browser suite, with `e2e/landing.spec.ts` extended to check:
  - the DNA still has `animation-name: none` and its rotation, and the mascot has no animation;
  - particles and fragments are `aria-hidden`;
  - under reduced motion, `document.getAnimations()` holds nothing running and every block is in its final place;
  - no animation repeats forever unless decision M2 chooses the loop, and then the pause button stops it;
  - axe passes during and after the hero sequence;
  - no request to `/api/`;
  - layout shift stays at zero during load.
- The skill's inspector at 1440 / 768 / 390 before and after, reporting the moving-element count (19 today) and any new FAIL or WARN.
- Screenshots of the hero, the walkthrough's Check step and the capability rows at desktop and phone widths; a 200% text and keyboard pass.
- The DEV and owned-storage suites are not needed (no change to those screens); the backend's database and S3 tiers are not run (no backend change). Report what was run.
