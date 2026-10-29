# Feature Specification: Presentation events, when a result was rendered to a clinician and when one acknowledged it (D02)

**Feature Branch**: `docs/spec-019-presentation-events` (spec and plan only; each slice gets its own branch off `main`)

**Created**: 2026-10-28

**Status**: for the founder's review. The founder chose the two event kinds on 2026-10-28: *"rendered and acknowledged"*. Decisions P1 to P7 are in [plan.md](plan.md). Nothing is built.

**Input**:
- Spec 006: research row R12 (*engine `shown` is not presentation*); the success-criteria note that *"a decision … does not prove review before action, or that every shown result was seen. That needs D02 presentation events."*; and the founder's review: *"Engine `shown` is not evidence that a clinician saw the recommendation. Presentation and review need separate instrumentation"*, and *"minimal D02 instrumentation"*.
- The founder's 2026-10-27 report. Its own D02 section was not available when this was written. Where it would have defined event kinds, this spec follows the founder's 2026-10-28 choice instead.
- A read of `main` `b7edea6` (summarised under "What exists" in [plan.md](plan.md)).

## Why

Spec 006 can count **decisions** per eligible result. It cannot say whether a clinician ever **saw** a result, or saw it before deciding. Two facts are missing:

- **Rendered**: the result's content was actually on a clinician's screen, readable.
- **Acknowledged**: a clinician stated that they reviewed this exact result.

With both, the roadmap can measure *review before action* and *shown but never seen* honestly, separately from *decided*.

## Definitions

- **Rendered (recorded exposure).** At least half of a result's **recommendation-summary region** was in the browser viewport, in a visible tab, continuously for at least 1 second under `render-v1` (P2), for one signed-in person. One exposure **episode** per result version per person per page view; a change of patient, version or visibility starts a new interval. It is evidence of **display**, never of reading or understanding, and a missing exposure means *unknown*.
- **Acknowledged.** A clinician pressed **"Reviewed"** (or **"Retraction reviewed"** for a retracted result) on one exact result **version** for a review task. It is a deliberate act, durably recorded with who did it and when, and saved only after the server accepts it. It is neither a decision nor proof of follow-through.

Neither event says anything about the clinical decision, an order, or the patient. Spec 006's `clinician_result_decisions` stays the only record of what was decided.

## Requirements

- **FR-01 Instrumentation, not the result view.** No production screen shows result rows today, and the clinical result view is **a separate build** (founder, 2026-10-28). D02 delivers what that view plugs in: the server records and API, a render-capture hook, and a "Reviewed" control. These are proven on a **test-only page with synthetic fixture rows**, which never shows clinical content. Nothing here measures a real screen until the result view adopts them.
- **FR-02 One exact result.** Each event names the result's stored id (spec 006 D01a). The server checks that the result belongs to the caller's tenant; another tenant's id is 404, as everywhere else.
- **FR-03 Rendered is measured, not claimed.** The client reports a render only by the rule above (P2). The server stores the client's episode id, the client's start time and duration, and the server's received time. Timeliness uses the server's time.
- **FR-04 Rendered is idempotent and bounded.** The same episode id stored twice is one row. The client sends events in batches (P4), and losing a batch loses evidence, never correctness.
- **FR-05 Acknowledged is a ledger record.** Append-only and attributed, written like spec 006's decisions: the live membership decides the role, and a required `requestId` makes it idempotent.
- **FR-06 Who.** A render is recorded for any clinical reader (reader, clinician, reviewer), with the roles copied from the membership row. An acknowledgement is clinician-only (P5).
- **FR-07 No content in events.** No drug name, phenotype, recommendation text or patient label in any event. They carry ids and times only.
- **FR-08 Reads stay audited as today.** `security_audit_events` already logs each API read by route and subject id. It is not a render and is not reused as one.

## Out of scope

- The **delivered** and **opened** event kinds, which the founder did not choose.
- Eye-tracking, dwell beyond the threshold, and screenshots.
- The clinical result view itself, recommendation text on screen, and the decision form (a separate build).
- Rendering in the SMART pilot. It shows no drug results today and gets its own plan if it ever does.
- Notifications.
- Any metric code. The metrics are defined below and computed in D07.

## Metric definitions (for D07; not built here)

- **Exposure before decision**: recorded exposure before the recorded decision, for the same actor, patient, episode and version. This is a temporal association only, and an uncertain order is reported separately. It was called "seen before decided".
- **Delivered, no recorded exposure**: a result delivered without a confirmed exposure within a defined window. Known rendering failures are reported separately from missing telemetry and from ordinary navigation.
- **Acknowledged within W days**: the same denominator as spec 006's metric, with acknowledgement as the qualifying event.

Each output names the metric version, the eligibility policy, the render rule version (`render-v1`) and the window.

**Further measures (second research brief, 2026-10-28).** Each states its numerator, denominator, actor, version, window and exclusions, and keeps its rule version when a threshold changes mid-pilot:
- **Review completion:** current review tasks with a durable acknowledgement, over eligible tasks. This is explicit review, not acceptance of the recommendation.
- **Follow-through:** required actions completed within the assigned clinical interval, kept separate from acknowledgement.
- **Safety:** use of stale or retracted versions, unresolved correction tasks and wrong-patient attempts, each investigated with severity and denominator.
- **Instrumentation:** observation coverage, ingestion lag, duplicates and clock uncertainty. These decide how far the exposure metrics can be trusted.

If H1 claims that decision support improves decisions, exposure cannot test that. The test needs an adjudicated decision-quality endpoint and a comparison design, written down before its success criterion is approved.

**Display is not relevance.** The literature measures CDS quality through relevance and response, not display alone:
- Ray et al. (2026) found only one operational definition of alert fatigue across 22 systematic reviews. They recommend a sustained drop in appropriate response rates from an established baseline ([DOI](https://doi.org/10.1093/jamia/ocag064)).
- Carli et al. report alert positive predictive values of 8% to 83%, mostly 20% to 40%, and say PPV must be reported by alert type ([DOI](https://doi.org/10.2196/medinform.7170)).

So D07 should pair these display metrics with relevance metrics, measured against a baseline and per result type: the mix of decisions and their reason codes from spec 006. A high render rate alone is never evidence of a useful recommendation. (These papers were retrieved from PubMed, and each DOI was checked against its PubMed record on 2026-10-28.)
