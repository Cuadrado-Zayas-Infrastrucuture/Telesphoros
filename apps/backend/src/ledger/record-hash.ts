import { createHash } from 'node:crypto';
import { HASH_VERSION } from './ledger-types';

/** The bytes between the fields of an event's hash input. No hashed value may contain it (the database enforces that). */
const SEPARATOR = '\u001f';

export interface HashableEvent {
  tenantId: string;
  /** bigint as a decimal string: never a JavaScript number */
  seq: string;
  eventType: string;
  subjectTable: string;
  subjectId: string;
  actorSub: string;
  payloadSha256: string;
  projectionVersion: number;
  hashVersion: number;
  prevHash: string;
  /** `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`, UTC, microseconds, as the database formats it */
  createdAtUtc: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/**
 * The hash of one ledger event: the same formula as ledger_append_internal in migration 0005, computed independently here.
 *   sha256( tenant, seq, type, table, subject, actor, payload, projection version, hash version, previous hash, created-at )
 * joined with chr(31), UTF-8.
 */
export function recordHash(event: HashableEvent): string {
  if (event.hashVersion !== HASH_VERSION) throw new RangeError('Unsupported ledger hash version.');
  const input = [
    event.tenantId,
    event.seq,
    event.eventType,
    event.subjectTable,
    event.subjectId,
    event.actorSub,
    event.payloadSha256,
    String(event.projectionVersion),
    String(event.hashVersion),
    event.prevHash,
    event.createdAtUtc,
  ].join(SEPARATOR);
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The payload of a checkpoint event: sha256 of  id, tenant, up_to_seq, head_hash, mode  joined with chr(31) (the SQL function builds the same text). */
export function checkpointPayload(parts: { id: string; tenantId: string; upToSeq: string; headHash: string; mode: string }): string {
  return createHash('sha256').update([parts.id, parts.tenantId, parts.upToSeq, parts.headHash, parts.mode].join(SEPARATOR), 'utf8').digest('hex');
}

/** The payload of a redaction event: sha256 of  note id : original body digest : basis code. */
export function redactionPayload(parts: { noteId: string; bodySha256: string; basisCode: string }): string {
  return createHash('sha256').update(`${parts.noteId}:${parts.bodySha256}:${parts.basisCode}`, 'utf8').digest('hex');
}
