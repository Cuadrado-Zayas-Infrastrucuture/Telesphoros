import { LedgerStatus } from '../ledger/ledger-status';
import { ledgerChainCheck } from './ledger.readiness';
import { ReadinessService } from './readiness.service';

const finding = { tenantId: 't', kind: 'payload-mismatch' as const, seq: '7', source: 'background' as const, at: new Date(0) };

describe('the ledger readiness check', () => {
  const body = (status: LedgerStatus) => new ReadinessService([ledgerChainCheck(status)]).run();

  it('is down until the check at start has passed (a log nobody has looked at is not "up")', async () => {
    await expect(body(new LedgerStatus())).rejects.toMatchObject({ status: 503, details: [{ field: 'ledger', message: 'unavailable' }] });
  });

  it('is "verifying" once the start check passed and the full walk has not finished, or is running again, and ready throughout', async () => {
    const status = new LedgerStatus();
    status.setTail('ok');
    await expect(body(status)).resolves.toEqual({ status: 'ready', checks: { ledger: 'verifying' } });
    status.setFullRunning(true);
    status.markFullCompleted();
    await expect(body(status)).resolves.toEqual({ status: 'ready', checks: { ledger: 'verifying' } });
  });

  it('is "up" when the start check passed and a full walk has finished with nothing running', async () => {
    const status = new LedgerStatus();
    status.setTail('ok');
    status.markFullCompleted();
    await expect(body(status)).resolves.toEqual({ status: 'ready', checks: { ledger: 'up' } });
  });

  it('is down for a failed or incomplete start check, even if a full walk had finished', async () => {
    for (const tail of ['failed', 'incomplete', 'not-run'] as const) {
      const status = new LedgerStatus();
      status.setTail(tail);
      status.markFullCompleted();
      await expect(body(status)).rejects.toMatchObject({ status: 503 });
    }
  });

  it('is down once latched, whatever else is true, and names nothing about what was found', async () => {
    const status = new LedgerStatus();
    status.setTail('ok');
    status.markFullCompleted();
    status.latch(finding);
    const error = await body(status).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, details: [{ field: 'ledger', message: 'unavailable' }] });
    expect(JSON.stringify((error as { details: unknown }).details)).not.toMatch(/payload|7/);
  });
});
