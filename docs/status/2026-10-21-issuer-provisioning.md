# The provisioning task creates the issuer's login (DATA-01 PR C, written never applied)

Date: 2026-10-21

The one-off provisioning task now passes `PROVISION_SECRET_ISSUER` (the id of the issuer's secret container), and the provisioning task role reads and writes that secret as the fifth connection string, so `db provision-logins` creates `telesphoros_session_issuer` and stores its connection string. The change in `api-compute.tf` is three lines: the environment entry, the fifth ARN and the statement's name. No execution role gains the secret: the provisioning execution role still reads only the RDS administrator secret, and the API's service, migration and task roles still cannot reach the issuer secret.

Because the task always names the secret, the next provisioning run creates the issuer login even though `enable_issuer` is still false. Before migration 0028 the issuer login's privilege check says `SKIP`; run the command again with `--require-migrated` after `migrate up` and it must pass (`docs/ops/api-hosting.md`, `docs/ops/staging-rehearsal.md`).

Guards: `api-compute.guard.test.mjs` pins five secrets with named checks, ties the Terraform variable names to the names `apps/backend/src/db/cli.ts` reads, and requires the issuer secret to be named exactly twice in that file. `issuer.guard.test.mjs` allows exactly those two occurrences, in their exact shape, and reports any other file, statement or change. Nineteen defects injected one at a time, in the Terraform, in `cli.ts` and in the guards themselves, all turned a test red.

Written, never applied. Not verified: a real task run, `tofu plan` with real variables, and `tofu test` (it fails locally against CI's Terraform exactly as on `main`). Left for later: the API client. The provisioning and migration task commands still start with `node` although the image's entrypoint is `node`; that is the separate follow-up named in the issuer entry fragment, and this change does not touch those commands.
