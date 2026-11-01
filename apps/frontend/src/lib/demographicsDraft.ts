import {
  ETHNICITY_CODES,
  patientDemographicsInputSchema,
  SEX_CODES,
  type EthnicityCode,
  type PatientDemographicsDto,
  type PatientDemographicsInput,
  type PatientDto,
  type SexCode,
} from '@telesphoros/shared-types';

/** What the form holds while someone types. Sex '' means "not recorded"; an empty ethnicity list means the same. */
export interface DemographicsDraft {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: SexCode | '';
  ethnicity: EthnicityCode[];
}
export type DraftField = keyof DemographicsDraft;
export type DraftErrors = Partial<Record<DraftField, string>>;

export const EMPTY_DRAFT: DemographicsDraft = { givenName: '', familyName: '', dateOfBirth: '', sex: '', ethnicity: [] };

/** The words shown for each code. The codes themselves (spec 025 D3) are what is stored. */
export const SEX_LABELS: Record<SexCode, string> = { male: 'Male', female: 'Female' };
export const ETHNICITY_LABELS: Record<EthnicityCode, string> = {
  'american-indian-or-alaska-native': 'American Indian or Alaska Native',
  asian: 'Asian',
  'black-or-african-american': 'Black or African American',
  'hispanic-or-latino': 'Hispanic or Latino',
  'middle-eastern-or-north-african': 'Middle Eastern or North African',
  'native-hawaiian-or-pacific-islander': 'Native Hawaiian or Pacific Islander',
  white: 'White',
};
export { ETHNICITY_CODES, SEX_CODES };

/** The draft of an existing version, for a correction. */
export function draftFrom(value: PatientDemographicsDto): DemographicsDraft {
  return { givenName: value.givenName, familyName: value.familyName, dateOfBirth: value.dateOfBirth, sex: value.sex ?? '', ethnicity: [...(value.ethnicity ?? [])] };
}

export function isBlank(draft: DemographicsDraft): boolean {
  return !draft.givenName.trim() && !draft.familyName.trim() && !draft.dateOfBirth && !draft.sex && draft.ethnicity.length === 0;
}

const FIELDS: readonly DraftField[] = ['givenName', 'familyName', 'dateOfBirth', 'sex', 'ethnicity'];

/**
 * Checks a draft with the API's own schema, so the browser can never accept what the server refuses. Messages name the problem, never the value (D7).
 * `optional`: a blank draft is allowed and means "no demographics yet" (the patient shows Incomplete); anything typed must then be a complete version.
 */
export function checkDraft(draft: DemographicsDraft, optional: boolean): { input: PatientDemographicsInput | null; errors: DraftErrors } {
  if (optional && isBlank(draft)) return { input: null, errors: {} };
  const parsed = patientDemographicsInputSchema.safeParse({
    givenName: draft.givenName,
    familyName: draft.familyName,
    dateOfBirth: draft.dateOfBirth,
    sex: draft.sex || null,
    ethnicity: draft.ethnicity.length ? draft.ethnicity : null,
  });
  if (parsed.success) return { input: parsed.data, errors: {} };
  const errors: DraftErrors = {};
  for (const issue of parsed.error.issues) {
    const field = FIELDS.find((name) => name === issue.path[0]);
    if (field && !errors[field]) errors[field] = issue.message;
  }
  if (!draft.givenName.trim()) errors.givenName = 'Enter the given name.';
  if (!draft.familyName.trim()) errors.familyName = 'Enter the family name.';
  if (!draft.dateOfBirth) errors.dateOfBirth = 'Enter the date of birth.';
  return { input: null, errors };
}

/** Is this list row Incomplete (spec 025 D9)? A list response carries `demographicsComplete`; anything else (a single patient, an older API) is unknown. */
export function incompleteness(patient: Pick<PatientDto, 'demographicsComplete'>): 'complete' | 'incomplete' | 'unknown' {
  if (patient.demographicsComplete === true) return 'complete';
  if (patient.demographicsComplete === false) return 'incomplete';
  return 'unknown';
}
