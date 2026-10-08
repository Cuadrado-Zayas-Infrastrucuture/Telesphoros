import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DisputeCreate, DisputeDecisionCreate, DisputeDto, DisputeListQuery } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { DisputeStatus } from '../storage/ledger-records';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { LAB_KNOWLEDGE } from './evaluations.service';
import { toDisputeDto } from './lab-report.mapper';

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
    const exists = guideline.recommendations.some((row) => row.locator.table === body.locator.table && row.locator.row === body.locator.row && (row.locator.column ?? null) === column);
    if (!exists) throw AppException.conflictBecause('unknown-cell', 'That guideline has no cell at that locator.');

    // The version and the content hash come from the loaded file, so a dispute is always about the file that is in force.
    const { record } = await ledger.raiseDispute(principal.tenantId, principal.sub, {
      guidelineId: guideline.id,
      guidelineVersion: guideline.guidelineVersion,
      guidelineContentSha256: file.contentSha256,
      locator: { table: body.locator.table, row: body.locator.row, ...(column === null ? {} : { column }) },
      note: body.note,
    });
    return this.present(knowledge, { dispute: record, status: 'open', decision: null });
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

  async list(principal: Principal, query: DisputeListQuery): Promise<DisputeDto[]> {
    const { ledger, knowledge } = this.need();
    return (await ledger.listDisputes(principal.tenantId)).filter((d) => !query.status || d.status === query.status).map((d) => this.present(knowledge, d));
  }

  private present(knowledge: KnowledgeSet, status: DisputeStatus): DisputeDto {
    return toDisputeDto(status, knowledge);
  }
}
