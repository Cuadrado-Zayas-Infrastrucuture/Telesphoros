import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresPatientMedicationsRepository } from '../../src/storage/postgres/patient-medications.repository';
import type { NewMedication } from '../../src/storage/patient-medications.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { seedLabReport } from '../helpers/ledger-fixtures';
import { attempt } from '../helpers/ledger-sql';
const ACTOR = 'SYN-clinician';
(process.env.TEST_DATABASE_URL ? describe : describe.skip)('patient medication database protections', () => {
  let db: EphemeralDatabase;
  let database: Database;
  let repository: PostgresPatientMedicationsRepository;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
    repository = new PostgresPatientMedicationsRepository(database, new PostgresLedgerRecordsRepository(database));
  }, 60_000);
  afterAll(async () => {
    await database?.onModuleDestroy();
    await db?.drop();
  });
  async function world() {
    const tenant = `SYN-${randomUUID()}`;
    const { patientId } = await seedLabReport(db.adminUrl, tenant);
    const input: NewMedication = {
      id: randomUUID(),
      entryId: randomUUID(),
      patientId,
      name: 'syn-ingredient',
      requestHash: 'a'.repeat(64),
      input: { requestId: randomUUID(), rxcui: '991001', listVersion: 'a'.repeat(64), status: 'active', startMonth: null, stopMonth: null, source: 'clinician-entered' },
    };
    return { tenant, input };
  }
  const raw = (input: NewMedication, tenant: string, over: Record<string, unknown> = {}) => ({
    id: input.id,
    entry_id: input.entryId,
    patient_id: input.patientId,
    tenant_id: tenant,
    created_by: ACTOR,
    ledger_event_id: randomUUID(),
    version: 1,
    drug_rxcui: input.input.rxcui,
    drug_name: input.name,
    list_version: input.input.listVersion,
    status: input.input.status,
    start_month: null,
    stop_month: null,
    source: input.input.source,
    creation_request_id: input.input.requestId,
    creation_request_hash: input.requestHash,
    ...over,
  });
  const insert = async (client: Client, data: Record<string, unknown>) => {
    const keys = Object.keys(data);
    await client.query(
      `INSERT INTO patient_medications (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map((k) => data[k]),
    );
  };
  it('does not commit a version without its matching ledger event', async () => {
    const { tenant, input } = await world();
    const failure = await attempt(db.appUrl, tenant, ACTOR, (c) => insert(c, raw(input, tenant)));
    expect(failure?.code).toMatch(/^23/);
    expect((await withAdmin(db.adminUrl, (c) => c.query('SELECT id FROM patient_medications WHERE id=$1', [input.id]))).rows).toEqual([]);
  });
  it.each([
    ['status', { status: 'unknown' }, 'status'],
    ['source', { source: 'free-text' }, 'source'],
    ['start', { start_month: '2026-13' }, 'start_month'],
    ['stop', { status: 'stopped', stop_month: '2026-00' }, 'stop_month'],
    ['order', { status: 'stopped', start_month: '2026-03', stop_month: '2026-02' }, 'month_order'],
    ['active stop', { stop_month: '2026-02' }, 'active_stop'],
    ['code', { drug_rxcui: 'RxNorm:NA' }, 'rxcui'],
    ['list', { list_version: '' }, 'list_version'],
  ] as const)('refuses invalid %s at the database', async (_name, over, constraint) => {
    const { tenant, input } = await world();
    const error = await attempt(db.appUrl, tenant, ACTOR, (c) => insert(c, raw(input, tenant, over)));
    expect(error).toMatchObject({ code: '23514', constraint: `patient_medications_${constraint}` });
  });
  it('FORCE RLS hides rows from other tenants and worker privileges deny access', async () => {
    const { tenant, input } = await world();
    await repository.insertVersion(tenant, ACTOR, input);
    expect(await repository.read(`SYN-${randomUUID()}`, input.patientId, {})).toEqual([]);
    expect(await attempt(db.appUrl, `SYN-${randomUUID()}`, ACTOR, (c) => insert(c, raw({ ...input, id: randomUUID() }, tenant)))).toMatchObject({ code: '42501' });
    expect(await attempt(db.workerUrl, tenant, ACTOR, (c) => c.query('SELECT * FROM patient_medications'))).toMatchObject({ code: '42501' });
    const result = await withAdmin(db.adminUrl, (c) => c.query(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname='patient_medications'`));
    expect(result.rows).toEqual([{ forced: true }]);
  });
  it('orders current entries using only their latest fields, with stable entry-id ties and patient/tenant isolation', async () => {
    const { tenant, input } = await world();
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const stoppedId = '33333333-3333-4333-8333-333333333333';
    for (const entryId of [secondId, firstId, stoppedId]) {
      await repository.insertVersion(tenant, ACTOR, {
        ...input,
        id: randomUUID(),
        entryId,
        name: 'SYN-same',
        input: { ...input.input, requestId: randomUUID() },
      });
    }
    await repository.insertVersion(tenant, ACTOR, {
      ...input,
      id: randomUUID(),
      entryId: stoppedId,
      name: 'SYN-before',
      input: { ...input.input, requestId: randomUUID(), entryId: stoppedId, expectedVersion: 1, status: 'stopped' },
    });
    const otherPatient = await seedLabReport(db.adminUrl, tenant);
    const otherEntry = randomUUID();
    await repository.insertVersion(tenant, ACTOR, { ...input, id: randomUUID(), entryId: otherEntry, patientId: otherPatient.patientId });
    const otherTenant = await world();
    await repository.insertVersion(otherTenant.tenant, ACTOR, { ...otherTenant.input, entryId: firstId });
    const current = await repository.read(tenant, input.patientId, {});
    expect(current.map(({ entryId, name, version, current, status }) => ({ entryId, name, version, current, status }))).toEqual([
      { entryId: firstId, name: 'SYN-same', version: 1, current: true, status: 'active' },
      { entryId: secondId, name: 'SYN-same', version: 1, current: true, status: 'active' },
      { entryId: stoppedId, name: 'SYN-before', version: 2, current: true, status: 'stopped' },
    ]);
    expect(current.every((row) => row.patientId === input.patientId)).toBe(true);
    expect(current.some((row) => 'creationRequestHash' in row)).toBe(false);
    expect(await repository.read(tenant, input.patientId, { entryId: otherEntry })).toEqual([]);
    expect(await repository.read(otherTenant.tenant, input.patientId, {})).toEqual([]);
  });
  it('sees a committed correction immediately in both current read forms while retaining historical current flags', async () => {
    const { tenant, input } = await world();
    await repository.insertVersion(tenant, ACTOR, input);
    expect(await repository.read(tenant, input.patientId, { entryId: input.entryId, version: 1 })).toEqual([expect.objectContaining({ version: 1, current: true })]);
    await repository.insertVersion(tenant, ACTOR, {
      ...input,
      id: randomUUID(),
      name: 'SYN-corrected',
      input: { ...input.input, requestId: randomUUID(), entryId: input.entryId, expectedVersion: 1, status: 'stopped', stopMonth: '2026-02' },
    });
    const ledgerCount = () => withAdmin(db.adminUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id=$1', [tenant])).rows[0].n);
    const before = await ledgerCount();
    for (const query of [{}, { entryId: input.entryId }, { entryId: input.entryId, version: 2 }]) {
      expect(await repository.read(tenant, input.patientId, query)).toEqual([
        expect.objectContaining({ entryId: input.entryId, name: 'SYN-corrected', version: 2, current: true, status: 'stopped', stopMonth: '2026-02' }),
      ]);
    }
    expect(await repository.read(tenant, input.patientId, { entryId: input.entryId, version: 1 })).toEqual([
      expect.objectContaining({ name: 'syn-ingredient', version: 1, current: false, status: 'active', stopMonth: null }),
    ]);
    expect(await repository.read(tenant, input.patientId, { entryId: input.entryId, version: 3 })).toEqual([]);
    expect(await ledgerCount()).toBe(before);
  });
  it('returns one coherent committed version while a correction races with current reads', async () => {
    const { tenant, input } = await world();
    await repository.insertVersion(tenant, ACTOR, input);
    const correction = repository.insertVersion(tenant, ACTOR, {
      ...input,
      id: randomUUID(),
      name: 'SYN-new-version',
      input: { ...input.input, requestId: randomUUID(), entryId: input.entryId, expectedVersion: 1, status: 'stopped', stopMonth: '2026-02' },
    });
    const reads = await Promise.all(Array.from({ length: 12 }, () => repository.read(tenant, input.patientId, {})));
    await correction;
    for (const rows of reads) {
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect([1, 2]).toContain(row.version);
      expect(row).toMatchObject(
        row.version === 1
          ? { name: 'syn-ingredient', current: true, status: 'active', stopMonth: null }
          : { name: 'SYN-new-version', current: true, status: 'stopped', stopMonth: '2026-02' },
      );
    }
    expect(await repository.read(tenant, input.patientId, {})).toEqual([expect.objectContaining({ version: 2, current: true, name: 'SYN-new-version' })]);
  });
  it('recognizes medication facts but keeps analytic release held (D9, E3 and D07)', async () => {
    const { tenant, input } = await world();
    await repository.insertVersion(tenant, ACTOR, input);
    const answer = (patient: string) =>
      database.withTenant(
        tenant,
        async (c) =>
          (await c.query("SELECT eligible, reason_codes FROM use_eligibility($1,$2,'research','synthetic','coded','medication',$3,clock_timestamp())", [tenant, patient, input.id]))
            .rows[0],
      );
    const known = await answer(input.patientId);
    expect(known.eligible).toBe(false);
    expect(known.reason_codes).toContain('medication-release-held');
    expect(known.reason_codes).not.toContain('fact-not-found');
    const wrongPatient = await answer(randomUUID());
    expect(wrongPatient.eligible).toBe(false);
    expect(wrongPatient.reason_codes).toContain('fact-not-found');
  });
  it('refuses update, delete and truncate even by the owner', async () => {
    const { tenant, input } = await world();
    await repository.insertVersion(tenant, ACTOR, input);
    // Follow-ups reference medication versions. CASCADE gets past the FK's earlier 0A000 refusal to exercise append-only protection.
    for (const sql of ['UPDATE patient_medications SET version=2 WHERE id=$1', 'DELETE FROM patient_medications WHERE id=$1', 'TRUNCATE patient_medications CASCADE']) {
      expect(await attempt(db.adminUrl, tenant, ACTOR, (c) => c.query(sql, sql.includes('$1') ? [input.id] : []))).toMatchObject({ code: '23000' });
    }
  });
});
