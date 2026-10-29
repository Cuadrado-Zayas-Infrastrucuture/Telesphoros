import { z } from 'zod';
import { REPORT_TYPES } from '@/types/report';

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.json'] as const;

/** One schema: the form validates against it now and the backend can share it later. */
export const uploadReportSchema = z.object({
  patientLabel: z
    .string()
    .trim()
    .min(1, 'Enter a synthetic patient label.')
    .max(40, 'Use 40 characters or fewer.')
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only (no names or real identifiers).'),
  reportType: z.enum(REPORT_TYPES, { error: 'Choose a report type.' }),
  file: z
    .custom<File>((value) => value instanceof File, { error: 'Choose a report file.' })
    .refine((file) => !(file instanceof File) || file.size <= MAX_REPORT_BYTES, {
      error: 'The file is larger than 10 MB.',
    })
    .refine((file) => !(file instanceof File) || ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext)), { error: 'Only .json files are accepted.' }),
  syntheticConfirmed: z.boolean().refine((value) => value, {
    error: 'Confirm that this file contains synthetic data only.',
  }),
});

export type UploadReportValues = z.infer<typeof uploadReportSchema>;
