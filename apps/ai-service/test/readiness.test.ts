import { describe, expect, test } from 'vitest';
import { liveReadiness, READINESS_KEYS, readiness } from '../src/policy';

const all = Object.fromEntries(READINESS_KEYS.map((k) => [k, true]));
describe('FR-012 readiness conditions', () => {
  test('control: ready only when every condition is true', () => expect(readiness(all)).toEqual({ ready: true }));
  test.each([...READINESS_KEYS])('closed when %s is false', (key) =>
    expect(readiness({ ...all, [key]: false })).toEqual({ ready: false, reasonCode: 'NOT_READY', missing: [key] }),
  );
  test.each([...READINESS_KEYS])('closed when %s is absent', (key) => {
    const c = { ...all };
    delete c[key];
    expect(readiness(c)).toMatchObject({ ready: false, missing: [key] });
  });
  test('only the boolean true counts', () => {
    for (const v of ['true', 1, 'yes', null, {}]) expect(readiness({ ...all, baaExecuted: v as unknown as boolean }).ready).toBe(false);
  });
  test('lists every missing condition, and an empty input is closed', () => expect(readiness({})).toMatchObject({ ready: false, missing: [...READINESS_KEYS] }));
  test('the conditions include the three added after review', () =>
    expect(READINESS_KEYS).toEqual(expect.arrayContaining(['monitorLive', 'rollbackRehearsed', 'clinicianDocument'])));
  test('the live gate itself is unchanged: model execution stays disabled', () => expect(liveReadiness()).toEqual({ ready: false, reasonCode: 'MODEL_EXECUTION_DISABLED' }));
});
