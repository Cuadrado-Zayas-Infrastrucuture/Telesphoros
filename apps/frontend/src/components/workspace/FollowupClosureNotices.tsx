import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FollowupClosureNotices as Notices } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/auth/AuthProvider';
import { clinicianLabel } from '@/lib/clinicianLabel';
import { acknowledgeFollowupClosure, announceFollowupsChanged, onFollowupsChanged, readFollowupClosures } from '@/lib/patientFollowups';

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * Spec 045 FN-5: reminders assigned to the signed-in clinician that someone else closed, in words, each until it is acknowledged.
 * Renders nothing while there are none, or when they cannot be read (the list below still says what it can).
 */
export function FollowupClosureNotices() {
  const { apiFetch } = useAuth();
  const [notices, setNotices] = useState<Notices | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readFollowupClosures(apiFetch, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setNotices(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotices(null);
      });
    return () => controller.abort();
  }, [apiFetch, revision]);
  useEffect(() => onFollowupsChanged(() => setRevision((value) => value + 1)), []);
  if (!notices || notices.items.length === 0) return null;
  const acknowledge = async (thread: string, followupId: string) => {
    setSaving(followupId);
    setFailed(null);
    try {
      await acknowledgeFollowupClosure(apiFetch, thread, followupId);
      setNotices((current) => (current ? { items: current.items.filter((item) => item.followupId !== followupId), total: Math.max(0, current.total - 1) } : current));
      announceFollowupsChanged();
    } catch {
      setFailed(followupId);
    } finally {
      setSaving(null);
    }
  };
  return (
    <section aria-labelledby="followup-closures-heading" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <h2 id="followup-closures-heading" className="text-base font-medium">
        Closed by someone else
      </h2>
      <p className="text-sm text-muted-foreground">
        {notices.total === 1 ? 'One of your reminders was closed by another clinician.' : `${notices.total} of your reminders were closed by another clinician.`}
      </p>
      <ul className="divide-y divide-border">
        {notices.items.map((item) => (
          <li key={item.followupId} className="flex flex-col gap-1 py-2">
            <Link className="inline-flex min-h-control items-center font-medium text-primary underline-offset-2 hover:underline" to={`/patients/${item.patientId}?followup=${item.threadId}#followups`}>
              <span className="slashed-zero">{item.patientLabel}</span> · {item.medicationName}
            </Link>
            <p className="text-sm">
              Closed by {clinicianLabel(item.closedBy)} on {day.format(new Date(item.closedAt))}: {item.noteRedacted ? 'note removed' : item.note}
            </p>
            {failed === item.followupId && (
              <p role="alert" className="text-sm text-warning">
                Acknowledgement was not saved. Please retry.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={saving !== null}
              aria-label={`Acknowledge closure for ${item.patientLabel}`}
              onClick={() => void acknowledge(item.threadId, item.followupId)}
            >
              Acknowledge
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
