import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp, membershipOf } from '../helpers/app';
import { bearer, signToken } from '../helpers/tokens';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { pendingMigrations, MigrationError } from '../../src/db/migrator';

const apps: NestExpressApplication[] = [];
const dbs: EphemeralDatabase[] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(dbs.map((d) => d.drop()));
});
const boot = async (db: EphemeralDatabase) => {
  const app = await createTestApp({ postgresUrl: db.appUrl });
  apps.push(app);
  return app;
};

describe('readiness against a real database', () => {
  it.each(['checksum drift', 'unknown newer version'] as const)('refuses %s after startup and recovers after repair without restarting', async (fault) => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    const api = () => request(app.getHttpServer());
    await api().get('/api/v1/ready').expect(200);
    const original = await withAdmin(
      db.adminUrl,
      async (c) => (await c.query<{ version: string; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows,
    );
    const first = original[0]!;
    const unknown = String(Number(original.at(-1)!.version) + 1).padStart(4, '0');
    try {
      await withAdmin(db.adminUrl, (c) =>
        fault === 'checksum drift'
          ? c.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', ['t02-checksum-sentinel', first.version])
          : c.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [unknown, 't02_future', 't02-checksum-sentinel']),
      );
      const res = await api().get('/api/v1/ready').expect(503);
      expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
      expect(res.text).not.toMatch(/t02-checksum-sentinel|t02_future|schema_migrations|checksum|\.sql|postgres:|test_[0-9a-f]{12}/);
      await api().get('/api/v1/health').expect(200);
    } finally {
      await withAdmin(db.adminUrl, (c) =>
        fault === 'checksum drift'
          ? c.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [first.checksum, first.version])
          : c.query('DELETE FROM schema_migrations WHERE version = $1', [unknown]),
      );
    }
    await api().get('/api/v1/ready').expect(200);
    expect(await withAdmin(db.adminUrl, async (c) => (await c.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows)).toEqual(original);
  });

  it('is ready when the database is reachable and fully migrated', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const res = await request((await boot(db)).getHttpServer())
      .get('/api/v1/ready')
      .expect(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', migrations: 'up' } });
  });

  it('stays ready while the database is ahead of the code by an expand migration, and refuses once it is a breaking one', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    const api = () => request(app.getHttpServer());
    const last = await withAdmin(db.adminUrl, async (c) => (await c.query<{ version: string }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]!.version);
    const newer = String(Number(last) + 1).padStart(4, '0');
    await withAdmin(db.adminUrl, (c) =>
      c.query(`INSERT INTO schema_migrations (version, name, checksum, compat) VALUES ($1, 't_newer_expand', 'unknown-to-this-code', 'expand')`, [newer]),
    );
    const ready = await api().get('/api/v1/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { database: 'up', migrations: 'up' } }); // the public body does not change
    await withAdmin(db.adminUrl, (c) => c.query(`UPDATE schema_migrations SET compat = 'breaking' WHERE version = $1`, [newer]));
    const refused = await api().get('/api/v1/ready').expect(503);
    expect(refused.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
    expect(refused.text).not.toMatch(/t_newer_expand|unknown-to-this-code|schema_migrations|breaking|expand/);
    await withAdmin(db.adminUrl, (c) => c.query('DELETE FROM schema_migrations WHERE version = $1', [newer]));
    await api().get('/api/v1/ready').expect(200);
  });

  it.each(['pending suffix', 'history gap'] as const)('refuses a %s and becomes ready after repair', async (fault) => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
    const original = await withAdmin(
      db.adminUrl,
      async (c) =>
        (await c.query<{ version: string; name: string; checksum: string; applied_at: Date }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'))
          .rows,
    );
    const removed = fault === 'pending suffix' ? original.at(-1)! : original[1]!;
    try {
      await withAdmin(db.adminUrl, (c) => c.query('DELETE FROM schema_migrations WHERE version = $1', [removed.version]));
      if (fault === 'pending suffix') {
        await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c))).resolves.toEqual([removed.version]);
      } else {
        await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c))).rejects.toBeInstanceOf(MigrationError);
      }
      const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
      expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    } finally {
      await withAdmin(db.adminUrl, (c) =>
        c.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)', [
          removed.version,
          removed.name,
          removed.checksum,
          removed.applied_at,
        ]),
      );
    }
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
    expect(await withAdmin(db.adminUrl, async (c) => (await c.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows)).toEqual(original);
  });

  it('fails closed on missing metadata permission and recovers with the existing grant', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
    try {
      await withAdmin(db.adminUrl, (c) => c.query('REVOKE SELECT ON schema_migrations FROM telesphoros_app'));
      const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
      expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
      expect(res.text).not.toMatch(/permission denied|schema_migrations|telesphoros_app|postgres:/);
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    } finally {
      await withAdmin(db.adminUrl, (c) => c.query('GRANT SELECT ON schema_migrations TO telesphoros_app'));
    }
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
  });

  it('bounds a real metadata lock wait and recovers without restarting', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
    await withAdmin(db.adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
        const start = Date.now();
        const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
        expect(Date.now() - start).toBeLessThan(5000);
        expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
        expect(res.text).not.toMatch(/timeout|schema_migrations|postgres:/);
        await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
  }, 15000);

  it('is NOT ready while migrations are pending, but the process is still alive (health stays 200)', async () => {
    const db = await createEphemeralDatabase({ migrate: false });
    dbs.push(db);
    const app = await boot(db);
    const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(await withAdmin(db.adminUrl, async (c) => (await c.query("SELECT to_regclass('public.schema_migrations') IS NULL AS absent")).rows[0].absent)).toBe(true);
  });

  it('turns NOT ready when the database disappears, without leaking why, and health stays 200', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);

    await db.drop(); // forcibly disconnects the app's pooled connections too

    const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('database');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|does not exist|test_[0-9a-f]{12}|postgres:/);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it('private API calls fail closed (503 in the standard envelope, no database details) while the database is down, before any work is done', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    // No token mirroring: the caller's standing is looked up in the database for real, and the database is the thing that is down.
    const app = await createTestApp({ postgresUrl: db.appUrl, membershipFromTokens: false });
    apps.push(app);
    await membershipOf(app).grant({ tenantId: 'tenant-user-a', sub: 'user-a', roles: ['reader'], by: 'operator-test' });
    const token = await signToken({ sub: 'user-a', roles: ['reader'] });
    await request(app.getHttpServer()).get('/api/v1/patients').set(bearer(token)).expect(200); // control: works while the database is up
    await db.drop();
    const res = await request(app.getHttpServer()).get('/api/v1/patients').set(bearer(token));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.text).not.toMatch(/does not exist|test_[0-9a-f]{12}|postgres/i);
  });
});
