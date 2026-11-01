# Shared patient selection in chat and Upload
Date: 2026-10-31

`PatientPicker` provides one controlled native select for chat and Upload, including loading, empty and failed lists with Retry. It accepts `patients` (null before the first response), `value` and `onValueChange`; `loading` also covers pagination while the previous page is retained. `selectedPatient` keeps an off-page or newly created selection in the options. `error`, `onRetry` and `emptyMessage` describe list state. `newPatientOption` is supplied only by a caller that supports creation. Standard native-select props (including the ref, id, name, disabled, onBlur and ARIA attributes) reach the select, so form labels, validation and focus still work. State text joins existing accessible descriptions; generated ids distinguish multiple instances.

```tsx
<PatientPicker
  aria-label="Patient"
  patients={patients}
  value={patientId}
  onValueChange={setPatientId}
  error={patientsError}
  onRetry={reloadPatients}
/>
```

Requests and pagination stay in each page. The demographics slice already supplies `useAddPatient` for Upload and the sidebar; this change adds no creation hook. Chat continues creating a label-only patient on Send, and Upload keeps its separate label-and-demographics form and retry identities. The sidebar stays a list of links to patient pages. In Upload, Retry replaces Refresh while a list failure is shown. The chat label now uses the shared input with associated synthetic-label instructions; patient controls disable during report transfer.

The chat instruction regression was observed failing before the change. Component and existing page tests cover native form/ref wiring, list states, explicit choices, off-page selection, list retries and demographics retries. The chat upload browser flow also checks accessible instructions, 44px targets, 16px control text, viewport fit and axe on mobile and desktop. Verification results are recorded with the candidate, not inferred from these test definitions.
