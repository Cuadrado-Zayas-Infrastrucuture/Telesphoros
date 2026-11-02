import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { FollowupResponseSummary } from './FollowupResponseSummary';
import { useFollowups } from '@/hooks/useFollowups';
import type { FollowupInboxFilters } from '@telesphoros/shared-types';
const allFilters: FollowupInboxFilters = { assignment: 'all', status: 'all' };
export function FollowupInbox({ onNavigate }: { onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [filters, setFilters] = useState(allFilters);
  const { data, error, loading, reload, page, go } = useFollowups(undefined, undefined, filters);
  const filtered = filters.assignment !== 'all' || filters.status !== 'all';
  const select = (next: FollowupInboxFilters) => {
    go(1);
    setFilters(next);
  };
  const close = () => {
    setOpen(false);
    setShowSummary(false);
    select(allFilters);
  };
  return (
    <>
      <Button variant="ghost" className="min-h-control w-full justify-start gap-3 px-3 text-sm" onClick={() => setOpen(true)} title="Follow-ups">
        <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
        <span className="workspace-link-label">Follow-ups{data && !error ? ` (${data.counts.overdue + data.counts.today})` : ''}</span>
      </Button>
      <ContextDrawer id="followup-inbox" title="Follow-ups" closeLabel="Close follow-ups" open={open} onClose={close}>
        {open && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">Clinic follow-ups. Dates use each reminder’s recorded timezone. Counts and recorded responses cover the whole clinic.</p>
            <div>
              <Button
                variant="outline"
                className="w-full justify-between"
                aria-expanded={showSummary}
                aria-controls="followup-response-summary"
                onClick={() => setShowSummary((value) => !value)}
              >
                Recorded treatment responses <span aria-hidden="true">{showSummary ? '−' : '+'}</span>
              </Button>
              {showSummary && <FollowupResponseSummary />}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Assignment
                <select
                  className="min-h-control w-full rounded-md border border-input bg-background px-3 text-foreground"
                  value={filters.assignment}
                  onChange={(event) => select({ ...filters, assignment: event.target.value as FollowupInboxFilters['assignment'] })}
                >
                  <option value="all">All clinicians</option>
                  <option value="mine">Assigned to me</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Reminder status
                <select
                  className="min-h-control w-full rounded-md border border-input bg-background px-3 text-foreground"
                  value={filters.status}
                  onChange={(event) => select({ ...filters, status: event.target.value as FollowupInboxFilters['status'] })}
                >
                  <option value="all">All open reminders</option>
                  <option value="overdue">Overdue</option>
                  <option value="today">Due today</option>
                  <option value="upcoming">Upcoming</option>
                  <option value="reassignment">Needs reassignment</option>
                </select>
              </label>
            </div>
            {filtered && (
              <Button variant="ghost" className="self-start" onClick={() => select(allFilters)}>
                Clear filters
              </Button>
            )}
            {error ? (
              <>
                <p role="alert">Follow-ups could not be loaded. Counts are unavailable.</p>
                <Button variant="outline" onClick={reload}>
                  Retry follow-ups
                </Button>
              </>
            ) : !data ? (
              <p role="status">Loading follow-ups…</p>
            ) : (
              <>
                <p>
                  Clinic totals: {data.counts.overdue} overdue · {data.counts.today} due today · {data.counts.upcoming} upcoming
                </p>
                {data.counts.unassigned > 0 && <p className="text-warning">{data.counts.unassigned} need reassignment.</p>}
                {data.items.length === 0 ? (
                  <p role="status">{filtered ? 'No matching follow-ups. Try another filter or clear filters.' : 'No open follow-ups.'}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.items.map((entry) => (
                      <li key={entry.id} className="flex flex-col gap-1 py-3">
                        <Link
                          className="inline-flex min-h-control items-center font-medium text-primary underline-offset-2 hover:underline"
                          to={`/patients/${entry.patientId}#followups`}
                          onClick={() => {
                            close();
                            onNavigate();
                          }}
                        >
                          {entry.patientLabel} · {entry.medicationName}
                        </Link>
                        <Button asChild size="sm" variant="outline" className="self-start">
                          <Link
                            to={`/patients/${entry.patientId}?followup=${entry.threadId}#followups`}
                            aria-label={`Open follow-up for ${entry.patientLabel}`}
                            onClick={() => {
                              close();
                              onNavigate();
                            }}
                          >
                            Open follow-up
                          </Link>
                        </Button>
                        <p className={entry.dueState === 'overdue' ? 'text-sm text-warning' : 'text-sm'}>
                          {entry.dueState === 'today' ? 'Due today' : entry.dueState === 'overdue' ? 'Overdue' : 'Upcoming'} · {entry.next?.date} ({entry.next?.timezone})
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {entry.needsReassignment ? 'Needs reassignment' : entry.next?.assignee === data.currentActor ? 'Assigned to me' : `Assigned to ${entry.next?.assignee}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {(page > 1 || data.hasMore) && (
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={loading || page === 1} onClick={() => go(page - 1)}>
                      Previous
                    </Button>
                    <Button variant="outline" disabled={loading || !data.hasMore} onClick={() => go(page + 1)}>
                      More follow-ups
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </ContextDrawer>
    </>
  );
}
