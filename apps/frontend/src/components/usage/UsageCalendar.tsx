import { useState } from 'react';
import type { ApiFetch } from '@/lib/api';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Label } from '@/components/ui/Label';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { UsageCalendarLoader } from './UsageCalendarLoader';

/**
 * Reports uploaded per Puerto Rico day of one calendar year (specs/028-usage-heatmap), below the monthly figures. It loads on its own, so a
 * failure here leaves the rest of the Usage page as it is. The picker stays while another year loads.
 */
export function UsageCalendar({ apiFetch }: { apiFetch: ApiFetch }) {
  const [request, setRequest] = useState<{ year?: number; attempt: number }>({ attempt: 0 });
  const [years, setYears] = useState<number[] | null>(null);

  return (
    <SettingsSection id="usage-calendar" title="Reports uploaded per day" description="One calendar year in Puerto Rico time. Darker days had more uploads.">
      <div className="flex flex-col gap-4">
        {years && years.length > 1 && (
          <div className="flex items-center gap-3">
            <Label htmlFor="usage-calendar-year">Year</Label>
            <NativeSelect
              id="usage-calendar-year"
              className="w-32"
              value={request.year ?? years[0]}
              onChange={(event) => setRequest((current) => ({ year: Number(event.target.value), attempt: current.attempt }))}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <UsageCalendarLoader
          key={`${request.year ?? 'current'}-${request.attempt}`}
          apiFetch={apiFetch}
          year={request.year}
          onYears={setYears}
          onRetry={() => setRequest((current) => ({ ...current, attempt: current.attempt + 1 }))}
        />
      </div>
    </SettingsSection>
  );
}
