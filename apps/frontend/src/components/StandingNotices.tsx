import type { Notice } from '@/lib/resultStatus';

/** Whether an evaluation can be relied on, as words in colour: destructive when it must not be used, warning for a caution. */
export function StandingNotices({ notices }: { notices: readonly Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {notices.map((notice) => (
        <p key={notice.message} className={`font-medium ${notice.tone === 'destructive' ? 'text-destructive' : 'text-warning'}`}>
          {notice.message}
        </p>
      ))}
    </div>
  );
}
