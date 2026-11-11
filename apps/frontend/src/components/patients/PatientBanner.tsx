import type { PatientDemographicsDto } from '@telesphoros/shared-types';
import { SEX_LABELS } from '@/lib/demographicsDraft';
import { exactAge } from '@/lib/patientSummary';

/**
 * Who this record is about, at the top of the page: name, date of birth, exact age and sex, so a clinician can
 * confirm the patient without reading down to the demographics table. It shows values this page has already read
 * for this one patient; like the table, they live only in page state (never in the title, the address or a log).
 */
export function PatientBanner({ value }: { value: PatientDemographicsDto }) {
  const name = [value.givenName, value.familyName].filter(Boolean).join(' ');
  const age = exactAge(value.dateOfBirth);
  const facts = [value.dateOfBirth ? `Born ${value.dateOfBirth}` : null, age === null ? null : `${age} years`, value.sex ? SEX_LABELS[value.sex] : null].filter(Boolean);
  if (!name && facts.length === 0) return null;
  return (
    <div role="group" aria-label="Patient identity" className="flex flex-col gap-1 border-l-2 border-primary pl-3">
      {name && <p className="text-lg font-medium wrap-anywhere">{name}</p>}
      {facts.length > 0 && <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>}
    </div>
  );
}
