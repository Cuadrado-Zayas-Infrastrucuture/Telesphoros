import { REASON_CODES, REASON_OUTCOME } from '@telesphoros/cpic-schema';
import { describe, expect, test } from 'vitest';
import { eligibility, FALLBACK_TEXT } from '../src/fallback';

describe('FR-002 eligibility and fixed text', () => {
  test('a shown result with a strength other than "No recommendation" is eligible', () => {
    for (const s of ['Strong', 'Moderate', 'Optional']) expect(eligibility('shown', null, s)).toEqual({ eligible: true });
  });
  test('control: "No recommendation" is not eligible and has its own text', () =>
    expect(eligibility('shown', null, 'No recommendation')).toEqual({ eligible: false, reason: 'no-recommendation-strength', text: FALLBACK_TEXT['no-recommendation-strength'] }));
  test.each([...REASON_CODES])('reason code %s has fixed text and no model call', (code) => {
    const r = eligibility(REASON_OUTCOME[code], code, null);
    expect(r).toEqual({ eligible: false, reason: code, text: FALLBACK_TEXT[code] });
    expect(FALLBACK_TEXT[code]).toMatch(/^No explanation is generated\./);
  });
  test('the table covers exactly the engine reason codes plus its two own entries', () =>
    expect(Object.keys(FALLBACK_TEXT).sort()).toEqual([...REASON_CODES, 'no-recommendation-strength', 'unknown-outcome'].sort()));
  test('unknown outcomes, codes and prototype keys fail closed', () => {
    for (const [o, c, s] of [
      ['mystery', null, null],
      ['held', 'made-up', null],
      ['held', 'constructor', null],
      ['held', null, null],
      ['shown', null, 'Weak'],
      ['shown', null, null],
    ] as const)
      expect(eligibility(o, c, s), `${o} ${c} ${s}`).toMatchObject({ eligible: false, reason: 'unknown-outcome' });
  });
});
