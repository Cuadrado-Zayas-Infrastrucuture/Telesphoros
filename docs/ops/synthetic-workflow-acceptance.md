# Real synthetic OpenEMR workflow acceptance

This opt-in test joins the earlier slices. It opens actual synthetic charts in OpenEMR, completes real SMART OAuth/PKCE, reads the actual test API using signed identities, and verifies the built React viewer against a fresh PostgreSQL database and versioned Moto bucket. It does not stub browser evidence responses or advance a fake clock. See the [acceptance matrix](../design/plans/synthetic-workflow-acceptance.md).

## Run

Use the repository's pinned Node/pnpm versions. Install dependencies and Playwright Chromium (`pnpm --filter @telesphoros/frontend exec playwright install chromium`), Python dependencies for the recorded-text reader, PostgreSQL 16, and Moto. Provision the dedicated local synthetic OpenEMR with `pnpm demo:smart:setup`. Its generated `.runtime` files must remain private (0600).

Stop your own standalone `demo:smart` process so port 8767 is free; leave OpenEMR on 8301. The test owns its pilot listener and closes it afterward. It never kills a process occupying that port or edits your runtime registration/stored-reader files.

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres \
TEST_S3_ENDPOINT=http://127.0.0.1:5555 \
pnpm --filter @telesphoros/smart-pilot test:workflow
```

The database URL must identify a disposable local test cluster whose owner can create databases/roles. Both service hosts must be exactly `127.0.0.1`; S3 must use HTTP without URL credentials. Inherited AWS settings are removed and emulator-only credentials supplied. Production mode, missing/private-file violations and missing services fail; there is no skip/pass fallback. An installed Chrome may be used with `WORKFLOW_BROWSER_CHANNEL=chrome`.

The launcher builds the pilot, then runs the explicitly named backend workflow suite. Ordinary backend tests deliberately do not include this suite because they do not provision OpenEMR. CI's existing browser and database jobs do not claim to execute this real-EHR workflow. The preflight refusal tests run in the normal pilot suite.

## Isolation and evidence

Only two pre-provisioned synthetic EHR patients are used. Fixture setup creates a random tenant, a fresh `test_<random>` PostgreSQL database and a new `test-reports-<random>` Moto bucket through existing test helpers. A restricted application role serves the real API. Tokens use the fake test identity provider; report capture uses the existing recorded D01 runner and test knowledge. Neither is a clinical validation substitute.

Separate setup calls perform capture acceptance, evaluation and reviewer corrections; the connector only reads. The test observes actual transport methods and checks unchanged tenant-scoped evaluation/ledger counts around browser operations. OpenEMR login, OAuth consent and token exchange necessarily update authentication/session state; no EHR clinical data is written. No screenshots, traces, passwords, bearer tokens, signed URLs, report payloads or page dumps are logged.

The test overwrites one newly created source object with synthetic D02, then deletes only its originally pinned D01 version to prove refusal. The blast radius is that run's unique emulator bucket; the fixture recreates the bytes. No retention policy is changed. The test database is dropped after execution. As in the existing S3 test helpers, synthetic emulator objects/buckets remain until the disposable emulator is reset; this is not production retention behavior.

The launcher replaces `packages/smart-pilot/openemr/.runtime/workflow-verification.json` with RUNNING, then PASS or FAIL. It records timestamps, Git HEAD, whether the worktree was dirty, and test dependency boundaries; the command's exit status is authoritative. A dirty-worktree result is local working-tree evidence, not exact-commit CI evidence. Interrupted runs can remain RUNNING. Aggregate step counts are printed without identifiers.

After testing, restart the ordinary local viewer with `pnpm demo:smart` if desired. Its prior private runtime configuration is unchanged.

## Limits

This completes the planned synthetic integration acceptance sequence when the command passes. Evidence can remain visible until the next recheck (15 seconds, 30-second freshness ceiling); there is no push notification or atomic multi-service snapshot. A missing source fails closed. An explicit operator-selected replacement requires a new launch; there is no clinical workflow for writing back, prescribing or auto-selecting a replacement.

The Bundle is checked against the vendored core R4 schema and finite terminology contract in this workflow. The separate pinned official IG validator and finite terminology tests remain the source of Genomics Reporting profile evidence. Clinical validation, production SMART registration/security review, hosted identity/storage enforcement, real patient consent and deployment approval remain outside this synthetic slice.
