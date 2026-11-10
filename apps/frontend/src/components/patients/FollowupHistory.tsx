import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { Button } from '@/components/ui/Button';
import { useFollowups } from '@/hooks/useFollowups';
import { FollowupValues } from './FollowupValues';
import { clinicianLabel } from '@/lib/clinicianLabel';

export function FollowupHistory({ patientId, threadId }: { patientId: string; threadId: string }) {
  const { data, error, loading, reload, page, go } = useFollowups(patientId, threadId);
  return (
    <div className="flex flex-col gap-3 pt-3">
      {error ? (
        <>
          <p role="alert">History could not be loaded.</p>
          <Button variant="outline" onClick={reload}>
            Retry history
          </Button>
        </>
      ) : !data ? (
        <ContentSkeleton label="Loading history…" variant="list" />
      ) : (
        <>
          <ol aria-label="Follow-up history" className="flex flex-col gap-4">
            {[...data.items]
              .sort((a, b) => b.version - a.version)
              .map((entry) => (
                <li key={entry.id} className="border-l border-border pl-3">
                  <p className="text-sm font-medium">
                    Version {entry.version} · {entry.action}
                  </p>
                  <FollowupValues entry={entry} actor={data.currentActor} />
                  {entry.next && (
                    <p className="text-sm">
                      Next date: {entry.next.date} ({entry.next.timezone}) · {clinicianLabel(entry.next.assignee, data.currentActor)}
                    </p>
                  )}
                </li>
              ))}
          </ol>
          {(page > 1 || data.hasMore) && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={loading || page === 1} onClick={() => go(page - 1)}>
                Previous history
              </Button>
              <Button variant="outline" disabled={loading || !data.hasMore} onClick={() => go(page + 1)}>
                More history
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
