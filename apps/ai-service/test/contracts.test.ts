import { describe, expect, test } from 'vitest';
import { requestSchema } from '../src/contracts';
import { syntheticProfile, validProfile } from '../src/policy';
import { checkCandidate, checkSources, hashBytes } from '../src/evidence';
import { fixture, sourceDigest } from './fixtures/synthetic-sop';

describe('approved P1 strict contracts', () => {
  test('P1-01 refuses strict request fields', () => { expect(requestSchema.safeParse({ ...fixture().request,tenantId:'tenant-b' }).success).toBe(false); });
  test('P1-01 permits strict request fields control', () => { expect(requestSchema.parse(fixture().request)).toEqual(fixture().request); });
  test('P1-02 refuses Unicode input bounds', () => {
    for (const question of ['\ud800','a'.repeat(513),'😀'.repeat(513)]) expect(requestSchema.safeParse({ ...fixture().request,question }).success).toBe(false);
  });
  test('P1-02 permits Unicode input bounds control', () => { expect(requestSchema.parse({ ...fixture().request,question:'😀'.repeat(512) }).question).toHaveLength(1024); });
  test('P1-10 refuses fixed role graph', () => { expect(validProfile({ ...syntheticProfile(),roles:['retrieval','draft','verification','shell'] })).toBe(false); });
  test('P1-10 permits fixed role graph control', () => { expect(validProfile(syntheticProfile())).toBe(true); expect(syntheticProfile().roles).toEqual(['retrieval','draft','verification']); });
  test('P1-14 refuses exact evidence bytes', () => {
    const f = fixture('es'); const c = structuredClone(f.candidate); c.claims[0].startByte=57; c.claims[0].endByte=58;
    // A separate literal multibyte source: byte1 is inside é.
    const source={ ...f.source,body:'é',digest:hashBytes('é') }; c.text='é'; c.digest=source.digest; c.claims[0]={ ...c.claims[0],text:'é',startByte:1,endByte:2 };
    expect(() => checkCandidate(c,[source])).toThrow();
    expect(() => checkSources([{ ...f.source,version:'v2' }],f.context)).toThrow();
  });
  test('P1-14 permits exact evidence bytes control', () => {
    for (const locale of ['en','es'] as const) { const f=fixture(locale);expect(hashBytes(f.source.body)).toBe(sourceDigest[locale]);expect(checkCandidate(f.candidate,checkSources([f.source],f.context)).text).toBe(f.source.body); }
  });
  test('P1-25 refuses immutable profile identity', () => { const p=syntheticProfile(); expect(validProfile({ ...p,budget:{ ...p.budget,tokens:28161 } })).toBe(false); expect(validProfile({ ...p,profileDigest:'sha256:'+'0'.repeat(64) })).toBe(false); });
  test('P1-25 permits immutable profile identity control', () => { const p=syntheticProfile();expect(validProfile(p)).toBe(true);p.roles.reverse();expect(syntheticProfile().roles).toEqual(['retrieval','draft','verification']); });
});
