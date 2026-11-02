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
| 0:00–0:27 | Introduce the chat workspace | “Reports and follow-up work belong in the physician workflow. This demonstration uses fictional patients; interpretation examples are fixed.” |
| 0:27–0:55 | Attach D01 in chat; add a note; choose Add patient from the details panel and create `SYN-INVESTOR-01` | “The report stays attached while we create the patient's record. Nothing uploads until the physician confirms.” |
| 0:55–1:26 | Record a synthetic medication and its source; schedule a follow-up for today with a goal, timezone and responsible clinician | “The patient page holds medications and follow-up documentation. Reminders are saved without relying on a model.” |
| 1:26–1:54 | Back to chat; reopen Report details; confirm and upload; open All reports and the uploaded file | “The note and attachment are preserved. The server verifies the stored file, which establishes file identity rather than clinical accuracy.” |
| 1:54–2:20 | Show fixed sample result | “These invented values illustrate the result experience. No engine processed this upload, and fixed samples cannot create clinical decisions.” |
| 2:20–2:51 | Close report panels; open Follow-ups → Open follow-up; record response, symptoms, source and note; choose In 14 days and save | “The reminder opens the relevant form. The physician saves documentation and the explicit next reminder together.” |
| 2:51–3:24 | Return to chat; filter Follow-ups by Assigned to me and Upcoming; expand Recorded treatment responses | “This chart summarizes saved documentation and missing assessments. It is a foundation for Data Insights, not evidence of treatment effectiveness.” |
| 3:24–3:50 | Close Follow-ups; attach and upload D08 for the same fictional patient; open Show held sample | “This fixed example illustrates unsupported evidence: a reason is shown, with no gene or drug result. Unmatched files get no sample interpretation.” |
| 3:50–4:28 | Return to chat and describe the next milestone | “The workflow is working. Actual report extraction and validated computation come next; optional AI notes and governed Data Insights remain future work.” |

Patient demographics, medication capture and follow-up documentation use the real local API and database. The medication and recorded response are fictional examples, not treatment advice. Describe reminders as in-app; no email or push notification is sent. The response chart includes all recorded follow-ups, including closed reminders, and its clinic totals do not change when reminder filters change. Do not substitute hosted staging: the fixed-result screens are intentionally loopback-only and absent from its normal build.

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
- Open the current narrated backup on the meeting machine and check playback, captions and audio output. Keep the MP4 and screenshots available locally. Record a replacement only if the presented source or narration changes.
- Review that no screen or narration implies computed results, clinical validation or a connected medication–gene analysis.
- Read that run’s `blast-radius.md` before teardown. Stop through its foreground launcher or its exact UUID; never kill a process by port.

Use the recording if a live demonstration fails. Do not repeatedly troubleshoot during the meeting. The narrated backup is an automated synthetic demonstration; it does not replace the presenter's own rehearsal.

The current media package is `/workspace/investor-demo-assets/chat-first-2026-11-02/`, built from merged commit `e6b7be432786f403d69739f45946258b7199aba0`. Open `index.html` for offline playback and chapters, or play `investor-walkthrough.mp4` directly. The package includes captions, a transcript, presenter cues, screenshots and source/checksum evidence. The narration uses a local synthetic voice and lasts about four minutes and 28 seconds. Share `/workspace/investor-demo-assets/telesphoros-investor-demo-2026-11-02.zip`, the curated archive excluding raw browser recordings, private service state and temporary tooling. Extract it before opening the player; if the meeting browser blocks local HTML, play the MP4 directly.

The earlier `/workspace/investor-demo-assets/narrated/` recording and `investor-prototype-preview.mp4` predate this workflow. Keep them as historical artifacts, not as current presentation material. The new package's verification record distinguishes automated rehearsal from the remaining human meeting-machine checks.

## Next delivery slices

| Slice | Completion criterion |
| --- | --- |
| Rehearse existing prototype | Product build and all 38 browser cases pass; current walkthrough and screenshots checked; limitations documented |
| Presentation acceptance | Current backup playback checked and two timed human rehearsals on the meeting machine |
| Resolve demonstrated usability issues | A separately approved implementation plan for each needed change, retaining branding, roles and synthetic boundaries |
| Computed synthetic MVP | Approved narrow report/content scope; real extraction, independent review, deterministic computation and result persistence connected through the UI; expected results independently verified |
| Patient-data pilot | Separate clinical, legal, tenant-isolation, recovery and hosted operational acceptance; no date implied by prototype completion |

The earlier 3–7 working-day estimate is a planning range for packaging and rehearsal, not an assurance that clinical integration can be completed in that time. Prototype acceptance does not require finishing every production-readiness item.

## Evidence

Current rehearsal results and media checks are recorded in [the chat-first package verification](verification/chat-first-demo-package.md). The [earlier investor rehearsal](verification/investor-demo-2026-11-02.md) and [2026-10-26 browser evidence](verification/fixture-product-demo.md) remain historical records.
