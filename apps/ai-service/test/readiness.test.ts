import { describe, expect, test } from 'vitest';
import { HELP_READINESS_KEYS, helpLiveReadiness, helpReadiness, liveReadiness, READINESS_KEYS, readiness } from '../src/policy';

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

// Spec 053 slice C2b, help-lane.md FR-H11: the help lane's own conditions, closed in code like the clinical lane's.
const allHelp = Object.fromEntries(HELP_READINESS_KEYS.map((k) => [k, true]));
describe('FR-H11 help lane readiness', () => {
  test('control: ready only when every condition is true', () => expect(helpReadiness(allHelp)).toEqual({ ready: true }));
  test.each([...HELP_READINESS_KEYS])('closed when %s is false', (key) =>
    expect(helpReadiness({ ...allHelp, [key]: false })).toEqual({ ready: false, reasonCode: 'NOT_READY', missing: [key] }),
  );
  test('counsel is a condition for the help lane too (HL-D2), and the BAA for real use', () =>
    expect(HELP_READINESS_KEYS).toEqual(expect.arrayContaining(['counselViewRecorded', 'baaExecuted', 'howHelpAnswersArticleSigned'])));
  test('only the boolean true counts', () => {
    for (const v of ['true', 1, null]) expect(helpReadiness({ ...allHelp, founderFlagSet: v as unknown as boolean }).ready).toBe(false);
  });
  test('the help live gate is closed: nothing can call a model for Help', () => expect(helpLiveReadiness()).toEqual({ ready: false, reasonCode: 'MODEL_EXECUTION_DISABLED' }));
});
