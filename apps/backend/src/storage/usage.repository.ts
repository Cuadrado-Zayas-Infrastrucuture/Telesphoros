import { puertoRicoDate } from '../usage/usage-months';
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

/** A Puerto Rico day (`YYYY-MM-DD`) with at least one upload (specs/028-usage-heatmap D6). */
export interface UsageDay {
  date: string;
  reportsUploaded: number;
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
  /** Uploads completed in `[from, to)`, per Puerto Rico day, oldest first; days with none are left out. Deleted reports still count (D1). */
  abstract uploadsByDay(tenantId: string, from: Date, to: Date): Promise<UsageDay[]>;
  /** When the organization was created: the start of the years its Usage calendar offers (specs/028-usage-heatmap D5). */
  abstract createdAt(tenantId: string): Promise<Date>;
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

  async uploadsByDay(tenantId: string, from: Date, to: Date): Promise<UsageDay[]> {
    const byDay = new Map<string, number>();
    for (const { uploadedAt } of this.reports.usageRows(tenantId)) {
      if (uploadedAt === null) continue;
      const at = new Date(uploadedAt);
      if (at.getTime() < from.getTime() || at.getTime() >= to.getTime()) continue;
      const date = puertoRicoDate(at);
      byDay.set(date, (byDay.get(date) ?? 0) + 1);
    }
    return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, reportsUploaded]) => ({ date, reportsUploaded }));
  }

  /** The in-memory organization registry records no creation time, so this tier uses the earliest upload, or now when there is none. */
  async createdAt(tenantId: string): Promise<Date> {
    const uploads = this.reports.usageRows(tenantId).flatMap((row) => (row.uploadedAt === null ? [] : [Date.parse(row.uploadedAt)]));
    return new Date(uploads.length > 0 ? Math.min(...uploads) : Date.now());
  }
}
