import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  ErrorCode,
  errorResponseSchema,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  patientDtoSchema,
  patientInputSchema,
  reportCreateSchema,
  reportPatchSchema,
} from './index';

const uuid = '3f2b8c1e-5a47-4d0e-9c3a-1b2c3d4e5f60';

describe('pagination', () => {
  it('applies defaults and coerces query strings', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });
  it('rejects out-of-range values and unknown keys', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ sort: 'x' }).success).toBe(false);
  });
  it('computes meta', () => {
    expect(buildMeta(2, 10, 25)).toEqual({ page: 2, pageSize: 10, total: 25, totalPages: 3 });
    expect(buildMeta(1, 10, 0).totalPages).toBe(0);
  });
});

describe('inputs are strict (no mass assignment)', () => {
  it('rejects unknown fields', () => {
    expect(patientInputSchema.safeParse({ label: 'SYN-1', ownerId: 'x' }).success).toBe(false);
    expect(
      reportCreateSchema.safeParse({ patientId: uuid, type: 'vcf', filename: 'a.vcf', sizeBytes: 5, status: 'processed' })
        .success,
    ).toBe(false);
  });
  it('rejects labels that look like names and bad filenames', () => {
    expect(patientInputSchema.safeParse({ label: 'Jane Doe' }).success).toBe(false);
    expect(reportCreateSchema.safeParse({ patientId: uuid, type: 'vcf', filename: '../etc/passwd.vcf', sizeBytes: 5 }).success).toBe(false);
    expect(reportCreateSchema.safeParse({ patientId: uuid, type: 'vcf', filename: 'a.exe', sizeBytes: 5 }).success).toBe(false);
  });
  it('requires at least one field to PATCH a report', () => {
    expect(reportPatchSchema.safeParse({}).success).toBe(false);
    expect(reportPatchSchema.safeParse({ type: 'structured' }).success).toBe(true);
  });
});

describe('response DTOs', () => {
  it('reject records that carry internal fields', () => {
    const base = { id: uuid, label: 'SYN-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    expect(patientDtoSchema.safeParse(base).success).toBe(true);
    expect(patientDtoSchema.safeParse({ ...base, ownerId: 'someone' }).success).toBe(false);
  });
});

describe('error envelope', () => {
  it('accepts only the documented shape and codes', () => {
    const ok = { error: { code: ErrorCode.NOT_FOUND, message: 'x', requestId: 'r' } };
    expect(errorResponseSchema.safeParse(ok).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { ...ok.error, code: 'WHATEVER' } }).success).toBe(false);
    expect(errorResponseSchema.safeParse({ error: { ...ok.error, stack: 'trace' } }).success).toBe(false);
  });
});
