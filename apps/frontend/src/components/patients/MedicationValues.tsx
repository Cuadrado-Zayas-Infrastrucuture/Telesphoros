import { drugPresentation, type PatientMedicationDto } from '@telesphoros/shared-types';

export function MedicationValues({ value, compact = false }: { value: PatientMedicationDto; compact?: boolean }) {
  const display = drugPresentation(value);
  if (compact)
    return (
      <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-2 sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium wrap-anywhere" aria-label={display.ariaLabel}>
            {display.displayName}
          </h3>
          <p className="text-xs text-muted-foreground">{value.status === 'active' ? 'Active' : 'Stopped'}</p>
        </div>
        <div className="min-w-0 text-xs text-muted-foreground">
          <p>{value.source === 'patient-reported' ? 'Patient-reported' : 'Clinician-entered'}</p>
          <p>
            Start: {value.startMonth ?? 'Not recorded'} · Stop: {value.stopMonth ?? 'Not recorded'}
          </p>
        </div>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="font-medium wrap-anywhere" aria-label={display.ariaLabel}>
        {display.displayName}
      </h3>
      <p className="text-sm">
        {value.status === 'active' ? 'Active' : 'Stopped'} · {value.source === 'patient-reported' ? 'Patient-reported' : 'Clinician-entered'}
      </p>
      <p className="text-sm text-muted-foreground">
        Start: {value.startMonth ?? 'Not recorded'} · Stop: {value.stopMonth ?? 'Not recorded'}
      </p>
      <p className="text-sm text-muted-foreground">
        Version {value.version}
        {value.current ? ' (current)' : ' (earlier)'}
      </p>
    </div>
  );
}
