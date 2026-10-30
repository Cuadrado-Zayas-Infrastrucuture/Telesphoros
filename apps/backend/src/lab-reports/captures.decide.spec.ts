import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { InMemoryObjectStorage } from '../object-storage/in-memory-object-storage';
import { CaptureDecisionRequestReusedError, type LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { InMemoryReportsRepository } from '../storage/reports.repository';
import type { ReportRecord } from '../storage/records';
import { CapturesService } from './captures.service';
import { PipelineSwitch } from './pipeline-switch';
import type { TextCaptureRunner } from './runner/text-capture-runner';

// What the service hands the ledger when a decision carries a retry id, and how it answers when the ledger refuses a reused one.
const pipeline = new PipelineSwitch({ NODE_ENV: 'test', LAB_REPORT_PIPELINE: 'enabled', DOWNLOAD_URL_TTL_SECONDS: 120 } as Env);
const reviewer: Principal = { sub: 'syn-reviewer', tenantId: 'tenant-unit', roles: ['clinician'] };
const runner: TextCaptureRunner = { name: 'fake', manifestSha256: 'f'.repeat(64), capture: async () => ({ text: 't', popplerVersion: '26.03.0' }) };

async function setup() {
  const reports = new InMemoryReportsRepository();
  const now = new Date().toISOString();
  const report: ReportRecord = {
    id: randomUUID(),
    tenantId: 'tenant-unit',
    createdBy: 'syn-creator',
    patientId: randomUUID(),
    type: 'lab-pdf',
    filename: 'a.pdf',
    sizeBytes: 10,
    status: 'received',
    storageKey: 'reports/x/k',
    contentType: 'application/pdf',
    sha256: 'a'.repeat(64),
    uploadedAt: now,
    objectVersion: 'v1',
    uploadRequestedBy: 'syn-creator',
    uploadedBy: 'syn-creator',
    createdAt: now,
    updatedAt: now,
  };
  await reports.insert(report);
  const captureId = randomUUID();
  const record = { id: captureId, captureId, decision: 'accepted', textSha256: 'b'.repeat(64), popplerVersion: '26.03.0', note: null, createdAt: now };
  const ledger = {
    findCapture: jest.fn().mockResolvedValue({ id: captureId, reportId: report.id, createdBy: 'syn-creator', textSha256: 'b'.repeat(64), popplerVersion: '26.03.0' }),
    insertAcceptance: jest.fn().mockResolvedValue({ record, created: true }),
  } as unknown as jest.Mocked<LedgerRecordsRepository>;
  return { service: new CapturesService(reports, new InMemoryObjectStorage(), pipeline, ledger, runner), ledger, captureId };
}

const requestOf = (ledger: jest.Mocked<LedgerRecordsRepository>) => ledger.insertAcceptance.mock.calls[0]![2].request;

describe('CapturesService.decide with a retry id', () => {
  it('passes the id and a fingerprint of the capture, the decision and the note to the ledger', async () => {
    const { service, ledger, captureId } = await setup();
    const requestId = randomUUID();
    await service.decide(reviewer, captureId, { decision: 'accepted', note: 'checked', requestId });
    expect(requestOf(ledger)).toEqual({ id: requestId, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('gives the same fingerprint for the same request and another for any change in capture, decision or note', async () => {
    const { service, ledger, captureId } = await setup();
    const otherCapture = randomUUID();
    const found = await ledger.findCapture('tenant-unit', captureId);
    ledger.findCapture.mockImplementation(async (_tenant, id) => ({ ...found!, id }));
    const requestId = randomUUID();
    const calls: Array<[string, 'accepted' | 'rejected', string | undefined]> = [
      [captureId, 'accepted', 'n'],
      [captureId, 'accepted', 'n'],
      [captureId, 'rejected', 'n'],
      [captureId, 'accepted', 'other'],
      [captureId, 'accepted', undefined],
      [otherCapture, 'accepted', 'n'],
    ];
    for (const [id, decision, note] of calls) await service.decide(reviewer, id, { decision, requestId, ...(note === undefined ? {} : { note }) });
    const hashes = ledger.insertAcceptance.mock.calls.map((call) => call[2].request!.hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes).size).toBe(5);
  });

  it('sends no retry identity when the body has none', async () => {
    const { service, ledger, captureId } = await setup();
    await service.decide(reviewer, captureId, { decision: 'accepted' });
    expect(ledger.insertAcceptance.mock.calls[0]![2]).not.toHaveProperty('request');
  });

  it('answers 409 request-id-reused when the ledger says the id belongs to a different decision', async () => {
    const { service, ledger, captureId } = await setup();
    ledger.insertAcceptance.mockRejectedValue(new CaptureDecisionRequestReusedError());
    const error = await service.decide(reviewer, captureId, { decision: 'rejected', requestId: randomUUID() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code: 'CONFLICT', details: [expect.objectContaining({ reason: 'request-id-reused' })] });
    expect((error as AppException).getStatus()).toBe(409);
  });
});
