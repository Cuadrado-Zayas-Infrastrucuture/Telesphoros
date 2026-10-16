# F07: current-main download CORS integration

Founder-approved local integration, 2026-10-16: fresh `fix/f07-download-cors-integration` from current main `75bdc20`, carrying corrected source `47d75cd` and older-review GET parity. Do not stack on or modify F06. Preserve original F07 branches; no push, PR, Terraform apply or deployment.

Use one GET-only JSON methods/headers/exposure/cache contract for Terraform, the browser fixture, owned storage launcher and older review launcher. Deployment origins remain exact HTTPS origins; local consumers use exact loopback origins. Preserve current child environment settings and worker handoff, actual launcher capture, literal independent policy oracles, real-origin refusal/same-document success, restoration and owned cleanup. The browser fixture must disable Moto global fallback too.

Preserve current Reports selectors, bounded pagination, mobile navigation, version-pin ordering, staging/registry/publisher/task guards and newer mock assertions. Leave auth, /me, upload recovery and page/session safeguards, backend intake, roles/RLS, signed links, IAM, encryption, object retention/versioning, clinical logic, dependencies, deployment input and CI gates untouched.

Verify the main PUT baseline, source policy/consumer parity, exact origins, native pinned Terraform fmt/init-without-backend/validate/all mocked plans, both native launcher controls including setting/worker defects, desktop/mobile native PostgreSQL/Moto storage browser tests and final version pin, scratch-only browser-fixture/policy/origin defects, local operations, signed-download controls and workspace static/brand checks. Record failures and hosted limits. Freeze the final local commit before receipt-producing rehearsals. See [verification](../../verification/f07-download-cors.md).

## Separate publication preparation (2026-10-16)

F06 merged with PR #131. The fresh F07 candidate starts from main `6f2ddaa`, includes all 38 promoted origin probes and the recovery-to-download browser bridge, and retains older-review GET parity. Historical integration results above are not new-candidate passes; see the [publication verification scope](../../verification/f07-download-cors.md) and its external frozen-head results. Both source branches and the combined reference stay unchanged. No push, PR, apply or deployment.
