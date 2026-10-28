# Lab-report reader (sidecar)

> **Not approved for production.** The imported engine is authorized for offline construction only
> (`clinical_approval: false`, `training_eligible: false`), and `SubprocessReportReader` refuses to be created with
> `mode: 'production'`. Nothing calls it yet: the adapter (next PR) and the records/API slice (5B-3) come later. The records/API slice is specified in [design/records-and-corrections.md](design/records-and-corrections.md).
> Everything under `knowledge/lab-report-reader/v2-handoff/` is **TEST ONLY: not clinical content, not human-adjudicated**.

## What it does

The reader finds where genes, diplotypes and reported results sit inside one stored report text. It never decides what
a value means and never looks at a guideline. What the adapter does with its output is specified in
[design/report-adapter-spec.md](design/report-adapter-spec.md).

```
TypeScript  SubprocessReportReader  ──stdin: {"text": ...}──►  python3 -I -B sidecars/report-reader/reader_cli.py <engine-dir> process
                                    ◄──stdout: {"packet", "projection"}  (canonical JSON, validated strictly)
                                                                   └─► imported engine.py (+ its own 2 s worker deadline), unmodified
```

| Piece | Where |
| --- | --- |
| The engine (not ours, byte-identical, never edited) | `knowledge/lab-report-reader/v2-handoff/engine/` (provenance: `ORIGIN.md`) |
| The wrapper (ours, about 60 lines) | `sidecars/report-reader/reader_cli.py` |
| The TypeScript interface, runner and result schemas | `apps/backend/src/services/report-reader/` |
| The pinned build the repository accepts | `pinned-reader.ts` (`PINNED_READER`, `PINNED_POPPLER_VERSION = 26.03.0`) |
| Hand-written expected output for the twelve captures | `tests/report_reader/golden.json` |

## The engine is optional

The engine, its twelve development PDFs with captured text, and the Python wrapper are **not part of the public repository** (their provenance is still with counsel). A checkout without `knowledge/lab-report-reader/` and `sidecars/report-reader/` therefore has to work:

- **Pipeline off (the default):** nothing needs the engine. The routes answer 503 `PIPELINE_DISABLED`; the port, the wrapper class, the adapter, the lookup and the ledger code are all there and tested with stand-ins.
- **Pipeline on, engine absent:** the app refuses to start with a message that names the missing paths (`assertReaderEnginePresent`, run when the reader is built).
- **Tests:** the 5 spec files that test the engine itself are skipped, and the skip is announced (`[jest] ENGINE ABSENT: skipping 5 specs that need the report-reader engine`). There were 20 until 2026-10-27: spec 004 moved 15 onto the public fixtures and the stand-in, 8 that already passed (slice 1) and 7 that needed fixtures D03 to D07 and D09 to D12 (slice 3). The marker is deliberately not `NOT RUNNING`: CI refuses every `NOT RUNNING` line (a service tier that did not run its database or S3 specs), and an absent engine is a permanent property of this repository, not a missing service. The list is `apps/backend/test/helpers/reader-engine-specs.json`; `reader-engine.spec.ts` fails if it names a file that is gone or if a new spec names the engine paths or the lookup helper without being listed. None of them holds a test that passes without the engine: the wrapper's own tests (deadlines, the process-group kill, the output cap, refusals, logging) are in `subprocess-report-reader.wrapper.spec.ts`, which runs in CI. CI keeps the list honest: after the PostgreSQL tier, `scripts/check-without-reader.sh --measure --listed` runs the listed files without skipping them and fails the job if one of them passes (it should leave the list) or a `partialSkip` count no longer matches. A spec that needs the engine but is not listed fails the tier itself. Each spec chooses its reader and fixtures by name, never by whether the engine is in the checkout (spec 004, slice 2): pipeline specs use the public fixtures and the test stand-in by default, and a listed spec that runs the engine passes `readerEngine: true` to `createTestApp` and reads `engineFixtures` from `test/helpers/lab-pipeline.ts`. `reader-engine.spec.ts` fails if such a spec is not on the list, or if a test helper checks for the engine again.
- **Where the 5 run:** nowhere in hosted CI. No CI job has the engine, so every run on GitHub skips them. They test the engine itself, so they run only on a maintainer's machine that holds the private engine, and only when someone runs them by hand (below). Nothing schedules that run, and a failure there reaches nobody. [Spec 004](../specs/004-reader-stand-in-coverage/spec.md) moved every other engine-gated spec into CI. The last run with the engine is recorded here (it covered all 20 that were listed then):

  | Date | `main` | Result |
  | --- | --- | --- |
  | 2026-10-27 | `1ac50b8` | 19 of 20 files passed (560 tests). `test/ledger-watch.e2e-spec.ts` failed 2 of 8: the 60 s boot-walk jitter from #32 (2026-10-24) outlasted the 5 s test timeout. It had passed before #32 and was never run after it. Fixed on `fix/ledger-watch-boot-jitter`. Outside the 20: with the engine present, `test/evaluation-request-worker.e2e-spec.ts` (#82) fails 1 of 13, because `FIXTURES` in `test/helpers/lab-pipeline.ts` switches to the engine's fixtures and the spec expects a drug only the public D01 has. Without the engine it passes 13 of 13. |

  To run them: copy `knowledge/lab-report-reader/` and `sidecars/report-reader/` from the private source into the checkout, start a PostgreSQL 16 server (some of them skip themselves without one; see `docs/database.md`), then from `apps/backend` run `TEST_STORAGE=postgres TEST_DATABASE_URL=<url> npx jest $(node -p "require('./test/helpers/reader-engine-specs.json').specs.join(' ')")`. The `[jest] ENGINE ABSENT` line must not appear. Never stage the two copied directories: they are not ignored, so add files by path.
- **What runs without the engine:** `application-recovery.pg-spec.ts`, which CI's evidence gate needs (every service profile must produce its `application-recovery` metric), runs on **public synthetic fixtures** (`data/fixtures/lab-reports`, ids D01 to D12 that match the hand-written oracle `tests/report_adapter/golden.json`; see the README there), as every pipeline spec now does, and a **test stand-in reader** (`apps/backend/test/helpers/stand-in-reader.ts`). The stand-in builds the packet the real reader's contract requires, which the real adapter re-derives and checks, so the adapter, the rules engine, the records and the recovery path are tested end to end. It says nothing about the real reader or about real PDF extraction; `test/stand-in-reader.spec.ts` runs it through the adapter and the engine against the oracle, with controls that a tampered or foreign packet is refused, and checks that nothing in `src/` imports it.
- **Proof:** `scripts/check-without-reader.sh` renames the two directories, runs the backend suite, and puts them back; in a checkout that never had them (the public repository, CI) it renames nothing. `--listed` (with `--measure`) runs only the listed files, as CI does. `--measure` runs everything *without* skipping, finds the files that fail, and compares them with the list (`--write` rewrites it). It also runs the browser job's `launcher-cors` test (needs a Python with the pinned Moto: `LOCAL_MOTO_PYTHON`), because that test loads the review launcher outside Jest, and says `NOT RUN` when it cannot. A stand-in does not prove this: the directories really are absent.
- **Local review demos** (`scripts/local-review/`): the three `verify-*` scripts read a capture PDF directly and say so when the fixtures are missing. The launcher (`start.cjs`) is left alone on purpose: the browser job's `launcher-cors` test loads it, and it must keep working in a checkout without the engine (the API it starts then refuses with the start message above).

## What the runner guarantees

- **Bounded input:** a text over 200 000 UTF-16 units is never sent (held `source-limit`); the engine applies its exact
  limit of 100 000 Unicode scalars.
- **Bounded time:** an 8 s deadline per read (the engine has its own 2 s parse deadline inside it). At the deadline the whole
  process group gets SIGTERM, and SIGKILL one second later, so the engine's worker cannot outlive the call. As a backstop for a
  caller that has died, the wrapper arms `signal.alarm(10)` and ends itself.
- **Bounded output:** more than 6 MB of stdout kills the process and holds. Output that is not valid JSON, or whose shape is
  not the expected one, is held (`worker-error`) and never passed on.
- **No shell, minimal environment:** only `PATH` and `PYTHONDONTWRITEBYTECODE` reach the process: no `PYTHONPATH`, no
  credentials, and no bytecode written into the imported engine directory. A test fails if run residue appears there.
- **Every failure is a `held` result, not a throw:** `source-limit`, `source-time-budget` or `worker-error`.

## What is logged, and what never is

Logged on any failure: the reason code and cause, the exit code, the signal, the **size** of stderr, the duration, and the
text length. When the wrapper fails it prints one line naming the exception class and `name:line` frames (never a message);
that line is passed to the log only after each part matches a strict pattern. **Never logged: the report text, spans,
parsed values, or any other stderr content.** A test feeds a process that echoes its input to stderr and checks that none of
it reaches the log.

## Running it by hand (development only)

```bash
E=knowledge/lab-report-reader/v2-handoff/engine
printf '{"text":"CYP2C19: diplotype *1/*2; result Intermediate Metabolizer"}' | PYTHONDONTWRITEBYTECODE=1 python3 -I -B sidecars/report-reader/reader_cli.py "$E" process
PYTHONDONTWRITEBYTECODE=1 python3 -I -B sidecars/report-reader/reader_cli.py "$E" bindings     # must equal PINNED_READER
```

Do not run the helper scripts inside the imported engine directory (see `ORIGIN.md`).

## The adapter (next step after the reader)

`apps/backend/src/services/report-adapter/` turns the reader's output into the engine's input, exactly as
[design/report-adapter-spec.md](design/report-adapter-spec.md) (as amended 2026-10-08) says, or holds the whole report.
Nothing calls it yet either; it is wired to an endpoint in the records slice.

| Piece | File |
| --- | --- |
| The orchestrator: checks in the order of the specification, then the mapping | `adapt-report.ts` |
| One occurrence to engine input (spec section 5.2), and repeated genes (section 5.4) | `adapt-occurrence.ts` |
| Packet integrity and disjoint evidence, recomputed and re-derived, never trusted | `packet-checks.ts` |
| The seven-token unavailable matcher (R06), pinned to Unicode 16.0 | `unavailable-matcher.ts` |
| The reader's canonical JSON, to recompute packet hashes | `canonical-json.ts` |
| Report-level hold codes, fixed messages and reviewer actions | `hold-codes.ts` |
| Append-only, asynchronous capture acceptance (in-memory until the records slice) | `capture-acceptance.ts` |
| Test-only knowledge using the real gene symbols (refused in production) | `data/fixtures/knowledge/test-only-reader/` |
| Hand-written expected output for D01 to D12 | `tests/report_adapter/golden.json` |

A held report produces no drug results. Nothing in a hold or in the audit trail contains text from the report.

## The pipeline routes (slice 5B-3.2b; synthetic, non-production)

With `LAB_REPORT_PIPELINE=enabled` (never in production, PostgreSQL only) a report that was uploaded as `lab-pdf` can be captured, reviewed and evaluated:

| Route | Who | What |
| --- | --- | --- |
| `POST /reports/:id/capture` | clinician, reviewer, admin | Fetches the **pinned version** of the PDF, re-hashes it, runs the text runner, stores the text, and records a capture. 201 new, 200 the same text again |
| `GET /captures/:id` | everyone signed in | The capture and its latest decision. Never the text, a storage key or who made it |
| `POST /captures/:id/decision` | reviewer | Accept or reject, with an optional note (kept in `event_notes`, shown only as a digest) and an optional `requestId` (UUID): repeat a request you cannot be sure went through with the same id and the decision already recorded under it is returned (201) instead of a second one being made; the same id with another decision or note is 409 `request-id-reused`. The hash and Poppler version are copied from the capture |
| `GET /reports/:id/download-url`, `GET /captures/:id/text-url` | clinician, reviewer, admin | A short-lived link to one version of one file (the PDF's pinned version; the text after its hash was re-checked) |
| `POST /reports/:id/evaluations` `{captureId, acceptanceId}` | clinician, reviewer, admin | Runs the reader, the adapter and the engine on an accepted capture and stores the result with its ledger event. 201 new, 200 the same evaluation again |
| `GET /evaluations`, `GET /evaluations/:id` | everyone signed in | Stored evaluations (list: paginated `data/meta`, no engine inputs), with their correction history, derived `state` and `current`. `?current=true` keeps each report's current evaluation (its newest, if active). Always `clinicalUse: "not-approved"` and `actionable: false`. In the detail, each result carries `id` (its stored row, already in the ledger record) and `ordinal` (its position from 0), so a later record can name one exact result (spec 006, D01a) |
| `POST /evaluations/:id/corrections` | reviewer | Retract, reinstate or supersede an evaluation. The evaluation itself is never changed. See below |
| `GET /notes/:id` | clinician, reviewer, admin | The text of a note (a decision, correction or dispute note), or the tombstone once redacted. The only route that returns a note body |
| `POST /cell-disputes` `{guidelineId, locator, note, requestId?}` | reviewer | Dispute one cell of a loaded guideline. The version and the file's content hash are read from the loaded knowledge, never supplied. `requestId` (UUID) is optional: repeat a request you cannot be sure went through with the same id and the dispute already raised under it is returned (201, with its status now, so a dismissed one is not shown as open) instead of a second one; the same id with another cell or note is 409 `request-id-reused`. Without an id a repeat is a new dispute |
| `POST /cell-disputes/:id/decision` `{decision, evidenceNote}` | reviewer | `upheld` or `dismissed`, final, by someone other than the person who raised it; the evidence is required |
| `GET /cell-disputes`, `GET /cell-disputes/:id` | everyone signed in | Disputes with `status` (`open`, `upheld`, `dismissed`) and `inForce`. List: paginated `data/meta`, optional `status` filter. Notes appear only as digests |
| `GET /ledger/verify?full=` | admin | Checks the record log of the caller's own tenant now (from the latest checkpoint, or the whole chain with `full=true`) and records a checkpoint on success. The answer names kinds of failure and sequence numbers only. A `failed` answer stops this process writing records until a restart. 503 `PIPELINE_BUSY` + `Retry-After` while another check runs. See [ops/ledger-watch.md](ops/ledger-watch.md) |

**Review list pagination.** `GET /evaluations` and `GET /cell-disputes` accept `page` (default 1) and `pageSize` (default 20, maximum 100) and return `{ data, meta: { page, pageSize, total, totalPages } }`. Filters apply before paging; totals count all matching tenant records, even on an empty page. Results are oldest-first by stored sequence. Internal clinical dispute checks always read the complete set. The separate dispute-impact route retains its `limit/afterSeq` cursor. See [verification and limits](verification/phase2-review-pagination.md).

**Corrections** (`POST /evaluations/:id/corrections` `{kind, reasonCode, previousCorrectionId?, replacementEvaluationId?, note?}`): `retraction`
("do not rely on this"), `supersession` (replaced by a newer, active evaluation of the same report), `reinstatement` (an earlier retraction was mistaken;
by someone other than the retractor). The reviewer names the correction they saw last (`previousCorrectionId`); a stale or missing one is 409
`stale-chain`. Other refusals are 409 with a `details[].reason`: `invalid-transition`, `self-reinstatement`, `bad-replacement`; two reviewers acting at
once cannot both succeed (the loser is told to reload). `clinical-review-disagrees` needs a note. Only a reviewer corrects; an administrator alone
cannot. After a correction the evaluation reads back unchanged except for `state`, `supersededBy`, `corrections` and `current`. **`current` is the
newest evaluation of a report if it is active, and otherwise none: if the newest is retracted, an older still-active one is NOT promoted** (spec section 22;
a reinstatement, or a fresh evaluation, makes one current again).

**Disputes and the overlay.** A dispute names a cell of a guideline file by id, version, the file's **content hash** and a locator (table, row, optional
column). While it is open or upheld, the **next** evaluation of any report in that tenant holds that cell (`cell-disputed`, its citation and **no
wording**) and evaluates everything else normally. The overlay can only tighten: a cell that is not `verified` in the file is left as it is, so a
dismissal never makes anything shown. A dispute about an older file (different hash) or version has no effect, which is how a corrected, re-signed
file lifts the hold. The evaluation's `knowledgeSetId` is then an effective id derived from the base set and the cells held (it equals the base id when
none were), and the stored binding records `overlay` (`overlay/1`, the base id and the cell keys) so the set can be rebuilt. Because the effective
knowledge differs, repeating a request after a dispute is a **new** evaluation (201), and after a dismissal it is the original one again (200).
Raising or deciding a dispute never changes a stored evaluation; correct an earlier result, if it needs it, with a correction.

**A dispute that appears while an evaluation is being made is never missed.** The evaluation is built from the disputes it read (their ids are its
*basis*). Inside the storing transaction, **after** the ledger lock is held and as its own statement under READ COMMITTED, the repository checks that
no active dispute is outside the basis; if one is, nothing is stored and the service evaluates once more with the new set (the reader is not run
again). If it changes again, 409 `dispute-changed` ("try again"). A held evaluation needs no basis, and a replay of a stored evaluation is returned
before this check. See spec section 20.

**Whoever accepts** is not the report's creator, the person who asked for the first upload link, the person who completed the upload, or the
person who captured it (409 `self-review`; a rejection is open to any reviewer).

**An evaluation is refused before the reader runs, and nothing is stored, when:** the decision named is not an acceptance
(`capture-not-accepted`), a later decision about that capture exists (`stale-acceptance`: always 409, even if the result exists; read history
with GET), the report's patient link is not verified for the file it holds now (`patient-link-unverified`, M2.1b: a second person must record that
this file belongs to its patient, see "Patient link" below; the check is repeated inside the storing transaction), the stored text is no longer the captured text (`text-hash-mismatch`), or the ids do not belong together (`mismatch`; unknown or foreign
ids are 404). **A dispute no longer refuses an evaluation** (until slice 5B-3.3b any dispute in the tenant did, `dispute-active`): the disputed
cell is held and everything else is evaluated; see "Disputes" below.

**When the reader does not give a usable answer:** `source-limit` and `candidate-or-frame-limit` are facts about the text and are stored as a
`held` evaluation. `source-time-budget` and `worker-error` are operational: 503 `READER_UNAVAILABLE` with `Retry-After: 30`, **nothing is stored
and no key is consumed**, and the same request works once the reader does. A repeating failure shows in the log as a reason code, never as a record.

**Capacity:** at most `LAB_REPORT_MAX_CONCURRENT_READS` (default 2) reads at once **in this process**; more are turned away at once with 503
`PIPELINE_BUSY` and `Retry-After: 5`, nothing queued. This is not a deployment-wide or per-tenant limit. No database transaction is held while the
reader works. A caller who gives up does not cancel the read; it finishes and is stored once.

**What an evaluation records:** the knowledge set id, the build (`BUILD_VERSION`), the capture and decision it relied on, the adapter's source
binding, `scope: "synthetic-test-only/1"` and the SHA-256 of the recorded set the text runner answers for, all inside the stored binding and
therefore inside the ledger event. The engine takes no population or drug-context input; none is invented.

**Rate limits.** Every route is rate limited (per address before sign-in, per person and route class after): a request over the limit is refused with **429 `RATE_LIMITED`** and a `Retry-After`, and
nothing is read or stored. Evaluation, capture, the file links and `GET /ledger/verify` are the expensive class (10 a minute per person by default). See [ops/rate-limiting.md](ops/rate-limiting.md).

**When the record log fails verification** every route above that writes a record answers **503 `LEDGER_COMPROMISED`** (no `Retry-After`; nothing stored; an
evaluation is refused before the reader runs) and `/ready` fails on `ledger`; reads still work. Only a restart after an investigation clears it
([ops/ledger-watch.md](ops/ledger-watch.md)).

**Configuration when enabled** (the application refuses to start without each): `LAB_REPORT_FIXTURES_DIR`, `KNOWLEDGE_DIR`, `BUILD_VERSION`, `LEDGER_VERIFIER_DATABASE_URL`; the
reader must be the pinned build (`verifyPinned()` at start), the knowledge must load, and the bucket must keep versions. Nothing is loaded or
started while the pipeline is off, and every route then answers 503 `PIPELINE_DISABLED` without touching anything.

The text runner is a **recorded-text substitute**: it recognises only the twelve development PDFs by the SHA-256 of their retrieved bytes and
returns their stored text. It says nothing about real PDF extraction, which needs the pinned Poppler binary and is a separate slice.

## Known limits

- The reader's registry names two genes, CYP2C19 and CYP2B6. A report that mentions anything else is held (`unaccounted-text`).
- D08 (monospaced two-column overflow) is held by design: Poppler's `-layout` capture turns 2, 3 and 4 character gaps into
  three spaces, so the evidence is gone from the stored text. Recovering it needs coordinates, which is the separate,
  unapproved experiment (5B-2b).
- The adapter's unavailable-value matcher needs a runtime with **Unicode 16.0** data (`process.versions.unicode`), which
  Node 22.22.0 has; it refuses to load otherwise. CI pins that exact Node release (docs/ops/ci-cd.md). Developers on another
  Node release will see the adapter's tests fail to load, by design.
- Poppler 26.03.0 is a version pin (a constant the adapter checks against the capture record). The production image and the
  PDF-to-text runner arrive with hosting and the records slice.

## Finding evaluations that cited a disputed cell

`GET /api/v1/cell-disputes/:id/evaluations` (clinician, reviewer, admin) accepts `limit` (1–100, default 50) and `afterSeq` (decimal sequence, default 0). The stored dispute supplies the cell identity. It lists historical evaluations, including corrected ones, with exact-file versus historical-identity-unverified matches and whether wording was exposed. Known different file hashes are excluded. A page may have no entries and still have a continuation cursor; follow it until null. It never changes an evaluation. See [the contract and limits](clinical-validation/cell-usage-listing.md).

## Patient link (M2.1b)

A report names a patient only because someone chose that patient when registering it. Before anything is evaluated, a **second person** records that the
report's exact file version belongs to that patient ([design note](design/plans/m2-1b-identifiers-and-patient-link.md)).

| Route | Roles | Notes |
| --- | --- | --- |
| `GET /reports/:id/patient-link` | clinical read | `state` `unverified`, `verified` or `rejected` for the file the report holds now; `staleDecision` is true when the newest decision was about an earlier file |
| `POST /reports/:id/patient-link/decisions` | `clinician`, `reviewer` | Three shapes: `{decision: "verified", method: "identifier-match", system, value}` (the identifier read off the report, matched against the patient's registered ones; a mismatch is 409 `identifier-mismatch` and records nothing), `{decision: "verified", method: "person-confirmed", basisCode}` (the weaker method) and `{decision: "rejected", method: "person-confirmed", basisCode}`. 201 for a new decision, 200 when the newest decision about this file already says the same (also when the same request arrives twice at once: decisions about one report queue on a per-report lock, so the second answers 200 and no second row is made) |

Refusals: `self-review` (409) for the person who registered the report, asked for its first upload link or completed the upload; `not-uploaded` (409);
`source-changed` (409) when the report changed while deciding; 403 for a role that may not decide (an administrator alone, a reader). Another
organization's report is 404. Both routes are pipeline routes (503 while the pipeline is off). **Quarantine (M2.1c-1).** A `rejected` decision about the file the report holds now quarantines the report: its evaluations stop being `current` (`GET /evaluations?current=true` leaves them out), and every evaluation read carries `advisory.patientLink` (`verified`, `unverified` for no decision for the current file, which includes evaluations made before the link existed, or `rejected`). `GET /patient-link/quarantine` (role `reviewer`, pipeline route, paged) lists quarantined reports that still have an active evaluation, with the coded reason and the evaluation ids; a reviewer retracts each with the existing `wrong-patient` correction, and a report leaves the list when none is active or the link is verified again. Nothing is corrected automatically, and a report cannot be re-pointed to another patient: upload it again under the right one. Identifiers themselves are registered on the patient
(`/patients/:id/identifiers`, [patient identifiers](ops/patient-identifiers.md)).

## Duplicate patients and merges (M2.1c-2)

[Design note](design/plans/m2-1c-2-duplicates-and-merge.md). A patient-identifier collision (`409 identifier-in-use`) leaves a possible-duplicate flag; a person proposes a merge and a different person decides it. The records are ledger records, so merge routes answer 503 while the ledger is absent (in-memory mode); the duplicate list works either way.

| Route | Roles | Notes |
| --- | --- | --- |
| `GET /patient-duplicates` | clinical read | Pairs flagged by a collision and not yet reviewed (a declined merge dismisses a pair); paged; no identifier or digest |
| `POST /patient-merges` | `clinician`, `reviewer` | `{kind: "merge" or "unmerge", sourcePatientId, targetPatientId, reasonCode}`; the reason must go with the kind. 409 `merge-<reason>` for a pair the graph cannot take, `merge-proposal-pending` for an undecided duplicate |
| `POST /patient-merges/:id/decision` | `clinician`, `reviewer` | `{decision: "approved" or "declined"}`; 409 `self-review` for the proposer and for a proposal already decided differently; the graph is checked again at commit |
| `GET /patient-merges`, `GET /patient-merges/:id` | clinical read | History newest first, filterable by state, with the decision |

An administrator alone has none of these. Reads: `GET /patients` hides merged-away patients unless `includeMerged=true` and shows `mergedInto`; `patientId` on reports, evaluations and recommendations means the whole group; `POST /reports` and `POST /patients/:id/identifiers` on a merged-away patient are 409 `patient-merged`. **A patient other records were merged into cannot be deleted** (`DELETE /patients/:id` answers `409 patient-has-merged-records` until the merge is undone), so a merged-away record is never left hidden behind a patient that is gone.
