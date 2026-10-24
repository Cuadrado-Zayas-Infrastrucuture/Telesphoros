import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { MergeRefusedError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Audit item 14: the check for an undecided proposal for the same pair ran, then the insert, in one READ COMMITTED transaction, with nothing between
 * them to stop a second proposer reading the same empty state. A synthetic trigger (test only) sleeps inside the insert so that both calls are past
 * the check before either has written.
 */
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  await owner(async (c) => {
    await c.query(`CREATE FUNCTION syn_slow_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`);
    await c.query(`CREATE TRIGGER syn_slow_proposal BEFORE INSERT ON patient_merge_proposals FOR EACH ROW EXECUTE FUNCTION syn_slow_proposal()`);
  });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
async function patient(t: string): Promise<string> {
  const id = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, `SYN-${id.slice(0, 8)}`]));
  return id;
}
const propose = (t: string, by: string, source: string, target: string) =>
  repo.insertMergeProposal(t, by, { kind: 'merge', sourcePatientId: source, targetPatientId: target, reasonCode: 'entered-twice' });
const proposalCount = (t: string, source: string, target: string) =>
  owner(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_merge_proposals WHERE tenant_id = $1 AND source_patient_id = $2 AND target_patient_id = $3`, [t, source, target])).rows[0]!.n);

describe('two proposals for the same pair at the same time', () => {
  it('lets one in and refuses the other as pending', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const results = await Promise.allSettled([propose(t, 'syn-proposer-1', a, b), propose(t, 'syn-proposer-2', a, b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(MergeRefusedError);
    expect(refused.reason).toMatchObject({ reason: 'proposal-pending' });
    expect(await proposalCount(t, a, b)).toBe(1);
  });

  it('does not make unrelated proposals wait for each other (control: different targets both go in)', async () => {
    const t = tenant();
    const [a, b, c] = [await patient(t), await patient(t), await patient(t)];
    const started = Date.now();
    const results = await Promise.allSettled([propose(t, 'syn-proposer-1', a, b), propose(t, 'syn-proposer-2', a, c)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(Date.now() - started).toBeLessThan(1600); // overlapped, not queued behind each other's sleep
  });

  it('still refuses a second proposal made after the first has committed (control)', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    await propose(t, 'syn-proposer-1', a, b);
    await expect(propose(t, 'syn-proposer-2', a, b)).rejects.toMatchObject({ reason: 'proposal-pending' });
  });
});
