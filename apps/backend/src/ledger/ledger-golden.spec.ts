import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalHash, canonicalJson } from '../services/report-adapter/canonical-json';
import { checkpointPayload, recordHash, redactionPayload } from './record-hash';

interface Vectors {
  tenantId: string;
  events: Array<{
    seq: string;
    eventType: string;
    subjectTable: string;
    subjectId: string;
    actorSub: string;
    projection: unknown;
    payloadSha256: string;
    projectionVersion: number;
    hashVersion: number;
    prevHash: string;
    createdAtUtc: string;
    recordHash: string;
  }>;
  checkpoint: { id: string; tenantId: string; upToSeq: string; headHash: string; mode: string; payload: string };
  redaction: { noteId: string; bodySha256: string; basisCode: string; payload: string };
  canonicalJson: Array<{ value: unknown; canonical: string; sha256: string }>;
}
const vectors: Vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'ledger-golden-vectors.json'), 'utf8'));

describe('ledger golden vectors (computed by an independent implementation)', () => {
  it('has the vectors it claims (a floor)', () => {
    expect(vectors.events.length).toBe(3);
    expect(vectors.canonicalJson.length).toBeGreaterThanOrEqual(5);
  });

  it.each(vectors.events.map((e) => [e.seq, e] as const))('event %s: payload hash and record hash match', (_seq, e) => {
    expect(canonicalHash(e.projection)).toBe(e.payloadSha256);
    expect(
      recordHash({
        tenantId: vectors.tenantId,
        seq: e.seq,
        eventType: e.eventType,
        subjectTable: e.subjectTable,
        subjectId: e.subjectId,
        actorSub: e.actorSub,
        payloadSha256: e.payloadSha256,
        projectionVersion: e.projectionVersion,
        hashVersion: e.hashVersion,
        prevHash: e.prevHash,
        createdAtUtc: e.createdAtUtc,
      }),
    ).toBe(e.recordHash);
  });

  it('the vector events form a chain', () => {
    vectors.events.forEach((e, i) => expect(e.prevHash).toBe(i === 0 ? '0'.repeat(64) : vectors.events[i - 1]!.recordHash));
  });

  it('checkpoint and redaction payloads match', () => {
    expect(
      checkpointPayload({
        id: vectors.checkpoint.id,
        tenantId: vectors.checkpoint.tenantId,
        upToSeq: vectors.checkpoint.upToSeq,
        headHash: vectors.checkpoint.headHash,
        mode: vectors.checkpoint.mode,
      }),
    ).toBe(vectors.checkpoint.payload);
    expect(redactionPayload(vectors.redaction)).toBe(vectors.redaction.payload);
  });

  it.each(vectors.canonicalJson.map((c, i) => [i, c] as const))('canonical JSON vector %i matches byte for byte', (_i, c) => {
    expect(canonicalJson(c.value)).toBe(c.canonical);
    expect(canonicalHash(c.value)).toBe(c.sha256);
  });
});
