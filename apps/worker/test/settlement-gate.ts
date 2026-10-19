import { Client } from 'pg';
import { disposeFixtures, onceFixtureCleanup } from '../../backend/test/helpers/fixture-cleanup';
import type { Fixture } from './support';

/** TEST ONLY: hold terminal updates in this disposable database after verification commits. */
export async function holdSettlements(f: Fixture) {
  const client = new Client({ connectionString: f.db.adminUrl });
  let locked = false;
  let createdFunction = false;
  let createdTrigger = false;
  const release = async () => {
    if (!locked) return;
    const { rows } = await client.query('SELECT pg_advisory_unlock($1, $2) AS released', [166, 1]);
    if (rows[0].released !== true) throw new Error('Test settlement gate lost its lock');
    locked = false;
  };
  const close = onceFixtureCleanup(() => disposeFixtures([
    release,
    async () => { if (createdTrigger) await client.query('DROP TRIGGER worker_test_hold_settlement ON public.jobs'); },
    async () => { if (createdFunction) await client.query('DROP FUNCTION public.worker_test_hold_settlement()'); },
    () => client.end(),
  ]));
  try {
    await client.connect();
    await client.query("SELECT set_config('lock_timeout', $1, false)", ['2s']);
    // Static fixture DDL, never a migration or a change to the real worker's SQL.
    await client.query(`CREATE FUNCTION public.worker_test_hold_settlement() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(166, 1);
        RETURN NEW;
      END $$`);
    createdFunction = true;
    await client.query(`CREATE TRIGGER worker_test_hold_settlement BEFORE UPDATE OF state ON public.jobs
      FOR EACH ROW WHEN (OLD.type = 'files.verify-stored' AND NEW.state IN ('succeeded', 'dead', 'cancelled'))
      EXECUTE FUNCTION public.worker_test_hold_settlement()`);
    createdTrigger = true;
    await client.query('SELECT pg_advisory_lock($1, $2)', [166, 1]);
    locked = true;
    return {
      release,
      close,
      async blocked(): Promise<number> {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`, [166, 1]);
        return rows[0].n as number;
      },
    };
  } catch (error) {
    await disposeFixtures([close], [error]);
    throw error;
  }
}
