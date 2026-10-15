# Plan: polish the product landing page and the Reports dashboard

Status: **plan only, awaiting founder approval.** No UI code, token, asset or policy is changed by this document. Requested 2026-10-15: install the [taste-skill](https://github.com/Leonxlnx/taste-skill) design skill, use [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) as further inspiration for an AI SaaS product, and polish the landing page and dashboard.

## What was done so far (reading and measuring only)

- Read the skill's `SKILL.md`, installer, scripts and references before installing. Its scripts drive a local Chrome over DevTools, search open image archives (Openverse, Wikimedia Commons, Art Institute of Chicago, the Met, NASA, Internet Archive) and write only `./.taste-skill/` and `~/.taste-skill/history.json`. Nothing was run as an installer; the one skill `design-taste-frontend` was copied to the user skills directory (`~/.claude/skills/`). **It is not vendored into this repository**, and a cloud session's home directory is ephemeral, so it must be re-installed in a later session (decision P5).
- Read three of the awesome-design-md files (Linear, Claude, Replicate) for structure only. Those files describe other companies' palettes and fonts; none of that is copied (see "Borrowing rules").
- Ran the skill's source lint and real-browser inspector against the **signed-out landing** from a production build with placeholder auth settings (a build without them shows "Telesphoros cannot start"). The repo's own `check:brand` passed on the same tree.

## Findings on the current landing

The landing is clean and on-brand, and the measurements below say where it is thin. Numbers are the inspector's, at 1440 / 768 / 390 px.

**Real gaps that fit inside the approved brand** (proposed to fix):

| Finding | Measured |
| --- | --- |
| Running text is small | body 14px; 24 text blocks under 13px (footnotes, hero byline, notes) |
| Too many type sizes | 14 distinct sizes (10, 11, 12, 13, 14, 15, 16, 17, 23, 24, 37, 40, 42, 61 px); about five is enough |
| Headlines wrap to three lines at 768px | the purpose, workflow and FAQ headings (37px) |
| Running copy is a soft teal-grey | 6.6:1; reads thin next to a full-ink heading |
| The page does not move | 0 elements animate on load or scroll |
| Hero does not lead hard enough | 61px (4.2vw) headline; the strongest sites studied by the skill run larger |

**Findings that conflict with founder-approved decisions** (proposed to **keep**, see decisions P1 and P2):

| Skill rule | Where the approved landing differs |
| --- | --- |
| No eyebrow labels | six `landing-eyebrow` / `workflow-kicker` labels |
| No 01 / 02 / 03 | the workflow tabs and the capability rows |
| No gradients | the teal hero and its scrim (the approved teal direction, 2026-10-13) |
| No hairlines or 1px outlined boxes | section dividers, the walkthrough, the FAQ |
| At least four real pictures, plus footage | the approved assets are the DNA artwork and the mascot, which AGENTS.md says are never recolored, redrawn, animated or filtered |

The skill also states "Not for dashboards or app screens." It was written for public marketing pages.

## Proposed scope

### Slice A: landing (one draft PR, branched off `main`)

1. **Type scale.** Collapse the 14 sizes to a five-step landing scale held in tokens (display, heading, lead, body, small). Running text 16px minimum in the full landing ink; nothing meant to be read under 13px. Notes and byline raised accordingly.
2. **Headline measure.** Widen the measure and trim line breaks so every heading is two lines or fewer at 1440, 768 and 390. Wording is unchanged unless you ask for it: the approved headline, purpose line and disclaimers stay verbatim.
3. **Hero.** Larger display size, still left aligned, same DNA artwork and position, same disclaimers and role-aware actions.
4. **Motion layer.** Entrances for heading, text and illustration inside each section (staggered 60 to 90ms, 16 to 24px rise with opacity, once, `IntersectionObserver`), press/hover/focus feedback on every control, transform and opacity only, full `prefers-reduced-motion` fallback, content visible if script fails. **The DNA and mascot images are never animated** (AGENTS.md); motion applies to the surrounding text and the walkthrough only.
5. **Rhythm.** Larger, consistent gaps between sections than inside them, neighbouring sections kept visibly different, as the skill's layout notes ask.
6. All values come from `tokens.css` (the policy forbids literals elsewhere).

### Slice B: Reports dashboard and upload page (a separate draft PR after A is reviewed; never stacked)

Inspiration, from the skill's critique method and the Linear/Claude/Replicate design notes, kept within the existing brand: an opaque layered surface ladder (page, panel, selected row) instead of mixed outlines; one clear primary action per screen; dense but calm tables; a quiet selected-row state; status said in words; skeletons that match the final layout.

1. **Reports list.** Clearer row hierarchy (filename strongest, patient secondary, status last), tighter header block, a patient id that never wraps into the filename, an empty state with the primary action. Keep the 20-row bound, patient filter, mobile list/detail flow and focus return.
2. **Report details panel.** Group fields into identity, storage state and technical disclosure; keep the verified-download behavior and its role rules; keep the "storage verification is not clinical review" wording.
3. **Upload page.** Same type and surface treatment so the two screens read as one product; no change to the retry, recovery or validation logic.
4. **Shared controls.** Only through the existing `Button`, `Card`, `NativeSelect` components and tokens; 44px targets, visible focus, AA contrast.
5. Reports primary details and composer must still fit together at 1280×800 at default text size (AGENTS.md).

### Not touched in either slice

Backend, schema, authentication and tenant policy, roles and guarded routes, upload and download byte verification, owned-storage opt-in, development-only AI routes and their `import.meta.env.DEV` boundaries, clinical gates and all disclaimers, the logo, the particle DNA, the mascot and every font file, `scripts/branding-policy.json` and its hashes, deployment, and any real data. No new dependency. No external font, image or script service. No claim beyond what the approved landing already says.

## Borrowing rules

- From awesome-design-md and the skill we borrow **structure and method only**: hierarchy, spacing rhythm, state design, density, motion timing, the look-and-fix loop. We do not borrow another company's palette, typeface, logo, gradients or copy. Anything that would need a foreign colour or font is rejected by the branding check by design.
- Proof is never invented: no customers, quotes, reviews, press, logos or statistics, as before.

## Decisions only the founder can make

- **P1. Brand elements the skill bans (eyebrows, 01/02/03, the teal gradient, hairlines).** Recommended: **keep them**, because they are part of the approved landing and a rebrand needs founder approval, a reviewed policy update and new contrast evidence (AGENTS.md). Alternative: approve a restyle that removes some of them, which is a separate, larger plan.
- **P2. Pictures and footage from open archives.** Recommended: **no**. The skill wants at least four real pictures and a video loop found in public collections. For a clinical-adjacent synthetic-data product that adds credit obligations and imagery that is not ours, and the approved artwork is fixed. Alternative: approve one or two specific pictures case by case.
- **P3. Motion on the landing.** Recommended: **yes**, as specified above (never on the DNA or mascot, reduced-motion respected).
- **P4. Order and split.** Recommended: slice A (landing) first, then slice B (dashboard and upload). Alternative: dashboard first, or both in one review.
- **P5. Keep the skill in the repository?** Recommended: **no**; leave it installed per user and re-install when needed. Alternative: vendor it under `.claude/skills/` in its own small PR (about 350 KB plus its image-search scripts) so every session has it.
- **P6. Body text size.** Recommended: raise landing running text to 16px. The dashboard stays compact (its approved compact hierarchy is unchanged unless you say otherwise).

## Verification (when approved)

- `pnpm --filter @telesphoros/frontend` typecheck, lint, unit tests including `test:brand`, `check:brand`, production build and `check:chunks`; the permission tests that cover role-aware actions.
- Browser: standard and DEV suites and the owned-storage suite from `STATUS.md` ("Running things locally"), with the three-tier backend caveat noted: this is a frontend-only change, so the database and S3 tiers are run for regression, not to prove a schema.
- Visual: the skill's inspector at 1440 / 768 / 390 for the landing before and after; screenshots of Reports at 1280×800 and 390 wide with the list, selected, loading, empty and error states; 200% text; keyboard order and focus; contrast; no horizontal overflow; reduced-motion run showing all content present.
- The inspector's `FAIL`s for the decisions kept under P1 and P2 are reported as accepted exceptions, never hidden or suppressed in code.
- Report what was run, what passed and what was not run.

## Limits of the evidence so far

- The inspector numbers are for the signed-out landing from a local production build with placeholder auth values. The dashboard has **not** been measured in a browser yet: it needs the fake identity provider and API stack, which is part of slice B's verification. The dashboard observations above come from the existing screenshot `docs/design/previews/reports-dashboard-modern-desktop.jpg`.
- The skill's scores and thresholds come from its author's study of gallery sites; they are guidance, not a standard this product has to meet.
