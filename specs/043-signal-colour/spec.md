# Feature Specification: The signal colour in the app (SC)

**Feature Branch**: `feat/043-signal-colour`

**Created**: 2026-11-18

**Status**: Direction approved by the founder 2026-11-18 ("there are no tangerine in the UI to match the landing page", then "Progress marks too"). After a first look at the three places the founder said "needs more orange" and chose three of four offered additions (Amendment 1, below). Built on this branch. This is a brand change: it is not final until the founder has looked at the places in light and dark and said so (task T008).

**Input**: telesphoros.app took a signal colour on 2026-11-14, tangerine, the complement of the brand teal. The app's palette never received it, so the step from the landing page into the app loses the one vivid colour. The landing page's decision came with a caution that carries over unchanged: amber and orange read as "caution" on clinical screens, so the signal colour is for decoration and progress only, never for a result or a status.

## Decisions

- **D1, one token, three values:** `--signal` is `#C2500A` on light surfaces, where the vivid orange would be too faint, and `#FF7A1A` in the dark theme and on the sign-in flow's night surface. These are the landing page's two tangerines (`--signal` and `--signal-fill` there). The brand policy pins all three, allows the two literals, and requires 3:1 against the page, against a card and against the muted surface in every theme, the level for a graphic mark and for large text. It is exposed as the utilities `text-signal`, `bg-signal` and so on.
- **D2, sign-in drawing:** about one in three of the characters that come loose and rise takes the signal colour, as the dashes off the landing page's helix do. The sphere itself does not change.
- **D3, chat home line:** one short line under the heading "Start with a synthetic report.", 5rem by 3px, running from the signal colour to the brand teal, as the landing page's stage opens. It is hidden from assistive technology.
- **D4, progress:** every mark that shows something under way takes the signal colour:
  - the mark of the step under way in both step lists (the real upload's and the chat preview's); its word stays plain, a finished step keeps its check, a failed step has no signal mark;
  - the turning ring and the phase bar of the chat preview's preparation;
  - the upload guide's progress bar and the line under its current step.

  Not changed: the spinner inside a button keeps the button's text colour, because it sits on the button's fill, where tangerine would be hard to see, and D5 keeps buttons free of it. Loading placeholders (the grey shapes) stay grey.
- **D5, where it never goes:** results, recommendations, medications, follow-up due and overdue states, alerts and notices, small and body text, and button fills. The app already has a warning colour in the same family (`--warning`, brown in light, amber in dark); the signal colour must never sit where a reader could take it for one. A new use needs its own decision here.
- **D6, heading accent:** as the landing page's headline does, a large heading may carry the signal colour: the last words of the chat home's heading ("synthetic report.") and the sign-in page's heading ("Sign in"). Only at heading sizes, 24 px and up: on a light page the colour reaches 4.39:1, enough for large text (3:1) and not for small text (4.5:1). The words and the heading's accessible name do not change.

## Amendment 1 (2026-11-18)

After the first browser look the founder said "needs more orange". Four additions were offered; three were chosen: the heading accent (D6, new), every progress mark (D4, was the upload's step list only), and a stronger sign-in drawing and chat-home line (D2 was one in seven; D3 was 3rem by 2px). The fourth, a bar beside the sidebar's selected item, was not chosen.

## Out of scope

The landing page and the company page; any other screen of the app; the selected item in the sidebar (considered twice, left out: it is on every screen, beside the follow-up count); wording; API, schema, setting or infrastructure.

## Not verified by this spec

Whether the signal colour and the warning colour stay easy to tell apart for people with a colour vision deficiency. In the dark theme they are closest (`#FF7A1A` beside `#DDB672`). D5 keeps them on different kinds of things, and a mark is never the only carrier of meaning, but nobody has looked at this through a simulator yet.
