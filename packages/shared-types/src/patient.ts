import { z } from 'zod';

/**
 * Patients are identified ONLY by a synthetic label (e.g. SYN-0001). No name, date of birth,
 * or real identifier exists anywhere in this model, by design.
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

/** What the API returns. Internal fields (owner, storage keys) never appear here. */
export const patientDtoSchema = z.strictObject({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PatientDto = z.infer<typeof patientDtoSchema>;
