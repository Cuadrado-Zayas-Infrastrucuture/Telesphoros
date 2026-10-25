import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  buildMeta,
  type Paginated,
  type PaginationQuery,
  type PatientLinkDecisionCreate,
  type PatientLinkDecisionDto,
  type PatientLinkDto,
  type QuarantineEntryDto,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { SourceChangedError } from '../ledger/ledger-types';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { PatientIdentifiersRepository } from '../storage/patient-identifiers.repository';
import type { ReportRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';
import { IdentifierDigest } from './identifier-digest';
import { linkState } from './link-state';
import { toDecisionDto, toLinkDto } from './patient-identity.mapper';

/**
 * The recorded decision that a report's exact file version belongs to a patient. The decision is a ledger record, so the ledger's rules apply
 * (append-only, one event, covered by the verifier). Everything that can be refused is refused before anything is written.
 */
@Injectable()
export class PatientLinkService {
  private readonly digest: IdentifierDigest;

  constructor(
    private readonly reports: ReportsRepository,
    private readonly identifiers: PatientIdentifiersRepository,
    @Inject(ENV) env: Env,
    @Optional() private readonly ledger?: LedgerRecordsRepository,
  ) {
    this.digest = new IdentifierDigest(env.IDENTIFIER_DIGEST_KEY);
  }

  private need<T>(dependency: T | undefined | null): T {
    if (dependency === undefined || dependency === null) throw AppException.pipelineMisconfigured();
    return dependency;
  }

  private async requireReport(principal: Principal, reportId: string): Promise<ReportRecord> {
    const report = await this.reports.findById(principal.tenantId, reportId);
    if (!report) throw AppException.notFound('Report not found.');
    return report;
  }

  /**
   * The reviewer's work list (M2.1c-1): reports whose link was rejected for the file they hold now and that still have an active evaluation. Nothing is
   * written here and no correction is made for the reviewer: each evaluation is retracted (`wrong-patient`) by a person.
   */
  async quarantine(principal: Principal, { page, pageSize }: PaginationQuery): Promise<Paginated<QuarantineEntryDto>> {
    const { items, total } = await this.need(this.ledger).pageQuarantine(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize });
    return {
      data: items.map((e) => ({ reportId: e.reportId, patientId: e.patientId, basisCode: e.basisCode, rejectedAt: e.rejectedAt, activeEvaluationIds: e.activeEvaluationIds })),
      meta: buildMeta(page, pageSize, total),
    };
  }

  async get(principal: Principal, reportId: string): Promise<PatientLinkDto> {
    const report = await this.requireReport(principal, reportId);
    const newest = await this.need(this.ledger).latestPatientDecision(principal.tenantId, report.id);
    return toLinkDto(report.id, report.patientId, linkState(report, newest));
  }

  /**
   * Whoever decides is none of: the report's creator, who asked for its first upload link, who completed the upload (the database repeats the
   * rule; this gives the clear answer first). A match that does not match records NOTHING: it answers 409 and the person tries again or attests.
   */
  async decide(principal: Principal, reportId: string, body: PatientLinkDecisionCreate): Promise<{ decision: PatientLinkDecisionDto; created: boolean }> {
    const ledger = this.need(this.ledger);
    const report = await this.requireReport(principal, reportId);
    if (!report.uploadedAt || !report.sha256 || !report.objectVersion) {
      throw AppException.conflictBecause('not-uploaded', 'The file for this report has not been uploaded and verified yet.');
    }
    if ([report.createdBy, report.uploadRequestedBy, report.uploadedBy].includes(principal.sub)) {
      throw AppException.conflictBecause('self-review', 'You took part in registering or uploading this report, so you cannot decide whose it is. Another person must.');
    }

    let basis: { basisCode?: string; identifierId?: string };
    if (body.method === 'identifier-match') {
      const found = await this.identifiers.findActiveOfPatient(principal.tenantId, report.patientId, body.system, this.digest.digest(principal.tenantId, body.system, body.value));
      if (!found) throw AppException.conflictBecause('identifier-mismatch', "That identifier is not registered for this report's patient. Nothing was recorded.");
      basis = { identifierId: found.id };
    } else {
      basis = { basisCode: body.basisCode };
    }

    try {
      const stored = await ledger.insertPatientDecision(principal.tenantId, principal.sub, {
        reportId: report.id,
        expectedReport: { patientId: report.patientId, sha256: report.sha256, objectVersion: report.objectVersion },
        decision: body.decision,
        method: body.method,
        ...basis,
      });
      return { decision: toDecisionDto(stored.record), created: stored.created };
    } catch (error) {
      if (error instanceof SourceChangedError)
        throw AppException.conflictBecause('source-changed', 'The report changed while you were deciding. Nothing was recorded; look at it again.');
      throw error;
    }
  }
}
