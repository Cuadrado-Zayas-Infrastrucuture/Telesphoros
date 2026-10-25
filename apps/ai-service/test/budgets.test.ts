import { expect, test } from 'vitest';
import { expired, SyntheticBudgets } from '../src/budgets';
import { syntheticProfile } from '../src/policy';
import { runVector } from './helpers/memory-adapters';

test('P1-11 refuses full graph reservation', () => {
  const b = new SyntheticBudgets(10000);
  expect(b.reserve(runVector(), syntheticProfile())).toBe(false);
  expect(b.snapshot('r1')).toBeNull();
});
test('P1-11 permits full graph reservation control', () => {
  const b = new SyntheticBudgets();
  expect(b.reserve(runVector(), syntheticProfile())).toBe(true);
  expect(b.snapshot('r1')?.tokensReserved).toBe(28160);
  expect(b.snapshot('r1')?.costReserved).toBe(250000);
});
test('P1-12 refuses memory budget contention', async () => {
  const b = new SyntheticBudgets();
  const admitted = await Promise.all(['a', 'b', 'c'].map((id) => Promise.resolve().then(() => b.reserve(runVector(id, id), syntheticProfile()))));
  expect(admitted).toEqual([true, true, false]);
  expect(b.reserve(runVector('d', 'a'), syntheticProfile())).toBe(false);
});
test('P1-12 permits memory budget contention control', () => {
  const b = new SyntheticBudgets();
  expect(b.reserve(runVector('a', 'a'), syntheticProfile())).toBe(true);
  expect(b.reserve(runVector('b', 'b'), syntheticProfile())).toBe(true);
  b.complete('a');
  expect(b.reserve(runVector('c', 'c'), syntheticProfile())).toBe(true);
});
test('P1-13 refuses original deadline', () => {
  const r = runVector();
  expect(expired({ ...r, state: 'running' }, r.admittedAt + 120001, 120001)).toBe(true);
});
test('P1-13 permits original deadline control', () => {
  const r = runVector();
  expect(expired(r, r.admittedAt + 119999, 119999)).toBe(false);
});
test('P1-23 refuses unknown attempted use', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  b.begin('r1', 'attempt-1');
  expect(b.observe('r1', 'draft', 'attempt-1', null)).toBe(false);
  b.complete('r1');
  expect(b.snapshot('r1')?.active).toBe(true);
  expect(b.snapshot('r1')?.tokensReserved).toBe(28160);
  expect(b.begin('r1', 'attempt-2')).toBe(false);
  expect(b.counters('r1').usageState).toBe('unknown');
});
test('P1-23 permits unknown attempted use control', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  b.begin('r1', 'attempt-1');
  expect(b.observe('r1', 'draft', 'attempt-1', { inputUnits: 100, generatedUnits: 50 })).toBe(true);
  expect(b.observe('r1', 'draft', 'attempt-1', { inputUnits: 100, generatedUnits: 50 })).toBe(false);
  b.complete('r1');
  expect(b.snapshot('r1')?.active).toBe(false);
  expect(b.counters('r1')).toEqual({ logicalSlots: 1, projectedTokens: 150, actualModelCalls: 0, actualModelTokens: 0, actualInferenceCharges: 0, usageState: 'known' });
});
test('P1-24 refuses original budget window', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  b.begin('r1', 'a1');
  b.complete('r1');
  expect(b.snapshot('r1')?.tenantWindow).toBe('2026-10-31');
  expect(b.snapshot('r1')?.fleetWindow).toBe('2026-10');
  expect(b.reserve(runVector('r2', 'tenant-a', Date.UTC(2026, 10, 1)), syntheticProfile())).toBe(false);
});
test('P1-24 permits original budget window control', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  b.begin('r1', 'a1');
  expect(b.reserve(runVector('r2', 'tenant-b', Date.UTC(2026, 10, 1)), syntheticProfile())).toBe(true);
  expect(b.snapshot('r2')?.tenantWindow).toBe('2026-11-01');
  expect(b.snapshot('r1')?.active).toBe(true);
});
test('P1-29 refuses logical per-role token cap', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  b.begin('r1', 'a1');
  expect(b.observe('r1', 'draft', 'a1', { inputUnits: 4097, generatedUnits: 0 })).toBe(false);
  expect(b.counters('r1').projectedTokens).toBe(4097);
  const huge = new SyntheticBudgets();
  huge.reserve(runVector(), syntheticProfile());
  huge.begin('r1', 'a1');
  expect(huge.observe('r1', 'director', 'a1', { inputUnits: 9007199254740991, generatedUnits: 9007199254740991 })).toBe(false);
  huge.complete('r1');
  expect(huge.counters('r1').usageState).toBe('unknown');
  expect(huge.counters('r1').projectedTokens).toBe(0);
  expect(huge.snapshot('r1')?.tokensReserved).toBe(28160);
});
test('P1-29 permits logical per-role token cap control', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector(), syntheticProfile());
  for (const [role, inputUnits, generatedUnits, n] of [
    ['draft', 4096, 768, 1],
    ['director', 8192, 1024, 2],
    ['draft', 4096, 768, 3],
    ['director', 8192, 1024, 4],
  ] as const) {
    b.begin('r1', `a${n}`);
    expect(b.observe('r1', role, `a${n}`, { inputUnits, generatedUnits })).toBe(true);
  }
  expect(b.counters('r1').projectedTokens).toBe(28160);
  expect(b.begin('r1', 'a5')).toBe(false);
});
test('P1-12 refuses reserving a completed run again', () => {
  const b = new SyntheticBudgets();
  expect(b.reserve(runVector('a', 'a'), syntheticProfile())).toBe(true);
  b.begin('a', 'x1');
  expect(b.observe('a', 'draft', 'x1', { inputUnits: 100, generatedUnits: 50 })).toBe(true);
  b.complete('a');
  expect(b.reserve(runVector('a', 'a'), syntheticProfile())).toBe(false);
  expect(b.counters('a').projectedTokens).toBe(150);
  expect(b.snapshot('a')?.active).toBe(false);
});
test('P1-12 permits reserving a different run after completion control', () => {
  const b = new SyntheticBudgets();
  b.reserve(runVector('a', 'a'), syntheticProfile());
  b.begin('a', 'x1');
  b.observe('a', 'draft', 'x1', { inputUnits: 100, generatedUnits: 50 });
  b.complete('a');
  expect(b.reserve(runVector('b', 'a'), syntheticProfile())).toBe(true);
  expect(b.counters('b').projectedTokens).toBe(0);
});
