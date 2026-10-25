import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { IdentifierInUseError, IdentifierRequestReusedError } from '../../src/storage/patient-identifiers.repository';
import { PostgresPatientIdentifiersRepository } from '../../src/storage/postgres/patient-identifiers.repository';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/** Audit item 25: a retry of POST /patients/:id/identifiers. The same request id from the same person replays the identifier; another body under it is refused. */
let pg: EphemeralDatabase;
let first: Database;
let second: Database;
let identifiers: PostgresPatientIdentifiersRepository;
let otherPool: PostgresPatientIdentifiersRepository;
let patients: PostgresPatientsRepository;
const actor = 'syn-clinician';
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  first = new Database({ url: pg.appUrl, ssl: 'disable' });
  second = new Database({ url: pg.appUrl, ssl: 'disable' });
  identifiers = new PostgresPatientIdentifiersRepository(first);
  otherPool = new PostgresPatientIdentifiersRepository(second);
  patients = new PostgresPatientsRepository(first);
});
afterAll(async () => {
  await first?.onModuleDestroy();
  await second?.onModuleDestroy();
  await pg?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
async function patient(t: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await patients.insert({ id, tenantId: t, createdBy: 'syn-registrar', label: `SYN-${id.slice(0, 8)}`, createdAt: now, updatedAt: now });
  return id;
}
const input = (patientId: string, over: Record<string, unknown> = {}) => ({
  patientId,
  system: 'hospital-a-mrn',
  digest: randomBytes(32),
  keyVersion: 1,
  request: { id: randomUUID(), hash: 'a'.repeat(64) },
  ...over,
});
const rowsFor = (t: string, requestId: string) =>
  owner(async (c) => (await c.query(`SELECT id::text AS id FROM patient_identifiers WHERE tenant_id = $1 AND creation_request_id = $2`, [t, requestId])).rows);

describe('PostgresPatientIdentifiersRepository.add with a retry id', () => {
  it('stores one identifier however many times, from however many pools, the same request arrives at once', async () => {
    const t = tenant();
    const body = input(await patient(t));
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? identifiers : otherPool).add(t, actor, body)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rowsFor(t, body.request.id)).toEqual([{ id: results[0]!.id }]);
  });

  it('stores one identifier when two repeats are both past the look-up before either has written (a sleeping trigger opens the window every time)', async () => {
    const t = tenant();
    const body = input(await patient(t));
    await owner(async (c) => {
      await c.query(`CREATE FUNCTION syn_slow_identifier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER syn_slow_identifier BEFORE INSERT ON patient_identifiers FOR EACH ROW EXECUTE FUNCTION syn_slow_identifier()`);
    });
    try {
      const results = await Promise.all([identifiers.add(t, actor, body), otherPool.add(t, actor, body)]);
      expect(results[0]!.id).toBe(results[1]!.id);
      expect(await rowsFor(t, body.request.id)).toHaveLength(1);
    } finally {
      await owner(async (c) => {
        await c.query('DROP TRIGGER syn_slow_identifier ON patient_identifiers');
        await c.query('DROP FUNCTION syn_slow_identifier()');
      });
    }
  });

  it('replays the stored identifier, and also after it was withdrawn (the record says so)', async () => {
    const t = tenant();
    const p = await patient(t);
    const body = input(p);
    const made = await identifiers.add(t, actor, body);
    await identifiers.withdraw(t, actor, p, made.id);
    expect(await identifiers.add(t, actor, body)).toMatchObject({ id: made.id, status: 'withdrawn' });
  });

  it('refuses the same request id with a different original body', async () => {
    const t = tenant();
    const body = input(await patient(t));
    await identifiers.add(t, actor, body);
    await expect(identifiers.add(t, actor, { ...body, digest: randomBytes(32), request: { id: body.request.id, hash: 'b'.repeat(64) } })).rejects.toBeInstanceOf(
      IdentifierRequestReusedError,
    );
  });

  it("keeps one person's request ids apart from another's", async () => {
    const t = tenant();
    const body = input(await patient(t));
    const a = await identifiers.add(t, 'syn-a', body);
    const b = await identifiers.add(t, 'syn-b', { ...body, digest: randomBytes(32) });
    expect(a.id).not.toBe(b.id);
  });

  it('still refuses a number another patient holds, under a new request id, and records the possible duplicate', async () => {
    const t = tenant();
    const [holder, other] = [await patient(t), await patient(t)];
    const taken = input(holder);
    await identifiers.add(t, actor, taken);
    await expect(identifiers.add(t, actor, input(other, { digest: taken.digest }))).rejects.toBeInstanceOf(IdentifierInUseError);
    expect((await owner((c) => c.query('SELECT 1 FROM patient_duplicate_flags WHERE tenant_id = $1', [t]))).rowCount).toBe(1);
  });

  it('without a request id behaves as before: the same number for the same patient is refused', async () => {
    const t = tenant();
    const p = await patient(t);
    const body = input(p, { request: undefined });
    await identifiers.add(t, actor, body);
    await expect(identifiers.add(t, actor, body)).rejects.toBeInstanceOf(IdentifierInUseError);
  });
});

describe('the retry identity of an identifier', () => {
  it('cannot be changed once stored, and an id needs its hash and the reverse', async () => {
    const t = tenant();
    const body = input(await patient(t));
    await identifiers.add(t, actor, body);
    await expect(owner((c) => c.query(`UPDATE patient_identifiers SET creation_request_id = gen_random_uuid() WHERE creation_request_id = $1`, [body.request.id]))).rejects.toThrow(
      /retry identity/,
    );
    await expect(
      owner((c) =>
        c.query(
          `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, created_by, creation_request_id) VALUES ($1, $2, 'x', $3, 'syn', gen_random_uuid())`,
          [t, body.patientId, randomBytes(32)],
        ),
      ),
    ).rejects.toThrow(/patient_identifiers_creation_request_pair/);
  });
});
