# Physician workspace: chat and patient record

Date: 2026-11-02

Founder direction: the primary clinical interface is chat. The patient record is the only separate clinical page. Patient creation, demographics, medications and follow-up documentation belong there. Report attachment opens a small details form over chat and uploads only after confirmation. Outcomes mean easy follow-up documentation, with reminders so physicians do not forget. Recommendation decisions can be recorded alongside follow-up (founder clarification in this session).

## Physician flow

1. Open chat, select the patient and continue the conversation.
2. Attach or drop a report. A compact dialog shows the file, patient, optional note and the currently required synthetic confirmation. No patient-demographic form inside the chat. Confirm upload; show progress, errors and the report's status in the conversation.
3. Choose a patient in the sidebar to open their record. Add patient opens the same record in creation mode, with demographics first. Save once, then add medications on that record.
4. On the patient record, use compact sections for Patient information, Medications and Follow-up. Show the next due date and one obvious **Document follow-up** action. Keep recent entries readable; open details, history or corrections on demand.
5. Return to the same chat without losing an unsent report or question. Report history and account preferences should open panels over chat. They should not become additional physician workflow pages.

## Follow-up documentation and reminders

Make the common task a short form, with patient, date and relevant treatment already selected where known. Ask for treatment response, side effects and a short note; support “not assessed” rather than forcing a clinical conclusion. Optional details expand on demand. Recommendation decisions are an optional linked part of the entry: exact recommendation/version, accepted/declined/deferred and reason. Author and time are recorded automatically. “Reviewed” alone is not acceptance or a treatment outcome.

At the end, choose **Next follow-up** using a date picker and convenient relative-date shortcuts. The physician chooses the interval; the product does not infer a clinical schedule. Require either a next date and responsible clinician or an explicit **No further follow-up needed** choice. Do not silently omit a reminder when the physician has selected a due date.

**Save follow-up** records the note, completes the current task and schedules the next reminder together. Scheduling the first follow-up should also be available after a treatment change or recommendation decision, without re-entering the patient's information. Due dates use the responsible clinician's configured timezone and display it where a time is requested.

The initial delivery channel is in-app: a compact **Follow-ups** area in the chat sidebar with **Due today** and **Overdue** counts, plus the due state on the patient record. It opens a panel, not another clinical page. One click opens the correct patient's follow-up form. Offer **Document**, **Reschedule** and **Dismiss with reason**; merely opening or reading a reminder does not complete it. A completed entry removes the old reminder and shows the next due date. Overdue items remain visible until resolved, without generating an alert on every page load.

Reminders belong to a named clinician and remain visible to appropriately authorized clinic staff for coverage. Removing that clinician from the organization must surface unassigned follow-ups for reassignment, not silently lose them. Email or push delivery can be enabled later through an explicit clinic preference; the MVP plan does not assume those channels are connected or deliver messages outside the application.

The existing demographics and medication services can support their current sections. Follow-up notes, tasks and reminders need a durable, tenant-scoped API/schema and versioned corrections; recommendation decisions must bind to actual stored results. The repository has a PostgreSQL queue/outbox and worker, but no physician follow-up reminder handler or notification UI was found in this inspection. Reuse that scheduling foundation with transactional scheduling, idempotent delivery and retries. Recheck task state before emitting a reminder so completion or rescheduling prevents stale alerts. The due/overdue list must remain accurate even if background notification delivery fails. Review acknowledgements are not a substitute. Do not simulate a saved note, silently store clinical notes in browser storage or infer a decision from a chat answer.

## Optional AI assistance for follow-up notes

Founder direction: inference may assist with documentation, while the product's core workflows remain usable without it. Patient records, medication capture, report upload, manually written follow-up notes, reminder scheduling and due/overdue lists must not depend on a model call.

Keep a normal note editor as the default. Offer an explicit **Help write note** action for converting the physician's rough notes into a concise draft. The physician can select the relevant existing patient-record context; show what will be included before requesting a draft. Start with organization, rewriting and summarization of supplied information. Dictation/transcription is a separate future input capability, not assumed to exist in this slice.

Show the result as an **AI-assisted draft**, with **Use draft**, **Edit** and **Discard** actions. Keep the original physician text available so they can compare or restore it. Inserting the draft into the editor does not save, sign or complete the follow-up. The physician reviews and explicitly saves the final entry through the ordinary follow-up workflow.

The draft must preserve uncertainty, negation, chronology, who reported a fact, and exact medication names/doses from the selected source. Missing information stays missing; the model must not fill in examinations, adherence, side effects, diagnoses, decisions or treatment plans. Unsupported output is withheld or clearly flagged for review, never presented as a verified clinical fact. Human review remains necessary; automated checks are not a guarantee of factual accuracy.

Example: rough note “pt reports less nausea, missed 2 doses; review in 2 weeks” can become “The patient reports less nausea and two missed doses. Follow-up is planned in two weeks.” It must not become “Medication tolerated well; adherence good” or invent an examination. The interval in text is not a scheduled reminder: the physician confirms the date in the structured follow-up control, and the ordinary application code schedules it after save.

If inference is unavailable, times out or reaches its budget, retain the original note and keep manual save and scheduling available. Retry must not overwrite edits made while generation was running. Stale drafts must be explicitly reconciled with newer patient context. AI may not save a clinical record, accept a recommendation, complete a task or schedule a reminder on its own.

Implementation is a separate optional task in the existing inference architecture, with bounded input/output, deadlines and usage accounting. Follow the repository's [model-path requirements](../../ai-safety-and-hallucination-controls.md), including data/output classification, an actual output guard on the serving path, evaluation before prompt/model changes and an explicit retention policy. Do not enable a provider, send patient text or incur inference spending through this documentation change.

Acceptance includes synthetic examples with missing information, contradictory notes, negations, copied instructions in source text, exact dose preservation and unsupported additions. Verify physician edits survive a late response; Use draft does not save; Discard restores the original; and the complete manual documentation/reminder path works with inference disabled or failing. Capture model/prompt provenance of accepted assistance under the record's audit policy without placing note text in operational logs.

## Delivery and acceptance

The initial intake-dialog work established attachment → details → confirmed upload → conversation status. It removes the ordinary Upload page navigation item. The subsequent frontend consolidation removes label-only creation from chat, moves creation/demographics to `/patients/new`, and keeps the conversation mounted while patient records or panels are open. The legacy upload route remains available inside a panel for existing recovery links; its compatibility form still exists. Durable follow-up and AI assistance are not implemented by these frontend changes.

Frontend acceptance now covers patient creation on the patient page, unsent chat draft preservation, and report/history/settings navigation as panels. Existing recovery links open their compatible form in a panel, preserving resume/cancel behavior. Full migration of that legacy form into chat intake remains a follow-up.

Execution detail (founder instructed “continue”): use a shared signed-in workspace layout to keep the conversation in memory while the patient route is open; clear it on sign-out and explicit New chat. No draft file or note is serialized to browser storage. `/patients/new` reuses the existing demographic creation workflow and its retry identities, then opens the created record. Sidebar and attachment controls navigate there. Patient selection remains in the upload dialog; patient creation is removed from that dialog. This frontend slice uses the existing patient APIs. Durable follow-up/reminders follow as a separate schema/API slice under the same approved product direction.

The follow-up slice adds storage contracts and a new numbered migration with a down file, API authorization, idempotent writes, history/corrections, assigned tasks, reminder scheduling and patient-page controls. Verify with real PostgreSQL, cross-tenant/role checks, retries and stale changes. Control the clock to test due/overdue boundaries, timezone changes, completion racing delivery, rescheduling, duplicate jobs and an unavailable worker. Save the note and next reminder atomically; record nothing as saved until the server confirms it. A clinical content change or deployment remains separate.

End-to-end acceptance: create a synthetic patient with information, add a medication, return to chat, attach a report, complete details, upload, return to the same patient, record a decision and a follow-up note, set the next date, reload and verify the history and scheduled task. Advance a controlled clock and verify the due reminder; open it, document follow-up, and verify the old reminder closes and exactly one next reminder exists. Verify rescheduling prevents the previous alert and overdue work survives a worker restart. Repeat at mobile and desktop widths, including validation errors and interrupted upload recovery. No additional separate clinical page should be needed.

## Usability iteration (2026-11-02)

Founder instruction: iterate until the workflow/UI are smooth, then assess Bklit charts. Continue the local frontend slice; publication remains unapproved. First reproduce and fix attachment-specific confirmation, same-file reattachment, and the misleading interpretation-unavailable reply to an upload note. Keep report notes in the conversation with their upload, without representing them as durable follow-up documentation. Make patient selection and sidebar rosters page beyond the first 20 records, retain the selected patient, and keep primary sidebar actions reachable with long lists. Use existing UI tokens, native controls, real APIs and synthetic fixtures. No schema, clinical inference or external publishing.

Acceptance: failing then passing behavior tests, actual-storage browser checks at mobile/desktop widths, keyboard/accessibility checks, realistic rosters, failed/retried page loads, explicit confirmation for each replacement file, and no upload caused by navigation or attachment selection. Review chart documentation only after this workflow pass; recommend charts for actual supported data and distinguish future outcome charts that need structured observations. Do not add decorative or fabricated clinical charts.

## Chart fit after the usability pass (2026-11-02)

Reviewed Bklit's component documentation after the desktop/mobile workflow pass. The supplied [candlestick gallery](https://bklit.com/charts/candlestick-chart) could not be retrieved by the web tool; its [component documentation](https://bklit.com/docs/components/candlestick-chart) was accessible. This is a design/dependency assessment, not a rendered Bklit integration or accessibility certification. No chart package was installed.

| Component | Placement and purpose | Decision and data prerequisite |
| --- | --- | --- |
| [Line chart](https://bklit.com/docs/components/line-chart), optionally with [date markers](https://bklit.com/docs/utility/markers) | Patient record, below follow-up documentation: one measured outcome over time; dated medication changes can provide context | Best first clinical chart, once structured, dated observations with a consistent metric/unit exist. Free-text notes alone do not produce a numeric trend. Show actual observations, gaps and source links; medication markers do not establish causation. |
| [Sparkline](https://bklit.com/docs/components/sparkline) | Small patient-context card inside chat, opening the full patient chart | Optional second presentation of the same observations, with a visible latest value, unit and period. Its compact axis-free form is a summary only; numerical details must remain available without hover. |
| [Horizontal bar chart](https://bklit.com/docs/components/bar-chart) | Follow-ups panel over chat: counts by overdue, due today and upcoming, or completed follow-ups by week | Useful after durable task storage and complete scoped aggregates exist. Start with actionable text counts and a due list; three counts alone do not need a chart. Never count just the loaded roster page as the clinic total. |
| [Calendar heatmap](https://bklit.com/docs/components/heatmap-chart) | Optional expanded follow-up history: documentation activity by day | Later, only if physicians need this overview. Activity is neither treatment effectiveness nor medication adherence; distinguish no observations from zero activity. The due list remains the main reminder interaction. |
| Candlestick | No placement in this MVP | The component requires date/open/high/low/close. Patient notes, genotype categories and recommendation decisions have no such meaning. Do not invent this structure to reuse a visually appealing chart. |

Keep charts inside chat cards or the patient record; no additional analytics page. A dated medication/follow-up event list is more useful than a chart before repeated measurements exist. PGx phenotypes and recommendation holds remain explicit textual categories. Do not turn them into a composite score, a gauge, a radar profile or an implied probability. Area, pie, funnel and Sankey presentations add little to the immediate physician task.

For any later integration, retain the existing Inter typography, opaque surfaces and approved tokens. Use labeled axes/units, a visible period and text summary, plus an accessible table or list. Preserve missing values as gaps; never interpolate a clinical conclusion, auto-generate a reference range or silently convert incompatible units. Keep observations readable at 375px and 1280px, test keyboard/touch access and reduced motion, and keep chart failures independent of saving notes/reminders. Avoid decorative glow, 3D bars and continuously animated axes.

Bklit's [repository](https://github.com/bklit/bklit-ui) identifies the chart components as MIT and Studio as proprietary; use only the components and retain their license notice. Its [2026-10-31 change](https://bklit.com/changelog/2026-10-31-built-on-d3) replaces visx with direct d3 modules, so older dependency lists are stale. Components are copied through the shadcn registry: inspect/pin the actual source and dependencies, adapt tokens without reinitializing this application's existing UI, and verify production chunk size and accessibility before adoption. A small isolated line-chart implementation is the appropriate first integration after follow-up observations are available.

## Physician documentation as the source for Data Insights (2026-11-02)

Founder direction: collect and analyze useful data for the second product, Data Insights. Build the collection into ordinary care documentation. The initial buyer/use case remains to be selected; the common foundation below supports clinic operations, PGx research and program evaluation without assuming all audiences receive the same data. This section records requirements, not an enabled collection/export service.

### Reuse the existing foundation

Source inspection finds versioned evaluation/result identities and knowledge provenance, clinician result decisions (`cdr-v1`), result acknowledgement/render contracts, and versioned medication records. See [spec 006 research](../../../specs/006-clinician-decision-records/research.md), [decision delivery](../../status/2026-10-28-clinician-result-decisions.md), [acknowledgements](../../status/2026-10-29-result-acknowledgements.md) and [render capture](../../status/2026-10-29-result-render-capture.md). The earlier draft's claim that decision storage is absent is historical; patient-page integration is still missing. Reuse the approved five-response vocabulary and correction history rather than adding a second accepted/declined system.

The current medication contract stores RxCUI, drug-list version, active/stopped, optional start/stop **month**, and clinician-entered/patient-reported source. It does not establish dose, indication, exact treatment start, dispensing or ingestion. Month precision must not be expanded into an invented day. Follow-up observations, treatment episodes and reminder delivery need new durable contracts.

### Minimum useful capture

| Record | Capture during the physician workflow | Useful analysis |
| --- | --- | --- |
| Treatment context | Indication and treatment goal; relevant baseline measure with unit/instrument/version; medication and relevant concurrent treatment | Define comparable treatment episodes and baseline severity |
| Curated PGx evidence | Exact report/result, gene/phenotype, assay coverage or explicit unknown, evidence state, knowledge and engine versions | Describe actionable findings among appropriately tested/evaluable records; preserve held and unsupported results |
| Recommendation decision | Existing accepted/modified/rejected/deferred/clarification-requested response, approved reason/change codes, exact result and decision time | Measure documented decisions and reasons, without inferring implementation |
| Treatment actually reported | Medication started/changed/stopped, dose/regimen when needed, effective date and its precision, source; link to the decision only when supported | Distinguish intent from reported treatment and describe treatment changes |
| Follow-up observation | Assessment date, treatment episode, response, adverse symptoms and severity, adherence when assessed, relevant repeated measure, source and optional narrative | Describe observed changes and tolerability over a defined follow-up window |
| Follow-up task | Due date, assignee, completed/rescheduled/dismissed status, reason and linked documentation | Calculate follow-up coverage, delay and missingness |

Use clinical-owner-defined, versioned endpoint templates for each initial indication. A general “better/same/worse/not assessed” response can support documentation, but is not interchangeable with a validated score or a universal treatment-effect endpoint. A reported adverse symptom is not automatically attributed to a drug. Unknown, not assessed, declined and lost to follow-up must remain distinguishable from an observed negative finding.

The physician-facing form should prefill patient, treatment and relevant recommendation from confirmed records; ask only applicable follow-up questions; expand secondary detail on demand; and save documentation plus the next task together. Do not require every analytic field at every visit. Medication changes should offer scheduling a baseline/follow-up assessment. Manual completion remains fully usable without inference. AI may propose note wording or structured fields from supplied text, but only clinician-confirmed values enter the clinical/analytic record, with their origin retained.

### First metrics and charts

1. **Follow-up completion:** documented tasks divided by eligible tasks due in a stated period, with overdue, rescheduled, dismissed and unavailable outcomes separately visible. Historical due dates must survive rescheduling. Use a due list plus optional bars.
2. **Decision distribution:** latest valid clinician response per exact result at the analysis cutoff, alongside no recorded decision and known display/acknowledgement coverage. Use labeled bars. A render proves display only; acknowledgement and decision remain separate events.
3. **Observed outcome trajectory:** paired baseline/follow-up values for the same measure, unit and treatment episode in a predefined window. Show the paired count, total eligible count, missing follow-ups and relevant treatment changes. Patient view uses a line chart; aggregate analysis reports distributions and uncertainty, not only an average.
4. **Time to documented treatment change:** only where a supported treatment-change record and adequate date precision exist. State the starting event, follow-up cutoff and censoring rule. Current month-only medication data cannot support a days-to-change metric.
5. **Evidence/data completeness:** evaluable versus held/unknown results and follow-up coverage. Genotype/phenotype prevalence must use assay coverage and callable denominators, not all uploaded patients.

Analyses must specify the unit counted (patient, treatment episode, result or task), deduplicate retries, account for corrections/merges, pin input versions and definitions, and distinguish occurred-at from recorded-at time. Include eligible patients without observed outcomes so a chart cannot silently select only successful follow-ups. Observational comparisons require attention to indication, baseline severity, concomitant treatment and selection/missingness; they do not by themselves establish that PGx caused improvement. Synthetic fixtures never enter empirical summaries.

### Two uses of the same governed record

Physician charts read authorized patient records inside the clinic boundary. Data Insights uses a separately governed analytic preparation layer with internal lineage, then purpose-specific aggregate releases. Preserve the updated spec 006 approach: internal source references support corrections and reproducibility; externally released outputs use appropriate disclosure controls, including cumulative-query risk. Source reconciliation: migrations 0062/0063 already implement provenance and purpose-specific grants, validation, withdrawal, restrictions, tenant terms and the synthetic-only eligibility function. Operational grant management and controlled release remain missing; ordinary clinical documentation or preference-cookie consent does not authorize secondary use. Retain the founder's [curated-data-only direction](../../status/2026-10-28-no-raw-genomic-data.md); raw genomic files are not required.

Delivery order: connect the existing decision contracts to the patient workflow; implement treatment-linked follow-up observations and atomic reminders; validate a synthetic analytic projection with denominator/missingness reports; then connect the existing eligibility foundation to operational grant management and controlled aggregate release. The initial endpoint set and audience shape the detailed schema before migrations. This does not reopen clinical release, raw-genome ingestion, external export or deployment gates.

Founder instructed continuation of treatment-linked documentation and reminders. Execution detail and verification are in [treatment follow-ups](treatment-followups.md).

The subsequent [response summary slice](followup-response-summary.md) implements a small read-only physician chart inside the existing Follow-ups panel, using complete clinic counts and explicit missing-assessment categories. Its [versioned metric definition](../followup-response-summary.md) is a first in-clinic reporting contract, not a Data Insights release or a validated outcome instrument.
