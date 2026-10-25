import { expectAppException } from '../../test/helpers/expect-app-exception';
import { SubprocessReportReader } from '../services/report-reader/subprocess-report-reader';
import { ReaderLimiter } from './reader-limiter';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('ReaderLimiter', () => {
  it('lets up to the cap run at once and turns the next away at once with 503 PIPELINE_BUSY (nothing is queued)', async () => {
    const limiter = new ReaderLimiter(2);
    const [a, b] = [deferred(), deferred()];
    const first = limiter.run(() => a.promise);
    const second = limiter.run(() => b.promise);
    expect(limiter.active).toBe(2);
    await expectAppException(
      limiter.run(async () => 'never runs'),
      503,
      'PIPELINE_BUSY',
    );
    expect(limiter.active).toBe(2); // the refused call took nothing
    a.resolve();
    await first;
    expect(limiter.active).toBe(1);
    expect(await limiter.run(async () => 'runs again')).toBe('runs again'); // control: a freed slot is usable
    b.resolve();
    await second;
    expect(limiter.active).toBe(0);
  });

  it.each([
    ['throws', () => Promise.reject(new Error('boom'))],
    [
      'rejects late',
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('late');
      },
    ],
  ])('releases the slot when the work %s', async (_name, work) => {
    const limiter = new ReaderLimiter(1);
    await expect(limiter.run(work)).rejects.toThrow();
    expect(limiter.active).toBe(0);
    expect(await limiter.run(async () => 'ok')).toBe('ok');
  });

  it.each([
    ['exits non-zero', ['sh', '-c', 'exit 3']],
    ['cannot be started', ['/no/such/command-for-the-reader']],
    ['runs past its deadline', ['sh', '-c', 'sleep 30']],
  ])(
    'releases the slot when the real reader %s (it answers with a failure result, never hangs the slot)',
    async (_name, command) => {
      const limiter = new ReaderLimiter(1);
      const reader = new SubprocessReportReader({ mode: 'non-production', command, deadlineMs: 300, killGraceMs: 100 });
      const result = await limiter.run(() => reader.read('some text'));
      expect(result.packet.schema).toBe('pgx-span-processing-failure/1');
      expect(limiter.active).toBe(0);
      expect(await limiter.run(async () => 'ok')).toBe('ok');
    },
    10_000,
  );

  it('refuses a cap that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new ReaderLimiter(bad)).toThrow(RangeError);
  });
});
