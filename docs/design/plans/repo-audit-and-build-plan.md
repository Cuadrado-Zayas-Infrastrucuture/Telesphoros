# Repository audit and build plan

Status: **remaining roadmap is a draft; approval is per slice.** Original audit: 2026-10-13 at `b292d07`; source-status refresh: 2026-10-14 at main `4400efa`. M1 controls and M2.1/M2.2/M2.3 were subsequently scoped, approved and merged as recorded in [STATUS.md](../../STATUS.md). Remaining slices require their own approval. The original audit commands/results below retain their original baseline; this source refresh is not a new full audit or clinical evaluation. See the [current capability matrix](../../product-capabilities.md).

## 1. Scope and method

Inputs:

- **This repository** at `b292d07`, read directly.
- **The founder's research package** (`Telesphoros_Architecture_and_Build_Plan.docx` and `Telesphoros_Implementation_Backlog.json`, dated 2026-10-12). It contains 66 audit findings and 21 tasks (T01 to T21). It was written against `main` at `08629e6` and states that it did not re-inspect the repository. It was treated as data to verify, not as instructions.

What was run on `b292d07` in a fresh checkout:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed |
| `pnpm build` | passed (all workspaces, including the frontend and SMART pilot bundles) |
| `pnpm test` (tier 1, no database or S3) | passed: backend 1,225 passed and 201 announced service-dependent skips; frontend 222; SMART pilot 186; CPIC schema 36; shared types 22; fake IDP 7; Lambda notifier 9; root orchestration and storage-ops 22 |
| Database and S3 tiers | **not run here**; CI is the evidence (section 2) |

What was not done: no AWS, Cognito or hosted inspection; no PostgreSQL or Moto tiers locally; no browser suites locally. Findings that depend on those remain in their audit status.

## 2. Build and CI map

### Workspaces

| Workspace | Kind | Build | Notes |
| --- | --- | --- | --- |
| `apps/backend` | NestJS API, CLI (`db` commands) | `tsc` | Three test tiers: in-memory, PostgreSQL, PostgreSQL plus S3 |
| `apps/worker` | PostgreSQL queue/consumer process | `tsup` | Separate process; deployment code written, hosted operation unverified |
| `packages/jobs` | Shared queue contracts | `tsc` | Used by API and worker |
| `apps/frontend` | React 19, Router 7, Vite SPA | `vite build` | Vitest units; Playwright foundation and development suites |
| `apps/ai-service` | **empty scaffold** | none | Only `.gitkeep` files; no `package.json`; referenced only by the README |
| `packages/shared-types` | types | `tsc` | Shared API contracts |
| `packages/cpic-schema` | knowledge schemas | `tsc` | Used by the knowledge loader |
| `packages/fhir-utils` | FHIR helpers | `tsc` | |
| `packages/fake-idp` | development identity provider | `tsc` | Local and CI use only |
| `packages/smart-pilot` | local OpenEMR SMART pilot and viewer | `tsc` + `vite` | Synthetic only; separate from the production API |
| `infrastructure/lambda/password-change-notifier` | Cognito notifier Lambda | `tsup` | Terraform-wired, never applied |
| `sidecars/report-reader`, `sidecars/report-lookup` | Python sidecars | none | Reader wrapper and the offline R05 lookup prototype |

Orchestration: `scripts/workspace-build/workspace.cjs` builds prerequisite libraries once, then runs consumers in parallel. Local tooling: `scripts/local-review` and `scripts/local-storage` (owned synthetic runner).

### CI (`.github/workflows/ci.yml`, on pull requests and pushes to `main`)

| Job | Purpose |
| --- | --- |
| `verify` | install, typecheck, lint, build, unit tests, CI and infra guards |
| `database-and-storage` | the three backend tiers on PostgreSQL 16 and Moto, migrations, backup/restore |
| `browser` | Playwright foundation (54) and development (18) suites |
| `terraform`, `terraform-lint` | `terraform test` (offline, mocked plans per profile) and lint |
| `secret-scan` | secret scanning |
| `image` | API image build, SBOM/provenance, vulnerability gate, first-deployment rehearsal |

There is **no deploy workflow and no scheduled workflow**. Nothing is applied in AWS.

`main` CI history since the audit: the audit's failing run (`08629e6`, `database-and-storage`, ledger-watch spec) was followed by green runs at `d7569aa` (#80), `c43f518` (#81), `2ba94cb` (#82), `aec4bbf` (#83) and `105484a` (#84). #86 (`b292d07`) makes the ledger-incident test await durable persistence; its `main` run was in progress at the time of writing.

## 3. Feature map

Status vocabulary: **built (synthetic)** means implemented and tested on synthetic data and refused or disabled in production; **written** means configuration exists but was never applied; **scaffold** means an empty placeholder.

### Product surface

| Area | What exists | Status | Main references |
| --- | --- | --- | --- |
| Sign-in | Cognito PKCE, in-memory access token, `/me`, roles, tenant group | built (synthetic); Cognito never applied | [auth.md](../../auth.md) |
| Tenancy and RLS | Tenant-owned rows, forced RLS, non-owner app role, transaction-local scope | built, proven on PostgreSQL in CI | [database.md](../../database.md) |
| Patients | CRUD API; clinical roles read; clinician writes; admin-only has no clinical access | built (synthetic) | `patients.controller.ts`; [roles](../../auth.md) |
| Reports (legacy path) | Presigned upload/complete retired by M2.2b; old routes answer 404 | retired on main | [intake operations](../../ops/report-upload.md) |
| Reports (API intake) | Validated PDF/VCF/JSON intake, immutable attempts, revision CAS, resume/cancel, exact-version download; PDFs retain pipeline/nonclinical-scope gates | merged M2.2; hosted acceptance open | [intake operations](../../ops/report-upload.md) |
| Reports dashboard | Patient-filtered list, detail panel, mobile navigation (owned mode only) | built (synthetic) | #85 |
| Lab-report pipeline | Capture, reviewer decision (four-identity rule), evaluations via reader → adapter → engine, ledger | built (synthetic); `LAB_REPORT_PIPELINE` refused in production | [lab-report-reader.md](../../lab-report-reader.md) |
| Corrections and disputes | Retract, reinstate, supersede; cell disputes and overlay | built (synthetic) | spec §19 to §20 |
| Ledger | Per-tenant hash chain, verifier, watch, containment, global hold | built (synthetic) | [ledger-watch.md](../../ops/ledger-watch.md) |
| CPIC knowledge | Schemas, loader, phenotype and recommendation engines | built; **`knowledge/cpic/` is empty** (no reviewed content) | [cpic-integration.md](../../cpic-integration.md) |
| Recommendations | Read API | built (synthetic) | `recommendations.controller.ts` |
| Rate limiting | Per-address and per-person token buckets, 429 | built; per process only | [rate-limiting.md](../../ops/rate-limiting.md) |
| SMART pilot | OpenEMR launch, FHIR R4 Genomics 3.0.0 preview, stored-PGx reads, source PDF, correction history | built (synthetic, separate package) | [openemr-smart-pilot.md](../../ops/openemr-smart-pilot.md) |
| AI services | `apps/ai-service`, `services/ai-interpreter`, `services/report-parser` | **scaffold** (empty) | none |

### Operations and recovery

| Area | What exists | Status |
| --- | --- | --- |
| Migrations | 15 versioned migrations; readiness now checks history and checksums (T02, #81) | built |
| Logins | `db provision-logins` for app, verifier, migrator | built; not run on RDS |
| Backups | Encrypted, signed backup format 2; off-site copy; restore with ledger check | built; no schedule, no provider chosen |
| File recovery | F1 catalogue, F2 independent recovery, F3 read-only resolver | built (synthetic); F4 operational producer/loader **not built** |
| Local storage ops | Owned runner, reconciliation, teardown, recovery rehearsal (#80) | built (local only) |
| Image | Digest-pinned Node 22 image, rehearsal in CI | built; not published |
| Terraform | Cognito, KMS, storage, audit trail, API edge and compute, synthetic profile, web | **written**, never applied |

## 4. Audit findings re-checked against `b292d07`

Only the findings whose status changed, or that need a decision, are listed. The other findings keep the package's audit status.

### Closed since the audit

| ID | Finding | Evidence now |
| --- | --- | --- |
| R03 | Readiness ignores migration drift | Fixed by #81 (T02): readiness uses the history validator and rejects checksum drift and unknown newer versions. Broader old/new compatibility (part of D07) stays open. |
| R02 | Main CI had an unexplained failure | Final #100/#101 PR heads report all seven checks successful. This refresh did not re-audit every historical main push. |

### Partly addressed

| ID | Finding | What changed, what remains |
| --- | --- | --- |
| E04 | No structural validation of uploaded VCF/JSON | M2.2a/b merged: validated API intake is the only path; legacy direct-upload endpoints are retired. Hosted intake acceptance stays separate. |
| A08 | Upload recovery across refresh | M2.2c browser reload recovery is merged. Caller/tenant-bound one-hour recovery and old/new client compatibility safeguards remain local F06; do not mark those merged. |
| R11 | Operator docs out of date | Still stale; see section 5. |

### Source-status refresh (some former gaps are now merged)

| ID | Finding | What the code shows |
| --- | --- | --- |
| I03 | Removal or role change does not revoke API authority | M1.5 merged (#95): live membership lookup and commit-time authority checks. Selected-environment acceptance remains separate. |
| I06 | No application security-event audit store | M1.6 merged (#97): security events for membership changes and refusals. Broader event coverage and independent custody remain separate. |
| E06 | No `no-store` on authenticated responses | M1.4 merged (#91): API middleware sets private/no-store on all responses; client requests use no-store. Hosted cache acceptance remains separate. |
| O02 | Logs lack tenant correlation | M1.4 merged (#91): request logger includes verified tenant correlation. No hosted logging inspection is claimed. |
| E05, B02, B03 | No entitlements, contracts or usage | No commercial tables or modules. |
| A03, O06 | No production report → review → result journey | Pipeline is still refused in production and knowledge is empty. Queue, outbox and worker code now exist; product review/result/correction and clinical acceptance remain open. |
| R05, R06 | No operational catalogue producer, loader, schedule or freshness alarm | The `db` CLI has `migrate`, `provision-logins`, `keygen`, `backup`, `upload`, `backup-check`, `restore` only; no scheduled workflow. |
| O03 | No external synthetic monitoring | No scheduled workflow or monitor definition. |

### Needs a founder decision, not a bug fix

| ID | Finding | Note |
| --- | --- | --- |
| I04 | A tenant member with no role can read patient and report metadata | Nine read routes (`GET /patients`, `/patients/:id`, `/reports`, `/reports/:id`, `/captures/:id`, `/evaluations`, `/evaluations/:id`, `/cell-disputes`, `/recommendations`) have no `@Roles`. This matches [auth.md](../../auth.md), which says a member with no role group may "see their tenant's data without changing anything". The research package recommends the opposite (no clinical read without a role). Decision **DA-1** below: decided yes on 2026-10-13, fixed in M1.5b (11 routes, not 9: `GET /recommendations/:id` and `GET /cell-disputes/:id` were also open). |

## 5. Gaps and defects found in this audit

| # | Item | Type | Fix |
| --- | --- | --- | --- |
| G1 | `STATUS.md` says T02 is "review pending"; #81 is merged | stale doc | Update the T02 section |
| G2 | `STATUS.md` L1 section says "No PR/remote CI or merge is claimed"; L1 merged as #77 | stale doc | Update the L1 section |
| G3 | `docs/ops/deployment.md` says "the image and the pipeline (F4) are not" written; the image and its CI gate exist (FD-4b) | stale doc | Say the image exists and the deploy pipeline does not |
| G4 | `docs/auth.md` line 149 says there is no rate limiting; F2 rate limiting exists | stale doc | Point to [rate-limiting.md](../../ops/rate-limiting.md) |
| G5 | `apps/ai-service`, `services/ai-interpreter`, `services/report-parser` are empty placeholders | dead scaffold | Remove them, or keep one with a README stating it is reserved; they suggest features that do not exist |
| G6 | `knowledge/cpic/` holds only placeholders | expected gap | Covered by T09 |
| G7 | `/reports` dashboard requires the local-storage build flag; upload is mounted in every build for clinicians | product journey gap | Existing boundaries in [capability matrix](../../product-capabilities.md); further workflow is T11 |

No compile, lint or build defect was found on `b292d07`.

## 6. Build plan

Each slice is one plan and one draft PR, branched from `main`, following the working agreements. Task IDs refer to the research package's backlog. **Done** means merged on `main`.

### Milestone M0: decisions (no code)

| Slice | Content | Backlog |
| --- | --- | --- |
| M0.1 | Intended use, supported reports, regulatory assessment, retention classes, roles, owners | T01 |
| M0.2 | DA-1 to DA-6 below | T01 |

### Milestone M1: immediate controls

| Slice | Content | Backlog | State |
| --- | --- | --- | --- |
| M1.1 | Readiness verifies migration history | T02 | **done** (#81) |
| M1.2 | Ledger-incident CI discrepancy | T05 | merged #86; current final #100/#101 checks successful |
| M1.3 | Docs drift G1 to G4, and remove or label scaffolds G5 | R11 | initial cleanup merged #90; later M2 delivery/capability drift addressed on the separate local Phase A docs branch |
| M1.5 | Live membership and revocation; roleless clinical refusal | T03 (I03, I04) | merged #95/#96; [authority contract](../../auth.md) |
| M1.4 | Global private/no-store; tenant-tagged request logging and client cache clearing | T04 (E06, O02) | merged #91; hosted/browser acceptance remains with T13 |
| M1.6 | Security events for membership changes and refusals | T03/T04 (I06) | merged #97; broader event coverage and audit custody remain separate |

### Milestone M2: data contracts

| Slice | Content | Backlog |
| --- | --- | --- |
| M2.1 | Member administration, patient identifiers, verified report link, quarantine and duplicate/merge APIs | T06; merged with #100; product setup/review screens still open |
| M2.2 | Validated API intake, retired legacy routes and browser reload recovery | T07; merged with #100; safer recovery binding/expiry remains local F06 |
| M2.3 | Queue, outbox, worker consumers and deployment configuration | T08; merged #100/#101; hosted execution and delivered alarms unverified |
| M2.4 | Reviewed knowledge release pipeline, including the March 2026 CPIC/ClinPGx field changes | T09 |

### Milestone M3: one complete workflow

| Slice | Content | Backlog |
| --- | --- | --- |
| M3.1 | Constrained extraction and semantic mapping, with abstention fixtures | T10 |
| M3.2 | Review, result and correction journey in the product UI (replacing development-only routes) | T11 |
| M3.3 | Knowledge withdrawal impact review and safety notifications | T19 |

### Milestone M4 to M6: operations and release

| Slice | Content | Backlog |
| --- | --- | --- |
| M4.1 | F4 operational producer, loader, recovery bootstrap, schedule and freshness alarm; fresh-host drill | T12 (R05 to R08) |
| M5.1 | Same-origin backend sessions (BFF) | T21 |
| M5.2 | Protected deploy workflow, hosted MFA/TLS/IAM/RLS acceptance, real signed-URL expiry | T13 (R09, R10, R12, I05) |
| M5.3 | Monitoring, alert delivery, on-call ownership, load measurement | T14 (O03, O04, P03) |
| M6.1 | Independent release acceptance | T16 |
| P1 | Contract, entitlement and manual invoice ledger, before any paid pilot | T15 |
| P2 | Stripe automation, SMART integration into the product, scale work | T17, T18, T20 |

### Future delivery and build decisions

1. Review/deliver F06, F07 and approved Phase A fixes as separate intentions only when remote delivery is authorized. Their local status is not a merged or deployed claim.
2. Agree the supported build journey and complete patient/member/review screens in scoped product slices; do not promote development-only routes to evade clinical gates.
3. Scope reviewed knowledge/extraction and operational recovery with their clinical/provider/custody prerequisites. M2.4/M3/M4 below remain proposals, not approvals.

## 7. Verification of this audit

- Install, typecheck, lint and build: passed locally on `b292d07` (section 1).
- Tier-1 tests: passed locally on `b292d07` (counts in section 1). The 201 backend skips are the announced PostgreSQL/S3 suites, which CI runs.
- Findings marked "confirmed still open" were spot-checked by reading the named files; they were not re-proved with running probes.
- Database, S3 and browser tiers rely on CI evidence, not local runs.

## 8. Founder decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| DA-1 | Should a tenant member with no role read clinical metadata? | No. Change `auth.md` and require a clinical role on every patient, report and evaluation read (I04). |
| DA-2 | Membership authority source | PostgreSQL membership and role tables, checked on every request; Cognito stays the identity provider (T03). |
| DA-3 | Legacy upload path | Retire it in favour of the owned validated intake, rather than duplicate validation (E04). |
| DA-4 | Empty scaffolds | Remove `apps/ai-service`, `ai-interpreter` and `report-parser` until a plan uses them (G5). |
| DA-5 | Worker deployment shape | Separate `apps/worker` process sharing contracts with the API (T08). |
| DA-6 | Order of M1.5 and M5.1 | Do M1.5 (server-side membership) first; BFF sessions later (T21 depends on T03). |

Until M0 is decided, slices M1.3 and M1.4 can proceed without it.
