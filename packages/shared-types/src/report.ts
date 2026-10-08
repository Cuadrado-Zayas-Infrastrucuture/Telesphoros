import { z } from 'zod';

export const REPORT_TYPES = ['vcf', 'structured', 'lab-pdf'] as const;
export const reportTypeSchema = z.enum(REPORT_TYPES);
export type ReportType = z.infer<typeof reportTypeSchema>;

export const REPORT_STATUSES = ['received', 'processing', 'processed', 'failed'] as const;
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

/** A file name only: no paths, no spaces, and one of the accepted extensions. */
export const reportFilenameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, dashes and underscores only.')
  .regex(/\.(vcf|json|pdf)$/i, 'Only .vcf, .json and .pdf files are accepted.');

/** The one extension each report type takes. A name must match its type: a .pdf is never a "vcf". */
export const REPORT_EXTENSIONS: Record<ReportType, '.vcf' | '.json' | '.pdf'> = { vcf: '.vcf', structured: '.json', 'lab-pdf': '.pdf' };

export const filenameMatchesType = (type: ReportType, filename: string): boolean => filename.toLowerCase().endsWith(REPORT_EXTENSIONS[type]);

const FILENAME_TYPE_MISMATCH = { path: ['filename'] as PropertyKey[], message: 'The file name must end in the extension of the report type.' };

/**
 * POST body. This registers report METADATA only: the file itself goes to object storage in
 * Phase 3, and ingestion arrives in Phase 5. `status` is set by the system, never by the client.
 */
export const reportCreateSchema = z.strictObject({
  patientId: z.uuid(),
  type: reportTypeSchema,
  filename: reportFilenameSchema,
  sizeBytes: z.number().int().min(1).max(MAX_REPORT_BYTES),
}).refine((body) => filenameMatchesType(body.type, body.filename), FILENAME_TYPE_MISMATCH);
export type ReportCreate = z.infer<typeof reportCreateSchema>;

/** PATCH body: correct metadata. At least one field is required. */
export const reportPatchSchema = z
  .strictObject({
    type: reportTypeSchema.optional(),
    filename: reportFilenameSchema.optional(),
  })
  .refine((body) => body.type !== undefined || body.filename !== undefined, {
    message: 'Provide at least one field to change.',
  })
  // When both are given they must agree. When only one is, the service checks it against the stored other half.
  .refine((body) => body.type === undefined || body.filename === undefined || filenameMatchesType(body.type, body.filename), FILENAME_TYPE_MISMATCH);
export type ReportPatch = z.infer<typeof reportPatchSchema>;

export const reportDtoSchema = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  type: reportTypeSchema,
  filename: z.string(),
  sizeBytes: z.number().int(),
  status: reportStatusSchema,
  /** True once the file is in object storage and the server has verified its size and checksum. */
  fileUploaded: z.boolean(),
  contentType: z.string().nullable(),
  sha256: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReportDto = z.infer<typeof reportDtoSchema>;

export const reportListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  patientId: z.uuid().optional(),
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

/** Content types accepted per report type. The client declares one; the server checks it matches. */
export const REPORT_CONTENT_TYPES: Record<ReportType, readonly string[]> = {
  vcf: ['text/x-vcf', 'text/plain'],
  structured: ['application/json'],
  'lab-pdf': ['application/pdf'],
};

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Provide the lowercase hex SHA-256 of the file.');

/** Step 1 of an upload: say what you are about to send, and its checksum. */
export const reportUploadUrlRequestSchema = z.strictObject({
  contentType: z.string().min(1).max(100),
  sha256: sha256HexSchema,
});
export type ReportUploadUrlRequest = z.infer<typeof reportUploadUrlRequestSchema>;

/** A short-lived, single-object URL. The browser PUTs the file straight to storage with these headers. */
export const reportUploadUrlResponseSchema = z.strictObject({
  uploadUrl: z.string().min(1),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type ReportUploadUrlResponse = z.infer<typeof reportUploadUrlResponseSchema>;
