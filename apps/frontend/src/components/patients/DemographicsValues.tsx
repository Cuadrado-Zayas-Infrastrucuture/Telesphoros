import type { PatientDemographicsDto } from '@telesphoros/shared-types';
import { ETHNICITY_LABELS, SEX_LABELS } from '@/lib/demographicsDraft';
import { onDate, when } from '@/lib/formatWhen';
import { exactAge } from '@/lib/patientSummary';

export function DemographicsValues({ value }: { value: PatientDemographicsDto }) {
  // The same exact age as the banner above (specs/041 D2); the year-based one only when the date cannot be read.
  const age = exactAge(value.dateOfBirth);
  const rows: [string, string][] = [
    ['Given name', value.givenName],
    ['Family name', value.familyName],
    ['Date of birth', onDate(value.dateOfBirth)],
    ['Age', age === null ? `${value.ageYears} (from the birth year; can be one year high)` : `${age} years`],
    ['Sex', value.sex ? SEX_LABELS[value.sex] : 'Not recorded'],
    ['Ethnicity', value.ethnicity ? value.ethnicity.map((code) => ETHNICITY_LABELS[code]).join(', ') : 'Not recorded'],
    ['Recorded', `${when(value.createdAt)}, version ${value.version}`],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
      {rows.map(([term, detail]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className={detail === 'Not recorded' ? 'text-warning sm:col-span-2' : 'wrap-anywhere text-foreground sm:col-span-2'}>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}
