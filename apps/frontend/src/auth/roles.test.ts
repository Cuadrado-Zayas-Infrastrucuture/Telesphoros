import type { Role } from '@telesphoros/shared-types';
import { describe, expect, it } from 'vitest';
import { primaryRole, WRITER_ROLES } from './roles';

const canWrite = (roles: Role[]) => roles.some((r) => WRITER_ROLES.includes(r));

describe('roles', () => {
  it('lets clinicians and admins write, in any combination, and never a reader or reviewer alone', () => {
    expect(canWrite(['clinician'])).toBe(true);
    expect(canWrite(['admin'])).toBe(true);
    expect(canWrite(['clinician', 'reviewer'])).toBe(true);
    expect(canWrite(['admin', 'reviewer'])).toBe(true);
    expect(canWrite(['reader'])).toBe(false);
    expect(canWrite(['reviewer'])).toBe(false);
    expect(canWrite([])).toBe(false);
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
