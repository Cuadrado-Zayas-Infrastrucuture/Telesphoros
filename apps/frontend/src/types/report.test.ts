import { REPORT_TYPES } from '@telesphoros/shared-types';
import { describe, expect, it } from 'vitest';
import { REPORT_TYPES as OFFERED, REPORT_TYPE_LABELS } from './report';

describe('report types in the frontend', () => {
  it('offers only the two types that have an upload screen, and never lab-pdf', () => {
    expect([...OFFERED]).toEqual(['vcf', 'structured']);
  });

  it('can label every type the API may return (so a lab-pdf row never renders as undefined)', () => {
    for (const type of REPORT_TYPES) expect(REPORT_TYPE_LABELS[type]).toEqual(expect.any(String));
  });
});
