# API hosting (F3): ECS Fargate behind a load balancer

**Status: F3a, the edge, is written as Terraform and guard-tested. It is never applied, and it is off by default (`enable_api_hosting = false`).**
F3b, the compute behind it (cluster, service, task, roles, secrets, log group, alarms), is the next step. Plan and the founder's decisions:
[design/plans/f3-api-hosting.md](../design/plans/f3-api-hosting.md). Nothing here is approval to apply the rest of the root: the three first-apply
gates in `infrastructure/terraform/README.md` still apply.

## Where each environment runs

| | Front end | API | Data |
| --- | --- | --- | --- |
| Staging | **Vercel** (founder decision, synthetic data only) | AWS, **production mode**, from this Terraform with `environment = "staging"` | AWS, synthetic |
| Production | S3 + CloudFront ([domains-and-hosting.md](domains-and-hosting.md)) | AWS | AWS, after the BAA |

The staging API is not run on Vercel: the record-log watch (start-up check, 24-hour background walks, the in-process latch), the in-process rate limiter and
the start-up budget all assume one long-lived process. A staging API in production mode cannot run the synthetic lab-report reader (production refuses it),
so the reader stays local-only until its production integration is planned.
For a Vercel staging front end, set the staging callback and logout URLs (`app_callback_urls`, `app_logout_urls`), `reports_cors_origins` and the API's
CORS origin to the Vercel staging address; production keeps `https://app.telesphoros.app`. Whether Vercel is acceptable for a production front end that
handles real patient data is **not** decided here (the production front end stays on S3 + CloudFront).

## What F3a creates (when the switch is on)

| Piece | Detail |
| --- | --- |
| Certificate | ACM, DNS-validated, for `api_domain` (default `api.telesphoros.app`) in the primary region. The validation CNAME is added **by hand** in Cloudflare, DNS-only; Terraform waits for it (read the record from the ACM console while the apply waits; the output `api_validation_cnames` repeats it afterwards). Keep it for renewal. |
| Load balancer | Internet-facing application load balancer in `public_subnet_ids` (at least two zones). **HTTPS on 443 only: there is no port-80 listener at all**, so there is no plain-text path to redirect. TLS 1.2 minimum (`ELBSecurityPolicy-TLS13-1-2-2021-06`), invalid headers dropped, strictest desync mitigation, deletion protection in production. The default answer is a fixed **404**; only `/api/*` is forwarded to the API target group. |
| Target group | HTTP to port 3000 (the application's default `PORT`), target type `ip`. The health check is **readiness** (`GET /api/v1/ready`, expecting 200), so a task whose database is down, whose migrations are pending or whose record log failed a check leaves rotation. A test reads the application to keep the port, the prefix and the route in agreement. |
| Security groups | Load balancer: 443 from the internet in, port 3000 to the tasks out. Tasks: 3000 from the load balancer only; out only to the database (5432) and to HTTPS (AWS services and the Cognito key endpoint). Database: one added rule accepting the tasks' group. Rule resources only; nothing allows all traffic; a test names every rule and fails on an unexpected one. |
| Firewall (WAF, regional) | AWS managed groups IP reputation, known bad inputs and common rules in **block** mode, plus a per-address ceiling (`api_rate_limit_per_5min`, default 2000 per five minutes) as the shared backstop above F2's per-process limits. |
| Outputs | `api_alb_dns_name` (the value for the Cloudflare CNAME), `api_validation_cnames`, `api_target_group_arn`, `api_tasks_security_group_id`. |

## Decisions that shaped it (and what they cost)

- **Plain HTTP between the load balancer and the tasks.** TLS ends at the load balancer; the hop is inside private subnets and limited by security groups. Accepted for the synthetic pilot; **decide again before real patient data** (it means TLS inside the task: a sidecar or the application).
- **No access logging on the load balancer, no firewall logging, no sampled requests.** Request lines carry record identifiers and the firewall's samples and logs keep headers such as `Authorization`. Forensics rest on the application's own logs (F3b) and the audit trail ([audit-trail.md](audit-trail.md)). If firewall logging is ever wanted it needs a redaction plan first; a test fails the build if a logging resource appears.
- **The firewall blocks from day one.** A managed rule can reject a legitimate request (for example the common rule set's body-size rule on a large JSON body). Watch the blocked-request metric during the first staging soak; the fix for a false positive is a **scoped exclusion on that one rule**, never turning a group off.
- **Outbound path is a NAT gateway, which this module does not create** (the VPC is an input). The tasks must reach AWS services and Cognito's public key endpoint. It is **not** verified that the Cognito key endpoint is reachable through a VPC endpoint, so none is assumed.
- **`TRUST_PROXY_HOPS=1`** (F3b sets it): exactly one proxy, this load balancer, sits in front of the API. If anything is ever put in front of it (a CDN), the value and [rate-limiting.md](rate-limiting.md) must change together.
- **Per-process limiter, two or more tasks:** each task allows the full in-process rate. The firewall ceiling is the shared bound.

## Before the first apply (checklist)

1. The three gates in the Terraform README (BAA, remote state, plan reviewed line by line) and the prerequisites in [deployment.md](deployment.md).
2. A VPC with at least two public subnets (in different zones) and private subnets with a **route to a NAT gateway**; set `public_subnet_ids`. Without a VPC, create it first, as its own change.
3. Apply with `enable_api_hosting = true`; add the certificate validation record in Cloudflare while the apply waits.
4. Only after F3b has a healthy service behind it: add the DNS-only CNAME from the API name to `api_alb_dns_name`. Until then the load balancer answers 404 or 503 and nothing else.
5. Check, with synthetic data: TLS 1.2 accepted and 1.1 refused, port 80 refused, `/` answers 404, `/api/v1/health` and `/api/v1/ready` answer, a request from the firewall's block list is refused, the unhealthy-target path works by stopping a task.

## What is not verified

`terraform fmt` and `validate` pass locally; the guard tests read the text. **Nothing has been planned or applied in AWS.** Not verified: that AWS accepts the whole root, load-balancer and firewall behaviour, certificate validation, the health check against a real task, task-to-database reachability, false positives from the managed rules, NAT egress to Cognito, and cost (no estimate has been made).

## HIPAA eligibility

The list could not be read from the official AWS page in the build environment (outbound access to it is blocked). From search results quoting it: Amazon ECS, Amazon ECR, Elastic Load Balancing and AWS WAF appear, and AWS Fargate appears for the ECS and EKS engines. **Not confirmed:** Secrets Manager, CloudWatch (logs and alarms), CloudTrail, VPC/NAT, Certificate Manager, SNS. Check each on the live AWS HIPAA Eligible Services Reference before the BAA review. Eligibility is not compliance, and the BAA must be executed before any real patient data.
