# Feature Specification: A tooltip that names an icon button (TT)

**Feature Branch**: `feat/042-tooltip`

**Created**: 2026-11-18

**Status**: Plan approved by the founder 2026-11-18 ("tooltip", then "Patient page refresh"). Built on this branch with Amendment 1 and D9 to D10; all checks and the full local loop pass (tasks T008, T017, T018). The founder looked at it in a browser and listened in VoiceOver on 2026-11-19 (task T010). Not pushed.

**Input**: "Check ... tooltips, hover card, pop over ... Use this free components" (uiarc.dev). A read of Arc UI on 2026-11-18 against this app found that only the tooltip has a clear use here, and the founder chose it alone.

Why a tooltip at all: several icon-only buttons name themselves with the browser's `title` attribute, and two specs say that name shows "as a tooltip" (034 D3 and D5, 041 D8). A `title` appears after a browser-chosen delay on mouse hover only. It never appears on keyboard focus, so a sighted keyboard user sees an icon with no name.

## Decisions

- **D1, one `Tooltip` component:** `components/arc/Tooltip.tsx` wraps its one child and shows `label` beside it on hover (after 250 ms) and on keyboard focus (at once). Escape hides it and leaves focus where it was. It is built on `@radix-ui/react-tooltip`, which links the label to the control and handles placement at the window's edges. The app already uses Radix for `Label` and `Slot`.
- **D2, first use, the patient page:** "Refresh medications" and "Refresh follow-ups" (specs/041 D8) use `Tooltip` in place of `title`. Their accessible names, their place and their behaviour do not change, so every existing test and browser suite finds them as before.
- **D3, a tooltip only repeats a name:** `label` is the control's own accessible name, for people who see the icon. A fact, a status, a reason or a safety statement never lives only in a tooltip: touch users rarely see one, and a disabled control shows it on hover only, because it takes no keyboard focus. This is the rule of `docs/design/plans/followup-response-summary.md` ("no hover-only data") applied to this component.
- **D4, the app's own look:** the label is the page's text and background colours swapped (`--foreground` behind, `--background` in front), so its contrast is the body text's in every theme. Radius, shadow and size come from existing tokens. It fades in over 120 ms and leaves at once; with reduced motion it does not fade. The open state is styled in `styles/tooltip.css`, because the lint rule against one-off Tailwind values also covers `data-[state=…]` variants.
- **D5, adapted from Arc UI, credited:** the shape (a provider, a trigger that keeps the child's own element, a portalled label, the 250 ms delay, the 8 px gap, the 15rem width) follows Arc UI's `tooltip.tsx` at commit `8302b52e` (MIT, Elia Kuratli). `components/arc/` keeps the licence and a README beside the component, as `components/bklit/` and `components/prompt-kit/` do. Not taken: Arc's `motion` text morph, its shared skip window, its CSS module and its token file. No animation library is added.

## Amendment 1, 2026-11-18: the other icon-only controls

Founder, the same day, after the first use passed its checks: "apply tooltips on other areas", then "Yes, first group". Every native `title` left in the app was listed and sorted into four groups; this amendment takes the first.

- **D6, every icon-only control that names itself:** `Tooltip` replaces `title` on the Reports filter's "Refresh patient options" and "Clear patient filter", on the "About…" info button (`InfoButton`, so the Follow-up section and the New patient page), and in the sidebar: the collapse control always, and, while the sidebar is collapsed to icons, New chat, each destination, Follow-ups and the account button. Names, order and behaviour do not change. This is what specs/018 D3 and specs/034 D5 mean by a name shown "as a tooltip"; their `title` becomes this component.
- **D7, no label, no tooltip:** `label` may be undefined, and then the child renders exactly as before. The expanded sidebar shows each name in words, so its links carry no tooltip. In the collapsed sidebar the label opens to the right of the icon; the collapse control opens to the right when collapsed and below when expanded.
- **D8, `SidebarLink`:** the tooltip hands its child one merged set of properties and joins class names as text. A sidebar destination's class name is a function of whether it is the current page, which that join would turn into a string. `components/layout/SidebarLink.tsx` carries the function as `styleFor` and passes everything else through to the link.

- **D9, the sidebar fetches the tooltip on demand (founder, "Load it on demand"):** the sidebar is in the file every page loads first, and using `Tooltip` there moved the tooltip library into that file: 110,710 to 128,008 bytes gzipped. `components/arc/LazyTooltip.tsx` has the same properties as `Tooltip`; it shows the control at once, fetches the tooltip's code after the first render, once per page, and wraps the control when it arrives. Wrapping replaces the control's element, so a control that holds the keyboard focus at that moment gets it back on its replacement. The sidebar and `FollowupsNavLink` use it; pages that load on demand keep `Tooltip`. Measured after: the first file is 110,781 bytes gzipped (71 more than before any tooltip), and the library is its own 17,703-byte file that the page does not preload.
- **D10, icons only at the desktop width (found 2026-11-19, founder: "Yes, fix it first"):** the collapse to icons applies only at 64rem and wider (`styles/workspace.css`); below that the sidebar is a menu that shows every name in words. The stored collapse stays set there, so keying the sidebar's tooltips on it alone gave the menu's links a tooltip that repeated the visible word, opened mostly past the left edge, and described each link with its own name. The sidebar and `FollowupsNavLink` now show a tooltip only when the sidebar is collapsed and the window is at the desktop width (`hooks/useMediaQuery.ts`, which follows the window as it changes). The collapse control keeps its tooltip at every width; below the desktop width it is hidden anyway.

Left for later, each with its own decision: the full text of cut-off rows (Recents in the sidebar, file names and patient labels in the reports table, the patient list, the account email), which show record text and need keyboard reach first; and reasons or instructions (the Send button's blocked reason, the sidebar's resize hint, the usage calendar's day text), which D3 keeps out of a tooltip.

## Out of scope

The cut-off rows and the reasons named above; the development-only screens (the sample assistant, the local workspace and its bar); popover, hover card and every other Arc UI part; any change to wording, API, schema, setting or infrastructure.

## Not verified by this spec

A screen-reader pass beyond VoiceOver on macOS. Radix describes the control with the label while it is open, and here the label equals the name, so a screen reader could say the name twice. The founder listened in VoiceOver on 2026-11-19, on a collapsed sidebar icon: the name was read once. Other screen readers (NVDA, JAWS, TalkBack, iOS VoiceOver) were not tried.

Known and accepted: the label is drawn at the end of the document, outside the page's landmarks, so that no scrolling or clipped container can cut it off. axe's best-practice `region` rule flags that (measured 2026-11-18; drawing it in place clears the rule). The rule is outside the set the app holds its pages to, WCAG 2 A and AA (`e2e/helpers.ts`), and the label is reached through the control it describes, not through landmark navigation. The unit test uses the app's set on the whole document.
