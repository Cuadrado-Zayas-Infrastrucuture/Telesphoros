# Spec 003: the LLM harness, written and waiting for approval (2026-10-25)

Date: 2026-10-25

**Implemented (documentation only).** `specs/003-llm-harness/` holds `spec.md`, `plan.md` and `tasks.md` for the harness around a model that explains a verified engine result. The rule it states: the engine decides, the model explains; a model's words are shown only if code ties every claim to a field of the engine's own `shown` result, the guideline's text is always shown beside them, and every failure shows the engine text alone. The spec cites `main` `ceac298` and proposes four slices: an offline evaluation harness with the sensors and the R3 gate, the explanation contract and failure path, outcome v2 with real counters and a trace, and a Bedrock adapter behind the readiness gate. The founder chose D1 to D5 on 2026-10-25: explain only, no model-driven tools, synthetic data, a direct Bedrock client, and the founder reviews the golden cases as pharmacist.

**Plan not approved.** `plan.md` is a draft. The founder decided D6 to D10 on 2026-10-25 as recommended: no stored text, the gate inside `verify`, thresholds after slice 1, English first, counsel before readiness. No code, migration, CI file or schema changes in this PR.

**Not changed:** the engine, the knowledge files, the ledger, the synthetic kernel and its tables, Terraform, the AWS account, the BAA, and R1 to R5 in `docs/ai-safety-and-hallucination-controls.md`.

**Not verified:** the Anthropic evals guide, the OWASP list and the FDA guidance were read as summaries and are to be confirmed at the source before they are relied on. Bedrock model access for the account, the organization policy on `bedrock:InvokeModel`, and prices are unchecked. Because `specs/**` is not on the docs-only list in `.github/ci/scope.mjs`, this PR runs the full hosted pipeline.
