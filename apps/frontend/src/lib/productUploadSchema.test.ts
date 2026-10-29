import { describe, expect, it } from 'vitest';
import { productUploadSchema } from './productUploadSchema';
const valid = { patientId: '11111111-1111-4111-8111-111111111111', reportType: 'structured', file: new File(['{"synthetic":true}'], 'sample.json'), syntheticConfirmed: true };
describe('product upload validation', () => {
  it('accepts structured reports linked to an existing UUID, and refuses VCF (no raw genomic data)', () => {
    expect(productUploadSchema.safeParse(valid).success).toBe(true);
    expect(productUploadSchema.safeParse({ ...valid, reportType: 'vcf', file: new File(['x'], 'sample.vcf') }).success).toBe(false);
    expect(productUploadSchema.safeParse({ ...valid, file: new File(['x'], 'sample.vcf') }).success).toBe(false);
  });
  it.each([
    { patientId: '' },
    { patientId: 'SYN-0001' },
    { syntheticConfirmed: false },
    { reportType: 'lab-pdf' },
    { file: new File([], 'empty.json') },
    { file: new File(['x'], 'bad name.json') },
    { file: new File(['x'], 'a'.repeat(100) + '.json') },
    { file: new File(['x'], 'mismatch.pdf') },
    { file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.json') },
  ])('refuses invalid product input %j', (change) => expect(productUploadSchema.safeParse({ ...valid, ...change }).success).toBe(false));
});
