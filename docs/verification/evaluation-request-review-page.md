# H4 slice 3 verification: the review page's queued path and the cancel route

Date: 2026-10-28

Scope: [spec 007](../../specs/007-async-evaluation/spec.md) slice 3, tasks T030 to T034. Synthetic fixtures only: public D01 through the test stand-in reader for the route, and a scripted API for the page. Tested on real restricted-role PostgreSQL 16, Node 22.22.0 and pnpm 10.28.0, from a frozen offline install.

## Seen failing first

- **Route.** Before the route existed, 5 of 53 tests failed: the three cancel cases in `test/evaluation-requests-api.e2e-spec.ts`, the switched-off 503 case, and the hand-written route list in `test/lab-reports-gate.e2e-spec.ts`.
- **Page.** Before the page changed, the 9 new component tests in `src/pages/LocalReviewPage.test.tsx` failed. Eight of them could not find the "Queue synthetic evaluation" button, and the 11 existing tests still passed.

## What the tests cover

**Route**, on PostgreSQL:
- the requester cancels (200, `cancelled`), and the status then reads `cancelled`;
- a second cancel gets 409 `not-cancellable`;
- a colleague and a reader get 403 and the request stays queued, then the requester cancels (control);
- another organization gets 404, a malformed id 400, and a body 400, with nothing changed;
- with the switch off, 503 `EVALUATION_REQUESTS_DISABLED`;
- the controller and input-pipe inventory, and the boundary test, still hold.

**Page**, component tests on fake timers:
- queued, then running, then completed, with the stored evaluation shown and no more requests after it;
- requests again exactly at 1, 2 and 4 seconds, then every 10;
- the five-minute stop and its sentence, with no result shown;
- no request after the page goes away;
- two clicks send one `requestId`;
- cancel, after which there are no more requests and no Cancel button;
- `dead` and `completion-missing` shown as operational words, with no result and no Cancel;
- the switched-off sentence, with no polling.

## Mutations

Each was applied alone, its tests run, and the file restored byte for byte. All nine were caught:
- a new `requestId` on every click;
- polling that outlives the page;
- a 5-second interval instead of 10;
- polling that never gives up;
- Cancel offered on a finished request;
- the switched-off answer shown as a plain refusal;
- cancel leaving the timer running;
- the cancel route without roles (caught by the gate's rule that every route names its roles);
- the cancel route answering 201 instead of 200.

## Results on the candidate

Every run is on candidate `df2af1f`, with a clean tree.

| Run | Result |
| --- | --- |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:infra`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | exit 0 |
| backend, in memory, with services | 3032 passed, 1 failed, 310 skipped (see below) |
| backend, PostgreSQL | 3322 passed, 21 skipped |
| backend, PostgreSQL and S3 | 3342 passed, 1 skipped |
| worker, with services; F2 and F3 recovery validators | exit 0 |
| browser (`pnpm --filter @telesphoros/frontend e2e`, all three configurations) | 118, 30 and 2 passed |
| Gitleaks on the commit | no leaks |

Three things are worth knowing about these runs:

- **The first browser run failed before any test.** Outside CI, `apps/frontend/playwright.config.ts` looks for Chromium at `/opt/pw-browsers/chromium` unless `CHROMIUM_PATH` is set. That directory does not exist on this machine, so every test failed to launch in about 1 ms. The rerun set `CHROMIUM_PATH` to the installed revision 1248, the one the pinned `playwright-core` 1.64.1 names, and all suites passed. No file was changed for this.
- **The browser suites rewrite 12 tracked landing-page previews** under `docs/design/previews/` when run locally. They were restored to the committed files, and none is part of this change.
- **One in-memory-tier test hit its deadline.** `test/db/capture-decision-order.pg-spec.ts` exceeded its 5 s limit once. It passed in the two PostgreSQL tiers in the same loop, and twice alone (4.6 s and 2.7 s). It does not touch this change. It runs close to its limit under load, but the cause is unproven.

## Not verified

- No worker ran as its own process behind the page. The page's states are proved against a scripted API, and the route against the real stack.
- No hosted CI run yet.
