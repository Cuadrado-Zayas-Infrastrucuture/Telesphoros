import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth/principal';
import type { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { Projected } from '../storage/ledger-records';
import { DisputesService } from './disputes.service';

const principal = { tenantId: 'syn-tenant', sub: 'syn-reviewer' } as Principal;
const id = randomUUID();
const dispute = { id, tenantId: 'syn-tenant', seq: '1', createdBy: 'syn', createdAt: 'syn', guidelineId: 'syn', guidelineVersion: '1', guidelineContentSha256: 'a'.repeat(64), locatorTable: 'T', locatorRow: 'R', locatorColumn: null };
const result = { drug: 'synthetic', outcome: 'shown', recommendationText: 'private synthetic wording', citation: { guidelineId: 'syn', guidelineVersion: '1', locator: { table: 'T', row: 'R', column: null } } };
const record = (seq: string, hash?: string): Projected => ({ id: randomUUID(), reportId: randomUUID(), tenantId: 'syn-tenant', seq, createdBy: 'syn', createdAt: 'syn', results: [result], binding: hash ? { cellProvenance: { version: 'cell-provenance/1', files: [{ guidelineId: 'syn', guidelineVersion: '1', contentSha256: hash }] } } : {} });

it('uses the stored dispute, keeps unverified history distinct, and advances a sparse page over excluded versions', async () => {
  const historical = record('2'); const exact = record('3', 'a'.repeat(64)); const wrong = record('4', 'b'.repeat(64));
  const repo = { findDispute: jest.fn().mockResolvedValue({ dispute, status: 'dismissed', decision: null }), cellEvaluationCandidates: jest.fn().mockResolvedValue([historical, exact]), evaluationState: jest.fn().mockResolvedValue({ state: 'superseded', by: randomUUID() }) };
  // No current knowledge dependency: historical inquiries survive a knowledge replacement or removal.
  const service = new DisputesService(repo as unknown as LedgerRecordsRepository);
  const page = await service.evaluations(principal, id, { afterSeq: '0', limit: 1 });
  expect(page.entries).toMatchObject([{ evaluationId: historical.id, state: 'superseded', matches: [{ identity: 'historical-identity-unverified' }] }]);
  expect(page.nextAfterSeq).toBe('2');
  expect(repo.cellEvaluationCandidates).toHaveBeenCalledWith('syn-tenant', expect.objectContaining({ guidelineContentSha256: 'a'.repeat(64) }), '0', 2);
  repo.cellEvaluationCandidates.mockResolvedValue([wrong, exact]);
  expect(await service.evaluations(principal, id, { afterSeq: '3', limit: 1 })).toMatchObject({ entries: [], nextAfterSeq: '4', actionable: false });
  repo.cellEvaluationCandidates.mockResolvedValue([exact]);
  expect(await service.evaluations(principal, id, { afterSeq: '4', limit: 1 })).toMatchObject({ entries: [{ matches: [{ identity: 'exact-file' }] }], nextAfterSeq: null });
});
it('returns not found for an inaccessible dispute before querying any evaluation', async () => {
  const repo = { findDispute: jest.fn().mockResolvedValue(undefined), cellEvaluationCandidates: jest.fn() };
  await expect(new DisputesService(repo as unknown as LedgerRecordsRepository).evaluations(principal, id, { afterSeq: '0', limit: 50 })).rejects.toMatchObject({ status: 404 });
  expect(repo.cellEvaluationCandidates).not.toHaveBeenCalled();
});
