# Opt-in report lookup: offline implementation verification

This slice implements the owner-approved section 13 boundary in `docs/design/report-adapter-spec.md`. It is an offline engineering prototype. No API/controller imports it; no migration, production switch, knowledge adoption, model or training flag changes.

## Behavior

- Strict versioned input/context/policy, source evidence and output contracts.
- One authenticated tenant/report/capture scope supplied separately from the payload. Trusted ports obtain current records in a consistent snapshot, replay the existing pinned deterministic reader locally, and check the dependency version immediately before returning.
- Ordered capture, packet, association, duplicate, empty, reconciliation, context/policy and routing gates. Duplicates remain literal comparisons. Empty fields and adverse diplotype facts cannot become approved-unavailable.
- Canonical plus proved absence/approved unavailable uses only its policy-named single-gene row. Both canonical uses only the combined cell. Both missing selects no row. Required rows outside the reviewed scope never fall back.
- Selected outputs contain only source locators. A published “No recommendation” is a selected row; no-row is separate. Nothing exposes recommendation wording or grants clinical release.

## Trusted ports are required, not implemented production adapters

`LookupPorts` has `readSnapshot`, `replaySource` and `currentVersion`. Missing methods fail closed. The only reference store is a fictional test helper under `apps/backend/test/helpers/report-lookup.ts`, outside the production build. Its accepted/verified records are deliberately invented test inputs, never actual approvals.

The store must authorize the scope/actor; resolve the latest capture decision, separation of duties and current review ordering; bind stored PDF/object version/text/Poppler; and return one coherent snapshot including current tenant disputes. The module verifies those explicit bindings, strict record hashes, source slices, candidate/frame membership and mapping reconciliation. Source records bind all other pinned reader identities transitively through the verified packet hash. Coverage refers only to the pinned generator's registered report region, with grammar-hash binding; this slice adds no template/anchor registration.

The legacy TypeScript checker alone does not establish full source accounting. This boundary additionally compares the complete stored reader result with an independent local run of the unchanged pinned generator. Rehashing a forged packet/coverage ledger does not establish absence.

A version read before return detects a simulated concurrent change; it is **not** an atomic database commit. Future persistence must serialize/revalidate the dependency set and latest decisions in the transaction. Real authorization, SQL/RLS, object storage, correction history, reviewer qualifications and independent capture/gold review are not established by these tests.

## Bounds and hashes

Exactly two supported genes; at most 500 policy selectors, 200 evidence records, ten source artifacts; 1 MiB serialized input/snapshot/replay; 100000 source Unicode scalars; nesting at most 64 descendant levels; two-second asynchronous operation deadlines. Ports must honor cancellation. A Promise race cannot terminate an uncooperative or synchronous port; the test replay uses a cancellable local subprocess with its own timeout. No retries, truncation or automatic repair.

Strict UTF-8 decode preserves BOM. Literal offsets count Unicode scalars. Artifact hashes cover exact UTF-8 bytes; policy formatting/newlines invalidate artifact reviews. Logical record hashes use the existing restricted canonicalizer, UTF-16 key order, safe integers and scalar strings. Raw duplicate keys, floats/exponents, unsafe integers and lone surrogates are rejected before admission. Existing packet/knowledge identity algorithms are unchanged.

## Verification evidence

Visible synthetic development tests only:

- 36 explicitly written state-matrix cells at the routing layer, also exercised through the pinned reader wherever it can represent the source.
- Admission negatives cover cross-tenant/report/capture substitutions, PDF/object-version binding, stale rejection/reviews, simulated concurrent rejection, empty/diplotype/unavailable conflicts, quoted values, abstention and scope/no-fallback holds.
- Frozen known-answer record/artifact digests and an independent Python oracle cover UTF-16/scalar sort divergence, BOM/astral slices, key reordering, exact policy bytes and rejected inputs.
- Targeted mutation runner operates in an isolated copy: nine deliberate defects must fail assertions, while one harmless formatting control passes. It checks the working source remains unchanged.
- Legacy adapter/engine suites, backend typecheck/build/lint and local backend tests are separate checks. CI remains required. Local database/S3 tiers require configured services and must not be described as passing when skipped.

See `report-lookup-offline-v1-results.json` for counts/environment. These are implementation checks, not independently measured clinical accuracy or a model-training readiness claim.

## Known representability limit

The pinned reader holds a source with no supported frames. Therefore “both absent → no row” is verified at the routing layer but cannot currently be admitted end-to-end from an empty/no-gene report. The integration test expects the stronger reader hold. Two actual unavailable-token occurrences can yield a fully admitted no-row. No grammar was widened to make the matrix pass.

## Run

Use CI-pinned Node 22.22.0 (Unicode 16.0), pnpm 10.28.0 and Python 3:

```sh
pnpm install --frozen-lockfile
pnpm --filter @telesphoros/backend typecheck
pnpm --filter @telesphoros/backend lint
pnpm --filter @telesphoros/backend build
pnpm --filter @telesphoros/backend exec jest --runInBand
python3 sidecars/report-lookup/test_mutations.py --output /tmp/report-lookup-mutations.json
```

Next scope, requiring its own plan: production record-store/API integration and real transaction/storage/authorization tests; independently reviewed real-capture evaluation remains separately gated.
