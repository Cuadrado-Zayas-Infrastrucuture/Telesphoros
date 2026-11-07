# Follow-up response summary: metric definition
Date: 2026-11-02

API: `GET /api/v1/followups/summary`, no query parameters. Definition: `followup-response-v1`. The clinical read roles are clinician and reviewer; scope comes from authenticated tenant membership.

| Field | Meaning |
| --- | --- |
| `definition` | Version of these counting rules |
| `asOf` | Server transaction timestamp for this live read; not a stored analytical snapshot or a user-selectable historical cutoff |
| `total` | Distinct follow-up threads with a patient currently available in this clinic, across all dates and all list pages |
| `responses.improved`, `.unchanged`, `.worsened` | Latest assessment's documented response, one count per thread |
| `responses.notAssessed` | An assessment exists but its response field explicitly says not assessed |
| `responses.noAssessment` | No document/amend assessment exists for that thread |

The five categories are exhaustive and sum to `total`. The UI's “Response documented” numerator is improved + unchanged + worsened. This is documentation coverage among recorded follow-ups, not a care-completion or success rate. A patient can contribute multiple follow-ups; patients without a follow-up contribute none. A recorded medication version is context, not evidence of dispensing or ingestion. Deleted patients are excluded; merged identities are not collapsed into patient-level units because this projection counts threads.

For each thread, select the highest-version document/amend assessment, including closed threads. A correction replaces its previous category. A subsequent reschedule or dismissal changes the reminder but does not erase the last assessment. A later assessment with response not assessed explicitly replaces the prior response in this all-time latest-value view. Idempotent retries and earlier versions add no counts. Narrative text and its redaction do not determine categories.

One tenant-bound SQL statement produces the denominator and categories from the same database snapshot. The response contains no patient/medication identifiers, names, notes or author references. The strict client contract rejects negative/non-integer counts, inconsistent totals, unsupported definition versions and unexpected fields. Failures hide the summary values and provide retry; they do not disable documentation or reminders.

Rendering uses native SVG marks and an accessible table with visible labels/counts. All bars share a zero-to-total scale. No numeric clinical endpoint is fabricated, no causal inference is made, and no Bklit dependency is needed for these five static categories. Existing branding tokens and controls are used.

Before reuse in Data Insights, define the analytical unit, cohort, observation window, validated endpoints, missingness/censoring rules, patient/episode deduplication and reproducible source versions. Use existing provenance/eligibility foundations with operational grants and disclosure controls. This live clinic summary neither creates a governed export nor changes secondary-use eligibility. Synthetic records remain demonstration data.
