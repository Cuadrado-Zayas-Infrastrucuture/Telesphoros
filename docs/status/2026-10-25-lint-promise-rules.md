# Type-aware promise rules in lint, and packages/jobs is linted (2026-10-25)

Date: 2026-10-25

**Implemented (lint only; no runtime change).** `pnpm lint` now checks three type-aware rules: `@typescript-eslint/no-floating-promises`, `no-misused-promises` and `await-thenable`. They cover every package that had lint, plus `packages/jobs` (the queue, registry and retry rules), which had no lint script before. The rules live in one file, `scripts/lint/promise-rules.mjs`, which each `eslint.config` calls with the folders its `tsconfig.json` covers. A promise that nothing awaits or handles fails where nobody sees it: a job that never settles, or a test that cannot go red. This is PR B of the tooling plan from the create-t3-app comparison (founder decision 2026-10-24).

**Measured first.** The full `recommendedTypeChecked` set would report 6,754 findings over the same files, mostly `no-unsafe-*` (2,941 `no-unsafe-member-access` alone), so it is not adopted. The three promise rules reported 6, all `no-misused-promises` and all in backend test code; there were 0 floating promises and 0 bad `await`s.
- Five are Jest mocks of `pg` `Client` methods and the S3 client's `send`, whose callback overloads are typed `void` while the mock returns the promise the real method returns. Each gets a suppression naming the rule, with a reason.
- One, in `outbox-request-id.pg-spec.ts`, handed a promise to the request middleware's `next`. The middleware drops that return value, and the promise already routes its rejection to `reject`. It is now `{ void work().then(resolve, reject); }`, which behaves the same.

`linterOptions.reportUnusedDisableDirectives` is `error` in the covered folders, so a suppression that stops suppressing anything fails lint. `pnpm lint` takes about 14 s locally, up from 6 s.

**Tests, red first.** Before the six changes, `pnpm lint` failed with exactly the six findings above; after them it passes. Defect injection: a temporary file holding one floating promise, one `forEach(async …)`, one `await 1` and one stale suppression was placed in each of the ten covered folders (backend and worker `src` and `test`; ai-service `src`, `durable` and `test`; smart-pilot `src` and `ui`; jobs `src`). All four findings were reported in every folder, and the file was removed after each run.

**Limits.** Only files a `tsconfig.json` covers get these rules. `packages/smart-pilot/test/*.test.tsx` sits outside its tsconfig (`tsc` does not check those files either), and build-config files (`tsup.config.ts`, `vitest.config.mts`) are outside too. Those keep the untyped rules. Behaviour is unchanged; any real defect these rules find later is its own change.
