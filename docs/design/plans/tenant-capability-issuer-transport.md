# Tenant capability: how the API reaches the issuer (design and cost)

**Status: proposed, for the founder's decision. Nothing here is built or applied.** Written 2026-10-20 for DATA-01 slice 2, task T018 (`specs/001-tenant-capability/tasks.md`). It is the pricing the P2 plan asked for before any transport is written (`docs/design/plans/agentic-session-capability.md`, section 3a, D1, "second condition"). Repository facts cite `main` `8f9dc12`.

## What slice 2 built, and what is left open

The API now asks a `CapabilityIssuerPort` for one capability per request (`apps/backend/src/issuer/capability-issuer.port.ts`, `apps/backend/src/issuer/request-capabilities.ts`, called from `AuthGuard`). The issuer core (`apps/backend/src/issuer/issuer-core.ts`) verifies the access token with `CognitoTokenVerifier`, mints 32 random bytes and calls `tenant_capability_issue` as `telesphoros_session_issuer`. The default port is `NullCapabilityIssuer`, so nothing is requested and behaviour in `guc` mode is unchanged.

**Open:** the wire between the API's port and the issuer core, and how the issuer knows the caller is the API. A client for the chosen wire is one more `CapabilityIssuerPort`; a server around `IssuerCore` is the other end.

## Repository facts that shape the choice

| Fact | Where |
|---|---|
| The only load balancer is the public API one. No internal load balancer, Service Connect, Cloud Map or service discovery exists in the Terraform root. | `infrastructure/terraform/api-edge.tf:145` (`aws_lb.api`); no match for the others in `*.tf` |
| API tasks accept traffic only from that load balancer; they send out only to the database (5432) and to HTTPS. | `api-edge.tf:72-129` (`api_tasks`, `api_tasks_from_alb`, `api_tasks_to_database`, `api_tasks_https_out`) |
| The worker accepts no inbound connection at all; it is the isolation precedent (own security group, own roles, own secret). | `worker.tf:111-145` |
| Sizes today: API 512 CPU / 1024 MiB, production at least two tasks; worker 256 / 512. | `api-compute.tf:46-59`, `:591`; `worker.tf:15-24` |
| The one Lambda is the password notifier: no VPC, no database, 128 MB. It is no precedent for a database-connected function. | `lambda.tf:51-66` |
| The database is reached by security-group rule, from tasks directly. There is no RDS Proxy. | `database.tf:7`, `api-edge.tf` (`api_db_from_tasks`) |
| Outbound HTTPS from tasks (Cognito's key endpoint, AWS APIs) goes "through the VPC's outbound path (NAT, decided in the plan)". The synthetic profile has no NAT; its tasks take public addresses. | `api-edge.tf` comment above `api_tasks_https_out`; `network-synthetic.tf`, `profile.tf` (`tasks_public_ip`) |
| The issuer must verify tokens itself, so it needs the same outbound path to Cognito's key set as the API. | `cognito-token-verifier.ts:38-42` |
| The issuer is on every request's critical path, and decision D4 says it fails closed (503) once enforcement is on. | `specs/001-tenant-capability/plan.md`, D4 |
| An ECS secret injected as an environment variable is not refreshed on rotation; the task must be replaced. | P2 plan, section 3a, D1 (cites the ECS documentation) |
| Issuance volume is one call per authenticated request. The provisional limit is 120 per person per 60 s, counted and not enforced. | `0028_tenant_capability.up.sql`, `capability_purposes` |

## What the transport does and does not protect

The security boundary is not the transport. It is: the API holds no issuer credential; the issuer verifies the Cognito token itself; the database re-checks the membership version and the organization. A compromised API can already relay real users' live tokens to the issuer for up to 15 minutes (spec, "Residual risks"). So caller authentication only keeps other hosts in the network from using the issuer as a free oracle and flooding its log. It is defence in depth, and it should cost little.

## The three options

### (a) ECS issuer service, internal ingress, application-level caller authentication

- **Build (slice 2b, Terraform, not applied):** a service from the same image with its own execution role, task role and secret (the worker pattern); a security-group rule from `api_tasks` to the issuer's port; an internal entry point (an internal load balancer, or Service Connect); a caller check in the issuer; alarms. Production needs at least two tasks, because an outage is a 503 for every request.
- **Caller authentication:** the repository has none to reuse. Candidates: a shared secret the API sends and the issuer compares (new secret, new rotation), or signed requests. Either is new custody. ECS and ALB offer no IAM authentication on this path.
- **Cost drivers:** Fargate task-hours times task count (at least 2); the internal load balancer's hours and capacity units, if that entry point is chosen; log volume (one line per request is not needed; refusals only); one more secret. The outbound path to Cognito is shared with the API's, not new.
- **Published prices** (fetched 2026-10-20, us-east-1 examples only; the project's Region is a variable and is not fixed in the repository):
  - Fargate, Linux/x86: "$0.000011244 per vCPU second" and "$0.000001235 per GB per second"; Arm: "$0.0000089944" and "$0.0000009889"; "1-minute minimum". Source: <https://aws.amazon.com/fargate/pricing/>. The tables did not render, so these come from the page's worked examples.
  - Application Load Balancer: "hourly charge of $0.0225" and "$0.008 per LCU", from Pricing Example 1. Source: <https://aws.amazon.com/elasticloadbalancing/pricing/>.
  - Service Connect: price not fetched.
- **Latency:** one in-VPC hop on every request, no cold start. Measured nowhere yet (D4).
- **Fits the repository:** most. It reuses the worker's isolation pattern and needs no new database component.

### (b) Lambda invoked under IAM

- **Build:** a function with the issuer's roles, attached to the VPC so it can reach the database; the API task role gets `lambda:InvokeFunction` on it. Caller authentication is IAM itself, with no listener and no secret of our own.
- **Extra pieces it forces:** a VPC attachment; an outbound path to Cognito's key set (the same NAT question as the tasks); AWS's own guidance to put an RDS Proxy in front of a function that connects to RDS (P2 plan, section 3a, D1), and the proxy reads the issuer login's secret; and cold starts on the synchronous path of a request. Provisioned concurrency removes cold starts and is billed as long as it is on.
- **Cost drivers:** requests and GB-seconds; provisioned concurrency if cold starts matter; RDS Proxy per vCPU-hour; the VPC-attached network path.
- **Published prices** (fetched 2026-10-20):
  - Lambda: "$0.20 per one million requests"; "$0.0000166667 per GB-s" (x86); Arm rate not retrievable; free tier "one million requests and 400,000 GB-seconds per month", which does not apply to functions with provisioned concurrency. Provisioned concurrency: "$0.0000041667 per GB-s" plus "$0.0000097222 per GB-s" compute while it is on. Source: <https://aws.amazon.com/lambda/pricing/>. The page says VPC use "incurs additional charges" at EC2 rates and gives no figure.
  - RDS Proxy: "priced per vCPU per hour" with "a 10-minute minimum charge following a billable status change". **The per-vCPU figure and any minimum vCPU count did not load**; read them at <https://aws.amazon.com/rds/proxy/pricing/> before deciding.
- **Fits the repository:** least. No database-connected function, no RDS Proxy and no function in a VPC exist today.

### (c) In-process only (the issuer core inside the API)

- **Build:** nothing beyond slice 2. The API would construct `IssuerCore` with the issuer's database URL.
- **Why it cannot be the real design:** the API would hold the issuer's credential, so a compromised API could mint a capability for any organization. That is the exposure DATA-01 exists to remove (spec, "Rule"). It adds a database round trip and changes nothing about who can forge.
- **Cost:** no infrastructure. **Use:** only to exercise the plumbing on synthetic data. Slice 2 deliberately does not wire it.

## Comparison

| | (a) ECS | (b) Lambda | (c) In-process |
|---|---|---|---|
| Closes DATA-01 | yes | yes | **no** |
| New always-on service | yes, at least 2 tasks in production | no | no |
| New database component | no | RDS Proxy (recommended by AWS) | no |
| Caller authentication | new, application-level | IAM, nothing of ours | n/a |
| Cold start on the request path | no | yes, unless provisioned concurrency | no |
| Idle cost | task-hours, always | near zero, plus proxy hours and any provisioned concurrency | none |
| Repository precedent | worker isolation pattern | none | none |

## Not verified

No price was applied to a size or a request volume, so this document states no monthly figure. Prices are us-east-1 examples read from pages whose tables did not render; the Region is unset. Service Connect pricing, RDS Proxy's per-vCPU price, whether a function in a VPC needs a NAT to reach Cognito's key endpoint (AWS documentation, not fetched this session), and all latency are unverified. Decision D4's p95 budget and D7's seven-day window need a synthetic staging environment, and nothing is applied in AWS.

## Recommendation

**(a), the ECS issuer service,** with the internal entry point and the caller check settled in slice 2b's own PR, each with a fresh price read. It fits the isolation pattern the worker already proved, adds no database component and has no cold starts on a path that fails closed. Lambda (b) is the better fit if the founder values IAM caller authentication and a near-zero idle cost over a new database component and cold starts; it is a close second, and the missing RDS Proxy figure is what stops this document ranking it on cost.

**The one decision for the founder:** accept an always-on ECS issuer service, at least two tasks in production, as the transport for slice 2b, or choose Lambda behind RDS Proxy. Until one is chosen the API runs with `NullCapabilityIssuer` and nothing changes.
