# Packages

Workspace packages: code the apps import, with two exceptions that are run instead. **Synthetic data only.** Documentation map: [docs/README.md](../docs/README.md). Deployable processes are under [`apps/`](../apps); a package is referenced as `workspace:*` (`pnpm test` fails otherwise).

| Package | What it is | Imported by | First file |
| --- | --- | --- | --- |
| [`shared-types`](shared-types) | API contracts, roles and the patient, report and evaluation types | backend, frontend, smart-pilot | `src/index.ts` |
| [`cpic-schema`](cpic-schema) | Schemas and vocabulary for the knowledge and the phenotype and recommendation engines. The real schema source: `knowledge/schemas` is an empty placeholder | backend, ai-service | `src/` |
| [`jobs`](jobs) | Queue, backoff, runner and shutdown primitives | backend, worker, ai-service | `src/index.ts` |
| [`fake-idp`](fake-idp) | A test-only identity provider. **Never deploy it, and never point production at it** | backend and frontend tests | `src/` |
| [`smart-pilot`](smart-pilot) | A local, synthetic-only SMART/FHIR rehearsal with its own entry (`src/start.ts`), tests and UI. The package you run rather than import | nothing | `src/start.ts` |
| [`fhir-utils`](fhir-utils) | An empty placeholder (a `.gitkeep`); nothing to read yet | nothing | none |

[The layout decision](../docs/adr/0001-repository-layout.md) says `packages/` holds shared libraries and `apps/` holds deployable units. Two things do not fit that rule and the decision does not record them: `smart-pilot` is run rather than imported, and `apps/ai-service` is a library under `apps/`. Importer lists were read from each `package.json` on 2026-11-07; `fake-idp` is a dev dependency of the backend and the frontend.

**Does not belong here:** a process that serves traffic (`apps/`), clinical content (`knowledge/`, gated), real data of any kind.
