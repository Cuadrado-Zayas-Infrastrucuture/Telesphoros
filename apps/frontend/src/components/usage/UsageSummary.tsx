import type { UsageDto } from '@telesphoros/shared-types';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { formatBytes, formatCount, monthName } from '@/lib/usage';

/** Shared loading and loaded layout: two months, then storage. Null renders decorative placeholders, never invented counts. */
export function UsageSummary({ usage }: { usage: UsageDto | null }) {
  const [current, previous] = usage?.months ?? [];
  const figure = (value: number | undefined, format = formatCount) =>
    value === undefined ? (
      <span className="relative block w-16">
        <span className="invisible">0</span>
        <Skeleton className="absolute inset-0" />
      </span>
    ) : (
      format(value)
    );
  return (
    <div aria-hidden={usage === null || undefined} className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        {[
          { month: current, title: current ? `${monthName(current.month)}, so far` : 'This month, so far', id: 'usage-current' },
          { month: previous, title: previous ? monthName(previous.month) : 'Last month', id: 'usage-previous' },
        ].map(({ month, title, id }) => (
          <SettingsSection key={id} id={id} title={title}>
            <dl>
              <SettingsRow label="Reports uploaded">{figure(month?.reportsUploaded)}</SettingsRow>
              <SettingsRow label="Evaluations with results">{figure(month?.evaluations.evaluated)}</SettingsRow>
              <SettingsRow label="Evaluations held">{figure(month?.evaluations.held)}</SettingsRow>
            </dl>
          </SettingsSection>
        ))}
      </div>
      <SettingsSection id="usage-storage" title="Storage" description="Report files that are uploaded and not deleted, by their recorded size.">
        <dl>
          <SettingsRow label="Report files">{figure(usage?.storage.reportFiles)}</SettingsRow>
          <SettingsRow label="Total size">{figure(usage?.storage.reportBytes, formatBytes)}</SettingsRow>
        </dl>
      </SettingsSection>
    </div>
  );
}
