import type { NestExpressApplication } from '@nestjs/platform-express';
import { Database } from '../../src/db/database';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, withAdmin, type EphemeralDatabase } from '../helpers/database';

// DATABASE_POOL_MAX bounds how many connections one API process holds as the application login. Several API tasks multiply it, and
// Terraform's connection budget (infrastructure/terraform/database-connections.tf) adds it up against the database's limit.
describe('the application database pool', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication | undefined;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
  }, 60_000);
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    await db.drop();
  });

  /** The most connections the application login held on this database while `work` ran, sampled every 25 ms. */
  async function peakDuring(work: () => Promise<unknown>): Promise<number> {
    const login = decodeURIComponent(new URL(db.appUrl).username);
    const database = new URL(db.appUrl).pathname.slice(1);
    let peak = 0;
    let running = true;
    const sampling = withAdmin(db.adminUrl, async (client) => {
      while (running) {
        const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2', [database, login]);
        peak = Math.max(peak, rows[0]!.n);
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    try {
      await work();
    } finally {
      running = false;
      await sampling;
    }
    return peak;
  }
  const busy = (connections: Database, count: number) =>
    Promise.all(Array.from({ length: count }, (_, i) => connections.withTenant(`syn-pool-${i}`, (client) => client.query('SELECT pg_sleep(0.3)'))));

  it.each([2, 3])(
    'holds at most DATABASE_POOL_MAX=%i connections under more concurrent work than that, and reaches it',
    async (max) => {
      app = await createTestApp({ postgresUrl: db.appUrl, databasePoolMax: max });
      const peak = await peakDuring(() => busy(app!.get(Database), max + 3));
      expect(peak).toBe(max);
    },
    60_000,
  );
});
