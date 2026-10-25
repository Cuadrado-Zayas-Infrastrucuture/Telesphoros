import { randomUUID } from 'node:crypto';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { DisputeRequestReusedError, type LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { DisputesService } from './disputes.service';

// What the service hands the ledger when a dispute carries a retry id, what it shows for a replayed dispute, and how it answers when the ledger refuses a reused id.
const reviewer: Principal = { sub: 'syn-reviewer', tenantId: 'tenant-unit', roles: ['reviewer'] };
const body = { guidelineId: 'syn-guideline', locator: { table: 'recommendations', row: 'r1' }, note: 'reads wrongly' };

function setup() {
  const cells = [
    { table: 'recommendations', row: 'r1' },
    { table: 'recommendations', row: 'r2' },
    { table: 't2', row: 'r1' },
    { table: 'recommendations', row: 'r1', column: 'c' },
  ];
  const guideline = (id: string) => ({ id, guidelineVersion: '1', recommendations: cells.map((locator) => ({ locator })) });
  const knowledge = {
    allGuidelines: () => [guideline('syn-guideline'), guideline('other')],
    files: [
      { kind: 'guideline', id: 'syn-guideline', contentSha256: 'c'.repeat(64) },
      { kind: 'guideline', id: 'other', contentSha256: 'd'.repeat(64) },
    ],
  } as unknown as KnowledgeSet;
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    tenantId: 'tenant-unit',
    seq: '1',
    createdBy: 'syn-reviewer',
    createdAt: now,
    guidelineId: 'syn-guideline',
    guidelineVersion: '1',
    guidelineContentSha256: 'c'.repeat(64),
    locatorTable: 'recommendations',
    locatorRow: 'r1',
    locatorColumn: null,
    note: null,
  };
  const ledger = {
    raiseDispute: jest.fn().mockResolvedValue({ record, created: true }),
    findDispute: jest.fn(),
  } as unknown as jest.Mocked<LedgerRecordsRepository>;
  return { service: new DisputesService(ledger, knowledge), ledger, record };
}

describe('DisputesService.raise with a retry id', () => {
  it('passes the id and a fingerprint of the guideline, the cell and the note to the ledger', async () => {
    const { service, ledger } = setup();
    const requestId = randomUUID();
    await service.raise(reviewer, { ...body, requestId });
    expect(ledger.raiseDispute.mock.calls[0]![2].request).toEqual({ id: requestId, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('gives the same fingerprint for the same request and another for any change in guideline, table, row, column or note', async () => {
    const { service, ledger } = setup();
    const requestId = randomUUID();
    const variants = [
      body,
      body,
      { ...body, note: 'other' },
      { ...body, locator: { ...body.locator, row: 'r2' } },
      { ...body, locator: { ...body.locator, table: 't2' } },
      { ...body, locator: { ...body.locator, column: 'c' } },
      { ...body, guidelineId: 'other' },
    ];
    for (const variant of variants) await service.raise(reviewer, { ...variant, requestId });
    const hashes = ledger.raiseDispute.mock.calls.map((call) => call[2].request!.hash);
    expect(hashes).toHaveLength(variants.length);
    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes).size).toBe(variants.length - 1);
  });

  it('sends no retry identity when the body has none', async () => {
    const { service, ledger } = setup();
    await service.raise(reviewer, body);
    expect(ledger.raiseDispute.mock.calls[0]![2]).not.toHaveProperty('request');
  });

  it('shows the dispute as it is now when the ledger answers with one it already had (a replay after a decision is not shown as open)', async () => {
    const { service, ledger, record } = setup();
    ledger.raiseDispute.mockResolvedValue({ record, created: false } as never);
    ledger.findDispute.mockResolvedValue({
      dispute: record,
      status: 'dismissed',
      decision: { id: randomUUID(), decision: 'dismissed', createdBy: 'syn-decider', createdAt: record.createdAt, evidenceNote: null },
    } as never);
    const shown = await service.raise(reviewer, { ...body, requestId: randomUUID() });
    expect(shown.status).toBe('dismissed');
    expect(ledger.findDispute).toHaveBeenCalledWith('tenant-unit', record.id);
  });

  it('answers 409 request-id-reused when the ledger says the id belongs to a different dispute', async () => {
    const { service, ledger } = setup();
    ledger.raiseDispute.mockRejectedValue(new DisputeRequestReusedError());
    const error = await service.raise(reviewer, { ...body, requestId: randomUUID() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code: 'CONFLICT', details: [expect.objectContaining({ reason: 'request-id-reused' })] });
    expect((error as AppException).getStatus()).toBe(409);
  });
});
