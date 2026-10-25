import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { IntegrityError } from '../../src/storage/errors';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import type { PatientRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/** Audit item 25: a retry of POST /patients. The same request id from the same person replays the patient; a different body under it is refused. */
let pg: EphemeralDatabase;
let first: Database;
let second: Database;
let patients: PostgresPatientsRepository;
let otherPool: PostgresPatientsRepository;
const tenant = 'tenant-patient-registration';
const actor = 'syn-clinician';
const hash = (label: string) =>
  label
    .padEnd(64, 'a')
    .replace(/[^0-9a-f]/g, 'a')
    .slice(0, 64);
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  first = new Database({ url: pg.appUrl, ssl: 'disable' });
  second = new Database({ url: pg.appUrl, ssl: 'disable' });
  patients = new PostgresPatientsRepository(first);
  otherPool = new PostgresPatientsRepository(second);
});
afterAll(async () => {
  await first?.onModuleDestroy();
  await second?.onModuleDestroy();
  await pg?.drop();
});

function record(over: Partial<PatientRecord> = {}): PatientRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: tenant,
    createdBy: actor,
    label: `SYN-${randomUUID().slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    creationRequestId: randomUUID(),
    creationRequestHash: hash('a'),
    ...over,
  };
}
const rowsFor = (requestId: string) =>
  withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT id::text AS id FROM patients WHERE tenant_id = $1 AND creation_request_id = $2`, [tenant, requestId])).rows);

describe('PostgresPatientsRepository.insertOrReplay', () => {
  it('stores one patient however many times, and from however many pools, the same request arrives at once', async () => {
    const input = record();
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? patients : otherPool).insertOrReplay({ ...input, id: randomUUID() })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await rowsFor(input.creationRequestId!)).toEqual([{ id: results[0]!.id }]);
  });

  it('replays the stored patient for the same request id, even after its label was changed', async () => {
    const input = record();
    const created = await patients.insertOrReplay(input);
    await patients.update({ ...created, label: `${created.label}-X`, updatedAt: new Date().toISOString() });
    expect(await patients.insertOrReplay({ ...input, id: randomUUID() })).toMatchObject({ id: created.id, label: `${input.label}-X` });
  });

  it('refuses the same request id with a different original body', async () => {
    const input = record();
    await patients.insertOrReplay(input);
    await expect(patients.insertOrReplay({ ...input, id: randomUUID(), label: `${input.label}-2`, creationRequestHash: hash('b') })).rejects.toBeInstanceOf(IntegrityError);
  });

  it("keeps one person's request ids apart from another's", async () => {
    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      patients.insertOrReplay(record({ creationRequestId: requestId, createdBy: 'syn-a' })),
      patients.insertOrReplay(record({ creationRequestId: requestId, createdBy: 'syn-b' })),
    ]);
    expect(a.id).not.toBe(b.id);
  });

  it('does not replay a deleted patient: the id stays reserved and the retry is refused', async () => {
    const input = record();
    const created = await patients.insertOrReplay(input);
    await withAdmin(pg.adminUrl, (c) => c.query('UPDATE patients SET deleted_at = now() WHERE id = $1', [created.id])); // a soft delete, whichever way the application does it
    await expect(patients.insertOrReplay({ ...input, id: randomUUID() })).rejects.toBeInstanceOf(IntegrityError);
  });

  it('still refuses a label another patient already has, under a new request id', async () => {
    const taken = record({ creationRequestId: undefined, creationRequestHash: undefined });
    await patients.insert(taken);
    await expect(patients.insertOrReplay(record({ label: taken.label.toLowerCase() }))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('finds a patient by its request id, for this person only', async () => {
    const input = record();
    const created = await patients.insertOrReplay(input);
    expect(await patients.findByRequest(tenant, actor, input.creationRequestId!)).toMatchObject({ id: created.id, creationRequestHash: input.creationRequestHash });
    expect(await patients.findByRequest(tenant, 'syn-someone-else', input.creationRequestId!)).toBeUndefined();
    expect(await patients.findByRequest('another-tenant', actor, input.creationRequestId!)).toBeUndefined();
  });
});

describe('the retry identity of a patient', () => {
  it('cannot be changed once stored, and a request id needs its hash and the reverse', async () => {
    const input = record();
    await patients.insertOrReplay(input);
    await expect(
      withAdmin(pg.adminUrl, (c) => c.query(`UPDATE patients SET creation_request_id = gen_random_uuid() WHERE creation_request_id = $1`, [input.creationRequestId])),
    ).rejects.toThrow(/retry identity/);
    await expect(
      withAdmin(pg.adminUrl, (c) =>
        c.query(`INSERT INTO patients (tenant_id, created_by, label, creation_request_id) VALUES ($1, $2, 'SYN-NOHASH', gen_random_uuid())`, [tenant, actor]),
      ),
    ).rejects.toThrow(/patients_creation_request_pair/);
  });

  it('is not needed: a patient made without one is as before', async () => {
    const plain = record({ creationRequestId: undefined, creationRequestHash: undefined });
    await patients.insert(plain);
    expect(await patients.findById(tenant, plain.id)).toMatchObject({ id: plain.id, label: plain.label });
  });
});
