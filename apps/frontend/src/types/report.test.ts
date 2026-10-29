import { REPORT_TYPES } from '@telesphoros/shared-types';
import { describe, expect, it } from 'vitest';
import { REPORT_TYPES as OFFERED, REPORT_TYPE_LABELS } from './report';

describe('report types in the frontend', () => {
  it('offers only the type that has an upload screen, never lab-pdf, and never raw genomic VCF', () => {
    expect([...OFFERED]).toEqual(['structured']);
    expect(OFFERED).not.toContain('vcf');
    expect(REPORT_TYPE_LABELS).not.toHaveProperty('vcf');
  });

  it('can label every type the API may return (so a lab-pdf row never renders as undefined)', () => {
    for (const type of REPORT_TYPES) expect(REPORT_TYPE_LABELS[type]).toEqual(expect.any(String));
  });
});
