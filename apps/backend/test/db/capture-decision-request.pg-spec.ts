import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { CaptureDecisionRequestReusedError } from '../../src/storage/ledger-records.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

/**
 * Audit item 1 of the inherited list: a retried capture decision made a second acceptance row, and the evaluation made from the first was no longer built on the
 * newest decision. Same cure as the report, patient, identifier and invitation creates: an optional retry identity per reviewer with a fingerprint of the original request.
 */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
const tenant = () => `tenant-${randomUUID()}`;
const fingerprint = (captureId: string, decision: string, note?: string) =>
  createHash('sha256')
    .update(JSON.stringify([captureId, decision, note ?? null]))
    .digest('hex');

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

async function captured(tenantId: string) {
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const stored = await repo.insertCapture(tenantId, report.uploader, capture);
  return { report, capture, captureId: stored.record.id };
}

describe('a capture decision with a retry identity', () => {
  it('replays: the same reviewer, id and fingerprint get the decision already stored, and nothing is written twice', async () => {
    const t = tenant();
    const { capture, captureId } = await captured(t);
    const request = { id: randomUUID(), hash: fingerprint(captureId, 'accepted', 'checked') };
    const first = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { note: 'checked', request }));
    const again = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { note: 'checked', request }));
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.record.id).toBe(first.record.id);
    expect(await count(t, 'capture_acceptances')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(1);
    expect(await count(t, 'ledger_events')).toBe(2); // the capture and the one decision
  });

  it('does not make the evaluation stale: accept, evaluate, repeat the accept, and the evaluation still stands on the newest decision', async () => {
    const t = tenant();
    const { report, capture, captureId } = await captured(t);
    const request = { id: randomUUID(), hash: fingerprint(captureId, 'accepted') };
    const accepted = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { request }));
    const evaluation = await repo.insertEvaluation(t, 'syn-system', evaluationFor(report, captureId, accepted.record.id));
    const replay = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { request }));
    expect(replay.record.id).toBe(accepted.record.id);
    expect((await repo.latestAcceptance(t, captureId))?.id).toBe(accepted.record.id);
    const context = (await repo.evaluationContexts(t, [evaluation.record.id])).get(evaluation.record.id);
    expect(context?.acceptance).toMatchObject({ id: accepted.record.id, decision: 'accepted', current: true });
  });

  it('control: a repeat WITHOUT a retry id is a new decision, as before (the evaluation then stands on an older one)', async () => {
    const t = tenant();
    const { report, capture, captureId } = await captured(t);
    const accepted = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture));
    const evaluation = await repo.insertEvaluation(t, 'syn-system', evaluationFor(report, captureId, accepted.record.id));
    const second = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture));
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(accepted.record.id);
    const context = (await repo.evaluationContexts(t, [evaluation.record.id])).get(evaluation.record.id);
    expect(context?.acceptance).toMatchObject({ id: accepted.record.id, current: false });
  });

  it('refuses the same id with a different decision, note or capture, and writes nothing', async () => {
    const t = tenant();
    const { capture, captureId } = await captured(t);
    const id = randomUUID();
    await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { request: { id, hash: fingerprint(captureId, 'accepted') } }));
    const different = [
      acceptanceFor(captureId, capture, { decision: 'rejected', request: { id, hash: fingerprint(captureId, 'rejected') } }),
      acceptanceFor(captureId, capture, { note: 'other', request: { id, hash: fingerprint(captureId, 'accepted', 'other') } }),
      acceptanceFor(captureId, capture, { request: { id, hash: fingerprint(randomUUID(), 'accepted') } }),
    ];
    for (const input of different) await expect(repo.insertAcceptance(t, 'syn-reviewer', input)).rejects.toBeInstanceOf(CaptureDecisionRequestReusedError);
    expect(await count(t, 'capture_acceptances')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(0); // the refused attempts left no note behind
  });

  it('is per reviewer and per organization: another reviewer, or another organization, can use the same id', async () => {
    const a = tenant();
    const b = tenant();
    const one = await captured(a);
    const two = await captured(b);
    const id = randomUUID();
    const mine = await repo.insertAcceptance(a, 'syn-reviewer', acceptanceFor(one.captureId, one.capture, { request: { id, hash: fingerprint(one.captureId, 'accepted') } }));
    const other = await repo.insertAcceptance(
      a,
      'syn-other-reviewer',
      acceptanceFor(one.captureId, one.capture, { request: { id, hash: fingerprint(one.captureId, 'accepted') } }),
    );
    const elsewhere = await repo.insertAcceptance(b, 'syn-reviewer', acceptanceFor(two.captureId, two.capture, { request: { id, hash: fingerprint(two.captureId, 'accepted') } }));
    expect([mine.created, other.created, elsewhere.created]).toEqual([true, true, true]);
    expect(new Set([mine.record.id, other.record.id, elsewhere.record.id]).size).toBe(3);
  });

  it('survives concurrent repeats: five at once leave one decision, one note and one ledger event, and all five answer with it', async () => {
    const t = tenant();
    const { capture, captureId } = await captured(t);
    const request = { id: randomUUID(), hash: fingerprint(captureId, 'accepted', 'checked') };
    // A trigger that sleeps before the insert holds the window between the look-up and the insert open, so five repeats overlap there instead of by luck.
    await withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query(`CREATE OR REPLACE FUNCTION zz_capture_decision_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER zz_capture_decision_sleep BEFORE INSERT ON capture_acceptances FOR EACH ROW EXECUTE FUNCTION zz_capture_decision_sleep()`);
    });
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { note: 'checked', request }))));
      expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    } finally {
      await withAdmin(pg.adminUrl, async (c: Client) => {
        await c.query('DROP TRIGGER zz_capture_decision_sleep ON capture_acceptances');
        await c.query('DROP FUNCTION zz_capture_decision_sleep()');
      });
    }
    expect(await count(t, 'capture_acceptances')).toBe(1);
    expect(await count(t, 'event_notes')).toBe(1);
    expect(await count(t, 'ledger_events')).toBe(2);
  });

  it('does not change what the ledger records: the projection of a keyed decision has the same fields as an unkeyed one and shows no retry identity', async () => {
    const t = tenant();
    const { capture, captureId } = await captured(t);
    const plain = await repo.insertAcceptance(t, 'syn-reviewer-a', acceptanceFor(captureId, capture));
    const keyed = await repo.insertAcceptance(t, 'syn-reviewer-b', acceptanceFor(captureId, capture, { request: { id: randomUUID(), hash: fingerprint(captureId, 'accepted') } }));
    expect(Object.keys(keyed.record).sort()).toEqual(Object.keys(plain.record).sort());
    expect(JSON.stringify(keyed.record)).not.toMatch(/creation_?request|requestId/i);
  });
});

describe('the table itself', () => {
  it('keeps the id and its fingerprint together, one id per reviewer, and never changes them', async () => {
    const t = tenant();
    const { capture, captureId } = await captured(t);
    const request = { id: randomUUID(), hash: fingerprint(captureId, 'accepted') };
    const stored = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(captureId, capture, { request }));
    await withAdmin(pg.adminUrl, async (c: Client) => {
      const insert = (id: string | null, hash: string | null, who = 'syn-reviewer') =>
        c.query(
          `INSERT INTO capture_acceptances (tenant_id, created_by, ledger_event_id, capture_id, decision, text_sha256, poppler_version, creation_request_id, creation_request_hash)
         VALUES ($1, $2, gen_random_uuid(), $3, 'accepted', $4, $5, $6, $7)`,
          [t, who, captureId, capture.textSha256, capture.popplerVersion, id, hash],
        );
      await expect(insert(randomUUID(), null)).rejects.toMatchObject({ code: '23514', constraint: 'capture_acceptances_creation_request_pair' });
      await expect(insert(null, 'a'.repeat(64))).rejects.toMatchObject({ code: '23514', constraint: 'capture_acceptances_creation_request_pair' });
      await expect(insert(randomUUID(), 'not-a-hash')).rejects.toMatchObject({ code: '23514', constraint: 'capture_acceptances_creation_request_pair' });
      await expect(insert(request.id, 'a'.repeat(64))).rejects.toMatchObject({ code: '23505', constraint: 'capture_acceptances_creation_request_uq' });
      await expect(c.query(`UPDATE capture_acceptances SET creation_request_id = gen_random_uuid() WHERE id = $1`, [stored.record.id])).rejects.toThrow();
    });
    expect(await count(t, 'capture_acceptances')).toBe(1);
  });
});
