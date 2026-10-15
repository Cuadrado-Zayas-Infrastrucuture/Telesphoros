# Delivery documentation refresh — 2026-10-14

Founder-approved Phase A documentation intention, on an independent branch from current main `4400efa`; no runtime source, CI definition, permissions, schema or infrastructure resource changes. No push, PR or deployment. F06/F07 and the existing `chore/current-delivery-status` branch remain unchanged.

## Facts checked

- PR #100 merged at 2026-10-14 19:18:06 UTC; PR #101 merged at 21:27:43 UTC. Each final PR head reports seven successful checks: verify, database-and-storage, browser, terraform, terraform-lint, secret-scan and image. Main's current commit is `4400efa`; this is not a claim that every historical main push or local fix has remote CI.
- M2.1/M2.2 source commits and M2.3a's queue commit are ancestors of #100's head. M2.3b/c are included in #101. Their old local/stacked/draft delivery labels in current status were stale. Original verification documents keep their original dated results.
- Existing T02 and L1/L2/L3 merged-state corrections from `chore/current-delivery-status` are already represented on current main. The older branch was read as a reference, not replayed or modified.
- File bytes enter through the validated attempt/raw-byte API; the legacy presigned upload routes are retired. Exact-version signed GET access exists; main's reports CORS is still PUT-only, with F07's repair separate and local.
- The frontend always mounts clinician upload, gates `/reports` on the local-storage build flag, and excludes local review/operations/interpretation from production builds. Server processing gates remain independent. Main reload recovery and older bundles do not include F06's newer scope/expiry protections.
- M1 live membership, no-store, tenant logging and security-event changes are on main. M2 queue/outbox/worker code exists; hosted provisioning, delivered alarms and operational acceptance are unverified.
- The tracked Terraform lock selects AWS 6.68.0 and archive 2.8.1; `versions.tf` constrains AWS to `~> 6.67`. Versioned required CI includes image; terraform-lint remains advisory.

## Verification and limits

The existing CI-configuration guard suite passed. Relative links in all changed Markdown files were checked against real files; whitespace and redacted staged-secret checks passed. Changed-file and source-contract checks confirm this intention is documentation-only and preserves the old audit's original command/results baseline. No builds, database/storage suites, live GitHub protection settings, AWS resources, provider policies, agreements or deployment state were inspected anew for this documentation slice.

The [capability matrix](../product-capabilities.md) records source and delivery state. Broader product workflows, clinical knowledge/extraction, real-data acceptance and deployment approvals remain separate. These corrections do not approve the entire historical roadmap.
