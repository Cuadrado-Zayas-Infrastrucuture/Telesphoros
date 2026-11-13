import { Link } from 'react-router-dom';
import { drugPresentation, type FollowupInboxFilters } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { useFollowups } from '@/hooks/useFollowups';

const MINE: FollowupInboxFilters = { assignment: 'mine', status: 'all' };
/** A home is a starting point, not the list: the full inbox, with its filters, is in the sidebar. */
const SHOWN = 3;
const DUE_WORDS = { overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming', closed: 'Closed' } as const;

/**
 * The home's work list (specs/038 D19): the open follow-ups assigned to the person signed in, from the same read the Follow-ups inbox
 * uses. It is the one list of work across patients the API has. Each row names the patient and the medication, says when the reminder
 * is due and in which timezone, and opens that follow-up. "Overdue" is about the reminder's date, and the section says so.
 */
export function HomeFollowups() {
  const { data, error, reload } = useFollowups(undefined, undefined, MINE);
  const shown = data?.items.slice(0, SHOWN) ?? [];
  const more = (data?.items.length ?? 0) - shown.length;
  return (
    <section aria-label="Follow-ups assigned to you" className="mx-auto mt-6 flex w-full max-w-md flex-col gap-2 text-sm">
      <h2 className="font-medium">Follow-ups assigned to you</h2>
      {error ? (
        <>
          <p>Follow-ups could not be loaded, so none are listed here.</p>
          <Button variant="outline" size="sm" className="self-start" onClick={reload}>
            Retry follow-ups
          </Button>
        </>
      ) : !data ? (
        <p className="text-muted-foreground">Loading follow-ups…</p>
      ) : data.items.length === 0 ? (
        <p className="text-muted-foreground">No open follow-ups are assigned to you.</p>
      ) : (
        <>
          <ul className="divide-y divide-divider">
            {shown.map((entry) => {
              const drug = drugPresentation({ name: entry.medicationName });
              return (
                <li key={entry.id} className="flex flex-col py-1">
                  <Link
                    className="inline-flex min-h-control items-center font-medium underline-offset-2 wrap-anywhere hover:underline"
                    to={`/patients/${entry.patientId}?followup=${entry.threadId}#followups`}
                    aria-label={`Open follow-up for ${entry.patientLabel}, ${drug.ariaLabel}`}
                  >
                    {entry.patientLabel} · {drug.displayName}
                  </Link>
                  <p className={entry.dueState === 'overdue' ? 'text-warning' : 'text-muted-foreground'}>
                    {DUE_WORDS[entry.dueState]} · {entry.next?.date} ({entry.next?.timezone})
                  </p>
                </li>
              );
            })}
          </ul>
          {(more > 0 || data.hasMore) && <p className="text-muted-foreground">There are more. The full list, with its filters, is under Follow-ups in the sidebar.</p>}
          {shown.some((entry) => entry.dueState === 'overdue') && (
            <p className="text-xs text-muted-foreground">Overdue means the reminder’s date has passed. It is not a clinical warning.</p>
          )}
        </>
      )}
    </section>
  );
}
