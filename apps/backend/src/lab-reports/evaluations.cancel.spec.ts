import { createHash } from 'node:crypto';
import { expectAppException } from '../../test/helpers/expect-app-exception';
import type { Principal } from '../auth/principal';
import { failureResult, type ReaderResult } from '../services/report-reader/reader-result';
import type { ReportReader } from '../services/report-reader/report-reader';
import { EvaluationsService } from './evaluations.service';
import { ReaderLimiter } from './reader-limiter';

// The cancellable boundary of a synchronous evaluation, with stand-ins for everything around the reader: a cancelled evaluation stores
// nothing, even when the reader ignores the signal and answers late.
const principal: Principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [] };
const text = 'synthetic captured text';
const sha256 = createHash('sha256').update(text).digest('hex');

function setup(read: ReportReader['read']) {
  const report = { id: 'report-1', type: 'lab-pdf', patientId: 'patient-1', sha256: 'file-sha', objectVersion: 'v1' };
  const capture = { id: 'capture-1', reportId: report.id, textStorageKey: 'key', textSha256: sha256 };
  const acceptance = { id: 'acceptance-1', captureId: capture.id, decision: 'accepted' };
  const ledger = {
    findCapture: jest.fn(async () => capture),
    findAcceptance: jest.fn(async () => acceptance),
    latestAcceptance: jest.fn(async () => acceptance),
    latestPatientDecision: jest.fn(async () => ({
      id: 'link-1',
      decision: 'verified',
      reportSha256: report.sha256,
      objectVersion: report.objectVersion,
      patientId: report.patientId,
    })),
    listDisputes: jest.fn(async () => []),
    insertEvaluation: jest.fn(),
  };
  const reader = { read: jest.fn(read) };
  const limiter = new ReaderLimiter(1);
  const service = new EvaluationsService(
    { findById: async () => report } as never,
    { getObject: async () => ({ bytes: Buffer.from(text), sha256 }) } as never,
    limiter,
    {} as never,
    ledger as never,
    {} as never,
    {} as never,
    reader,
  );
  return { service, ledger, reader, limiter };
}

const body = { captureId: 'capture-1', acceptanceId: 'acceptance-1' } as never;

describe('cancelling an evaluation', () => {
  it('without cancellation, uses the read result as before (control: an operational failure is 503 READER_UNAVAILABLE)', async () => {
    const { service, reader, limiter } = setup(async () => failureResult('worker-error'));
    await expectAppException(service.create(principal, 'report-1', body, { signal: new AbortController().signal }), 503, 'READER_UNAVAILABLE');
    expect(reader.read).toHaveBeenCalledWith(text, { signal: expect.any(AbortSignal) });
    expect(limiter.active).toBe(0);
  });

  it('does not run the reader or take a slot when already cancelled', async () => {
    const { service, reader, ledger, limiter } = setup(async () => failureResult('worker-error'));
    const controller = new AbortController();
    controller.abort();
    await expect(service.create(principal, 'report-1', body, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(reader.read).not.toHaveBeenCalled();
    expect(ledger.insertEvaluation).not.toHaveBeenCalled();
    expect(limiter.active).toBe(0);
  });

  it('stores nothing when cancelled during a read whose reader ignores the signal and answers late', async () => {
    const controller = new AbortController();
    const { service, ledger, limiter } = setup(async () => {
      controller.abort(); // cancelled while reading...
      await new Promise((r) => setTimeout(r, 20));
      return failureResult('source-limit') as ReaderResult; // ...and a late answer that, uncancelled, would go on to be evaluated
    });
    await expect(service.create(principal, 'report-1', body, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ledger.listDisputes).not.toHaveBeenCalled();
    expect(ledger.insertEvaluation).not.toHaveBeenCalled();
    expect(limiter.active).toBe(0);
  });
});
