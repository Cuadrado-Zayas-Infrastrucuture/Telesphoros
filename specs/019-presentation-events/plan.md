# Plan: presentation events (D02), rendered and acknowledged

**Status**: approved by the founder on 2026-10-29: P2 to P7 accepted as recommended. D02a is authorized, then D02b. Spec: [spec.md](spec.md). Tasks: [tasks.md](tasks.md).

## What exists (read at `main` `b7edea6`)

| Area | Today | Where |
| --- | --- | --- |
| Result rows on a production screen | **none** | the only views are `LocalReviewPage` and `LocalOperationsPage`, which print `JSON.stringify` and are mounted under `import.meta.env.DEV` only (`apps/frontend/src/app/routes.tsx:43-50`) |
| SMART pilot page | gene and phenotype rows, a FHIR preview and the source PDF; no drug results | `packages/smart-pilot/ui/SmartEvidencePage.tsx` |
| Read audit | one `security_audit_events` row per API read: route and subject id (the **evaluation** id for `GET /evaluations/:id`), written after the handler | `apps/backend/src/auth/security-audit.interceptor.ts:12-29`, migration 0016 |
| Render, view, ack or seen records | **none**: `\bviewed\b`, `\bseen\b`, `read_at`, `\bopened\b`, `rendered_at`, `displayed_at` and `shown_at` all have 0 hits | backend, frontend, smart-pilot, shared-types |
| Telemetry or beacons | none; `IntersectionObserver` is used only for landing-page animation | `apps/frontend/src/hooks/useLandingMotion.ts` |
| A per-result decision API | exists, no screen calls it | spec 006 D01b, `clinician-decisions.controller.ts` |
| Roles | `CLINICAL_READ_ROLES = reader, clinician, reviewer` on every read | `apps/backend/src/auth/clinical-read.ts:8` |

## Founder decisions

P1 was decided on 2026-10-28. P2 to P7 were accepted as recommended on 2026-10-29.

| # | Decision | Recommendation |
| --- | --- | --- |
| P1 | **Scope** (FR-01) | **Decided by the founder, 2026-10-28:** the clinical result view is a separate build. D02 ships the instrumentation only, proven on a test-only page of synthetic rows. The result view adopts the hook and the control when it is built. |
| P2 | **The exposure rule** `render-v1` | **Recorded exposure, not reading.** `exposure_threshold_met` means at least 50% of a **defined recommendation-summary region** (not a long scrolling evidence panel, which small screens could never half-show) was in the viewport, in a visible tab, for one continuous second. That is the display-advertising standard (MRC/IAB), and it is kept as a labelled baseline only. Record the continuous and cumulative visible time, the rule version and the measurement capability. Reset the interval on a change of patient, version or visibility. The pilot compares 1, 2 and 3 seconds on the same observations; no countdown is forced, and nothing is ever called "read". Intersection and visibility APIs measure geometry and tab state, not attention. Assistive-technology use gets its own tested path. **Evidence:** median alert dwell was 8 seconds (McDaniel et al., [DOI](https://doi.org/10.1093/jamia/ocv144)); 67% of inpatient alerts were closed in under 3 seconds (Elias et al., [DOI](https://doi.org/10.1055/s-0039-1700869)); 72.5% were dismissed in under 3 seconds and 13.2% in under 1 second (Wang et al., [DOI](https://doi.org/10.2196/23355)). No study validates any threshold as comprehension. Comprehension is validated separately, with clinicians on realistic English and Spanish cases, including incorrect and retracted results. |
| P3 | **Where exposures are stored** | `result_render_events` is append-only, **not** ledgered, access-controlled, integrity-monitored and under governed retention. HIPAA requires audit controls and integrity protection (45 CFR 164.312) but prescribes no ledger. Each event keeps the server receipt time, the client occurrence time, clock uncertainty, actor, patient and tenant context, the displayed content version and the event schema version. A batch hash or signed manifest is optional: it can show later modification, but not that the browser told the truth or that a person looked. If incident reconstruction will rely on exposures, the **first confirmed exposure** per actor and version is retained in the auditable store. Reviews, retractions and decisions stay in ledgered history. |
| P4 | **Delivery guarantees differ by event** | **Exposure** is explicitly lossy analytics. The first exposure is sent promptly, then duration updates are batched. Events carry unique ids, ingestion is idempotent, retries are bounded, and the queue flushes when the page hides. Any retry buffer holds opaque ids only, for a short time. No `sendBeacon`: it cannot carry the bearer token and gives no receipt. A missing exposure means **unknown**, never "not shown"; observed upload failures, ingestion lag and coverage are tracked instead. **Acknowledgements, retractions and permission changes** commit with their audit record and report success only after the server durably accepts them. The UI shows pending or failed states honestly, and never shows a review as saved when it was not. Clinical reading never depends on analytics being available. |
| P5a | **Acknowledging the exact clinical state** | A clinician-only ledger record `result_acknowledgements`. The request names the result version, the basis version and the review task. The server rechecks permission, patient context and status at commit; if any changed, it answers **409** and asks for a refreshed review. A review made **before** a retraction is kept with a clear historical label. For a result **already** retracted, the action is **"Retraction reviewed"**, never a generic acknowledgement that could read as endorsing current guidance. This follows CDS Hooks' rule that stale guidance must be replaced. Reviewing does not rerun the computation; it states which version was reviewed. |
| P5b | **What counts as one review** | Deduplicate by clinician, **immutable result version** and review task or decision episode, not "one per result forever". A material correction, a new evaluation, a relevant new input or a new decision creates a new review obligation; navigation and cosmetic changes do not. The clinical owner defines materiality and escalation times. Review, disposition (spec 006 decisions) and follow-through stay separate. In Singh et al., opening a result did not establish follow-up: follow-up was missing in 6.4% of opened and 10.1% of unopened alerts (P = .13) ([DOI](https://doi.org/10.1016/j.amjmed.2009.07.027)). |
| P6 | **Who sees the review summary** | Care-team readers with tenant-scoped authorization, a care relationship and a permitted purpose see who reviewed the result, their role, when, and whether the review covers the **current** version. A generic `reader` role alone is not enough; this is an access rule, not a patient-authorization requirement. Sponsor, payer and cross-tenant users never inherit it from a program report. Raw security logs (FHIR AuditEvent-style) stay in a separately privileged view, without IP addresses, authentication details or browsing history. |
| P7 | **Slicing** | **D02a**: acknowledgements (the migration, the API and the "Reviewed" control component). **D02b**: render capture (`render-v1`, `result_render_events`, the batch endpoint and the hook). Both are proven on the test-only page. D02a goes first because acknowledgement is the event with clinical weight. |

## Slice D02a: acknowledgements

**Changes**
- A migration for `result_acknowledgements`, numbered at build time: re-read `main`, the open PRs and other sessions' branches first. It is append-only, ledgered and FORCE RLS. Its composite key ties it to the result, evaluation and patient, as 0055 does. It is unique on `(tenant, created_by, result_id, review_task)` (P5b), has a `kind` of `review` or `retraction-reviewed` (P5a), and adds a new ledger event type.
- Routes: `POST /evaluation-results/:id/acknowledgements` (clinician) and the acknowledgements added to the existing `GET …/clinician-decisions` history, or a sibling `GET` (decided in the slice plan).
- Frontend: a `ReviewedControl` component, taking a result id and calling the route, plus a **test-only page** (mounted in the e2e build only, like the existing local pages) that lists synthetic fixture rows with ids only and no clinical text. The clinical result view is a separate build and adopts the component.

**Not touched**: the clinical result view (a separate build), the engine, evaluations, decisions semantics, the SMART pilot, `security_audit_events`, Terraform and CI configuration.

**Tests**: tenancy (404), role (403 for reader and reviewer), replay, attribution, a ledger verify, and the control's states and accessibility on the test-only page.

**Verification scenarios** (from the second research brief, synthetic fixtures):
- Two clinicians review different versions of one result. Their histories stay distinct, and the current-review status is correct.
- A retraction lands while a result is open, so the stale generic acknowledgement is refused (409) and only "Retraction reviewed" is offered.
- The patient context changes, so earlier exposure timers and pending actions are invalidated, and nothing submits against the previous patient.
- Duplicate delivery and network loss create neither a duplicate review nor a false success message.
- A sponsor or cross-tenant user cannot reach a clinic result through a report or a reused role.

## Slice D02b: render capture

**Changes**
- `result_render_events`: append-only, not ledgered. It holds episode id, result id, viewer, roles, client start and duration, server received time and `render-v1`. It is unique on `(tenant, viewer, episode id)`.
- A batch endpoint for clinical readers that validates every result id in the tenant.
- A frontend hook, `useResultRender(resultId)`, that the future result view attaches to each row. It observes the row with `IntersectionObserver` and the page's visibility state, and applies `render-v1`. It is exercised on the test-only page.

**Tests**:
- the threshold rule in a unit test with fake timers;
- a Playwright test proving a row scrolled into view for at least 1 second produces exactly one episode, and one below the threshold produces none;
- idempotent batches;
- another tenant's id refused;
- no content field accepted, because the schema is strict.

**Mutation checks** for both slices: the role check, the tenant check, the idempotency key, the threshold, and the visibility condition.

## Risks

- **Over-reading the metric.** A render proves display, not reading. Every output must say so (spec, Definitions).
- **Volume.** Renders scale with page views. They stay unledgered and get a retention period of their own, set before any real data (counsel, as part of D05 Q10).
- **Clock trust.** The client start time is kept for ordering within an episode only. Every timeliness measure uses the server's clock.

## How this was checked

The "What exists" table comes from a read of `main` `b7edea6` using `git show` and `git grep` on the paths named, with the hit counts shown. No new code, migration or test was written.
