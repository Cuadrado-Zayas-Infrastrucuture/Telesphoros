import { errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp } from './helpers/app';

describe('health (liveness) and ready (readiness)', () => {
  it('health is public and always "ok"; ready reports "ready" with no dependencies yet', async () => {
    const app = await createTestApp();
    try {
      expect((await request(app.getHttpServer()).get('/api/v1/health').expect(200)).body).toEqual({ status: 'ok' });
      expect((await request(app.getHttpServer()).get('/api/v1/ready').expect(200)).body).toEqual({
        status: 'ready',
        checks: {},
      });
    } finally {
      await app.close();
    }
  });

  it('ready returns 503 while a dependency is down, but health stays 200 (so the process is not restarted)', async () => {
    const app = await createTestApp({
      readinessChecks: [
        { name: 'database', check: async () => { throw new Error('connection refused to db.internal:5432'); } },
        { name: 'cache', check: async () => undefined },
      ],
    });
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
      expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.details).toEqual([{ field: 'database', message: 'unavailable' }]);
      expect(JSON.stringify(res.body)).not.toMatch(/db\.internal|5432|refused/);
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    } finally {
      await app.close();
    }
  });

  it('ready fails (instead of hanging) when a dependency never answers', async () => {
    const app = await createTestApp({
      readinessChecks: [{ name: 'slow', check: () => new Promise<void>(() => undefined) }],
    });
    try {
      const started = Date.now();
      const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
      expect(res.body.error.details[0].field).toBe('slow');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await app.close();
    }
  }, 15000);
});
