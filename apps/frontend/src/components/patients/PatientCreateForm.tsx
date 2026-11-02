import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { PatientDemographicsFields } from '@/components/patients/PatientDemographicsFields';
import { Button } from '@/components/ui/Button';
import { useAddPatient } from '@/hooks/useAddPatient';
import { announcePatientAdded } from '@/lib/workspaceEvents';

/** Patient creation and demographics share retry identities through useAddPatient. */
export function PatientCreateForm() {
  const navigate = useNavigate();
  const form = useAddPatient(announcePatientAdded);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  async function add() {
    const outcome = await form.submit();
    if (!outcome) return;
    announcePatientAdded({ ...outcome.patient, demographicsComplete: outcome.complete });
    navigate(`/patients/${outcome.patient.id}`);
  }
  return (
    <form
      className="flex flex-col gap-2 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      {form.pending ? (
        <p className="text-xs text-muted-foreground">
          Patient <span className="font-medium text-foreground">{form.pending.label}</span> exists. Save its demographics, or close and add them later.
        </p>
      ) : (
        <>
          <label htmlFor="new-patient-label" className="text-xs font-medium">
            Synthetic patient label
          </label>
          <input
            ref={field}
            id="new-patient-label"
            value={form.label}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            readOnly={form.busy}
            aria-invalid={form.labelError ? true : undefined}
            aria-describedby={form.labelError ? 'new-patient-help new-patient-error' : 'new-patient-help'}
            placeholder="SYN-0002"
            onChange={(event) => form.setLabel(event.target.value)}
            className="h-11 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
          <p id="new-patient-help" className="text-xs text-muted-foreground">
            Letters, numbers and hyphens. A code, never a name.
          </p>
          {form.labelError && (
            <p id="new-patient-error" role="alert" className="text-xs text-destructive">
              {form.labelError}
            </p>
          )}
        </>
      )}
      <PatientDemographicsFields idPrefix="new-patient" value={form.draft} errors={form.errors} disabled={form.busy} onChange={form.setDraft} />
      {form.problem && (
        <p role="alert" className="text-xs text-destructive">
          {form.problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" pending={form.busy} pendingLabel="Saving…">
          {form.pending ? 'Save demographics' : 'Create patient'}
        </Button>
        <Button
          type="button"
          disabled={form.busy}
          variant="ghost"
          size="sm"
          onClick={() => {
            form.reset();
            navigate('/workspace');
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
