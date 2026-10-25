import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  buildMeta,
  type Paginated,
  CLINICAL_USE,
  cellUsageDtoSchema,
  type CellUsageDto,
  type CellUsageQuery,
  type DisputeCreate,
  type DisputeDecisionCreate,
  type DisputeDto,
  type DisputeListQuery,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { DisputeStatus } from '../storage/ledger-records';
import { DisputeRequestReusedError, LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { LAB_KNOWLEDGE } from './evaluations.service';
import { toDisputeDto } from './lab-report.mapper';
import { cellMatches } from './cell-usage';

/**
 * Disputes about guideline cells (specification 5). A reviewer raises one against a cell of the knowledge that is loaded NOW; a second
 * reviewer decides it. Raising or deciding never changes a stored evaluation: the effect is on what is evaluated NEXT (the overlay), and
 * earlier results are corrected, if they need to be, through a correction.
 */
@Injectable()
export class DisputesService {
  constructor(
    @Optional() private readonly ledger?: LedgerRecordsRepository,
    @Optional() @Inject(LAB_KNOWLEDGE) private readonly knowledge?: KnowledgeSet,
  ) {}

  private need(): { ledger: LedgerRecordsRepository; knowledge: KnowledgeSet } {
    if (!this.ledger || !this.knowledge) throw AppException.pipelineMisconfigured();
    return { ledger: this.ledger, knowledge: this.knowledge };
  }

  async raise(principal: Principal, body: DisputeCreate): Promise<DisputeDto> {
    const { ledger, knowledge } = this.need();
    const guideline = knowledge.allGuidelines().find((g) => g.id === body.guidelineId);
    const file = knowledge.files.find((f) => f.kind === 'guideline' && f.id === body.guidelineId);
    if (!guideline || !file) throw AppException.notFoundBecause('unknown-guideline', 'No guideline with that id is loaded.');
    const column = body.locator.column ?? null;
    const exists = guideline.recommendations.some(
      (row) => row.locator.table === body.locator.table && row.locator.row === body.locator.row && (row.locator.column ?? null) === column,
    );
    if (!exists) throw AppException.conflictBecause('unknown-cell', 'That guideline has no cell at that locator.');

    // The version and the content hash come from the loaded file, so a dispute is always about the file that is in force.
    try {
      const stored = await ledger.raiseDispute(principal.tenantId, principal.sub, {
        guidelineId: guideline.id,
        guidelineVersion: guideline.guidelineVersion,
        guidelineContentSha256: file.contentSha256,
        locator: { table: body.locator.table, row: body.locator.row, ...(column === null ? {} : { column }) },
        note: body.note,
        // The fingerprint of the original request: the guideline, the cell and the note (not the version or the file hash, so a repeat after the knowledge was re-signed still finds its dispute).
        ...(body.requestId
          ? {
              request: {
                id: body.requestId,
                hash: createHash('sha256')
                  .update(JSON.stringify([guideline.id, body.locator.table, body.locator.row, column, body.note]))
                  .digest('hex'),
              },
            }
          : {}),
      });
      if (stored.created) return this.present(knowledge, { dispute: stored.record, status: 'open', decision: null });
      // A repeat: show the dispute as it is now (it may have been decided since), never as a new open one.
      return this.present(knowledge, (await ledger.findDispute(principal.tenantId, stored.record.id)) ?? { dispute: stored.record, status: 'open', decision: null });
    } catch (error) {
      if (error instanceof DisputeRequestReusedError) throw AppException.conflictBecause('request-id-reused', 'That request id was already used for a different dispute.');
      throw error;
    }
  }

  async decide(principal: Principal, id: string, body: DisputeDecisionCreate): Promise<DisputeDto> {
    const { ledger, knowledge } = this.need();
    const found = await ledger.findDispute(principal.tenantId, id);
    if (!found) throw AppException.notFound('Dispute not found.');
    if (found.decision) throw AppException.conflictBecause('already-decided', 'This dispute already has its final decision. Raise a new dispute for a new concern.');
    if (found.dispute.createdBy === principal.sub) throw AppException.conflictBecause('self-decision', 'A dispute is decided by someone other than the person who raised it.');
    await ledger.decideDispute(principal.tenantId, principal.sub, { disputeId: id, decision: body.decision, evidenceNote: body.evidenceNote });
    return this.present(knowledge, (await ledger.findDispute(principal.tenantId, id))!);
  }

  async get(principal: Principal, id: string): Promise<DisputeDto> {
    const { ledger, knowledge } = this.need();
    const found = await ledger.findDispute(principal.tenantId, id);
    if (!found) throw AppException.notFound('Dispute not found.');
    return this.present(knowledge, found);
  }

  async list(principal: Principal, query: DisputeListQuery): Promise<Paginated<DisputeDto>> {
    const { ledger, knowledge } = this.need();
    const { page, pageSize, status } = query;
    const { items, total } = await ledger.pageDisputes(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize }, status);
    return { data: items.map((d) => this.present(knowledge, d)), meta: buildMeta(page, pageSize, total) };
  }

  async evaluations(principal: Principal, id: string, query: CellUsageQuery): Promise<CellUsageDto> {
    const ledger = this.ledger;
    if (!ledger) throw AppException.pipelineMisconfigured();
    const found = await ledger.findDispute(principal.tenantId, id);
    if (!found) throw AppException.notFound('Dispute not found.');
    const d = found.dispute;
    const cell = {
      guidelineId: d.guidelineId as string,
      guidelineVersion: d.guidelineVersion as string,
      guidelineContentSha256: d.guidelineContentSha256 as string,
      locator: { table: d.locatorTable as string, row: d.locatorRow as string, ...(d.locatorColumn === null ? {} : { column: d.locatorColumn as string }) },
      note: '',
    };
    const candidates = await ledger.cellEvaluationCandidates(principal.tenantId, cell, query.afterSeq, query.limit + 1);
    const page = candidates.slice(0, query.limit);
    const entries: CellUsageDto['entries'] = [];
    for (const record of page) {
      const matches = cellMatches(record, cell);
      if (matches.length === 0) continue;
      const state = await ledger.evaluationState(principal.tenantId, record.id);
      entries.push({ evaluationId: record.id, reportId: record.reportId as string, createdAt: record.createdAt, state: state.state, matches });
    }
    return cellUsageDtoSchema.parse({
      disputeId: id,
      entries,
      nextAfterSeq: candidates.length > query.limit ? page[page.length - 1]!.seq : null,
      clinicalUse: CLINICAL_USE,
      actionable: false,
    });
  }

  private present(knowledge: KnowledgeSet, status: DisputeStatus): DisputeDto {
    return toDisputeDto(status, knowledge);
  }
}
