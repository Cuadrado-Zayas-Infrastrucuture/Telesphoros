import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * Spec 026 (migration 0065): the worker's way to remove expired capabilities. `capabilities_sweep_run(p_limit)` calls the existing
 * `tenant_capabilities_sweep` (0028, unchanged) and says whether a full batch was removed, so the caller knows more may be waiting.
 *
 * Every login here is a real login, as in tenant-capability.pg-spec.ts. Rows are synthetic and written by the owner connection; ages are set by hand.
 */
jest.setTimeout(60_000);

let db: EphemeralDatabase;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

/** Runs one statement as `url` in its own committed transaction (the worker's sweep commits, as the timer's call does). */
async function as<T>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const run = async (limit: number) => (await as<{ removed: number; behind: boolean }>(db.workerUrl, 'SELECT removed, behind FROM capabilities_sweep_run($1)', [limit]))[0]!;

/** Rows that expired `minutesAgo` minutes ago (negative: still live), purpose `internal`, as the internal bindings write them. */
async function rows(minutesAgo: number, n = 1): Promise<string[]> {
  const hashes: string[] = [];
  await owner(async (c) => {
    for (let i = 0; i < n; i++) {
      const hash = randomBytes(32);
      hashes.push(hash.toString('hex'));
      await c.query(
        `INSERT INTO tenant_capabilities (token_hash, tenant_id, sub, membership_version, purpose, request_id, issued_at, expires_at)
         VALUES ($1, 'org-alpha', 'capability-sweep-spec', 0, 'internal', NULL,
                 clock_timestamp() - make_interval(mins => $2) - interval '60 seconds', clock_timestamp() - make_interval(mins => $2))`,
        [hash, minutesAgo],
      );
    }
  });
  return hashes;
}
const present = async (hashes: string[]): Promise<string[]> =>
  owner(async (c) =>
    (await c.query<{ h: string }>(`SELECT encode(token_hash, 'hex') AS h FROM tenant_capabilities WHERE encode(token_hash, 'hex') = ANY($1) ORDER BY 1`, [hashes])).rows.map(
      (r) => r.h,
    ),
  );

beforeAll(async () => {
  db = await createEphemeralDatabase();
  await owner((c) => registerTenantRow(c, 'org-alpha'));
});
beforeEach(() => owner((c) => c.query('DELETE FROM tenant_capabilities')));
afterAll(async () => {
  await db.drop();
});

describe('capabilities_sweep_run (spec 026)', () => {
  it('as the worker login, removes a capability that expired an hour ago', async () => {
    const [old] = await rows(60);
    expect(await run(1000)).toEqual({ removed: 1, behind: false });
    expect(await present([old!])).toEqual([]);
  });

  it('keeps a live capability and one that expired a minute ago (inside the five-minute retention)', async () => {
    const kept = [...(await rows(-1)), ...(await rows(1))].sort();
    expect(await run(1000)).toEqual({ removed: 0, behind: false });
    expect(await present(kept)).toEqual(kept);
  });

  it('a full batch reports that more may be waiting; the run that finds less than a batch reports it is current', async () => {
    const old = await rows(60, 5);
    expect(await run(3)).toEqual({ removed: 3, behind: true });
    expect((await present(old)).length).toBe(2);
    expect(await run(3)).toEqual({ removed: 2, behind: false });
    expect(await present(old)).toEqual([]);
  });

  it.each([0, -1, 10001])('refuses a batch of %i', async (limit) => {
    await rows(60);
    expect(await code(as(db.workerUrl, 'SELECT * FROM capabilities_sweep_run($1)', [limit]))).toBe('22023');
  });

  it('only the worker login may run it', async () => {
    const others = [
      ['app', db.appUrl],
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
      ['issuer', db.issuerUrl],
    ] as const;
    for (const [name, url] of others) expect([name, await code(as(url, 'SELECT * FROM capabilities_sweep_run(10)'))]).toEqual([name, '42501']);
    expect(await code(as(db.workerUrl, 'SELECT * FROM capabilities_sweep_run(10)'))).toBe('ok');
  });

  it('the worker still cannot run the sweep itself, read the table, or write it', async () => {
    expect(await code(as(db.workerUrl, 'SELECT tenant_capabilities_sweep(10)'))).toBe('42501');
    expect(await code(as(db.workerUrl, 'SELECT count(*) FROM tenant_capabilities'))).toBe('42501');
    expect(await code(as(db.workerUrl, `DELETE FROM tenant_capabilities`))).toBe('42501');
  });
});
