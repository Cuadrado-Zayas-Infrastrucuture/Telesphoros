# Authorized synthetic source PDF

Approved by the founder on 2026-10-11: build from main and open one draft PR. Base: `db96b1e` (merged #70).

Reuse the existing tenant/role-authorized report download-link endpoint and its pinned object version. The local SMART reader optionally fetches this link from an explicitly configured loopback storage origin, without forwarding SMART/backend credentials. Require an exact version response, PDF content type/signature, declared size and computed SHA-256 matching the accepted capture/report; then repeat existing closing authorization/state checks. Return verified bytes in the FHIR DocumentReference, never the bearer URL or storage key. Provide an explicit synthetic PDF download in the local viewer.

No retention, clinical gate, database, backend route, infrastructure, EHR write, production data or deployment changes. Existing metadata mode remains available; configured retrieval fails closed without fallback. Founder-only production/deployment decisions remain outside scope; none is needed for this local slice.

Verify bounded/no-redirect transport, origin/version/digest/type/size/expiry refusals with success controls, actual PostgreSQL/API/versioned S3 retrieval and overwrite/missing-version behavior, UI cleanup, and existing pilot regressions. Break a new guard deliberately and confirm a test fails, then restore and rerun. Open a draft PR and stop for review.
