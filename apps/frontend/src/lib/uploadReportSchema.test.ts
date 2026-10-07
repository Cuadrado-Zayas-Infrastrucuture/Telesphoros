import { describe, expect, it } from 'vitest';
import { MAX_REPORT_BYTES, uploadReportSchema } from '@/lib/uploadReportSchema';

const valid = {
  patientLabel: 'SYN-0001',
  reportType: 'vcf',
  file: new File(['##fileformat=VCFv4.2'], 'sample.vcf'),
  syntheticConfirmed: true,
};

const messages = (input: unknown) => {
  const result = uploadReportSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('uploadReportSchema', () => {
  it('accepts a complete synthetic submission', () => {
    expect(uploadReportSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty submission with a message per field', () => {
    const result = messages({ patientLabel: '', reportType: '', file: undefined, syntheticConfirmed: false });
    expect(result).toEqual(
      expect.arrayContaining([
        'Enter a synthetic patient label.',
        'Choose a report type.',
        'Choose a report file.',
        'Confirm that this file contains synthetic data only.',
      ]),
    );
  });

  it('rejects labels that look like names or real identifiers', () => {
    expect(messages({ ...valid, patientLabel: 'Jane Doe' })).toContain(
      'Use letters, numbers and hyphens only (no names or real identifiers).',
    );
  });

  it('rejects oversize files and wrong extensions', () => {
    const big = new File([new Uint8Array(MAX_REPORT_BYTES + 1)], 'big.vcf');
    expect(messages({ ...valid, file: big })).toContain('The file is larger than 10 MB.');
    expect(messages({ ...valid, file: new File(['x'], 'report.exe') })).toContain(
      'Only .vcf and .json files are accepted.',
    );
  });
});
