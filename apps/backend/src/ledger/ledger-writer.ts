import { randomUUID } from 'node:crypto';
import { EVENT_TYPE_FOR_TABLE, PROJECTION_VERSION, type RecordTable, toLedgerError } from './ledger-types';
import { loadProjections, projectionHash, type Queryable } from './projections';

/**
 * The ONLY code that calls `ledger_append`. Call `appendEvent` as the LAST statement of the transaction that inserted the record
 * (and its children): the row's head lock is then held only from here to COMMIT, and the projection is read back exactly as the
 * verifier will read it. At COMMIT the database refuses the transaction if the record and its event do not match
 * (migration 0005: deferred foreign key from the record, deferred constraint trigger on the event).
 *
 * The transaction must have set the tenant and actor settings (Database.withTenant does, given an actor).
 */
export async function appendEvent(client: Queryable, table: RecordTable, recordId: string, eventId: string): Promise<{ seq: string; payloadSha256: string }> {
  const projections = await loadProjections(client, table, [recordId]);
  const projection = projections.get(recordId);
  if (!projection) throw new Error('The record to append an event for was not found in this transaction.');
  const payloadSha256 = projectionHash(projection);
  try {
    const { rows } = await client.query<{ seq: string }>(`SELECT ledger_append($1::uuid, $2, $3, $4::uuid, $5, $6::smallint)::text AS seq`, [
      eventId, EVENT_TYPE_FOR_TABLE[table], table, recordId, payloadSha256, PROJECTION_VERSION,
    ]);
    return { seq: rows[0]!.seq, payloadSha256 };
  } catch (error) {
    throw toLedgerError(error);
  }
}

/** A fresh id for a record and, separately, for its event (the record carries `ledger_event_id` before the event exists). */
export const newId = (): string => randomUUID();
