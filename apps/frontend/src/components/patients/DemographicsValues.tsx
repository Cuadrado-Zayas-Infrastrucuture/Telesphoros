import type { PatientDemographicsDto } from '@telesphoros/shared-types';
import { ETHNICITY_LABELS, SEX_LABELS } from '@/lib/demographicsDraft';
import { when } from '@/lib/formatWhen';

export function DemographicsValues({ value }: { value: PatientDemographicsDto }) {
  const rows: [string, string][] = [
    ['Given name', value.givenName],
    ['Family name', value.familyName],
    ['Date of birth', value.dateOfBirth],
    ['Age', `${value.ageYears} (from the birth year; can be one year high)`],
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
