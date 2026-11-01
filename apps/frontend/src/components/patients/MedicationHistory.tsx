import { useEffect, useState } from 'react';
import type { PatientMedicationDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { MedicationValues } from '@/components/patients/MedicationValues';
import { Button } from '@/components/ui/Button';
import { readMedications } from '@/lib/patientMedications';

export function MedicationHistory({ patientId, current }: { patientId: string; current: PatientMedicationDto }) {
  const { apiFetch } = useAuth();
  const [version, setVersion] = useState(current.version - 1);
  const [value, setValue] = useState<PatientMedicationDto | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readMedications(apiFetch, patientId, controller.signal, current.entryId, version)
      .then((rows) => {
        if (controller.signal.aborted) return;
        if (!rows[0]) {
          setError(true);
          return;
        }
        setValue(rows[0]);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [apiFetch, patientId, current.entryId, version, attempt]);
  const view = (next: number) => {
    setValue(null);
    setError(false);
    setVersion(next);
  };
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3" aria-label="Medication history">
      {error ? (
        <div>
          <p role="alert">That version could not be loaded.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(false);
              setAttempt((n) => n + 1);
            }}
          >
            Retry version
          </Button>
        </div>
      ) : value ? (
        <MedicationValues value={value} />
      ) : (
        <p role="status">Loading version…</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={version <= 1} onClick={() => view(version - 1)}>
          Previous version
        </Button>
        <Button variant="outline" size="sm" disabled={version >= current.version - 1} onClick={() => view(version + 1)}>
          Next version
        </Button>
      </div>
    </div>
  );
}
