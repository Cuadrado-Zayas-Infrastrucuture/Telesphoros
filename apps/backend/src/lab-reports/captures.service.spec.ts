import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { expectAppException } from '../../test/helpers/expect-app-exception';
import type { Principal } from '../auth/principal';
import { DataOriginError } from '../ledger/data-origin';
import { InMemoryObjectStorage } from '../object-storage/in-memory-object-storage';
import type { ObjectStorage } from '../object-storage/object-storage';
import { type FetchedObject } from '../object-storage/object-storage';
import type { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { InMemoryReportsRepository } from '../storage/reports.repository';
import type { ReportRecord } from '../storage/records';
import { CapturesService } from './captures.service';
import { PipelineSwitch } from './pipeline-switch';
import type { TextCaptureRunner } from './runner/text-capture-runner';

// Cases that need a storage or ledger that misbehaves on purpose, which a real store will not do.
const pipeline = new PipelineSwitch({ NODE_ENV: 'test', LAB_REPORT_PIPELINE: 'enabled', DOWNLOAD_URL_TTL_SECONDS: 120 } as Env);
const principal = (roles: Principal['roles']): Principal => ({ sub: 'syn-person', tenantId: 'tenant-unit', roles });
const runnerFor = (text = 'synthetic text'): TextCaptureRunner => ({ name: 'fake', manifestSha256: 'f'.repeat(64), capture: async () => ({ text, popplerVersion: '26.03.0' }) });

async function setup(storage: ObjectStorage = new InMemoryObjectStorage()) {
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
  const ledger = { findCaptureByIdentity: jest.fn(), insertCapture: jest.fn(), latestAcceptance: jest.fn() } as unknown as jest.Mocked<LedgerRecordsRepository>;
  return { service: new CapturesService(reports, storage, pipeline, ledger, runnerFor()), report, ledger };
}

class WrongBytesStorage extends InMemoryObjectStorage {
  constructor(private readonly answer: Partial<FetchedObject>) {
    super();
  }
  override async getObject(): Promise<FetchedObject> {
    return { sizeBytes: 3, contentType: 'application/pdf', sha256: 'b'.repeat(64), version: 'v1', bytes: Buffer.from('abc'), ...this.answer };
  }
}

describe('CapturesService: the retrieved object must be the verified one', () => {
  it("refuses bytes whose hash is not the report's, even when the store answers for the pinned version (no capture, no text written)", async () => {
    const storage = new WrongBytesStorage({ sha256: 'b'.repeat(64) });
    const put = jest.spyOn(storage, 'putObject');
    const { service, report, ledger } = await setup(storage);
    await expectAppException(service.capture(principal(['clinician']), report.id), 409, 'CONFLICT');
    expect(put).not.toHaveBeenCalled();
    expect(ledger.insertCapture).not.toHaveBeenCalled();
  });

  it('refuses an answer for a different version than the one pinned', async () => {
    const { service, report, ledger } = await setup(new WrongBytesStorage({ sha256: 'a'.repeat(64), version: 'v2' }));
    await expectAppException(service.capture(principal(['clinician']), report.id), 409, 'CONFLICT');
    expect(ledger.insertCapture).not.toHaveBeenCalled();
  });

  it('proceeds when hash and version both match (control)', async () => {
    const { service, report, ledger } = await setup(new WrongBytesStorage({ sha256: 'a'.repeat(64), version: 'v1' }));
    ledger.findCaptureByIdentity.mockResolvedValue(undefined);
    ledger.insertCapture.mockRejectedValue(new Error('reached the ledger')); // proves it got past the checks
    await expect(service.capture(principal(['clinician']), report.id)).rejects.toThrow('reached the ledger');
  });
});

describe('CapturesService: file links are for the roles that may open files', () => {
  it.each([['reader'], ['none']])('refuses a link to %s even if a route let them through', async (role) => {
    const { service, report } = await setup();
    const who = principal(role === 'none' ? [] : ['reader']);
    await expectAppException(service.pdfLink(who, report.id), 403, 'FORBIDDEN');
    await expectAppException(service.textLink(who, randomUUID()), 403, 'FORBIDDEN');
  });

  it('issues a PDF link for the pinned version to a clinician (control)', async () => {
    const { service, report } = await setup();
    const link = await service.pdfLink(principal(['clinician']), report.id);
    expect(link.url).toContain('versionId=v1');
  });
});

describe('CapturesService: the origin of the data (spec 020 E1a)', () => {
  it('names the origin first and passes it to the ledger: synthetic while the pipeline cannot run in production', async () => {
    const { service, report, ledger } = await setup(new WrongBytesStorage({ sha256: 'a'.repeat(64) })); // the pinned version, with the report's hash
    ledger.findCaptureByIdentity.mockResolvedValue(undefined);
    ledger.insertCapture.mockRejectedValue(new Error('stop here: the call is what is asserted'));
    await expect(service.capture(principal(['clinician']), report.id)).rejects.toThrow('stop here');
    expect(ledger.insertCapture).toHaveBeenCalledWith('tenant-unit', 'syn-person', expect.objectContaining({ origin: 'synthetic' }));
  });

  it('refuses to capture, before reading or storing anything, when the origin cannot be named (production)', async () => {
    const storage = new InMemoryObjectStorage();
    const read = jest.spyOn(storage, 'getObject');
    const put = jest.spyOn(storage, 'putObject');
    const { report, ledger } = await setup(storage);
    const production = new PipelineSwitch({ NODE_ENV: 'production', LAB_REPORT_PIPELINE: 'enabled', DOWNLOAD_URL_TTL_SECONDS: 120 } as Env);
    const reports = new InMemoryReportsRepository();
    const service = new CapturesService(reports, storage, production, ledger, runnerFor());
    await expect(service.capture(principal(['clinician']), report.id)).rejects.toBeInstanceOf(DataOriginError);
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(ledger.insertCapture).not.toHaveBeenCalled();
  });
});

describe('CapturesService without its collaborators', () => {
  it('answers PIPELINE_MISCONFIGURED, never a crash, if it is reached without the ledger or the runner', async () => {
    const reports = new InMemoryReportsRepository();
    const service = new CapturesService(reports, new InMemoryObjectStorage(), pipeline);
    await expectAppException(service.capture(principal(['clinician']), randomUUID()), 500, 'PIPELINE_MISCONFIGURED');
    await expectAppException(service.get(principal(['clinician']), randomUUID()), 500, 'PIPELINE_MISCONFIGURED');
  });
});
