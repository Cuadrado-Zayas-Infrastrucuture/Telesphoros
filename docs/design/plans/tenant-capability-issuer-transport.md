# Tenant capability: how the API reaches the issuer (design and cost)

**Status: proposed, for the founder's decision. Nothing here is built or applied.** *Update 2026-10-20: the founder chose option (a). The addendum at the end settles the two items this document left open for slice 2b.* Written 2026-10-20 for DATA-01 slice 2, task T018 (`specs/001-tenant-capability/tasks.md`). It is the pricing the P2 plan asked for before any transport is written (`docs/design/plans/agentic-session-capability.md`, section 3a, D1, "second condition"). Repository facts cite `main` `8f9dc12`.

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

## Addendum, 2026-10-20: slice 2b settles the entry point and the caller check

**Status: proposed in the slice 2b PR for the founder's review. Nothing is applied.** The founder chose option (a), an always-on ECS issuer service, on 2026-10-20. This addendum settles the two items the first part left open, each with a fresh price read. Repository facts cite `main` `318232f`. The Terraform is `infrastructure/terraform/issuer.tf` (task T019).

### The prices, read again

Every figure below was read on 2026-10-20 from the page named. A figure not in this list was not read, and none is invented.

| Item | What the page says | Page |
|---|---|---|
| ECS Service Connect | "There is no additional charge for using Amazon ECS Service Connect." "There is no additional charge for AWS Cloud Map usage when used by Service Connect." You pay for the task's own vCPU and memory, which the Service Connect proxy shares. | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html>, section "Pricing" |
| Service Connect TLS | You pay for the private CA and for each certificate issued. ECS rotates a certificate every five days, so about six are issued per service per month. | same page |
| AWS Private CA | "$400 per private CA per month for general-purpose mode"; "$50 per private CA per month for short-lived certificate mode" (certificates valid up to 7 days); short-lived certificates "$0.058" each; first CA in a Region free for 30 days. The page names no Region. | <https://aws.amazon.com/private-ca/pricing/> |
| Application Load Balancer | "hourly charge of $0.0225" and "$0.008 per LCU", from a US-East-1 example. | <https://aws.amazon.com/elasticloadbalancing/pricing/> |
| Fargate, Linux/x86 | "$0.000011244 per vCPU second" and "$0.000001235 per GB per second", from the page's US East (N. Virginia) example, because the price table did not render. | <https://aws.amazon.com/fargate/pricing/> |
| RDS Proxy | "priced per vCPU per hour"; "10-minute minimum charge following a billable status change". **The per-vCPU figure is not in the page text.** It was fetched twice (a document reader and a page fetch); the pricing-example sections are empty in both. | <https://aws.amazon.com/rds/proxy/pricing/> |

Arithmetic on those inputs, a 30-day month, list prices, not a quote:

| Line | Inputs | Result |
|---|---|---|
| One issuer task, 256 CPU (0.25 vCPU) and 512 MiB (0.5 GB) | (0.25 x 0.000011244 + 0.5 x 0.000001235) x 3600 x 720 | about $8.89 |
| Two tasks (the production minimum) | 2 x $8.89 | about $17.77 |
| Private CA, short-lived mode, plus the issuer's certificates | $50 + 6 x $0.058 | about $50.35 |
| An internal load balancer, hours only | $0.0225 x 720 | $16.20, plus LCUs, which depend on traffic and were not estimated |

### Decision 1, the internal entry point: Service Connect

| | Service Connect | Internal load balancer |
|---|---|---|
| Who the issuer's security group admits | the API tasks directly | the load balancer; the API tasks are admitted one hop earlier |
| New components | one private HTTP namespace; the API joins it as a client | the balancer, its security group, a listener, a target group |
| Encryption of the access token in the VPC | Service Connect TLS, from a Private CA (about $50.35 a month with the short-lived CA) | an HTTPS listener needs a certificate for a name that resolves inside the VPC; the repository has no private zone, and its public names are administered by hand in Cloudflare. A plain-text listener would carry a live 15-minute bearer token |
| Service charge | none | hours above, plus LCUs |
| Repository precedent | none (no Service Connect, Cloud Map or internal balancer exists) | none |

Money does not decide this: the load balancer's hours are lower than the CA's monthly fee. What decides it is the shape the task asks for, "a security-group rule from the API tasks to the issuer port and nothing else inbound". With a balancer that rule cannot be written, because the issuer would admit the balancer. Service Connect also needs no public name, no certificate to validate by hand and no private DNS zone.

What this costs the founder: the CA is the one recurring line (about $50.35 a month at list price once the 30-day trial for the first CA in the Region ends). `issuer.tf` does **not** create it. It takes the CA's ARN as `issuer_tls_ca_arn`, and the service refuses to exist in production without one. Synthetic staging may run without TLS, because every token there belongs to a synthetic person, and the plan already forbids real data before enforcement.

### Decision 2, the caller check: the network identity, and no shared secret

The repository has no caller authentication to reuse, and the pages read describe discovery and encryption for Service Connect, not caller identity (none stated; none assumed). The choice is between:

1. **Security-group source plus TLS in transit (chosen).** Only tasks in the API's security group can open a connection to the issuer's port, and the token is encrypted on the way. Any process inside the API tasks can call the issuer, which is true of the API process itself already.
2. **A shared secret the API sends and the issuer compares.** It adds one more secret that the API's execution role must read, one more rotation, and a check in application code that does not exist yet.

The first part of this document set the test: the transport is not the security boundary. The issuer verifies the Cognito token itself, and the database re-checks the membership. A compromised API can already relay live tokens for up to 15 minutes. A shared secret would not change that, and it would add custody the founder must run. Choice 1 therefore adds no new secret and no new code. If the issuance log ever shows calls from outside the API, signed requests or mutual TLS are the next step, and they would be a new decision.

### What slice 2b does not do, and why

- **Entry point: provided afterwards, in PR A (second addendum below).** When this addendum was written `IssuerCore` opened no port and the image built no issuer entry. PR A adds `apps/backend/src/issuer/main.ts`, compiled by the existing backend build to `dist/issuer/main.js`; the task's `command` is that path. `enable_issuer` stays false until the API has a client.
- **No client.** The API still uses `NullCapabilityIssuer`. Joining the namespace (`issuer_namespace_arn`), calling `http://session-issuer:8082` and the `CapabilityIssuerPort` implementation are the client PR.
- **No provisioning wiring (done in the follow-up PR C).** `provision-logins` creates the issuer login only when `PROVISION_SECRET_ISSUER` names the secret (`apps/backend/src/db/cli.ts`). Passing it from the provisioning task, and letting that task's role write the issuer secret, edit `api-compute.tf` and its guard, which used to pin that role to exactly four secrets. PR C does it: the provisioning task definition passes the variable, the provisioning task role gains the issuer secret as its fifth, and no execution role does. It was not part of T019.
- **Measurements.** Nothing is applied, so decision D4's p95 budget and D7's seven-day window cannot be measured. The alarm thresholds in `issuer.tf` are provisional.

### Not verified

Service Connect, the Private CA, the certificate role's trust principal and conditions, and whether ECS-issued certificates fit a short-lived-mode CA are all unexercised; the IAM policy is the AWS-managed one (version 4, read 2026-10-20) narrowed to one CA. The documentation read does not say whether the Service Connect proxy reaches the application on the task's loopback address or its network interface, so the issuer entry's bind address is open (the container health check assumes `127.0.0.1`). `tofu validate` accepts the file; `tofu test` is known to fail locally against CI's Terraform version and was not used as evidence. The RDS Proxy per-vCPU price is still unread, so option (b) is still not priced.

## Addendum 2, 2026-10-20: PR A provides the issuer's entry point

**What was built.** `node dist/issuer/main.js`, from the same image as the API and the worker. It is plain `node:http`, not a Nest application, and it is compiled by the existing backend build, so there is no new bundle and no Dockerfile change. `pnpm --filter @telesphoros/backend build` emits `dist/issuer/main.js`; the image's `pnpm deploy --legacy --prod` step keeps `dist`, and the `rm -rf` line after it removes `src`, `test`, `scripts` and config files only. A guard (`issuer.guard.test.mjs`) derives the emitted path from `tsconfig.build.json` and the Dockerfile and requires the task's `command` to equal it.

**The wire** (`apps/backend/src/issuer/issuer-server.ts`):

| Request | Answer |
|---|---|
| `POST /v1/capabilities`, `application/json`, body at most 8 KiB, exactly `{accessToken, membershipVersion, requestId}` | `200 {token, expiresAt}` |
| the token does not verify | `401 {error: "invalid-token"}` |
| a verified person with no single tenant | `403 {error: "no-tenant"}` |
| the database refuses | `403 {error: "refused", detail: <the database's closed code>}` (detail dropped unless it is lower-case letters, digits and dashes) |
| a malformed body, an unknown key, a version below 1, a request id that is not 1 to 128 of `A-Za-z0-9._-` | `400 {error: "invalid-request"}` |
| not JSON; over 8 KiB | `415`; `413` |
| the database or anything unexpected failed | `503 {error: "unavailable"}` |
| `GET /livez` | `200` (the Terraform health check) |
| anything else | `404` |

Header timeout 5 s, request timeout 10 s, at most 128 connections, one request per connection (`Connection: close` on every answer). `SIGTERM` stops accepting, lets requests in flight finish for up to 20 s, closes the pool and exits 0; ECS waits 30 s. Production refuses to start on any missing setting, on `DATABASE_SSL` other than `require`, on `COGNITO_ISSUER` or `COGNITO_JWKS_URI`, and if one of the application's own secrets (`JWT_SECRET`, `INVITATION_DIGEST_KEY`, `IDENTIFIER_DIGEST_KEY`, `LEDGER_VERIFIER_DATABASE_URL`) is present. A test pins that the entry's imports exclude the API's pool, its configuration, the ledger login and the worker.

**Logs.** `IssuerCore`'s `Capability not issued: <reason>` lines reach stdout unchanged, because `issuer.tf`'s two metric filters match them. The server writes different phrases for its own refusals so a failure is counted once. No token, claim, database message or address is written; a request id is, after it is checked against the pattern above.

**A finding about the task's command.** The image sets `ENTRYPOINT ["node"]`, and an ECS `command` replaces only the image's `CMD`. A command that starts with `node` therefore runs `node node ...`. On 2026-10-20 a local `docker run` of an image built from this Dockerfile (`telesphoros-fd4b:rehearsal`) with arguments `node worker/main.js` died with a module-not-found error, and with `worker/main.js` it started the worker. `issuer.tf` therefore uses `["dist/issuer/main.js"]`. The worker task (`worker.tf`) and the migrate and provision-logins tasks (`api-compute.tf`) are written with a leading `node` and are not changed here.

**Not verified.** (1) That the Service Connect proxy reaches the application on the task's network interface, which is why the entry binds `0.0.0.0` (the health check uses `127.0.0.1`, which that covers). (2) That `Connection: close` is the right choice behind Service Connect: it was chosen so the proxy never reuses a connection the application is about to time out; the proxy's behaviour is unexercised. (3) Latency under load: the handler has no deadline of its own beyond the verifier's key-set timeout (3 s) and the pool's limits (2 s to connect, 5 s per statement). (4) The Fargate platform: on 2026-10-20 an image was built locally from `api.Dockerfile` (arm64, because the host is) and run with a read-only root filesystem as the image's user (10001), `command` `dist/issuer/main.js` and the production settings. The entry listened on `0.0.0.0:8082`, the Terraform health-check one-liner exited 0, a bad token got a 401, and `docker stop` ended it with exit code 0. Fargate runs `X86_64` (`issuer.tf`), so the x86 image, ECS itself and the awslogs driver are unexercised. The same image refused `node dist/issuer/main.js` with `Cannot find module '/app/node'`.
