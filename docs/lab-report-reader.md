# Lab-report reader (sidecar)

> **Not approved for production.** The imported engine is authorized for offline construction only
> (`clinical_approval: false`, `training_eligible: false`), and `SubprocessReportReader` refuses to be created with
> `mode: 'production'`. Nothing calls it yet: the adapter (next PR) and the records/API slice (5B-3) come later.
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
