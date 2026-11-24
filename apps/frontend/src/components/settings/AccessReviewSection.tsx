import { type FormEvent, useState } from 'react';
import type { AccessReviewPage } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { NativeSelect } from '@/components/ui/NativeSelect';
import type { ApiFetch } from '@/lib/api';
import { exportAccessReview, readAccessReview, type AccessReviewFilter } from '@/lib/accessReview';
import { SettingsSection } from './SettingsSection';

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'page'; page: AccessReviewPage } | { kind: 'message'; text: string };
const MESSAGES = {
  forbidden: 'Only administrators of this organization can review access.',
  invalid: 'Check the filter: choose a patient id or a member, and at most 92 days.',
  failed: 'The access review could not be loaded. Try again.',
} as const;
const READ_NAMES: Record<string, string> = { 'private-read': 'Read', 'download-link': 'Report file link' };
const OUTCOMES: Record<string, string> = { succeeded: 'Allowed', refused: 'Refused' };
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Spec 046: who read which patient, for administrators (Settings). It reads the organization's existing access audit; it shows ids, route keys,
 * outcomes and times, never a patient label or a clinical value (D3, AR-6). A failure says so: it never looks like "nobody read anything".
 */
export function AccessReviewSection({ apiFetch }: { apiFetch: ApiFetch }) {
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 29 * 86_400_000);
  const [by, setBy] = useState<'patient' | 'member'>('patient');
  const [value, setValue] = useState('');
  const [fromDate, setFromDate] = useState(day(monthAgo));
  const [toDate, setToDate] = useState(day(today));
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [shown, setShown] = useState<{ filter: AccessReviewFilter; page: number } | null>(null);
  const [download, setDownload] = useState<string | null>(null);

  const filter = (): AccessReviewFilter => ({ ...(by === 'patient' ? { patientId: value.trim() || undefined } : { member: value.trim() || undefined }), fromDate, toDate });
  const load = async (f: AccessReviewFilter, page: number) => {
    setState({ kind: 'loading' });
    const result = await readAccessReview(apiFetch, f, page);
    setShown({ filter: f, page });
    setState(result.kind === 'page' ? { kind: 'page', page: result.page } : { kind: 'message', text: MESSAGES[result.kind] });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(filter(), 1);
  };
  const saveCsv = async () => {
    if (!shown) return;
    setDownload('Preparing the file…');
    const blob = await exportAccessReview(apiFetch, shown.filter);
    if (!blob) return setDownload('The file could not be prepared. Try again.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `access-review-${shown.filter.fromDate}-to-${shown.filter.toDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setDownload('The file is downloaded.');
  };

  return (
    <SettingsSection id="settings-access-review" title="Access review" description="Who opened which patient's record, from this organization's access audit. Ids only.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="grid gap-1">
          <Label htmlFor="access-review-by">Look up by</Label>
          <NativeSelect id="access-review-by" value={by} onChange={(e) => setBy(e.target.value === 'member' ? 'member' : 'patient')}>
            <option value="patient">Patient id</option>
            <option value="member">Member</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="access-review-value">{by === 'patient' ? 'Patient id' : 'Member'}</Label>
          <Input id="access-review-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Leave empty for every read" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="access-review-from">From</Label>
          <Input id="access-review-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} required />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="access-review-to">To</Label>
          <Input id="access-review-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} required />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" pending={state.kind === 'loading'} pendingLabel="Loading…">
            Show reads
          </Button>
          <Button type="button" variant="outline" disabled={state.kind !== 'page'} onClick={() => void saveCsv()}>
            Download CSV
          </Button>
        </div>
      </form>
      <div className="mt-4" aria-live="polite">
        {state.kind === 'idle' && <p className="text-sm text-muted-foreground">Choose a patient or a member and a window, then Show reads.</p>}
        {state.kind === 'message' && <p className="text-sm text-destructive">{state.text}</p>}
        {download && <p className="text-sm text-muted-foreground">{download}</p>}
        {state.kind === 'page' && state.page.data.length === 0 && <p className="text-sm text-muted-foreground">No reads in this window.</p>}
        {state.kind === 'page' && state.page.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Reads of patient records</caption>
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-2">
                    When
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Member
                  </th>
                  <th scope="col" className="px-2 py-2">
                    What
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Outcome
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Patient
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.page.data.map((row, i) => (
                  <tr key={`${row.occurredAt}-${row.routeKey}-${i}`} className="border-t">
                    <td className="px-2 py-2 tabular-nums">{new Date(row.occurredAt).toLocaleString()}</td>
                    <td className="px-2 py-2">{row.member}</td>
                    <td className="px-2 py-2">
                      {READ_NAMES[row.event] ?? row.event}: <code>{row.routeKey}</code>
                    </td>
                    <td className={`px-2 py-2 ${row.outcome === 'refused' ? 'text-destructive' : ''}`}>{OUTCOMES[row.outcome] ?? row.outcome}</td>
                    <td className="px-2 py-2">{row.patientId ? <code>{row.patientId}</code> : 'Not a patient record'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.kind === 'page' && shown && (state.page.hasMore || shown.page > 1) && (
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" disabled={shown.page <= 1} onClick={() => void load(shown.filter, shown.page - 1)}>
              Previous
            </Button>
            <Button type="button" variant="outline" disabled={!state.page.hasMore} onClick={() => void load(shown.filter, shown.page + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
