# The app carries the landing page's signal colour, for decoration and progress only

Date: 2026-11-19

The tangerine that telesphoros.app uses as its signal colour is now in the app's palette as one token, `--signal` (`#C2500A` on light
surfaces, `#FF7A1A` in the dark theme and on the sign-in flow), pinned and contrast-checked by the branding guard (founder decision;
[spec 043](../../specs/043-signal-colour/spec.md)). It appears as an accent on two large headings (the chat home and the sign-in page),
a short line under the chat home's heading, some of the characters in the sign-in drawing, and every mark that shows something under
way: the current step in the step lists, the upload guide's bar and current step, and the chat preview's preparation ring and bar. It
never marks a result, a status, a medication, a follow-up state, an alert, small text or a button, because orange reads as caution on a
clinical screen. A colour-vision check found that a red-blind reader cannot tell it from the warning colour in the light theme, so the
spec requires that colour is never the only difference between a signal mark and a warning, an error or a success; every use today
has a word or a shape beside it. No word, route, role, API, schema or stored data changes.
