import { describe, expect, test } from 'vitest';
import { ATTACKS } from '../evals/attacks/attacks';
import { RESULTS } from '../evals/golden/results';
import { hashBytes } from '../src/evidence';
import { buildPrompt, InputRefused, TEMPLATE_V1, templateDigest } from '../src/prompts/explain-v1';

const literals = TEMPLATE_V1.split(/\{\{\w+\}\}/);
describe('FR-001 closed prompt', () => {
  test('every character is a template literal or one named field of the result', () => {
    for (const r of Object.values(RESULTS)) {
      const { prompt, segments } = buildPrompt(r);
      expect(segments.map((s) => s.text).join('')).toBe(prompt);
      for (const s of segments) if (s.from === 'template') expect(literals).toContain(s.text);
      const fields = new Set(segments.filter((s) => s.from === 'field').map((s) => (s as { field: string }).field));
      expect([...fields].sort()).toEqual(['drug', 'genes', 'guidelineId', 'guidelineVersion', 'implication', 'locator', 'recommendationText', 'strength']);
    }
  });
  test('no inbound attacker value is in any prompt', () => {
    for (const a of ATTACKS.filter((x) => x.cls === 'inbound')) for (const v of Object.values(a.inbound ?? {})) expect(buildPrompt(RESULTS[a.result]).prompt).not.toContain(v);
  });
  test('every hostile shape is refused before a model could be called', () => {
    const shapes = ATTACKS.filter((x) => x.cls === 'shape');
    expect(shapes.length).toBeGreaterThan(0);
    for (const a of shapes) expect(() => buildPrompt(a.input), a.id).toThrow(InputRefused);
  });
  test('control: a clean result is accepted', () => expect(() => buildPrompt(RESULTS.dose)).not.toThrow());
  test('the template digest is the digest of the template text', () => {
    expect(templateDigest()).toBe(hashBytes(TEMPLATE_V1));
    expect(templateDigest()).not.toBe(hashBytes(TEMPLATE_V1 + ' '));
  });
  test('the template contains no placeholder for a patient identifier or a report field', () => {
    const names = [...TEMPLATE_V1.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['drug', 'genes', 'guidelineId', 'guidelineVersion', 'implication', 'locator', 'recommendationText', 'strength']);
  });
});
