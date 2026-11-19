# Feature Specification: The signal colour in the app (SC)

**Feature Branch**: `feat/043-signal-colour`

**Created**: 2026-11-18

**Status**: Direction approved by the founder 2026-11-18 ("there are no tangerine in the UI to match the landing page", then "Progress marks too"). Built on this branch. This is a brand change: it is not final until the founder has looked at the three places in light and dark and said so (task T008).

**Input**: telesphoros.app took a signal colour on 2026-11-14, tangerine, the complement of the brand teal. The app's palette never received it, so the step from the landing page into the app loses the one vivid colour. The landing page's decision came with a caution that carries over unchanged: amber and orange read as "caution" on clinical screens, so the signal colour is for decoration and progress only, never for a result or a status.

## Decisions

- **D1, one token, three values:** `--signal` is `#C2500A` on light surfaces, where the vivid orange would be too faint, and `#FF7A1A` in the dark theme and on the sign-in flow's night surface. These are the landing page's two tangerines (`--signal` and `--signal-fill` there). The brand policy pins all three, allows the two literals, and requires 3:1 against the page and against a card in every theme, the level for a graphic mark. It is exposed as the utilities `text-signal`, `bg-signal` and so on.
- **D2, sign-in:** in the sign-in drawing, about one in seven of the characters that come loose and rise takes the signal colour, as the dashes off the landing page's helix do. The sphere itself, the heading, the text and the button do not change.
- **D3, chat home:** one short line under the heading "Start with a synthetic report.", 3rem by 2px, running from the signal colour to the brand teal, as the landing page's stage opens. It is the page's only signal mark, and it is hidden from assistive technology.
- **D4, progress:** in the real upload's step list, the mark of the step under way takes the signal colour. Its word ("In progress") stays plain. A finished step keeps its check and green word, a failed step its red word and no signal mark, a waiting step nothing. The chat preview's list is unchanged.
- **D5, where it never goes:** results, recommendations, medications, follow-up due and overdue states, alerts and notices, body text, and button fills. The app already has a warning colour in the same family (`--warning`, brown in light, amber in dark); the signal colour must never sit where a reader could take it for one. A new use needs its own decision here.

## Out of scope

The landing page and the company page; any other screen of the app; the selected item in the sidebar (considered, left out: it is on every screen); wording; API, schema, setting or infrastructure.

## Not verified by this spec

Whether the signal colour and the warning colour stay easy to tell apart for people with a colour vision deficiency. In the dark theme they are closest (`#FF7A1A` beside `#DDB672`). D5 keeps them on different kinds of things, and a mark is never the only carrier of meaning, but nobody has looked at this through a simulator yet.
