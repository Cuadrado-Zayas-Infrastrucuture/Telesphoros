import { LedgerVerifier } from '../../src/ledger/verifier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/** The lock that spaces tasks' full walks out (audit items 23 and 32), against the real database: two verifiers stand for two tasks. */
let pg: EphemeralDatabase;
const open: LedgerVerifier[] = [];
beforeAll(async () => {
  pg = await createEphemeralDatabase();
});
afterAll(async () => {
  await Promise.all(open.map((v) => v.close()));
  await pg.drop();
});
const task = () => {
  const verifier = LedgerVerifier.connect(pg.verifierUrl);
  open.push(verifier);
  return verifier;
};

describe('the walk lock', () => {
  it('goes to one task at a time, and to the next once it is released', async () => {
    const [a, b] = [task(), task()];
    const first = await a.acquirePassLock();
    expect(first).toBeDefined();
    expect(await b.acquirePassLock()).toBeUndefined();
    await first!.release();
    const second = await b.acquirePassLock();
    expect(second).toBeDefined();
    await second!.release();
  });

  it('is free again when the holder disappears without releasing it (a task killed mid-walk)', async () => {
    const [a, b] = [task(), task()];
    const held = await a.acquirePassLock();
    expect(held).toBeDefined();
    // The holder's connection dies, as when its process is killed: the database ends the session that holds the advisory lock.
    await withAdmin(pg.adminUrl, (c) => c.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted`));
    let got: Awaited<ReturnType<LedgerVerifier['acquirePassLock']>>;
    for (let attempt = 0; attempt < 40 && !got; attempt++) {
      got = await b.acquirePassLock();
      if (!got) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(got).toBeDefined();
    await got!.release();
    await held!.release(); // the dead holder's own release must not throw or hang (it discards the connection)
  });

  it('does not stop the holder from verifying (it keeps one connection, the walk uses another)', async () => {
    const a = task();
    const held = await a.acquirePassLock();
    await expect(a.tenants()).resolves.toEqual(expect.any(Array));
    await held!.release();
  });
});
