import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  ErrorCode,
  errorResponseSchema,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  patientDtoSchema,
  patientInputSchema,
  REPORT_CONTENT_TYPES,
  reportCreateSchema,
  reportDtoSchema,
  reportPatchSchema,
  reportUploadUrlRequestSchema,
  reportUploadUrlResponseSchema,
  TENANT_GROUP_PREFIX,
  tenantFromGroups,
  tenantIdSchema,
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

describe('upload contract', () => {
  const sha = 'a'.repeat(64);
  it('requires a lowercase hex SHA-256 and a content type, and refuses extra fields (no client-chosen storage key)', () => {
    expect(reportUploadUrlRequestSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha }).success).toBe(true);
    expect(reportUploadUrlRequestSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha.toUpperCase() }).success).toBe(false);
    expect(reportUploadUrlRequestSchema.safeParse({ contentType: 'text/x-vcf', sha256: 'abc' }).success).toBe(false);
    expect(reportUploadUrlRequestSchema.safeParse({ contentType: 'text/x-vcf' }).success).toBe(false);
    expect(reportUploadUrlRequestSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha, storageKey: 'reports/x' }).success).toBe(false);
  });
  it('describes the upload target the browser needs, and nothing else', () => {
    const ok = { uploadUrl: 'https://example.test/x', method: 'PUT', headers: { 'Content-Type': 'text/plain' }, expiresAt: new Date().toISOString() };
    expect(reportUploadUrlResponseSchema.safeParse(ok).success).toBe(true);
    expect(reportUploadUrlResponseSchema.safeParse({ ...ok, method: 'POST' }).success).toBe(false);
    expect(reportUploadUrlResponseSchema.safeParse({ ...ok, storageKey: 'k' }).success).toBe(false);
  });
  it('accepts a content type per report type, and the DTO never carries a storage key', () => {
    expect(REPORT_CONTENT_TYPES.vcf).toContain('text/x-vcf');
    expect(REPORT_CONTENT_TYPES.structured).toEqual(['application/json']);
    const dto = {
      id: uuid, patientId: uuid, type: 'vcf', filename: 'a.vcf', sizeBytes: 5, status: 'received',
      fileUploaded: false, contentType: null, sha256: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(reportDtoSchema.safeParse(dto).success).toBe(true);
    expect(reportDtoSchema.safeParse({ ...dto, storageKey: 'reports/x' }).success).toBe(false);
  });
});

describe('tenant ids and tenant groups', () => {
  it('accepts lower-case letters, digits and dashes, 1 to 63 characters, not starting with a dash', () => {
    for (const ok of ['a', 'acme', 'acme-pharmacy-2', '9lives', 'a'.repeat(63)]) expect(tenantIdSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-a', 'A', 'a b', 'a_b', 'a/b', 'a:b', 'a'.repeat(64), 'ñ', 'a\n']) expect(tenantIdSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('finds the tenant in exactly one "tenant:<id>" group, ignoring roles and look-alikes', () => {
    expect(tenantFromGroups(['clinician', 'tenant:acme'])).toEqual({ ok: true, tenantId: 'acme' });
    expect(tenantFromGroups(['tenant:acme', 'tenants', 'tenant', 'Tenant:other'])).toEqual({ ok: true, tenantId: 'acme' });
  });

  it('refuses none, several (even identical), and malformed ones', () => {
    for (const groups of [[], ['clinician'], ['tenant:a', 'tenant:b'], ['tenant:a', 'tenant:a'], ['tenant:'], ['tenant:A'], ['tenant:a b'], [`tenant:${'a'.repeat(64)}`]]) {
      expect(tenantFromGroups(groups), JSON.stringify(groups)).toEqual({ ok: false });
    }
  });

  it('uses the documented prefix', () => {
    expect(TENANT_GROUP_PREFIX).toBe('tenant:');
  });
});
