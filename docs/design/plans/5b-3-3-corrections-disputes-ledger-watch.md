> **Plan record.** Plan for slice 5B-3.3. Approved 2026-10-08 with all recommendations (decisions 24 to 30). 3.3a (corrections) is built in the PR that adds this file; 3.3b and 3.3c follow, each its own PR. Where this text and the code or `docs/design/records-and-corrections.md` differ, the code and the specification govern (section 19 of the specification lists the amendments found while building).

# Plan: slice 5B-3.3, corrections, disputes and the ledger watch

This slice makes the stored records **correctable** and the ledger chain **actively watched**. It builds on 3.1 (tables, ledger, verifier), 3.2a (roles, evidence) and 3.2b (the pipeline up to a stored evaluation, #20 to #29).

## Summary

**What it does**
- Reviewers can retract, reinstate or supersede a stored evaluation, and see the correction history (3.3a).
- Reviewers can dispute a guideline cell; a disputed cell is held with no wording, and the rest of the tenant keeps evaluating (3.3b).
- The ledger is verified at startup, re-verified in the background and on a schedule, fails closed on corruption, shows in readiness, can be checked on demand by an admin, and is checked when a backup is restored (3.3c).

**What it does not do**
- It approves nothing for clinical use. Every result stays `clinicalUse: "not-approved"` and `actionable: false`.
- It does not change production gating: the pipeline stays a synthetic, non-production integration and is still refused in production.
- It needs **no migration**: the tables, constraints and triggers for corrections and disputes (migration 0009) and the repository methods already exist and are tested.
- No frontend (5D), no Terraform, nothing applied in AWS, no change to the engine, adapter, reader, knowledge schema or hash formulas.

**How**
- Three separate PRs, each branched off `main` (never stacked), each stopping for your review. Synthetic data only.

## Required approvals (decisions 24 to 30)

If you agree with all recommendations, reply **"approved, use your recommendations."** The reasoning for each is in the section named.

| # | Decision | My recommendation | Detail |
| --- | --- | --- | --- |
| **24** | PR structure and order | Three PRs, in the order a (corrections), b (disputes and overlay), c (ledger watch). c has no dependency on a or b and can go first if you prefer the integrity net earlier. | Section 2 |
| **25** | The dispute blocker | Replace the tenant-wide `dispute-active` refusal (any dispute blocks every drug) with the overlay plus an exact re-check by dispute id after the ledger lock. Cost: tests that proved the stopgap are rewritten, with the same two-session method. | Section 5.3 |
| **26** | Verifier login | Required in production and whenever the pipeline is enabled (fails closed; costs nothing until the hosting phase). | Section 6.1 |
| **27** | Restore-time ledger check | Run as the verifier role through the restore's existing superuser connection (`SET ROLE`), so no new credential is needed. | Section 6.3 |
| **28** | Reading notes | Add `GET /notes/:id` for clinician, reviewer and admin. Without it a second reviewer cannot read the dispute they are asked to decide. Alternative: defer to the UI slice. | Section 4.1 |
| **29** | "Evaluations that used this cell" listing | Defer. Record it as the first item that must exist before any clinical approval. | Section 5.4 |
| **30** | The `current` rule | Implement spec 4.5 exactly: if the newest evaluation is retracted, an older still-active one becomes current again. I will flag this in the PR for a clinical decision rather than quietly change the specification. | Section 4.3 |

## 1. Current state and prerequisites

- **The database side of corrections and disputes is built and tested (migration 0009, 3.1).** `LedgerRecordsRepository` already has `insertCorrection`, `listCorrections`, `evaluationState`, `raiseDispute`, `decideDispute` and `listDisputes`. The state machine, the one-child rule, "the reinstater is not the retractor" and "the decider is not the raiser" are database triggers.
- **No endpoint calls them yet.** `EvaluationDto.corrections` is always `[]`. `applyDisputeOverlay` does not exist.
- **The 3.2b-2 dispute check is deliberately coarse.** Any open or upheld dispute in the tenant refuses every new evaluated evaluation. `ledger-types.ts` marks it as a stopgap "until the overlay exists, 5B-3.3".
- **A cell is identified by** guideline file id, version, the file's content hash and a locator (table, row, optional column). The loaded `KnowledgeSet` already carries each file's `contentSha256`, and the engine already holds a cell whose verification state is `disputed`, showing no wording (`cell-disputed`).
- **The verifier exists but nothing runs it.** `LedgerVerifier` uses its own database login (`telesphoros_ledger_verifier`, deliberately not the app's), has a time and event budget, returns `ok | failed | incomplete`, can record a `tail` or `full` checkpoint, and reports failures as a kind and a sequence number, never a value.
- **Readiness** has `database` and `migrations`; `ReadinessDto.checks` is `Record<name, 'up'>`.
- **Restore** (`restoreAndVerify`) checks counts, migrations, schema, row-level security and privileges. It does not walk the chain; `ledger-backup.pg-spec.ts` verifies a restored ledger by hand.
- **Notes** live in `event_notes` and never in the ledger or the DTOs. There is currently no API to read a note's text (decision 28).

## 2. Pull request structure (decision 24)

| PR | Contents | Why separate |
| --- | --- | --- |
| **3.3a, corrections** | `POST /evaluations/:id/corrections`; correction history in the evaluation DTOs; `current` on evaluations; `GET /evaluations?current=true`; `GET /notes/:id` | The safety lever: a wrong result can be undone. Self-contained, because the database rules exist. |
| **3.3b, disputes and the overlay** | `POST /cell-disputes`, `POST /cell-disputes/:id/decision`, `GET /cell-disputes`, `GET /cell-disputes/:id`; `applyDisputeOverlay` and the effective knowledge set id; evaluation uses the overlay; the coarse refusal is replaced by an exact re-check | The most delicate rule: it changes behaviour 3.2b-2 proved. |
| **3.3c, ledger watch** | Verifier configuration; startup tail verification; background full verification; the `ledger-compromised` latch; scheduled verification; `GET /ledger/verify`; readiness `ledger` check; restore-time check; ops docs | The integrity net. Independent of a and b: it verifies whatever is in the chain. |

**Files touched**

| Area | Files | PR |
| --- | --- | --- |
| Shared types | `packages/shared-types/src/lab-report.ts` (correction, dispute, note and verify DTOs; `current` and a filled `corrections` on evaluation DTOs; `ReadinessDto` allows `'verifying'`) | a, b, c |
| Services and controllers | `corrections.service.ts`, `corrections.controller.ts`, `notes.controller.ts` (a); `disputes.service.ts`, `disputes.controller.ts` (b); `ledger-verify.controller.ts` (c) | a, b, c |
| Overlay | `src/services/knowledge/dispute-overlay.ts` (pure function) and a guideline and cell lookup on `KnowledgeSet` | b |
| Evaluation | `evaluations.service.ts` (read active disputes, build the overlay, one bounded retry), `lab-report.mapper.ts` | a, b |
| Repository | `ledger-records.repository.ts` and its PostgreSQL implementation: `listEvaluations({current})`, `findNote`, active disputes as rows, the exact re-check, `DisputeChangedError` replacing `DisputeActiveError` | a, b |
| Ledger watch | `src/ledger/ledger-monitor.ts`, `ledger-status.ts`, an append gate in `ledger-writer.ts`, `src/health/ledger.readiness.ts`, `health.module.ts` | c |
| Config | `LEDGER_VERIFIER_DATABASE_URL`, `LEDGER_STARTUP_BUDGET_MS`, `LEDGER_FULL_VERIFY_INTERVAL_HOURS`, with validation | c |
| Restore | `src/db/restore.ts` (a `ledger chain` check), CLI help, `docs/ops/backup-and-restore.md` | c |
| Docs | Spec section 19 (amendments), `docs/lab-report-reader.md`, `docs/STATUS.md`, `docs/architecture.md`, `docs/ops/ledger-roles.md`, `.env.example` | all |

## 3. Conventions shared by every new endpoint

All routes are under `/api/v1` and behind `@RequiresPipeline()`. Order of answers: 401, 403, 503 (pipeline off), 400, then the work. A foreign or unknown id is 404. No response, log line or ledger event contains note text, report text, span text or a gene value.

## 4. PR 3.3a, corrections

### 4.1 Endpoints

| Route | Roles | Input | Success | Refusals (nothing is stored) |
| --- | --- | --- | --- | --- |
| `POST /evaluations/:id/corrections` | reviewer | `{kind, reasonCode, previousCorrectionId?, replacementEvaluationId?, note?}` | `201` the correction | 409 `stale-chain`, 409 `bad-replacement`, 409 `invalid-transition`, 409 `LEDGER_CONFLICT` (any database rule, including a race), 400 validation |
| `GET /evaluations`, `GET /evaluations/:id` | all | adds `current=true` | list or detail | n/a |
| `GET /notes/:id` | clinician, reviewer, admin | path id | the note, or its tombstone if redacted | 404 |

### 4.2 Rules

1. **The client names the correction it saw last.** `previousCorrectionId` must equal the evaluation's latest correction, or be omitted when there is none. Anything else is 409 `stale-chain` ("reload"). The service never fills it in: a reviewer acts on what they were looking at. The database one-child indexes remain the real guard against two reviewers acting at once; the loser gets `LEDGER_CONFLICT`, which the service reports as the same "reload" answer.
2. **Kind, reason and state** follow spec 4.1 to 4.4. The service checks first so the answer is a clear 409; every rule is also a database constraint or trigger, already tested in 3.1.
3. **A supersession needs a valid replacement** (service rules, no migration). The replacement must exist in the tenant, belong to the **same report** (the database already enforces this), be **newer** (greater `seq`), and be **active**. A held replacement is allowed: "replaced by no result" is a legitimate outcome. Race: the replacement could be retracted just after the check; the history then reads correctly (old superseded, replacement retracted, no current result) and no record is wrong. Recorded, not prevented.
4. **`clinical-review-disagrees` needs a note** (database check); other reasons take an optional note of 1 to 1000 characters, stored in `event_notes` with only its hash in the ledger.
5. **Independence:** a retraction is reinstated by someone else (database trigger). Nothing else is added; a reviewer may retract an evaluation they created, because spec 7 does not forbid it.
6. **Responses carry a note as `{id, bodySha256}`;** the text, and whether it has been redacted, are read through `GET /notes/:id`. (Amended while building: the stored projection that the ledger hashes has no `redacted` field, so the correction cannot carry one.)

### 4.3 "Current" (decision 30)

`current` is the **latest (`seq`) active evaluation of its report**, per spec 4.5. `GET /evaluations?current=true` returns one per report and composes with `patientId` and `reportId`. Every evaluation DTO gains `current: boolean` (an additive change to a strict contract, listed in the PR). It is computed in SQL from `corrections` in one statement.

Consequence to be aware of: if the newest evaluation is retracted, an older still-active evaluation becomes current again. That is the specification as written. I will implement it as written and flag it in the PR as a point for clinical review.

## 5. PR 3.3b, disputes and the overlay

### 5.1 Endpoints

| Route | Roles | Input | Success | Refusals |
| --- | --- | --- | --- | --- |
| `POST /cell-disputes` | reviewer | `{guidelineId, locator: {table, row, column?}, note}` | `201` | 404 `unknown-guideline`, 409 `unknown-cell` |
| `POST /cell-disputes/:id/decision` | reviewer | `{decision: upheld or dismissed, evidenceNote}` | `201` | 409 `self-decision` (database trigger), 409 `already-decided` (unique), 404 |
| `GET /cell-disputes`, `GET /cell-disputes/:id` | all | filter `status` | list or detail with status and decision | n/a |

The version and content hash are **read from the loaded knowledge, never supplied** (spec 8). List views carry no note text.

### 5.2 The overlay (spec 5.3): a pure function, tested alone

`applyDisputeOverlay(knowledge, disputes)` returns a new `KnowledgeSet` in which each cell named by an **open or upheld** dispute, **whose disputed file hash equals the loaded file's hash**, has `verification: {state: 'disputed', note: <fixed text>}`.

- **It can only tighten.** A `verified` cell becomes `disputed`; an `unverified` or already `disputed` cell is unchanged. A dismissal never makes anything shown, because a dismissed dispute is simply not in the input.
- **A dispute about an older file version** (different hash) has no effect: the corrected, re-signed file lifts the hold, as the specification says.
- **The effective id** is `sha256("overlay/1\n" + baseId + "\n" + canonicalJson(sorted disputed-cell keys))` and **equals `baseId` when nothing was overlaid**, so results made without disputes keep their ids. A cell key is `[guidelineId, version, contentSha256, table, row, column or null]`.
- **The loaded set is never modified;** it stays immutable and shared.
- **The stored binding also records** `overlay: {version: "overlay/1", baseKnowledgeSetId, cellKeys}` when any cell was overlaid, so a later reader can rebuild the effective set. This sits inside the already-hashed binding; no schema change.

### 5.3 Replacing the coarse refusal with an exact one (decision 25)

Today any active dispute in the tenant blocks every new evaluated evaluation. After this PR, evaluation proceeds, disputed cells are held by the overlay, and safety rests on one sound check. Flow in `EvaluationsService.create` (the reader still runs outside any transaction and is never run twice):

1. Read the tenant's active disputes (open or upheld) **with their ids**, build the overlay, and run the engine on the overlaid set.
2. `insertEvaluation` receives `disputeBasis`: the set of active dispute ids that were considered.
3. Inside the storing transaction, **after the ledger append, with the tenant lock held until COMMIT**, the repository reads the currently active dispute ids in a **separate statement under READ COMMITTED. That statement takes its snapshot only after the lock is granted,** so it sees every dispute that committed before the lock. If any id is not in `disputeBasis`, it throws `DisputeChangedError` and nothing is stored. A dispute that has since *left* the set (dismissed) is fine: the result is only more cautious than needed, and its id says exactly what was applied.
4. The service answers `DisputeChangedError` by **re-reading, rebuilding and retrying the engine and the store once**. The adapter result is reused and the reader is not run again. A second failure is 409 `dispute-changed` ("try again").
5. A **held** evaluation (no drug results) needs no basis and is not blocked, as in 3.2b-2. A replay of a stored evaluation is returned before this check, as in 3.2b-2.

**Why it is sound.** Every dispute change also appends to the ledger, so it needs the same per-tenant lock. A dispute that committed before the lock was granted is visible to the post-lock statement and is refused. A dispute that is still waiting for the lock is ordered after the evaluation, which is correct: the evaluation is then simply older than the dispute. This is **proved again with two real database sessions in both orders**, deterministically, using the same barrier tooling as 3.2b-2.

**Tests that change.** The tests that encode the stopgap are rewritten, not deleted, and each is listed in the PR: `dispute-recheck.pg-spec.ts`, the `dispute-active` end-to-end test, and the `DisputeActiveError` mapping. `activeDisputeExists` is replaced by a method that returns the rows.

### 5.4 Explicit non-goals and boundaries

- **A dispute does not retract earlier evaluations.** A reviewer who upholds a dispute then corrects the affected evaluations with `knowledge-error-found` (3.3a). Every evaluation shows `advisory.activeDisputes`, and nothing is `actionable` in this stage. A listing of "which evaluations used this cell" is the first thing needed before any clinical approval; it is deferred and named in the follow-ups (decision 29).
- **No cross-tenant propagation** (decision 5, unchanged).
- **Two open disputes about the same cell are allowed.** Each is independent and the overlay is a set. The database has no cross-table uniqueness for this and I do not add one.

## 6. PR 3.3c, the ledger watch

### 6.1 Configuration (decision 26)

- `LEDGER_VERIFIER_DATABASE_URL`: the verifier **login**, never the application's (`docs/ops/ledger-roles.md`). **Required when `NODE_ENV=production` and when `LAB_REPORT_PIPELINE=enabled`;** optional otherwise. In production with the pipeline off the ledger is empty, so the check is instant; requiring the login proves the chain is watchable from day one and fails closed if it is missing. It costs nothing until the hosting phase, when the login must be provisioned (already documented as outside the repository).
- `LEDGER_STARTUP_BUDGET_MS` (default 20 000) and `LEDGER_FULL_VERIFY_INTERVAL_HOURS` (default 24; 0 disables the timer).
- Validation errors name variables, never values.

### 6.2 Behaviour (spec 6.6 and 6.7)

1. **Startup, synchronous and bounded.** For each tenant, `tail` verification within the budget. **Production refuses to start** on `failed` or `incomplete`. Development and tests log a warning and continue in state `unverified`.
2. **Background.** Immediately after start, one tenant at a time, `full` verification with a checkpoint on success. `failed` **latches** `ledger-compromised`. `incomplete` (too large for its budget) logs and leaves the state `verifying`, to be retried on the schedule.
3. **The latch** is in-process and cleared only by a restart. While latched, `/ready` fails (`ledger`) and every ledger append returns 503 `LEDGER_COMPROMISED`; reads still work. The gate sits in `ledger-writer.ts`, the one place that can append (already the only caller of `ledger_append`, pinned by a static test), so a future route cannot bypass it. The evaluation route also checks before running the reader, so a doomed request wastes no work.
4. **Alarm.** A structured `error` log (`ledger-compromised`, tenant, failure kind, sequence number; never a value). Connecting a cloud alarm to that log line is a deployment task (Terraform is written, never applied); the ops document will say so rather than claim an alarm exists.
5. **Schedule.** An unref'd timer runs full verification every N hours, jittered. Several instances each running it is harmless (read-only snapshot) and merely redundant.
6. **Readiness `ledger`:** `up` (tail verified, no latch), `verifying` (tail verified, full running; the instance **is ready**), otherwise failing. The check reads in-memory state, so it cannot time out on the database. `ReadinessDto.checks` becomes `'up' | 'verifying'` (additive).
7. **`GET /ledger/verify?full=`** (admin only, behind the pipeline gate, for the caller's tenant). Runs `tail`, or `full`, now; one at a time per process (otherwise 503 `PIPELINE_BUSY` with `Retry-After`); writes a checkpoint on success. Returns `{status, mode, headSeq, headHash, eventsChecked, failures: [{kind, seq}], checkpointId}` and never a row value. A `failed` result also latches: an admin finding corruption has found the same corruption.
8. **Thresholds (spec 13).** I will measure verification time on synthetic chains of 10 000 and 50 000 events on the CI-sized machine inside this PR, set the default budget and the "below this size, tail is a full walk" threshold from the numbers, and record them in the PR. The spec's 50 000 stays provisional until then.

### 6.3 Restore-time check (decision 27)

`restoreAndVerify` gains a check named `ledger chain`. After the restore, for every tenant in the restored copy it runs a **full** verification acting as `telesphoros_ledger_verifier`: the superuser connection already used for the restore runs `SET ROLE`, so no extra credential is needed and the verifier's own policies are exercised. It writes nothing (`recordCheckpoint: false`), so a throwaway restore stays a throwaway.

It cannot be skipped silently. A restored copy with ledger events and a failing or incomplete walk makes the restore "not ok". A backup from before the ledger existed records the check as "not applicable" with the reason, the way the privileges check does for older backups.

## 7. Error contract additions

`LEDGER_COMPROMISED` (503) is a new top-level code. New stable `details[].reason` values: `dispute-changed`, `stale-chain`, `bad-replacement`, `invalid-transition`, `unknown-guideline`, `unknown-cell`, `already-decided`, `self-decision`. Only "try again" errors carry `Retry-After`.

## 8. How each PR is verified

Every PR: the three backend tiers, typecheck, lint, build, infra and CI-config tests, frontend tests, chunk check, secret scan, and a clean-state run.

**3.3a, corrections**
- End to end over HTTP on D01 to D12: retract; reinstate (by another reviewer; the same reviewer refused); supersede with a newer evaluation of the same report; supersede with an older one, another report's, or a retracted one (each refused with a reason); stale `previousCorrectionId`; two reviewers at once (one wins, one gets `LEDGER_CONFLICT`); terminal state after supersession; `clinical-review-disagrees` without a note refused.
- The history in the DTO equals what was written; the ledger chain verifies afterwards; the original evaluation is byte-for-byte unchanged.
- `current` and `current=true` in each state, including the fallback to an older active evaluation.
- Role matrix (reader, clinician and admin cannot correct). `GET /notes/:id`: cross-tenant 404, a redacted note shows the tombstone, no note text in any list or log (log capture).
- **Defect injection** with harmless controls on: the state check, the replacement-newer rule, the replacement-active rule, the stale-chain rule, `current` selection, and the no-note-text-in-responses rule.

**3.3b, disputes and the overlay**
- Overlay unit tests: tighten-only; a dismissal never loosens an `unverified` cell; an older file hash lifts the hold; the id equals the base id when nothing was overlaid; the input is not modified.
- End to end: a dispute on a verified cell makes the next evaluation that uses it held with `cell-disputed` and no wording, while an unrelated drug still evaluates. Upheld keeps the hold; dismissed restores the file's own state. The decider is not the raiser. Unknown guideline or cell refused. Version and hash come from the loaded set.
- **Two-session proofs in both orders** for the exact re-check, deterministic via the barrier tooling, plus the retry path and the second-failure answer.
- **Defect injection** on: overlay skipped, overlay loosening, hash comparison dropped, re-check removed, re-check on the wrong isolation level, re-check accepting unseen ids. The rewritten stopgap tests are listed in the PR.

**3.3c, ledger watch**
- Startup: a clean ledger passes; a tampered chain (an edit, a deletion, a reordering, a late child row, an edited note) fails startup in production and warns in development; an exceeded budget fails production closed.
- Background: corruption injected after start is found and latches; readiness fails and appends return 503 `LEDGER_COMPROMISED` while reads still work; only a restart clears it. Readiness shows `verifying`, then `up`.
- `GET /ledger/verify`: admin only, one at a time, no row values in the answer, latches on failure.
- Restore: a good backup passes; a restored copy with an edited row fails the new check; a pre-ledger backup reports "not applicable".
- Measurements recorded in the PR.
- **Defect injection**, each with a control, on: the startup refusal, the latch, the append gate, the readiness mapping, the restore check.

## 9. Risks

1. **3.3b changes proved behaviour.** Mitigation: the same method that proved it the first time (two real sessions, a barrier, defect injection), with the old tests rewritten visibly rather than quietly weakened.
2. **The latch is an in-process flag,** so two instances can disagree briefly; each runs the same walks and latches itself. Acceptable for a single-instance pilot, and stated in the ops document.
3. **Production start-up now depends on the verifier login existing** (decision 26). Intended and documented.
4. **A full verification of a very large chain may not finish within its budget.** It then stays `verifying` and logs. Not a pilot-scale problem; the measurements will show where it begins.
5. **Notes may contain accidental identifiers.** `GET /notes/:id` is limited to the roles that already see report files, is never logged, and redaction (already built) works through it.

## 10. Follow-ups after this slice

The "evaluations that used this cell" listing (decision 29); anchoring each tenant's head outside the database; the cloud alarm on the `ledger-compromised` log line; the adapter-side R05 readiness proposal (awaiting you); the real Poppler runner; Tableau; the founder-owned actions in `docs/STATUS.md`; the frontend (5D).
