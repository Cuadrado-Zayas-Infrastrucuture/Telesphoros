# Records, corrections and the audit chain (slice 5B-3 specification)

> **Status.** Written and approved before any code, as `docs/design/outcomes-and-reason-codes.md` requires. The database layer
> (migrations 0004 to 0009, the ledger library, the verifier and the PostgreSQL repository) is built in **5B-3.1**; the endpoints,
> the `reviewer` role and the pipeline switch follow in 5B-3.2 and 5B-3.3, each of which stops for review. Where building taught
> something that changes the text below, **section 15 (Amendments) governs**, and the affected passage carries a pointer.
> Synthetic data only. `clinical_approval` and `training_eligible` stay `false` on everything in this slice.

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

### 3.6a `report_patient_decisions` (M2.1b)

A person's decision that a report's exact file version belongs to a patient, a record like the others: append-only, tenant-scoped, one ledger event
(`patient-link-decision`). Columns: `report_id`, `patient_id`, `report_sha256` and `object_version` (the file the decision is about), `decision`
(`verified|rejected`), `method` (`identifier-match|person-confirmed`), `basis_code` (a frozen list: verifying `no-identifier-on-report`,
`identifier-not-registered`, `documented-clinic-procedure`; rejecting `different-person`, `identifier-conflict`, `cannot-establish`; never present with a
match), `identifier_id` (present only with a match: the registered identifier that matched, never its value), `created_by`. The database refuses a
decision about a file or patient the report does not have now, and by the report's creator, upload requester or uploader. The *current* link is
derived: the newest decision, if it names the report's current file and patient. An evaluation is refused (409 `patient-link-unverified`) unless the
current link is `verified`; see [the M2.1b design note](plans/m2-1b-identifiers-and-patient-link.md). Free text has no place here: the reason is a code.

### 3.6b `patient_merge_proposals` and `patient_merge_decisions` (M2.1c-2)

Two ledger records (event types `patient-merge-proposal` and `patient-merge-decision`) and one plain append-only table, `patient_duplicate_flags`
(not a ledger record: one row per unordered pair of patients whose identifiers collided, a system code and who hit it, never a number or digest).
A proposal has `kind` (`merge|unmerge`), `source_patient_id`, `target_patient_id` and a coded `reason_code` that goes with the kind; a decision has
`proposal_id` and `decision` (`approved|declined`). A trigger refuses a decider who proposed it and a second decision. An approved merge makes the source an
**alias** of the target; an approved unmerge of that pair ends it. Nothing else is written: the effective group of a patient (the root and its direct
aliases, one level deep) is derived by SQL functions, and a deferred constraint trigger refuses, at commit and under the ledger's head lock, a decision
the graph cannot take (`same-patient`, `patient-gone`, `source-merged`, `target-merged`, `source-has-aliases`, `not-merged`). A declined merge dismisses
the pair from the review list. See [the M2.1c-2 note](plans/m2-1c-2-duplicates-and-merge.md).

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

The current evaluation of a report is its latest (`seq`) evaluation, **if that one is `active`; otherwise the report has none**
(amended in section 22: an older active evaluation is never promoted). Older evaluations, and retracted or superseded ones, are history. A newer evaluation of the same report made with newer knowledge is **not** a
correction: it is a new row, and the older one stays `active` (decision 10).

**Quarantine (M2.1c-1).** A report is *quarantined* when the newest patient-link decision about it ([3.6a](#36a-report_patient_decisions-m21b)) names the file (hash and storage version) and the patient it holds now and says `rejected`. It is derived, never stored, and changes nothing about any stored row. A quarantined report has **no current evaluation** (the rule above gains this second way to be "none"); its evaluations stay `active` in the correction model until a reviewer retracts each with `wrong-patient`, which the system never does by itself. Every evaluation read shows `advisory.patientLink` (`verified`, `unverified` or `rejected`). The quarantine lifts when a later decision for the same file says `verified`; a rejection about an earlier file leaves the report merely unverified. A reviewer's work list (`GET /patient-link/quarantine`) shows quarantined reports that still have an active evaluation. See [the M2.1c plan](plans/m2-1c-wrong-chart-and-duplicates.md).

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
| `event_type` | `capture`, `capture-decision`, `evaluation`, `correction`, `dispute`, `dispute-decision`, `patient-link-decision`, `patient-merge-proposal`, `patient-merge-decision`, `redaction`, `checkpoint` |
| `subject_table`, `subject_id` | what the event is about; `UNIQUE (subject_table, subject_id)` (one event per row) |
| `actor_sub` | the author; no control characters (check) |
| `payload_sha256` | hash of the subject (section 6.2) |
| `prev_hash`, `record_hash` | 64 hex; `UNIQUE (tenant_id, prev_hash)` makes a fork impossible |
| `created_at` | database `now()` at append |

The ledger has **no free-text column**: only ids, codes, a hash and the actor's `sub`.

### 6.2 Hashes (exact)

- **`record_hash`** is computed **by the database**, not by the application:
  `encode(sha256(convert_to(concat_ws(chr(31), tenant_id, seq, event_type, subject_table, subject_id, actor_sub, payload_sha256, projection_version, hash_version, prev_hash, created_at_utc), 'UTF8')), 'hex')`,
  where `created_at_utc` is `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and the first event of a tenant has
  `prev_hash = 64 zeros`. Every joined value is constrained not to contain `chr(31)`. `hash_version` (1) names this formula and
  `projection_version` (1) names the projection of section 6.2's next bullet; both are stored on the event, so a later change is detectable
  instead of silently reinterpreted. Known-answer vectors from an independent implementation: `apps/backend/test/fixtures/ledger-golden-vectors.json`.
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
  follows the applicable record-retention policy and legal holds, not erasure. HIPAA compliance-document retention is a separate
  category; see [retention authorities](../genomic-storage.md#retention-authorities-and-existing-policy).

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

- Records are retained indefinitely by the application (no delete path). Any future reviewed retention job must follow a record-category
  schedule that accounts for applicable law, customer obligations and legal holds; it would need an explicit, audited exception at the
  triggers. No such job or permission is introduced here. HIPAA's six-year compliance-document rule is not a universal clinical-record
  retention period. Existing retention settings remain unchanged; see [retention authorities and policy](../genomic-storage.md#retention-authorities-and-existing-policy).
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

## 15. Amendments made while building 5B-3.1 (these govern where they differ from the text above)

Each was found by building or by an attack test, and each is covered by a test.

1. **Hashes and versions** (6.2). The event hash also covers `projection_version` and `hash_version`. The payload of a **checkpoint** is
   `sha256(id, tenant, up_to_seq, head_hash, mode)` joined with `chr(31)`; the payload of a **redaction** is
   `sha256("<note id>:<original body sha256>:<basis code>")`. Both are recomputed by the verifier.
2. **Encoding of the projection** (6.2): uuid lower-case text; `timestamptz` as `YYYY-MM-DD"T"HH24:MI:SS.US"Z"` in UTC (microseconds, which
   JavaScript dates would lose); `bigint` as a decimal string; `numeric` as the stored text (`"1.50"`); `integer` as a JSON number;
   `text[]` as an array in stored order; `jsonb` canonicalized; free text replaced by `{ "id", "bodySha256" }`. Children of an evaluation are
   ordered in code (results by `ordinal`, gene states by gene symbol in UTF-16 order), never by a collation. The writer and the verifier load
   rows through the same function, so they cannot drift.
3. **Two append functions** (6.3). `ledger_append` is the only function the application may call, and it refuses the event types
   `redaction` and `checkpoint`. `ledger_append_internal` does the work and can be executed only by the redaction function and by
   functions of the same owner. Only `src/ledger/ledger-writer.ts` calls `ledger_append`; a static test pins that.
4. **The actor is the author** (6.3). The event's actor must equal the record's `created_by`, checked at COMMIT in **both** directions: a
   deferred constraint trigger on `ledger_events` (event to row) and a deferred constraint trigger on every record table (row to its own
   event: the event exists, names this row, this tenant and this author). The deferred foreign key alone only proves that *some* event with
   that id exists; without the second trigger a second row could point at the first row's event and commit (found by an attack test).
5. **An evaluation always names its capture** (3.4). `capture_id` is NOT NULL. `capture_acceptance_id` is nullable only for a held
   evaluation that was held before any acceptance (hold code `capture-not-accepted`). An evaluated one relies on the **latest** decision
   about its capture, and it must be an acceptance. `hold_message_id` is not stored: a hold is its code.
6. **Results** (3.4). `guideline_id` / `guideline_version` are nullable together with `citation` (a `no-guideline` or an uncited
   `no-published-recommendation` result has none). Each result also stores `gene_evidence` (the engine's per-result gene list), so the stored
   result equals the engine's output field for field.
7. **Redaction** (3.7, 6.8). A redaction carries a basis **code** (`phi-in-note`, `legal-order`, `other-approved`), not free text. The one
   allowed update of a note (tombstone, time, basis) is permitted only when a `redaction` event for that note was appended by the **same
   transaction** (checked through the event row's `xmin`), so an old event cannot be reused. The procedure `redact_event_note(note, event, basis)`
   is executed by the `telesphoros_ledger_operator` group, with the tenant and actor settings of the operator's session.
8. **Roles** (7; new text). Four `NOLOGIN` roles are created by the migrations: `telesphoros_ledger` (owns the ledger tables and functions),
   `telesphoros_redactor` (owns the redaction function; `UPDATE` only on three columns of `event_notes`), `telesphoros_ledger_verifier`
   (reads; executes only `ledger_record_checkpoint`) and `telesphoros_ledger_operator` (may execute the redaction function). Logins that
   are members of the last two are provisioned **outside the repository**; the verifier is deliberately **not** a member of the application
   role. Forced row-level security blinds even an owner, so the ledger role and the verifier each have an **explicit read policy on every
   record table**; the catalog guard (`ledger-catalog.pg-spec.ts`) fails when one is missing.
9. **Verification** (6.6). One verification runs in a single `REPEATABLE READ READ ONLY` transaction (one snapshot for the head, the events
   and the rows). Modes: `full` from genesis; `tail` from the newest checkpoint that still matches the chain (otherwise `full`). It checks both
   directions and the notes, reports a failure **kind and sequence number only**, and returns `incomplete` (never `ok`, and no checkpoint)
   when the time or event budget is exhausted. The verifier reads tenants directly from `ledger_heads`; there is no `ledger_tenants()`
   function. A checkpoint is written only by `ledger_record_checkpoint`, in a separate short transaction.
10. **The migrator** (D6). Migrations create ledger objects under `SET LOCAL ROLE telesphoros_ledger` / `telesphoros_redactor`, so the
    migrator needs a one-time `SET` membership in those roles (granted automatically to a superuser or an administrator-enabled migrator;
    `docs/ops/ledger-roles.md`). Every audit `down` migration refuses to run unless the session sets `telesphoros.allow_audit_drop = 'yes'`.
11. **Backup and restore** (10). The restore no longer passes `--no-owner` to `pg_restore` (pg_dump's own flag is ignored for the custom archive format, so the restore decides): a restore that gave the definer functions to a superuser would turn
    "the application can append" into "the application runs code as a superuser". The manifest records ownership and privilege facts
    (additive field `privileges`, covered by the signature); a restore first requires that every role they name exists on the server,
    restores with owners, and compares ownership and privileges with the record. Backups made before this field existed are restored as
    before. See `docs/ops/backup-and-restore.md`.
12. **PostgreSQL only.** The record repositories have no in-memory implementation: the guarantees are the database's.
13. **Not done in this slice.** Startup verification, the readiness `ledger` check, the restore-time ledger check and every endpoint belong to
    5B-3.2 and 5B-3.3. The pipeline stays off.

## 16. Amendments made while building 5B-3.2a (these govern where they differ from the text above)

1. **The roles table** (7). The role of a person is the whole set of groups they hold, never a "highest" one. `reviewer` adds to what a
   person holds; no other role implies it, so an `admin` alone cannot accept a capture, and `admin` + `reviewer` can (never their own work).
   The frontend's "most capable role" is for display only.
2. **Four identities cannot accept a capture** (7, decision 12), replacing "the user who uploaded the report": the report's creator, the
   first person who asked for an upload link (set once, never replaced), the person who completed the upload (set once), and the capture's
   creator. A retry that returns an existing record changes nobody's identity. A rejection is open to any reviewer. Enforced by the
   database (migration 0010), tested for each identity. An office therefore needs at least two people able to review.
3. **The stored file is pinned to a storage VERSION** (3.2, migration 0010). `reports.object_version` is read from the same response as the
   bytes that were hashed. A lab PDF without a real version (including S3's literal `null`) cannot be completed (409, reason
   `source-unpinned`). Once uploaded, the file's identity cannot change; once any capture exists, the report's type, name, patient and
   deletion mark cannot change either. Reads and links for evidence name the version; a missing version is "missing", never the latest.
4. **A capture locks the report row** (`FOR SHARE`) in the same transaction that inserts it, so a concurrent change to the report waits
   and is then refused (capture first), or is seen and the capture is refused (change first). Tested with two real sessions held at a
   barrier in both orders, with controls.
5. **Retention of overwritten files.** The reports bucket keeps noncurrent versions for at least six years (it was 90 days, which would
   have deleted a captured file's pinned version after an overwrite). Terraform enforces the floor with a variable validation and an infra
   guard. No principal in the module may delete object versions; a break-glass role outside it may, and its use is an audit event.
6. **The pipeline switch** (9) is `LAB_REPORT_PIPELINE` (default `disabled`). While off, creating, changing, uploading or completing a
   `lab-pdf` report answers 503 `PIPELINE_DISABLED` and does nothing; reading and deleting such a report still work. Enabled, it is refused
   in production and with the in-memory store, and with the S3 driver the application refuses to start unless the bucket keeps versions.
7. **Error codes** (8): `PIPELINE_DISABLED`, `PIPELINE_BUSY`, `READER_UNAVAILABLE`, `LEDGER_BUSY`, `LEDGER_CONFLICT`, `UNSUPPORTED_SOURCE`,
   `PIPELINE_MISCONFIGURED`; a business conflict keeps `CONFLICT` with a stable `details[].reason`. Only the three "try again" errors carry
   `Retry-After`.
8. **A file name must end in the extension of its type** on create and on change (`lab-pdf` takes only `.pdf`).

## 17. Amendments made while building 5B-3.2b-1 (these govern where they differ from the text above)

1. **The capture protocol is enforced by the repository** (3.2, plan 12.3). `insertCapture` requires the bindings the caller relied on
   (patient, file hash, object version, storage key) and, inside the capture's own transaction, locks the report row `FOR SHARE`, re-reads
   them, and refuses with "source changed" if any differs. The database trigger of migration 0010 repeats the checks, so a caller that
   bypasses the repository is stopped too.
2. **The captured text is not version-pinned** (decision 18). The capture table has no column for the text object's version, and adding one
   would change the hashed projection. Instead the text key is content-addressed and deterministic, the text is re-hashed before a link is
   issued (`GET /captures/:id/text-url`, a separate route so a damaged text object cannot make the capture unreadable) and again at
   evaluation. A link therefore names a version whose bytes were just checked.
3. **File links are for clinician, reviewer and admin, not reader** (decision 19). A PDF is the most sensitive artifact in the system.
4. **The text runner hashes the bytes it is given** and takes no hash from the caller, so a replaced file cannot borrow another file's text.

## 18. Amendments made while building 5B-3.2b-2 (these govern where they differ from the text above)

1. **The dispute re-check** (5.3, plan 12.2). `insertEvaluation` re-checks for an open or upheld dispute **after** the ledger append, as its own
   statement under READ COMMITTED. It is sound only because every dispute change also appends (so it needs the same tenant lock), the
   evaluation keeps the lock to COMMIT, and the check takes a fresh snapshot. A dispute that committed before the lock was granted is seen and
   the evaluation is refused with nothing stored; one that queued behind is ordered after the evaluation. Held evaluations (no drug results) and
   replays of a stored evaluation are not blocked. Tested with two real sessions in both orders, and the isolation level and the separate
   statement are asserted.
2. **Reader outcomes** (6). `source-limit` and `candidate-or-frame-limit` are stored as `held`; `source-time-budget` and `worker-error` answer
   503 and store nothing.
3. **What an evaluation stores beyond the adapter's binding:** `scope` and the recorded-set hash (inside `binding`), the knowledge set id and
   the build version. Source-bound clinical context (indication, population, specimen) remains deferred (section 14).
4. **Reading** (4.5, 8). A stored evaluation is always readable by id. Its response says whether the decision it relied on is still the latest
   (`acceptance.current`), how many disputes are active in the tenant, and `actionable: false` (always, while not approved for clinical use).
5. **The reader limit is per process** and is a configuration value (`LAB_REPORT_MAX_CONCURRENT_READS`).

## 19. Amendments made while building 5B-3.3a (these govern where they differ from the text above)

1. **A correction names the correction it saw last** (4.3, 8). `previousCorrectionId` must equal the evaluation's latest correction, or be omitted
   when there is none; anything else is 409 `stale-chain` and the service never fills it in. The one-child unique indexes still decide a race (the
   loser is told to reload). Nothing about the evaluation, its report or the author is taken from the request body.
2. **Reasons the API gives** (4.4). `invalid-transition` (superseded is terminal; a retracted evaluation can only be reinstated; only a retracted
   one can be reinstated), `self-reinstatement` (the reinstater is not the retractor; the database trigger repeats it), `bad-replacement`.
   The reason table of 4.2 is checked against migration 0009's CHECK constraint by a test that reads the migration text.
3. **A replacement** (4.1, 4.3) must also be **newer** than the evaluation it replaces and itself **active** (service rules; no migration). A held
   replacement is allowed ("replaced by no result"). If the replacement is retracted a moment after the check, the history reads correctly and no
   record is wrong; this is recorded, not prevented. Unknown replacement: 404.
4. **`current`** (4.5) is on every evaluation (`current: boolean`) and `GET /evaluations?current=true` returns the current evaluation of each report
   (only the value `true` is accepted). It follows the specification as written: if the newest evaluation is retracted, an **older still-active evaluation
   becomes current again**. This is flagged for a clinical decision; it is not silently changed. **Superseded by section 22: the founder decided
   that nothing is current in that case.**
5. **Correction history in the evaluation** (4.4, 8). `corrections` lists every correction oldest first; the evaluation's `state` and `supersededBy` are
   derived from that same list, so the two cannot disagree. A correction shows its note as `{id, bodySha256}` only; whether a note was redacted is shown
   when it is read.
6. **Reading a note** (3.7, 6.8). `GET /notes/:id` (clinician, reviewer, admin; not reader) returns the text, or the fixed tombstone once redacted, with
   its original digest. It is the only route that returns a note body; it is never logged, and another tenant's note is 404.

## 20. Amendments made while building 5B-3.3b (these govern where they differ from the text above)

1. **The overlay replaces the tenant-wide refusal** (5.3, plan 12.2). `dispute-active` is gone. An evaluation is built from the disputes it read; the
   storing transaction refuses (`DisputeChangedError`, 409 `dispute-changed`) only if, after the ledger lock is held, an active dispute is not among
   the **ids it read** (its basis). A dispute that has since left the set is harmless. The service retries once with the new set, without running the
   reader again. Omitting the basis means "none were considered": it fails closed. A held evaluation needs no basis. Proved again with two real
   sessions in both orders, and the check is asserted to be its own statement after the append under READ COMMITTED.
2. **What the overlay changes** (5.3). Only cells that were `verified` and are named by an open or upheld dispute **whose file version and content hash
   match the loaded file**. Cells already `unverified` or `disputed` are untouched and are not part of the effective id. The effective id is
   `sha256("overlay/1\n" + baseId + "\n" + canonicalJson(sorted cell keys))`, a cell key being `[guideline id, version, file hash, table, row, column or null]`,
   and equals the base id when nothing changed. The stored binding also records `overlay: {version, baseKnowledgeSetId, cellKeys}` so a reader can rebuild
   the set. Disputes are read per tenant; one tenant's dispute never changes another tenant's evaluation.
3. **Idempotency across a dispute** (3.4). The evaluation identity includes the effective knowledge set id, so repeating a request after a dispute is a
   new evaluation, and after a dismissal it is the original evaluation again (a replay). A dispute that holds an unrelated cell also changes the id.
4. **Endpoints** (8). `POST /cell-disputes` and `POST /cell-disputes/:id/decision` (reviewer only); `GET /cell-disputes` (filter `status`) and
   `GET /cell-disputes/:id` for every signed-in role. The guideline version and content hash are taken from the loaded knowledge. Reasons: 404
   `unknown-guideline`, 409 `unknown-cell`, 409 `self-decision` (the database trigger repeats it), 409 `already-decided` (the unique constraint repeats
   it). A dispute shows `inForce`: open or upheld **and** the loaded file is still the one that was disputed. Notes are digests only.
5. **Two open disputes about one cell are allowed**; each is independent and the overlay is a set. No cross-table uniqueness is added.


## 21. Amendments made while building 5B-3.3c (these govern where they differ from the text above)

1. **Configuration** (6.6). `LEDGER_VERIFIER_DATABASE_URL` is the verifier's own login (never the application's; refused if equal to `DATABASE_URL`). It is
   required in production and whenever `LAB_REPORT_PIPELINE=enabled`, and the watch is off when it is not set elsewhere. `LEDGER_STARTUP_BUDGET_MS`
   (default 20 000) is **one total budget across tenants**; `LEDGER_FULL_VERIFY_INTERVAL_HOURS` (default 24; 0 turns the timer off).
2. **The check at start** (6.6). A tenant is checked from its latest checkpoint within the remaining budget, except that a chain whose head is at or below
   50 000 events (measured: about 5 s for a full walk; 14.7 s for 150 000; `docs/ops/ledger-watch.md`) is walked in full, because a checkpoint is a shortcut and not a control. A tenant reached after the
   budget is spent is **incomplete**, never `ok`. Production refuses to start on `failed` or `incomplete`, and also when the check cannot run at all
   (login, network, missing tables): nothing is known, which is not "fine". **Refinement of the plan:** a *failed* check at start latches in development
   too (the plan left it unlatched until the background walk found the same thing); readiness is down and writes stop at once.
3. **The latch** (6.6). In-process, first finding kept, cleared only by a restart. The append gate is a **required first argument of `appendEvent`**, asked
   before the record is read or anything is appended; the Postgres repository passes the shared status. A closed gate rolls back the whole transaction (503
   `LEDGER_COMPROMISED`, no `Retry-After`). The evaluation route also asks before it runs the reader. Writes that are not ledger records are unaffected.
4. **Background and timer** (6.6). One tenant at a time, `full`, a checkpoint on success and **none once latched**. A walk that is too large for its
   budget (15 minutes per tenant), or cannot run (database problem), leaves readiness at `verifying` and latches nothing; the next scheduled walk tries
   again. One verification at a time per process: background callers queue, the admin endpoint is told it is busy. A shutdown aborts the walk at its
   next batch (`VerifyOptions.signal`).
5. **Readiness** (6.7). `ledger` is `up`, `verifying` (usable; a full walk is running or has not finished) or not ready. `ReadinessDto.checks` values are
   `up | verifying`. A setup without a verifier login reports exactly what it did before.
6. **`GET /ledger/verify?full=`** (8). Admin only, behind the pipeline gate (it lives with the other pipeline routes), the caller's own tenant only (no
   tenant parameter exists; the query is strict). Default walks from the checkpoint, `full=true` the whole chain, within 30 s; success records a
   checkpoint; a `failed` answer latches. 503 `PIPELINE_BUSY` + `Retry-After` while another check runs. The answer is
   `{status, mode, headSeq, headHash, eventsChecked, failures: [{kind, seq}], checkpointId}`.
7. **Restore** (10). `restoreAndVerify` gains `ledger chain`: a full walk of every tenant as `telesphoros_ledger_verifier` (the restore's server credentials
   with `role` set on the connection), writing nothing; "not applicable" for a backup that predates the ledger.
8. **Not done, and said so.** No alarm is connected to the `ledger-compromised` log line (Terraform is written, never applied); the head is still not
   anchored outside the database (6.9).

## 22. Amendment made after the clinical decision on `current` (this governs where it differs from 4.5 and section 19)

The founder (a pharmacist) decided on 2026-10-08 that when the newest evaluation of a report is retracted, **nothing is current**. The rule is now:

> The current evaluation of a report is its newest evaluation (by `seq`) if that evaluation is `active`. Otherwise the report has no current evaluation.

- **Why.** A retraction says "do not rely on this". Quietly promoting an older evaluation would present a result that predates the corrected one as the
  one to rely on, when nobody has said so. Failing closed is the safer default for decision support.
- **What follows.** An older evaluation that was never corrected stays `active` (its `state` is unchanged) but `current` is `false`. A reinstatement of the
  newest makes it current again. A fresh evaluation (a new capture and acceptance, or newer knowledge) is the newest and is current if active. A
  supersession is unchanged: the replacement is newer, so it is current.
- **Known consequence.** If the newest is retracted and the older one was in fact right, a reviewer cannot say so; they need a fresh capture and
  evaluation. A later "affirm" action could close that gap if it proves needed; it is not built.
- **What did not change.** `state`, `supersededBy`, the correction rules, stored records (no migration), and every other field of an evaluation.
  `GET /evaluations?current=true` and `current` on each evaluation follow the new rule from the same single query.

## 23. Amendment made while building FD-2: containment shared through the database (this governs where it differs from 6.6, 6.7 and section 21)

The peer review of 2026-10-09 found that the latch of 6.6 lived in one process's memory, so a second API task kept appending to a chain the first had
found damaged (and a load balancer does not help: it sends traffic to every target when all are unhealthy). Migration 0011 moves the fact into the
database, where `ledger_append` already takes the tenant's head-row lock. The plan is [design/plans/fd2-ledger-containment.md](plans/fd2-ledger-containment.md).

- **Tables.** `ledger_incidents` (a tenant incident or a global hold; open until a clearance names it) and `ledger_incident_clearances`; both append-only
  (the `refuse_mutation` triggers), neither readable by the application role. `ledger_checkpoints` gains `walk_started_at` (the database's clock at the
  start of the walk's snapshot; `NULL` for checkpoints from the older four-argument function, which therefore never clear anything).
- **Who.** `ledger_record_incident` (verifier login, tenant incidents only, idempotent while one is open), `ledger_set_global_hold` and
  `ledger_clear_incident` (operator role only). The application role holds `ledger_append` and nothing behind it (`ledger_append_internal` stays
  unreachable for it; a catalog test pins this).
- **The gate.** `ledger_append` takes the tenant's head-row lock and then refuses (SQLSTATE `LC001`, 503 `LEDGER_COMPROMISED`) while the tenant has an
  open incident or any global hold is open. `ledger_record_incident` takes the same lock, so no write commits for the tenant after the incident exists.
  Checkpoints and redactions use `ledger_append_internal` and are deliberately not gated.
- **Clearing a tenant incident** needs a `full` checkpoint of that tenant whose walk **started after** the incident was recorded and reaches at least the
  failed sequence number. A chain that is still damaged writes no checkpoint, so it cannot be cleared by anyone. A global hold needs only a basis.
- **Per tenant, not per instance.** The in-memory `LedgerStatus` is a mirror and a fast path, per tenant; the monitor records its findings in the
  database, reads the open incidents at start, before each full walk and every 60 seconds, and keeps refusing on its own for a finding the database has
  not yet heard. Production still refuses to start on a NEW failure (recorded first, so the replacement start finds it contained and goes on); an
  already-contained tenant is listed in the log and not re-judged at start. Readiness is `contained` (still ready) for tenant incidents and not ready
  for a global hold or an unverified start. The first finding logs `ledger-compromised` (the alarm); later failures of a contained tenant log a warning.
- **Not built.** Two-person approval of a clearance or hold (FD-8). Anchoring the head outside the database (6.9). Anything proved in AWS.
