import { useEffect, useState } from 'react';
import { BUNDLED_DRUG_LIST, matchesDrug, type PatientMedicationDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { MedicationForm } from '@/components/patients/MedicationForm';
import { MedicationHistory } from '@/components/patients/MedicationHistory';
import { MedicationValues } from '@/components/patients/MedicationValues';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { readMedications } from '@/lib/patientMedications';

export function MedicationsSection({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { apiFetch } = useAuth();
  const [items, setItems] = useState<PatientMedicationDto[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<{ entry?: PatientMedicationDto; stopping?: boolean } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    readMedications(apiFetch, patientId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setItems(rows);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [apiFetch, patientId, attempt]);
  const reload = () => {
    setItems(null);
    setError(false);
    setHistory(null);
    setExpanded(null);
    setAttempt((n) => n + 1);
  };
  const edit = (next: NonNullable<typeof editing>) => {
    setSaved(false);
    setEditing(next);
  };
  const ordered = items
    ? items.filter((item) => matchesDrug(item, filter)).sort((a, b) => Number(a.status === 'stopped') - Number(b.status === 'stopped') || a.name.localeCompare(b.name))
    : [];
  return (
    <section aria-labelledby="medications-heading" className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 id="medications-heading" className="text-lg font-semibold">
          Medications
        </h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(editing) || items === null}
          onClick={() => {
            setSaved(false);
            reload();
          }}
        >
          Refresh medications
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Recorded medications only. This list does not change reports or provide drug–gene guidance.</p>
      {items && items.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {items.filter((item) => item.status === 'active').length} active · {items.filter((item) => item.status === 'stopped').length} stopped
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="medications-filter">Find recorded medication</Label>
            <Input id="medications-filter" value={filter} autoComplete="off" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
          </div>
        </div>
      )}
      {saved && (
        <p role="status" className="text-sm">
          Medication saved.
        </p>
      )}
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">Medications could not be loaded.</p>
          <Button size="sm" variant="outline" onClick={reload}>
            Reload medications
          </Button>
        </div>
      ) : items === null ? (
        <p role="status">Loading medications…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No medications recorded yet.</p>
      ) : ordered.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No recorded medications match this filter.
        </p>
      ) : (
        <ul aria-label="Recorded medications" className="divide-y divide-border border-y border-border">
          {ordered.map((entry) => (
            <li key={entry.entryId} className="flex flex-col gap-2 py-2">
              <div className="flex items-start gap-2 sm:items-center">
                <MedicationValues value={entry} compact />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Details for ${entry.name}`}
                  aria-expanded={expanded === entry.entryId}
                  onClick={() => {
                    setExpanded(expanded === entry.entryId ? null : entry.entryId);
                    setHistory(null);
                  }}
                >
                  Details
                </Button>
              </div>
              {expanded === entry.entryId && (
                <div className="flex flex-col gap-3 pb-2">
                  <p className="text-xs text-muted-foreground">Version {entry.version} (current)</p>
                  <div className="flex flex-wrap gap-2">
                    {canWrite && BUNDLED_DRUG_LIST && !editing && (
                      <>
                        <Button size="sm" variant="outline" aria-label={`Correct ${entry.name}`} onClick={() => edit({ entry })}>
                          Correct
                        </Button>
                        {entry.status === 'active' && (
                          <Button size="sm" variant="outline" aria-label={`Stop ${entry.name}`} onClick={() => edit({ entry, stopping: true })}>
                            Stop
                          </Button>
                        )}
                      </>
                    )}
                    {entry.version > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Earlier versions of ${entry.name}`}
                        aria-expanded={history === entry.entryId}
                        onClick={() => setHistory(history === entry.entryId ? null : entry.entryId)}
                      >
                        Earlier versions
                      </Button>
                    )}
                  </div>
                  {history === entry.entryId && <MedicationHistory key={entry.version} patientId={patientId} current={entry} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite &&
        (editing ? (
          <MedicationForm
            patientId={patientId}
            initial={editing.entry}
            stopping={editing.stopping}
            onCancel={() => {
              setEditing(null);
              reload();
            }}
            onSaved={() => {
              setEditing(null);
              setSaved(true);
              reload();
            }}
          />
        ) : (
          !error &&
          items !== null && (
            <div>
              <Button size="sm" onClick={() => edit({})} disabled={!BUNDLED_DRUG_LIST}>
                Add medication
              </Button>
            </div>
          )
        ))}
      {!BUNDLED_DRUG_LIST && <p role="status">The verified drug list is unavailable. Medication changes are disabled.</p>}
    </section>
  );
}
