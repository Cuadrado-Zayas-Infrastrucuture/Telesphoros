# Staging runs the expired-capability sweep

Date: 2026-10-31

**Released (synthetic staging, founder-run, the same recipe as the 6c4714de release).** `main` `299efbb3` (spec 026 PR A, #214): image
`sha256:e1ea8d63…`, pushed by hand under the break-glass exception (CI cannot sign in this account; recorded in [ci-cd.md](../ops/ci-cd.md)).
In order: the migration task moved to the new image (1 replaced), a manual snapshot `telesphoros-staging-pre-299efbb3`, migration 0065
(`expand`: one new function; pending before `0065`, after `(none)`), then the API and worker task definitions (3 replaced, the two services
updated; both steady within two minutes). Each plan was read line by line, pinned by its sha256 and checked against the expected shape before
it was applied.

**Checked after the release, read-only.** API and worker: one task each, on the new image. `/api/v1/ready` and `/api/v1/health`: 200. No alarm
in ALARM or INSUFFICIENT_DATA. The sweep: its first run removed **73** expired capabilities and reported `current`; the runs after it removed
none. That is spec 026 D5's measurement, taken from the sweep's own log lines as the founder chose.

**Image scan (ECR, linux/amd64).** 0 critical, 8 high, none with a Debian bookworm fix. Seven are the ones the last release carried; one is new,
glibc CVE-2026-84243 (catalogs loaded from a path named by `LANGUAGE`), which Debian lists as unfixed in every suite. The image already carries
the newest bookworm glibc, and the image it replaced has the same glibc.

**Alarms (#216), applied the same evening** once the sweep had run (the stale alarm treats missing data as a breach, so it could not go first). The plan was
complete and had six creates and nothing else: three log filters (`capability-sweep-ran`, `-failed` and `-behind`) and three alarms (failing, stale, behind).
Afterwards all three alarms were OK, the sweep logged one run a minute, and the account held 34 alarms (31 before). Spec 026 SC-002: each alarm was
forced into ALARM once (twice in all, since the script was run twice); CloudWatch reported the notification executed for every one, they returned to OK
within two minutes, and the test emails arrived. That proves the notification path, not the metric path.

**Not established.**
- SC-001 (no row older than one interval plus five minutes, a day after the release) is read tomorrow.
