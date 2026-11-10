import { describe, expect, it } from 'vitest';
import { clinicianLabel } from './clinicianLabel';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '88888888-8888-4888-8888-88888888ab9f';

describe('clinicianLabel', () => {
  it("uses the signed-in clinician's own word", () => {
    expect(clinicianLabel(ME, ME)).toBe('Me');
    expect(clinicianLabel(ME, ME, 'You')).toBe('You');
  });
  it('shows another clinician as a short stable label, never the raw id', () => {
    expect(clinicianLabel(OTHER, ME)).toBe('Clinician AB9F');
    expect(clinicianLabel(OTHER, ME)).toBe(clinicianLabel(OTHER));
    expect(clinicianLabel(OTHER, ME)).not.toContain(OTHER);
  });
  it('labels a clinician without knowing who is signed in', () => {
    expect(clinicianLabel(ME)).toBe('Clinician 1111');
  });
  it('copes with ids that are missing or have no letters or digits', () => {
    expect(clinicianLabel(null)).toBe('Unknown clinician');
    expect(clinicianLabel('')).toBe('Unknown clinician');
    expect(clinicianLabel('----')).toBe('Clinician');
    expect(clinicianLabel('a|b')).toBe('Clinician AB');
  });
});
