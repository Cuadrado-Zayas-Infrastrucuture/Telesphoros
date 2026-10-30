import { describe, expect, it } from 'vitest';
import { ackKindFor, canonicalAckBasis, resultAcknowledgementCreateSchema, sameAckBasis } from './index';

// Spec 019 D02a: the acknowledgement request (T004). Each malformed field is refused on its own, against a valid control.
describe('resultAcknowledgementCreateSchema', () => {
  const valid = {
    requestId: '0b0e9a3c-6f61-4d8e-9f1a-1c2d3e4f5a6b',
    resultId: '1c1f0b4d-7a72-4e9f-8a2b-2d3e4f5a6b7c',
    patientId: '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d',
    kind: 'review',
    reviewTask: 'result-review',
    displayedBasis: ['active'],
  };

  it('accepts a review of an active result and a retraction review of a retracted one (controls)', () => {
    expect(resultAcknowledgementCreateSchema.parse(valid)).toEqual(valid);
    const retracted = { ...valid, kind: 'retraction-reviewed', displayedBasis: ['not-current', 'retracted'] };
    expect(resultAcknowledgementCreateSchema.parse(retracted).displayedBasis).toEqual(['retracted', 'not-current']); // put in the server's order
  });

  it.each([
    ['requestId', { requestId: 'not-a-uuid' }],
    ['resultId', { resultId: 'r1' }],
    ['patientId', { patientId: '' }],
    ['kind', { kind: 'acknowledged' }],
    ['reviewTask', { reviewTask: 'decision-review' }],
    ['displayedBasis empty', { displayedBasis: [] }],
    ['displayedBasis unknown', { displayedBasis: ['current'] }],
    ['displayedBasis repeated', { displayedBasis: ['disputed', 'disputed'] }],
    ['displayedBasis active with another', { displayedBasis: ['active', 'disputed'] }],
    ['A3: review of a retracted basis', { displayedBasis: ['retracted'] }],
    ['A3: retraction reviewed of an active basis', { kind: 'retraction-reviewed' }],
    ['an extra field', { note: 'x' }],
  ])('refuses %s', (_label, change) => {
    expect(resultAcknowledgementCreateSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('refuses each missing field', () => {
    for (const key of Object.keys(valid)) {
      const { [key as keyof typeof valid]: _omit, ...rest } = valid; // eslint-disable-line @typescript-eslint/no-unused-vars
      expect(resultAcknowledgementCreateSchema.safeParse(rest).success).toBe(false);
    }
  });
});

describe('basis helpers', () => {
  it('order, compare and choose the kind as A3 says', () => {
    expect(canonicalAckBasis(['not-current', 'disputed', 'retracted'])).toEqual(['retracted', 'disputed', 'not-current']);
    expect(sameAckBasis(['disputed', 'retracted'], ['retracted', 'disputed'])).toBe(true);
    expect(sameAckBasis(['active'], ['disputed'])).toBe(false);
    expect(sameAckBasis(['retracted'], ['retracted', 'not-current'])).toBe(false);
    expect(ackKindFor(['active'])).toBe('review');
    expect(ackKindFor(['superseded', 'not-current'])).toBe('review');
    expect(ackKindFor(['retracted', 'not-current'])).toBe('retraction-reviewed');
  });
});
