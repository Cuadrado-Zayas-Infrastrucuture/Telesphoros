import { AppException } from '../common/app-exception';
import { mapException } from '../common/error-mapping';
import { Database } from './database';

// Port 1 refuses at once, so this needs no database. The pool-full case (a real database, a pool of one) is in test/db/pool-exhaustion.pg-spec.ts.
describe('a request that cannot get a database connection', () => {
  const db = new Database({ url: 'postgres://nobody:nothing@127.0.0.1:1/none', ssl: 'disable', max: 1 });
  afterAll(() => db.onModuleDestroy());

  it('answers 503 with a Retry-After, whoever the caller is', async () => {
    const error = await db.withTenant('alice', async () => 'unreachable').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    const mapped = mapException(error);
    expect(mapped.status).toBe(503);
    expect(mapped.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('says nothing about the database in the answer', async () => {
    const error = await db.withTenant('alice', async () => 'unreachable').catch((e: unknown) => e);
    const text = JSON.stringify(mapException(error));
    expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody|postgres/i);
  });
});
