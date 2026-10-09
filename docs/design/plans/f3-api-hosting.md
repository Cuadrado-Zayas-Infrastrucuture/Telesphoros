# Plan F3: API hosting on ECS Fargate behind a load balancer

Status: **approved by the founder on 2026-10-09** (decisions at the end). F3a (the edge) is built in this PR; F3b (the compute) is the next PR. Terraform text only; nothing is applied in AWS, ever, by this plan.
F1 (#41) and F2 (#42) are merged; F3 reads F1's alarm topic.
This supersedes the earlier H1 plan: #39 already landed the frontend hosting (`web.tf`); this is the API half ("H2" in the docs).

## What exists and what it means for F3 (checked in the repo, not remembered)

- The API listens on port 3000 (`PORT`), serves under `/api/v1`, with `GET /api/v1/health` (liveness, no dependencies) and `GET /api/v1/ready` (503 while the database is down, migrations are pending, or the ledger check is failing). Both are exempt from rate limiting (F2).
- **Production start-up refuses** (`config/env.ts`): `AUTH_VERIFIER` other than `cognito`; `STORAGE_DRIVER` other than `postgres`; `OBJECT_STORAGE_DRIVER` other than `s3`; `DATABASE_SSL` other than `require`; missing `LEDGER_VERIFIER_DATABASE_URL`; `RATE_LIMIT_ENABLED` off; **`TRUST_PROXY_HOPS` unset**; any non-https CORS origin; and **`LAB_REPORT_PIPELINE=enabled`**. So a production-mode API cannot run the synthetic lab-report reader. See decision 1.
- The Terraform already has the database (private, SG open only to `app_security_group_ids`), the reports bucket, KMS keys, Cognito, and `aws_iam_policy.app_runtime` ("created but not attached: the role is defined where the compute is"). F3 is where that role finally exists.
- `vpc_id` and `private_subnet_ids` are inputs ("created elsewhere"). There is **no Dockerfile in the repository** and no image registry, so the image is F4's job; F3 only takes an image reference.
- `database.ts` connects with `ssl: { rejectUnauthorized: true }` and no CA setting. RDS certificates are signed by Amazon's RDS CA, which Node does not ship. **Unless the image adds the RDS CA bundle (`NODE_EXTRA_CA_CERTS`), the first connection will fail.** I have not tested this (nothing to test against); it is a must-verify item for F4's image and the first staging run.

## The shape (two PRs, each branched off `main`, F3a first)

Both use Codex's H1 pattern: a single switch `enable_api_hosting` (default `false`) and every new resource has `count = var.enable_api_hosting ? 1 : 0`, so merging changes nothing in a plan until someone turns it on. Enabling it is **not** approval to apply the rest of the root (same warning as `domains-and-hosting.md`).

### F3a. The edge: certificate, load balancer, WAF, security groups

1. **Certificate**: ACM, DNS-validated, in the primary region, for `api.telesphoros.app` (variable `api_domain`, validated to be a hostname under `telesphoros.app`). The validation CNAME is added by hand in Cloudflare, DNS-only, as for H1. Terraform waits for it; the same "read the record from the ACM console while the apply waits" note applies.
2. **Load balancer** (application): internet-facing in new input `public_subnet_ids` (at least two, different zones); **HTTPS listener on 443 only, no port-80 listener at all** (nothing to redirect: the front end calls an `https://` URL); policy `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2 minimum); `drop_invalid_header_fields = true`; `desync_mitigation_mode = strictest`; deletion protection on in production; idle timeout 60 s; **access logs off**, same reasoning as the CloudFront decision in `domains-and-hosting.md` (request lines carry record identifiers; app logs and the F1 trail cover forensics). Default action is a fixed 404 so nothing but the target group is ever reachable.
3. **Target group**: HTTP 3000, target type `ip`, health check `GET /api/v1/ready` expecting 200 (readiness, so a task whose ledger check fails or whose migrations are pending leaves rotation), interval 15 s, healthy 2, unhealthy 3, deregistration delay 30 s.
4. **Security groups** (exact, tested): ALB: ingress 443 from the internet, egress only to the task group on 3000. Task group (created here, used by F3b): ingress 3000 **from the ALB group only**; egress 443 (AWS APIs and the Cognito key endpoint) and 5432 to the database group only. The database group gets one new ingress rule from the task group (`database.tf`, one added rule; the existing `app_security_group_ids` contract stays, and its "at least one" validation is relaxed only when `enable_api_hosting` is on).
5. **WAF** (regional, attached to the ALB): AWS managed rule groups `AWSManagedRulesCommonRuleSet`, `KnownBadInputsRuleSet` and `AmazonIpReputationList` in **block** mode, plus our own **rate-based rule per address** (default 2000 per 5 minutes, a variable, backstop to F2's per-process limiter: with 2 tasks the in-app limits are doubled, the WAF is the shared ceiling). Request logging is **off** by default; if turned on later it must redact the `Authorization` header and the query string (the doc says so; not built now). I start the managed groups in **block**, and the doc says a false positive on a real route is fixed by a scoped exclusion, never by turning the group off (decision 5 if you prefer count-first).
6. Outputs: ALB DNS name (the value for the Cloudflare `api` CNAME), certificate validation records, target group ARN, task security group id.

### F3b. The compute: cluster, service, tasks, roles, secrets, logs, alarms

1. **Cluster** (Container Insights on) and **service**: Fargate, `awsvpc`, **no public IP**, tasks in `private_subnet_ids`; `desired_count` 2 in production (one per zone), 1 in staging; rolling deployment 100% minimum healthy / 200% maximum with the **deployment circuit breaker and rollback on**; health-check grace 60 s; `enable_execute_command = false` (no shell into a PHI task; break-glass for a container is a separate decision).
2. **Task definition**: 0.5 vCPU / 1 GB to start (variables; **sizing is a guess**, to be measured in staging); non-root user; `readonlyRootFilesystem = true`; stop timeout 30 s (the app has shutdown hooks); `awslogs` to the app log group; image from variable `api_image`, **validated to be digest-pinned (`@sha256:`)**, never a tag, so a deployment is exactly one reviewed artifact.
   Plain environment (no secrets): `NODE_ENV=production`, `PORT=3000`, `AUTH_VERIFIER=cognito`, the three `COGNITO_*` values from `cognito.tf`, `STORAGE_DRIVER=postgres`, `OBJECT_STORAGE_DRIVER=s3`, `REPORTS_BUCKET`, `AWS_REGION`, `DATABASE_SSL=require`, `CORS_ALLOWED_ORIGINS` (the app origin, `https://app.telesphoros.app`, from a new variable), `RATE_LIMIT_ENABLED=true`, **`TRUST_PROXY_HOPS=1`** (one load balancer, nothing in front of it; a guard test pins "exactly one proxy in front" so adding a CDN in front of the API without changing this fails the build), `BUILD_VERSION`.
   Secrets (injected by ECS from Secrets Manager, never plain text): `DATABASE_URL`, `LEDGER_VERIFIER_DATABASE_URL`.
3. **Secrets**: Terraform creates the empty secret **containers** only (encrypted with the data key). **No secret value is ever in code or state**; you put values in by hand after the logins exist (see "the login gap"). A guard test fails the build if a secret value attribute appears.
4. **Roles**: *execution role* (pull from the registry, write its own log group, read exactly the three secrets, decrypt with the data key through Secrets Manager only). *Task role* = the existing `aws_iam_policy.app_runtime` and nothing else. The existing infrastructure guard (no principal gets `s3:DeleteObjectVersion`) must keep passing; I will extend it to cover the new roles.
5. **One-off migration task definition** (definition only, no service): same image, command `db:migrate`, secret `DATABASE_MIGRATOR_URL`, run by a person (or F4's pipeline) before a release; the service's login never migrates. The API's `/ready` stays 503 until migrations are applied, so the load balancer will not send traffic to a task that came up before its migration.
6. **Logs**: app log group, retention variable (default 365 days, floor 90), encrypted with its own key (not the data key and not F1's audit key). The application already logs without PHI by design; the doc repeats that it must stay so.
7. **Alarms into F1's `audit_alarms` topic**: **`ledger-compromised`** (metric filter on the application's structured line `"event":"ledger-compromised"`, any occurrence, treat-missing-data not-breaching); load balancer unhealthy hosts above 0 for 3 minutes; target 5xx count; running tasks below the minimum. The first one is the point of the whole watch: today it only logs.
8. Docs: `docs/ops/api-hosting.md` (what each piece does, the first-apply order, rollback, what is NOT verified), update `rate-limiting.md` (value is now 1 and where it is set), `deployment.md` (F3 done, F4 next), `ledger-watch.md` (the alarm exists), `STATUS.md`, `break-glass.md` (no change expected).

## The login gap (must be solved in the runbook, not in Terraform)

`telesphoros_app`, the verifier and the migrator logins are "provisioned outside" (`ledger-roles.md`). RDS creates only the admin user and its password secret. Nothing in the repo creates the application's login or the verifier's, so the first apply needs a documented one-time step: connect as the admin from inside the VPC, create the three logins (each in exactly its one group; the verifier **not** in `telesphoros_app`), put their connection strings into the three secret containers. I will write that as a runbook with copy-paste-safe SQL (the lesson from `pilot-ops-bedrock-preflight`: each command contains its own prerequisite). Reaching the database from inside the VPC with no bastion and no shell into tasks is itself a design question; my proposal is a short-lived one-off task from the migration task definition with the admin secret, and I will write it down for your approval inside the F3b PR rather than invent a bastion.

## Tests and verification

- New `infrastructure/terraform/api.guard.test.mjs` imported by `guard.test.mjs` (as for audit and web), each guard proved by breaking a copy and watching it fail, plus a clean control: HTTPS-only listener, no port 80, TLS policy floor, invalid headers dropped, deletion protection in production, WAF groups present and in block, rate rule present, security groups exact (no `0.0.0.0/0` into the task group or the database), no public IP, digest-pinned image validation, no secret value anywhere, `TRUST_PROXY_HOPS` equals 1, read-only root and non-root, log retention floor, alarms exist and the `ledger-compromised` filter pattern matches **the string the application really writes** (a test reads `ledger-monitor.ts` for the literal so the two cannot drift: the dead-lookup-map lesson), the switch defaults off and every resource is counted.
- `terraform fmt` and `validate` locally with my provider mirror (it works), `test:infra`, `test:ci-config`, typecheck, lint, build; CI `terraform` jobs.
- **Not verified, and the PRs will say so:** every behaviour in AWS (health checks, WAF rules, the alarm firing, secrets injection, rollback), Cognito key-fetch egress from private subnets (see decision 3), the RDS certificate chain, task sizing, cost.

## HIPAA eligibility of each service (you asked me to confirm)

I could **not** read AWS's official list: the sandbox's network policy denies `aws.amazon.com`. From search results that quote the official page: Amazon ECS, Amazon ECR, Elastic Load Balancing and AWS WAF appear, and **AWS Fargate appears limited to the ECS and EKS engines** (that is how it is used here). I could **not confirm** Secrets Manager, CloudWatch (Logs and alarms), CloudTrail, VPC/NAT, Certificate Manager or SNS; third-party guides say yes for some, which I do not rely on. The live page must be checked before the AWS BAA review. Reminder: being on the list is eligibility, not compliance, and the BAA must be executed before any real patient data.

## Decisions that were open (answers below)

1. **What does staging run?** A production-mode API refuses the synthetic lab-report reader, so a staging API that behaves like production cannot demo the reader. Recommended: staging is production-mode (so what you test is what ships) and the reader stays local-only until its production integration (R05) is planned. Alternative: staging in a non-production mode, which weakens what it proves.
2. **Does the VPC exist?** The Terraform takes `vpc_id` and subnets as inputs and has never been applied, so I don't know whether a VPC, public subnets, or egress exist. Recommended: keep the inputs and add the new `public_subnet_ids`; if no VPC exists, say so and I'll write a small optional network module as its own PR first (it must come before F3a).
3. **Outbound path for the tasks.** They need to reach AWS services and Cognito's public key endpoint. Recommended: NAT gateways (simple, roughly tens of dollars a month each at list price, **my figure from memory, not checked**), versus VPC endpoints (cheaper at low traffic, but I have not verified that the Cognito key endpoint is reachable through one, so I won't promise it). I'd start with NAT and revisit.
4. **Traffic between the load balancer and the tasks is plain HTTP inside the VPC** (TLS ends at the load balancer). It never leaves private subnets and is restricted by security groups. For real patient data a risk assessment may want it encrypted; that means TLS inside the task (a sidecar or the app). Recommended: accept for the synthetic pilot, write it in the risk register, decide before real data. Say if you want it built now.
5. **WAF managed rules in block (my default) or count-first.**
6. **Ownership of the first apply**: it needs you in the AWS account (BAA, remote state, OIDC roles are prerequisites listed in `deployment.md`); F3 does not change those.

## What I do NOT touch

Authentication and roles code, the database schema, the engine, the ledger, the front end (its friendly 429 message stays a small follow-up), the frontend hosting from #39, the break-glass role (still not created), the image and pipeline (F4: Dockerfile with the RDS CA bundle, registry, signed image, deploy workflow with OIDC, migrations run), Cognito sign-in auditing.

## Cost of waiting

None of this is urgent for the synthetic work already merged; F3 is what turns "text that validates" into "something that can run", and F4 is what builds the image it runs. Order: merge #41 and #42, then (answers to 1 to 5), F3a, F3b, F4.

## Decisions (founder, 2026-10-09)

1. **Staging:** the staging **front end runs on Vercel**; the staging **API runs on AWS in production mode** from the same Terraform (`environment = "staging"`), so the path that ships is the path that is tested. The API is not run on Vercel: the record-log watch, the in-process rate limiter and the start-up budget all assume a long-lived process. Staging uses synthetic data only. (The synthetic lab-report reader stays local-only until R05's production integration is planned.)
2. **VPC:** keep `vpc_id` and `private_subnet_ids` as inputs and add `public_subnet_ids`; no network module now. If no VPC exists at the first apply, that becomes its own PR first.
3. **Outbound path:** NAT gateways. Not created here (the VPC is external); the first-apply checklist requires confirming a NAT route from the private subnets.
4. **Load balancer to tasks:** plain HTTP inside the VPC, accepted for the synthetic pilot, to be decided again before real patient data.
5. **Firewall:** managed rule groups in block mode from the start.
6. The first apply stays gated on the prerequisites in `docs/ops/deployment.md`.
