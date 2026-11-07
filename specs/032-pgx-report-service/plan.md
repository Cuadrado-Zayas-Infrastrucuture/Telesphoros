# Implementation proposal

Status: The service design remains a proposal for clinical review. S1 synthetic contracts/fixtures are merged; S2a adds owned-local inspection of stored laboratory evidence and independent patient-link review ([bounded plan](../../docs/design/plans/pgx-structured-intake.md)). The remaining slices below require their own plans and acceptance evidence. No clinical gate is opened.

## Existing mechanisms and gaps

| Current mechanism | Reuse / gap |
| --- | --- |
| [Report adapter](../../apps/backend/src/services/report-adapter/types.ts) and [approved adapter specification](../../docs/design/report-adapter-spec.md) | Preserve accepted-text hashes, scalar offsets, independent acceptance and conservative holds. New structured import needs a separate reviewed entry point; do not reinterpret existing span packets as lab JSON. |
| [Evaluation schemas](../../packages/cpic-schema/src/evaluation.ts) | Existing laboratory call source, gene states, immutable knowledge-set identity and cell citations. No general assay manifest, context-aware rule contract or multi-report reconciliation is established by these schemas. |
| [Knowledge loader rules](../../docs/cpic-integration.md) | Preserve reviewed content hashes, verified cells, combined-table precedence and dispute holds. Add archived source snapshots and notice/conflict governance through a separate approved change. |
| [Records/corrections](../../docs/design/records-and-corrections.md) | Reuse tenant-scoped append-only ledger transactions and exact report-file versions. A lab amendment and a Telesphoros evaluation correction have different authors and meanings. |
| [Clinician decisions](../../packages/shared-types/src/clinician-decisions.ts) and [service](../../apps/backend/src/lab-reports/clinician-decisions.service.ts) | Existing decision/amendment/withdrawal chains, result/evaluation/patient binding, idempotency and current-basis checks. Assessment integration must preserve these checks and historical parsability. |
| [Follow-ups](../../packages/shared-types/src/patient-followups.ts) and [repository](../../apps/backend/src/storage/postgres/patient-followups.repository.ts) | Reuse medication/decision linkage, dated assessments, timezone/assignee reminders, version conflict checks, amendments and explicit not-assessed values. Do not build a second reminder system. |
| [Decision tests](../../apps/backend/test/clinician-decisions.e2e-spec.ts) and [follow-up tests](../../apps/backend/test/patient-followups.e2e-spec.ts) | Existing binding, retries, current basis and follow-up cases are baseline protections; new acceptance scenarios add boundaries instead of replacing them. |
| [Earlier data-products plan](../../docs/design/plans/pgx-data-model-and-data-products.md) | Retain separation of operational records and authorized secondary use. Its dated assertion that FDA guidance does not address genomic data needs fresh function-specific review using the 2026 guidance; do not carry it into this specification as a conclusion. |

The absent report-reader engine is a real gap. These contracts define what it must produce and what downstream code must refuse; a wrapper or synthetic stored result is not evidence of vendor-PDF extraction.

## Interface decision

Recommend a server-owned import/assessment boundary as sketched in [contracts](contracts/README.md). It hides source retrieval, schema checks and orchestration while keeping holds, provenance and review obligations explicit. Chat, batch import and future partner integrations should call the same authority-preserving service.

Alternative: let each caller parse lab data and construct existing `GeneInput` values directly. This is initially smaller but loses assay limitations/context and distributes identity, amendment and review logic across callers. Extending the accepted-text reader to accept arbitrary JSON would also confuse transcription with laboratory authenticity. Keep structured and PDF import implementations separate, converging only after reviewed evidence satisfies the same normalized contract. No new abstraction replaces transaction ownership or the existing ledger repository.

## Proposed delivery slices

| Slice | Concrete scope | Verification / completion gate |
| --- | --- | --- |
| S1 — Synthetic contract package | Draft strict versioned schemas and invented paired PDF/JSON examples; no real clinical content. Agree typed findings, state dimensions, amendment semantics and compatibility mapping. | Schema/semantic refusal controls, deterministic rendering, bounded resource tests; review every unsupported/missing field. |
| S2 — Structured intake and review | Version-pinned package ingestion using existing authority, acceptance and storage; immutable manifest/revision persistence via new migrations; chat confirmation view. | A01–A03, A09, A10, A15, A16; real database/S3 tiers and browser. Preserve old records and ledger hashes. |
| S3 — Contextual synthetic assessment | Snapshot medications/context, select reviewed synthetic joint rules, separate derived interpretation; link existing decisions/follow-ups; render a synthetic assessment. | A07, A12–A14, A18, A19; independently written expected values and browser checks. |
| S4 — Partner PDF reader qualification | One selected lab format at a time; authoritative finding rows, source spans and bounded parsing; preserve existing conservative adapter holds. | Synthetic layout/ambiguity/adversarial fixtures, per-field extraction accuracy and refusal cases; no scanner/OCR promise without separate qualification. |
| S5 — Content and laboratory validation | Select initial pathways/lab, freeze actual CPIC inventory, populate exact coverage rows, approve targets/translation and conflict policy. | A04–A08, A11, A13, A17; laboratory analytical evidence and independent clinical review. No live API auto-promotion. |
| S6 — Release and monitoring | Approved intended use, regulatory/data-rights review, operational acceptance, knowledge rollback and impacted-patient task handling. | Approved release checklist, full evidence bundle, delivery/review measurements and rehearsal. Real-data gates only change through explicit approval. |

Build the investor demonstration from S1–S3 using clearly synthetic content. S4 and S5 can proceed independently once the contract is agreed; clinical activation depends on both the qualified input path and approved content, not on the demo's polish.

## Decisions to settle before the affected implementation

| Decision | Recommendation | Owner / timing |
| --- | --- | --- |
| Initial medication service | Choose a narrow service based on expected patients, prescribing workflow and qualified lab; catalogue does not choose the ordered panel. | Founder + clinical lead + laboratory, before S5 scope. |
| Lab deliverable | Matching structured package/PDF with versioned manifest; qualify external PDFs separately. | Founder + lab, before partner contract. |
| Ambiguity/reflex policy | Hold affected decisions and request clarification; do not select a likely call. | Clinical lead + laboratory, before S2/S5 clinical use. |
| Interim guidance | Hold conflicting cells unless a named reviewer approves an exact, expiring exception. | Clinical lead, before S5 promotion. |
| Follow-up measurement | Retain current simple documentation first; define medication-specific instruments/time windows before claiming comparative outcomes. | Clinical lead + product, before Data Insights exports. |
| Commercial/regulatory posture | Review each intended function, source license, use purpose and jurisdiction separately. | Founder + counsel/regulatory + lab, before real-data release. |

## Data Insights linkage

Proposed event chain: issued report revision → reviewed finding → assessment/context/rule snapshot → clinician decision → separately documented medication exposure → dated follow-up. Use durable IDs and effective/recorded times. Preserve missingness, prior exposure, indication, dose, concomitant medicines and instrument versions where actually collected; never fabricate them from a decision.

First useful physician views: follow-up completion/due counts, assessment coverage/missing prerequisites, decision distributions and longitudinal patient measurements with units. Observational comparisons must disclose eligibility, denominators, follow-up windows, loss to follow-up and confounding. No efficacy claim follows from a response chart. Keep care/QI, research and commercial secondary-use permissions distinct; hashed patient IDs alone are not de-identification. This proposal adds no export or new data-use authorization.

## S2b1 bounded continuation

The [revision inspection slice](../../docs/design/plans/pgx-revision-reconciliation.md) implements deterministic duplicate/conflict and amendment-chain classification as a pure shared-contract function. It is independently branched from main and does not depend on the S2a UI branch. It supplies candidate source references for future review, never persistence, acceptance or a current clinical profile. Immutable normalized records, transactional reconciliation and assessment-impact tasks remain S2 follow-ups.

## S2b2 stored evidence continuation

The [stored-revision slice](../../docs/design/plans/pgx-stored-revisions.md) connects S2a's exact-version source verification and independent patient matching to S2b1's lineage inspector. It adds immutable, ledger-covered laboratory revisions and a read-only normalized finding view, plus save/history controls in the existing report panel. Reconciliation uses the complete bounded patient history and preserves invalidated sources as holds. An eligible chain remains only a candidate for findings review; analytical acceptance, cross-laboratory selection, assessment generation and affected-assessment tasks remain follow-ups. The owned-local synthetic gate stays in force.

## S2c findings review continuation

The [findings-review slice](../../docs/design/plans/pgx-findings-review.md) adds append-only independent decisions about stored findings and explicit resolution of conflicting stored sources, in the existing report panel. It keeps patient matching separate, rechecks evidence freshness and reviewer authority at commit, never selects or revives a source on its own, and leaves every finding's stated uncertainty unchanged. Context-bound synthetic assessments and affected-assessment review tasks remain the next slice.

## S3 synthetic assessment plan

The [S3 plan](../../docs/design/plans/pgx-synthetic-assessment.md) proposes how a stored, reviewed synthetic revision becomes a held-or-selected synthetic assessment, where it is stored, and what must change before staging can show it. It is documentation only; its four founder decisions (D1 to D4) are open, and nothing in it opens a clinical, data-rights or real-data gate.
