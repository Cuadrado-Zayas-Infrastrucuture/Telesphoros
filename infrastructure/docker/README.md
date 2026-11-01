# API image and first-deployment rehearsal (FD-4b)

Synthetic only. No AWS credentials, resources, registry push, fake identity provider, Python, or clinical release.

```sh
docker buildx build --platform linux/amd64 --load -f infrastructure/docker/api.Dockerfile -t telesphoros-fd4b:rehearsal .
node --test infrastructure/docker/guard.test.mjs
node infrastructure/docker/rehearsal.cjs telesphoros-fd4b:rehearsal
```

The official Node 22.22.0 Debian base is pinned to its multi-platform digest. The build installs the frozen workspace and deploys production dependencies only; a build-only check compares their actual edges and versions after removing leftover pnpm aliases back into the build checkout. A preparation stage applies the existing pinned Debian fixes. `runtime-rootfs.cjs` then copies Node and its seven explicitly reviewed linux/amd64 shared libraries into a scratch runtime, along with Debian identity, truthful source-package inventory for those libraries, and their copyright files. An unexpected library, native addon, native ELF payload or application symlink outside the deployment fails the build. A new native dependency needs an explicit runtime review.

The runtime carries no shell, package manager, mount/nsenter/partition utilities, system libz/libmount/libblkid, setuid/setgid executables, or non-C locale files. It keeps Node's built-in compression and ICU APIs, compiled application/workspace packages, migrations and checked public RDS trust roots. `LANG`, `LC_ALL` and `LANGUAGE` default to `C`; the numeric user remains 10001 with an exec-form Node entrypoint. Deployment still supplies secrets and a read-only filesystem. This is the application/task image, not a general-purpose administration image; tools that were never installed here, such as pg_dump, remain unavailable. [Security scope and residual risks](runtime-security.md).

The existing image rehearsal starts with a real-runtime check under user 10001, read-only root, no network, dropped capabilities and no-new-privileges. It checks excluded libraries/tools and privilege bits, preserved Debian inventory, Node gzip round-trip and hostname lookup before the full provisioning/migration/API/worker rehearsal. These extra local restrictions do not change deployed Terraform settings.

The founder independently downloaded the public RDS bundle on 2026-10-09 and confirmed SHA-256 `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c` and 111 certificates. The local file additionally measured 169,984 bytes. The image checks the recorded checksum during build. Hash equality verifies the vendored bytes, not AWS server configuration or ongoing certificate validity.

The rehearsal creates uniquely named throwaway containers/network, a one-day CA and certificate for the internal `pg` hostname, a SCRAM-authenticated PostgreSQL 16 cluster, and Moto Secrets Manager. A non-superuser administrator runs the image's own provisioning command; the migrator applies the schema; provisioning verifies migrated privileges. Generated passwords never appear in console output. Both APIs use production mode, Cognito configuration without development overrides, strict TLS, user 10001, and read-only filesystems. A connection through a resolving hostname absent from the test certificate must fail hostname verification. No actual Cognito token validation or S3 request is exercised.

**Correction to the original plan:** on a pristine database, production ledger verification refuses startup before HTTP listen. The rehearsal asserts that refusal instead of manufacturing a pre-migration `/ready` 503. After migrations, both APIs must report health 200, readiness 200, and an unauthenticated `/me` 401.

The compiled repository writes a synthetic capture and records containment through the verifier login in one container process. A separate image process, with no cached incident state, attempts a new capture: the database must refuse and roll back it; the same operation for a healthy tenant must succeed. Both running API tasks must subsequently report `contained` through their normal incident polling. The production pipeline remains disabled: this test exercises compiled write paths, not an authenticated production capture route.

Cleanup removes ONLY this run's generated container names (including their disposable volumes), its own network, and its own temporary directory. It never prunes Docker or accesses existing databases. Interrupted runs may require cleanup of the specific printed/generated names; never run global prune as a substitute.

CI's `image` check exports an OCI archive with SBOM/provenance, then reuses the same builder/cache to load an unattested Docker runtime (compatible with classic image stores), scans fixed HIGH/CRITICAL vulnerabilities, and rehearses. The OCI artifact is private and expires after one day; Docker load alone can discard attestations. The exception file is empty. An exception requires actual review, rationale, owner and expiry; a failing scan is not permission to add one. Keyless signing, ECR/OIDC, live IAM/RDS/Fargate behavior and costs remain later work.

The founder must import the updated `.github/rulesets/main.json`; editing its file does not change live branch protection.

## Local verification, 2026-10-09

The linux/amd64 image built under Docker 29.6.2 on macOS. The running image uses Node 22.22.0 and ICU 77.1; local orchestration uses Node 24.14.0. The synthetic rehearsal passed provisioning, wrong-hostname TLS refusal, pristine startup refusal, migrations, privilege verification, two API health/readiness/auth checks, cross-process contained-write rollback, the healthy-tenant control, and containment polling by both APIs.

All 43 Dockerfile/CI contract tests passed. Twenty-six mutations of actual Dockerfile, workflow or CA files each made the checks fail; the unmodified controls passed before and after restoration. Lint, type checking and 31 infrastructure guards passed. Trivy 0.69.3 reported zero fixed HIGH/CRITICAL findings with an empty exception list. This is a scan at that time, not a promise about later databases or unknown vulnerabilities. The existing database/S3/browser CI tiers remain required and are reported separately on the PR.

## PostgreSQL startup readiness

The official PostgreSQL image starts a socket-only temporary server during initialization, then replaces it with the final TCP server. A socket `pg_isready` probe can succeed before initialization ends and race subsequent setup SQL. The rehearsal now probes `127.0.0.1` inside its PostgreSQL container before proceeding. Its 60-second readiness budget, SCRAM authentication, strict TLS checks and setup SQL are unchanged; partially executed setup SQL is never retried.

CI runs `node --test infrastructure/docker/postgres-readiness.test.cjs` before the full rehearsal. This real-container regression holds initialization at a barrier, proves the old socket probe succeeds, requires the TCP probe to reject it, then releases initialization and requires the final server and a SQL query to succeed. The test's trust authentication is confined to a uniquely named container with `--network none`; the full rehearsal remains SCRAM-authenticated. Cleanup removes only that run's container and disposable volume.

Verification on 2026-10-11: [regression passed](/private/tmp/pg-readiness-test-final.log), [old-probe mutation failed](/private/tmp/pg-readiness-mutation.log), [restored fix passed](/private/tmp/pg-readiness-restored.log), [54 Docker/CI guards passed](/private/tmp/pg-readiness-guards.log), [current API image built](/private/tmp/pg-readiness-build.log), and [full rehearsal passed](/private/tmp/pg-readiness-rehearsal.log). The original CI output masks setup errors to protect generated credentials; the local reproduction independently confirmed socket readiness before initialization completion. No raw setup stderr was exposed.

PR #73 also reported a separate five-second timeout in the backup-restore downgrade-refusal test. This readiness change does not alter that test or claim to fix it. Retention settings, clinical gates and all existing image checks remain unchanged.
