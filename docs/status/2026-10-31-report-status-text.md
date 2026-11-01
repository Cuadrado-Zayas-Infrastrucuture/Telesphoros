# Consistent report status words
Date: 2026-10-31

`ReportStatusText` presents an API-validated record status with the same label and semantic color in Reports, the sidebar, chat and history drawer. Received and Processing use warning, Processed uses success, and Failed uses error. Reports previously colored every status as an action. Status describes the record, not clinical review; no workflow, route or backend behavior changes.

```tsx
<ReportStatusText status={report.status} className="text-xs" />
```

The component accepts a typed `status` and optional typography/layout `className`. Its semantic color takes precedence over an accidental caller text-color override. The exhaustive status map stays private to the component; consumers no longer import presentation data from the history drawer.
