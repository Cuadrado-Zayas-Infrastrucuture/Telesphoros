import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type EvaluationCreate, type EvaluationDto, type EvaluationListQuery, type EvaluationSummaryDto, PIPELINE_SCOPE } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { ObjectStorage } from '../object-storage/object-storage';
import { evaluate } from '../services/recommendation-engine/recommendation-engine';
import { adaptReport, adapterKnowledgeFrom, type AdapterResult } from '../services/report-adapter';
import { applyDisputeOverlay, type DisputedCell, OVERLAY_VERSION, type OverlayResult } from '../services/knowledge/dispute-overlay';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import { DisputeChangedError } from '../ledger/ledger-types';
import { type ReaderResult } from '../services/report-reader/reader-result';
import type { ReportReader } from '../services/report-reader/report-reader';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { DisputeStatus, EvaluationInput, Projected } from '../storage/ledger-records';
import { ReportsRepository } from '../storage/reports.repository';
import { DatabaseCaptureAcceptanceStore } from './acceptance-store';
import { type EvaluationContext, toEvaluationDto, toEvaluationSummaryDto } from './lab-report.mapper';
import { ReaderLimiter } from './reader-limiter';
import { TextCaptureRunner } from './runner/text-capture-runner';

export const LAB_KNOWLEDGE = Symbol('LAB_KNOWLEDGE');
export const LAB_READER = Symbol('LAB_READER');

/** Captured text is at most 100 000 Unicode scalars (4 bytes each). */
const MAX_TEXT_BYTES = 400_000;
/** The reader failing to RUN (as opposed to a fact about this text) is operational: nothing is stored and no key is consumed. */
const OPERATIONAL_READER_FAILURES = new Set(['source-time-budget', 'worker-error']);

export interface EvaluationOutcome {
  evaluation: EvaluationDto;
  created: boolean;
}

@Injectable()
export class EvaluationsService {
  private readonly logger = new Logger('LabReportEvaluations');

  // Everything the pipeline needs exists only when it is switched on; routes are gated first, `need` is the second line of defence.
  constructor(
    private readonly reports: ReportsRepository,
    private readonly storage: ObjectStorage,
    private readonly limiter: ReaderLimiter,
    @Inject(ENV) private readonly env: Env,
    @Optional() private readonly ledger?: LedgerRecordsRepository,
    @Optional() private readonly runner?: TextCaptureRunner,
    @Optional() @Inject(LAB_KNOWLEDGE) private readonly knowledge?: KnowledgeSet,
    @Optional() @Inject(LAB_READER) private readonly reader?: ReportReader,
  ) {}

  private need<T>(dependency: T | undefined | null): T {
    if (dependency === undefined || dependency === null) throw AppException.pipelineMisconfigured();
    return dependency;
  }

  /**
   * Evaluates an accepted capture (plan section 6). Everything that can be refused is refused BEFORE the reader runs, and nothing is
   * stored by a refusal. The reader and the engine run outside any database transaction; one transaction stores the result.
   */
  async create(principal: Principal, reportId: string, body: EvaluationCreate): Promise<EvaluationOutcome> {
    const ledger = this.need(this.ledger);
    const runner = this.need(this.runner);
    const knowledge = this.need(this.knowledge);
    const reader = this.need(this.reader);

    const report = await this.reports.findById(principal.tenantId, reportId);
    if (!report) throw AppException.notFound('Report not found.');
    if (report.type !== 'lab-pdf') throw AppException.conflictBecause('wrong-type', 'Only a lab PDF can be evaluated.');

    const capture = await ledger.findCapture(principal.tenantId, body.captureId);
    const acceptance = await ledger.findAcceptance(principal.tenantId, body.acceptanceId);
    if (!capture || !acceptance) throw AppException.notFound('Capture or decision not found.');
    if (capture.reportId !== report.id || acceptance.captureId !== capture.id) {
      throw AppException.conflictBecause('mismatch', 'That capture and decision do not belong to this report.');
    }

    // The decision relied on is an acceptance AND is still the latest decision about this capture. A newer, unaccepted CAPTURE of the
    // same report does not matter; a newer decision on THIS capture does. Always 409, even if a result for it already exists:
    // history is read with GET, a POST never replays from a superseded decision.
    if (acceptance.decision !== 'accepted') throw AppException.conflictBecause('capture-not-accepted', 'No reviewer has accepted this capture.');
    const latest = await ledger.latestAcceptance(principal.tenantId, capture.id);
    if (!latest || latest.id !== acceptance.id) throw AppException.conflictBecause('stale-acceptance', 'A later decision about this capture supersedes the one named.');

    // The stored text must still be the text that was captured and accepted.
    const stored = await this.storage.getObject(capture.textStorageKey as string, { maxBytes: MAX_TEXT_BYTES });
    if (!stored) throw AppException.conflictBecause('source-missing', 'The captured text is no longer available.');
    if (stored.sha256 !== capture.textSha256) throw AppException.conflictBecause('text-hash-mismatch', 'The stored text is not the text that was captured.');
    const text = stored.bytes.toString('utf8');

    const read = await this.limiter.run(() => reader.read(text));
    this.failIfOperational(read);

    const adapted = await adaptReport(
      { tenantId: principal.tenantId, captureAcceptanceId: acceptance.id, text, reader: read },
      { captures: new DatabaseCaptureAcceptanceStore(ledger), knowledge: adapterKnowledgeFrom(knowledge) },
    );

    // Disputes about guideline cells tighten what is shown (the overlay, spec 5.3): a disputed cell is held with no wording and everything
    // else is evaluated as usual. The disputes read here are the BASIS the storing transaction re-checks after the ledger lock; if one
    // appeared in between, the repository refuses and we evaluate once more with the new set (the reader is not run again).
    for (let attempt = 1; ; attempt++) {
      const active = (await ledger.listDisputes(principal.tenantId)).filter((d) => d.status !== 'dismissed');
      const input = this.build(report.patientId, report.id, capture.id, adapted, knowledge, runner, active);
      try {
        const result = await ledger.insertEvaluation(principal.tenantId, principal.sub, input);
        return { evaluation: await this.present(principal.tenantId, result.record), created: result.created };
      } catch (error) {
        if (!(error instanceof DisputeChangedError) || attempt >= 2) throw error;
        this.logger.warn({ event: 'dispute-changed-retry' }, 'A dispute changed while evaluating; evaluating once more');
      }
    }
  }

  async list(principal: Principal, query: EvaluationListQuery): Promise<EvaluationSummaryDto[]> {
    const ledger = this.need(this.ledger);
    const { current, ...filter } = query;
    const records = await ledger.listEvaluations(principal.tenantId, { ...filter, current: current === 'true' });
    const disputes = await this.activeDisputes(principal.tenantId);
    const currentIds = await ledger.currentEvaluationIds(principal.tenantId, [...new Set(records.map((r) => r.reportId as string))]);
    const out: EvaluationSummaryDto[] = [];
    for (const record of records) out.push(toEvaluationSummaryDto(record, await this.context(principal.tenantId, record, disputes, currentIds)));
    return out;
  }

  async get(principal: Principal, id: string): Promise<EvaluationDto> {
    const record = await this.need(this.ledger).findEvaluation(principal.tenantId, id);
    if (!record) throw AppException.notFound('Evaluation not found.');
    return this.present(principal.tenantId, record);
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------

  /** The reader could not run or ran out of time: say so, store NOTHING. A repeating failure shows in the log, never as a record. */
  private failIfOperational(read: ReaderResult): void {
    if (read.packet.schema === 'pgx-span-processing-failure/1' && OPERATIONAL_READER_FAILURES.has(read.packet.reason)) {
      this.logger.warn({ event: 'reader-unavailable', reason: read.packet.reason }, 'The reader did not return a usable result; nothing was stored');
      throw AppException.readerUnavailable();
    }
  }

  private build(
    patientId: string, reportId: string, captureId: string, adapted: AdapterResult, knowledge: KnowledgeSet, runner: TextCaptureRunner, active: DisputeStatus[],
  ): EvaluationInput {
    // The scope and what the substitute runner can answer for are part of the stored binding, hence of the ledger event.
    const binding: Record<string, unknown> = { ...adapted.binding, scope: PIPELINE_SCOPE, recordingsSha256: runner.manifestSha256 };
    if (adapted.disposition === 'held') {
      // A held evaluation shows no result, so no cell and no dispute matters to it.
      return {
        patientId, reportId, captureId, captureAcceptanceId: adapted.binding.captureAcceptanceId, disposition: 'held', holdCode: adapted.code, binding,
        knowledgeSetId: knowledge.id, engineVersion: this.env.BUILD_VERSION!, geneInputs: [], occurrences: [], results: [], geneStates: [],
      };
    }
    const disputed: DisputedCell[] = active.map(({ dispute: d }) => ({
      guidelineId: d.guidelineId as string, guidelineVersion: d.guidelineVersion as string, guidelineContentSha256: d.guidelineContentSha256 as string,
      locator: { table: d.locatorTable as string, row: d.locatorRow as string, column: (d.locatorColumn as string | null) ?? null },
    }));
    const overlay: OverlayResult = applyDisputeOverlay(knowledge, disputed);
    // When the overlay changed a cell, the stored binding says how to rebuild the effective set from the base set (inside the hashed record).
    if (overlay.cellKeys.length > 0) binding.overlay = { version: OVERLAY_VERSION, baseKnowledgeSetId: knowledge.id, cellKeys: overlay.cellKeys };
    const engine = evaluate(overlay.knowledge, adapted.geneInputs);
    return {
      patientId, reportId, captureId, captureAcceptanceId: adapted.binding.captureAcceptanceId, disposition: 'evaluated', holdCode: null, binding,
      knowledgeSetId: engine.knowledgeSetId, engineVersion: this.env.BUILD_VERSION!, geneInputs: adapted.geneInputs, occurrences: adapted.occurrences,
      results: engine.results, geneStates: engine.geneStates, disputeBasis: active.map(({ dispute }) => dispute.id),
    };
  }

  private async activeDisputes(tenantId: string): Promise<number> {
    return (await this.need(this.ledger).listDisputes(tenantId)).filter((d) => d.status !== 'dismissed').length;
  }

  private async context(tenantId: string, record: Projected, disputes: number, currentIds?: Map<string, string | null>): Promise<EvaluationContext> {
    const ledger = this.need(this.ledger);
    const acceptanceId = record.captureAcceptanceId as string | null;
    let acceptance: EvaluationContext['acceptance'] = null;
    if (acceptanceId) {
      const decided = await ledger.findAcceptance(tenantId, acceptanceId);
      const latest = await ledger.latestAcceptance(tenantId, record.captureId as string);
      if (decided) acceptance = { id: decided.id, decision: decided.decision as 'accepted' | 'rejected', current: latest?.id === decided.id };
    }
    // The state is derived from these same corrections (mapper), so what is shown can never disagree with the history shown beside it.
    const corrections = await ledger.listCorrections(tenantId, record.id);
    const reportId = record.reportId as string;
    const currentId = (currentIds ?? (await ledger.currentEvaluationIds(tenantId, [reportId]))).get(reportId) ?? null;
    return { acceptance, corrections, current: currentId === record.id, activeDisputes: disputes };
  }

  private async present(tenantId: string, record: Projected): Promise<EvaluationDto> {
    return toEvaluationDto(record, await this.context(tenantId, record, await this.activeDisputes(tenantId)));
  }
}
