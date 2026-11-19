# Tasks: The signal colour in the app

Front end only. No API, schema, setting, infrastructure or package change. The plan is the decisions in [spec.md](spec.md).

- [x] T001 Token and policy (D1): `--signal` in the light, dark and night blocks of `styles/tokens.css`; `--color-signal` in `styles/index.css`; `scripts/branding-policy.json` gains the three values, the two literals and two contrast pairs (page and card, 3:1); `docs/design/branding.md` gains the row.
- [x] T002 Policy tests: `scripts/check-branding.test.mjs` (a drifted value is rejected in the light and the dark theme; a value too faint for the page is rejected).
- [x] T003 Sign-in (D2): `components/signin/SignInArt.tsx`.
- [x] T004 Chat home (D3): `components/workspace/ConversationWelcome.tsx`, `styles/one-screen.css`; `ConversationWelcome.test.tsx`.
- [x] T005 Progress (D4): `components/prompt-kit/Steps.tsx`; `Steps.test.tsx`.
- [x] T006 Checks in the sealed sandbox, 2026-11-18: brand check, typecheck, lint and format check exit 0; the front end's tests pass (65 script tests, 1,103 unit tests in 92 files); build, chunk and foundation checks exit 0. Measured contrast of the signal colour: light 4.39:1 on the page and 4.72:1 on a card; dark 6.42 and 5.85; night 6.58 and 5.91 (3:1 required). Against the warning colour its lightness differs by only 1.25:1 (light) and 1.37:1 (dark): the two are told apart by hue, which is why D5 keeps them on different kinds of things. Controls, all red as they should be: the step test fails without the signal class; the brand check refuses a signal value the policy does not list; a foreign palette utility is still refused. The upload read `lockfile: MISMATCH`, because the sandbox image was rebuilt for specs/042 and this branch has the older lock file; the image holds every package this branch needs.
- [ ] T007 Browser look in light and dark: the sign-in drawing, the chat home, an upload in progress; measured contrast of each mark against what it sits on.
- [ ] T008 The founder's look and explicit approval of the brand change.
- [ ] T009 Before a PR: the full local loop, gitleaks, and a pass through a colour-vision simulator (spec, "Not verified").
