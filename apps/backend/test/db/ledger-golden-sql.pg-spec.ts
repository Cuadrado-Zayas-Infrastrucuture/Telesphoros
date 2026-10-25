import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/** The SQL formulas inside ledger_append_internal / ledger_record_checkpoint / redact_event_note, against the independent golden vectors. */
interface GoldenEvent {
  seq: string;
  eventType: string;
  subjectTable: string;
  subjectId: string;
  actorSub: string;
  payloadSha256: string;
  projectionVersion: number;
  prevHash: string;
  createdAtUtc: string;
  recordHash: string;
}
const vectors: {
  tenantId: string;
  events: GoldenEvent[];
  checkpoint: { id: string; tenantId: string; upToSeq: string; headHash: string; mode: string; payload: string };
  redaction: { noteId: string; bodySha256: string; basisCode: string; payload: string };
} = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'ledger-golden-vectors.json'), 'utf8'));
let pg: EphemeralDatabase;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
});
afterAll(async () => {
  await pg.drop();
});

describe('the database computes the golden hashes', () => {
  it.each(vectors.events.map((e) => [e.seq, e] as const))('event %s: the SQL record hash equals the independent one, timestamp formatting included', async (_s, e) => {
    // The exact expression of ledger_append_internal, with the timestamp round-tripped through timestamptz as the table stores it.
    const { rows } = await withAdmin(pg.adminUrl, (c) =>
      c.query(
        `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, '1', $9::text,
              pg_catalog.to_char($10::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex') AS h`,
        [vectors.tenantId, e.seq, e.eventType, e.subjectTable, e.subjectId, e.actorSub, e.payloadSha256, String(e.projectionVersion), e.prevHash, e.createdAtUtc],
      ),
    );
    expect(rows[0].h).toBe(e.recordHash);
  });

  it('the checkpoint and redaction payload formulas equal the independent ones', async () => {
    const cp = vectors.checkpoint;
    const red = vectors.redaction;
    const { rows } = await withAdmin(pg.adminUrl, (c) =>
      c.query(
        `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), $1::text, $2::text, $3::text, $4::text, $5::text), 'UTF8')), 'hex') AS cp,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($6::text || ':' || $7::text || ':' || $8::text, 'UTF8')), 'hex') AS red`,
        [cp.id, cp.tenantId, cp.upToSeq, cp.headHash, cp.mode, red.noteId, red.bodySha256, red.basisCode],
      ),
    );
    expect(rows[0]).toEqual({ cp: cp.payload, red: red.payload });
  });

  it('the formula in the migration is the formula tested here (the test cannot drift from the code)', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '0005_ledger.up.sql'), 'utf8');
    expect(sql).toContain(`t, s::text, p_type, p_table, p_subject::text, a, p_payload, p_projection_version::text, '1', h.record_hash`);
    expect(sql).toContain(`pg_catalog.to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  });
});
