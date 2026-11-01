import { z } from 'zod';
import { listOrderSchema } from './pagination';

/** The accepted report types. No raw genomic data (VCF or sequence) is stored (founder decision, 2026-10-28); `structured` is a curated JSON report. */
export const REPORT_TYPES = ['structured', 'lab-pdf'] as const;
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
  .regex(/\.(json|pdf)$/i, 'Only .json and .pdf files are accepted.');

/** The one extension each report type takes. A name must match its type: a .pdf is never "structured". */
export const REPORT_EXTENSIONS: Record<ReportType, '.json' | '.pdf'> = { structured: '.json', 'lab-pdf': '.pdf' };

export const filenameMatchesType = (type: ReportType, filename: string): boolean => filename.toLowerCase().endsWith(REPORT_EXTENSIONS[type]);

const FILENAME_TYPE_MISMATCH = { path: ['filename'] as PropertyKey[], message: 'The file name must end in the extension of the report type.' };

/**
 * POST body. This registers report METADATA only: the file itself goes to object storage in
 * Phase 3, and ingestion arrives in Phase 5. `status` is set by the system, never by the client.
 */
export const reportCreateSchema = z
  .strictObject({
    patientId: z.uuid(),
    type: reportTypeSchema,
    filename: reportFilenameSchema,
    sizeBytes: z.number().int().min(1).max(MAX_REPORT_BYTES),
    /** Retry identity for this creator in this tenant; omitted callers retain ordinary creation. */
    requestId: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .refine((body) => filenameMatchesType(body.type, body.filename), FILENAME_TYPE_MISMATCH);
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
  order: listOrderSchema,
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

/** Content types accepted per report type. The client declares one; the server checks it matches. */
export const REPORT_CONTENT_TYPES: Record<ReportType, readonly string[]> = {
  structured: ['application/json'],
  'lab-pdf': ['application/pdf'],
};

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Provide the lowercase hex SHA-256 of the file.');

/** What a file upload declares before any byte is sent: its content type and its SHA-256 (the validated intake checks both against the bytes). */
export const reportFileDeclarationSchema = z.strictObject({
  contentType: z.string().min(1).max(100),
  sha256: sha256HexSchema,
});
export type ReportFileDeclaration = z.infer<typeof reportFileDeclarationSchema>;
