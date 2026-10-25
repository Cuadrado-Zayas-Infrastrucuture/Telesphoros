import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  meDtoSchema,
  recoveryScopeDtoSchema,
  CORRECTION_KINDS,
  CORRECTION_REASON_CODES,
  correctionCreateSchema,
  evaluationListQuerySchema,
  identifierCreateSchema,
  invitationCreateSchema,
  identifierDtoSchema,
  patientLinkDecisionCreateSchema,
  disputeListQuerySchema,
  REASONS_FOR_KIND,
  ErrorCode,
  errorResponseSchema,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  patientDtoSchema,
  decisionCreateSchema,
  disputeCreateSchema,
  patientCreateSchema,
  patientInputSchema,
  REPORT_CONTENT_TYPES,
  reportCreateSchema,
  reportDtoSchema,
  reportPatchSchema,
  reportFileDeclarationSchema,
  TENANT_GROUP_PREFIX,
  tenantFromGroups,
  tenantIdSchema,
} from './index';

describe('bounded review list queries', () => {
  for (const [name, schema] of [['evaluations', evaluationListQuerySchema], ['disputes', disputeListQuerySchema]] as const) {
    it(`${name} defaults to 20, caps at 100 and rejects invalid/unsafe pages`, () => {
      expect(schema.parse({})).toEqual({ page: 1, pageSize: 20 });
      expect(schema.parse({ page: '2', pageSize: '100' })).toEqual({ page: 2, pageSize: 100 });
      for (const query of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { pageSize: '0' }, { pageSize: '101' }, { page: '9007199254740991', pageSize: '100' }, { unknown: '1' }]) {
        expect(schema.safeParse(query).success, JSON.stringify(query)).toBe(false);
      }
    });
  }
});

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
    // A file name must end in the extension of its type, in both directions, on create and on patch.
    const create = (type: string, filename: string) => reportCreateSchema.safeParse({ patientId: uuid, type, filename, sizeBytes: 5 }).success;
    expect([create('lab-pdf', 'a.pdf'), create('lab-pdf', 'A.PDF'), create('vcf', 'a.vcf'), create('structured', 'a.json')]).toEqual([true, true, true, true]);
    expect([create('vcf', 'a.pdf'), create('lab-pdf', 'a.vcf'), create('lab-pdf', 'a.json'), create('structured', 'a.pdf'), create('vcf', 'a.json')]).toEqual([false, false, false, false, false]);
    expect(reportPatchSchema.safeParse({ type: 'lab-pdf', filename: 'a.pdf' }).success).toBe(true);
    expect(reportPatchSchema.safeParse({ type: 'vcf', filename: 'a.pdf' }).success).toBe(false);
    expect(reportPatchSchema.safeParse({ filename: 'a.pdf' }).success).toBe(true); // alone: the service checks it against the stored type
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

describe('upload contract (the declaration an upload makes)', () => {
  const sha = 'a'.repeat(64);
  it('requires a lowercase hex SHA-256 and a content type, and refuses extra fields (no client-chosen storage key)', () => {
    expect(reportFileDeclarationSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha }).success).toBe(true);
    expect(reportFileDeclarationSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha.toUpperCase() }).success).toBe(false);
    expect(reportFileDeclarationSchema.safeParse({ contentType: 'text/x-vcf', sha256: 'abc' }).success).toBe(false);
    expect(reportFileDeclarationSchema.safeParse({ contentType: 'text/x-vcf' }).success).toBe(false);
    expect(reportFileDeclarationSchema.safeParse({ contentType: 'text/x-vcf', sha256: sha, storageKey: 'reports/x' }).success).toBe(false);
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

describe('correction requests', () => {
  const ok = (body: object) => correctionCreateSchema.safeParse(body).success;
  const uuid = '3f0c8a52-6d0e-4f64-9a53-0c5a3b7f9a11';

  it('accepts each kind with a reason that belongs to it, and refuses every reason that does not', () => {
    for (const kind of CORRECTION_KINDS) {
      for (const reasonCode of CORRECTION_REASON_CODES) {
        const body = {
          kind, reasonCode, note: 'a note',
          ...(kind === 'supersession' ? { replacementEvaluationId: uuid } : {}),
          ...(kind === 'reinstatement' ? { previousCorrectionId: uuid } : {}),
        };
        expect(ok(body), `${kind} / ${reasonCode}`).toBe(REASONS_FOR_KIND[kind].includes(reasonCode));
      }
    }
  });

  it('every reason code is allowed for at least one kind, and the table names no unknown code', () => {
    const allowed = new Set(Object.values(REASONS_FOR_KIND).flat());
    expect([...allowed].sort()).toEqual([...CORRECTION_REASON_CODES].sort());
  });

  it('needs a replacement exactly for a supersession, a named retraction for a reinstatement, and a note for clinical-review-disagrees', () => {
    expect(ok({ kind: 'supersession', reasonCode: 'software-defect' })).toBe(false);
    expect(ok({ kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: uuid })).toBe(true);
    expect(ok({ kind: 'retraction', reasonCode: 'software-defect', replacementEvaluationId: uuid })).toBe(false);
    expect(ok({ kind: 'reinstatement', reasonCode: 'retraction-mistaken' })).toBe(false);
    expect(ok({ kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: uuid })).toBe(true);
    expect(ok({ kind: 'retraction', reasonCode: 'clinical-review-disagrees' })).toBe(false);
    expect(ok({ kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: 'why' })).toBe(true);
  });

  it('takes nothing but the documented fields, and trims or bounds the note', () => {
    expect(ok({ kind: 'retraction', reasonCode: 'software-defect', createdBy: 'x' })).toBe(false);
    expect(ok({ kind: 'retraction', reasonCode: 'software-defect', note: '   ' })).toBe(false);
    expect(ok({ kind: 'retraction', reasonCode: 'software-defect', note: 'x'.repeat(1001) })).toBe(false);
    expect(ok({ kind: 'retraction', reasonCode: 'software-defect', note: 'x'.repeat(1000) })).toBe(true);
  });
});

describe('the evaluation list query', () => {
  it('accepts only current=true, never false or a number', () => {
    expect(evaluationListQuerySchema.safeParse({ current: 'true' }).success).toBe(true);
    for (const current of ['false', '1', 'yes', true, 1]) expect(evaluationListQuerySchema.safeParse({ current }).success, String(current)).toBe(false);
  });
});

describe('patient identifiers and the patient link', () => {
  const create = (body: unknown) => identifierCreateSchema.safeParse(body);

  it('takes a system code and a printable value, trims both, lower-cases the system, and nothing else', () => {
    expect(create({ system: ' Hospital-A-MRN ', value: '  mrn-1 ' })).toMatchObject({ success: true, data: { system: 'hospital-a-mrn', value: 'mrn-1' } });
    for (const bad of [{ system: 'hospital a', value: 'x' }, { system: '-a', value: 'x' }, { system: 'a'.repeat(41), value: 'x' }, { system: 'a', value: '' }, { system: 'a', value: 'x'.repeat(65) }, { system: 'a', value: 'x\u0000y' }, { system: 'a', value: 'x', extra: 1 }, { value: 'x' }]) {
      expect(create(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(create({ system: 'a'.repeat(40), value: 'x'.repeat(64) }).success).toBe(true);
  });

  it('shows an identifier without a value or a digest, and refuses a DTO that carries one', () => {
    const dto = { id: '2b2f0a52-9a43-4f2a-8bd2-7e0f8a2f5d11', patientId: '3b2f0a52-9a43-4f2a-8bd2-7e0f8a2f5d11', system: 'hospital-a-mrn', status: 'active', createdAt: '2026-10-13T00:00:00.000Z', withdrawnAt: null };
    expect(identifierDtoSchema.safeParse(dto).success).toBe(true);
    expect(identifierDtoSchema.safeParse({ ...dto, value: 'x' }).success).toBe(false);
    expect(identifierDtoSchema.safeParse({ ...dto, digest: 'ab' }).success).toBe(false);
  });

  describe('a link decision', () => {
    const ok = (body: unknown) => patientLinkDecisionCreateSchema.safeParse(body).success;
    it('is one of three shapes, and a reason goes only with the decision it supports', () => {
      expect(ok({ method: 'identifier-match', decision: 'verified', system: 'hospital-a-mrn', value: 'mrn-1' })).toBe(true);
      expect(ok({ method: 'person-confirmed', decision: 'verified', basisCode: 'no-identifier-on-report' })).toBe(true);
      expect(ok({ method: 'person-confirmed', decision: 'rejected', basisCode: 'different-person' })).toBe(true);
      expect(ok({ method: 'person-confirmed', decision: 'verified', basisCode: 'different-person' })).toBe(false);
      expect(ok({ method: 'person-confirmed', decision: 'rejected', basisCode: 'documented-clinic-procedure' })).toBe(false);
      expect(ok({ method: 'person-confirmed', decision: 'verified' })).toBe(false);
      expect(ok({ method: 'identifier-match', decision: 'rejected', system: 'hospital-a-mrn', value: 'mrn-1' })).toBe(false);
      expect(ok({ method: 'identifier-match', decision: 'verified', system: 'hospital-a-mrn' })).toBe(false);
      expect(ok({ method: 'identifier-match', decision: 'verified', system: 'hospital-a-mrn', value: 'x', basisCode: 'no-identifier-on-report' })).toBe(false);
      expect(ok({ method: 'person-confirmed', decision: 'verified', basisCode: 'no-identifier-on-report', createdBy: 'me' })).toBe(false);
      expect(ok({ method: 'guess', decision: 'verified' })).toBe(false);
    });
  });
});


describe('compatible identity capability contracts', () => {
  it('keeps /me exactly roles-only for old and cached clients', () => {
    expect(meDtoSchema.parse({ roles: ['clinician'] })).toEqual({ roles: ['clinician'] });
    expect(meDtoSchema.safeParse({ roles: ['clinician'], recoveryScope: 'a'.repeat(64) }).success).toBe(false);
  });
  it('accepts an opaque scope only through its separate strict contract', () => {
    expect(recoveryScopeDtoSchema.parse({ recoveryScope: 'a'.repeat(64) })).toEqual({ recoveryScope: 'a'.repeat(64) });
  });
  it.each([undefined, '', 'tenant:alice', 'A'.repeat(64), 'a'.repeat(63)])('refuses invalid or missing scope %s', recoveryScope => {
    expect(recoveryScopeDtoSchema.safeParse({ recoveryScope }).success).toBe(false);
  });
  it('refuses raw identity fields on either endpoint', () => {
    expect(meDtoSchema.safeParse({ roles: [], sub: 'synthetic-person' }).success).toBe(false);
    expect(recoveryScopeDtoSchema.safeParse({ recoveryScope: 'a'.repeat(64), sub: 'synthetic-person' }).success).toBe(false);
  });
});

describe('decisionCreateSchema (a capture decision can be retried safely)', () => {
  it('takes the decision, an optional note, and an optional retry id that is lower-cased', () => {
    expect(decisionCreateSchema.parse({ decision: 'accepted' })).toEqual({ decision: 'accepted' });
    expect(decisionCreateSchema.parse({ decision: 'rejected', note: ' checked ', requestId: '2F3A8E3C-9B64-4C55-8B7E-0B5C1D8E9A10' }))
      .toEqual({ decision: 'rejected', note: 'checked', requestId: '2f3a8e3c-9b64-4c55-8b7e-0b5c1d8e9a10' });
  });
  it('refuses a retry id that is not a UUID, and any other extra field', () => {
    for (const requestId of ['', 'abc', 7, '2f3a8e3c-9b64-4c55-8b7e']) expect(decisionCreateSchema.safeParse({ decision: 'accepted', requestId }).success).toBe(false);
    expect(decisionCreateSchema.safeParse({ decision: 'accepted', textSha256: 'x' }).success).toBe(false);
  });
});

describe('disputeCreateSchema (raising a dispute can be retried safely)', () => {
  const base = { guidelineId: 'syn-guideline', locator: { table: 'recommendations', row: 'r1' }, note: 'reads wrongly' };
  it('takes the cell and the note, and an optional retry id that is lower-cased', () => {
    expect(disputeCreateSchema.parse(base)).toEqual(base);
    expect(disputeCreateSchema.parse({ ...base, requestId: '2F3A8E3C-9B64-4C55-8B7E-0B5C1D8E9A10' })).toEqual({ ...base, requestId: '2f3a8e3c-9b64-4c55-8b7e-0b5c1d8e9a10' });
  });
  it('refuses a retry id that is not a UUID, and any other extra field', () => {
    for (const requestId of ['', 'abc', 7, '2f3a8e3c-9b64-4c55-8b7e']) expect(disputeCreateSchema.safeParse({ ...base, requestId }).success).toBe(false);
    expect(disputeCreateSchema.safeParse({ ...base, guidelineVersion: '9' }).success).toBe(false);
  });
});

describe('patientCreateSchema (audit item 25: POST /patients could not be retried safely)', () => {
  it('takes the label, and an optional retry id that is lower-cased', () => {
    expect(patientCreateSchema.parse({ label: 'SYN-1' })).toEqual({ label: 'SYN-1' });
    expect(patientCreateSchema.parse({ label: 'SYN-1', requestId: '2F3A8E3C-9B64-4C55-8B7E-0B5C1D8E9A10' })).toEqual({ label: 'SYN-1', requestId: '2f3a8e3c-9b64-4c55-8b7e-0b5c1d8e9a10' });
  });
  it('refuses a retry id that is not a UUID, and any other extra field', () => {
    for (const requestId of ['', 'abc', 7, '2f3a8e3c-9b64-4c55-8b7e']) expect(patientCreateSchema.safeParse({ label: 'SYN-1', requestId }).success).toBe(false);
    expect(patientCreateSchema.safeParse({ label: 'SYN-1', ownerId: 'x' }).success).toBe(false);
  });
  it('leaves the replacement body (PUT) as it was: it has no retry id', () => {
    expect(patientInputSchema.safeParse({ label: 'SYN-1', requestId: '2f3a8e3c-9b64-4c55-8b7e-0b5c1d8e9a10' }).success).toBe(false);
  });
});

describe('identifierCreateSchema retry id (audit item 25)', () => {
  const id = '3F0C2A4B-1D5E-4B6A-9C7D-8E1F2A3B4C5D';
  it('takes an optional UUID, lower-cased, beside the system and value', () => {
    expect(identifierCreateSchema.parse({ system: 'hospital-a-mrn', value: 'x1' })).toEqual({ system: 'hospital-a-mrn', value: 'x1' });
    expect(identifierCreateSchema.parse({ system: 'hospital-a-mrn', value: 'x1', requestId: id }).requestId).toBe(id.toLowerCase());
  });
  it('refuses an id that is not a UUID and any other extra field', () => {
    for (const requestId of ['', 'abc', 5]) expect(identifierCreateSchema.safeParse({ system: 'a', value: 'x', requestId }).success).toBe(false);
    expect(identifierCreateSchema.safeParse({ system: 'a', value: 'x', patientId: 'p' }).success).toBe(false);
  });
});

describe('invitationCreateSchema retry id (audit item 25)', () => {
  const id = '9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D';
  it('takes an optional UUID, lower-cased, beside the address and roles', () => {
    expect(invitationCreateSchema.parse({ email: 'A@Example.test', roles: ['reader'] })).toEqual({ email: 'a@example.test', roles: ['reader'] });
    expect(invitationCreateSchema.parse({ email: 'a@example.test', roles: ['reader'], requestId: id }).requestId).toBe(id.toLowerCase());
  });
  it('refuses an id that is not a UUID and any other extra field', () => {
    for (const requestId of ['', 'abc', 5]) expect(invitationCreateSchema.safeParse({ email: 'a@example.test', roles: [], requestId }).success).toBe(false);
    expect(invitationCreateSchema.safeParse({ email: 'a@example.test', roles: [], tenantId: 't' }).success).toBe(false);
  });
});
