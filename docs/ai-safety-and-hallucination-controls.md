# ai-safety-and-hallucination-controls

Status: only the requirements below are written. The rest of this document is still to do.

Model output is grounded in `knowledge/cpic` rules and disabled by default
(`PGX_CLINICAL_HOLD_LIFTED` must be exactly `true`). Every model needs a model
card and an evaluation gate before use.

## Requirements for any model path

These bind the first change that adds a model call. At the time of writing, `apps/` and `packages/`
contain no model client. Each requirement is written as prose and must also exist as a test that can
fail: the change that adds the model path includes, for each one, a check that was broken on purpose to
show the test goes red.

### R1. Every model task declares its data class in code, and a test holds it

- Each task declares one data class, `phi` or `no-phi`, in the code that defines the task. A task with no
  declaration does not run.
- A prompt that carries health information about one individual is `phi`, even with names and
  identifiers removed. A medication list, conditions, allergies or results for one person qualify. When
  unsure, the class is `phi`.
- A `phi` task may reach only a provider covered by a signed business associate agreement. When none is
  configured, the call refuses. It does not fall back to another provider. While the system holds
  synthetic data only, no agreement is in place and no model call may carry real patient data.
- A test fails when a task's declared class disagrees with the input sanitizers it runs or with the
  provider filter it uses, and when a new task has no declaration.
- Origin: an earlier gateway prototype labelled a task `no-phi` while its prompt held one patient's
  medication list. The provider filter applies only to `phi` tasks, so it never ran. Nothing failed.

### R2. Every output guard has a production caller, and a test proves it

- Each check on model output (grounding, evidence binding, figure checks) is listed beside the task that
  must use it. A test fails when a guard exported from the guard module has no production caller, and
  when a task skips a guard listed for it.
- A guard that cannot check what the task emits is removed, not wired in. A check on dollar amounts says
  nothing about clinical prose.
- Origin: the same prototype held an output guard that was written and unit-tested but called by no
  production code. Its tests stayed green because they called it directly.

### R3. A change to a prompt, a model or a decoding setting is evaluated before it merges

- The evaluation gate runs on the pull request that changes a prompt, a model name, a provider route or a
  decoding setting (temperature, token limits, response schema), and it is a required check on the
  protected branch. A job that runs only after the merge is a report, not a gate.
- The gate names the paths that count as such a change, and a test fails when a file that builds a prompt
  or selects a model sits outside them.
- A gate that makes no model call says so, and the document says what it does not prove. A contract check
  on committed outputs proves the scoring code and the fixtures agree; it does not show that a changed
  prompt still produces grounded text. The live evaluation that does, with its approval and cost, is a
  separate named step, and release of the changed task waits for it.
- Origin: the same prototype ran its evaluation workflow only on pushes to the main branch, so a prompt or
  model change could merge before any check had run on it. Its live evaluation was manual.

### R4. Every task's output class is declared, and free text shown to a person is checked, withheld or labelled

- Each task declares what it returns: structured fields checked against a schema, or free text. Free text
  that reaches a person must be checked against its source, withheld, or shown labelled as unreviewed
  model output. A length limit is not a check.
- The check for a class of output is listed beside the task (see R2). A task with free text and no listed
  check does not run. A test fails when a task's declared class and its listed checks disagree.
- A check that tests wording against the evidence (a term or a figure appears in the source) is described
  as that. It does not show that a claim follows from the evidence, and the document does not call it
  clinical agreement.
- Origin: in the prototype only one task had an output check, and that check compared words with the
  evidence. Five other tasks returned free text under a length limit, one of them clinical notes for a
  pharmacist whose review was described in prose only.

### R5. A stored model output has a declared retention, a purge that covers every row, and a way to erase it

- A model response or a model-written text kept anywhere (a response cache, a task outcome, a log, a trace)
  is listed with its data class (R1), how long it is kept, what deletes it, and who can read it. A `phi`
  response is not cached unless that decision is written down with those four answers, and encryption at
  rest of the stored text is one of the answers.
- The purge covers every row. A row with no expiry is a retention decision, not a default: the code either
  forbids it for `phi` tasks or a test shows it is purged.
- Erasure on request is possible for the stored text, or the text is not stored. A table that refuses
  deletion cannot hold model text that may need to be erased. The synthetic task outcome in `apps/ai-service`
  stores the released artifact text (`kernel.ts`, `simulatedArtifact`), and its table
  (`agentic_synthetic_outcomes`, migration 0029) is immutable by trigger: acceptable for synthetic text,
  and a blocker for any real text until this is decided.
- Provider-side prompt caching is a separate surface from a stored response cache. A decision names which
  one it covers.
- Origin: the prototype cached the responses of two `phi` tasks for seven days in a table whose
  `response` column held the text as plain JSON. An hourly job deleted expired rows, but a row written
  with no expiry was never deleted by it, and whether the column was encrypted or could be erased on request
  was not checked.

**Decided 2026-10-25 for the explanation harness receipts (`agentic_explain_receipts`, migration 0048).** The receipt stores no model text, so the stored-text questions above do not arise for it: it holds a keyed digest of the evidence and of the output, fixed codes and counters. Data class: derived from `phi` input (a keyed digest of one person's gene and phenotype), kept as `phi`-adjacent. Retention: 2190 days, enforced by the row itself (no role can delete a younger row). Deletion: only after that age, by the organization's purge function. Erasure on request: not by row; destroying or rotating the digest key makes the digests unlinkable. Who reads: the organization's own application login, through a function bound to its capability. Open: counsel confirms the key-destruction path before real data.
