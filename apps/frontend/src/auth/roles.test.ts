import type { Role } from '@telesphoros/shared-types';
import { describe, expect, it } from 'vitest';
import { CLINICAL_READ_ROLES, primaryRole, WRITER_ROLES } from './roles';

const canWrite = (roles: Role[]) => roles.some((r) => WRITER_ROLES.includes(r));

describe('roles', () => {
  it('lets clinicians write, in any combination, and never a reader, reviewer or administrator alone', () => {
    expect(canWrite(['clinician'])).toBe(true);
    expect(canWrite(['admin', 'clinician'])).toBe(true);
    expect(canWrite(['clinician', 'reviewer'])).toBe(true);
    expect(canWrite(['admin'])).toBe(false);
    expect(canWrite(['admin', 'reviewer'])).toBe(false);
    expect(canWrite(['reader'])).toBe(false);
    expect(canWrite(['reviewer'])).toBe(false);
    expect(canWrite([])).toBe(false);
  });

  it('lets readers, clinicians and reviewers read clinical records, and an administrator only with another role', () => {
    const canRead = (roles: Role[]) => roles.some((r) => CLINICAL_READ_ROLES.includes(r));
    expect([['reader'], ['clinician'], ['reviewer'], ['admin', 'reader']].map((r) => canRead(r as Role[]))).toEqual([true, true, true, true]);
    expect([['admin'], []].map((r) => canRead(r as Role[]))).toEqual([false, false]);
  });

  it('names the most capable role for display, in every combination of the four', () => {
    expect(primaryRole([])).toBeUndefined();
    expect(primaryRole(['reader'])).toBe('reader');
    expect(primaryRole(['reviewer'])).toBe('reviewer');
    expect(primaryRole(['clinician', 'reviewer'])).toBe('reviewer');
    expect(primaryRole(['reader', 'clinician'])).toBe('clinician');
    expect(primaryRole(['admin', 'reviewer', 'reader'])).toBe('admin');
  });
});
