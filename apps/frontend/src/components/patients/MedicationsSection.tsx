import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { matchesDrug, type PatientMedicationDto } from '@telesphoros/shared-types';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import { useAuth } from '@/auth/AuthProvider';
import { Tooltip } from '@/components/arc/Tooltip';
import { DrugListInformation } from '@/components/patients/DrugListInformation';
import { MedicationForm } from '@/components/patients/MedicationForm';
import { MedicationHistory } from '@/components/patients/MedicationHistory';
import { MedicationValues } from '@/components/patients/MedicationValues';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { readMedications } from '@/lib/patientMedications';
import { MEDICATIONS_WORDS } from '@/lib/words/patient';
import { useWords } from '@/lib/words/screens';

export function MedicationsSection({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { apiFetch } = useAuth();
  const words = useWords(MEDICATIONS_WORDS);
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
          {words.heading}
        </h2>
        {/* An icon with its name for assistive technology, and in a tooltip on hover and on keyboard focus (specs/041 D8, specs/042 D2). */}
        <Tooltip label={words.refresh}>
          <Button
            size="sm"
            variant="ghost"
            className="px-0"
            aria-label={words.refresh}
            disabled={Boolean(editing) || items === null}
            onClick={() => {
              setSaved(false);
              reload();
            }}
          >
            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
          </Button>
        </Tooltip>
      </div>
      <p className="text-sm text-muted-foreground">{words.disclaimer}</p>
      {items && items.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {words.counts(String(items.filter((item) => item.status === 'active').length), String(items.filter((item) => item.status === 'stopped').length))}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="medications-filter">{words.filterLabel}</Label>
            <Input id="medications-filter" value={filter} autoComplete="off" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
          </div>
        </div>
      )}
      {saved && (
        <p role="status" className="text-sm">
          {words.saved}
        </p>
      )}
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{words.loadFailed}</p>
          <Button size="sm" variant="outline" onClick={reload}>
            {words.reload}
          </Button>
        </div>
      ) : items === null ? (
        <ContentSkeleton label={words.loading} variant="list" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{words.empty}</p>
      ) : ordered.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {words.noFilterMatch}
        </p>
      ) : (
        <ul aria-label={words.listLabel} className="divide-y divide-border border-y border-border">
          {ordered.map((entry) => (
            <li key={entry.entryId} className="flex flex-col gap-2 py-2">
              <div className="flex items-start gap-2 sm:items-center">
                <MedicationValues value={entry} compact />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={words.detailsFor(entry.name)}
                  aria-expanded={expanded === entry.entryId}
                  onClick={() => {
                    setExpanded(expanded === entry.entryId ? null : entry.entryId);
                    setHistory(null);
                  }}
                >
                  {words.details}
                </Button>
              </div>
              {expanded === entry.entryId && (
                <div className="flex flex-col gap-3 pb-2">
                  <p className="text-xs text-muted-foreground">{words.currentVersion(String(entry.version))}</p>
                  <div className="flex flex-wrap gap-2">
                    {canWrite && BUNDLED_DRUG_LIST && !editing && (
                      <>
                        <Button size="sm" variant="outline" aria-label={words.correctFor(entry.name)} onClick={() => edit({ entry })}>
                          {words.correct}
                        </Button>
                        {entry.status === 'active' && (
                          <Button size="sm" variant="outline" aria-label={words.stopFor(entry.name)} onClick={() => edit({ entry, stopping: true })}>
                            {words.stop}
                          </Button>
                        )}
                      </>
                    )}
                    {entry.version > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={words.earlierVersionsFor(entry.name)}
                        aria-expanded={history === entry.entryId}
                        onClick={() => setHistory(history === entry.entryId ? null : entry.entryId)}
                      >
                        {words.earlierVersions}
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
                {words.add}
              </Button>
            </div>
          )
        ))}
      {!BUNDLED_DRUG_LIST && <p role="status">{words.drugListUnavailable}</p>}
      <DrugListInformation />
    </section>
  );
}
