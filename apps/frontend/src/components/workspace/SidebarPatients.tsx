import { useCallback, useEffect, useRef, useState } from 'react';
import { patientLabelSchema, type PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { createPatient, listPatients, SubmitError } from '@/lib/api';
import { announcePatientAdded, onPatientAdded } from '@/lib/workspaceEvents';

/**
 * The panel's "Patients": the first page of synthetic labels, and for writer roles an "Add patient" control (specs/024 D2a). Adding follows the Upload page:
 * the label is checked first, and a retry with the same label replays the first request id, so a lost response never makes a second patient.
 */
export function SidebarPatients() {
  const { apiFetch, roles } = useAuth();
  const canAdd = roles.some((role) => WRITER_ROLES.includes(role));
  const [patients, setPatients] = useState<PatientDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const request = useRef<{ label: string; id: string } | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      listPatients(apiFetch, 1, signal, 'newest')
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
    const parsed = patientLabelSchema.safeParse(label);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Enter a synthetic patient label.');
      return;
    }
    const clean = parsed.data;
    const attempt = request.current?.label === clean ? request.current : { label: clean, id: crypto.randomUUID() };
    request.current = attempt;
    setAdding(true);
    setProblem(null);
    setAdded(null);
    try {
      const created = await createPatient(apiFetch, clean, attempt.id);
      request.current = null;
      setPatients((list) => (list?.some((p) => p.id === created.id) ? list : [created, ...(list ?? [])]));
      announcePatientAdded(created);
      setLabel('');
      setOpen(false);
      setAdded(`Added ${created.label}.`);
      toggle.current?.focus();
    } catch (caught) {
      if (!(caught instanceof SessionEndedError)) setProblem(caught instanceof SubmitError ? caught.message : 'The patient could not be added. Please retry.');
    } finally {
      setAdding(false);
    }
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
            <li key={patient.id} className="truncate py-1 text-xs text-foreground">
              {patient.label}
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
            <label htmlFor="panel-patient-label" className="text-xs font-medium">
              Synthetic patient label
            </label>
            <input
              ref={field}
              id="panel-patient-label"
              value={label}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              readOnly={adding}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'panel-patient-help panel-patient-error' : 'panel-patient-help'}
              placeholder="SYN-0002"
              onChange={(event) => {
                setLabel(event.target.value);
                setProblem(null);
              }}
              className="h-11 w-full rounded-md border border-border bg-background px-2 text-sm"
            />
            <p id="panel-patient-help" className="text-xs text-muted-foreground">
              Letters, numbers and hyphens. Never a name.
            </p>
            {problem && (
              <p id="panel-patient-error" role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" pending={adding} pendingLabel="Adding…">
                Create patient
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setProblem(null);
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
