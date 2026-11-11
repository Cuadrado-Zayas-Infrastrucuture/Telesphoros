import { Skeleton } from '@/components/ui/Skeleton';
import { useId } from 'react';
import type { PatientDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import type { NativeSelectProps } from '@/components/ui/NativeSelect';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { patientSummary } from '@/lib/patientSummary';

/** `sex` and `birthYear` are the coded fields list items carry; when present they confirm the choice under the select. */
type PatientChoice = Pick<PatientDto, 'id' | 'label'> & Partial<Pick<PatientDto, 'sex' | 'birthYear'>>;

export interface PatientPickerProps extends Omit<NativeSelectProps, 'children' | 'value' | 'defaultValue' | 'onChange'> {
  patients: readonly PatientChoice[] | null;
  value: string;
  onValueChange: (id: string) => void;
  /** Keep a selected patient visible when paging or after creating it. */
  selectedPatient?: PatientChoice | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyMessage?: string;
  /** Only callers that create a patient may offer this choice. Creation stays with the caller. */
  newPatientOption?: { value: string; label: string };
}

/** Controlled, native patient choice. Callers own requests, pagination and patient creation; refs and ARIA attributes reach the select. */
export function PatientPicker({
  patients,
  value,
  onValueChange,
  selectedPatient,
  loading = false,
  error,
  onRetry,
  emptyMessage = 'No patients yet.',
  newPatientOption,
  disabled,
  id,
  'aria-describedby': describedBy,
  ...props
}: PatientPickerProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const stateId = `${selectId}-state`;
  const chosenId = `${selectId}-chosen`;
  // The option text stays the plain code (tests and tools find a patient by it); this line is the second check.
  const chosen = value ? (patients?.find((patient) => patient.id === value) ?? (selectedPatient?.id === value ? selectedPatient : null)) : null;
  const chosenSummary = chosen ? patientSummary(chosen) : '';
  const busy = loading || (patients === null && !error);
  const message = busy ? 'Loading patients…' : error || (patients?.length === 0 ? emptyMessage : null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <NativeSelect
        {...props}
        id={selectId}
        value={value}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={[describedBy, message ? stateId : null, chosenSummary ? chosenId : null].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="">Choose an existing patient…</option>
        {selectedPatient && !patients?.some((patient) => patient.id === selectedPatient.id) && <option value={selectedPatient.id}>{selectedPatient.label}</option>}
        {patients?.map((patient) => (
          <option key={patient.id} value={patient.id}>
            {patient.label}
          </option>
        ))}
        {newPatientOption && <option value={newPatientOption.value}>{newPatientOption.label}</option>}
      </NativeSelect>
      {chosen && chosenSummary && (
        <p id={chosenId} className="text-sm text-muted-foreground">
          {chosen.label} · {chosenSummary}
        </p>
      )}
      {busy && (
        <div aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      )}
      {message && (
        <div className="flex flex-wrap items-center gap-2">
          <p id={stateId} role={!busy && error ? 'alert' : 'status'} className={!busy && error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {message}
          </p>
          {!busy && error && onRetry && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label="Retry loading patients" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
