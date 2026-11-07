import { describeSize } from '@/lib/describeSize';
import type { ProductUploadValues } from '@/lib/productUploadSchema';
import { REPORT_TYPE_LABELS } from '@/types/report';

/** The last step of the guided upload: what is about to be sent. */
export function UploadSummary({ patientLabel, values }: { patientLabel: string | undefined; values: Partial<ProductUploadValues> }) {
  return (
    <section aria-label="Upload summary" className="rounded-lg border border-divider bg-background p-4">
      <h3 className="text-lg">Check your entries</h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Synthetic patient</dt>
          <dd className="wrap-anywhere font-medium">{patientLabel ?? 'Not selected'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Report type</dt>
          <dd>{values.reportType ? REPORT_TYPE_LABELS[values.reportType] : 'Not selected'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground">Report file</dt>
          <dd className="wrap-anywhere">
            {values.file?.name ?? 'Not selected'}
            {values.file && ` (${describeSize(values.file.size)})`}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">Nothing has been submitted yet. Storage verification happens after upload and is not clinical review.</p>
    </section>
  );
}
