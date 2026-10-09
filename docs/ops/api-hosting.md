# API hosting (F3): ECS Fargate behind a load balancer

**Status: F3a (the edge) and F3b (the compute) are written as Terraform and guard-tested. Neither is applied, and both are off by default (`enable_api_hosting = false`).**
What is still missing before anything runs: the image and the deployment pipeline (F4), the database logins (below), and a VPC with a NAT route. Plan and the founder's decisions:
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

## What F3b creates (same switch; `api-compute.tf`)

The foundations exist as soon as the switch is on. **The task definitions and the service also need `api_image`**, so the order can be: apply the foundations, fill the secrets, build the image (F4), set `api_image`, apply again.

| Piece | Detail |
| --- | --- |
| Secret containers | Three Secrets Manager secrets, encrypted with the data key: the application login (`DATABASE_URL`), the verifier login (`LEDGER_VERIFIER_DATABASE_URL`) and the table owner's login for migrations (`DATABASE_MIGRATOR_URL`). **Terraform creates the containers only, never a value** (a test fails the build on a secret version or string). |
| Roles | The **task role** is the application's own identity: the existing `app_runtime` policy (report files) and nothing else. Two **execution roles** let ECS start a task: the service's can read the two runtime secrets; the migration task's can read only the migrator secret. Pulls are limited to the one repository named in `api_image`; logs to the one log group. The broad managed execution policy is refused by a test. |
| Cluster and service | Fargate cluster with Container Insights on. Service in the private subnets, no public address, in the tasks' security group, registered with the load balancer's target group. Rolling deployments keep full healthy capacity and roll back on failure (circuit breaker). No shell can be opened into a task. Production needs `api_desired_count >= 2`. |
| Task | Digest-pinned image (a tag is refused), read-only root filesystem, a numeric non-root user (`10001`), 30 s stop timeout, logs to the API log group. 0.5 vCPU and 1 GiB are **first guesses**: measure in staging. |
| Environment | Exactly the settings the production start-up demands (Cognito sign-in, Postgres, S3, TLS to the database, rate limiting on, `TRUST_PROXY_HOPS=1`) and none it refuses (no pipeline, no shared secret, no development overrides). **A test hands the environment to the application's own `loadEnv`** (with placeholders for the two secrets) and it must be accepted as a production configuration. |
| Migration task | A task definition only, never a service: `node dist/db/cli.js migrate up` with the table owner's login and no task role. Run it once before a release (below). |
| Logs | A log group with its own KMS key (neither the data key nor the audit key), retention `api_log_retention_days` (default 365, floor 90). |
| Alarms (into the audit topic, so one confirmed address hears everything) | `ledger-compromised` (any occurrence of the application's `ledger-compromised` log line); an unhealthy task for three minutes; ten or more server errors in five minutes; fewer running tasks than `api_desired_count` (silence counts as a breach). |

**How the `ledger-compromised` alarm is kept honest.** The alarm is a CloudWatch Logs metric filter on a top-level `event` field in each JSON log line. That only works if the application really writes the field at the top level, so: a test (`log-shape.spec.ts`) drives the application's real logger options (now in `logger-options.ts`) and requires the field at the top level; the Terraform guard requires the application to still log that event name and that spec to exist; and each was proved by breaking it (nesting the logged object turns the spec red). **Not verified:** the real alarm firing in AWS (use `set-alarm-state` and a deliberate test event in staging; checklist below).

## The database logins (a gap this PR does not close)

The migrations create the roles but not their logins, and RDS creates only the admin user ([ledger-roles.md](ledger-roles.md)). Before the first start, an administrator must, from inside the VPC, create three logins and put their connection strings in the three secrets. **The connection strings carry no TLS parameters** (no `sslmode`, `sslrootcert` or any `ssl...` name): the application refuses them at start-up, because in node-postgres they can override the explicit TLS setting. TLS comes only from `DATABASE_SSL=require`, which the service and the migration task both set ([database.md](../database.md#database-tls)):

| Secret | Login | Member of |
| --- | --- | --- |
| `.../api/database-url` | an application login | `telesphoros_app` only |
| `.../api/ledger-verifier-database-url` | a verifier login | `telesphoros_ledger_verifier` only, **never** `telesphoros_app` |
| `.../api/migrator-database-url` | the table owner | (owns the tables; needs `SET` on `telesphoros_ledger` and `telesphoros_redactor`, see ledger-roles.md) |

The SQL is in ledger-roles.md. **There is no tool in the repository to run it, and no bastion**: the image will not carry `psql`, tasks have no shell, and the database has no public address. Proposed for F4 (needs its own approval): a small `db provision-logins` command in the same image, run as a one-off task with the admin secret, that creates the logins with generated passwords and writes the connection strings into the three secrets, so no password is ever typed or displayed. Until that exists, the first deployment cannot start.

## Releasing (after F4 exists)

1. Run the **migration task** once with the new image (`api_migrate_task_family`), in the private subnets and the tasks' security group, and check its log for `migrate up` finishing. The service's `/ready` stays 503 while migrations are pending, so a task that starts first is not sent traffic.
2. Set `api_image` to the new digest and apply. The circuit breaker rolls back a deployment whose tasks never become ready.
3. Watch the four alarms and `/api/v1/ready`.

## Decisions that shaped it (and what they cost)

- **Plain HTTP between the load balancer and the tasks.** TLS ends at the load balancer; the hop is inside private subnets and limited by security groups. Accepted for the synthetic pilot; **decide again before real patient data** (it means TLS inside the task: a sidecar or the application).
- **No access logging on the load balancer, no firewall logging, no sampled requests.** Request lines carry record identifiers and the firewall's samples and logs keep headers such as `Authorization`. Forensics rest on the application's own logs (F3b) and the audit trail ([audit-trail.md](audit-trail.md)). If firewall logging is ever wanted it needs a redaction plan first; a test fails the build if a logging resource appears.
- **The firewall blocks from day one.** A managed rule can reject a legitimate request (for example the common rule set's body-size rule on a large JSON body). Watch the blocked-request metric during the first staging soak; the fix for a false positive is a **scoped exclusion on that one rule**, never turning a group off.
- **Outbound path is a NAT gateway, which this module does not create** (the VPC is an input). The tasks must reach AWS services and Cognito's public key endpoint. It is **not** verified that the Cognito key endpoint is reachable through a VPC endpoint, so none is assumed.
- **`TRUST_PROXY_HOPS=1`** (set by F3b): exactly one proxy, this load balancer, sits in front of the API. If anything is ever put in front of it (a CDN), the value and [rate-limiting.md](rate-limiting.md) must change together; a test fails the build if the value is not 1.
- **Per-process limiter and per-process ledger watch, two or more tasks:** each task allows the full in-process rate, and each runs its own start-up check and 24-hour walks. The firewall ceiling is the shared rate bound. A task that finds damage stops writing and leaves rotation at once (`/ready` fails), but **another task learns of it only at its own next walk, up to 24 hours later** (the alarm fires from the first finding).
- **The image must cooperate (F4):** a user with id `10001` that can read the application, a read-only root filesystem (nothing may write outside a mounted volume), and **Amazon's RDS certificate authority bundle with `NODE_EXTRA_CA_CERTS`**: the application connects with strict certificate checks and Node does not trust that authority by default. None of this is tested until an image exists.

## Before the first apply (checklist)

1. The three gates in the Terraform README (BAA, remote state, plan reviewed line by line) and the prerequisites in [deployment.md](deployment.md).
2. A VPC with at least two public subnets (in different zones) and private subnets with a **route to a NAT gateway**; set `public_subnet_ids`. Without a VPC, create it first, as its own change.
3. Apply with `enable_api_hosting = true`; add the certificate validation record in Cloudflare while the apply waits.
4. Fill the three secrets (previous section), build and push the image (F4), set `api_image`, `api_cors_origins` and `api_desired_count`, apply again.
5. Only after a healthy service is behind it: add the DNS-only CNAME from the API name to `api_alb_dns_name`. Until then the load balancer answers 404 or 503 and nothing else.
6. Check, with synthetic data: TLS 1.2 accepted and 1.1 refused, port 80 refused, `/` answers 404, `/api/v1/health` and `/api/v1/ready` answer, a request from the firewall's block list is refused, the unhealthy-target path works by stopping a task.
7. Test every alarm: `aws cloudwatch set-alarm-state` on each (the email must arrive), and for `ledger-compromised` also produce a real log line in staging (a deliberate, reverted change to one stored event in a throwaway tenant) and watch the metric filter count it.

## What is not verified

`terraform fmt` and `validate` pass locally; the guard tests read the text (and the environment check runs the application's own loader). **Nothing has been planned or applied in AWS.** Not verified: that AWS accepts the whole root, a valid Fargate CPU and memory pairing for the values chosen, load-balancer and firewall behaviour, certificate validation, the health check against a real task, task-to-database reachability, secret injection, rollback by the circuit breaker, the alarms firing, false positives from the managed rules, NAT egress to Cognito, the image (none exists), and cost (no estimate has been made).

## HIPAA eligibility

The list could not be read from the official AWS page in the build environment (outbound access to it is blocked). From search results quoting it: Amazon ECS, Amazon ECR, Elastic Load Balancing and AWS WAF appear, and AWS Fargate appears for the ECS and EKS engines. **Not confirmed:** Secrets Manager, CloudWatch (logs and alarms), CloudTrail, VPC/NAT, Certificate Manager, SNS. Check each on the live AWS HIPAA Eligible Services Reference before the BAA review. Eligibility is not compliance, and the BAA must be executed before any real patient data.
