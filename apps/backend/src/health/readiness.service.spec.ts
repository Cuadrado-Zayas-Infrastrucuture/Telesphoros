import { expectAppException } from '../../test/helpers/expect-app-exception';
import { AppException } from '../common/app-exception';
import { CHECK_TIMEOUT_MS, ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  it('is ready when there is nothing to check, and lists each healthy dependency', async () => {
    await expect(new ReadinessService([]).run()).resolves.toEqual({ status: 'ready', checks: {} });
    await expect(
      new ReadinessService([{ name: 'db', check: async () => undefined }]).run(),
    ).resolves.toEqual({ status: 'ready', checks: { db: 'up' } });
  });

  it('fails with 503 naming only what is down, never why', async () => {
    const service = new ReadinessService([
      { name: 'db', check: async () => { throw new Error('password authentication failed for user admin'); } },
      { name: 'cache', check: async () => undefined },
    ]);
    const error = await service.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).details).toEqual([{ field: 'db', message: 'unavailable' }]);
    expect(JSON.stringify((error as AppException).details)).not.toContain('password');
  });

  it('bounds every probe with a timeout so a hung dependency cannot hang readiness', async () => {
    jest.useFakeTimers();
    try {
      const pending = expectAppException(
        new ReadinessService([{ name: 'slow', check: () => new Promise<void>(() => undefined) }]).run(),
        503,
        'SERVICE_UNAVAILABLE',
      );
      await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 1);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });
});
