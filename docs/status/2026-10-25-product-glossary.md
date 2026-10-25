# Initial product and engineering glossary

Date: 2026-10-25

**Implemented.** [The glossary](../glossary.md) gives the initial product and engineering vocabulary for organizations, access, patients, reports, uploads, capture review, evaluations, corrections and the audit ledger. Each group links to the existing contracts and implementation that establish its meaning. The founder reviewed the vocabulary on 2026-10-25 and chose simple definitions, with **Replacement** for supersession and **Restoration** for reinstatement. The glossary retains the code-name mapping.

**Boundaries checked.** A report registration can exist before its file is uploaded; an upload attempt can end without commitment. A capture decision can accept or reject, despite the internal `AcceptanceDto` name. Capture acceptance and patient-link verification are separate decisions. An active evaluation can be held or non-current; retracting the newest evaluation does not promote an older active one. Rejection of the report's current patient link also leaves no current evaluation. Replacement replaces an evaluation, preserving both records.

**Scope.** Documentation only. Clinical definitions, guideline content, code/API names and behavior, schema, agent prompts and routing, infrastructure and deployment are unchanged. No ADR is needed because this records existing meanings rather than a new architecture decision.
