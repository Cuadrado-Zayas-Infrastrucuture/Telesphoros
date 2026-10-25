# Application source is formatted by Prettier (2026-10-25)

Date: 2026-10-25

**Implemented (formatting only; no behaviour change).** Prettier 3.9.10, pinned exactly, formats TypeScript and JavaScript under `apps/*/{src,test}` and `packages/*/{src,test}`. The settings are in `.prettierrc.json`: width 180, single quotes, semicolons, `(x) =>` arrows and trailing commas.

- `pnpm format` writes the formatting, and `pnpm lint` fails on any unformatted file in that scope.
- Everything outside the scope keeps its bytes: docs, fixtures, knowledge, data, CI, infrastructure, scripts and other configuration.
- This is PR D of the tooling plan from the create-t3-app comparison (founder decision 2026-10-24: width 180, one format-only commit, `.git-blame-ignore-revs`).

**Four commits.**
1. Tooling: the config, the scripts and this note.
2. The formatting itself, nothing else: 555 of 751 in-scope files, `prettier --write` output only.
3. `pnpm format:check` added to `pnpm lint`, `.git-blame-ignore-revs` naming commit 2, and one lint directive the formatting moved, put back.
4. One Terraform-guard control updated for the new spacing.

Every commit passes its own checks. The PR must merge with a merge commit, as this repository does, so commit 2 keeps its hash for `.git-blame-ignore-revs`.

**Width chosen by measurement.** The diff barely shrinks with width, because Prettier lays out objects, call chains and long lines differently from the old hand style. Measured on main `ceac298`, against its 78,246 lines:

| Width | Files changed | Lines added / removed |
|---|---|---|
| 120 | 622 | +46.8k / −13.5k |
| 160 | 571 | +30.1k / −10.8k |
| 180 | 540 | +25.8k / −10.2k |
| 200 | 533 | +23.4k / −9.9k |

180 is close to the code's natural width: 95% of lines were at most 147 characters, and 99% at most 203. Single quotes everywhere costs about 0.8k extra lines over keeping smart-pilot's double quotes, and leaves one rule with no exceptions.

**Bytes that must not change.** Before formatting, every in-scope file's SHA-256 was searched across the repository, in hex and base64. Two matched, both recorded by the 2026-10-10 recovery rehearsal in `docs/verification/phase3c-rehearsal-evidence.json`: `apps/backend/test/helpers/recovery-cli-observe.cjs` and `recovery-evidence.ts`. Three of that record's five files had already changed in later edits, and no test reads it. The two that still match are in `.prettierignore`, so the record stays checkable.

`scripts/lint/prettier-scope.test.mjs`, run by `pnpm test`, repeats that search on every run and fails if a pinned in-scope file is not ignored. Removing one of the two entries turned it red; restoring it turned it green. It also pins the scope to one glob shared by `format` and `format:check`.

**Same program, different layout.** `prettier --debug-check` passed for 723 files on `ceac298`. Its own checker crashed on the 5 files that contain `BigInt` literals, because it cannot serialise them. TypeScript's parser was therefore used to compare every changed file before and after, all 555 including those 5. The comparison covered syntax trees and comments, ignoring only grouping parentheses:

- **548 identical.**
- **3** had a comment moved from after a `{` to its own line, with the same text and count.
- **4 `.tsx` files** split JSX text differently. Compiled with the react-jsx transform, each element's joined text is the same, except one fragment's leading whitespace in `SyntheticAssistant.tsx` (6 spaces to 1), which no whitespace-preserving style encloses.

The full local loop then ran on the formatted tree; 35 test files read source as text, so it had to.

**One directive moved by the formatting, fixed in commit 3.** Prettier split a one-line `jest.isolateModules(() => { config = require(…); }); // eslint-disable-line …` across three lines, leaving the directive on the wrong line. It is now an `eslint-disable-next-line` directly above the `require`. It was the only same-line directive (`eslint-disable-line`, `@ts-expect-error`, `@ts-ignore`) that the format moved. With commit 3, a misformatted file fails `pnpm lint`; `git blame --ignore-revs-file .git-blame-ignore-revs` attributes none of `restore.ts`'s 72 reformatted lines to the format commit.

**One guard control needed the same care, fixed in commit 4.** A control in `infrastructure/terraform/api-compute.guard.test.mjs` simulated a weakened `app.factory.ts` by removing the exact text `server.keepAliveTimeout=API_KEEP_ALIVE_TIMEOUT_MS;`. After formatting the line has spaces around `=`, so the removal matched nothing, and the control failed (the guard itself, a whitespace-tolerant regex, still passed). The control now uses the same tolerant pattern.

To find any control the formatting had made silently toothless, every exact-text `replace()` in the Terraform, Docker and CI guard suites was instrumented to record when its text is not found. The suites ran on `main` and on this branch: 466 passed, 0 failed, and the same 15 such call sites on both, all already present on `main`.

**Limits.** `apps/frontend/e2e`, `apps/ai-service/durable`, `scripts/` and configuration files are outside the scope. Widening it is a later choice, using the same hash check.
