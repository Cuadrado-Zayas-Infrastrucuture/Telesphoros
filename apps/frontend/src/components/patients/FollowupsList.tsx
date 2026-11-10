import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { FollowupDto, FollowupInput } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { useFollowups } from '@/hooks/useFollowups';
import { FollowupForm } from './FollowupForm';

import { FollowupValues } from './FollowupValues';
import { FollowupHistory } from './FollowupHistory';
import { clinicianLabel } from '@/lib/clinicianLabel';

export function FollowupsList({ patientId, initialSaved = false, onEditingChange }: { patientId: string; initialSaved?: boolean; onEditingChange?: (editing: boolean) => void }) {
  const { roles } = useAuth();
  const { hash } = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (hash === '#followups') {
      heading.current?.scrollIntoView?.({ block: 'start' });
      heading.current?.focus({ preventScroll: true });
    }
  }, [hash, patientId]);
  const canWrite = roles.includes('clinician');
  const { data, error, loading, reload, page, go } = useFollowups(patientId);
  const [editing, setEditing] = useState<{ action: FollowupInput['action']; entry?: FollowupDto } | null>(null);
  useEffect(() => {
    onEditingChange?.(!!editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  const [history, setHistory] = useState<string | null>(null);
  const [saved, setSaved] = useState(initialSaved);
  const edit = (action: FollowupInput['action'], entry?: FollowupDto) => {
    setSaved(false);
    setEditing({ action, entry });
  };
  return (
    <section id="followups" aria-labelledby="followups-heading" className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} id="followups-heading" className="text-lg font-semibold">
          Follow-up
        </h2>
        <Button variant="ghost" size="sm" disabled={loading || !!editing} onClick={reload}>
          Refresh follow-ups
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Document response to a recorded treatment and choose when to follow up.</p>
      {saved && <p role="status">Follow-up saved.</p>}
      {editing ? (
        <FollowupForm
          key={`${editing.action}-${editing.entry?.id ?? 'new'}`}
          patientId={patientId}
          {...editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setSaved(true);
            reload();
          }}
        />
      ) : (
        canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => edit('document')}>
              Document follow-up
            </Button>
            <Button size="sm" variant="outline" onClick={() => edit('schedule')}>
              Schedule follow-up
            </Button>
          </div>
        )
      )}
      {error ? (
        <div>
          <p role="alert">Follow-ups could not be loaded.</p>
          <Button variant="outline" onClick={reload}>
            Retry follow-ups
          </Button>
        </div>
      ) : !data ? (
        <ContentSkeleton label="Loading follow-ups…" variant="list" />
      ) : (
        <>
          <p className="text-sm">
            {data.counts.overdue} overdue · {data.counts.today} due today · {data.counts.upcoming} upcoming
            {data.counts.unassigned ? ` · ${data.counts.unassigned} need reassignment` : ''}
          </p>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No follow-ups recorded yet.</p>
          ) : (
            <ul aria-label="Patient follow-ups" className="divide-y divide-border border-y border-border">
              {data.items.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-2 py-3">
                  <p className="font-medium">{entry.medicationName}</p>
                  <p className={entry.dueState === 'overdue' ? 'text-sm text-warning' : 'text-sm'}>
                    {entry.next
                      ? `${entry.dueState === 'today' ? 'Due today' : entry.dueState === 'overdue' ? 'Overdue' : 'Next follow-up'}: ${entry.next.date} (${entry.next.timezone})`
                      : 'No open reminder'}
                  </p>
                  {entry.next && (
                    <p className="text-xs text-muted-foreground">
                      Responsible clinician: {clinicianLabel(entry.next.assignee, data.currentActor)}
                      {entry.needsReassignment ? ' — reassignment needed' : ''}
                    </p>
                  )}
                  <FollowupValues entry={entry} actor={data.currentActor} />
                  <div className="flex flex-wrap gap-2">
                    {canWrite && !editing && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => edit('document', entry)}>
                          Document
                        </Button>
                        {entry.next && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => edit('reschedule', entry)}>
                              Reschedule
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => edit('dismiss', entry)}>
                              Dismiss
                            </Button>
                          </>
                        )}
                        {entry.assessment && entry.createdBy === data.currentActor && (
                          <Button size="sm" variant="ghost" onClick={() => edit('amend', entry)}>
                            Correct assessment
                          </Button>
                        )}
                      </>
                    )}
                    <Button size="sm" variant="ghost" aria-expanded={history === entry.threadId} onClick={() => setHistory(history === entry.threadId ? null : entry.threadId)}>
                      History
                    </Button>
                  </div>
                  {history === entry.threadId && <FollowupHistory patientId={patientId} threadId={entry.threadId} />}
                </li>
              ))}
            </ul>
          )}
          {(page > 1 || data.hasMore) && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={loading || page === 1} onClick={() => go(page - 1)}>
                Previous follow-ups
              </Button>
              <Button variant="outline" disabled={loading || !data.hasMore} onClick={() => go(page + 1)}>
                More follow-ups
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
