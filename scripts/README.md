# Scripts

Automation grouped by purpose. **Synthetic data only.** Documentation map: [docs/README.md](../docs/README.md). The root `package.json` exposes a subset as `pnpm` commands; the rest are called by those commands, by CI or by a runbook. The repository rule is that no secret is printed or committed. The demo scripts stop only the processes they started and refuse an occupied port instead of killing whatever holds it.

| Folder | What it is | Start with |
| --- | --- | --- |
| [`local-storage/`](local-storage) | The disposable storage demo: owned PostgreSQL, S3 emulator and fake identity provider, with ownership checks and teardown | `pnpm demo:storage`, then [start-here](../docs/start-here.md) and [local storage operations](../docs/ops/local-storage-operations.md) |
| [`local-review/`](local-review) | The separately gated capture/review demo; it needs reader captures that are not in the public checkout | [README](local-review/README.md) |
| [`staging/`](staging) | Read-only staging status, plan checks and the release recipe (`staging/release/`: claim, plan, apply, image, migrate, verify, frontend, state backup) | [environments](../docs/ops/environments.md), [staging release](../docs/ops/staging-release.md) |
| [`workspace-build/`](workspace-build) | Builds a workspace package's dependencies before its checks, and the version rules `pnpm test` enforces | `pnpm typecheck`, `pnpm build` |
| [`lint/`](lint) | Shared lint rules (promise handling, type-only imports, Prettier scope) used by every package's ESLint config | [CONTRIBUTING](../CONTRIBUTING.md) |
| [`test-fixtures/`](test-fixtures) | PostgreSQL fixture lifecycle regression tests and fixture helpers | [README](test-fixtures/README.md) |
| [`e2e-storage/`](e2e-storage) | Provisions the disposable database the PostgreSQL browser suite needs | [local storage browser tests](../docs/ops/local-storage-browser.md) |
| [`drug-list/`](drug-list) | Regenerates the bundled drug list (`packages/shared-types/src/drug-list/bundled.json`) from the CPIC drug table and RxNav, writing it only if every request succeeds | [README](drug-list/README.md) |
| [`cognito/`](cognito), [`readiness/`](readiness) | `cognito/` generates the hosted sign-in stylesheet (`infrastructure/terraform/cognito/hosted-ui.css`) from the frontend's color tokens; `readiness/` is a local synthetic load rehearsal | the script's header comment |
| `status-index.mjs` | Prints the index of `docs/status/` fragments, newest first | `pnpm status:index` |
| `check-without-reader.sh` | Runs the backend tests as the public checkout sees them, with the private reader directories renamed away and restored on exit | [the engine is optional](../docs/lab-report-reader.md#the-engine-is-optional) |

**Does not belong here:** application code (`apps/`, `packages/`), Terraform (`infrastructure/`), a script that holds or prints a live value; those live in the private folder named in [team access](../docs/ops/team-access.md).
