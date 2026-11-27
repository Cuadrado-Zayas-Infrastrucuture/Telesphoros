import type { PatientDemographicsDto } from '@telesphoros/shared-types';
import { onDate } from '@/lib/formatWhen';
import { exactAge } from '@/lib/patientSummary';
import { PATIENT_BANNER_WORDS } from '@/lib/words/patient';
import { useWords } from '@/lib/words/screens';

/**
 * Who this record is about, at the top of the page: name, date of birth, exact age and sex, so a clinician can
 * confirm the patient without reading down to the demographics table. It shows values this page has already read
 * for this one patient; like the table, they live only in page state (never in the title, the address or a log).
 */
export function PatientBanner({ value }: { value: PatientDemographicsDto }) {
  const words = useWords(PATIENT_BANNER_WORDS);
  const name = [value.givenName, value.familyName].filter(Boolean).join(' ');
  const age = exactAge(value.dateOfBirth);
  const sexLabel = value.sex === 'male' ? words.sexMale : value.sex === 'female' ? words.sexFemale : null;
  const facts = [value.dateOfBirth ? words.born(onDate(value.dateOfBirth)) : null, age === null ? null : words.years(String(age)), sexLabel].filter(Boolean);
  if (!name && facts.length === 0) return null;
  return (
    <div role="group" aria-label={words.groupLabel} className="flex flex-col gap-1 border-l-2 border-primary pl-3">
      {name && <p className="text-lg font-medium wrap-anywhere">{name}</p>}
      {facts.length > 0 && <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>}
    </div>
  );
}
