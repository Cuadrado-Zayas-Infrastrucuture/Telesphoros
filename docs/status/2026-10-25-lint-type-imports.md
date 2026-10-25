# Type-only imports are written `import type`, and decorator metadata is protected (2026-10-25)

Date: 2026-10-25

**Implemented (lint and import lines only; no runtime change).** `pnpm lint` now enforces `@typescript-eslint/consistent-type-imports` with `fixStyle: 'separate-type-imports'` in every linted package: backend, worker, ai-service, frontend, smart-pilot and jobs. An import used only as a type becomes its own `import type` line, the style every package already used (363 top-level `import type` lines in the backend, none inline). The setting lives in one file, `scripts/lint/type-imports.mjs`. This is PR C of the tooling plan from the create-t3-app comparison (founder decision 2026-10-24).

**The decorator trap, proved before fixing.** The backend compiles with `emitDecoratorMetadata`, so a class named only as a decorated constructor's parameter type is a runtime value, and `import type` would erase it and break dependency injection. With type information the rule reads that setting and leaves decorated files alone; without it, it flags them and its autofix would break them. Both behaviours were checked on a temporary decorated `@Injectable()` provider: with the backend's config it was not flagged; with the same rule and no type information it was.

So the backend applies the rule only to the files `promise-rules.mjs` gives type information. `scripts/lint/type-imports.test.mjs` holds that in place: `pnpm test` runs it, and it checks every TypeScript file in each package whose tsconfig enables decorator metadata (today only the backend, which acts as a floor). Deleting the backend's `promiseRules(…)` line turned it red; restoring it turned it green.

**Measured, then fixed.** 38 findings in 26 files. 21 were fixed by `eslint --fix`, in 18 files: every changed line is an import line, none of those files has a decorator (66 backend files do), and the one autofix that came out badly formatted (`packages/smart-pilot/src/client.ts`, moving `medicationSchema`, used only in `z.infer<typeof …>`) was formatted by hand. The other 17 were `typeof import('…')` type annotations in Jest and Vitest module mocks. Those import nothing, so `disallowTypeAnnotations: false` keeps them, with no edit.

**Tests.** A temporary file importing a class used only as a type was flagged in all seven covered folders (backend `src` and `test`, worker, ai-service, frontend, smart-pilot, jobs) and removed after each run. Also restores the space in the root `test` script that #50 dropped (`&&node`).

**Limits.** `packages/shared-types`, `cpic-schema` and `fake-idp` have no lint script and are not covered.
