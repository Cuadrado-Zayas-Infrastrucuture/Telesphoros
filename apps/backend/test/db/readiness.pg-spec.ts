import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp } from '../helpers/app';
import { bearer, signToken } from '../helpers/tokens';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';

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
  it('is ready when the database is reachable and fully migrated', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const res = await request((await boot(db)).getHttpServer()).get('/api/v1/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up', migrations: 'up' } });
  });

  it('is NOT ready while migrations are pending, but the process is still alive (health stays 200)', async () => {
    const db = await createEphemeralDatabase({ migrate: false });
    dbs.push(db);
    const app = await boot(db);
    const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.details).toEqual([{ field: 'migrations', message: 'unavailable' }]);
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
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

  it('API calls fail cleanly (500 in the standard envelope, no database details) while the database is down', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const app = await boot(db);
    await db.drop();
    const token = await signToken({ sub: 'user-a', roles: ['reader'] });
    const res = await request(app.getHttpServer()).get('/api/v1/patients').set(bearer(token));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toMatch(/does not exist|test_[0-9a-f]{12}|postgres/i);
  });
});
