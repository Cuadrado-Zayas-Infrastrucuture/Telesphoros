import { z } from 'zod';

/**
 * Patient demographics (specs/025-patient-demographics, slice PD-a).
 *
 * Two kinds of field, kept apart (D1):
 *   - IDENTITY: given name, family name, full date of birth. Encrypted before they reach the database, readable only through the detail read by a clinical
 *     role. They are never in a list, a log, an error or a backup in plaintext.
 *   - ANALYTIC ATTRIBUTES: sex, birth year, ethnicity. Coded values from closed vocabularies (D3); the only demographic fields a list carries.
 * A field nobody has filled stays empty (null), and the patient shows "Incomplete". There is no `unknown` and no `declined` code.
 */

/** D3 (founder, 2026-10-30): male or female only. An unrecorded value is null, not a third code. */
export const SEX_CODES = ['male', 'female'] as const;
export type SexCode = (typeof SEX_CODES)[number];

/** D3: the OMB SPD 15 (2024) combined categories, one field, more than one allowed. Ethnicity is demographics, not ancestry (D4). */
export const ETHNICITY_CODES = [
  'american-indian-or-alaska-native',
  'asian',
  'black-or-african-american',
  'hispanic-or-latino',
  'middle-eastern-or-north-african',
  'native-hawaiian-or-pacific-islander',
  'white',
] as const;
export type EthnicityCode = (typeof ETHNICITY_CODES)[number];

/** The earliest date of birth accepted (the database accepts a birth year from 1900 to 2100). */
export const DATE_OF_BIRTH_MIN = '1900-01-01';
/** A name is 1 to 100 UTF-16 units: at most 400 UTF-8 bytes, which is the ciphertext bound the table enforces. */
export const NAME_MAX_LENGTH = 100;

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters and line separators
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const nameSchema = z
  .string()
  .max(NAME_MAX_LENGTH, `Use ${NAME_MAX_LENGTH} characters or fewer.`)
  .transform((value) => value.normalize('NFC').trim().replace(/\s+/g, ' '))
  .refine((value) => value.length >= 1, 'Enter a name.')
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Use printable characters only.');

/**
 * Is `value` a real calendar date written YYYY-MM-DD, not before 1900-01-01 and not after `today` (a YYYY-MM-DD string, UTC)? Returns a message that never
 * contains the value, or null when it is acceptable.
 */
export function dateOfBirthProblem(value: string, today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Use YYYY-MM-DD.';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return 'Enter a real calendar date.';
  if (value < DATE_OF_BIRTH_MIN) return `The date of birth cannot be before ${DATE_OF_BIRTH_MIN}.`;
  if (value > today) return 'The date of birth cannot be in the future.';
  return null;
}

const dateOfBirthSchema = z.string().superRefine((value, ctx) => {
  const problem = dateOfBirthProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const sexSchema = z.enum(SEX_CODES);
const ethnicitySchema = z
  .array(z.enum(ETHNICITY_CODES))
  .min(1, 'Choose at least one, or leave ethnicity out.')
  .max(ETHNICITY_CODES.length)
  .refine((codes) => new Set(codes).size === codes.length, 'Each ethnicity may appear once.');

/**
 * `POST /patients/:id/demographics`: the patient's full demographics as a new version (the first, or a correction; a correction adds a version and never
 * overwrites). Sex and ethnicity may be left out or null, and then stay empty. An optional retry id replays the version it created.
 */
export const patientDemographicsInputSchema = z.strictObject({
  requestId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  givenName: nameSchema,
  familyName: nameSchema,
  dateOfBirth: dateOfBirthSchema,
  sex: sexSchema.nullish().transform((value) => value ?? null),
  ethnicity: ethnicitySchema.nullish().transform((value) => (value ? [...value].sort() : null)),
});
export type PatientDemographicsInput = z.infer<typeof patientDemographicsInputSchema>;

/** `GET /patients/:id/demographics?version=N`. Without `version`, the current one. */
export const patientDemographicsQuerySchema = z.strictObject({
  version: z.coerce.number().int().min(1).max(1_000_000).optional(),
});
export type PatientDemographicsQuery = z.infer<typeof patientDemographicsQuerySchema>;

/** One entry of the version list: who recorded it and when, and its coded fields. No identity. */
export const patientDemographicsVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  sex: z.enum(SEX_CODES).nullable(),
  birthYear: z.number().int(),
  ethnicity: z.array(z.enum(ETHNICITY_CODES)).nullable(),
});
export type PatientDemographicsVersion = z.infer<typeof patientDemographicsVersionSchema>;

/**
 * What the detail read returns to a clinical role: one version decrypted, and the list of every version. `ageYears` is computed from the birth year alone
 * (this year minus the birth year), so it can be one year HIGH before the person's birthday; it is for grouping, never for a dose.
 */
export const patientDemographicsDtoSchema = z.strictObject({
  patientId: z.uuid(),
  /** The version shown: the current one unless `?version=` asked for an earlier one. */
  version: z.number().int().min(1),
  current: z.boolean(),
  givenName: z.string(),
  familyName: z.string(),
  dateOfBirth: z.string(),
  sex: z.enum(SEX_CODES).nullable(),
  birthYear: z.number().int(),
  ageYears: z.number().int(),
  ethnicity: z.array(z.enum(ETHNICITY_CODES)).nullable(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  versions: z.array(patientDemographicsVersionSchema),
});
export type PatientDemographicsDto = z.infer<typeof patientDemographicsDtoSchema>;

/**
 * `GET /patients/demographics-completeness`: how many of the organization's patients (merged-away ones excluded, as in the list) have complete coded
 * demographics. `complete` means the latest version records both sex and ethnicity, the same rule as `demographicsComplete` on a list row, so the counts
 * and the "Incomplete" word never disagree. `patients` is the denominator: it equals `complete + incomplete + none`. Counts only: no name, date or id.
 */
export const demographicsCompletenessSchema = z
  .strictObject({
    patients: z.number().int().min(0),
    complete: z.number().int().min(0),
    /** A version exists, but sex or ethnicity is not recorded. */
    incomplete: z.number().int().min(0),
    /** No version recorded yet. */
    none: z.number().int().min(0),
  })
  .refine((c) => c.complete + c.incomplete + c.none === c.patients, { message: 'The counts must add up to the number of patients.' });
export type DemographicsCompleteness = z.infer<typeof demographicsCompletenessSchema>;

/** The `reason` of each refusal a client must tell apart (in `error.details[0].reason`). */
export const DEMOGRAPHICS_REFUSAL_REASONS = {
  /** 410: the patient's identity key was destroyed (D8). Every version is unreadable and no new version can be written. Nothing can undo it. */
  identityErased: 'identity-erased',
  /** 409: the retry id was used before with different fields. */
  requestIdReused: 'request-id-reused',
  /** 404: the patient has no demographics yet. */
  noDemographics: 'no-demographics',
} as const;

/** This year minus the birth year. It can be one year high until the birthday (the birthday is not stored in a coded column). */
export function ageFromBirthYear(birthYear: number, now: Date = new Date()): number {
  return Math.max(0, now.getUTCFullYear() - birthYear);
}
