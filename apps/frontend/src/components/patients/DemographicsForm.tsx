import { useRef, useState } from 'react';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { PatientDemographicsFields } from '@/components/patients/PatientDemographicsFields';
import { Button } from '@/components/ui/Button';
import { SubmitError } from '@/lib/api';
import { checkDraft, type DemographicsDraft, type DraftErrors } from '@/lib/demographicsDraft';
import { recordDemographics } from '@/lib/patientDemographics';

/** Records the first version, or a correction as a new one. The draft is dropped once saved; a retry replays the same request id. */
export function DemographicsForm(props: { patientId: string; initial: DemographicsDraft; correction: boolean; onCancel: () => void; onSaved: () => void }) {
  const { apiFetch } = useAuth();
  const [draft, setDraft] = useState<DemographicsDraft>(props.initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);

  async function save() {
    const checked = checkDraft(draft, false);
    setErrors(checked.errors);
    if (!checked.input) return;
    const key = JSON.stringify(checked.input);
    const attempt = request.current?.key === key ? request.current : { key, id: crypto.randomUUID() };
    request.current = attempt;
    setBusy(true);
    setProblem(null);
    try {
      await recordDemographics(apiFetch, props.patientId, checked.input, attempt.id);
      props.onSaved();
    } catch (caught) {
      if (caught instanceof SessionEndedError) return;
      setProblem(caught instanceof SubmitError ? caught.message : 'The demographics could not be saved. Please retry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      aria-label={props.correction ? 'Correct demographics' : 'Record demographics'}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {props.correction && <p className="text-sm text-muted-foreground">A correction adds a new version. The current one stays readable.</p>}
      <PatientDemographicsFields
        idPrefix="patient-demographics"
        value={draft}
        errors={errors}
        disabled={busy}
        onChange={(next) => {
          setDraft(next);
          setErrors({});
          setProblem(null);
        }}
      />
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : props.correction ? 'Save correction' : 'Save demographics'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
