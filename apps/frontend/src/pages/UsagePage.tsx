import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { UsageCalendar } from '@/components/usage/UsageCalendar';
import { UsageReportView } from '@/components/usage/UsageReportView';
import { usePageTitle } from '@/hooks/usePageTitle';

/** The organization's own activity and storage, for its administrators (specs/011-usage-page). Counts only; nothing clinical. */
export default function UsagePage() {
  usePageTitle('Usage');
  const { apiFetch } = useAuth();
  const [attempt, setAttempt] = useState(0);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl leading-tight tracking-tight">Usage</h1>
        <p className="text-pretty text-muted-foreground">Your organization&apos;s activity and storage. Months are in Puerto Rico time.</p>
      </div>
      <UsageReportView key={attempt} apiFetch={apiFetch} onRetry={() => setAttempt((n) => n + 1)} />
      <UsageCalendar apiFetch={apiFetch} />
    </div>
  );
}
