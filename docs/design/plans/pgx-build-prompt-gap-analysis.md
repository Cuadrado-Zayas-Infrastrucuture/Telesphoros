# Plan: the PGx build prompt against this repository (gap analysis, Phases 3 to 5)

Status: **draft, awaiting founder decisions D1 to D3 (and the small questions in section 6).** Snapshot 2026-10-19 against main `ccd4499`. **This is a plan only: no code, migration, dependency, infrastructure or clinical content changes, and nothing here is approved.** It does not adopt the prompt and does not replace the [repository audit and build plan](repo-audit-and-build-plan.md); it maps one external document onto that roadmap.

## 1. Why this exists

The founder supplied `TELESPHOROS_PGX_BUILD_PROMPT.md` (25,357 bytes, ten sections, Phases 0 to 9) and asked how it fits the current stack. The prompt is **untrusted requirements data**, not an instruction to this repository ([working agreement 5](../../STATUS.md#working-agreements)). Its stack assumptions (Express, CommonJS only, Redis and BullMQ, `node-pg-migrate`, PharmCAT as the clinical core, Stripe, pgvector memory) come from the earlier Telesphoros gateway, whose conventions [CLAUDE.md](../../../CLAUDE.md) says do not apply here. About a third of it (tenancy, roles, auth, rate limits, queue, audit chain) is already built. This plan separates what is already covered, what is a real gap, and what needs a founder decision.

What was read: the prompt in full; `docs/STATUS.md`, `architecture.md`, `cpic-integration.md`, `fhir-cds-hooks.md`, `auth.md`, the records specification and the existing plans named below; and the source paths cited in each row. Nothing was run against a database, AWS or a model provider.

## 2. What I found (checked, not assumed)

1. **The product input differs.** The prompt's pipeline is *VCF → PharmCAT diplotypes → CPIC*. This repository's pipeline is *lab report (PDF or structured JSON) → reader and adapter → diplotype or phenotype → in-house engine over signed knowledge* ([architecture.md](../../architecture.md#the-lab-report-pipeline-a-synthetic-non-production-integration)). `vcf` is an accepted report type (`packages/shared-types/src/report.ts:3`), but intake checks only the header line `##fileformat=VCFv4.[1-5]` (`apps/backend/src/reports/intake/structural-validator.ts:218`). Nothing parses variants, checks the reference build (GRCh38) or checks position coverage, and PharmCAT appears nowhere in the repository.
2. **The knowledge trust model differs.** Clinical content is data a pharmacist reviews and signs; recommendation text is copied verbatim and never rewritten; a result is `shown` only when every gene resolved and a *verified* cell matches ([cpic-integration.md](../../cpic-integration.md), [outcomes-and-reason-codes.md](../outcomes-and-reason-codes.md)). `knowledge/cpic/` is **empty on purpose** until real content is signed. The prompt instead has a nightly CPIC sync and PharmCAT-produced recommendations.
3. **There is no LLM in the clinical path.** `apps/ai-service` holds only `.gitkeep` files, and the audit's DA-4 recommended removing it. The Prompt Kit and Vercel AI SDK work is a synthetic in-browser preview with an in-memory transport and no model ([prompt-kit-sdk-review.md](../prompt-kit-sdk-review.md)). The draft [agent approval tiers](agent-approval-tiers.md) put "clinical results or clinical decisions" in tier T3, forbidden to the agent.
4. **Authentication is partly there.** Cognito already requires authenticator-app MFA at sign-in (`docs/auth.md`, first paragraph). There is **no per-action step-up** (for example at report sign-off), and no application-level TOTP, which is the right place for it to stay unless a decision says otherwise.
5. **FHIR is a synthetic preview, not a service.** A SMART pilot builds a `collection` Bundle against Genomics Reporting 3.0.0 profiles and CI runs the pinned official HL7 validator over generated examples ([fhir-cds-hooks.md](../../fhir-cds-hooks.md), [synthetic-fhir-ig-validation.md](synthetic-fhir-ig-validation.md)). The same document states there is **no production FHIR server, CDS Hooks service, clinical recommendation or EHR writeback**.
6. **Already built and matching the prompt's intent:** forced row-level security by tenant, roles and live membership revocation, a per-tenant hash-chained ledger committed in the transaction (the prompt's `audit_chain`; no Merkle roots exist or are needed), a PostgreSQL queue with transactional outbox and a separate worker (the prompt's BullMQ), numbered reversible migrations, per-process rate limiting in `apps/backend/src/rate-limit` ([ops/rate-limiting.md](../../ops/rate-limiting.md)), and a deterministic engine whose results carry a citation (`citation` on result DTOs, `packages/shared-types/src/lab-report.ts:133`).
7. **No billing code exists.** The roadmap already sequences a manual contract and invoice ledger (P1) before any paid pilot and Stripe automation later (P2).

## 3. Stack assumptions in the prompt

| Prompt assumes | Repository | Verdict |
| --- | --- | --- |
| Express, CommonJS only | NestJS 11 on TypeScript; React 19 and Vite | Drop. A rewrite discards tested code. |
| Redis and BullMQ | PostgreSQL queue, outbox, worker ([ops/jobs.md](../../ops/jobs.md)) | Drop. A second stateful service for no new capability. |
| `node-pg-migrate`, expand then contract | Custom migrator with up and down pairs; expand/contract tolerance is a separate approved slice | Drop the tool; keep the practice. |
| Sessions, argon2, magic links, TOTP | Cognito, with roles read from the database on every request | Drop; consider Cognito-side step-up only (G5.1). |
| UUID v7 keys, `memories`, pgvector | Existing key scheme; no use case for cross-order memory | Drop memory until a plan needs it. |
| Merkle roots | Hash chain | Already met in substance. |
| Puerto Rico storage region (C5) | AWS S3 | **Unverified and possibly unachievable**; see D4 (section 6). |

## 4. Phase 3 to 5 requirements mapped to existing slices

"Existing slice" names the slice in the [roadmap](repo-audit-and-build-plan.md) or an approved plan. "Gap slice" is a proposal (section 5); none is started or approved.

### Phase 3: deterministic PGx pipeline

| Prompt requirement | Repository today | Existing slice | Gap slice |
| --- | --- | --- | --- |
| `vcf-validate`: GRCh38 only, declared-position coverage, missing positions surfaced | Header-only check (finding 1) | M2.2 intake covers structure only | **G3.1** (only if VCF is a supported journey) |
| PharmCAT runner, pinned, raw outputs with checksums | Absent | none | **G3.2**, only under D1 option B |
| Genotype → phenotype → drug recommendation, guideline id and version on every row | Done in the in-house engine; version and citation copied from the guideline; stored with the ledger | the engine and loader (PR 5B-1, built on synthetic fixtures) | none beyond content |
| `cpic_guidelines` synced nightly, "never edited by hand" | Signed per-file review; empty until sign-off; the loader refuses unreviewed or edited files | **M2.4** reviewed knowledge release pipeline | Adapt: a sync may only *propose* a change for the signing process, never auto-load (G3.4) |
| CYP2D6 flagged; `call_source` per gene, never `pharmacat` | No call-source field exists (searched `apps`, `packages`, `docs`, `knowledge`); the repository's input is the lab's reported diplotype, so the source is always the lab today | none | **G3.3** makes it explicit, small |
| Golden set: 25 real-gene VCFs, drift fails CI | Fixtures use invented genes `GENEA` to `GENED`; hand-written expected results are the oracle (working agreement 6); real-gene content is blocked on signed knowledge | M2.4, then M3.1 fixtures | **G3.5**, after M2.4 and a decision on real-genome-derived data (D4) |

### Phase 4: agent layer

| Prompt requirement | Repository today | Existing slice | Gap slice |
| --- | --- | --- | --- |
| Orchestrator agent over BullMQ, state machine, escalation | Postgres queue, outbox, worker, append-only records and a ledger already do this without a model | M2.3 (merged) | none. Recommend **no orchestrator agent**; the prompt itself says an agent must justify itself. |
| Interpreter (the only LLM call): cited narrative | Not present. The engine's `recommendationText` is verbatim and never rewritten | none; blocked by D2 | **G4.1** only if D2 = B |
| Verifier (rule-based): citation coverage, RxNorm, strength labels | The engine's `shown` conditions already enforce a verified cell; no RxNorm anywhere beyond a single doc mention | engine (merged) | **G4.2** only if D2 = B |
| Prompts as versioned files with eval sets; injection and adversarial tests; regression on prompt change | None (no prompts exist) | none | part of G4.1 |
| `agent_runs`/`agent_steps`, per-run cost caps, daily tenant budget | None | none | part of G4.1 |
| Agent memory (`memories`, pgvector) | None | none | **Dropped** (no use case) |
| Tool scopes; destructive and clinical tools not agent-callable | Approval tiers drafted: T3 forbids clinical decisions to an agent | [agent-approval-tiers.md](agent-approval-tiers.md) (draft) | Needs an explicit amendment under D2 = B |

### Phase 5: reports, FHIR, CDS Hooks

| Prompt requirement | Repository today | Existing slice | Gap slice |
| --- | --- | --- | --- |
| `draft → verified → signed`, sign-off with step-up 2FA | Upload → capture → reviewer decision → evaluation → corrections, each a ledgered record, with two-person rules (`reviewer` is never implied). No "signed report" state; no per-action step-up | **M3.2** review, result and correction journey | **G5.1**: define whether a reviewer's acceptance is the sign-off, and whether step-up is needed (D4) |
| Signed hash enters the audit chain | Each record has its own ledger event in the per-tenant chain | records specification (merged) | none |
| FHIR R4 export per Genomics Reporting IG, validator in CI | Synthetic preview and pinned validator in CI; no server endpoint | P2 / T18 (SMART into the product) | **G5.2**: a read-only server endpoint, only after the clinical gates |
| CDS Hooks discovery and `order-sign` card, EHR JWT verification | None | P2 | **G5.3**, after G5.2 |
| CZI-branded PDF with a basis on every recommendation card | The existing PDF slice only retrieves *source* bytes; no rendered report | none | **G5.4** |
| No recommendation card without `basis[]` | Results carry a citation, absent only when there is nothing to show; a UI-level assertion over every card was **not verified** here | M3.2 | add the assertion to M3.2 |

## 5. Proposed slices (each its own plan and draft PR off main; none started)

Prerequisites that already exist on the roadmap come first, and no clinical slice starts before **M0.1** (intended use and regulatory assessment, T01) is decided.

| Order | Slice | Depends on | Notes |
| --- | --- | --- | --- |
| 0 | **M0.1** intended use, supported reports, regulatory assessment | none | Existing. Decides whether an interpretation layer is in scope at all. |
| 1 | **M2.4** reviewed knowledge release pipeline | M0.1 | Existing. Real CPIC content must be signed before any golden set. |
| 2 | **G3.3** `callSource` on each gene state | none | Small and independent. |
| 3 | **M3.1, M3.2** extraction and review journey | M2.4 | Existing. Add the "basis on every card" assertion. |
| 4 | **G3.1** VCF validation (GRCh38, position coverage) | D1, supported-journey decision | Only if VCF becomes a supported input. |
| 5 | **G3.2** PharmCAT as an untrusted diplotype caller | G3.1, D1 = B | Its output enters through the existing adapter and is labelled `callSource`; it never writes recommendation wording. |
| 6 | **G3.4** knowledge-change proposals from CPIC releases | M2.4 | A proposal PR for the signing process, not an automatic load. |
| 7 | **G3.5** real-gene golden set | M2.4, D4 | |
| 8 | **G5.1** sign-off semantics and step-up | M3.2, D4 | |
| 9 | **G5.2, G5.3, G5.4** FHIR endpoint, CDS Hooks, rendered PDF | clinical gates, P2 | |
| later | **G4.1, G4.2** narrative interpreter and rule-based verifier | D2 = B, M0.1, a BAA and model-provider decision | Shadow mode and an eval suite first. |

## 6. Decisions only the founder can make

**D1. PharmCAT or the in-house engine.**

| Option | What it means | Cost and risk |
| --- | --- | --- |
| A. Keep the in-house engine and lab-reported diplotypes (today) | No VCF calling | Nothing to build now; VCF stays "accepted, not interpreted" |
| **B. PharmCAT only as a diplotype caller for VCF input (recommended, later)** | Its output is untrusted input to the existing adapter, labelled with `callSource`; the signed-knowledge engine still produces every recommendation | New container and version pinning; CYP2D6 stays lab or external-caller sourced |
| C. PharmCAT as the full clinical core (the prompt's C2) | Replaces the engine and the verified-cell model | Creates a second source of recommendation wording that bypasses pharmacist-signed cells; discards merged, tested work |

Recommendation: **A now, B when VCF becomes a supported journey, never C.** The signed, verbatim, five-outcome model is this product's differentiator, and PharmCAT's reporter would duplicate it without that control. The prompt's PharmCAT facts (license, validation result, CYP2D6 behaviour) are unverified here and need checking before B.

**D2. Is an LLM narrative allowed in the clinical path?**

| Option | Meaning | Gate |
| --- | --- | --- |
| **A. No (recommended now)** | Fixed verbatim wording only, as today | none |
| B. Separate, labelled, non-authoritative narrative beside the verbatim recommendation | Rule-based verifier, shadow mode for the first real orders, eval suite first | M0.1 regulatory assessment, a T3 amendment in the approval tiers, a model-provider decision and an executed BAA (none exists; synthetic data only until then) |
| C. Narrative replaces the verbatim text | Contradicts "never rewritten" | Not recommended |

**D3. Billing scope.** Recommendation: **out of scope for this program.** Keep roadmap P1 (manual contract and invoice ledger) before any paid pilot and P2 (Stripe) later; carry the prompt's C6 rule (flat, tenure-based pricing, never per test or referral) into the P1 and P2 plans as a requirement, because it is a legal posture rather than a billing detail. Pulling Stripe, usage counters and API keys forward would add a large unrelated surface.

**Smaller questions (D4):**
- **Residency:** the prompt requires Puerto Rico storage. To my knowledge AWS has no Puerto Rico region; this needs counsel and an AWS check before it becomes a health-endpoint gate.
- **Genome-derived test data:** "GIAB-derived" data is real human sequence. Repository rule 4 says synthetic only. Decide whether public reference genomes are acceptable or whether goldens must be invented.
- **Sign-off meaning and step-up (G5.1):** is the reviewer's acceptance the sign-off, and does it need a per-action second factor beyond Cognito's sign-in MFA?
- **`apps/ai-service`:** keep the empty scaffold or remove it (DA-4 recommended removal).
- **Prompt citations:** the FDA guidance dates, the PharmCAT validation result, the CPIC counts and the Epic claim are unverified; one is sourced to a profile page. Verify before any of them appear in a regulatory document.

## 7. What this does NOT touch

Code, migrations, dependencies, CI, Terraform, knowledge files, the roadmap table (a later slice may add rows once decisions land), `apps/ai-service`, and every approval tier. It records no decision and authorizes no build.

## 8. How it is verified

- Every repository claim above names a file or a document; the paths were opened, and the VCF and `callSource` findings come from reading `structural-validator.ts` and from searches over `apps`, `packages`, `docs` and `knowledge`.
- A link check over this file's relative links is part of the PR description.
- **Not verified:** any statement in the prompt about FDA, PharmCAT, CPIC, Epic or FHIR guides; AWS region availability; behaviour of any slice proposed here. Nothing was run in AWS or against a model provider.
