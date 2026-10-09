# Local synthetic review verification — 2026-10-09

Base: main435e532929cf5d1cf617fcfcb3eb5d5c63007efb. macOS/Darwin arm64; Node22.22.0/Unicode16; pnpm10.28.0; PostgreSQL16.14; Python3.14.6; Poppler26.03.0. This is visible synthetic engineering evidence, not independent clinical validation or an unseen PDF experiment.

| Check | Result |
| --- | --- |
| Production build, lint, typecheck | Passed |
| Frontend tests | 111 passed /13 files |
| Package tests | Shared-types20, CPIC-schema36, fake-IDP7, notifier9 passed |
| Backend tier1, in-memory API plus actual PG/S3 specs | 1300 passed;180 intentionally skipped PostgreSQL API variants |
| Backend tier2, PostgreSQL API | 1479 passed;1 S3-only case intentionally skipped |
| Backend tier3, PostgreSQL + S3 protocol | 1480 passed;90 suites;zero skipped |
| Real Poppler direct tests | 6 passed |
| Defect injections | 14 caught;source restored after each mutation |
| Infrastructure/CI configuration guards | 20/13 passed |
| Production chunk budget | 141.1kB gzip entry;150kB budget;6 page chunks |
| Production knowledge check | Passed;zero real guidelines loaded |
| Portable live upload/capture/Poppler/operations checks | Passed against isolated PostgreSQL and local Moto |
| Browser | Sign-in callback, capture form and operations controls render on portable launcher |

Live checks include checksum/size/type refusal; missing-upload recovery; unauthenticated401 and reader403; same-actor review409; rejected-capture evaluation409; D01 outcomes equal the committed hand-written oracle; clinical/training flags false; cross-tenant404; correction role/stale/self-review refusals, retraction/reinstatement/supersession; dispute independent decision, affected-evaluation listing and full ledger walk.

Mutation coverage: preview hash, explicit comparison, capture reviewer role, accepted-only evaluation, local file origin, configured emulator origin, extractor version, binary drift, PDF allowlist, text oracle, operations confirmation, operations reviewer role, changed-cell confirmation and admin ledger control. Mutation tests require assertion failures, not just a nonzero process exit.

Initial full run failed because the isolated cluster lacked a role named `postgres`, assumed by an unchanged RLS refusal test. An unprivileged NOLOGIN role was added only to the test cluster; no superuser role or production migration was added. All three tiers then passed. Initial sandbox loopback restrictions and two integration defects (invalid build identifier and copied test import) were resolved before reporting these results.

The runbook's dedicated database is synthetic-only, loopback trust. App and verifier logins are restricted. Moto objects are ephemeral; persistent DB metadata does not make file evidence durable. General PDF support, production release, AWS deployments, training and clinical approval remain out of scope.
