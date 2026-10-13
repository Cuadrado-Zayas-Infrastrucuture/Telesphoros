import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * The rule "no evaluation without a verified patient link" is enforced by the evaluations service and re-checked inside the storing transaction
 * (migration 0019's design note explains why it is not a table trigger). That only holds while nothing else in production source creates an
 * evaluation, so this walks the source and fails the day another caller appears: a new caller must go through the service, or change this test on
 * purpose in review.
 */
const SRC = resolve(__dirname, '..');
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => resolve(SRC, f));
const callers = files.filter((f) => /\.insertEvaluation\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).replace(/\\/g, '/'));

describe('who creates evaluations', () => {
  it('is the evaluations service alone (the scan finds it: a floor, so an empty read cannot pass)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(callers).toEqual(['lab-reports/evaluations.service.ts']);
  });

  it('and that service always names the patient-link decision it relied on', () => {
    const service = readFileSync(resolve(SRC, 'lab-reports/evaluations.service.ts'), 'utf8');
    expect(service).toMatch(/patientLinkDecisionId:\s*link\.decision!\.id/);
    expect(service).toMatch(/link\.state !== 'verified'/);
    expect(service).toMatch(/PatientLinkUnverifiedError/);
  });
});
