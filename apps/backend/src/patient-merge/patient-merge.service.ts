import { Injectable, Optional } from '@nestjs/common';
import {
  buildMeta,
  type DuplicateCandidateDto,
  type Paginated,
  type PaginationQuery,
  type PatientMergeCreate,
  type PatientMergeDecisionCreate,
  type PatientMergeDto,
  type PatientMergeListQuery,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { MergeAlreadyDecidedError, MergeRefusedError } from '../ledger/ledger-types';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import { PatientIdentifiersRepository } from '../storage/patient-identifiers.repository';
import { PatientsRepository } from '../storage/patients.repository';
import { toDuplicateDto, toMergeDto } from './patient-merge.mapper';

/** What a refusal of the database's merge rule means to the caller. Every one is a 409 the person can act on. */
const REFUSALS: Record<string, string> = {
  'source-merged': 'The first patient is already merged into another patient.',
  'target-merged': 'The second patient was itself merged into another patient. Propose the merge into that patient instead.',
  'source-has-aliases': 'Other patients were merged into the first patient. Merge those into the second patient instead, or undo those merges first.',
  'not-merged': 'No merge of these two patients is in force, so there is nothing to undo.',
  'proposal-pending': 'There is already an undecided proposal for these two patients.',
};

/**
 * Possible duplicates, and the merge of two patient records. A merge is two people's decision recorded in the ledger; it rewrites no record. The
 * ledger exists only on PostgreSQL, so without it merging answers 503 while the duplicate list (flags are not ledger records) still works.
 */
@Injectable()
export class PatientMergeService {
  constructor(
    private readonly patients: PatientsRepository,
    private readonly identifiers: PatientIdentifiersRepository,
    @Optional() private readonly ledger?: LedgerRecordsRepository,
  ) {}

  private need(): LedgerRecordsRepository {
    if (!this.ledger) throw AppException.unavailable('Merging patient records needs the PostgreSQL record store, which is not configured.');
    return this.ledger;
  }

  private refusal(error: MergeRefusedError): AppException {
    if (error.reason === 'patient-gone') return AppException.notFound('Patient not found.');
    return AppException.conflictBecause(`merge-${error.reason}`, REFUSALS[error.reason] ?? 'The merge is not possible in the current state of the patients.');
  }

  async duplicates(principal: Principal, { page, pageSize }: PaginationQuery): Promise<Paginated<DuplicateCandidateDto>> {
    const { items, total } = await this.identifiers.listDuplicates(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize });
    return { data: items.map(toDuplicateDto), meta: buildMeta(page, pageSize, total) };
  }

  async propose(principal: Principal, body: PatientMergeCreate): Promise<PatientMergeDto> {
    const ledger = this.need();
    // The same 404 whether a patient is missing or belongs to another organization.
    for (const id of [body.sourcePatientId, body.targetPatientId]) {
      if (!(await this.patients.findById(principal.tenantId, id))) throw AppException.notFound('Patient not found.');
    }
    try {
      const stored = await ledger.insertMergeProposal(principal.tenantId, principal.sub, {
        kind: body.kind,
        sourcePatientId: body.sourcePatientId,
        targetPatientId: body.targetPatientId,
        reasonCode: body.reasonCode,
      });
      const status = await ledger.findMerge(principal.tenantId, stored.record.id);
      return toMergeDto(status!);
    } catch (error) {
      if (error instanceof MergeRefusedError) throw this.refusal(error);
      throw error;
    }
  }

  /** 201 for a new decision, 200 when the proposal already has exactly this decision. */
  async decide(principal: Principal, proposalId: string, body: PatientMergeDecisionCreate): Promise<{ merge: PatientMergeDto; created: boolean }> {
    const ledger = this.need();
    const before = await ledger.findMerge(principal.tenantId, proposalId);
    if (!before) throw AppException.notFound('Merge proposal not found.');
    if (before.status !== 'pending') {
      if (before.status === body.decision) return { merge: toMergeDto(before), created: false };
      throw AppException.conflictBecause('merge-already-decided', 'This proposal was already decided.');
    }
    // The database repeats the rule; this gives the clear answer first.
    if (before.proposal.createdBy === principal.sub) {
      throw AppException.conflictBecause('self-review', 'You proposed this merge, so you cannot decide it. Another person must.');
    }
    try {
      const stored = await ledger.insertMergeDecision(principal.tenantId, principal.sub, { proposalId, decision: body.decision });
      const status = await ledger.findMerge(principal.tenantId, proposalId);
      return { merge: toMergeDto(status!), created: stored.created };
    } catch (error) {
      if (error instanceof MergeRefusedError) throw this.refusal(error);
      if (error instanceof MergeAlreadyDecidedError) throw AppException.conflictBecause('merge-already-decided', 'This proposal was already decided.');
      throw error;
    }
  }

  async get(principal: Principal, proposalId: string): Promise<PatientMergeDto> {
    const status = await this.need().findMerge(principal.tenantId, proposalId);
    if (!status) throw AppException.notFound('Merge proposal not found.');
    return toMergeDto(status);
  }

  async list(principal: Principal, { page, pageSize, status }: PatientMergeListQuery): Promise<Paginated<PatientMergeDto>> {
    const { items, total } = await this.need().pageMerges(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize }, status);
    return { data: items.map(toMergeDto), meta: buildMeta(page, pageSize, total) };
  }
}
