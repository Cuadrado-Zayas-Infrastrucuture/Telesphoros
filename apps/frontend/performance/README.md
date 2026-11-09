# Synthetic patient-loading measurements

This opt-in Playwright measurement uses the built frontend, real API, disposable
PostgreSQL with the application role and tenant memberships, the test identity
provider, and local Moto. No patient response or credential is written to the
measurement JSON. It creates synthetic fixture data only.

Use Node 22.22.0 and pnpm 10.28.0. From the repository root, build with `pnpm build`
and `pnpm --filter @telesphoros/frontend build:e2e`. Prepare a disposable database
using [the browser provisioning procedure](../../../scripts/e2e-storage/provision.sh):
set `E2E_OWNER_URL` to your loopback PostgreSQL owner connection, choose fresh
`E2E_DB_NAME=synthetic_storage_<suffix>` and `E2E_APP_LOGIN` values, and set
`E2E_ENV_FILE` to a private temporary file. Run the provisioning script, then
source and export the resulting `E2E_DATABASE_URL`. The performance configuration
uses the storage suite's loopback/non-owner checks. Install the pinned Moto
dependencies and Playwright Chromium as for browser acceptance; `MOTO_SERVER`
and `CHROMIUM_PATH` may select already installed tools.

Run from the repository root:

```sh
PERFORMANCE_OUTPUT=/tmp/patient-loading.json \
  pnpm --filter @telesphoros/frontend exec playwright test \
  --config playwright.performance.config.ts
```

The fixture has complete demographics and 20 recorded medications. Five new
browser contexts each measure a first patient visit after sign-in and a return
visit through browser history, at both 0 and 120 ms CDP network latency. HTTP
caching is not overridden and requests are not intercepted. Authenticated data
still uses the application's `no-store` policy; return visits reuse loaded code,
not cached patient responses. The first visit is not a cold server or a complete
sign-in/page-load measurement.

`readyMs` runs from the first of the three patient reads until identity,
demographics and all 20 medication rows are visible. Request offsets show the
waterfall independently of that UI measurement. Direct API timings are five
warm, unthrottled reads per endpoint. Compare medians and ranges on matched
revisions, fresh databases and the same host/browser, with no other tests running.
These small local samples characterize scheduling; they are not production
latency, load-capacity or p95 evidence. The benchmark asserts fixture correctness
but deliberately sets no timing threshold and does not join default CI suites.
