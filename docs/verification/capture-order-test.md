# Capture-decision concurrency test budget

Date: 2026-11-01. Public Telesphoros. The independent test-only repair began from main `7ff49849` and delivery rebased onto `916eb756` after input-boundary repair PR #241 merged. The founder approved preserving every reviewer race while separating independently bounded cases. Consent PR #240 and UX PR #238 remain separate; the capture test and production source did not change during this rebase.

## Observed failure and contract

The [PostgreSQL/S3 job for consent PR #240](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros/actions/runs/41316089921/job/124876385395) reported a five-second test-body timeout in `test/db/capture-decision-order.pg-spec.ts`. Its result was 3,966 passed, one failed and one skipped; the browser and other application checks passed. The CI log does not identify the particular slow iteration or operation.

The original regression, introduced in `7a332a35`, protects a per-capture advisory lock. Without it, capture-acceptance row sequence can disagree with ledger order when two reviewers decide one capture concurrently. The old test ran 60 separate tenant/report/capture scenarios in a loop inside one default-budget test, required both reviewer writes to succeed, and required zero disagreements between the current decision and an independent SQL ledger-order oracle.

## Reproduction and repair

The original unmodified test passed on a newly owned PostgreSQL 16 cluster and produced 60 captures, 120 decisions and two reviewers. Adding 90ms of controlled latency before each real fixture seed reproduced its five-second timeout after 42 races. This is a controlled aggregate-budget reproduction, not a measurement of the hosted runner's slow call.

The repair uses `it.each` for the same 60 sequential scenarios. Only the two reviewers within each scenario run concurrently, as before. Every case retains the default five-second limit, both successful-write assertions and direct equality with the independently queried last ledger decision. The oracle must also return a decision, making a missing result an explicit failure. There is no shared disagreement counter, retry, omitted race, added timeout or production-code change.

With identical seeding latency, all 60 cases complete and the database still contains 60 captures and 120 decisions from two reviewers. The measured slowest case was about 129ms; combined test time was 6.6s. Ordinary latency also passes all 60. A genuinely stalled individual case remains subject to its original five-second deadline.

## Ordering sensitivity

A private diagnostic delayed the first reviewer's real INSERT response by 100ms, allowing the second reviewer to contend. With the real production lock, all 60 cases passed. An isolated copy of the repository with only that per-capture lock removed failed all 60 cases at the ledger-order equality assertion, while still recording all 120 decisions. Those were ordering failures, not fixture/import errors or timeouts. The production source file was never edited, and the mutation copy and diagnostic wrappers are not part of the PR.

This checks the meaningful guard under real PostgreSQL transactions. The diagnostic adds response latency around real operations; it does not fabricate database, repository or oracle results. The ordinary CI suite runs the real production implementation without these diagnostics.

## Verification and limits

Complete before/after output, numeric timings, actual row counts, child exit statuses and owned-service cleanup receipts are retained under `/private/tmp/pr240-capture-before`, `/private/tmp/pr240-capture-after`, `/private/tmp/pr240-capture-guard` and `/private/tmp/pr240-capture-mutant`. Expected failing controls remain failures. The pre-sync full tier passed 4,026 tests in 286 suites, with one skip; that historical run remains under `/private/tmp/pr240-capture-full`. Final project and complete service-tier results on the combined delivery candidate are recorded separately in the PR and shared working notes, with the final service run under `/private/tmp/pr240-capture-final-full`.

The harness uses the existing migrated PostgreSQL fixtures and restricted application role on a fresh random-port cluster, plus a local S3 emulator for the complete tier. It shuts down only the services it creates. Synthetic fixtures only; no production database, paid service or patient data. No clinical logic, schema, auth/tenant policy, capture/ledger implementation, frontend, dependency, shared fixture helper or CI gate is modified.

This changes the scope of the default test deadline from the 60-race batch to each independent race; it is not a throughput claim. The number of reported passing tests increases by 59 because the existing workload is exposed as individual cases. Hosted CI remains required. The optional real-issuer profile, absent private reader engine, container image and new device/accessibility checks are outside this test-only change. Codex produced the change, diagnostics and report; no merge or deployment is included.
