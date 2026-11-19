# Feature Specification: A tooltip that names an icon button (TT)

**Feature Branch**: `feat/042-tooltip`

**Created**: 2026-11-18

**Status**: Plan approved by the founder 2026-11-18 ("tooltip", then "Patient page refresh"). Built on this branch; the checks wait on one new package and a rebuilt sandbox image (tasks T006 to T008).

**Input**: "Check ... tooltips, hover card, pop over ... Use this free components" (uiarc.dev). A read of Arc UI on 2026-11-18 against this app found that only the tooltip has a clear use here, and the founder chose it alone.

Why a tooltip at all: several icon-only buttons name themselves with the browser's `title` attribute, and two specs say that name shows "as a tooltip" (034 D3 and D5, 041 D8). A `title` appears after a browser-chosen delay on mouse hover only. It never appears on keyboard focus, so a sighted keyboard user sees an icon with no name.

## Decisions

- **D1, one `Tooltip` component:** `components/arc/Tooltip.tsx` wraps its one child and shows `label` beside it on hover (after 250 ms) and on keyboard focus (at once). Escape hides it and leaves focus where it was. It is built on `@radix-ui/react-tooltip`, which links the label to the control and handles placement at the window's edges. The app already uses Radix for `Label` and `Slot`.
- **D2, first use, the patient page:** "Refresh medications" and "Refresh follow-ups" (specs/041 D8) use `Tooltip` in place of `title`. Their accessible names, their place and their behaviour do not change, so every existing test and browser suite finds them as before.
- **D3, a tooltip only repeats a name:** `label` is the control's own accessible name, for people who see the icon. A fact, a status, a reason or a safety statement never lives only in a tooltip: touch users rarely see one, and a disabled control shows none. This is the rule of `docs/design/plans/followup-response-summary.md` ("no hover-only data") applied to this component.
- **D4, the app's own look:** the label is the page's text and background colours swapped (`--foreground` behind, `--background` in front), so its contrast is the body text's in every theme. Radius, shadow and size come from existing tokens. It fades in over 120 ms and leaves at once; with reduced motion it does not fade. The open state is styled in `styles/tooltip.css`, because the lint rule against one-off Tailwind values also covers `data-[state=…]` variants.
- **D5, adapted from Arc UI, credited:** the shape (a provider, a trigger that keeps the child's own element, a portalled label, the 250 ms delay, the 8 px gap, the 15rem width) follows Arc UI's `tooltip.tsx` at commit `8302b52e` (MIT, Elia Kuratli). `components/arc/` keeps the licence and a README beside the component, as `components/bklit/` and `components/prompt-kit/` do. Not taken: Arc's `motion` text morph, its shared skip window, its CSS module and its token file. No animation library is added.

## Out of scope

Every other use of `title` ("Clear patient filter", "Reset", the "About…" info buttons, the sidebar's collapsed links and Recents rows); the Send button's blocked reason, which is a reason and not a name (D3) and needs its own decision; popover, hover card and every other Arc UI part; any change to wording, API, schema, setting or infrastructure.

## Not verified by this spec

A screen-reader pass. Radix describes the control with the label while it is open, and here the label equals the name, so a screen reader may say the name twice. That needs a listen in VoiceOver before this pattern spreads to more buttons.

Known and accepted: the label is drawn at the end of the document, outside the page's landmarks, so that no scrolling or clipped container can cut it off. axe's best-practice `region` rule flags that (measured 2026-11-18; drawing it in place clears the rule). The rule is outside the set the app holds its pages to, WCAG 2 A and AA (`e2e/helpers.ts`), and the label is reached through the control it describes, not through landmark navigation. The unit test uses the app's set on the whole document.
