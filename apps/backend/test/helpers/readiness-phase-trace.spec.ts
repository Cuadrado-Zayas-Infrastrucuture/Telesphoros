import { createReadinessPhaseTrace } from './readiness-phase-trace';

it('records a start before the work and a returned result without serializing it', async () => {
  const lines: string[] = [];
  const times = [10, 13.6];
  const trace = createReadinessPhaseTrace(
    (line) => lines.push(line),
    () => times.shift()!,
  );
  const result = { privateValue: 'SYN-RESULT-NOT-FOR-LOGS' };
  expect(
    await trace('fixture-create', async () => {
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({ diagnostic: 'readiness-phases-v1', sequence: 1, phase: 'fixture-create', event: 'start', elapsedMs: 0 });
      return result;
    }),
  ).toBe(result);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { diagnostic: 'readiness-phases-v1', sequence: 1, phase: 'fixture-create', event: 'start', elapsedMs: 0 },
    { diagnostic: 'readiness-phases-v1', sequence: 2, phase: 'fixture-create', event: 'returned', elapsedMs: 4 },
  ]);
  expect(lines.join('')).not.toContain(result.privateValue);
});

it('preserves the exact rejection but emits no error object or message', async () => {
  const lines: string[] = [];
  const trace = createReadinessPhaseTrace(
    (line) => lines.push(line),
    () => 20,
  );
  const error = new Error('SYN-ERROR-NOT-FOR-LOGS');
  await expect(
    trace('database-drop', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(lines.map((line) => JSON.parse(line).event)).toEqual(['start', 'threw']);
  expect(lines.join('')).not.toContain(error.message);
});

it('keeps a pending phase visible before a callback settles', async () => {
  const lines: string[] = [];
  const trace = createReadinessPhaseTrace(
    (line) => lines.push(line),
    () => 30,
  );
  let finish!: () => void;
  const pending = trace(
    'failed-ready',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(lines.map((line) => JSON.parse(line).event)).toEqual(['start']);
  finish();
  await pending;
  expect(lines.map((line) => JSON.parse(line).event)).toEqual(['start', 'returned']);
});

it('refuses unknown phase data before emitting it or running work', async () => {
  const lines: string[] = [];
  const work = jest.fn(async () => undefined);
  const trace = createReadinessPhaseTrace((line) => lines.push(line));
  await expect(trace('SYN-UNTRUSTED-PHASE' as never, work)).rejects.toThrow('Unsupported readiness phase');
  expect(lines).toEqual([]);
  expect(work).not.toHaveBeenCalled();
});
