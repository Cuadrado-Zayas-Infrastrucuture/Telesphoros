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
