import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { State } from '../src/contracts';
import { EXPLAIN_LIMITS, FAILURE_REASONS } from '../src/explain-contracts';
import { canTransition } from '../src/kernel';

// These read the migrations as text, so the TypeScript state machine, the failure reasons and the run's deadline cannot drift from the SQL without a failing test in the default run
// (the database specs that exercise the SQL run only against PostgreSQL).
const migrations = resolve(import.meta.dirname, '../../backend/migrations');
const sql = (name: string) => readFileSync(resolve(migrations, name), 'utf8');
const STATES: State[] = ['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending', 'released', 'held', 'failed', 'cancelled', 'expired'];

describe('migration 0049 and the TypeScript state machine', () => {
  const runs = sql('0049_agentic_explain_runs.up.sql');
  test('the legal pairs in SQL are exactly the pairs canTransition allows, over all 121', () => {
    const block = runs.slice(runs.indexOf('-- transitions:begin'), runs.indexOf('-- transitions:end'));
    const inSql = [...block.matchAll(/\('([a-z-]+)','([a-z-]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const inTs = STATES.flatMap((f) => STATES.filter((t) => canTransition(f, t)).map((t) => `${f}>${t}`)).sort();
    expect(inSql.length).toBeGreaterThan(0);
    expect(new Set(inSql).size).toBe(inSql.length);
    expect(inSql).toEqual(inTs);
    expect(inTs).toHaveLength(31);
  });
  test('control: the comparison would see a pair that differs', () => {
    const tampered = runs.replace("('admitted','queued')", "('admitted','running')");
    const block = tampered.slice(tampered.indexOf('-- transitions:begin'), tampered.indexOf('-- transitions:end'));
    const inSql = [...block.matchAll(/\('([a-z-]+)','([a-z-]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const inTs = STATES.flatMap((f) => STATES.filter((t) => canTransition(f, t)).map((t) => `${f}>${t}`)).sort();
    expect(inSql).not.toEqual(inTs);
  });
  test('the table lists the same eleven states as the TypeScript State type', () => {
    const list = /state text NOT NULL CHECK \(state IN \(([^)]*)\)\)/.exec(runs)![1];
    expect([...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual([...STATES].sort());
  });
  test('the run deadline in SQL is the TypeScript deadline', () => {
    expect(/clock_timestamp\(\) \+ interval '(\d+) seconds'/.exec(runs)![1]).toBe(String(EXPLAIN_LIMITS.deadlineMs / 1000));
  });
});

describe('migration 0048 and the TypeScript failure reasons', () => {
  test('the receipt table allows exactly the failure reasons plus RELEASED', () => {
    const receipts = sql('0048_agentic_explain_receipts.up.sql');
    const list = /reason_code text NOT NULL CHECK \(reason_code IN \(([^)]*)\)\)/s.exec(receipts)![1];
    expect([...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...FAILURE_REASONS, 'RELEASED'].sort());
  });
});
