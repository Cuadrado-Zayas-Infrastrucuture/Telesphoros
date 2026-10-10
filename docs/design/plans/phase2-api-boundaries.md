# Phase 2 API boundaries — approved first slice

Founder approved the Phase 2 closure sequence, then authorized this slice on 2026-10-09. Separate PR from fresh main; pagination and batching follow only after merge verification.

1. Reproduce API exception/request leakage using synthetic values and the actual pino logger/filter.
2. Replace raw exception logging with fixed event/status/code/requestId diagnostics; log route templates rather than request URLs. Preserve the ledger alarm log shape.
3. Derive body/query acceptance from existing Nest parameter declarations. Reject undeclared input after guards and before pipes/business logic; preserve missing/empty-object bodyless actions.
4. Check all production controller classes and their body/query/param pipes; retain strict schemas and explicit response mappers. Do not echo unknown field names in validation errors.
5. Run targeted, full backend and PostgreSQL/S3 CI tests, plus reversible defect injections; document compatibility effects and limits.

Untouched: clinical algorithms/flags, knowledge, capture, ledger hashes and append gates, database schema, auth provisioning, frontend features, infrastructure and DNS. No spend or real patient data. Endpoint callers sending ignored bodies/queries must remove them; this tightening is intentional. Fixed diagnostics trade away raw exception detail; source errors should be reproduced with synthetic data, not reintroduced into logs.
