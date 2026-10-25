import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Client } from 'pg';
import { authorityContextMiddleware } from '../../src/auth/authority-context';
import { Database } from '../../src/db/database';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import type { ReportRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { commitUpload } from '../helpers/uploads';

/**
 * Audit item 50: a job could not be traced to the request that caused it. The upload commit writes its outbox event with the request's id, and the relay
 * copies it into the job's payload for the routes that take it. The worker side (an optional `requestId` in the payload) is already on `main`.
 */
let db: EphemeralDatabase;
let database: Database;
let reports: PostgresReportsRepository;
let patients: PostgresPatientsRepository;
const HASH = 'a'.repeat(64);
beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  reports = new PostgresReportsRepository(database);
  patients = new PostgresPatientsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const tenant = () => `syn-rid-${randomUUID().slice(0, 8)}`;
async function newReport(tenantId: string): Promise<ReportRecord> {
  await owner((c) => registerTenantRow(c, tenantId)); // the relay makes a job only for a registered organization
  const now = new Date().toISOString();
  const p = { id: randomUUID(), tenantId, createdBy: 'syn-actor', label: `SYN-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now };
  await patients.insert(p);
  const r: ReportRecord = { id: randomUUID(), tenantId, createdBy: 'syn-actor', patientId: p.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 1000, status: 'received',
    storageKey: null, contentType: null, sha256: null, uploadedAt: null, objectVersion: null, uploadRequestedBy: null, uploadedBy: null, createdAt: now, updatedAt: now };
  await reports.insert(r);
  return r;
}
/** Runs `work` the way a request does: inside the per-request slot the API opens, with the id the request middleware set. */
const inRequest = <T>(requestId: string | undefined, work: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => authorityContextMiddleware({ id: requestId } as unknown as Request, {} as Response, () => { void work().then(resolve, reject); }));
const eventOf = (reportId: string) => owner(async (c) => (await c.query<{ request_id: string | null }>('SELECT request_id FROM outbox_events WHERE subject_id = $1', [reportId])).rows[0]);
const relay = () => owner((c) => c.query('SELECT outbox_relay(500)'));
const payloadOf = (reportId: string) => owner(async (c) => (await c.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM jobs WHERE payload ->> 'reportId' = $1`, [reportId])).rows[0]?.payload);
const REQUEST = '7b9c1d2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('the upload commit carries the request id into the outbox event and the job', () => {
  it('stores the id of the request on the event and puts it in the job payload', async () => {
    const t = tenant();
    const r = await newReport(t);
    await inRequest(REQUEST, () => commitUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' }));
    expect(await eventOf(r.id)).toEqual({ request_id: REQUEST });
    await relay();
    expect(await payloadOf(r.id)).toEqual({ reportId: r.id, requestId: REQUEST });
  });

  it('carries nothing for a commit that has no request behind it (a background caller), and the job is as before', async () => {
    const t = tenant();
    const r = await newReport(t);
    await commitUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' });
    expect(await eventOf(r.id)).toEqual({ request_id: null });
    await relay();
    expect(await payloadOf(r.id)).toEqual({ reportId: r.id });
  });

  it('drops a request id the jobs table would refuse (a caller-supplied id may hold a dot or an underscore) instead of failing the event', async () => {
    const t = tenant();
    const r = await newReport(t);
    await inRequest('caller.supplied_id-1', () => commitUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' }));
    expect(await eventOf(r.id)).toEqual({ request_id: null });
    await relay();
    expect(await payloadOf(r.id)).toEqual({ reportId: r.id }); // relayed, not stuck as a poison event
  });

  it('carries the id only on a route that opted in (control: the same event, the route switched off, then on)', async () => {
    const t = tenant();
    const [off, on] = [await newReport(t), await newReport(t)];
    await owner((c) => c.query(`UPDATE outbox_routes SET carry_request_id = false WHERE event_type = 'report.file-committed'`));
    try {
      await inRequest(REQUEST, () => commitUpload(reports, off, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' }));
      await relay();
      expect(await payloadOf(off.id)).toEqual({ reportId: off.id });
    } finally {
      await owner((c) => c.query(`UPDATE outbox_routes SET carry_request_id = true WHERE event_type = 'report.file-committed'`));
    }
    await inRequest(REQUEST, () => commitUpload(reports, on, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' }));
    await relay();
    expect(await payloadOf(on.id)).toEqual({ reportId: on.id, requestId: REQUEST });
  });
});

describe('outbox_append', () => {
  it('keeps the two-argument form for images that call it (no request id), and the new form needs the same organization binding', async () => {
    const t = tenant();
    const [a, b] = [randomUUID(), randomUUID()];
    await database.withTenant(t, async (c) => {
      await c.query('SELECT outbox_append($1, $2)', ['report.file-committed', a]);
      await c.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', b, REQUEST]);
    });
    expect((await eventOf(a))).toEqual({ request_id: null });
    expect((await eventOf(b))).toEqual({ request_id: REQUEST });
    const client = new (await import('pg')).Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await expect(client.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', randomUUID(), REQUEST])).rejects.toMatchObject({ code: '42501' }); // no organization bound
    } finally {
      await client.end();
    }
  });

  it('can be called by the application role and by no one else (PUBLIC and the worker cannot)', async () => {
    const rows = await owner((c) => c.query(`SELECT has_function_privilege('public', 'outbox_append(text, uuid, text)', 'EXECUTE') AS pub,
      has_function_privilege('telesphoros_app', 'outbox_append(text, uuid, text)', 'EXECUTE') AS app,
      has_function_privilege('telesphoros_worker', 'outbox_append(text, uuid, text)', 'EXECUTE') AS worker`));
    expect(rows.rows[0]).toEqual({ pub: false, app: true, worker: false });
  });

  it('stores an id of the right shape only: anything else becomes no id', async () => {
    const t = tenant();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await database.withTenant(t, async (c) => {
      await c.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', ids[0], 'has space']);
      await c.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', ids[1], 'x'.repeat(65)]);
      await c.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', ids[2], '']);
    });
    for (const id of ids) expect(await eventOf(id)).toEqual({ request_id: null });
  });
});

describe('an outbox event', () => {
  it('still changes only by being relayed: its request id cannot be edited, even by the owner', async () => {
    const t = tenant();
    const id = randomUUID();
    await database.withTenant(t, (c) => c.query('SELECT outbox_append($1, $2, $3)', ['report.file-committed', id, REQUEST]));
    await expect(owner((c) => c.query(`UPDATE outbox_events SET request_id = 'another-id-1234' WHERE subject_id = $1`, [id]))).rejects.toThrow(/changes only by being relayed/);
  });
});
