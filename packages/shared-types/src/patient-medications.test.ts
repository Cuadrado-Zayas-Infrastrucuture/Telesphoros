import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { patientMedicationInputSchema, patientMedicationsQuerySchema } from './patient-medications';
import { BUNDLED_DRUG_LIST, drugListSchema, drugPresentation, matchesDrug, tallMan } from './drug-list';
const input = {
  requestId: 'ab148a10-fbbe-4ccf-9a00-792a2616494e',
  rxcui: '991001',
  listVersion: 'a'.repeat(64),
  status: 'active',
  startMonth: null,
  stopMonth: null,
  source: 'clinician-entered',
};
describe('medication capture contracts', () => {
  it('accepts optional dates, stopped entries and explicit versioned corrections', () => {
    expect(patientMedicationInputSchema.parse(input)).toEqual(input);
    expect(patientMedicationInputSchema.parse({ ...input, startMonth: undefined, stopMonth: undefined })).toMatchObject({ startMonth: null, stopMonth: null });
    expect(patientMedicationInputSchema.safeParse({ ...input, status: 'stopped', startMonth: '2026-01', stopMonth: '2026-02' }).success).toBe(true);
    expect(patientMedicationInputSchema.safeParse({ ...input, entryId: input.requestId, expectedVersion: 1 }).success).toBe(true);
  });
  it.each([
    { startMonth: '2026-13' },
    { stopMonth: '2026-02' },
    { status: 'stopped', startMonth: '2026-03', stopMonth: '2026-02' },
    { entryId: input.requestId },
    { expectedVersion: 1 },
    { dose: 'secret' },
    { name: 'hydrOXYzine' },
    { requestId: undefined },
  ])('rejects malformed capture %j', (over) => {
    expect(patientMedicationInputSchema.safeParse({ ...input, ...over }).success).toBe(false);
  });
  it('requires an entry for a historical read and rejects unknown query fields', () => {
    expect(patientMedicationsQuerySchema.safeParse({ version: '1' }).success).toBe(false);
    expect(patientMedicationsQuerySchema.parse({ entryId: input.requestId, version: '1' })).toEqual({ entryId: input.requestId, version: 1 });
    expect(patientMedicationsQuerySchema.safeParse({ reportId: input.requestId }).success).toBe(false);
  });
});
const artifact = {
  status: 'verified',
  version: 'a'.repeat(64),
  cpicRelease: 'fixture',
  cpicSource: 'https://example.invalid',
  accessedAt: '2026-11-01T00:00:00.000Z',
  rxnormRelease: 'fixture',
  attribution: 'fixture',
  currencyNotice: 'fixture',
  citations: ['fixture1', 'fixture2', 'fixture3'],
  sourceProperties: [{ rxcui: '991001', name: 'hydroxyzine', tty: 'IN' }],
  entries: [{ rxcui: '991001', name: 'hydroxyzine', displayName: 'hydrOXYzine', tty: 'IN', rxnormRelease: 'fixture' }],
};
describe('drug source and display guards', () => {
  it('requires a source-verified bundled list before MD-a can ship', () => {
    expect(BUNDLED_DRUG_LIST, 'T402 is incomplete: run the source generator and install its unedited artifact.').not.toBeNull();
  });
  it('uses FDA capitals visually and plain text accessibly, with case-independent search', () => {
    expect(drugPresentation({ name: 'hydroxyzine' })).toEqual({ displayName: 'hydrOXYzine', ariaLabel: 'hydroxyzine' });
    expect(matchesDrug({ name: 'hydroxyzine' }, 'HYDROXY')).toBe(true);
    expect(tallMan('synthetic', ['synTHETIC'])).toBe('synTHETIC');
    expect(tallMan('unlisted')).toBe('unlisted');
  });
  it('accepts a verified ingredient fixture; refuses missing/duplicate codes, release and stored Tall Man', () => {
    expect(drugListSchema.safeParse(artifact).success).toBe(true);
    for (const entry of [
      { ...artifact.entries[0], rxcui: '' },
      { ...artifact.entries[0], rxnormRelease: '' },
      { ...artifact.entries[0], name: 'hydrOXYzine' },
      { ...artifact.entries[0], name: 'invented replacement' },
    ])
      expect(drugListSchema.safeParse({ ...artifact, entries: [entry] }).success).toBe(false);
    expect(drugListSchema.safeParse({ ...artifact, entries: [...artifact.entries, ...artifact.entries] }).success).toBe(false);
    expect(drugListSchema.safeParse({ ...artifact, entries: [{ ...artifact.entries[0], name: 'synthetic other', displayName: 'synthetic other' }] }).success).toBe(false);
  });
  it('validates a real bundled artifact when available, otherwise explicitly disables capture', () => {
    if (BUNDLED_DRUG_LIST) {
      expect(drugListSchema.safeParse(BUNDLED_DRUG_LIST).success).toBe(true);
      const { status: _status, version, ...content } = BUNDLED_DRUG_LIST;
      expect(createHash('sha256').update(JSON.stringify(content)).digest('hex')).toBe(version);
    } else expect(BUNDLED_DRUG_LIST).toBeNull();
  });
});
