import type { CaptureAcceptance, CaptureAcceptanceStore, NewCaptureAcceptance } from '../services/report-adapter';
import type { LedgerRecordsRepository } from '../storage/ledger-records.repository';

/**
 * The adapter's view of a person's decision, read from the database. Acceptances are created only by the decision endpoint (with the
 * independence rules), so `record` refuses: nothing may write one through the adapter's interface.
 */
export class DatabaseCaptureAcceptanceStore implements CaptureAcceptanceStore {
  constructor(private readonly ledger: LedgerRecordsRepository) {}

  record(...args: [NewCaptureAcceptance]): Promise<CaptureAcceptance> {
    void args;
    return Promise.reject(new Error('Acceptances are created only through the decision endpoint.'));
  }

  async get(tenantId: string, id: string): Promise<CaptureAcceptance | null> {
    const record = await this.ledger.findAcceptance(tenantId, id);
    if (!record) return null;
    return {
      id: record.id,
      tenantId: record.tenantId,
      textSha256: record.textSha256 as string,
      popplerVersion: record.popplerVersion as string,
      decision: record.decision as 'accepted' | 'rejected',
      reviewer: { sub: record.createdBy, tenantId: record.tenantId },
      decidedAt: record.createdAt,
      note: null, // a note's text is never handed to the adapter
    };
  }
}
