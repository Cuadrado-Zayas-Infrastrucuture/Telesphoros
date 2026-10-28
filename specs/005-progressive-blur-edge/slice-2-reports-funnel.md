# Slice 2: report stages funnel and skeleton (RSF)

**Branch**: `feat/reports-funnel`, off `main` (not stacked on slice 1; it does not use blur)

**Approved**: 2026-10-27. The founder chose option A: Registered, File uploaded and Read, with Failed as a word beside the funnel. Frontend only.

## Why option A

The stages first proposed (Uploaded, Read, Genes matched, Reviewed) do not exist in the report data. `ReportDto` (`packages/shared-types/src/report.ts`) has `status` (`received`, `processing`, `processed`, `failed`) and `fileUploaded`. Gene evaluations and review decisions are separate lab-report records with no tenant-wide count. Counting those needs a backend summary endpoint and a clinical definition, which is out of scope here.

## Stages

| Stage | Counts a report when | Note |
| --- | --- | --- |
| Registered | it is listed | every report record |
| File uploaded | `fileUploaded` | storage verified size and checksum |
| Read | `status === 'processed'` and `fileUploaded` | nested in File uploaded, so the funnel never widens |
| Failed (word, not a stage) | `status === 'failed'` | shown beside the funnel with its count |

"Read" means the system processed the record. It does not mean clinical review; the page already says storage verification is not clinical review.

## Counting

The list API has no status filter and returns statuses one page at a time. The funnel pages through `GET /api/v1/reports` at the API's maximum of 100 per page, applying the same patient filter as the table, up to 10 pages (1,000 reports). When there are more, the counts cover the first 1,000 listed and the funnel says so: "Counted from the first 1,000 of N reports." Every page is checked as strictly as `listReports` checks its own.

## Requirements

- **FR-201** `ui/Skeleton`: the shadcn Skeleton (`shadcn-ui/ui@96da9cc`, MIT), `aria-hidden`, in the look `ReportListSkeleton` already ships (`bg-divider`, `rounded-sm`, pulse only with `motion-safe`). `ReportListSkeleton` is rebuilt on it with the same rows.
- **FR-202** `FunnelChart`: adapted from `bklit/bklit-ui@e303e47` `packages/ui/src/charts/funnel-chart.tsx` (MIT). It keeps the curved segment geometry and the halo ring, drops `motion`, hover, patterns and grid, and draws into a fixed `viewBox`. Core `--primary`, halo `--brand-accent`. The SVG is `aria-hidden`; a visible list gives every stage's count and its share of Registered.
- **FR-203** `ReportStages` on Reports: a skeleton while counting, the funnel and list, Failed as a word in `--destructive` with its count, an error line with a retry button when counting fails, and the cap note. It follows the patient filter and the Refresh button, not table pagination.
- **FR-204** No backend, shared-types, token or policy change.

## Tests

- Skeleton: `aria-hidden`, approved classes, `ReportListSkeleton` keeps 5 rows.
- FunnelChart: one core and one halo path per stage; all-zero data draws without `NaN`; a widening stage is drawn no wider than its predecessor.
- Counting: sums across pages, the patient filter on every request, the 10-page cap and its note, and rejection of a page that breaks the contract.
- ReportsPage: the stages appear with counts, Failed is a word, it recounts on a patient change and not on a table page change, and axe passes.
