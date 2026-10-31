import { z } from 'zod';
import { ETHNICITY_CODES, SEX_CODES } from './patient-demographics';

/**
 * Patients are identified by a synthetic label (e.g. SYN-0001). No name or date of birth exists anywhere in this model, by design.
 * A clinic's own identifier for a patient (a record number) can be attached, but only as a keyed digest that is never shown
 * back (see patient-identity.ts); the label stays the only human handle.
 */
export const patientLabelSchema = z
  .string()
  .trim()
  .min(1, 'Enter a synthetic patient label.')
  .max(40, 'Use 40 characters or fewer.')
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only (no names or real identifiers).');

/** POST and PUT body (full replacement). */
export const patientInputSchema = z.strictObject({ label: patientLabelSchema });
export type PatientInput = z.infer<typeof patientInputSchema>;

/**
 * POST body: the label, and optionally a retry id. A repeat of the same request by the same person (same id, same label) replays the patient it created; the
 * same id with a different label is refused. Without an id nothing is replayed, as before. The replacement body (PUT) takes no retry id.
 */
export const patientCreateSchema = patientInputSchema.extend({
  requestId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
});
export type PatientCreate = z.infer<typeof patientCreateSchema>;

/** What the API returns. Internal fields (owner, storage keys) never appear here. */
export const patientDtoSchema = z.strictObject({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The patient this one was merged into (M2.1c-2), or null. A merged-away patient keeps every record; reads resolve the pair as one. */
  mergedInto: z.uuid().nullable().default(null),
  /**
   * The coded demographics (spec 025, D3/D6). Present on LIST items only; a single patient's response omits them (the demographics route returns them).
   * Never an identity value: a list does not decrypt anything. `null` means not recorded (the patient is "Incomplete").
   */
  sex: z.enum(SEX_CODES).nullable().optional(),
  birthYear: z.number().int().nullable().optional(),
  /** This year minus the birth year, so it can be one year HIGH until the birthday. For grouping, never for a dose. */
  ageYears: z.number().int().nullable().optional(),
  ethnicity: z.array(z.enum(ETHNICITY_CODES)).nullable().optional(),
  /** True when a demographics version exists and both sex and ethnicity are recorded. */
  demographicsComplete: z.boolean().optional(),
});
export type PatientDto = z.infer<typeof patientDtoSchema>;
