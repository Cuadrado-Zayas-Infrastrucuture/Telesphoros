import type { UsageDto } from '@telesphoros/shared-types';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { formatBytes, formatCount, monthName } from '@/lib/usage';

/** The loaded figures: this month so far and last month side by side, then storage. Plain numbers; two months read best that way. */
export function UsageSummary({ usage }: { usage: UsageDto }) {
  const [current, previous] = usage.months;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        {[
          { month: current, title: `${monthName(current.month)}, so far`, id: 'usage-current' },
          { month: previous, title: monthName(previous.month), id: 'usage-previous' },
        ].map(({ month, title, id }) => (
          <SettingsSection key={id} id={id} title={title}>
            <dl>
              <SettingsRow label="Reports uploaded">{formatCount(month.reportsUploaded)}</SettingsRow>
              <SettingsRow label="Evaluations with results">{formatCount(month.evaluations.evaluated)}</SettingsRow>
              <SettingsRow label="Evaluations held">{formatCount(month.evaluations.held)}</SettingsRow>
            </dl>
          </SettingsSection>
        ))}
      </div>
      <SettingsSection id="usage-storage" title="Storage" description="Report files that are uploaded and not deleted, by their recorded size.">
        <dl>
          <SettingsRow label="Report files">{formatCount(usage.storage.reportFiles)}</SettingsRow>
          <SettingsRow label="Total size">{formatBytes(usage.storage.reportBytes)}</SettingsRow>
        </dl>
      </SettingsSection>
    </div>
  );
}
