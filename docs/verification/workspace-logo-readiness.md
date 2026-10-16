# Workspace logo browser readiness — 2026-10-16

## Failure and cause

PR #138's browser job `117108509265` in run `38941061086` failed on mobile at `local-e2e/interpretation-preview.spec.ts:70`: the bounding box was null immediately after a visibility assertion. Its engineering-workflow changes did not modify frontend runtime or browser tests. The relevant test, login helper and layout/sidebar files are byte-identical between its base `8eaa7a8` and this fix's base main `d6dccdb`.

`signInAs()` waits for the destination URL; that does not guarantee React has committed the authenticated workspace header. `AppLayout` replaces `SiteHeader` with `WorkspaceSidebar`; both contain an image with the same accessible name. The page-wide locator can bind to the retiring site-header logo. In the failing trace, a real site-header node appears at 45884.508 ms during the bounding-box operation; the workspace header appears at 45967.398 ms before that operation completes. The final screenshot shows the valid workspace and logo. A prior visibility check does not make a subsequent measurement atomic; [Playwright documents a nullable bounding box](https://playwright.dev/docs/api/class-locator#locator-bounding-box).

## Correction

Scope the existing logo locator to `header.workspace-navigation`, the same readiness boundary already used by `openWorkspaceNavigation()`. The existing visibility and minimum-64-pixel assertions stay intact. No retries, sleeps, timeout increases, skips, branding policy, product source, authentication behavior, security check or CI configuration changes.

This is a separate main-based test-fix slice; PR #138's workflow-pack diff remains unchanged. No merge or deployment is authorized.

## Local verification

Node 22.22.0, the repository's Playwright-selected headless Chromium and pinned Moto 5.2.4 were used with the real local frontend, backend and synthetic identity provider. Extra validation dependencies/browser files were installed only in the task workspace. Full permitted logs, exit statuses and probe sources were preserved before filtering.

| Check | Result |
|---|---|
| Controlled authentication phase, original locator | Fails: matches one temporary header image while the final workspace is absent; expected zero |
| Same controlled phase, scoped locator | Six passes: three mobile and three desktop repetitions; waits for the real authenticated response, measures the final logo, and proves the retired logo's bounding box is null |
| Undersized final-logo control | Both profiles fail the unchanged width assertion: received 32, required at least 64 |
| Complete originally failing attachment/image/feedback/accessibility/no-request scenario | Ten passes: five mobile and five desktop repetitions |
| Frontend lint and typecheck | Passed |
| Brand rejection tests | 27 passed, zero failed/skipped |

The controlled probe holds the real authenticated `/me` response during the callback and starts sign-in concurrently. It proves locator ownership across the actual header handoff; it does not claim to reproduce the CI scheduler timing exactly. The exact original null dereference is established by the retained CI trace/log. An initial probe awaited completed sign-in while holding that response and timed out; fixing the probe order produced the discriminating failure above. An initial browser launch lacked the requested local Chromium revision; installing that exact revision resolved the setup failure. Neither setup result was counted as a regression result.

The temporary probe and forced-width mutation are not shipped. Only the existing test's locator changes. Required remote checks remain separate from this local evidence; all three database/storage profiles and security/image acceptance remain mandatory. Nothing here establishes hosted or clinical acceptance.
