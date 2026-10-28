import { paginatedSchema, reportDtoSchema, reportListQuerySchema } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
import { SubmitError, type ApiFetch } from './api';

/** The list API's largest page, and how many pages a count may read (1,000 reports). */
export const REPORT_STAGE_PAGE_SIZE = 100;
export const REPORT_STAGE_MAX_PAGES = 10;

/** A count as the page shows it (1,000 not 1000), and its share of a total as a whole percent. */
export const formatCount = (value: number) => value.toLocaleString('en-US');
export const formatShare = (value: number, of: number) => (of > 0 ? `${Math.round((value / of) * 100)}%` : '0%');

export interface ReportStageCounts {
  /** Reports counted: every listed record, up to the cap. */
  registered: number;
  /** Counted reports whose file storage verified. */
  uploaded: number;
  /** Counted reports processed with a verified file; never more than `uploaded`. */
  read: number;
  /** Counted reports whose processing failed. Not a stage: shown beside the funnel. */
  failed: number;
  /** All reports the list holds for this filter. */
  total: number;
  /** True when `total` exceeds what was counted. */
  capped: boolean;
}

/**
 * Counts report stages by paging the report list (it has no status filter), with the same checks as `listReports`.
 * Synthetic records only; "Read" is system processing, not clinical review.
 */
export async function countReportStages(api: ApiFetch, signal?: AbortSignal, patientId?: string): Promise<ReportStageCounts> {
  try {
    const counts = { registered: 0, uploaded: 0, read: 0, failed: 0 };
    let total: number | undefined;
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, REPORT_STAGE_MAX_PAGES); page += 1) {
      const query = reportListQuerySchema.parse({ page, pageSize: REPORT_STAGE_PAGE_SIZE, ...(patientId ? { patientId } : {}) });
      const params = new URLSearchParams({ page: String(query.page), pageSize: String(REPORT_STAGE_PAGE_SIZE), ...(query.patientId ? { patientId: query.patientId } : {}) });
      const response = await api(`/api/v1/reports?${params}`, { signal });
      if (!response.ok) throw new Error();
      const { meta, data } = paginatedSchema(reportDtoSchema).parse(await response.json());
      if (
        meta.page !== page ||
        meta.pageSize !== REPORT_STAGE_PAGE_SIZE ||
        data.length > REPORT_STAGE_PAGE_SIZE ||
        meta.totalPages !== Math.ceil(meta.total / REPORT_STAGE_PAGE_SIZE) ||
        (total !== undefined && meta.total !== total) ||
        (page < meta.totalPages && data.length !== REPORT_STAGE_PAGE_SIZE) ||
        data.some((report) => query.patientId && report.patientId !== query.patientId)
      )
        throw new Error();
      total = meta.total;
      totalPages = meta.totalPages;
      for (const report of data) {
        counts.registered += 1;
        if (report.fileUploaded) counts.uploaded += 1;
        if (report.fileUploaded && report.status === 'processed') counts.read += 1;
        if (report.status === 'failed') counts.failed += 1;
      }
    }
    return { ...counts, total: total ?? 0, capped: (total ?? 0) > counts.registered };
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('Report stages could not be counted. Please retry.');
  }
}
