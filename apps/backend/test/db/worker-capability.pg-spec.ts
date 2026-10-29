import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { claimJob, queuedEvaluation } from '../helpers/queued-evaluation';

/**
 * Spec 012 slice 1: the database issues a capability for the requester of a queued evaluation, only to the worker that holds the request's job, after
 * checking the lease, the requester's active membership and role, and the organization. Every answer is logged. Real logins throughout (the issuer, the
 * application, the queue worker); synthetic organizations and people, one per test.
 */
jest.setTimeout(60_000);

let pg: EphemeralDatabase;
let database: Database;
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
}, 60_000);
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

interface Answer {
  expires_at: Date | null;
  refusal: string | null;
  membership_version: string | null;
  tenant_id: string | null;
  sub: string | null;
}

/** As the issuer login, committed, as the issuer does. */
async function issueForJob(job: string | null, worker: string | null, hash: Buffer | null = hashOf(randomBytes(32).toString('base64url')), url = pg.issuerUrl) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<Answer>('SELECT * FROM tenant_capability_issue_for_job($1, $2, $3)', [job, worker, hash])).rows[0]!;
  } finally {
    await c.end();
  }
}

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);

async function logFor(job: string) {
  return owner(
    async (c) =>
      (
        await c.query<{ tenant_id: string | null; sub: string | null; purpose: string; outcome: string; reason: string | null }>(
          'SELECT tenant_id, sub, purpose, outcome, reason FROM capability_issuance_log WHERE request_id = $1 ORDER BY seq',
          [job],
        )
      ).rows,
  );
}

async function capabilitiesFor(job: string) {
  return owner(
    async (c) =>
      (
        await c.query<{ tenant_id: string; sub: string; purpose: string; membership_version: string }>(
          'SELECT tenant_id, sub, purpose, membership_version FROM tenant_capabilities WHERE request_id = $1',
          [job],
        )
      ).rows,
  );
}

const queued = (options: Parameters<typeof queuedEvaluation>[2] = {}) => queuedEvaluation(pg, database, options);
const claim = (job: string, worker: string) => claimJob(pg, job, worker);

describe('tenant_capability_issue_for_job', () => {
  it('issues a capability for the requester to the worker that holds the job, and logs it', async () => {
    const t = await queued();
    const answer = await issueForJob(t.job, t.worker);
    expect(answer).toMatchObject({ refusal: null, membership_version: '1', tenant_id: t.tenantId, sub: t.sub });
    expect(answer.expires_at!.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(answer.expires_at!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await capabilitiesFor(t.job)).toEqual([{ tenant_id: t.tenantId, sub: t.sub, purpose: 'evaluation-job', membership_version: '1' }]);
    expect(await logFor(t.job)).toEqual([{ tenant_id: t.tenantId, sub: t.sub, purpose: 'evaluation-job', outcome: 'issued', reason: null }]);
  });

  it('issues for a requester who is a reviewer (control for the role check)', async () => {
    const t = await queued({ roles: ['reviewer'] });
    expect((await issueForJob(t.job, t.worker)).refusal).toBeNull();
  });

  it.each([
    ['another worker names the job', async (t: Awaited<ReturnType<typeof queued>>) => issueForJob(t.job, 'syn-worker-other')],
    [
      'the lease has run out',
      async (t: Awaited<ReturnType<typeof queued>>) => {
        await owner((c) => c.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [t.job]));
        return issueForJob(t.job, t.worker);
      },
    ],
  ])('refuses when %s, logs it, and issues nothing', async (_case, ask) => {
    const t = await queued();
    const answer = await ask(t);
    expect(answer).toMatchObject({ expires_at: null, refusal: 'job-not-held', membership_version: null });
    expect(await capabilitiesFor(t.job)).toEqual([]);
    expect(await logFor(t.job)).toEqual([{ tenant_id: t.tenantId, sub: t.sub, purpose: 'evaluation-job', outcome: 'refused', reason: 'job-not-held' }]);
  });

  it('refuses a job that is still queued, then issues once it is claimed', async () => {
    const t = await queued({ claim: false });
    expect((await issueForJob(t.job, t.worker)).refusal).toBe('job-not-held');
    await claim(t.job, t.worker);
    expect((await issueForJob(t.job, t.worker)).refusal).toBeNull();
  });

  it('refuses a job id that does not exist, logging it without an organization or person', async () => {
    const job = randomUUID();
    expect((await issueForJob(job, 'syn-worker-any')).refusal).toBe('job-not-held');
    expect(await logFor(job)).toEqual([{ tenant_id: null, sub: null, purpose: 'evaluation-job', outcome: 'refused', reason: 'job-not-held' }]);
  });

  it('refuses a job of another type held by the same worker', async () => {
    const t = await queued();
    await owner((c) => c.query(`UPDATE jobs SET type = 'uploads.sweep' WHERE id = $1`, [t.job]));
    expect((await issueForJob(t.job, t.worker)).refusal).toBe('job-not-held');
  });

  it('refuses a requester whose only role is reader', async () => {
    const t = await queued({ roles: ['reader'] });
    expect((await issueForJob(t.job, t.worker)).refusal).toBe('role-not-allowed');
    expect(await capabilitiesFor(t.job)).toEqual([]);
    expect((await logFor(t.job)).map((r) => r.reason)).toEqual(['role-not-allowed']);
  });

  it('refuses a requester removed after queuing', async () => {
    const t = await queued();
    await owner((c) => c.query(`UPDATE tenant_memberships SET status='removed', changed_by='syn-test' WHERE tenant_id=$1 AND sub=$2`, [t.tenantId, t.sub]));
    expect((await issueForJob(t.job, t.worker)).refusal).toBe('membership-not-current');
    expect(await capabilitiesFor(t.job)).toEqual([]);
  });

  it('refuses when the organization is suspended', async () => {
    const t = await queued();
    await owner((c) => c.query(`UPDATE tenants SET status='suspended', changed_by='syn-operator' WHERE id=$1`, [t.tenantId]));
    expect((await issueForJob(t.job, t.worker)).refusal).toBe('tenant-inactive');
    expect(await capabilitiesFor(t.job)).toEqual([]);
  });

  it.each([
    ['no job', () => issueForJob(null, 'syn-worker-any')],
    ['no worker', () => issueForJob(randomUUID(), null)],
    ['a short token hash', () => issueForJob(randomUUID(), 'syn-worker-any', Buffer.alloc(16))],
  ])('refuses %s as malformed', async (_case, ask) => {
    expect((await ask()).refusal).toBe('malformed');
  });

  it.each([
    ['the application login', () => pg.appUrl],
    ['the queue worker login', () => pg.workerUrl],
  ])('cannot be called by %s (control: the issuer login can)', async (_case, url) => {
    const t = await queued();
    const attempt = issueForJob(t.job, t.worker, undefined, url()).then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );
    expect(await attempt).toBe('42501');
    expect((await issueForJob(t.job, t.worker)).refusal).toBeNull();
  });

  it('gives the capability owner read access to jobs and evaluation requests and nothing more', async () => {
    const grants = await owner(
      async (c) =>
        (
          await c.query<{ table_name: string; privilege_type: string }>(
            `SELECT table_name, privilege_type FROM information_schema.role_table_grants
              WHERE grantee = 'telesphoros_capability' AND table_name IN ('jobs', 'evaluation_requests') ORDER BY 1, 2`,
          )
        ).rows,
    );
    expect(grants).toEqual([
      { table_name: 'evaluation_requests', privilege_type: 'SELECT' },
      { table_name: 'jobs', privilege_type: 'SELECT' },
    ]);
  });
});
