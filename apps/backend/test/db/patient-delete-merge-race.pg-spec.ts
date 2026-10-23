import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { Database } from '../../src/db/database';
import { MergeRefusedError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Deleting a patient while a merge into that patient is being approved. The service checks "was anything merged into this patient?" in one
 * transaction and deletes in another, and the merge decision is checked at COMMIT without holding the patient rows, so the two could both
 * succeed and leave a merge in force into a patient that is gone. Each test pins one interleaving with a gate placed just before the commit.
 */
let pg: EphemeralDatabase;
let database: Database;
let ledger: PostgresLedgerRecordsRepository;
let patients: PostgresPatientsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  ledger = new PostgresLedgerRecordsRepository(database);
  patients = new PostgresPatientsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});
afterEach(() => jest.restoreAllMocks());

const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
async function patient(t: string): Promise<string> {
  const id = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, `SYN-${randomUUID().slice(0, 8)}`]));
  return id;
}
const propose = (t: string, source: string, target: string) => ledger.insertMergeProposal(t, 'syn-proposer', { kind: 'merge', sourcePatientId: source, targetPatientId: target, reasonCode: 'entered-twice' });
const approve = (t: string, proposalId: string) => ledger.insertMergeDecision(t, 'syn-decider', { proposalId, decision: 'approved' });
const mergedInto = (t: string, id: string) => owner(async (c) => (await c.query<{ id: string | null }>(`SELECT patient_merged_into($1, $2::uuid)::text AS id`, [t, id])).rows[0]?.id ?? null);
const isDeleted = (id: string) => owner(async (c) => (await c.query<{ gone: boolean }>(`SELECT deleted_at IS NOT NULL AS gone FROM patients WHERE id = $1`, [id])).rows[0]!.gone);
const sleep = (ms: number) => new Promise<'timer'>((resolve) => setTimeout(() => resolve('timer'), ms));
/** Pauses the next unit of work after it has done everything except commit, runs `before`, and resumes when the returned function is called. */
function pauseBeforeCommit(before: (client: PoolClient) => Promise<void> = async () => undefined) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  jest.spyOn(Database.prototype as unknown as { authorityStillCurrent(c: PoolClient, t: string): Promise<boolean> }, 'authorityStillCurrent').mockImplementationOnce(async (client) => {
    await before(client);
    reached();
    await gate;
    return true;
  });
  return { arrived, release };
}
/** The invariant: a merge in force into a patient that has been deleted must never exist. */
async function expectConsistent(t: string, source: string, target: string) {
  const mergedIntoTarget = (await mergedInto(t, source)) === target;
  expect({ mergeInForce: mergedIntoTarget, targetDeleted: await isDeleted(target) }).not.toEqual({ mergeInForce: true, targetDeleted: true });
}

describe('deleting a patient that others are being merged into', () => {
  it('refuses the delete in the database even when the earlier "nothing merged into it" check had passed', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, a, b);
    expect(await patients.hasMergedRecords(t, b)).toBe(false); // what the service asked first
    await approve(t, p.record.id); // a merge lands in the gap before the service deletes
    await expect(patients.delete(t, b)).rejects.toMatchObject({ reason: 'patient-has-merged-records' });
    expect(await isDeleted(b)).toBe(false);
    expect(await mergedInto(t, a)).toBe(b);
  });

  it('approval checked first, delete arriving before the approval commits: one of the two is refused', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, a, b);
    // The approval has written its ledger event and run every commit-time rule (both patients live), and is about to commit; whatever locks
    // those rules took are held until it does.
    const hold = pauseBeforeCommit((client) => client.query('SET CONSTRAINTS ALL IMMEDIATE').then(() => undefined));
    const approving = approve(t, p.record.id).then(() => 'approved' as const, (error: unknown) => error);
    await hold.arrived;
    const deleting = patients.delete(t, b).then(() => 'deleted' as const, (error: unknown) => error);
    await Promise.race([deleting, sleep(1500)]); // before the fix the delete commits here; after it, it waits for the approval
    hold.release();
    const [approval, deletion] = await Promise.all([approving, deleting]);
    expect([approval, deletion].filter((r) => r === 'approved' || r === 'deleted')).toHaveLength(1);
    await expectConsistent(t, a, b);
  });

  it('delete done but not committed, approval arriving: the approval is refused as patient-gone or waits and is refused', async () => {
    const t = tenant();
    const [a, b] = [await patient(t), await patient(t)];
    const p = await propose(t, a, b);
    const hold = pauseBeforeCommit();
    const deleting = patients.delete(t, b).then(() => 'deleted' as const, (error: unknown) => error);
    await hold.arrived; // the row is updated, the delete has not committed
    const approving = approve(t, p.record.id).then(() => 'approved' as const, (error: unknown) => error);
    await Promise.race([approving, sleep(1500)]); // before the fix the approval commits here; after it, it waits for the delete
    hold.release();
    const [deletion, approval] = await Promise.all([deleting, approving]);
    expect(deletion).toBe('deleted');
    expect(approval).toBeInstanceOf(MergeRefusedError);
    expect(approval).toMatchObject({ reason: 'patient-gone' });
    await expectConsistent(t, a, b);
  });
});
