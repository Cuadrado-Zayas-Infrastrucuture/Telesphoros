# Empty patient roster guidance — 2026-10-14

Phase A local branch from main `4400efa`, independent of the launcher fix and frozen F06/F07. No push, PR or deployment.

The upload page now says: “No patients available. Ask a clinician to add a synthetic patient, then refresh the list.” Its existing Refresh patients control is unchanged. The existing empty-list test also verifies the handoff and that refresh is enabled, while retaining its no-auto-create/no-submit assertions. The [setup note](../ops/patient-setup.md) documents the current clinician-only API workflow and leaves patient-create/search screens separate.

Verification: focused frontend upload/auth tests **32 passed**; route/role tests **27 passed**; branding rejection tests **24 passed**. Frontend typecheck, lint and production build passed. The backend and fake-IDP builds used for browser acceptance passed. Existing patient/member/private-read tests passed in memory (**85 passed, one profile-dependent skip**); database/S3 backend tiers were excluded and were not claimed as passed. No API/schema/permission code changed.

Built Chromium checks at 375×812 and 1280×800: **8 passed**. The real fake-IDP flow and built API produced an empty roster; the page rendered the clinician handoff and rejected an upload without creating a patient. A synthetic clinician API request created the patient; Refresh patients listed it and the user could select its actual returned ID. Reader, admin-only and roleless clients could not enter the upload page. The new synthetic fixture was removed by its exact ID; RAM-backed API and all owned IDP/API/web/Moto processes stopped. Mobile/desktop error-state screenshots were visually checked, with no horizontal overflow and unchanged fonts/colors/controls.

Scratch harness setup failures were repaired: use the package-local Jest binary; allow its owned HTTP bind; disable inherited AWS profiles; include the API's required owned Moto startup fixture. A closed native-select option is hidden, so its positive control verifies actual selection rather than visual expansion. No branch behavior or refusal assertion was weakened to resolve these setup issues.
