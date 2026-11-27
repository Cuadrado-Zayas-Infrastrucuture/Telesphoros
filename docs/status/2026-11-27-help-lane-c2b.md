# Spec 053 slice C2b: the help lane in apps/ai-service, dormant

Date: 2026-11-27

The second of C2's three pull requests ([plan](../../specs/053-help-chat/plan-slice-c2.md),
[help lane](../../specs/003-llm-harness/help-lane.md)). It adds `apps/ai-service/src/help/`:
- **`runHelpAnswer`.** It runs the curated engine first. A question the rule refuses, one with no good match, or one with no signed
  article never reaches the model. Otherwise it makes one call, with no repair. Any failure shows exactly the curated answer: a port
  error, the deadline, unknown usage, a broken reply, the model's out-of-scope flag (which becomes the refusal) or any check on any
  sentence. A released answer carries the label and the cited articles' own links.
- **The prompt.** It is built only from the template, the screen, the roles, the chosen signed articles with their glossary entries, and
  the question, which is fenced.
- **Checks HC1 to HC6.** Each is a pure function with a broken copy.
- **The registry.** The help task is in the task registry, declared `phi` with provider `baa-required` and its own checks.
- **Readiness.** `helpReadiness()` and `helpLiveReadiness()` are closed in code.
- **The receipt** holds ids, codes, counters and identity only.

Three things differ from the plan or the spec, and are said in the PR:
- **HC4** does not apply the question-shaped part of `isPatientQuestion` to answers, because an article's own sentence would trip it.
  The help-lane row is amended to match.
- **The package boundary** of `ai-service` is widened narrowly: files in `src/help/` only may import `@telesphoros/help-content` and the
  drug-list entry of `@telesphoros/shared-types`.
- **Exporting the lane** from the package entry, and bundling `help-content` into its build, move to C3. A guard already says the
  dormant harness is not exported.

Breakage entries C2-1 to C2-10 are added. The product's articles are all drafts, so Help still never calls a model. There is no route,
setting or host.
