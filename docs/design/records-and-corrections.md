# Records, corrections and the audit chain (slice 5B-3 specification)

> **Specification only. No migration, table, endpoint or code exists for anything in this document.** It is written and
> approved before any of that, as `docs/design/outcomes-and-reason-codes.md` requires ("the correction and supersession
> model for stored results ... written and approved before their code"). The code follows in three later pull requests
> (5B-3.1, 5B-3.2, 5B-3.3), each of which stops for review. Synthetic data only. `clinical_approval` and
> `training_eligible` stay `false` on everything in this slice.

## 0. What this slice connects

Built and merged, but connected to nothing: the lab-report reader (`SubprocessReportReader`), the adapter (`adaptReport`),
the engine (`evaluate`) and the knowledge loader. Stored today: `patients`, `reports` (bytes in object storage) and the flat
`recommendations` table, which nothing writes and which cannot hold what the engine returns (a hold, a reason code, a
citation, an abstention). This slice adds the records that make an evaluation durable, correctable and tamper-evident, and
the endpoints that run the pipeline. Everything is tenant-scoped exactly like the existing tables.

## 1. Decisions recorded

Approved by the founder on 2026-10-08, with four additions (marked **+**), all written into this specification.

| # | Decision |
| --- | --- |
| 1 | `recommendations` is left exactly as it is (not written, not dropped). Full results go to new evaluation tables. The UI moves in slice 5D. |
| 2 | One tenant-scoped, hash-chained ledger beside the data tables. |
| 3 | Only the `reviewer` role is added. `operator`, `governance`, `compliance` have no first consumer and are not added. |
| 4 | Separation of duties: the reviewer who accepts a capture is not the user who uploaded the report. |
| 5 | Disputes apply within the tenant that raised them. Cross-tenant propagation needs a governance role and is not built. |
| 6 | The pipeline is off in production by default; a fake text-capture runner serves development and tests. |
| 7 | The labeled-data table is deferred until it has a consumer. |
| 8 | The correction kinds and reason codes of section 4 are the frozen vocabulary. |
| 9 | Production refuses to start when the ledger check fails. **+** Verification is checkpointed and bounded so a cold start cannot time out (section 6.6). |
| 10 | A new evaluation with newer knowledge is a new row, not a correction. "Current" is defined in section 4.5. |
| + A | The ledger lock is held as briefly as possible: one lightweight head row per tenant, locked by the last statement of the transaction (section 6.4). |
| + B | Startup verification is bounded (checkpoint plus tail), with full verification continuing in the background and a latched fail-closed state if it fails (section 6.6). |
| + C | A correction can have at most one child, enforced by unique constraints in the database (section 4.3). |
| + D | The ledger carries no free text and no report values. Free-text notes live in a separate table that can be redacted without breaking the chain (sections 3.7 and 6.8). |

## 2. Invariants (what must always be true)

1. **Nothing is edited or deleted.** No table in this document grants `UPDATE`, `DELETE` or `TRUNCATE` to the application role, and a
   trigger on each refuses them for every role including the table owner. (Backup and restore are not affected; a future retention
   job is a separate, reviewed change.)
2. **Nothing is stored without its ledger event.** A data row and its ledger event commit together or not at all (section 6.3).
3. **Every row is tenant-scoped.** `tenant_id` on every row, row-level security bound to `app.current_tenant_id`, composite foreign
   keys `(id, tenant_id)` so a row can never point at another tenant's row even if a policy were bypassed. Another tenant's record
   reads as not found.
4. **Every row names its author.** `created_by` comes from the token's `sub`, never from the request, and never changes.
5. **The database holds no report bytes and no report text.** The PDF and the captured text live in object storage (the text under
   its own key, with its SHA-256 recorded). Gene values and results appear only in the evaluation rows, under row-level security.
6. **No free text, report value, or span text in the ledger or in any log.** Logs and the ledger carry ids, codes, hashes, offsets.
7. **A result is stored as it was shown.** The wording and strength of a shown result are copied into the evaluation, because the
   knowledge set may change later; the knowledge set id (including any dispute overlay) says exactly what produced it.
8. **Held means no drug results.** A held report stores a held evaluation with its code and no result rows, exactly as the adapter
   returns it. Nothing downstream turns a hold into an empty success.

## 3. Data model

### 3.1 Conventions for every new table

- Columns: `seq bigint GENERATED ALWAYS AS IDENTITY`, `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `tenant_id text NOT NULL`
  (1 to 128 characters, as today), `created_by text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, and (data tables
  only) `ledger_event_id uuid NOT NULL`.
- `UNIQUE (id, tenant_id)` on every table that is referenced, and composite foreign keys `(x_id, tenant_id)`.
- `ENABLE` and `FORCE ROW LEVEL SECURITY`, one policy `<table>_tenant ... TO telesphoros_app` on `app.current_tenant_id`.
- Grants: `SELECT, INSERT` only. Triggers `<table>_append_only` (`BEFORE UPDATE OR DELETE OR TRUNCATE`) raise
  `integrity_constraint_violation` for everyone.
- Each migration has a `down` file. Tables are listed with their columns below; types follow the existing migrations.
- A catalog guard test (section 11) lists every append-only table and checks the above, so the next table someone adds is checked.

### 3.2 `report_captures`: one text read from one stored PDF

| Column | Notes |
| --- | --- |
| `report_id` | FK `(report_id, tenant_id)` to `reports`; the report's `type` must be `lab-pdf` (section 3.9) |
| `pdf_sha256` | must equal the report's recorded `sha256` |
| `text_storage_key` | object-storage key of the captured text (generated by the server) |
| `text_sha256`, `text_scalars` | hash and length in Unicode scalars of the stored text, byte-exact, BOM kept, no normalization |
| `poppler_version` | e.g. `26.03.0`; recorded, compared by the adapter with the pinned version |
| `runner` | `fake` or `poppler` (so a fake capture can never be mistaken for a real one) |

`UNIQUE (tenant_id, report_id, text_sha256, poppler_version)`: capturing the same text again returns the existing row.

### 3.3 `capture_acceptances`: a person's decision about one capture

The shape already defined in `capture-acceptance.ts` (`decision` `accepted|rejected`, reviewer, `decided_at`, note), pointing at a
capture: `capture_id` FK `(capture_id, tenant_id)`, `textSha256` and `popplerVersion` copied from the capture and checked equal by a
trigger, `reviewer_sub` (= `created_by`), `note_id` (nullable, section 3.7). Append-only; a later decision is a new row, and the
adapter relies on the **latest** acceptance of the capture. **Separation of duties:** a trigger refuses an `accepted` row whose
`created_by` equals the `created_by` of the report (the uploader). The service checks the same first, to give a clear error.

### 3.4 `evaluations` and what they hold

`evaluations` (immutable header):

| Column | Notes |
| --- | --- |
| `patient_id`, `report_id` | composite FKs; the report belongs to the patient |
| `capture_acceptance_id` | FK; the acceptance that was relied on |
| `disposition` | `held` or `evaluated` |
| `hold_code`, `hold_message_id` | for `held`: the adapter's report-level hold code (the frozen list in `hold-codes.ts`); null otherwise |
| `binding` | jsonb: `textSha256`, `popplerVersion`, `packetHash`, `generatorCodeHash`, `captureAcceptanceId` (the adapter's `SourceBinding`) |
| `knowledge_set_id` | 64 hex: the loaded set **including the dispute overlay** (section 5.3) |
| `engine_version` | the git commit of the build (injected at build time); a result is attributable to the code that made it |
| `gene_inputs` | jsonb: exactly what was passed to `evaluate()` (the only place values from the report appear) |
| `occurrences` | jsonb: the adapter's audit trail (offsets, hashes, states, codes; no text) |
| `identity_key` | `sha256(capture_acceptance_id, knowledge_set_id, engine_version, binding.generatorCodeHash)` |

`UNIQUE (tenant_id, identity_key)`: the same inputs, knowledge and code give the existing evaluation instead of a duplicate. A check
constraint makes `disposition = 'held'` imply a hold code and no children, and `'evaluated'` imply no hold code.

`evaluation_results` (one row per drug and guideline, copying the engine's `DrugResult`): `evaluation_id`, `ordinal`, `drug`,
`guideline_id`, `guideline_version`, `outcome` (the five), `reason_code` (the 14, nullable only for `shown`), `genes text[]`,
`strength`, `citation jsonb`, `recommendation_text`, `implication`. Check constraints mirror the engine's result schema: wording and
strength are present **only** for `shown` and for a verified "No recommendation"; they are null for `held`, `abstained` and
`no-guideline` (an unverified or disputed cell never has its wording stored).

`evaluation_gene_states` (one per gene, copying `GeneStateResult`): `evaluation_id`, `gene`, `state`, `phenotype`, `diplotype`,
`activity_score numeric(6,2)`, `reason_code`.

**Children and the ledger.** The header, its results and its gene states are inserted in one transaction **before** the ledger event.
A trigger on each child table refuses an insert once the parent's ledger event is visible, so a child cannot be added later; the
event's `payload_sha256` covers the whole aggregate (header, all results in `ordinal` order, all gene states in gene order), so
verification also detects a child that was somehow added.

### 3.5 `corrections`

See section 4 for the model. Columns: `evaluation_id`, `report_id` (copied from the evaluation, for the supersession constraint),
`kind`, `reason_code`, `previous_correction_id` (nullable), `replacement_evaluation_id` (nullable), `note_id` (nullable),
`created_by`. Constraints in section 4.3.

### 3.6 `cell_disputes` and `cell_dispute_decisions`

See section 5. `cell_disputes`: `guideline_id`, `guideline_version`, `guideline_content_sha256`, `locator_table`, `locator_row`,
`locator_column` (nullable), `note_id` (required). `cell_dispute_decisions`: `dispute_id` (unique: one final decision per dispute),
`decision` (`upheld|dismissed`), `evidence_note_id` (required), `created_by`.

### 3.7 `event_notes`: free text, kept out of the ledger

Every free-text field in this slice (a capture decision note, a correction note, a dispute note, a dispute decision's evidence) is a
row here and is referenced by id. Columns: `body text` (1 to 1000 characters), `body_sha256`, `redacted_at` (null), and the
reference from the row that uses it. The **ledger and the data rows carry only `body_sha256`**, never the text. The interface
tells the user not to enter patient identifiers; the text is stored under row-level security and is never logged. Redaction is a
privileged procedure, section 6.8.

### 3.8 The ledger tables

`ledger_events`, `ledger_heads`, `ledger_checkpoints` and the function `ledger_append` are specified in section 6.

### 3.9 Changes to existing tables

- `reports.type` gains `lab-pdf`: the shared-types enum, the database check `reports_type_valid`, the filename schema (`.pdf`) and
  `REPORT_CONTENT_TYPES` (`application/pdf` only). The existing `vcf` and `structured` behavior is unchanged.
- The report soft-delete guard is extended: a report with any evaluation can never be soft-deleted (evaluations are never deleted).
- `recommendations` is untouched.

## 4. The correction model

A stored evaluation is never edited. A correction is a new row about it.

### 4.1 Kinds

| Kind | Meaning |
| --- | --- |
| `retraction` | The evaluation must no longer be relied on. No replacement. |
| `supersession` | Replaced by a newer evaluation of the **same report** (a new evaluation row, itself in the ledger). |
| `reinstatement` | An earlier retraction was mistaken; the evaluation is active again. |

### 4.2 Reason codes (frozen, like the engine's)

| Code | Meaning | Allowed kinds |
| --- | --- | --- |
| `capture-wrong` | The captured text differs from the PDF | retraction, supersession |
| `wrong-patient` | The report was attached to the wrong patient | retraction |
| `input-misread` | The reader or adapter misread a value the capture had right | retraction, supersession |
| `knowledge-error-found` | A guideline cell or mapping the result used is wrong or disputed | retraction, supersession |
| `software-defect` | The software produced a wrong result | retraction, supersession |
| `clinical-review-disagrees` | A qualified reviewer judged the result inappropriate (note required) | retraction |
| `retraction-mistaken` | The retraction was a mistake | reinstatement only |

A new code is a new reviewed change, as with the engine's vocabulary. Messages are fixed text; a note is optional except where marked.

### 4.3 Chain and constraints

- `previous_correction_id` names the previous correction **on the same evaluation**, or is null for the first. Composite foreign
  key `(previous_correction_id, evaluation_id, tenant_id)` to `corrections (id, evaluation_id, tenant_id)` makes a link to another
  evaluation's correction impossible.
- **At most one child, enforced in the database:** `UNIQUE (previous_correction_id) WHERE previous_correction_id IS NOT NULL`, and
  `UNIQUE (evaluation_id) WHERE previous_correction_id IS NULL` (an evaluation has at most one first correction). Two reviewers acting
  at once cannot both succeed: the second insert violates a unique constraint and the service returns a conflict asking to reload.
- `kind = 'supersession'` requires `replacement_evaluation_id`, with composite FK `(replacement_evaluation_id, tenant_id, report_id)`
  to `evaluations (id, tenant_id, report_id)` (the same report), and `replacement_evaluation_id <> evaluation_id`; other kinds require it null.
- `reason_code` must be allowed for the `kind` (a check constraint over the table above); `clinical-review-disagrees` requires a note.
- `reinstatement` requires that the previous correction is a `retraction` and that its author differs from this one (trigger).

### 4.4 State of an evaluation (derived, never stored)

| State | Reached by |
| --- | --- |
| `active` | no corrections, or the last correction is a `reinstatement` |
| `retracted` | the last correction is a `retraction` |
| `superseded by X` | the last correction is a `supersession` (terminal; further corrections are refused) |

A trigger enforces the state machine: a `retraction` or `supersession` needs an `active` evaluation; a `reinstatement` needs a
`retracted` one. Reading an evaluation always returns its correction history; a retracted or superseded evaluation is still
returned by id, clearly marked, and its original content is unchanged.

### 4.5 "Current"

The current evaluation of a report is the latest (`seq`) evaluation of that report that is `active`. Older evaluations, and
retracted or superseded ones, are history. A newer evaluation of the same report made with newer knowledge is **not** a
correction: it is a new row, and the older one stays `active` (decision 10).

## 5. Disputed cells

Guideline cells live in signed knowledge files; a cell becomes `verified` only through a file change and a re-sign. Database
records can only **tighten** at run time, never loosen.

### 5.1 Raising and deciding

- A reviewer **raises** a dispute against a cell identified by `(guideline_id, guideline_version, guideline_content_sha256, locator)`
  with a required note. While open, the cell is treated as `disputed` for this tenant.
- A dispute leaves open only through one **decision** with required evidence by a reviewer **other than the one who raised it**
  (trigger plus service check): `upheld` or `dismissed`.
  - `upheld`: the cell stays held (`cell-disputed`) for as long as the knowledge file's content hash is the one that was disputed.
    A corrected, re-signed file has a different hash, which lifts the hold automatically, but that file passed the normal
    file sign-off and cell verification, so a cell is shown only if the new file says `verified`.
  - `dismissed`: the file's own verification state applies again. A dismissal can **never** make an `unverified` cell shown.
- A decision is final for its dispute. A fresh concern is a new dispute (it may name the earlier one in its note).
- Rules from `outcomes-and-reason-codes.md` carried forward: nothing downstream can override a held cell; every state change is a
  new row that points at the previous one.

### 5.2 Scope

Disputes apply **within the tenant that raised them** (decision 5). With one pilot tenant this is complete; protecting every
tenant from a dispute raised by one needs a platform role and is a separate, later decision.

### 5.3 The overlay

A pure function `applyDisputeOverlay(knowledge, openOrUpheldDisputes)` returns a knowledge set in which each disputed cell has
`verification: { state: 'disputed', note: <fixed text> }`. The engine is unchanged: it already holds a disputed cell with no
wording. The effective knowledge set id is `sha256("overlay/1\n" + baseId + "\n" + canonicalJson(sorted disputed-cell keys))`, and
equals `baseId` when there is no overlay, so results made without disputes keep their ids. The id is stored on every evaluation.

## 6. The ledger

### 6.1 `ledger_events`

| Column | Notes |
| --- | --- |
| `id` | uuid, generated by the caller so the data row can reference it in the same transaction |
| `tenant_id`, `seq` | `seq` starts at 1 per tenant; `UNIQUE (tenant_id, seq)` |
| `event_type` | `capture`, `capture-decision`, `evaluation`, `correction`, `dispute`, `dispute-decision`, `redaction`, `checkpoint` |
| `subject_table`, `subject_id` | what the event is about; `UNIQUE (subject_table, subject_id)` (one event per row) |
| `actor_sub` | the author; no control characters (check) |
| `payload_sha256` | hash of the subject (section 6.2) |
| `prev_hash`, `record_hash` | 64 hex; `UNIQUE (tenant_id, prev_hash)` makes a fork impossible |
| `created_at` | database `now()` at append |

The ledger has **no free-text column**: only ids, codes, a hash and the actor's `sub`.

### 6.2 Hashes (exact)

- **`record_hash`** is computed **by the database**, not by the application:
  `encode(sha256(convert_to(concat_ws(chr(31), tenant_id, seq, event_type, subject_table, subject_id, actor_sub, payload_sha256, prev_hash, created_at_utc), 'UTF8')), 'hex')`,
  where `created_at_utc` is `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and the first event of a tenant has
  `prev_hash = 64 zeros`. Every joined value is constrained not to contain `chr(31)`.
- **`payload_sha256`** is `sha256` of the **canonical JSON** (sorted keys at every level, no whitespace; the same routine as the
  reader's `canonical-json.ts`) of the subject's projection: every column of the row as stored, timestamps as ISO-8601 UTC strings,
  uuids lower-case, jsonb canonicalized, with `ledger_event_id` included and **free text replaced by its `body_sha256`**. For an
  evaluation the projection is the whole aggregate (section 3.4). The verifier recomputes it from the stored rows.

### 6.3 Completeness: no data row without its event, no event without its row

- The application role has **no `INSERT` on `ledger_events`**. It calls `ledger_append(event_id, event_type, subject_table, subject_id,
  payload_sha256)`, a `SECURITY DEFINER` function owned by the table owner. The function takes `tenant_id` from
  `current_setting('app.current_tenant_id')` itself (never from a parameter), takes the actor from `app.current_actor` set by the
  request transaction (and fails if either setting is missing, so it fails closed), locks the tenant's head, and writes the event with the DB-computed hashes.
- Each data table's `ledger_event_id` has a **deferrable, initially deferred** composite foreign key to `ledger_events (id, tenant_id)`.
  The data row is inserted first and `ledger_append` is the **last statement** of the transaction; at `COMMIT`, a row without its event
  (or an event for a row that is not there, checked by a deferred constraint trigger on `ledger_events`) fails the transaction.

### 6.4 Lock contention (addition A)

Appends are serialized **per tenant only**, through one lightweight row in `ledger_heads (tenant_id, seq, record_hash)`:

1. `ledger_append` runs `INSERT ... ON CONFLICT DO NOTHING` for a new tenant's head, then `SELECT ... FOR UPDATE` on that one row.
2. It is the **last statement** before `COMMIT`, so the lock is held for one insert, not for the work of building the record.
   Domain-row inserts, hashing and validation happen before it, without the lock.
3. There is exactly one lock (the head row), so lock-order deadlocks cannot happen; an exclusive row lock on a different tenant's
   head never blocks this tenant.
4. 5B-3.1 includes a **contention test and measurement**: N concurrent writers in one tenant produce one linear chain, no deadlock,
   and the throughput and p99 wait are recorded in the pull request. If a tenant ever needs more, the next step is batching, not a design change.

### 6.5 Corrections cannot fork (addition C)

The unique constraints of section 4.3 plus `UNIQUE (tenant_id, prev_hash)` here mean that at the data level and the ledger level a
node has at most one child. A conflict is an expected, clean error ("reload and retry"), not data damage.

### 6.6 Verification, startup and scale (addition B)

Verification of a tenant walks `ledger_events` in `seq` order and checks, for each event: `seq` continuity, `prev_hash` equals the
previous `record_hash`, `record_hash` recomputes, and `payload_sha256` recomputes from the subject's stored rows (this also catches a
silent edit of data, not only of the ledger). Both directions are checked: every subject row has exactly one event, every event has its row.

- **`ledger_checkpoints` (append-only):** `tenant_id`, `up_to_seq`, `head_hash`, `verified_at`, `verification` (`full` or `tail`).
  A checkpoint is written, as a `checkpoint` ledger event, only after a successful verification.
- **At startup** (production and development):
  1. **Tail verification, synchronous, with a time budget** (default 20 seconds, configurable): for each tenant, confirm that the
     last checkpoint's `head_hash` still equals the `record_hash` at its `up_to_seq`, then verify every event after it. For a ledger
     with no checkpoint, or below a size threshold (set from the 5B-3.1 measurements; provisionally 50 000 events), this is the full
     chain.
  2. **Production refuses to start** if tail verification fails **or exceeds its budget** (decision 9). Development logs a warning.
  3. **Full verification, asynchronous**, begins immediately after start and records a `full` checkpoint on success. If it **fails**,
     the instance latches `ledger-compromised`: readiness fails, every endpoint that appends to the ledger returns 503, and an
     alarm is raised. The latch clears only by restart after investigation.
- A scheduled full verification (daily; also `GET /ledger/verify?full=true` for an admin) keeps the guarantee fresh independently of restarts.
- **What a checkpoint is and is not:** it makes a cold start fast. It is **not** an independent security control, because someone
  who can rewrite the chain can rewrite a checkpoint stored beside it. The security property comes from full verification and from
  anchoring the head outside the database (6.9).

**Tenant enumeration and row-level security.** The application role sees one tenant at a time, so the startup and scheduled checks
cannot list tenants through it. They use a second `SECURITY DEFINER` function, `ledger_tenants()`, executable only by a dedicated
`ledger_verifier` login role, which returns tenant ids and head sequence numbers and nothing else; each tenant is then verified with
that tenant's setting applied, through the same policies as any request. The ledger tables are `ENABLE ROW LEVEL SECURITY` without
`FORCE`, so that the functions owned by the table owner can maintain them; the application role stays fully bound by the policies
and holds no write grant on them. The 5B-3.1 catalog guard asserts exactly this arrangement (and that no other role gained access).

### 6.7 Readiness

The existing readiness probe gains a `ledger` check: `ok` (tail verified, no latch), `verifying` (tail verified, full running; the
instance is ready), or `failed` (not ready). Details never include row content.

### 6.8 No PHI in the ledger; redaction (addition D)

- The event builder takes an **allow-list** of fields per event type (ids, codes, hashes, the actor). A field not on the list is a
  programming error that throws. A test asserts that no `ledger_events` column is free text and that no event payload contains a
  gene value, phenotype, diplotype, span text or note text.
- A free-text note can contain patient identifiers by accident. Because the note is in `event_notes` and only its hash is in the
  ledger, it can be **redacted without breaking the chain**: a privileged runbook procedure (run by the table owner, not exposed as an
  API, not a role of this slice) replaces `body` with a fixed tombstone, sets `redacted_at`, and appends a `redaction` ledger event
  (who, when, the legal or policy basis in the runbook record). The verifier skips the hash check for a note that has a `redaction`
  event and still checks everything else.
- **Scope of redaction:** free-text notes only. Structured evaluation data (gene inputs, results) is part of the clinical record and
  follows the retention policy (HIPAA six-year minimum and legal hold), not erasure.

### 6.9 Stated limits

- The chain makes tampering **evident**, not impossible. Someone with full database-owner access could rewrite a whole chain
  consistently, and removing the **newest** events cannot be detected from inside the database.
- **Follow-up (not in this slice):** anchor each tenant's head hash outside the database (for example in the signed backup manifest,
  or an Object Lock object), which closes both. The checkpoint events already provide the values to anchor.
- Live-database tampering by the application role is prevented by grants and triggers; tampering by the owner is made evident.

## 7. Roles and independence

`reviewer` is added (shared-types `ROLES`, a Cognito group `reviewer` in Terraform and its infra test, `docs/auth.md`, the frontend role
handling). Roles that do not gain a first consumer here are not added.

| Action | reader | clinician | reviewer | admin |
| --- | --- | --- | --- | --- |
| Read evaluations, captures, corrections, disputes | yes | yes | yes | yes |
| Capture text from a report, request the PDF link, run an evaluation | no | yes | yes | yes |
| Accept or reject a capture | no | no | yes | no |
| Correct an evaluation; raise or decide a dispute | no | no | yes | no |
| Verify the ledger on demand | no | no | no | yes |

Independence rules, each enforced in the service **and** in the database, each tested:

1. The reviewer who **accepts** a capture is not the user who uploaded the report (decision 4).
2. The person who **decides** a dispute is not the one who raised it.
3. The person who **reinstates** is not the one who retracted.

## 8. API (all under `/api/v1`; tenant-scoped; another tenant's record is 404)

| Endpoint | Roles | Notes |
| --- | --- | --- |
| `POST /reports/:id/capture` | clinician, reviewer, admin | runs the text-capture runner on the stored PDF; stores the text in object storage; returns the capture. Idempotent per section 3.2. |
| `GET /reports/:id/download-url` | all | a short-lived link to the original PDF, so a reviewer can compare it with the text |
| `GET /captures/:id` | all | capture metadata and, for a reviewer, a short-lived link to the text |
| `POST /captures/:id/decision` `{ decision, note? }` | reviewer | `accepted` or `rejected`; separation of duties |
| `POST /reports/:id/evaluations` `{ captureId }` | clinician, reviewer, admin | needs an accepted latest acceptance; reader, adapter, overlay, engine; stores the aggregate and the event; returns the evaluation. Idempotent per `identity_key`. |
| `GET /evaluations`, `GET /evaluations/:id` | all | filters `patientId`, `reportId`, `current=true`; the detail includes derived state and correction history |
| `POST /evaluations/:id/corrections` `{ kind, reasonCode, previousCorrectionId?, replacementEvaluationId?, note? }` | reviewer | state machine and chain rules of section 4 |
| `POST /cell-disputes` `{ guidelineId, locator, note }` | reviewer | the content hash and version are read from the loaded knowledge, not supplied |
| `POST /cell-disputes/:id/decision` `{ decision, evidenceNote }` | reviewer | independence rule |
| `GET /cell-disputes` | all | |
| `GET /ledger/verify?full=` | admin | |

Errors use the existing envelope: validation 400, unknown or other-tenant 404, role 403, state or chain conflicts 409, pipeline
disabled or ledger latched 503. Responses never contain note text in a list view, report text, or span text.

## 9. The pipeline switch and production guards

- `LAB_REPORT_PIPELINE` is `disabled` (default) or `enabled`. When disabled, the capture, evaluation, correction and dispute
  endpoints answer as unavailable and the reader is not started. **Production refuses to start with `enabled`** until a later
  reviewed change removes that guard (the same stance as `SubprocessReportReader`, which refuses `production` mode today).
- The text-capture runner is an interface. The **fake runner** (development and tests) returns stored synthetic text and records
  `runner = 'fake'`. The real Poppler 26.03.0 runner belongs with the production image in the hosting phase.
- The clinical-hold flag `PGX_CLINICAL_HOLD_LIFTED` is untouched here (it gates the AI layer, 5C). Production knowledge loading
  still refuses synthetic or unreviewed files.

## 10. Retention, backup and restore

- Records are retained indefinitely by the application (no delete path). HIPAA's six-year minimum and legal hold are handled by a
  future reviewed retention job, which this design does not block (the triggers are the one place it would need an explicit, audited exception).
- The new tables are included automatically in backup and restore (facts are read for every public table). **Restore gains a check:
  the ledger verifies in the restored copy**, so a restored database is proven intact, not only complete.
- Patient and report soft-delete guards (section 3.9) keep evaluated history from being hidden.

## 11. How it will be verified (summarised; each PR lists its own)

- **Database tier is mandatory** from 5B-3.1: a mocked `pool.query` proves nothing about a table.
- **Catalog guard:** a registry lists every append-only table; the guard asserts row-level security enabled and forced, a tenant policy,
  a `tenant_id`, `SELECT, INSERT` only, and the refuse-mutation trigger. Adding a table without registering it fails the build.
- Tenant isolation per table with negative controls (read, insert, reference across tenants).
- Append-only: `UPDATE`, `DELETE`, `TRUNCATE` refused for the application role **and** the owner.
- Ledger: parallel appends give one linear chain and measured throughput; forged `prev_hash` and direct `INSERT` refused; tamper, delete,
  reorder, a late child row, an edited note, and a missing event for a row are each detected; redaction keeps verification passing.
- Verification: tail + background full; fails closed in production on a damaged chain and on exceeding the budget, with harmless controls.
- Corrections: chain, one-child, state machine, cross-report supersession refused, reinstatement by the same person refused.
- Disputes: independence, `dismissed` never loosens an `unverified` cell, overlay changes the knowledge set id, engine holds with no wording.
- End to end over HTTP on D01 to D12: the stored result equals the hand-written golden **and** a fresh re-run of the engine; role matrix; pipeline off.
- Restore: backup, restore, and the ledger verifies in the copy.
- **Defect injection** on every new rule with a harmless control, as in earlier slices; clean-state run of all three tiers.

## 12. What this changes and what it does not

| Changes (in later PRs) | Does not change |
| --- | --- |
| New tables and one function in the database; `reports.type` gains `lab-pdf`; the soft-delete guard; a `reviewer` role; new endpoints behind a switch that is off in production; readiness gains a ledger check; restore gains a ledger check | The engine, the adapter's logic, the reader, the knowledge schema, the five outcomes, the 14 reason codes, `recommendations`, the existing patient/report/recommendation endpoints (apart from the new report type), the frontend, anything applied in AWS |

## 13. Left for the build PRs to settle by measurement or detail, within these rules

- The event-count threshold for synchronous full verification, and the default time budget (5B-3.1, from the contention and verification measurements).
- Exact column types and index names, following the existing migrations.
- How the verifier login role is provisioned outside the repository, as `telesphoros_app`'s login role is today.
- The fixed message text for each correction reason and hold.
- Whether `GET /captures/:id` text links use the same presigned mechanism as the report download (expected: yes).

## 14. Explicitly deferred

Labeled-data records for the future model (decision 7; the rule stays: training eligibility false until lawful basis, independent
review and sealed splits); the `operator`, `governance` and `compliance` roles; cross-tenant dispute propagation; anchoring the
ledger head outside the database; the real Poppler runner; the frontend (5D); the AI layer (5C).
