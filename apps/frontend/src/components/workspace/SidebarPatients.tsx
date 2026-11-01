import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { IncompleteWord } from '@/components/patients/IncompleteWord';
import { PatientDemographicsFields } from '@/components/patients/PatientDemographicsFields';
import { Button } from '@/components/ui/Button';
import { useAddPatient } from '@/hooks/useAddPatient';
import { listPatients } from '@/lib/api';
import { announcePatientAdded, onPatientAdded } from '@/lib/workspaceEvents';

/**
 * The panel's "Patients": the first page of synthetic labels, each a link to the patient's page and marked "Incomplete" when its demographics are missing,
 * and for writer roles an "Add patient" control (specs/024 D2a) that also asks the demographics (spec 025 T301, `useAddPatient`).
 */
export function SidebarPatients() {
  const { apiFetch, roles } = useAuth();
  const canAdd = roles.some((role) => WRITER_ROLES.includes(role));
  const [patients, setPatients] = useState<PatientDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const form = useAddPatient((created) => {
    setPatients((list) => (list?.some((p) => p.id === created.id) ? list : [created, ...(list ?? [])]));
    announcePatientAdded(created);
  });
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      listPatients(apiFetch, 1, signal)
        .then((result) => {
          setFailed(false);
          setPatients(result.data);
        })
        .catch((caught: unknown) => {
          if (signal?.aborted || caught instanceof SessionEndedError) return;
          setFailed(true);
        });
    },
    [apiFetch],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    // The chat can add a patient too; show it here without another request.
    const stop = onPatientAdded((patient) => setPatients((list) => (list?.some((p) => p.id === patient.id) ? list : [patient, ...(list ?? [])])));
    return () => {
      controller.abort();
      stop();
    };
  }, [load]);

  async function add() {
    setAdded(null);
    const outcome = await form.submit();
    if (!outcome) return;
    // The row came from the create response, which carries no demographics: mark it from what was just saved.
    setPatients((list) => list?.map((p) => (p.id === outcome.patient.id ? { ...p, demographicsComplete: outcome.complete } : p)) ?? list);
    setOpen(false);
    setAdded(`Added ${outcome.patient.label}.`);
    toggle.current?.focus();
  }

  return (
    <section aria-labelledby="panel-patients-heading" data-panel-item="Patients" className="workspace-panel-section flex flex-col gap-1 px-3 py-2">
      <p id="panel-patients-heading" className="text-xs font-medium text-muted-foreground">
        Patients
      </p>
      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-1 text-xs">
          <span className="text-destructive">Patients could not be loaded.</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-control px-2"
            onClick={() => {
              setFailed(false);
              load();
            }}
          >
            Retry
          </Button>
        </div>
      ) : patients === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : patients.length === 0 ? (
        <p className="text-xs text-muted-foreground">No patients yet.</p>
      ) : (
        <ul aria-label="Patients" className="flex flex-col">
          {patients.map((patient) => (
            <li key={patient.id} className="flex min-w-0 items-center gap-2 text-xs">
              <Link to={`/patients/${patient.id}`} className="flex min-h-control min-w-0 items-center truncate text-foreground underline-offset-2 hover:underline">
                {patient.label}
              </Link>
              <IncompleteWord patient={patient} className="shrink-0" />
            </li>
          ))}
        </ul>
      )}
      {added && (
        <p role="status" className="text-xs text-success">
          {added}
        </p>
      )}
      {canAdd &&
        (open ? (
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
                <label htmlFor="panel-patient-label" className="text-xs font-medium">
                  Synthetic patient label
                </label>
                <input
                  ref={field}
                  id="panel-patient-label"
                  value={form.label}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={form.busy}
                  aria-invalid={form.labelError ? true : undefined}
                  aria-describedby={form.labelError ? 'panel-patient-help panel-patient-error' : 'panel-patient-help'}
                  placeholder="SYN-0002"
                  onChange={(event) => form.setLabel(event.target.value)}
                  className="h-11 w-full rounded-md border border-border bg-background px-2 text-sm"
                />
                <p id="panel-patient-help" className="text-xs text-muted-foreground">
                  Letters, numbers and hyphens. A code, never a name.
                </p>
                {form.labelError && (
                  <p id="panel-patient-error" role="alert" className="text-xs text-destructive">
                    {form.labelError}
                  </p>
                )}
              </>
            )}
            <PatientDemographicsFields idPrefix="panel-patient" compact value={form.draft} errors={form.errors} disabled={form.busy} onChange={form.setDraft} />
            {form.problem && (
              <p role="alert" className="text-xs text-destructive">
                {form.problem}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={form.busy}>
                {form.busy ? 'Saving…' : form.pending ? 'Save demographics' : 'Create patient'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  form.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button ref={toggle} variant="ghost" size="sm" className="min-h-control justify-start px-2 text-xs" aria-expanded={false} onClick={() => setOpen(true)}>
            Add patient
          </Button>
        ))}
    </section>
  );
}
