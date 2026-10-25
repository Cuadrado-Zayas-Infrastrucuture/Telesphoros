import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { IntegrityError } from '../../src/storage/errors';
import { PostgresPatientIdentifiersRepository } from '../../src/storage/postgres/patient-identifiers.repository';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { seedLabReport } from '../helpers/ledger-fixtures';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * A deleted patient's identifiers used to stay active: nothing withdrew them, and the active-identifier unique index kept the value, so the same
 * number answered "already registered" for another patient and pointed at a record nobody could see. Deleting a patient now withdraws its active
 * identifiers in the same transaction, by the person who deleted it.
 */
let pg: EphemeralDatabase;
let database: Database;
let patients: PostgresPatientsRepository;
let identifiers: PostgresPatientIdentifiersRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  patients = new PostgresPatientsRepository(database);
  identifiers = new PostgresPatientIdentifiersRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const digest = () => randomBytes(32);
const stamp = () => new Date().toISOString();
async function patient(t: string): Promise<string> {
  const id = randomUUID();
  await patients.insert({ id, tenantId: t, createdBy: 'syn-registrar', label: `SYN-${id.slice(0, 8)}`, createdAt: stamp(), updatedAt: stamp() });
  return id;
}
const add = (t: string, patientId: string, value = digest(), system = 'hospital-a-mrn') => identifiers.add(t, 'syn-registrar', { patientId, system, digest: value, keyVersion: 1 });
const states = (t: string, patientId: string) =>
  owner(
    async (c) =>
      (
        await c.query<{ system: string; status: string; withdrawn_by: string | null }>(
          `SELECT system, status, withdrawn_by FROM patient_identifiers WHERE tenant_id = $1 AND patient_id = $2 ORDER BY seq`,
          [t, patientId],
        )
      ).rows,
  );

describe('deleting a patient (audit: the identifiers of a deleted patient stayed active)', () => {
  it('withdraws its active identifiers, by the person who deleted it, and leaves an earlier withdrawal as it was', async () => {
    const t = tenant();
    const p = await patient(t);
    const earlier = await add(t, p, digest(), 'system-a');
    await identifiers.withdraw(t, 'syn-earlier', p, earlier.id);
    await add(t, p, digest(), 'system-b');
    await add(t, p, digest(), 'system-c');
    expect(await patients.delete(t, p, 'syn-deleter')).toBe(true);
    expect(await states(t, p)).toEqual([
      { system: 'system-a', status: 'withdrawn', withdrawn_by: 'syn-earlier' },
      { system: 'system-b', status: 'withdrawn', withdrawn_by: 'syn-deleter' },
      { system: 'system-c', status: 'withdrawn', withdrawn_by: 'syn-deleter' },
    ]);
  });

  it('lets the same identifier be registered to another patient afterwards', async () => {
    const t = tenant();
    const [gone, other] = [await patient(t), await patient(t)];
    const value = digest();
    await add(t, gone, value);
    await expect(add(t, other, value)).rejects.toMatchObject({ name: 'IdentifierInUseError' }); // before: held by the patient
    await patients.delete(t, gone, 'syn-deleter');
    await expect(add(t, other, value)).resolves.toMatchObject({ patientId: other, status: 'active' });
  });

  it('touches nobody else: another patient of the tenant and another tenant keep theirs', async () => {
    const [t, u] = [tenant(), tenant()];
    const [gone, kept, elsewhere] = [await patient(t), await patient(t), await patient(u)];
    await add(t, gone);
    await add(t, kept);
    await add(u, elsewhere);
    await patients.delete(t, gone, 'syn-deleter');
    expect((await states(t, kept)).map((s) => s.status)).toEqual(['active']);
    expect((await states(u, elsewhere)).map((s) => s.status)).toEqual(['active']);
  });

  it('withdraws nothing when no patient was deleted (unknown id, or already deleted)', async () => {
    const t = tenant();
    const p = await patient(t);
    await add(t, p);
    expect(await patients.delete(t, randomUUID(), 'syn-deleter')).toBe(false);
    await patients.delete(t, p, 'syn-deleter');
    expect(await patients.delete(t, p, 'syn-second')).toBe(false);
    expect((await states(t, p)).map((s) => s.withdrawn_by)).toEqual(['syn-deleter']); // the second call changed nothing
  });

  it('is one transaction: a refused delete leaves the identifiers active', async () => {
    const t = tenant();
    const { patientId: p } = await seedLabReport(pg.adminUrl, t); // a patient with a live report: the soft-delete trigger refuses
    await add(t, p);
    await expect(patients.delete(t, p, 'syn-deleter')).rejects.toBeInstanceOf(IntegrityError);
    expect((await states(t, p)).map((s) => s.status)).toEqual(['active']);
  });

  it('is one transaction the other way round: if withdrawing an identifier fails, the patient is not deleted', async () => {
    const t = tenant();
    const p = await patient(t);
    await add(t, p, digest(), 'system-ok');
    await add(t, p, digest(), 'system-poison');
    await owner(async (c) => {
      await c.query(
        `CREATE FUNCTION syn_refuse_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.system = 'system-poison' THEN RAISE EXCEPTION 'synthetic refusal' USING ERRCODE = 'integrity_constraint_violation'; END IF; RETURN NEW; END $$`,
      );
      await c.query(`CREATE TRIGGER syn_refuse_poison BEFORE UPDATE ON patient_identifiers FOR EACH ROW EXECUTE FUNCTION syn_refuse_poison()`);
    });
    try {
      await expect(patients.delete(t, p, 'syn-deleter')).rejects.toBeDefined();
      expect(await patients.findById(t, p)).toBeDefined(); // still there
      expect((await states(t, p)).map((s) => s.status)).toEqual(['active', 'active']);
    } finally {
      await owner(async (c) => {
        await c.query('DROP TRIGGER syn_refuse_poison ON patient_identifiers');
        await c.query('DROP FUNCTION syn_refuse_poison()');
      });
    }
  });
});
