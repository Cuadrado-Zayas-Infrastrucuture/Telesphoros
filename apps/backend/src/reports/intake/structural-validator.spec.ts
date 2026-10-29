import type { ReportType } from '@telesphoros/shared-types';
import { InvalidStructureError, StructuralValidator } from './structural-validator';
import { IntakeProgress } from './stage';
const validate = (type: ReportType, input: string | Buffer) => {
  const v = new StructuralValidator(type);
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  for (const byte of b) v.feed(Buffer.from([byte]));
  v.finish();
};
it.each(['null', 'false', '0', '-2.1e+3', '"hello 🌍"', '{"a":[true,null,{},[],"x\\u1234"]}'])('accepts complete JSON syntax across byte boundaries: %s', (s) =>
  expect(() => validate('structured', s)).not.toThrow(),
);
it.each([
  '',
  '{}{}',
  '{"a":}',
  '[1,]',
  '{"a":1,}',
  '01',
  '1e',
  'trueX',
  '"\\q"',
  '"\n"',
  '"unterminated',
  '[',
  'Infinity',
  '1e999',
  ' '.repeat(10) + 'x',
  '['.repeat(65) + '0' + ']'.repeat(65),
  '"' + 'x'.repeat(65537) + '"',
  '1'.repeat(129),
])('refuses incomplete or bounded JSON syntax: %s', (s) => expect(() => validate('structured', s)).toThrow());
it('rejects invalid UTF-8 and a BOM', () => {
  expect(() => validate('structured', Buffer.from([0xff]))).toThrow();
  expect(() => validate('structured', '\ufeff{}')).toThrow();
});
it('checks PDF prefix and final EOF without retaining the payload', () => {
  expect(() => validate('lab-pdf', '%PDF-1.7\ninert\n%%EOF\n')).not.toThrow();
  for (const s of ['x%PDF-1.7\n%%EOF', '%PDF-9.0\n%%EOF', '%PDF-1.7\n', '%PDF-1.7\n%%EOF\nextra']) expect(() => validate('lab-pdf', s)).toThrow();
});
it('refuses a VCF, or any type but the two accepted ones, before reading a byte (no raw genomic data is stored)', () => {
  for (const type of ['vcf', 'VCF', 'pdf', '']) expect(() => new StructuralValidator(type as ReportType)).toThrow(InvalidStructureError);
  for (const type of ['structured', 'lab-pdf'] as const) expect(() => new StructuralValidator(type)).not.toThrow(); // control
});
it('uses monotonic idle, progress and absolute deadlines', () => {
  let time = 0;
  const p = new IntakeProgress(() => time);
  time = 5000;
  p.check();
  time = 10000;
  expect(() => p.check()).toThrow();
  const q = new IntakeProgress(() => time);
  for (let i = 0; i < 11; i++) {
    time += 5000;
    q.add(1310720);
    q.check();
  }
  time += 5000;
  expect(() => q.check()).toThrow();
});
it('rejects a trickle despite non-idle traffic', () => {
  let time = 0;
  const p = new IntakeProgress(() => time);
  time = 5000;
  p.add(1);
  p.check();
  time = 10000;
  p.add(1);
  expect(() => p.check()).toThrow();
});
