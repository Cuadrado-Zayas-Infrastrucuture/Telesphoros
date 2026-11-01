import type { PatientDemographicsDto } from '@telesphoros/shared-types';

/** "Complete" or "Incomplete" as a word in color: complete means sex and ethnicity are both recorded (the list's `demographicsComplete`). */
export function Completeness({ value }: { value: PatientDemographicsDto | null }) {
  const complete = value !== null && value.sex !== null && value.ethnicity !== null;
  return <span className={complete ? 'text-sm text-success' : 'text-sm text-warning'}>{complete ? 'Complete' : 'Incomplete'}</span>;
}
