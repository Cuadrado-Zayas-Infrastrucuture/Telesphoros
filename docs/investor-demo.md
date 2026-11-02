# Investor prototype: presentation and acceptance

Date: 2026-11-02

## Scope

The local synthetic prototype now starts in **chat**. Attaching a report opens a compact details dialog; patient creation and demographics open the patient record. Medications are recorded there. Report history and settings open over chat, and returning from a patient keeps the unsent question and attachment. The legacy upload route remains a compatibility panel for recovery links.

The prototype includes treatment-linked follow-up documentation and persistent in-app reminders on the patient record and in a chat-side panel. It does not enable clinical interpretation, model inference or external notifications. See the [physician workspace plan](design/plans/physician-chat-and-patient-record.md), [workspace verification](verification/physician-workspace.md) and [follow-up verification](verification/treatment-followups.md).

The Follow-ups panel also offers a Recorded treatment responses disclosure with complete clinic counts and explicit missing-assessment categories. It summarizes saved synthetic documentation, including closed reminders. Its [metric definition](design/followup-response-summary.md) and [verification](verification/followup-response-summary.md) distinguish this physician view from clinical effectiveness evidence and a governed Data Insights release.

Use **Open follow-up** on a reminder to jump directly to its current documentation form on the patient record. Closed reminders and reviewer accounts open the record/history without a write form. This shortcut works beyond the first patient-list page and still requires an explicit save.

In the same panel, choose **Assigned to me** and a reminder status to focus the list. Filtering covers all pages, resets to page one, and never changes the clinic-wide totals or recorded-response chart. **Clear filters** returns to all open clinic reminders.

The patient record also has **Recorded results**, decision/history controls and explicit decision-linked follow-up. These consume actual stored evaluations; fixed sample results cannot create decisions. In the storage-only investor prototype, the processing API remains disabled and this section reports that status. The reader engine still needs design and implementation, as clarified by the founder on 2026-11-02. The downstream browser tests use disclosed upstream stand-ins and are not an extraction demonstration. See [verification](verification/patient-result-decisions.md).

The presentation demonstrates real patient creation, validated report upload and stored-file identity, followed by explicitly fixed sample results. The sample values are invented test data, not CPIC guidance. Medication capture is a separate capability; the fixed results do not inspect the medication list. Do not describe independent review, clinical computation, a model response or a prescribing recommendation as having happened.

Follow-up preparation authorized by the founder: run the core presentation sequence twice using temporary local browser automation, measure each scene, and create an English synthetic-voice recording with captions from the second run. Keep temporary tooling and media outside git. Check real patient/upload/result/hold transitions and inspect the exported recording. No product code, deployment or clinical gate changes. Automated timed rehearsals do not certify the presenter's delivery or the eventual meeting machine.

## Five-minute presentation

Start the demo and sign in before the meeting. Use a 1280×800 browser window. Keep the original D01 and D08 fixture PDFs ready in a file picker. Do not spend presentation time on dependency setup or the fake identity provider.

Use in-app links throughout. To show a second upload, close report history and attach the next file in chat. A browser refresh or address-bar navigation intentionally clears the in-memory sign-in and requires signing in again.

| Time | Action | Presenter wording |
| --- | --- | --- |
| 0:00–0:40 | Introduce the workflow | “Telesphoros is being built to bring pharmacogenomic evidence into the clinician’s workflow. Today’s prototype uses fictional patients and reports. Upload and storage are working; the interpretation screens show fixed examples.” |
| 0:40–1:30 | Open chat, choose Add patient, enter synthetic information for `SYN-INVESTOR-01`, then Back to chat | “We associate each report with a patient. This gives the clinician a place to find the underlying evidence.” |
| 1:30–2:15 | Attach D01 in chat, confirm the details and synthetic data only; upload, then open All reports and the uploaded report | “This file goes through the application’s upload and storage path. The application verifies the stored file. That confirms file storage, not clinical accuracy.” |
| 2:15–3:25 | Choose Show fixed sample result; show gene inputs, invented drug output and source disclosure | “This illustrates the intended result experience. These values are hand-authored examples; no reader, rules engine or model has processed this upload. The next engineering milestone is to connect supported evidence to computed results.” |
| 3:25–4:20 | Upload D08 for `SYN-INVESTOR-08`; open Show held sample | “This example illustrates a case where the system would withhold interpretation because the evidence cannot be aligned reliably. Today this is also a fixed demonstration.” |
| 4:20–5:00 | Close with the next milestone | “We have a working application foundation and an illustrative result experience. The next milestone is a narrow synthetic workflow with actual extraction, independent review and reproducible computation, followed by clinical validation before any patient-data pilot.” |

Patient demographics, medication capture and follow-up documentation use the real local API and database. If time allows, add a recorded medication, document a synthetic follow-up, choose its next date, then open Follow-ups from chat. Describe this as an in-app reminder; no email or push notification is sent. Do not substitute hosted staging: the fixed-result screens are intentionally loopback-only and absent from its normal build.

## Rehearsal

Use the pinned tools and setup in [Start here](start-here.md), then:

```sh
pnpm demo:product:build
pnpm demo:storage
```

In a separate terminal, with the owned stack ready:

```sh
PRODUCT_DEMO_SCREENSHOTS=true pnpm test:product-demo
```

The browser suite covers D01, D08 and an unmapped D02 uploaded under a misleading D01 filename at 375px and 1280px. It verifies actual stored hashes, sample selection, keyboard interaction, accessibility, layout and disabled processing. It does not establish clinical correctness or AWS acceptance.

Before a meeting, complete these checks on the exact presentation machine:

- Start from a fresh owned run; record its source commit and tool versions.
- Pass the complete product-demo browser suite and inspect the patient, chat intake, follow-up and result/held screenshots.
- Perform the five-minute sequence twice by hand, including file selection and the second upload.
- Record one clean, narrated desktop walkthrough. Keep a local copy and the screenshots available as backup; label both as synthetic with fixed results.
- Review that no screen or narration implies computed results, clinical validation or a connected medication–gene analysis.
- Read that run’s `blast-radius.md` before teardown. Stop through its foreground launcher or its exact UUID; never kill a process by port.

Use the recording if a live demonstration fails. Do not repeatedly troubleshoot during the meeting. A browser-test recording is useful technical evidence but is not a polished narrated presentation.

The earlier report-page media package at `/workspace/investor-demo-assets/narrated/` contains the synthetic-voice draft, transcript, captions and timed rehearsal receipts. It predates the chat-first workflow and must not be used as a current UI walkthrough. Its recording is about three minutes, leaving room for questions within the five-minute slot. The voice is a reference narration for review; a presenter can use `narration.txt` to record their own delivery. These automated runs do not replace human rehearsal on the meeting machine.

## Next delivery slices

| Slice | Completion criterion |
| --- | --- |
| Rehearse existing prototype | Build and six browser controls pass; screenshots inspected; limitations documented |
| Presentation acceptance | Two timed human rehearsals and one narrated backup recording on the meeting machine |
| Resolve demonstrated usability issues | A separately approved implementation plan for each needed change, retaining branding, roles and synthetic boundaries |
| Computed synthetic MVP | Approved narrow report/content scope; real extraction, independent review, deterministic computation and result persistence connected through the UI; expected results independently verified |
| Patient-data pilot | Separate clinical, legal, tenant-isolation, recovery and hosted operational acceptance; no date implied by prototype completion |

The earlier 3–7 working-day estimate is a planning range for packaging and rehearsal, not an assurance that clinical integration can be completed in that time. Prototype acceptance does not require finishing every production-readiness item.

## Evidence

Current rehearsal results and remaining gaps are recorded in [the dated verification record](verification/investor-demo-2026-11-02.md). Prior browser evidence belongs to [the 2026-10-26 verification](verification/fixture-product-demo.md) and must not be described as a fresh run.
