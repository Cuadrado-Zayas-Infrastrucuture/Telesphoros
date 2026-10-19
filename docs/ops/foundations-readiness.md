# Foundations readiness: state activation and synthetic rehearsal

**Offline preparation only. No AWS access, backend initialization, spending or
deployment is authorized by this page.** The founder will supply account, budget
and state decisions separately. Source wiring and CI are implemented; live
permissions, custody, locking, recovery and AWS acceptance remain unverified.
Historical statements that an account or state target is empty are not inventory.

## Decisions before AWS access

Record the decisions privately; do not commit real account configuration, tester
contact details, credentials, state or saved plans.

| Decision | Required answer / current boundary |
| --- | --- |
| Account and window | Account ID, primary Region, staffed execution window and current credit/free-plan terms. Earlier closing dates are historical, not verified entitlements. |
| Operator and owner | Founder-run session, existing MFA-protected profile and durable IAM role/user ARN, plus identity-recovery custody. The bootstrap creates no identity; a missing owner needs separate preparation. |
| Cost | Total USD ceiling, maximum runtime, alert thresholds/recipient, response owner and allowance for retained state and any drill resources. Price the actual plan before each apply; do not assume credits cover it. |
| State | Exact global bucket name, synthetic state key, historical retention days, approved encrypted local working storage and independent bootstrap/state backup custody. Default workspace only; never share production state. |
| Deployment gate | Resolve the BAA/manual-rehearsal issue below. No exception is selected by this documentation change. |
| DNS and mail | Carry forward `app.staging.telesphoros.app` and `api.staging.telesphoros.app` unless Jan changes the decision; confirm Cloudflare operator, Cognito prefix, SES sender, verified sandbox recipients and alarm inbox. Keep the tester roster private. |
| First startup | Approve the documented initial service failures and a bounded troubleshooting window, or request a separate service-hold source change first. API and worker counts currently require at least one. |
| Recovery and end state | Select real RDS restore-drill coverage and its budget. Decide application teardown or a keep owner/expiry/budget. Preserve the independent state bucket/key/history and bootstrap records in either case. |

[AWS Budgets notifications can lag charges](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html):
an alert is not a hard spending cap. Include cleanup time and retained infrastructure
in the allowance. [SES sandbox status is per Region](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html);
verify sender/recipient eligibility in the chosen Region before invitations.

## Unresolved deployment gate

The [Terraform README](../../infrastructure/terraform/README.md) requires an
executed BAA before any main-root apply. The original [FD-7 proposal](../design/plans/fd7-staged-synthetic-deploy.md)
describes a synthetic rehearsal while the BAA is pending. The latter is a proposed
scope, **not a waiver of the first-apply gate**. Before apply, either satisfy the
gate or obtain and record a separately reviewed founder decision explicitly
defining a synthetic-only exception. No real patient data or clinical processing
is permitted by this rehearsal, regardless of BAA status. This page grants no
legal or compliance acceptance.

[FD-6 deployment automation](deployment.md#intended-flow-to-be-built-after-the-decisions-below)
is a separate future workflow with OIDC and protected approvals. FD-7 proposes a
manual founder-run session; automation approval does not exist and manual execution
still needs its own authorization and the gates above. This PR neither creates
roles nor approves the manual session.

## Order and approval boundaries

Use the detailed [state activation runbook](terraform-state.md),
[saved-plan review](staging-plan-review.md), [task runner](staging-rehearsal.md),
[image push](image-push.md) and [frontend publish](frontend-publish.md) instructions
only after their live gates are met. Approval of one stage does not approve later
stages or an unseen saved plan.

| Stage | Required evidence and stop point |
| --- | --- |
| Read-only inventory | Separately authorize account access. Verify caller/owner, Regions, billing/quotas, existing resources and state ownership/lineage. Inventory local state/cache privately before init. Stop on an unknown or conflicting target. |
| Bootstrap plan/apply | Review the independent state-root plan and cost: bucket/key/configuration only, no application resources. Apply only the approved saved plan; retain protected local bootstrap state and its independent backup. |
| Backend acceptance/activation | Review a bounded isolated probe procedure and costs first; see below. Match the descriptor's six effective values, default workspace and approved owner; reject CLI overrides. Real init needs separate approval. Existing state/cache changes require a separate migration decision, not automatic `-reconfigure` or `-migrate-state`. |
| A: foundations + API edge | Synthetic/staging, API hosting on, web off, no image. Review/check/apply the actual saved plan. Add API certificate validation CNAMEs while apply waits. No services exist yet. |
| B: web | Plan against A's real state; review/check/apply the web additions. Add web certificate validation CNAMEs while apply waits; obtain them from ACM, not end-of-apply outputs. |
| Image and C: compute | Green image CI on the clean source commit; build/rehearse linux/amd64, push immutable tag and resolve the registry digest. Populate the two digest-key secrets privately. Review/check/apply C with only the four allowed ECR policy transitions plus expected creations. Task definitions and both services appear together. |
| Provision/start/publish | Expect initial task failures until logins/schema exist; observe rather than claim circuit-breaker recovery. Provision logins, migrate, require no pending migrations, verify grants, seed synthetic tenants/members/patients, restart API/worker, then dry-run and approve publication/staging traffic changes. |
| Acceptance | Record actual auth/TLS/CORS/intake/tenant-denial/worker/alarm results. Forced alarm states prove notification delivery; real event/filter checks are separate. RDS recovery remains unproven unless the selected real restore drill passes. |
| Teardown or keep | Review exact destroy plan, loss/rebuild scope, retained evidence and bucket-version inventory before approval. Follow the cleanup boundary below. Keeping requires an owner, expiry and continuing budget. |

The data plane uses one primary Region without off-site replication under
`synthetic`. Web hosting also uses global CloudFront and its ACM certificate in
`us-east-1` ([source](../../infrastructure/terraform/web.tf),
[AWS requirement](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)).
Do not mistake that certificate for unexpected backup infrastructure. Other
unapproved Regions/resources remain a stop.

## State probe preparation still required

The root's mocked policy tests do not establish live IAM, SCP/boundary, KMS,
concurrent-lock or recovery behavior. Before authorizing probes, prepare a reviewed
procedure using disposable, isolated state with the same exact-path policy contract.
Name its resources/owners, expected allow/deny outcomes, two-client lock/release
sequence, historical-version recovery, native exit capture, costs and retirement.
That procedure is not supplied or executed by this documentation change.

Do not test destructive refusal requests or bad writes against authoritative
state, add arbitrary canary paths to the protected backend, reuse its state lineage
for a scratch fixture, or weaken policies/`prevent_destroy` to make a test or its
cleanup work. On the actual backend, verify normal state binding and locking
without destructive fault injection. Unknown lineage, permission/lock failures or
lost custody stop writers; force-unlock, state deletion, key recreation and
automatic backend migration are not repairs authorized here.

## Hosted acceptance follows current application behavior

The normal production frontend has `/reports/upload` and no `/reports` dashboard
([route gates](../../apps/frontend/src/app/routes.tsx)). It selects an existing
synthetic patient; seed one through authorized APIs before testing. Upload bytes
go through [validated API intake](../../apps/frontend/src/lib/api.ts), not browser
presigned S3 uploads. Test accepted VCF/JSON, malformed input, interruption/reload
recovery, tenant/member denials, stored version/checksum and the worker's real
verification result. Exercise authorized retrieval through the API independently;
do not promise a dashboard journey this hosted build does not expose.

Keep development routes and `LAB_REPORT_PIPELINE` disabled. Check the live CSP,
API CORS, TLS/HTTP refusals, sign-in/MFA, invitations/reset/logout, deep links,
missing assets, denied anonymous storage access and staging redirects. Verify
all actual deployed alarms, including the four worker alarms, with receipt of
notifications and separate representative real-event/filter evidence. Never paste
tokens or signed URLs into shared evidence. [Capabilities](../product-capabilities.md)
and [worker checks](jobs.md#deployment-m23c-written-never-applied) define the scope.

## Cleanup boundary

Application destruction is a deliberate synthetic-data loss operation, not a
traffic rollback or production rollback strategy. Before it, stop writers and
preserve approved evidence/backups outside the disposable environment. The written
blast-radius review must name the account/resources, what is lost, what can be
rebuilt/restored, and what remains retained; obtain approval of that concrete plan.

The [web bucket](../../infrastructure/terraform/web.tf) is versioned with
`force_destroy = false`; publishing deliberately keeps old assets. Inventory all
pages of versions, delete markers and unfinished uploads, then explicitly approve
emptying that exact synthetic bucket before destroy. Removing current keys alone
does not empty a versioned bucket ([AWS emptying guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/empty-bucket.html)).
Do not change the resource protection or apply this cleanup to the state bucket.
The other synthetic buckets' GOVERNANCE-lock removal remains a live-provider test;
review scoped bypass/version-delete permissions and the exact cleanup procedure.
Never assume `force_destroy` proved it or relax policy after a refusal.

Restore only approved staging traffic records from the saved DNS baseline; keep
certificate validation and mail records. Confirm deletion/residual cost with
complete inventories, including RDS-created log groups, versioned buckets,
CloudFront and pending KMS deletion. Preserve state bucket/key/history and protected
bootstrap records; verify they remain readable. A keep decision needs the same
explicit residual inventory, owner, deadline and cost allowance.
