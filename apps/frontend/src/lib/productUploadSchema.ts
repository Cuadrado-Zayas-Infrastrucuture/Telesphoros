import { filenameMatchesType, reportFilenameSchema } from '@telesphoros/shared-types';
import { z } from 'zod';
import { ownedStorageMode } from './storageMode';
import { MAX_REPORT_BYTES, uploadReportSchema } from './uploadReportSchema';

/** Product upload chooses an existing patient; the local experiment keeps its label-based schema. */
export const productUploadSchema = uploadReportSchema.omit({ patientLabel: true }).extend({
  reportType: z.enum(['vcf', 'structured', 'lab-pdf'], { error: 'Choose a report type.' }),
  file: z.custom<File>((value) => value instanceof File, { error: 'Choose a report file.' })
    .refine(file => !(file instanceof File) || file.size <= MAX_REPORT_BYTES, { error: 'The file is larger than 10 MB.' }),
  patientId: z.uuid({ error: 'Choose an existing patient.' }),
}).superRefine((values, ctx) => {
  if (values.reportType === 'lab-pdf' && !ownedStorageMode()) ctx.addIssue({ code: 'custom', path: ['reportType'], message: 'PDF upload requires owned local storage mode.' });
  if (!(values.file instanceof File)) return;
  if (values.file.size === 0) ctx.addIssue({ code: 'custom', path: ['file'], message: 'The report file is empty.' });
  if (!reportFilenameSchema.safeParse(values.file.name).success) {
    ctx.addIssue({ code: 'custom', path: ['file'], message: 'Use a filename of up to 100 letters, numbers, dots, dashes or underscores.' });
  } else if (!filenameMatchesType(values.reportType, values.file.name)) {
    ctx.addIssue({ code: 'custom', path: ['file'], message: 'Choose a file matching the report type.' });
  }
});
export type ProductUploadValues = z.infer<typeof productUploadSchema>;
