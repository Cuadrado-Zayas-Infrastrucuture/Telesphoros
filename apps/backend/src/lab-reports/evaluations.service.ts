import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  buildMeta,
  type Paginated,
  type EvaluationCreate,
  type EvaluationDto,
  type EvaluationListQuery,
  type EvaluationSummaryDto,
  PIPELINE_SCOPE,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { ObjectStorage } from '../object-storage/object-storage';
import { evaluate } from '../services/recommendation-engine/recommendation-engine';
import { adaptReport, adapterKnowledgeFrom, type AdapterResult } from '../services/report-adapter';
import { applyDisputeOverlay, type DisputedCell, OVERLAY_VERSION, type OverlayResult } from '../services/knowledge/dispute-overlay';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import { currentDataOrigin, structuredAssessmentOrigin } from '../ledger/data-origin';
import { DisputeChangedError, PatientLinkUnverifiedError, StructuredBasisChangedError } from '../ledger/ledger-types';
import { linkState } from '../patient-identity/link-state';
import { type ReaderResult } from '../services/report-reader/reader-result';
import type { ReadOptions, ReportReader } from '../services/report-reader/report-reader';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { DisputeStatus, EvaluationCompletion, EvaluationInput, EvaluationView, InsertResult, Projected } from '../storage/ledger-records';
import { ReportsRepository } from '../storage/reports.repository';
import type { ReportRecord } from '../storage/records';
import { StructuredRevisionsRepository } from '../storage/structured-revisions.repository';
import { DatabaseCaptureAcceptanceStore } from './acceptance-store';
import { planStructuredAssessment, type StructuredAssessmentPlan } from './structured-assessment';
import { type EvaluationContext, toEvaluationDto, toEvaluationSummaryDto } from './lab-report.mapper';
import { LedgerStatus } from '../ledger/ledger-status';
import { ReaderLimiter } from './reader-limiter';
import { TextCaptureRunner } from './runner/text-capture-runner';

export const LAB_KNOWLEDGE = Symbol('LAB_KNOWLEDGE');
export const LAB_READER = Symbol('LAB_READER');
/** The synthetic knowledge a structured assessment evaluates against (SYNTHETIC_ASSESSMENT). Undefined otherwise; never the pipeline's LAB_KNOWLEDGE. */
export const SYNTHETIC_KNOWLEDGE = Symbol('SYNTHETIC_KNOWLEDGE');
/** The scope stored in the binding of a synthetic structured assessment: it never reads a PDF and is never a clinical release. */
export const STRUCTURED_ASSESSMENT_SCOPE = 'synthetic-structured-assessment';
/** What a structured assessment refusal says, by plan reason. Nothing from the report is quoted. */
const STRUCTURED_REFUSALS = {
  'not-recorded': ['structured-not-recorded', 'No stored structured revision exists for this report.'],
  'source-changed': ['structured-source-changed', 'The stored evidence changed. Reopen the report and review it again.'],
  superseded: ['structured-superseded', 'This revision is not the one under review for its series.'],
} as const;

/** Captured text is at most 100 000 Unicode scalars (4 bytes each). */
const MAX_TEXT_BYTES = 400_000;
/** The reader failing to RUN (as opposed to a fact about this text) is operational: nothing is stored and no key is consumed. */
const OPERATIONAL_READER_FAILURES = new Set(['source-time-budget', 'worker-error']);

export interface EvaluationCreateOptions extends ReadOptions {
  /** H3: the admitted request this evaluation completes, stored with it or not at all (EvaluationCompletion). Only the request consumer passes it. */
  completion?: EvaluationCompletion;
}

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
    @Optional() private readonly status?: LedgerStatus,
    @Optional() private readonly structured?: StructuredRevisionsRepository,
    @Optional() @Inject(SYNTHETIC_KNOWLEDGE) private readonly syntheticKnowledge?: KnowledgeSet,
  ) {}

  private need<T>(dependency: T | undefined | null): T {
    if (dependency === undefined || dependency === null) throw AppException.pipelineMisconfigured();
    return dependency;
  }

  /** Evaluates and stores (see `store`), then reads the stored evaluation back the way a caller of the API sees it. */
  async create(principal: Principal, reportId: string, body: EvaluationCreate, options: EvaluationCreateOptions = {}): Promise<EvaluationOutcome> {
    const stored = await this.store(principal, reportId, body, options);
    return { evaluation: await this.present(principal.tenantId, stored.record), created: stored.created };
  }

  /**
   * Evaluates an accepted capture (plan section 6). Everything that can be refused is refused BEFORE the reader runs, and nothing is
   * stored by a refusal. The reader and the engine run outside any database transaction; one transaction stores the result.
   * Returns the stored record only: the request worker has no reader of the response, so it calls this and builds none.
   */
  async store(principal: Principal, reportId: string, body: EvaluationCreate, options: EvaluationCreateOptions = {}): Promise<InsertResult> {
    const ledger = this.need(this.ledger);
    const runner = this.need(this.runner);
    const knowledge = this.need(this.knowledge);
    const reader = this.need(this.reader);
    // A request that cannot be stored (the tenant's record log is contained) is refused before the reader spends any effort on it.
    this.status?.assertOpen(principal.tenantId);
    // Named first (spec 020 E1a): an evaluation that cannot say whether its data is synthetic is refused before the reader spends any effort.
    const origin = currentDataOrigin(this.env);

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

    // M2.1b: nothing is evaluated for a patient until a second person has recorded that THIS file belongs to them. Checked here, before the reader
    // spends any effort, and again inside the storing transaction after the ledger lock (a decision or a file that changed in between cannot slip past).
    const link = linkState(report, await ledger.latestPatientDecision(principal.tenantId, report.id));
    if (link.state !== 'verified') throw this.unverified();

    // The stored text must still be the text that was captured and accepted.
    const stored = await this.storage.getObject(capture.textStorageKey as string, { maxBytes: MAX_TEXT_BYTES });
    if (!stored) throw AppException.conflictBecause('source-missing', 'The captured text is no longer available.');
    if (stored.sha256 !== capture.textSha256) throw AppException.conflictBecause('text-hash-mismatch', 'The stored text is not the text that was captured.');
    const text = stored.bytes.toString('utf8');

    // A cancelled evaluation takes no reader slot, and stores nothing even if a reader ignored the signal and answered after it.
    const { signal } = options;
    signal?.throwIfAborted();
    const read = await this.limiter.run(() => reader.read(text, { signal }));
    signal?.throwIfAborted();
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
      const input = { origin, ...this.build(report.patientId, report.id, capture.id, adapted, knowledge, runner, active), patientLinkDecisionId: link.decision!.id };
      try {
        return await ledger.insertEvaluation(principal.tenantId, principal.sub, input, options.completion);
      } catch (error) {
        if (error instanceof PatientLinkUnverifiedError) throw this.unverified();
        if (!(error instanceof DisputeChangedError) || attempt >= 2) throw error;
        this.logger.warn({ event: 'dispute-changed-retry' }, 'A dispute changed while evaluating; evaluating once more');
      }
    }
  }

  /**
   * Assesses the stored structured revision of a report (032 S3, synthetic) and reads the stored evaluation back the way a caller of the API sees it.
   * `created` is false when the same assessment already exists.
   */
  async assessStructured(principal: Principal, reportId: string): Promise<EvaluationOutcome> {
    const stored = await this.storeStructured(principal, reportId);
    return { evaluation: await this.present(principal.tenantId, stored.record), created: stored.created };
  }

  /**
   * Assesses the stored structured revision of a report (032 S3, synthetic). Nothing here reads a PDF or runs the reader: the input is the stored
   * revision and the independent reviews of its findings, evaluated against the SYNTHETIC knowledge only (never the pipeline's). Refused BEFORE anything
   * is stored: a report without a verified patient link, one that is not a structured report, a revision whose stored evidence changed or that is not
   * the one under review. Held (stored, no result) for everything incomplete, conflicting or unsupported. The stored evidence the plan rests on (revisions,
   * newest reviews, resolutions) is read again after the ledger lock is held, as the patient link and disputes are; a difference plans again, once more.
   */
  async storeStructured(principal: Principal, reportId: string): Promise<InsertResult> {
    const ledger = this.need(this.ledger);
    const knowledge = this.need(this.syntheticKnowledge);
    const structured = this.need(this.structured);
    this.status?.assertOpen(principal.tenantId);
    const origin = structuredAssessmentOrigin(this.env);
    // Stored with every evaluation. Missing is a misconfiguration, refused here and not left to fail when the record is hashed.
    const engineVersion = this.need(this.env.BUILD_VERSION);

    const report = await this.reports.findById(principal.tenantId, reportId);
    if (!report) throw AppException.notFound('Report not found.');
    if (report.type !== 'structured') throw AppException.conflictBecause('wrong-type', 'Only a stored structured laboratory report can be assessed this way.');

    // Same rule as the PDF path: nothing is assessed for a patient until a second person has recorded that THIS file belongs to them, checked here
    // and again inside the storing transaction after the ledger lock.
    const link = linkState(report, await ledger.latestPatientDecision(principal.tenantId, report.id));
    if (link.state !== 'verified') throw this.unverified();

    for (let attempt = 1; ; attempt++) {
      const snapshot = await structured.readForReport(principal.tenantId, {
        patientId: report.patientId,
        reportId: report.id,
        sha256: report.sha256 as string,
        objectVersion: report.objectVersion as string,
      });
      const plan = planStructuredAssessment(principal.tenantId, report, snapshot);
      if (plan.kind === 'refused') {
        const [code, message] = STRUCTURED_REFUSALS[plan.reason];
        throw AppException.conflictBecause(code, message);
      }
      const active = (await ledger.listDisputes(principal.tenantId)).filter((d) => d.status !== 'dismissed');
      const structuredBasis = {
        revisionIds: snapshot.revisions.map((r) => r.id).sort(),
        reviewIds: snapshot.reviews.map((r) => r.id).sort(),
        resolutionIds: snapshot.resolutions.map((r) => r.id).sort(),
      };
      const input = { origin, ...this.buildStructured(report, plan, knowledge, active, engineVersion), structuredBasis, patientLinkDecisionId: link.decision!.id };
      try {
        return await ledger.insertEvaluation(principal.tenantId, principal.sub, input);
      } catch (error) {
        if (error instanceof PatientLinkUnverifiedError) throw this.unverified();
        if (!(error instanceof DisputeChangedError || error instanceof StructuredBasisChangedError) || attempt >= 3) throw error;
        this.logger.warn({ event: 'structured-basis-changed-retry' }, 'The stored evidence or a dispute changed while assessing; assessing once more');
      }
    }
  }

  async list(principal: Principal, query: EvaluationListQuery): Promise<Paginated<EvaluationSummaryDto>> {
    const ledger = this.need(this.ledger);
    const { current, page, pageSize, ...filter } = query;
    // One transaction for the page and everything shown beside it (it used to be five).
    const {
      items: records,
      total,
      contexts,
      currentIds,
      links,
      activeDisputes: disputes,
    } = await ledger.evaluationPage(principal.tenantId, { ...filter, current: current === 'true' }, { offset: (page - 1) * pageSize, limit: pageSize });
    const out: EvaluationSummaryDto[] = [];
    for (const record of records) {
      const context = contexts.get(record.id);
      if (!context) throw AppException.pipelineMisconfigured();
      out.push(
        toEvaluationSummaryDto(record, {
          ...context,
          current: currentIds.get(record.reportId as string) === record.id,
          activeDisputes: disputes,
          patientLink: links.get(record.reportId as string) ?? 'unverified',
          loadedKnowledgeSetId: this.loadedKnowledgeSetId(record),
        }),
      );
    }
    return { data: out, meta: buildMeta(page, pageSize, total) };
  }

  async get(principal: Principal, id: string): Promise<EvaluationDto> {
    const view = await this.need(this.ledger).evaluationView(principal.tenantId, id);
    if (!view) throw AppException.notFound('Evaluation not found.');
    return toEvaluationDto(view.record, contextOf(view, this.loadedKnowledgeSetId(view.record)));
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------

  private unverified(): AppException {
    return AppException.conflictBecause('patient-link-unverified', 'This report has not been verified as belonging to its patient. A second person must verify it first.');
  }

  /** The reader could not run or ran out of time: say so, store NOTHING. A repeating failure shows in the log, never as a record. */
  private failIfOperational(read: ReaderResult): void {
    if (read.packet.schema === 'pgx-span-processing-failure/1' && OPERATIONAL_READER_FAILURES.has(read.packet.reason)) {
      this.logger.warn({ event: 'reader-unavailable', reason: read.packet.reason }, 'The reader did not return a usable result; nothing was stored');
      throw AppException.readerUnavailable();
    }
  }

  private build(
    patientId: string,
    reportId: string,
    captureId: string,
    adapted: AdapterResult,
    knowledge: KnowledgeSet,
    runner: TextCaptureRunner,
    active: DisputeStatus[],
  ): Omit<EvaluationInput, 'origin'> {
    // The scope and what the substitute runner can answer for are part of the stored binding, hence of the ledger event.
    const binding: Record<string, unknown> = { ...adapted.binding, scope: PIPELINE_SCOPE, recordingsSha256: runner.manifestSha256 };
    binding.cellProvenance = this.cellProvenance(knowledge);
    if (adapted.disposition === 'held') {
      // A held evaluation shows no result, so no cell and no dispute matters to it.
      return {
        patientId,
        reportId,
        captureId,
        captureAcceptanceId: adapted.binding.captureAcceptanceId,
        disposition: 'held',
        holdCode: adapted.code,
        binding,
        knowledgeSetId: knowledge.id,
        engineVersion: this.env.BUILD_VERSION!,
        geneInputs: [],
        occurrences: [],
        results: [],
        geneStates: [],
      };
    }
    const overlay = this.overlayFor(knowledge, active, binding);
    const engine = evaluate(overlay.knowledge, adapted.geneInputs);
    return {
      patientId,
      reportId,
      captureId,
      captureAcceptanceId: adapted.binding.captureAcceptanceId,
      disposition: 'evaluated',
      holdCode: null,
      binding,
      knowledgeSetId: engine.knowledgeSetId,
      engineVersion: this.env.BUILD_VERSION!,
      geneInputs: adapted.geneInputs,
      occurrences: adapted.occurrences,
      results: engine.results,
      geneStates: engine.geneStates,
      disputeBasis: active.map(({ dispute }) => dispute.id),
    };
  }

  /** Bind the actual base files into the immutable, ledger-hashed record; an overlay changes verification, never file identity. */
  private cellProvenance(knowledge: KnowledgeSet) {
    return {
      version: 'cell-provenance/1',
      files: knowledge
        .allGuidelines()
        .map((g) => {
          const file = knowledge.files.find((f) => f.kind === 'guideline' && f.id === g.id);
          if (!file) throw AppException.pipelineMisconfigured();
          return { guidelineId: g.id, guidelineVersion: g.guidelineVersion, contentSha256: file.contentSha256 };
        })
        .sort((a, b) => (a.guidelineId < b.guidelineId ? -1 : a.guidelineId > b.guidelineId ? 1 : 0)),
    };
  }

  /** The disputed cells applied to the knowledge, and (when one changed a cell) how to rebuild the effective set from the base set, inside the hashed binding. */
  private overlayFor(knowledge: KnowledgeSet, active: DisputeStatus[], binding: Record<string, unknown>): OverlayResult {
    const disputed: DisputedCell[] = active.map(({ dispute: d }) => ({
      guidelineId: d.guidelineId as string,
      guidelineVersion: d.guidelineVersion as string,
      guidelineContentSha256: d.guidelineContentSha256 as string,
      locator: { table: d.locatorTable as string, row: d.locatorRow as string, column: (d.locatorColumn as string | null) ?? null },
    }));
    const overlay: OverlayResult = applyDisputeOverlay(knowledge, disputed);
    if (overlay.cellKeys.length > 0) binding.overlay = { version: OVERLAY_VERSION, baseKnowledgeSetId: knowledge.id, cellKeys: overlay.cellKeys };
    return overlay;
  }

  /**
   * Synthetic structured assessment (032 S3): everything the evaluation records comes from the stored revision and the independent reviews of
   * its findings, never from the reader. A held plan stores a held evaluation (no result, no cell); a ready plan evaluates the same engine over the
   * same knowledge and disputes as the PDF path. The binding names the revision, the source file, the patient-link decision and each review relied on.
   */
  private buildStructured(
    report: ReportRecord,
    plan: Exclude<StructuredAssessmentPlan, { kind: 'refused' }>,
    knowledge: KnowledgeSet,
    active: DisputeStatus[],
    engineVersion: string,
  ): Omit<EvaluationInput, 'origin'> {
    const { revision } = plan;
    const binding: Record<string, unknown> = {
      version: 'structured-assessment-binding/1',
      scope: STRUCTURED_ASSESSMENT_SCOPE,
      synthetic: true,
      clinicalUse: 'not-approved',
      revisionId: revision.id,
      revisionSha256: revision.sha256,
      laboratoryReportId: revision.laboratoryReport.id,
      laboratoryReportRevision: revision.laboratoryReport.revision,
      patientLinkDecisionId: revision.patientLinkDecisionId,
      cellProvenance: this.cellProvenance(knowledge),
    };
    const common = { patientId: report.patientId, reportId: report.id, captureId: null, captureAcceptanceId: null, structuredRevisionId: revision.id, engineVersion };
    if (plan.kind === 'held') {
      binding.holdDetail = plan.detail;
      return { ...common, disposition: 'held', holdCode: plan.holdCode, binding, knowledgeSetId: knowledge.id, geneInputs: [], occurrences: [], results: [], geneStates: [] };
    }
    binding.reviewIds = plan.reviewIds;
    const overlay = this.overlayFor(knowledge, active, binding);
    const engine = evaluate(overlay.knowledge, plan.geneInputs);
    return {
      ...common,
      disposition: 'evaluated',
      holdCode: null,
      binding,
      knowledgeSetId: engine.knowledgeSetId,
      geneInputs: plan.geneInputs,
      occurrences: [],
      results: engine.results,
      geneStates: engine.geneStates,
      disputeBasis: active.map(({ dispute }) => dispute.id),
    };
  }

  private async present(tenantId: string, record: Projected): Promise<EvaluationDto> {
    return toEvaluationDto(record, contextOf(await this.need(this.ledger).viewOfEvaluation(tenantId, record), this.loadedKnowledgeSetId(record)));
  }

  /** A structured evaluation is made against the synthetic knowledge and a PDF evaluation against the pipeline's, so each is compared with its own. */
  private loadedKnowledgeSetId(record: Projected): string | null {
    return (record.structuredRevisionId === undefined ? this.knowledge : this.syntheticKnowledge)?.id ?? null;
  }
}

/** The state is derived from these same corrections (mapper), so what is shown can never disagree with the history shown beside it. */
function contextOf(view: EvaluationView, loadedKnowledgeSetId: string | null): EvaluationContext {
  return { ...view.context, current: view.current, activeDisputes: view.activeDisputes, patientLink: view.patientLink, loadedKnowledgeSetId };
}
