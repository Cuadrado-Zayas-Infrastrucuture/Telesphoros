# Adapt local issue triage

Date: 2026-10-25

Added `telesphoros-triage` for evidence-backed local issue/PR recommendations and AI-attributed Draft briefs. It checks existing labels, prior answers, related implementations and accepted decisions before proposing a category or disposition. Reporter claims, supplied reproduction evidence and executed checks remain distinct.

The adaptation uses current issue forms and existing glossary/ADR/planning records. It adds no tracker state machine, label mapping, rejection knowledge base, setup installer, automatic code execution, glossary edits or publication. Existing files and all 25 pinned vendor source files remain preserved. Normal repository discovery is retained.

Fixed routing baseline: 64/64. First candidate: 71/72, including all eight new requests; generic “find” wording attracted an existing CI-bottleneck request. Only that word in the new description changed to “identify”. Repaired routing passes 72/72, with all prior 64 result records and all fixed prompts unchanged. This lexical check does not establish model behavior.

All seven required local commands passed: typecheck, lint, tests, build, infrastructure tests (144/144), CI-config tests (203/203) and workflow checks (72/72 routing; 5/5 checker tests). Metadata, 37 local references/anchors, prior-skill and pinned-source integrity checks passed. Default database/S3 tiers were explicitly skipped and establish no service acceptance.

Three synthetic behavioral cases and a fixed rubric are prepared but unexecuted. Behavioral model evaluations require separate authorization before publication; no model runs or activation are established by this instruction-only candidate.
