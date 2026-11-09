import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { sealField } from '../../src/patient-demographics/identity-crypto';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresPatientDemographicsRepository } from '../../src/storage/postgres/patient-demographics.repository';
import { PostgresPatientMedicationsRepository } from '../../src/storage/postgres/patient-medications.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { seedLabReport } from '../helpers/ledger-fixtures';

// Explicit opt-in through --testRegex; no timing threshold and no changes to default test selection.
const tenant = 'syn-patient-read-benchmark';
const actor = 'syn-clinician';
const backgroundPatientsPerTenant = Number(process.env.PATIENT_READ_BACKGROUND_PATIENTS ?? 0);
const cases: { history: number; patient: string; entries: string[] }[] = [];
let pg: EphemeralDatabase;
let db: Database;
let medications: PostgresPatientMedicationsRepository;
let demographics: PostgresPatientDemographicsRepository;
const evidence: Record<string, unknown>[] = [];

beforeAll(async () => {
  if (!process.env.PATIENT_READ_OUTPUT) throw new Error('Set PATIENT_READ_OUTPUT for the opt-in synthetic benchmark.');
  if (!Number.isSafeInteger(backgroundPatientsPerTenant) || backgroundPatientsPerTenant < 0 || backgroundPatientsPerTenant > 100) {
    throw new Error('PATIENT_READ_BACKGROUND_PATIENTS must be an integer from 0 to 100 per tenant.');
  }
  pg = await createEphemeralDatabase();
  db = new Database({ url: pg.appUrl, ssl: 'disable' });
  const ledger = new PostgresLedgerRecordsRepository(db);
  medications = new PostgresPatientMedicationsRepository(db, ledger);
  demographics = new PostgresPatientDemographicsRepository(db, ledger);
  for (const history of [1, 5, 50]) {
    const { patientId: patient } = await seedLabReport(pg.adminUrl, tenant);
    const entries = Array.from({ length: 20 }, () => randomUUID());
    cases.push({ history, patient, entries });
    const key = Buffer.alloc(32, 23); // synthetic fixture material only; never emitted
    const binding = { tenant, patient, keyVersion: 1 };
    for (let version = 1; version <= history; version++) {
      await demographics.insertVersion(tenant, actor, {
        id: randomUUID(),
        patientId: patient,
        keyVersion: 1,
        givenName: sealField(key, binding, 'given_name', 'Synthetic'),
        familyName: sealField(key, binding, 'family_name', 'Read-Benchmark'),
        dateOfBirth: sealField(key, binding, 'date_of_birth', '1980-01-01'),
        sex: 'female',
        birthYear: 1980,
        ethnicity: ['white'],
        ...(version === 1 ? { newKey: { keyVersion: 1, wrapped: Buffer.alloc(61, 24), provider: 'local' } } : {}),
      });
      for (let index = 0; index < entries.length; index++) {
        await medications.insertVersion(tenant, actor, {
          id: randomUUID(),
          entryId: entries[index]!,
          patientId: patient,
          name: `SYN-ingredient-${String(index).padStart(2, '0')}`,
          requestHash: 'a'.repeat(64),
          input: {
            requestId: randomUUID(),
            rxcui: String(991001 + index),
            listVersion: 'a'.repeat(64),
            status: index < 16 ? 'active' : 'stopped',
            source: 'clinician-entered',
            startMonth: '2026-01',
            stopMonth: index < 16 ? null : '2026-02',
            ...(version > 1 ? { entryId: entries[index]!, expectedVersion: version - 1 } : {}),
          },
        });
      }
    }
    key.fill(0);
  }
  const other = await seedLabReport(pg.adminUrl, 'syn-patient-read-other');
  await medications.insertVersion('syn-patient-read-other', actor, {
    id: randomUUID(),
    entryId: randomUUID(),
    patientId: other.patientId,
    name: 'SYN-other',
    requestHash: 'a'.repeat(64),
    input: { requestId: randomUUID(), rxcui: '991001', listVersion: 'a'.repeat(64), status: 'active', source: 'clinician-entered', startMonth: null, stopMonth: null },
  });
  // Keep target histories selective among both same-tenant and foreign-tenant rows.
  for (const backgroundTenant of [tenant, 'syn-patient-read-other']) {
    for (let patientIndex = 0; patientIndex < backgroundPatientsPerTenant; patientIndex++) {
      const { patientId } = await seedLabReport(pg.adminUrl, backgroundTenant);
      for (let entryIndex = 0; entryIndex < 20; entryIndex++) {
        const entryId = randomUUID();
        for (let version = 1; version <= 5; version++) {
          await medications.insertVersion(backgroundTenant, actor, {
            id: randomUUID(),
            entryId,
            patientId,
            name: `SYN-background-${entryIndex}`,
            requestHash: 'a'.repeat(64),
            input: {
              requestId: randomUUID(),
              rxcui: String(991001 + entryIndex),
              listVersion: 'a'.repeat(64),
              status: 'active',
              source: 'clinician-entered',
              startMonth: null,
              stopMonth: null,
              ...(version > 1 ? { entryId, expectedVersion: version - 1 } : {}),
            },
          });
        }
      }
    }
  }
  await withAdmin(pg.adminUrl, (client) => client.query('ANALYZE'));
}, 120_000);

afterAll(async () => {
  try {
    if (pg && process.env.PATIENT_READ_OUTPUT) {
      const facts = await withAdmin(pg.adminUrl, async (client) => ({
        postgres: (await client.query('SHOW server_version')).rows[0].server_version,
        rows: (
          await client.query(`SELECT 'patient_medications' AS relation, count(*)::int AS rows FROM patient_medications
          UNION ALL SELECT 'patient_demographics', count(*)::int FROM patient_demographics`)
        ).rows,
      }));
      writeFileSync(
        process.env.PATIENT_READ_OUTPUT,
        JSON.stringify(
          {
            facts,
            fixture: { backgroundPatientsPerTenant, backgroundTenants: 2, backgroundEntriesPerPatient: 20, backgroundVersionsPerEntry: 5 },
            node: process.version,
            role: 'restricted application; real migrations/RLS/ledger',
            cache: 'first measured read follows fixture writes and ANALYZE; then 25 warm reads; no server/OS cache eviction',
            evidence,
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    await db?.onModuleDestroy();
    await pg?.drop();
  }
});

function sanitizedPlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedPlan);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['Filter', 'One-Time Filter', 'Index Cond', 'Recheck Cond', 'Output', 'Function Call'].includes(key))
      .map(([key, child]) => [key, sanitizedPlan(child)]),
  );
}

async function measure(label: string, work: () => Promise<unknown>) {
  const elapsed: number[] = [];
  let result: unknown;
  for (let index = 0; index <= 25; index++) {
    const start = performance.now();
    result = await work();
    elapsed.push(performance.now() - start);
  }
  const spy = jest.spyOn(Client.prototype, 'query'); // pass-through observer, not a dependency substitute
  let statements: [string, unknown[]][];
  try {
    await work();
    statements = spy.mock.calls.flatMap((args) => {
      const [sql, parameters] = args as unknown as [unknown, unknown[]];
      return typeof sql === 'string' && /^\s*(SELECT|WITH)\b/i.test(sql) && !sql.includes('set_config') ? [[sql, parameters ?? []] as [string, unknown[]]] : [];
    });
  } finally {
    spy.mockRestore();
  }
  const plans = [];
  for (const [sql, parameters] of statements!) {
    const answer = await db.withTenant(tenant, (client) => client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, parameters));
    plans.push({ sqlSha256: createHash('sha256').update(sql).digest('hex'), plan: sanitizedPlan(answer.rows[0]['QUERY PLAN']) });
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(result)); // only a count is retained, never values or ciphertext
  evidence.push({ label, firstMs: elapsed[0], warmMs: elapsed.slice(1), encodedRepositoryBytes: encodedBytes, plans });
  return result;
}

it('measures actual patient reads with ordinary and extended synthetic histories', async () => {
  for (const { history, patient, entries } of cases) {
    const current = await measure(`medications/current/${history}`, () => medications.read(tenant, patient, {}));
    expect(current).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        expect.objectContaining({
          entryId: entries[index],
          name: `SYN-ingredient-${String(index).padStart(2, '0')}`,
          version: history,
          current: true,
          status: index < 16 ? 'active' : 'stopped',
        }),
      ),
    );
    const historical = await measure(`medications/history/${history}`, () => medications.read(tenant, patient, { entryId: entries[0], version: 1 }));
    expect(historical).toEqual([expect.objectContaining({ entryId: entries[0], version: 1, current: history === 1 })]);
    const versions = await measure(`demographics/versions/${history}`, () => demographics.versions(tenant, patient));
    expect(versions).toHaveLength(history);
    const coded = await measure(`demographics/coded/${history}`, async () => [...(await demographics.codedFor(tenant, [patient])).values()]);
    expect(coded).toEqual([{ version: history, sex: 'female', birthYear: 1980, ethnicity: ['white'] }]);
    expect(await medications.read('syn-patient-read-other', patient, {})).toEqual([]);
    expect(await demographics.versions('syn-patient-read-other', patient)).toEqual([]);
  }
}, 60_000);
