# One page says what is applied: docs/ops/environments.md

Date: 2026-10-30

**Implemented.** `docs/ops/environments.md` records what exists in AWS:
- one synthetic staging environment in `us-east-2` (the API and worker services, one task each, on the hand-pushed image from `888979b`), and no production;
- the switches that are off: issuer, signing and the lab-report pipeline;
- what the organization's service control policy keeps unreadable;
- when each runbook last ran for real;
- read-only commands that re-check all of this.

It was read from the account on 2026-10-30. Twenty current-state documents that said "never applied" or "nothing is deployed" now say what is true and point there. `CLAUDE.md` names the page first. The `jobs.md` deployment heading lost its "never applied" suffix, and its three links follow. Dated records keep their wording. Documentation only.

**Not established.**
- No CI check refuses stale "not applied" wording yet. That guard, and the `NOT APPLIED` headers in the Terraform files, the PR template, the constitution and the `ci.yml` comment, are a separate pull request.
- The page is correct as of its read date only.
- GuardDuty, Security Hub and the cross-Region backup copy are unknown: the organization's policy denies reading them.
