import { useId, useRef, useState } from 'react';
import { BUNDLED_DRUG_LIST, patientMedicationInputSchema, type PatientMedicationDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { DrugPicker } from '@/components/patients/DrugPicker';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { SubmitError } from '@/lib/api';
import { recordMedication } from '@/lib/patientMedications';

export function MedicationForm(props: { patientId: string; initial?: PatientMedicationDto; stopping?: boolean; onCancel: () => void; onSaved: () => void }) {
  const id = useId();
  const { apiFetch } = useAuth();
  const [drug, setDrug] = useState(props.initial?.rxcui ?? '');
  const [status, setStatus] = useState(props.stopping ? 'stopped' : (props.initial?.status ?? 'active'));
  const [source, setSource] = useState(props.initial?.source ?? 'clinician-entered');
  const [start, setStart] = useState(props.initial?.startMonth ?? '');
  const [stop, setStop] = useState(props.initial?.stopMonth ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saving = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const initial = props.initial;
  const retired = initial && BUNDLED_DRUG_LIST && !BUNDLED_DRUG_LIST.entries.some((entry) => entry.rxcui === initial.rxcui) ? initial : undefined;
  const label = props.stopping ? 'Stop medication' : props.initial ? 'Correct medication' : 'Add medication';

  async function save() {
    if (saving.current) return;
    const fields = {
      rxcui: drug,
      listVersion: BUNDLED_DRUG_LIST?.version,
      status,
      source,
      startMonth: start || null,
      stopMonth: stop || null,
      ...(props.initial ? { entryId: props.initial.entryId, expectedVersion: props.initial.version } : {}),
    };
    const key = JSON.stringify(fields);
    const attempt = request.current?.key === key ? request.current : { key, id: crypto.randomUUID() };
    const checked = patientMedicationInputSchema.safeParse({ ...fields, requestId: attempt.id });
    if (!checked.success) {
      setProblem('Choose a drug and valid months from 1900 to 2199. Stop must not precede start; active entries have no stop month.');
      return;
    }
    request.current = attempt;
    saving.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await recordMedication(apiFetch, props.patientId, checked.data);
      props.onSaved();
    } catch (error) {
      if (error instanceof SessionEndedError || error instanceof NotSignedInError) return;
      setProblem(error instanceof SubmitError ? error.message : 'The medication could not be saved. Please retry.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={label}
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {props.initial ? 'This adds a version. Earlier versions stay readable.' : 'Record one ingredient. Dates are optional year-months.'}
      </p>
      {retired ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-recorded-drug`}>Recorded drug</Label>
          <Input id={`${id}-recorded-drug`} value={retired.name} readOnly aria-describedby={`${id}-retired-help`} />
          <p id={`${id}-retired-help`} className="text-sm text-muted-foreground">
            This ingredient is no longer in the current list. Its recorded identity is retained.
          </p>
        </div>
      ) : (
        <DrugPicker value={drug} disabled={busy || Boolean(props.stopping)} onChange={setDrug} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <NativeSelect
            id={`${id}-status`}
            value={status}
            disabled={busy || props.stopping}
            onChange={(event) => {
              setStatus(event.target.value as 'active' | 'stopped');
              if (event.target.value === 'active') setStop('');
            }}
          >
            <option value="active">Active</option>
            <option value="stopped">Stopped</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-source`}>Source</Label>
          <NativeSelect id={`${id}-source`} value={source} disabled={busy} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="clinician-entered">Clinician-entered</option>
            <option value="patient-reported">Patient-reported</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-start`}>Start month (optional)</Label>
          <Input id={`${id}-start`} type="month" min="1900-01" max="2199-12" value={start} disabled={busy} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-stop`}>Stop month (optional)</Label>
          <Input
            id={`${id}-stop`}
            type="month"
            min={start || '1900-01'}
            max="2199-12"
            value={stop}
            disabled={busy || status === 'active'}
            onChange={(event) => setStop(event.target.value)}
          />
        </div>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !BUNDLED_DRUG_LIST}>
          {busy ? 'Saving…' : props.stopping ? 'Save stopped medication' : props.initial ? 'Save correction' : 'Save medication'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
