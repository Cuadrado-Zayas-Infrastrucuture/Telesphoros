import { afterEach, beforeEach, expect, it } from 'vitest';
import { disposeFixtures } from '../../backend/test/helpers/fixture-cleanup';
import { createFixture, until, type Fixture } from './support';
import { holdSettlements } from './settlement-gate';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
afterEach(async () => {
  await f.close();
});

const gatePid = async () =>
  (
    await f.admin.query(`SELECT pid FROM pg_locks
  WHERE locktype = 'advisory' AND granted AND classid = 166 AND objid = 1 AND objsubid = 2
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
  ).rows[0].pid as number;
const disconnected = (pid: number) =>
  until('the gate connection to close', async () => (await f.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount === 0);
const capture = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the controlled fixture failure');
};

it('retains installation and cleanup failures when fixture DDL is rejected', async () => {
  await f.admin.query(`CREATE FUNCTION public.reject_gate_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TAG = 'CREATE TRIGGER' THEN RAISE EXCEPTION 'synthetic gate installation failure' USING ERRCODE = 'P0001';
      ELSE RAISE EXCEPTION 'synthetic gate cleanup failure' USING ERRCODE = 'P0002'; END IF;
    END $$`);
  await f.admin.query(`CREATE EVENT TRIGGER reject_gate_ddl ON ddl_command_start
    WHEN TAG IN ('CREATE TRIGGER', 'DROP FUNCTION') EXECUTE FUNCTION public.reject_gate_ddl()`);
  const error = await capture(() => holdSettlements(f));
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((e) => e.code)).toEqual(['P0001', 'P0002']);
  expect(
    (
      await f.admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND query LIKE 'DROP FUNCTION public.worker_test_hold_settlement%'`)
    ).rows[0].n,
  ).toBe(0);
});

it('tries every cleanup step and retains the test failure when dropping the trigger fails', async () => {
  const gate = await holdSettlements(f);
  const pid = await gatePid();
  await f.admin.query(`CREATE FUNCTION public.reject_gate_drop() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic trigger cleanup failure' USING ERRCODE = 'P0001'; END $$`);
  await f.admin.query(`CREATE EVENT TRIGGER reject_gate_drop ON ddl_command_start
    WHEN TAG IN ('DROP TRIGGER') EXECUTE FUNCTION public.reject_gate_drop()`);
  const original = new Error('synthetic assertion failure');
  const error = await capture(() => disposeFixtures([gate.close], [original]));
  expect(error).toBeInstanceOf(AggregateError);
  const errors = (error as AggregateError).errors;
  expect(errors[0]).toBe(original);
  // A dependent-function error proves its drop was attempted after the rejected trigger drop.
  expect(errors[1]).toBeInstanceOf(AggregateError);
  expect(errors[1].errors.map((e: { code: string }) => e.code)).toEqual(['P0001', '2BP01']);
  await disconnected(pid);
  expect(
    (
      await f.admin.query(`SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND classid = 166 AND objid = 1 AND objsubid = 2
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
    ).rows[0].n,
  ).toBe(0);
});

it('shares one cleanup across repeated callers and removes its database objects', async () => {
  const gate = await holdSettlements(f);
  const pid = await gatePid();
  await Promise.all([gate.close(), gate.close()]);
  await gate.close();
  await disconnected(pid);
  expect(
    (
      await f.admin.query(`SELECT to_regprocedure('public.worker_test_hold_settlement()') AS fn,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'worker_test_hold_settlement') AS triggers`)
    ).rows,
  ).toEqual([{ fn: null, triggers: 0 }]);
});
