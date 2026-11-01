# Spec 025 PD-c: patient demographics in the web app

Date: 2026-10-31

**What it adds.**
- **Add patient asks every field** (T301), in the panel and in the Upload step: the synthetic label, given and family name, date of birth, sex (male, female or not recorded) and ethnicity (the seven 2024 categories, more than one allowed). Leaving the identity fields blank still adds the patient, marked Incomplete. A second request records the demographics; if it fails, the patient stays and a retry sends only the demographics, with the same request id.
- **"Incomplete" as a word in color** (T302) next to a patient whose sex or ethnicity is missing in the panel, and one line in color under the patient choice when a report is attached (the Upload step and the chat). The Upload step's patient options keep the plain label: a native option cannot be colored, and a changed option name breaks every test and tool that finds a patient by it. It never blocks an upload.
- **A patient page** (T303) at `/patients/:id` for clinical read roles: the current demographics, every version (an earlier one opens by its number) and, for clinicians, a correction that adds a version and never overwrites one.

**What it guarantees, and where.**
- The browser checks every draft with the API's own schema (`patientDemographicsInputSchema`), so it cannot accept what the server refuses. Messages name the field, never the value.
- Identity values live only in form and page state: never in a URL, the page title, a log or an error message. Identity fields do not autofill and are not spell-checked. The draft is cleared once saved.

**What it does not do.**
- No completeness counts per tenant (T304): they need a backend route, a separate change.
- The chat's inline patient creation still takes a label only; that patient starts Incomplete.
- No medications: a later spec.
- Nothing is published to staging.

Evidence: `docs/verification/patient-demographics-ui.md`.
