# Plan: Vercel design previews of the frontend

Status: **decided by the founder in conversation on 2026-10-16 and built on this branch.** Verification is below. This is not deployment approval for the product, which stays on AWS.

## Decisions recorded (founder, 2026-10-16)

- **Frontend only on Vercel; the product stays on AWS.** The founder asked whether Vercel is better than AWS and chose "frontend only on Vercel". This keeps the hosting decision on record ([domains-and-hosting.md](../../ops/domains-and-hosting.md): company site on Vercel, Telesphoros on AWS) and the staged AWS deployment (FD-7). The alternative considered, the NestJS API as a Vercel service, is not built, for these reasons:
  - report bodies of up to 10 MiB pass through the API, over Vercel's documented 4.5 MB function request limit;
  - the worker and the ledger watch need a long-running process;
  - PostgreSQL with its separate logins, versioned S3 and Cognito would still live elsewhere;
  - one AWS BAA would become several.
- **A new Git-linked Vercel project, `telesphoros-previews`.** Every branch and pull request gets its own preview URL, behind Vercel Authentication. The existing `telesphoros-site` project and its `www.telesphoros.app` domain are not touched.
- **Visual only.** Sign-in and API settings are fixed placeholders on reserved `.invalid` hosts. Pages render; sign-in, upload, the assistant and every API call cannot work. No data, synthetic or real, is stored. This matches the earlier approved design preview.
- **No Vercel "services", no bindings.** With one frontend there is nothing to route between. `packages/smart-pilot` is a loopback-only local rehearsal tool and is never deployed. `apps/ai-service` is an empty scaffold.

## What is added

- `vercel.json` at the repository root:
  - pnpm install with the frozen lockfile;
  - the build script below, publishing `apps/frontend/dist`;
  - one single-page fallback to `/index.html`, so a deep link such as `/reports` loads the app;
  - `X-Robots-Tag: noindex, nofollow`, `nosniff`, `no-referrer` and `X-Frame-Options: DENY` on every response.
- `apps/frontend/scripts/build-vercel-preview.sh`:
  - discards every inherited `VITE_` setting, so a value added in the Vercel dashboard cannot point a preview at a real backend or switch on another frontend mode;
  - builds the shared types and the production frontend with the four placeholder settings;
  - removes source maps and the build manifest, as the AWS frontend publish does.
- `apps/frontend/scripts/vercel-preview.test.mjs`, run by the frontend `test` command (so by CI's `verify` job). It checks those rules and proves each by breaking an in-memory copy:
  - six config defects: a backend service, environment settings, another build command, another output directory, an API proxy, no `noindex`;
  - five script defects: inherited settings kept, a real API host, a real sign-in host, another frontend mode switched on, source maps published.

## Not touched

The application code, the backend, the AWS Terraform and the FD-7 plan, the `telesphoros-site` Vercel project and its domains, DNS, and the company site.

## The founder's step in Vercel

Add New → Project → import `Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered`:
- name it `telesphoros-previews`;
- keep the Root Directory at the repository root; `vercel.json` supplies the rest, and no environment variables are needed;
- confirm that **Settings → Deployment Protection → Vercel Authentication** is on, the default for new projects.

The Vercel connector used from the agent session can read projects but was refused (403) when creating one, so this step is manual.

## Verification

- `node --test scripts/vercel-preview.test.mjs`: 12 of 12. That is the real configuration plus 11 injected defects, each refused.
- `eslint` on the new test: clean.
- The build script was run exactly as Vercel will run it: from the repository root of a clean clone of `main` (`bd7a7e5`) with this change copied in, after `pnpm install --frozen-lockfile`. Two hostile inherited settings were deliberately set (`VITE_API_BASE_URL=https://api.leak.example`, `VITE_LOCAL_STORAGE_INTAKE=true`). Result:
  - the build passed;
  - the bundle carries `api.invalid` and no trace of the leaked host;
  - no source maps and no `.vite` directory;
  - served locally, `/` renders the product landing, not the owned-storage home.
- **Not verified:**
  - a real Vercel build: no CLI or token here, and project creation was refused. Vercel's choice of pnpm for this lockfile is the main unknown;
  - that Vercel serves files before applying the single-page rewrite, which its documentation describes;
  - the headers on a live deployment.
