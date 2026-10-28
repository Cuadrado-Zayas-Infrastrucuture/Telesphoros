import type { InMemoryReportsRepository } from './reports.repository';

export interface UsageActivity {
  reportsUploaded: number;
  evaluated: number;
  held: number;
}

export interface UsageStorage {
  reportFiles: number;
  reportBytes: number;
}

/**
 * Counts for an organization's Usage page (specs/010-usage). Every method takes the tenant as authenticated application code knows it, never
 * from a request, and returns counts only: no ids, names or values from a record.
 */
export abstract class UsageRepository {
  /** Uploads completed and evaluation records created in `[from, to)`. Deleted reports still count as uploaded (D3). */
  abstract activity(tenantId: string, from: Date, to: Date): Promise<UsageActivity>;
  /** Uploaded, not deleted report files now, and the sum of their recorded sizes (D5). */
  abstract storage(tenantId: string): Promise<UsageStorage>;
}

/** The in-memory store keeps no evaluations (the ledger is PostgreSQL only), so it always reports none. */
export class InMemoryUsageRepository extends UsageRepository {
  constructor(private readonly reports: InMemoryReportsRepository) {
    super();
  }

  async activity(tenantId: string, from: Date, to: Date): Promise<UsageActivity> {
    const inWindow = (at: string | null) => at !== null && Date.parse(at) >= from.getTime() && Date.parse(at) < to.getTime();
    return { reportsUploaded: this.reports.usageRows(tenantId).filter((row) => inWindow(row.uploadedAt)).length, evaluated: 0, held: 0 };
  }

  async storage(tenantId: string): Promise<UsageStorage> {
    const stored = this.reports.usageRows(tenantId).filter((row) => row.uploadedAt !== null && row.deletedAt === null);
    return { reportFiles: stored.length, reportBytes: stored.reduce((sum, row) => sum + row.sizeBytes, 0) };
  }
}
