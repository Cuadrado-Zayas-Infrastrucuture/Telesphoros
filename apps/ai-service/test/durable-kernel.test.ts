import { expect, test } from 'vitest';
import { runDurableSynthetic } from '../durable/kernel';
import { durableScenario } from './helpers/durable-memory';

const signal = new AbortController().signal;

test('a durable begin must succeed before any scripted actor runs', async () => {
  const s = durableScenario();
  s.denyAt('begin:draft:1', 'NOT_AUTHORIZED');
  expect(await runDurableSynthetic(s.stamp, s.initial, s.store, s.actors, signal)).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
  expect(s.counts).toEqual({ draft: 0, director: 0 });
  expect(s.trace).not.toContain('actor:draft');
});

test('first acceptance uses only two slots and an SQL-validated finish', async () => {
  const s = durableScenario();
  const result = await runDurableSynthetic(s.stamp, s.initial, s.store, s.actors, signal);
  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') expect(result.value?.terminalState).toBe('released');
  expect(s.counts).toEqual({ draft: 1, director: 1 });
  expect(s.trace).toContain('finish:released');
  expect(s.trace).not.toContain('begin:draft:2');
  expect(s.trace.indexOf('begin:draft:1')).toBeLessThan(s.trace.indexOf('actor:draft'));
});

test('repair is bounded to one second attempt and rechecked by durable begin', async () => {
  const s = durableScenario();
  let reviews = 0;
  const original = s.actors.director;
  s.actors.director = async (...args) => {
    const result = await original(...args);
    return { ...result, artifact: { ...result.artifact, decision: ++reviews === 1 ? 'repair' : 'accept' } };
  };
  s.denyAt('begin:draft:2', 'NOT_AUTHORIZED');
  const result = await runDurableSynthetic(s.stamp, s.initial, s.store, s.actors, signal);
  expect(result).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
  expect(s.counts.draft).toBe(1);
  expect(s.trace).toContain('advance:repair-pending');
  expect(s.trace).not.toContain('finish:released');
});

test('an unknown prior dispatch cannot replay any actor', async () => {
  const s = durableScenario();
  s.setUnknown();
  expect(await runDurableSynthetic(s.stamp, s.initial, s.store, s.actors, signal)).toEqual({ kind: 'refused', code: 'USAGE_UNKNOWN' });
  expect(s.counts).toEqual({ draft: 0, director: 0 });
});
