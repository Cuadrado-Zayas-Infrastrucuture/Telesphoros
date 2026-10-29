import { describe, expect, it } from 'vitest';
import { reportTypeFor } from './reportTypeFor';

describe('reportTypeFor (specs/016 D5)', () => {
  it('reads the type from the extension, in any case', () => {
    expect(reportTypeFor('syn-004.JSON')).toBe('structured');
    expect(reportTypeFor('Lab-Report.Pdf')).toBe('lab-pdf');
  });

  it('refuses anything else: raw genomic data (VCF), and a known extension in the middle of the name', () => {
    expect(reportTypeFor('SYN-004.vcf')).toBeNull();
    expect(reportTypeFor('notes.txt')).toBeNull();
    expect(reportTypeFor('SYN-004.json.zip')).toBeNull();
    expect(reportTypeFor('json')).toBeNull();
  });
});
