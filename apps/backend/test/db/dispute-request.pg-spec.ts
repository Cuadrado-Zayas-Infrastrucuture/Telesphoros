import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import type { DisputeInput } from '../../src/storage/ledger-records';
import { DisputeRequestReusedError } from '../../src/storage/ledger-records.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Inherited audit follow-up: a retried "raise a dispute" made a second dispute for the same cell. A dispute in force holds the evaluations that rely on its cell, so
 * after the first was dismissed the duplicate kept the cell disputed until someone also decided it. Same cure as the creates and the capture decision: an optional
 * retry identity per reviewer with a fingerprint of the original request.
 */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
const tenant = () => `tenant-${randomUUID()}`;
const cell = (over: Partial<DisputeInput> = {}): DisputeInput => ({
  guidelineId: 'syn-guideline',
  guidelineVersion: '1',
  guidelineContentSha256: 'c'.repeat(64),
  locator: { table: 'recommendations', row: 'r1' },
  note: 'the cell reads wrongly',
  ...over,
});
const fingerprint = (input: DisputeInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.guidelineId, input.locator.table, input.locator.row, input.locator.column ?? null, input.note]))
    .digest('hex');
const keyed = (input: DisputeInput, id = randomUUID()): DisputeInput => ({ ...input, request: { id, hash: fingerprint(input) } });

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pg.drop();
});

const count = (tenantId: string, table: string) =>
  withAdmin(pg.adminUrl, async (c: Client) => (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n as number);

describe('raising a dispute with a retry identity', () => {
  it('replays: the same reviewer, id and fingerprint get the dispute already stored, and nothing is written twice', async () => {
    const t = tenant();
    const input = keyed(cell());
    const first = await repo.raiseDispute(t, 'syn-reviewer', input);
    const again = await repo.raiseDispute(t, 'syn-reviewer', input);
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.record.id).toBe(first.record.id);
    expect(await count(t, 'cell_disputes')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(1);
    expect(await count(t, 'ledger_events')).toBe(1);
  });

  it('leaves no open duplicate: raise, dismiss, repeat the raise, and no dispute is open', async () => {
    const t = tenant();
    const input = keyed(cell());
    const raised = await repo.raiseDispute(t, 'syn-reviewer', input);
    await repo.decideDispute(t, 'syn-decider', { disputeId: raised.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
    const replay = await repo.raiseDispute(t, 'syn-reviewer', input);
    expect(replay.record.id).toBe(raised.record.id);
    const all = await repo.listDisputes(t);
    expect(all.map((d) => d.status)).toEqual(['dismissed']);
  });

  it('control: a repeat WITHOUT a retry id is a new dispute, as before (and is open)', async () => {
    const t = tenant();
    const first = await repo.raiseDispute(t, 'syn-reviewer', cell());
    await repo.decideDispute(t, 'syn-decider', { disputeId: first.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
    const second = await repo.raiseDispute(t, 'syn-reviewer', cell());
    expect(second.created).toBe(true);
    expect((await repo.listDisputes(t)).map((d) => d.status).sort()).toEqual(['dismissed', 'open']);
  });

  it('refuses the same id with a different guideline, cell or note, and writes nothing', async () => {
    const t = tenant();
    const id = randomUUID();
    await repo.raiseDispute(t, 'syn-reviewer', keyed(cell(), id));
    const different = [
      keyed(cell({ note: 'another concern' }), id),
      keyed(cell({ locator: { table: 'recommendations', row: 'r2' } }), id),
      keyed(cell({ guidelineId: 'syn-other' }), id),
    ];
    for (const input of different) await expect(repo.raiseDispute(t, 'syn-reviewer', input)).rejects.toBeInstanceOf(DisputeRequestReusedError);
    expect(await count(t, 'cell_disputes')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(1); // the refused attempts left no note behind
  });

  it('is per reviewer and per organization: another reviewer, or another organization, can use the same id', async () => {
    const a = tenant();
    const b = tenant();
    const id = randomUUID();
    const mine = await repo.raiseDispute(a, 'syn-reviewer', keyed(cell(), id));
    const other = await repo.raiseDispute(a, 'syn-other-reviewer', keyed(cell(), id));
    const elsewhere = await repo.raiseDispute(b, 'syn-reviewer', keyed(cell(), id));
    expect([mine.created, other.created, elsewhere.created]).toEqual([true, true, true]);
    expect(new Set([mine.record.id, other.record.id, elsewhere.record.id]).size).toBe(3);
  });

  it('survives concurrent repeats: five at once leave one dispute, one note and one ledger event, and all five answer with it', async () => {
    const t = tenant();
    const input = keyed(cell());
    // A trigger that sleeps before the insert holds the window between the look-up and the insert open, so five repeats overlap there instead of by luck.
    await withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query(`CREATE OR REPLACE FUNCTION zz_dispute_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER zz_dispute_sleep BEFORE INSERT ON cell_disputes FOR EACH ROW EXECUTE FUNCTION zz_dispute_sleep()`);
    });
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => repo.raiseDispute(t, 'syn-reviewer', input)));
      expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    } finally {
      await withAdmin(pg.adminUrl, async (c: Client) => {
        await c.query('DROP TRIGGER zz_dispute_sleep ON cell_disputes');
        await c.query('DROP FUNCTION zz_dispute_sleep()');
      });
    }
    expect(await count(t, 'cell_disputes')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(1);
    expect(await count(t, 'ledger_events')).toBe(1);
  });

  it('does not change what the ledger records: the projection of a keyed dispute has the same fields as an unkeyed one and shows no retry identity', async () => {
    const t = tenant();
    const plain = await repo.raiseDispute(t, 'syn-reviewer-a', cell());
    const withId = await repo.raiseDispute(t, 'syn-reviewer-b', keyed(cell()));
    expect(Object.keys(withId.record).sort()).toEqual(Object.keys(plain.record).sort());
    expect(JSON.stringify(withId.record)).not.toMatch(/creation_?request|requestId/i);
  });
});

describe('the table itself', () => {
  it('keeps the id and its fingerprint together, one id per reviewer, and never changes them', async () => {
    const t = tenant();
    const input = keyed(cell());
    const stored = await repo.raiseDispute(t, 'syn-reviewer', input);
    await withAdmin(pg.adminUrl, async (c: Client) => {
      const insert = (id: string | null, hash: string | null) =>
        c.query(
          `INSERT INTO cell_disputes (tenant_id, created_by, ledger_event_id, guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, note_id, creation_request_id, creation_request_hash)
         SELECT tenant_id, created_by, gen_random_uuid(), guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, note_id, $2, $3 FROM cell_disputes WHERE id = $1`,
          [stored.record.id, id, hash],
        );
      await expect(insert(randomUUID(), null)).rejects.toMatchObject({ code: '23514', constraint: 'cell_disputes_creation_request_pair' });
      await expect(insert(null, 'a'.repeat(64))).rejects.toMatchObject({ code: '23514', constraint: 'cell_disputes_creation_request_pair' });
      await expect(insert(randomUUID(), 'not-a-hash')).rejects.toMatchObject({ code: '23514', constraint: 'cell_disputes_creation_request_pair' });
      await expect(insert(input.request!.id, 'a'.repeat(64))).rejects.toMatchObject({ code: '23505', constraint: 'cell_disputes_creation_request_uq' });
      await expect(c.query(`UPDATE cell_disputes SET creation_request_id = gen_random_uuid() WHERE id = $1`, [stored.record.id])).rejects.toThrow();
    });
    expect(await count(t, 'cell_disputes')).toBe(1);
  });
});
