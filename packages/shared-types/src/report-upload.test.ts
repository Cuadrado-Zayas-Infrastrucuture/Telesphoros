import { describe, expect, it } from 'vitest';
import { uploadAttemptDtoSchema, uploadStateDtoSchema } from './report-upload';

const attempt = { attemptId: '00000000-0000-4000-8000-000000000000', revision: '11111111-1111-4111-8111-111111111111', expiresAt: '2026-11-11T12:00:00.000Z', state: 'declared' };
const state = { revision: attempt.revision, fileUploaded: false, run: { pendingBytes: 0, pendingCount: 0, lastReconciledAt: null, cleanupStalled: false } };

describe('upload responses', () => {
  it('accept exactly what the API sends (controls)', () => {
    expect(uploadAttemptDtoSchema.parse(attempt)).toEqual(attempt);
    expect(uploadStateDtoSchema.parse(state)).toEqual(state);
  });

  it.each(['key', 'tenantId', 'principal', 'sha256', 'storageKey'])('refuse an attempt that carries %s', (field) => {
    expect(uploadAttemptDtoSchema.safeParse({ ...attempt, [field]: 'x' }).success).toBe(false);
  });

  it('refuse a state or run that carries anything more, and an unknown attempt state', () => {
    expect(uploadStateDtoSchema.safeParse({ ...state, storageKey: 'reports/t/r' }).success).toBe(false);
    expect(uploadStateDtoSchema.safeParse({ ...state, run: { ...state.run, prefix: 'reports/t/' } }).success).toBe(false);
    expect(uploadAttemptDtoSchema.safeParse({ ...attempt, state: 'internal-only' }).success).toBe(false);
  });
});
