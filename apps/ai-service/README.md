# @telesphoros/ai-service

A **library**, not a service. It is synthetic control flow for explanation contracts, policy and budget checks and evaluations: its `package.json` says "no models, service, effects or deployment", and it has no process to start. Nothing in the product calls a model through it. Documentation map: [docs/README.md](../../docs/README.md).

It sits under `apps/` although it is not deployed. No other workspace package imports it at this commit (`grep '"@telesphoros/ai-service"' apps/*/package.json packages/*/package.json` finds only its own); it imports `@telesphoros/cpic-schema` and `@telesphoros/jobs`.

| Look at | For |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The whole public surface: request/context/outcome schemas, `syntheticProfile`, `liveReadiness`, `runSynthetic` |
| [`src/kernel.ts`](src/kernel.ts), [`src/policy.ts`](src/policy.ts), [`src/budgets.ts`](src/budgets.ts) | The control flow, the policy that keeps it synthetic, and the budget checks |
| [`src/model-clients/`](src/model-clients) | The model port and a scripted stand-in; there is no real client |
| [`src/evaluators/`](src/evaluators) | Sensors and the verifier for outputs |
| [`durable/`](durable) | PostgreSQL-backed run and receipt stores and a queue; tested by `test:durable:pg` |
| [`evals/`](evals) | Golden cases, attack cases and the pinned evaluation runner |

**Run and test**

```bash
pnpm --filter @telesphoros/ai-service test            # unit tests, no services
pnpm --filter @telesphoros/ai-service test:durable:pg # the durable stores; needs a disposable PostgreSQL
pnpm --filter @telesphoros/ai-service typecheck && pnpm --filter @telesphoros/ai-service build
```

The design and its release gates: [the LLM harness specification](../../specs/003-llm-harness/spec.md) and [AI safety requirements](../../docs/ai-safety-and-hallucination-controls.md). A model path stays off until clinical sign-off.

**Does not belong here:** a deployment, a real model client or a change that lets the product call a model; any of those is its own approved intention. Whether this library should move out of `apps/` is a separate layout decision.
