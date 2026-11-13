import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import type { PatientRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';

/**
 * Spec 040, PS-7: the search text is a bound parameter and matches only itself. The repository is called directly, past the API's schema, with
 * the characters the schema refuses, so a `LIKE` with an unescaped pattern, or text spliced into the statement, would show here.
 */
let pg: EphemeralDatabase;
let db: Database;
let patients: PostgresPatientsRepository;
const tenant = 'tenant-patient-search';
const page = { offset: 0, limit: 20 };

function record(label: string): PatientRecord {
  const now = new Date().toISOString();
  return { id: randomUUID(), tenantId: tenant, createdBy: 'syn-clinician', label, createdAt: now, updatedAt: now };
}

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  db = new Database({ url: pg.appUrl, ssl: 'disable' });
  patients = new PostgresPatientsRepository(db);
  for (const label of ['SYN-1', 'SYN-2', 'SYN-A1']) await patients.insert(record(label));
});
afterAll(async () => {
  await db?.onModuleDestroy();
  await pg?.drop();
});

it('matches the text literally: a wildcard, an underscore, a quote and a backslash find nothing, and nothing fails', async () => {
  for (const text of ['%', '_', "'", '\\', "SYN-1' OR '1'='1", 'SYN_1', '%1']) {
    const result = await patients.list(tenant, page, { labelContains: text });
    expect({ text, total: result.total, items: result.items.length }).toEqual({ text, total: 0, items: 0 });
  }
});

it('control: the same repository finds what the text spells', async () => {
  expect((await patients.list(tenant, page, { labelContains: 'syn-' })).total).toBe(3);
  expect((await patients.list(tenant, page, { labelContains: '1' })).items.map((p) => p.label)).toEqual(['SYN-1', 'SYN-A1']);
  expect((await patients.list(tenant, page)).total).toBe(3);
});
