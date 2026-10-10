import { describe, expect, it } from 'vitest';
import { productUploadSchema } from './productUploadSchema';
const valid = { patientId: '11111111-1111-4111-8111-111111111111', reportType: 'vcf', file: new File(['x'], 'sample.vcf'), syntheticConfirmed: true };
describe('product upload validation', () => {
  it('accepts VCF and structured reports linked to an existing UUID', () => {
    expect(productUploadSchema.safeParse(valid).success).toBe(true);
    expect(productUploadSchema.safeParse({ ...valid, reportType: 'structured', file: new File(['{}'], 'sample.json') }).success).toBe(true);
  });
  it.each([
    { patientId: '' }, { patientId: 'SYN-0001' }, { syntheticConfirmed: false }, { reportType: 'lab-pdf' },
    { file: new File([], 'empty.vcf') }, { file: new File(['x'], 'bad name.vcf') },
    { file: new File(['x'], 'a'.repeat(100) + '.vcf') }, { file: new File(['x'], 'mismatch.json') },
    { file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.vcf') },
  ])('refuses invalid product input %j', change => expect(productUploadSchema.safeParse({ ...valid, ...change }).success).toBe(false));
});
