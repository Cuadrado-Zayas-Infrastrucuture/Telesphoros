import { filenameMatchesType, reportFilenameSchema } from '@telesphoros/shared-types';
import { z } from 'zod';
import { uploadReportSchema } from './uploadReportSchema';

/** Product upload chooses an existing patient; the local experiment keeps its label-based schema. */
export const productUploadSchema = uploadReportSchema.omit({ patientLabel: true }).extend({
  patientId: z.uuid({ error: 'Choose an existing patient.' }),
}).superRefine((values, ctx) => {
  if (!(values.file instanceof File)) return;
  if (values.file.size === 0) ctx.addIssue({ code: 'custom', path: ['file'], message: 'The report file is empty.' });
  if (!reportFilenameSchema.safeParse(values.file.name).success) {
    ctx.addIssue({ code: 'custom', path: ['file'], message: 'Use a filename of up to 100 letters, numbers, dots, dashes or underscores.' });
  } else if (!filenameMatchesType(values.reportType, values.file.name)) {
    ctx.addIssue({ code: 'custom', path: ['file'], message: 'Choose a file matching the report type (.vcf or .json).' });
  }
});
export type ProductUploadValues = z.infer<typeof productUploadSchema>;
