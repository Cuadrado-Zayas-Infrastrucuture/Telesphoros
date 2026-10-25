import { describe, expect, test } from 'vitest';
import { RESULTS } from '../evals/golden/results';
import { ALL_SENSORS, runSensors, s1, s2, s3, s4, s5, s6 } from '../src/evaluators/sensors';
import { explanationSchema, type Explanation } from '../src/evaluators/types';

const e = (...statements: unknown[]): Explanation => explanationSchema.parse({ statements });
const gloss = (text: string) => ({ kind: 'gloss', fields: ['implication'], text });
const restate = (text: string) => ({ kind: 'restate', fields: ['drug'], text });
const quote = (startByte: number, endByte: number, text: string, field = 'recommendationText') => ({ kind: 'quote', field, startByte, endByte, text });

describe('S1 quotes are byte-exact spans of the result', () => {
  test('passes an exact span', () => expect(s1(e(quote(0, 12, 'Avoid drugv.')), RESULTS.avoid)).toEqual([]));
  test('holds an altered span', () => expect(s1(e(quote(0, 12, 'Avoid drugx.')), RESULTS.avoid)).toHaveLength(1));
  test('holds a span past the end', () => expect(s1(e(quote(900, 910, 'Avoid')), RESULTS.avoid)).toHaveLength(1));
  test('holds a quote of a field that is null', () => expect(s1(e(quote(0, 5, 'Avoid', 'implication')), RESULTS.normal)).toHaveLength(1));
  test('holds a span that cuts a multi-byte character', () => {
    const r = { ...RESULTS.avoid, recommendationText: 'Avoid drugv – now.' };
    expect(s1(e(quote(12, 13, '–')), r)).toHaveLength(1);
    expect(s1(e(quote(12, 15, '–')), r)).toEqual([]);
  });
});
describe('S2 restatements name only the result', () => {
  test('passes', () => expect(s2(e(restate('For drugv the guideline gives a Strong recommendation for patients with GENEA Synthetic Poor.')), RESULTS.avoid)).toEqual([]));
  test('holds another drug', () => expect(s2(e(restate('For drugq the guideline gives a Strong recommendation.')), RESULTS.avoid)).toHaveLength(1));
  test('holds another strength', () => expect(s2(e(restate('For drugv the guideline gives a Moderate recommendation.')), RESULTS.avoid)).toHaveLength(1));
  test('does not judge a gloss', () => expect(s2(e(gloss('Mystery words here.')), RESULTS.avoid)).toEqual([]));
});
describe('S3 gloss terms come from the result or the glossary', () => {
  test('passes', () => expect(s3(e(gloss('Reduced enzyme function increases exposure to drugv in the body.')), RESULTS.avoid)).toEqual([]));
  test('holds a term in neither', () => expect(s3(e(gloss('Refer the patient to a specialist.')), RESULTS.avoid)).toHaveLength(1));
  test('holds another drug', () => expect(s3(e(gloss('Exposure to drugq increases.')), RESULTS.avoid)).toHaveLength(1));
});
describe('S4 numbers come from the result', () => {
  test('passes a number in the result', () => expect(s4(e(gloss('Start drugx at 50% of the standard dose.')), RESULTS.dose)).toEqual([]));
  test('holds a number not in the result', () => expect(s4(e(gloss('Start drugx at 25% of the standard dose.')), RESULTS.dose)).toHaveLength(1));
  test('holds a number word not in the result', () => expect(s4(e(gloss('Consider a double dose of drugy.')), RESULTS.optional)).toHaveLength(1));
  test('passes a number word that is in the result', () => expect(s4(e(gloss('Use one dose.')), { ...RESULTS.normal, recommendationText: 'Use one dose.' })).toEqual([]));
});
describe("S5 direction words keep the result's words and pairings", () => {
  test("passes the result's own pairing", () => expect(s5(e(gloss('Reduced enzyme function lowers clearance of drugx.')), RESULTS.dose)).toEqual([]));
  test('holds a direction the result does not use', () => expect(s5(e(gloss('Increased enzyme function lowers clearance of drugx.')), RESULTS.dose)).toHaveLength(1));
  test('holds a re-paired direction (consider drug, not avoid drug)', () => expect(s5(e(gloss('Consider drugv.')), RESULTS.avoid)).toHaveLength(1));
  test('holds a negation the result does not use', () => expect(s5(e(gloss('Do not use drugw at the standard dose.')), RESULTS.normal)).toHaveLength(1));
  test('does not pair a word with the next sentence', () => expect(s5(e(gloss('Avoid. Consider an alternative agent.')), RESULTS.avoid)).toEqual([]));
  test("the result's strength word is exempt", () => expect(s5(e(restate('A Strong recommendation for drugv.')), RESULTS.avoid)).toEqual([]));
});
describe('S6 limits, banned words and dropped qualifiers', () => {
  test('passes', () => expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('Exposure rises.')), RESULTS.avoid)).toEqual([]));
  test('holds markup', () => expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('See <b>drugv</b>.')), RESULTS.avoid).map((h) => h.reason)).toContain('S6_FORMAT'));
  test('holds a link', () => expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('See https://x.example.')), RESULTS.avoid).map((h) => h.reason)).toContain('S6_FORMAT'));
  test('holds non-ASCII in a gloss', () => expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('Exposure ↑.')), RESULTS.avoid).map((h) => h.reason)).toContain('S6_FORMAT'));
  test('holds a second-person address', () => expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('You may stop.')), RESULTS.avoid).map((h) => h.reason)).toContain('S6_BANNED_WORD'));
  test('holds an over-long statement', () =>
    expect(s6(e(quote(0, 12, 'Avoid drugv.'), gloss('enzyme '.repeat(70))), RESULTS.avoid).map((h) => h.reason)).toContain('S6_STATEMENT_TOO_LONG'));
  test('holds a dropped qualifier', () => expect(s6(e(quote(0, 31, 'Consider a higher dose of drugy')), RESULTS.optional).map((h) => h.reason)).toContain('S6_QUALIFIER_DROPPED'));
  test('passes when the qualifier is carried', () => expect(s6(e(quote(0, 64, RESULTS.optional.recommendationText)), RESULTS.optional)).toEqual([]));
});
test('runSensors reports every sensor that holds', () => {
  const holds = runSensors(e(gloss('Refer 25 people. You may stop.')), RESULTS.avoid);
  expect(new Set(holds.map((h) => h.sensor))).toEqual(new Set(['S3', 'S4', 'S5', 'S6']));
  expect(Object.keys(ALL_SENSORS)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
});
test('a missing sensor is a hold, never a pass', () => {
  const rest = Object.fromEntries(Object.entries(ALL_SENSORS).filter(([id]) => id !== 'S3'));
  const holds = runSensors(e(quote(0, 12, 'Avoid drugv.')), RESULTS.avoid, rest as unknown as typeof ALL_SENSORS);
  expect(holds).toEqual([{ sensor: 'S3', reason: 'SENSOR_MISSING', statement: null }]);
});
