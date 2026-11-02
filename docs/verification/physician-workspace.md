# Physician workspace verification

Date: 2026-11-02

AI-assisted frontend changes from application base `e07619ec`. Scope: compact chat report intake, patient-page creation, preserved in-memory conversation, and report/account/recovery panels. [Product direction](../design/plans/physician-chat-and-patient-record.md).

## Behavior proved

- New patient-page navigation and draft-preservation tests first failed because Add patient was an inline sidebar button. They pass with `/patients/new` and a persistent signed-in conversation layout.
- Both panel tests first failed because Reports and Settings were pages rather than dialogs. They now prove dismissal returns to the same unsent question.
- Moving creation exposed an actual duplicate-submit defect in the shared creation hook: a second form submission while the first was pending sent a second patient request. The synchronous guard turns that test green. Existing lost-response identity, partial demographics failure, input validation, incomplete/complete state and cleared-draft controls remain, exercised through the relocated form.
- The UI unit suite retains its existing mocked HTTP responses/submission boundary. Browser tests exercise actual PostgreSQL 16.13, Moto 5.2.4, API, migrations and fake identity provider; inference and clinical processing stay disabled.

## Checks

| Check | Result |
| --- | --- |
| Full frontend suite | Latest usability iteration: 62 files / 694 tests passed; branding and preview guards passed separately (55 checks) |
| Final navigation/upload regression | 56 passed after the shared patient-loader lint adjustment |
| Product demo browser suite | 16 passed at 375×812 and 1280×800: demographics, medication entry, unsent attachment/question retained across patient creation, exactly one confirmed upload, report status, report/settings panels, fixed examples and held/unmapped controls, attachment replacement/reselection, visible upload retry and a roster exceeding 20 patients. The 4 new cases passed again against the final build. |
| Existing patient storage browser regressions | 8 distinct cases passed across initial run and focused rerun: demographics and version corrections, cross-tenant/role refusals, medication add/correct/stop/history, lost-response replay, concurrent correction conflict, and 20-medication light/dark layouts |
| Complete default-build workspace-home browser suite | 48 passed, 2 intentional viewport-specific skips; keyboard, role navigation, no inference request, upload confirmation, lost patient-create response and attachment Undo |
| Workspace typecheck and build | Passed again after the usability iteration; final synthetic demo build also passed |
| Lint and formatting | Passed again after the usability iteration; no suppression added |
| Production chunks and foundation | Lazy patient-creation chunk included; checked against the normal production build |
| CI configuration | 217 passed |
| Full default workspace tests | Failed: backend 2,075 passed, 2 failed, 451 skipped; 154 suites passed, 2 failed, 25 skipped. The failures are the unchanged subprocess reader's process-tree deadline and cancellation cleanup controls. A focused rerun still failed those 2, with 15 passing. |
| Infrastructure | Latest usability iteration: 285 passed. The preceding pass had an environmental `spawnSync git EPIPE` failure; that failure did not recur. An earlier concurrent dependency rebuild invalidated that run's module import; it is not counted as valid verification. |

The medication permission browser test initially could not sign in the no-role `dave` persona: the owned demo intentionally omits roleless memberships, whereas that test expects an active member without roles. A roleless membership was added only in the disposable database through the existing membership administration service. Both original test cases then passed without changing assertions or increasing timeouts.

The full database/S3 backend suites and optional external reader engine were not configured for the default workspace test command (451 skips). The real-storage browser runs above are separate evidence, not a claim that those skipped suites ran. Hosted CI has not been accepted. No required check was weakened or bypassed.

## Usability defects reproduced and fixed

Five new unit behaviors failed for the expected reasons before changes: an upload note received the unrelated interpretation-unavailable reply; a replacement attachment retained the previous confirmation; selecting the same file after removal did not reopen intake; later patient pages could not be reached; and upload errors appeared only behind the dialog. All now pass. Later-page failure/retry retains the existing roster and selected patient. Notes remain attached to the conversation upload entry, not durable follow-up records.

The additional browser cases use actual patient/report APIs and the owned PostgreSQL/Moto stack. The retry case deliberately aborts the first report declaration request at the browser transport boundary, then lets the retry reach the real service. It does not mock the backend or storage. The roster case creates 25 synthetic records per viewport and proves that a patient outside page one is selectable without changing the current selection during loading or losing the draft. Axe checks pass for expanded intake and the retry state; no horizontal overflow was detected. Existing unit HTTP mocks remain as described above.

Workspace typecheck, lint/format, build, production chunk/foundation, infrastructure (285) and CI configuration (217) checks were rerun. Full backend/default-workspace tests and the broader medication/default-browser suites were not rerun for this frontend-only iteration; their preceding results and limitations remain above. The final promise-callback adjustment to the roster loader was checked with the 56-test focused suite and all 4 new browser cases after rebuilding.

## Visual review and limits

Opened and inspected desktop patient creation and chat upload/status screenshots, plus mobile report intake and patient medication screenshots. Local copies are under `/workspace/investor-demo-assets/physician-workspace/`. Automated checks cover keyboard focus inside panels, no horizontal overflow, WCAG A/AA checks, and realistic medication lists in both themes.

The usability pass additionally inspected mobile/desktop busy-roster screenshots and the mobile failed-upload dialog. Lists have bounded scroll regions; Add patient stays above the roster, and the filter explicitly applies to loaded patients. The desktop sidebar still scrolls for lower navigation/account controls when populated. This is pagination plus a local filter, not clinic-wide server search. Chart selection and integration prerequisites are recorded in the product plan; the chart components themselves were not installed or browser-tested.

The owned run is `657b629e-d6df-4473-8929-2e30bba442db`. Its exact blast-radius file was reviewed before UUID-scoped teardown, which returned `Owned teardown verified`. Temporary verification configurations are removed from the source tree.

The subsequent usability run was `b46eb766-ecd6-4f06-a9ce-37fef1d52c5f`. After retaining screenshots and reviewing its exact blast-radius file, UUID-scoped teardown also returned `Owned teardown verified`.

Conversation drafts are held only in this signed-in browser session; a full reload clears them. Existing interrupted-upload recovery remains available through the legacy compatibility panel, whose full intake form still exists. The conversation still states that interpretation is unavailable; fixed sample results remain explicitly synthetic and loopback-only. At the end of this frontend slice, follow-up notes, recommendation decisions on the patient page, reminders and optional AI note drafting remained unimplemented. No schema, clinical logic, provider, AWS or deployment change was included in this slice. Subsequent treatment-linked documentation and in-app reminders have separate [implementation verification](treatment-followups.md).
