import { AppException } from '../../src/common/app-exception';
import { mapException } from '../../src/common/error-mapping';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';

let ephemeral: EphemeralDatabase;
let db: Database;
beforeAll(async () => {
  ephemeral = await createEphemeralDatabase();
  db = new Database({ url: ephemeral.appUrl, ssl: 'disable', max: 1 });
});
afterAll(async () => {
  await db.onModuleDestroy();
  await ephemeral.drop();
});

describe('a full connection pool (audit: pool exhaustion answered 500)', () => {
  it('answers 503 with a Retry-After to the request that waits too long, and the held request is untouched', async () => {
    let release!: () => void;
    const held = db.withTenant('alice', (c) => new Promise<string>((resolve) => {
      release = () => resolve('held work finished');
      void c.query('SELECT 1');
    }));
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the first request take the only connection
    const error = await db.withTenant('alice', async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    const mapped = mapException(error);
    expect(mapped.status).toBe(503);
    expect(mapped.retryAfterSeconds).toBeGreaterThan(0);
    release();
    await expect(held).resolves.toBe('held work finished');
  });

  it('serves the next request normally once the connection is free (control)', async () => {
    await expect(db.withTenant('alice', async () => 'ok')).resolves.toBe('ok');
  });
});
