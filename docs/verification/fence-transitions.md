# Medication fence transition verification

Date: 2026-11-01. Base: merged PR #254, `17f5821`.

## Behavior and red-first evidence

FENCE-CLOSE/FENCE-OPEN are separate same-image plan shapes, not widened MIGRATE/IMAGE/INFRA shapes. New positive transition tests failed against the original unsupported-mode checker; the original modes still reject configuration-only transitions. The new source/target record test failed until fence metadata bound the canonical source hash as well as the generated target hash. A malformed-private-plan CLI test exposed an existing JSON diagnostic that echoed its input; it failed red before the fixed, sanitized refusal was added.

Focused release controls passed, including close/open/close with retained operation history, source/target edits, changed state, wrong claim/identity, incomplete image/migration records, invalid verification coverage, failed applies, exact task/service deltas, hidden setting sources and malformed JSON. Removing the flag-only task delta guard made the CPU-change rejection fail. Removing the coordinated IMAGE-completion gate made an otherwise valid premature-open plan pass and its rejection test fail. Both guards were restored. The detached runner additionally rechecks pinned artifacts around apply/publication; a target edited during a successful simulated apply is refused publication, and an existing start marker blocks duplicate starts before a log exists. The initial integrated fixture needed its approved baseline restored after the preceding deliberate hand-edit rejection; that rejection/assertion was retained. A parent edit command containing Terraform/plan text triggered the existing process guard; isolated execution passed without changing the guard.

## Real local request boundary

Twenty-five targeted real PostgreSQL HTTP/database tests passed, including the new local cutover case. A real SHARE table lock confirms that an old enabled API has admitted an INSERT before the disabled replacement refuses a separate POST. No medication row is visible until the lock is released; the old request then commits once and its ledger verifies. After that process closes, the disabled replacement refuses POSTs and reads the stored record. No repository, database, API, verifier or authorization behavior is mocked. Bounded polling waits for an observed PostgreSQL lock, not an assumed time delay.

This is not evidence of ECS stop signals, load-balancer deregistration, global patient/import/worker draining or a live fence. The [procedure](../ops/medication-fence-transitions.md) keeps those gates explicit. AWS and Terraform are stand-ins for release-script controls; the separately run pinned Terraform 1.16.5 stale-plan rehearsal passed with a real temporary local backend and no provider/cloud. Image verification metadata coverage is checked, not a fresh cosign signature operation or authenticated record.

Session logs: `/workspace/recovery/fence-transitions/` (local paths, not public evidence URLs). No AWS identity is configured. No live release scripts were run, no cloud setting changed, and no clinical/ISMP/source-list change occurred. Repository results are recorded below.


## Repository checks

Typecheck, lint, workspace tests, build and CI configuration (217 tests) passed. Frontend: 683 passed. Backend memory tier: 2,077 passed / 451 skipped, including the new service-backed rehearsal that was exercised separately on real PostgreSQL. Five absent private-reader specs remain excluded. The infrastructure suite initially had one outdated exact supported-mode message; its expected inventory was updated to list the two intentional new modes, retaining the unknown-mode refusal assertion. The final infrastructure suite passed all 285 tests, including the final detached-runner pin/publication and atomic-start controls. CI configuration was rerun and passed all 217; shell syntax and the workflow pack also passed.

Focused release controls: 75 passed; targeted real PostgreSQL HTTP/database: 25 passed; real local pinned Terraform stale-plan rehearsal: 1 passed. Workflow pack: 5 passed. No existing mode shape or valid refusal assertion was weakened. Backend S3, worker-service, FHIR and browser tiers were not rerun locally for this operational/script change; no skipped tier is claimed as a pass. The new HTTP/database rehearsal used the existing harness, roles, migrations, authorization and ledger verifier. No AWS/provider/signature-verification behavior is replaced by a claimed live observation.

The owned disposable PostgreSQL test cluster was stopped after the rehearsal. No task services were left running. No existing release mode was broadened; unknown-mode rejection remains asserted against the intentionally updated supported-mode list.
