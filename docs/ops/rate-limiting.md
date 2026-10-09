# API rate limiting

Step F2. A fairness and cost guard: one signed-in person, or one script, cannot starve everyone else, and a flood of bad tokens is stopped before it
costs signature checks. **It is not a defence against a determined distributed attack** (that is the load balancer's and the WAF's job, step F3).

## What is limited

| Limit | Counted | Default per minute | Settings |
| --- | --- | --- | --- |
| **Per address** | Every request from a client address, **before** authentication (so it also covers bad tokens and public routes) | 300 | `RATE_LIMIT_IP_PER_MINUTE` |
| **Per person, reads** | After authentication and roles: `GET`, `HEAD`, `OPTIONS` | 120 | `RATE_LIMIT_READ_PER_MINUTE` |
| **Per person, writes** | Every other method | 30 | `RATE_LIMIT_WRITE_PER_MINUTE` |
| **Per person, expensive** | Routes marked expensive: starting a capture, evaluating a report, the file links (`download-url`, `text-url`), and `GET /ledger/verify` | 10 | `RATE_LIMIT_EXPENSIVE_PER_MINUTE` |

- A **person** is the tenant *and* the individual. Two people in one tenant do not share a bucket; the same individual id in two tenants is two people. Minting a new token does not reset anything.
- Each class has its **own bucket**: spending the expensive limit does not use up a person's reads.
- It is a **token bucket**: a person can burst up to the per-minute number at once, then is refilled continuously (the per-minute number divided by 60 each second).
- **Not limited:** `GET /health` and `GET /ready` (a load balancer calls them on a schedule).
- **Order:** address limit, then authentication, then roles, then the person limit. So a request that is refused (401, 403) never spends a person's tokens, and a flood of unauthenticated requests gets 429 rather than reaching token verification.

## The answer

**429 `RATE_LIMITED`** in the standard error envelope with a `Retry-After` header (whole seconds). The message does not say which limit or which key was hit. A refused request never reaches its handler, so nothing is read or stored by it.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `true` | Production refuses to start with it off. The test helper turns it off by default; the rate-limit tests turn it on. |
| `RATE_LIMIT_*_PER_MINUTE` | see above | 1 to 100 000 each. |
| `TRUST_PROXY_HOPS` | unset (treated as 0) | How many reverse proxies sit in front of the process. **Production refuses to start unless it is set explicitly.** |

### The client address, and why `TRUST_PROXY_HOPS` matters

- **0** (nothing in front): the connection's own address is used and `X-Forwarded-For` is **ignored**, so a client cannot invent its way out of the address limit with a header it controls.
- **1** (one load balancer, as planned for step F3): the address the load balancer appended is used. Anything a client puts earlier in the header is ignored.
- **Too low behind a load balancer** puts every client in one bucket (a self-inflicted outage). **Too high** lets a client spoof its address. When the compute host arrives (F3b), the value is 1 behind the F3a load balancer ([api-hosting.md](api-hosting.md)), and the Terraform and this setting must agree.

## Known limits (read before relying on it)

- **Per process.** Two instances each allow the full rate, and a restart resets every bucket. A shared store (or the WAF's rate rules) is the follow-up if instances are scaled out.
- **Bounded memory.** Each limiter remembers at most 50 000 keys and drops the least recently used beyond that; a sweep forgets buckets that have fully refilled. Under a flood of made-up addresses, an older honest client's bucket can be evicted and start full again: this is a fairness guard, not a security boundary.
- **The frontend does not yet show a friendly message on a 429.** It shows its generic error. That is a small follow-up.
- Numbers are defaults chosen for a pilot, not measured from real use: change them with the settings above.

## Verification

Bucket arithmetic with a controlled clock (burst, refill to the exact moment, cap, bounded memory, sweep); key isolation (tenant and individual, class, address); over HTTP: the 429 envelope and `Retry-After`, the classes, the order around authentication, the exempt probes, the client address at 0 and 1 trusted proxies, and that a refused write stores nothing; configuration rules. Defect injection with controls, listed in the pull request.
