import { z } from 'zod';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const month = z.string().regex(/^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$/, 'Use a year-month from 1900 to 2199 (YYYY-MM).');
const fields = {
  rxcui: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'Choose a coded drug.')
    .max(16),
  listVersion: z.string().regex(/^[0-9a-f]{64}$/, 'Choose the current drug list.'),
  status: z.enum(['active', 'stopped']),
  startMonth: month.nullable(),
  stopMonth: month.nullable(),
  source: z.enum(['clinician-entered', 'patient-reported']),
};
export const patientMedicationInputSchema = z
  .strictObject({
    requestId: uuid,
    /** Absent for a new entry; corrections name the entry and the version the clinician saw. */
    entryId: uuid.optional(),
    expectedVersion: z.number().int().min(1).max(1_000_000).optional(),
    ...fields,
    startMonth: month.nullish().transform((value) => value ?? null),
    stopMonth: month.nullish().transform((value) => value ?? null),
  })
  .superRefine((input, ctx) => {
    if (Boolean(input.entryId) !== (input.expectedVersion !== undefined)) ctx.addIssue({ code: 'custom', message: 'A correction needs an entry and its current version.' });
    if (input.startMonth && input.stopMonth && input.stopMonth < input.startMonth) ctx.addIssue({ code: 'custom', path: ['stopMonth'], message: 'Stop must not precede start.' });
    if (input.status === 'active' && input.stopMonth) ctx.addIssue({ code: 'custom', path: ['stopMonth'], message: 'An active medication has no stop month.' });
  });
export type PatientMedicationInput = z.infer<typeof patientMedicationInputSchema>;
export const patientMedicationsQuerySchema = z
  .strictObject({
    entryId: uuid.optional(),
    version: z.coerce.number().int().min(1).max(1_000_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.version !== undefined && !input.entryId) ctx.addIssue({ code: 'custom', message: 'A historical version needs an entry id.' });
  });
export type PatientMedicationsQuery = z.infer<typeof patientMedicationsQuerySchema>;
export const patientMedicationDtoSchema = z.strictObject({
  id: z.uuid(),
  entryId: z.uuid(),
  patientId: z.uuid(),
  version: z.number().int().min(1),
  current: z.boolean(),
  ...fields,
  name: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
});
export type PatientMedicationDto = z.infer<typeof patientMedicationDtoSchema>;
export const patientMedicationsDtoSchema = z.strictObject({ items: z.array(patientMedicationDtoSchema) });
