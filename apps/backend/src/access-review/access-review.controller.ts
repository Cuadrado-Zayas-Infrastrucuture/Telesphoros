import { Controller, Get, Header, Query } from '@nestjs/common';
import {
  ACCESS_REVIEW_CSV_HEADER,
  ACCESS_REVIEW_EXPORT_MAX_ROWS,
  ACCESS_REVIEW_PAGE_SIZE,
  type AccessReviewPage,
  type AccessReviewQuery,
  accessReviewQuerySchema,
  type AccessReviewRow,
  accessReviewWindow,
} from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccessReviewRepository, type AuditReadRow } from './access-review.repository';
import { subjectKindOf } from './route-keys';

const BATCH = 200; // the database function returns at most 201 rows per call

/**
 * Spec 046: an administrator's review of who read which patient, over the existing access audit. Admin only, here and in the database. Ids, route
 * keys, outcomes and times; no label and no clinical value, because the admin role sees no clinical data (D3, AR-6). Its own reads are audited by
 * the same interceptor as every other private read.
 */
@Controller('access-review')
export class AccessReviewController {
  constructor(private readonly repository: AccessReviewRepository) {}

  @Get()
  @Roles('admin')
  async list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(accessReviewQuerySchema)) query: AccessReviewQuery): Promise<AccessReviewPage> {
    const { from, to } = accessReviewWindow(query);
    const subjects = await this.subjects(principal, query);
    const rows = await this.repository.reads(principal.tenantId, principal.sub, {
      member: query.member,
      subjects,
      from,
      to,
      limit: ACCESS_REVIEW_PAGE_SIZE + 1,
      offset: (query.page - 1) * ACCESS_REVIEW_PAGE_SIZE,
    });
    const shown = rows.slice(0, ACCESS_REVIEW_PAGE_SIZE);
    return {
      data: await this.resolve(principal, shown, query.patientId),
      page: query.page,
      hasMore: rows.length > ACCESS_REVIEW_PAGE_SIZE,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  @Get('export')
  @Roles('admin')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(accessReviewQuerySchema)) query: AccessReviewQuery): Promise<string> {
    const { from, to } = accessReviewWindow(query);
    const subjects = await this.subjects(principal, query);
    const all: AuditReadRow[] = [];
    while (all.length < ACCESS_REVIEW_EXPORT_MAX_ROWS) {
      const batch = await this.repository.reads(principal.tenantId, principal.sub, { member: query.member, subjects, from, to, limit: BATCH, offset: all.length });
      all.push(...batch.slice(0, ACCESS_REVIEW_EXPORT_MAX_ROWS - all.length));
      if (batch.length < BATCH) break;
    }
    const rows = await this.resolve(principal, all, query.patientId);
    const cell = (v: string | null) => (v === null ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = rows.map((r) => [r.occurredAt, r.member, r.routeKey, r.event, r.outcome, r.subjectKind, r.subjectId, r.patientId].map(cell).join(','));
    return `${[ACCESS_REVIEW_CSV_HEADER, ...lines].join('\n')}\n`;
  }

  /** A review by patient: the rows whose subject is the patient or one of the patient's evaluations or reports. Otherwise no subject filter. */
  private async subjects(principal: Principal, query: AccessReviewQuery): Promise<string[] | undefined> {
    if (!query.patientId) return undefined;
    const { evaluations, reports } = await this.repository.recordsOf(principal.tenantId, principal.sub, query.patientId);
    return [query.patientId, ...evaluations, ...reports];
  }

  private async resolve(principal: Principal, rows: AuditReadRow[], knownPatient: string | undefined): Promise<AccessReviewRow[]> {
    const kinds = rows.map((r) => subjectKindOf(r.routeKey));
    const ids = { evaluations: [] as string[], reports: [] as string[] };
    rows.forEach((r, i) => {
      if (r.subjectId && kinds[i] === 'evaluation') ids.evaluations.push(r.subjectId);
      if (r.subjectId && kinds[i] === 'report') ids.reports.push(r.subjectId);
    });
    const patients =
      knownPatient || (ids.evaluations.length === 0 && ids.reports.length === 0)
        ? new Map<string, string>()
        : await this.repository.patientsOf(principal.tenantId, principal.sub, ids);
    return rows.map((r, i) => {
      const kind = r.subjectId ? kinds[i]! : 'other';
      const patientId = kind === 'patient' ? r.subjectId : kind === 'evaluation' || kind === 'report' ? (knownPatient ?? patients.get(r.subjectId!) ?? null) : null;
      return {
        occurredAt: r.occurredAt.toISOString(),
        member: r.member,
        routeKey: r.routeKey,
        event: r.event,
        outcome: r.outcome,
        subjectKind: kind,
        subjectId: r.subjectId,
        patientId,
      };
    });
  }
}
