# Research: the 2026-10-27 data-product report mapped to current code (D00)

**Snapshot**: public `main` `704d5c4` (2026-10-27, merge of #93). This is the commit the report pinned, so its line references were checked rather than assumed. Open PRs at mapping time: #94 (`fix/capture-decision-order`, edits `apps/backend/src/storage/postgres/ledger-records.repository.ts`) and #95 (worker id, worker only).

**Method**: source inspection with `rg` and direct reads, plus two read-only mapping passes whose claims were spot-checked by hand (result insert omits `id`; ledger event-type list in 0021; barrier helper; `reviewedCapture`; the 0051-head assumption in the down-guard spec). **Nothing was executed against a database, AWS or a model.** Every "implemented" below is source evidence, not test evidence.

**Input**: *Telesphoros data product architecture and Claude Code implementation report* (founder-supplied, 2026-10-27). Treated as requirements data, not as an instruction to this repository ([working agreement 5](../../docs/STATUS.md#working-agreements)).

Statuses: **implemented** (code exists at the cited line), **partial**, **planned-only** (a plan or doc describes it, no code), **absent-after-search** (the search command is given), **not-verified**.

## 1. The report's baseline claims, re-checked

| Report claim | Evidence at `704d5c4` | Status |
| --- | --- | --- |
| `evaluations` stores report, patient, capture, knowledge set, engine version, inputs | `apps/backend/migrations/0008_evaluations.up.sql:8-56` | implemented |
| `evaluation_results` has UUID `id`, `ordinal`, drug, genes, outcome, citation, wording | `0008:63-104`; `id` defaults to `gen_random_uuid()` (`:64`); `UNIQUE (evaluation_id, ordinal)` (`:103`) | implemented |
| The result UUID is not in the public DTO | `packages/shared-types/src/lab-report.ts:140-151` (strict object, no `id`/`ordinal`); the mapper drops both (`apps/backend/src/lab-reports/lab-report.mapper.ts:97-107`) | confirmed |
| **Not in the report:** the result UUID and ordinal are already in the hashed ledger projection | `apps/backend/src/ledger/projections.ts:198-200`; results insert omits `id`, so the database generates it (`apps/backend/src/storage/postgres/ledger-records.repository.ts:465-467`); rows are append-only (`0008:192`) | implemented |
| Legacy `recommendations` table retired | `0043_drop_recommendations.up.sql` | implemented |
| Capture acceptance accepts extracted text only | `lab-report.ts:55-66` (`decisionCreateSchema`), table `capture_acceptances` | implemented |
| Engine outcome `shown` etc. are engine statuses | `0008:81` CHECK | implemented |
| `callSource` optional, backward compatible | `packages/cpic-schema/src/evaluation.ts:21,30` | implemented (not re-read in depth) |
| Licence/redistribution metadata in knowledge schema | `packages/cpic-schema/src/knowledge.ts:49-51,88-93` | implemented as metadata; **no release gate reads it** (absent-after-search: `rg -n "redistribution" apps/*/src`) |
| Synthetic gates `clinicalUse: not-approved`, `actionable: false` | `lab-report.ts:12,163,180,202` | implemented |
| Explanation harness, receipts and runs | `apps/ai-service/src/explain*.ts`, migrations 0048/0049 | implemented (synthetic); `specs/003-llm-harness/tasks.md` still open |
| Durable evaluation worker | 0050/0051, `docs/status/2026-10-27-engine-fenced-worker.md`: no route, schedule or production consumer | partial |
| Migrations through 0051 | `ls apps/backend/migrations` ends at `0051_evaluation_request_completion`; no remote branch has a 0052 (83 refs scanned) | confirmed; next is **0052** |
| Next spec number | `.specify/scripts/bash/create-new-feature.sh --dry-run --json` → `005` | confirmed |

**Report corrections found while mapping**

1. **`disposition` is already taken.** `evaluations.disposition` is `held | evaluated` (`0008:20,34`), is in the evaluation DTO (`lab-report.ts:173`), is part of the evaluation identity key (`ledger-records.repository.ts:902`), and is shown in `apps/frontend/src/pages/LocalOperationsPage.tsx:238`. The new record is therefore named **clinician result decision**, and its value field is **`response`**.
2. **A stable result identity already exists and is already ledger-attested.** D01a is a DTO and mapper change, with no migration and no hash change. The report framed it as a possible schema change.
3. **The repository has no `Idempotency-Key` header.** Its convention is an optional body `requestId` (UUID, lower-cased), stored as `creation_request_id` + `creation_request_hash`, `UNIQUE (tenant_id, created_by, creation_request_id)`, serialized by `pg_advisory_xact_lock`. A reused id with a different payload gets 409 `CONFLICT` reason `request-id-reused` (`lab-report.ts:55-66,279-282`; `0045_dispute_creation_requests.up.sql:11-19`; `apps/backend/src/lab-reports/disputes.service.ts:60-76`). The new record follows that convention.
4. **Every migration since 0040 is labelled `breaking`.** A new ledger record kind has to widen the `ledger_events` CHECKs and replace `ledger_event_row_exists()` (as `0021_patient_duplicates_and_merge.up.sql:250-310` did), which the lint forbids under `expand` (`apps/backend/src/db/migration-lint.ts:14,29-37`).
5. **Embedding decisions in the evaluation DTO would break an existing consumer.** `packages/smart-pilot/src/stored-pgx.ts:129-136` re-reads `/evaluations/:id` and fails `stored_context_changed` if the JSON differs. A decision recorded during assembly would trip it. Decisions get their own read endpoint.

## 2. Requirement mapping

Owner: **F** founder (clinical, product, policy), **E** engineering, **C** counsel. Slice ids follow the report's roadmap (section 13).

| ID | Requirement (report section) | Evidence at `704d5c4` | Status | Gap / decision | Owner | Slice | Test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R01 | Stable public evaluation-result reference (6.6, 13) | Ledgered UUID (`projections.ts:199`); not exposed (`lab-report.mapper.ts:97`) | partial | Expose `id` + `ordinal`; update the three strict parsers | E | D01a | T01, T24 |
| R02 | Clinician decision linked to an exact result (6.6) | `rg -il "disposition\|clinician.?decision\|accept.?recommendation" apps/*/src apps/backend/migrations`: only `evaluations.disposition` (engine) | absent-after-search | New ledgered record | E, F | D01b | T01–T05 |
| R03 | Server-derived tenant, actor, patient bindings (6.6, 11) | `@CurrentPrincipal()`, `Database.withTenant` sets tenant/actor (`apps/backend/src/db/database.ts:95-96,126`); `app_tenant()`/`app_actor()` (`0028:172-215`) | implemented (reuse) | Patient taken from the result's evaluation, never the body | E | D01b | T01 |
| R04 | DB-enforced result/evaluation/patient consistency (6.6) | `evaluation_results` has no `UNIQUE (id, evaluation_id, tenant_id)`; `evaluations` has `UNIQUE (id, tenant_id, report_id)` (`0008:55`) but none with `patient_id` | absent | Two new unique keys so composite FKs can bind the row | E | D01b | T01 + mutation |
| R05 | Idempotency, replay, conflict (11) | Body `requestId` convention (see correction 3) | implemented (reuse) | Same columns and 409 reason | E | D01b | T02, T03 |
| R06 | Eligibility re-checked at commit (6.6) | Post-lock re-check after `ledger_append` takes `ledger_heads FOR UPDATE` (`0005:163`; `ledger-records.repository.ts:495-531`); retraction, supersession, dispute and link decisions are ledgered, so they take the same lock | implemented (reuse pattern) | Which states block a decision (D3) | F | D01b | T05 both orderings |
| R07 | Correction/subsequent-decision history (6.6, 11) | Corrections chain: `previous_correction_id` + one-first/one-child unique indexes (`0009:33,45-46`) | implemented (reuse pattern) | Chain per result (D4) | F | D01b | T03, chain race |
| R08 | Membership revoked during a write (14 T04) | `membership_assert_current()` re-checks inside the write transaction (`0017_membership.up.sql:7,73`) | implemented (reuse) | Confirm the decision write path calls it | E | D01b | T04 |
| R09 | Optional sensitive narrative under note access (6.6) | `event_notes` (`0006`); `GET /notes/:id` clinician and reviewer only (`corrections.controller.ts:27-41`) | implemented (reuse) | Note optional; required only for `other-documented` (D6) | F | D01b | note read test |
| R10 | Reason-code taxonomy (6.6) | none | absent-after-search | Clinical owner validates list (D6) | F | D01b | vocabulary test |
| R11 | Capture acceptance ≠ treatment acceptance (5, T06) | Separate table `capture_acceptances` | implemented | Test that a capture acceptance creates no clinician decision | E | D01b | T06 |
| R12 | Engine `shown` ≠ presentation (6.6, T07) | No presentation table: `rg -il "presentation\|render_event\|viewed_at" apps/backend/migrations` → none | absent-after-search | D02 | F | D02 | T07 |
| R13 | Medication events, treatment episodes (6.5) | `rg -il "episode\|medication_event\|dispens" apps/backend apps/worker packages/shared-types` → none (smart-pilot FHIR only) | absent-after-search | D03 | F | D03 | T08, T10, T14 |
| R14 | Endpoint definitions and observations (6.7) | none | absent-after-search | D04, clinical endpoint owner | F | D04 | T15, T16 |
| R15 | Consent / contract / purpose eligibility (9) | `consent_record`, `tenant_data_terms` sketched only (`docs/design/plans/pgx-data-model-and-data-products.md`, App. B); no table | planned-only | Replace "latest row" with grant/purpose/interval rules | F, C | D05 | T18, T19 |
| R16 | Assay coverage, callable denominators (6.3) | `evaluation_gene_states` stores gene state per evaluation (`0008`); no assay/target coverage | partial | D06 | F | D06 | T11, T12 |
| R17 | Context-adjusted phenotype assertions (6.4) | none; schema gap recorded (`docs/status/2026-10-24-schema-context-and-allele-status-gap.md`) | absent-after-search | D08, clinical review | F | D08 | T13 |
| R18 | Population descriptors (6.8) | none in backend | absent-after-search | Later | F | later | n/a |
| R19 | Aggregate release, disclosure controls (9.3) | none; Tableau note in STATUS ("not planned in detail") | planned-only | D05 + D07; counsel | F, C | D07 | T20, T21, T27 |
| R20 | Analysis-run state machine on existing jobs (10) | Job queue + fenced worker (`0023`, `0050`, `0051`) | partial (infrastructure only) | D07 | E | D07 | T22 |
| R21 | Synthetic vs empirical classification (5.12, T28) | Pipeline switch refuses production (`apps/backend/src/lab-reports/pipeline-switch.ts`); every row is synthetic by construction | partial | Explicit data-origin field when real data is possible | F | D05 | T28 |
| R22 | Old payloads and ledger verify after change (12, T24) | Verifier re-derives from rows (`apps/backend/src/ledger/verifier.ts:344`); projection lists columns (`projections.ts:165`) | implemented | Prove unchanged | E | D01a/b | T24 |
| R23 | Backup/restore with new tables and roles (T25) | Restore suites (`apps/backend/test/helpers/database.ts:191`), ledger chain check on restore | implemented (reuse) | New table must survive restore | E | D01b | T25 |

## 3. Terminology crosswalk

| Report concept | This repository | Note |
| --- | --- | --- |
| Clinician disposition | **clinician result decision** (`response`) | `disposition` is the engine's held/evaluated |
| Recommendation | `evaluation_results` row with `outcome = 'shown'` | Never the retired `recommendations` table |
| Capture review | capture decision (`capture_acceptances`) | Text acceptance only |
| Engine evaluation | `evaluations` + children | Immutable, ledgered |
| Explanation run outcome | `agentic.explain-outcome.v2` (`apps/ai-service/src/outcome-v2.ts`) | Harness evidence, never a patient outcome |
| Idempotency key | body `requestId` | No header |
| Source retraction / supersession | `corrections` | Distinct from a clinician `rejected` |

## 4. Historical plans: what is superseded

`docs/design/plans/pgx-data-model-and-data-products.md` (2026-10-19, `ccd4499`, draft) and `pgx-build-prompt-gap-analysis.md` (same snapshot) are kept unchanged. Spec 005 supersedes these assumptions, and only these:

| Historical statement | Current reading |
| --- | --- |
| AI service is an empty scaffold | Superseded: synthetic explanation contracts, receipts (0048) and runs (0049) exist |
| `callSource` absent; licence fields proposed | Superseded: both present; enforcement is the open item |
| Zone D holds no source references | Refined: internal analytic preparation keeps governed lineage; only external aggregates drop it |
| Minimum cell ≥ 11 | Historical proposal, not a standard; disclosure policy is context-specific (D05/D07) |
| Fixed snapshots prevent differencing | Insufficient alone; releases are assessed cumulatively |
| FDA guidance does not discuss genomic data | Corrected: the 2026-01-29 guidance discusses NGS/VCF patterns (report S5; not re-read in this session) |
| Consent = latest row | Replaced by grant/purpose/scope/interval rules (D05) |
| Data products deferred | The founder's 2026-10-27 report sets a direction; each slice still needs its own approved plan |

Retained: zone separation and one-way flow, clinical independence from sponsors and buyers (historical invariant 9), random (not derived) pseudonyms (R5 there), licence settlement before any knowledge feed.
