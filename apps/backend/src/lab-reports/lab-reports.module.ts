import { Logger, Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { Database } from '../db/database';
import { loadKnowledge } from '../services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import { assertReaderEnginePresent } from '../services/report-reader/engine-presence';
import type { ReportReader } from '../services/report-reader/report-reader';
import { SubprocessReportReader } from '../services/report-reader/subprocess-report-reader';
import { CapturesController, ReportCaptureController } from './captures.controller';
import { CapturesService } from './captures.service';
import { ClinicianDecisionsController } from './clinician-decisions.controller';
import { ClinicianDecisionsService } from './clinician-decisions.service';
import { EvaluationCorrectionsController, NotesController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { EvaluationRequestsController } from './evaluation-requests.controller';
import { EVALUATION_REQUESTS_SERVICE, EvaluationRequestsGateGuard, evaluationRequestsFactory, EvaluationRequestsSwitch } from './evaluation-requests-switch';
import { EvaluationsController, ReportEvaluationController } from './evaluations.controller';
import { EvaluationsService, LAB_KNOWLEDGE, LAB_READER, SYNTHETIC_KNOWLEDGE } from './evaluations.service';
import { LedgerController } from '../ledger/ledger.controller';
import { EvaluationReadGateGuard, PipelineGateGuard, PipelineStartupCheck, PipelineSwitch, SyntheticAssessmentGateGuard } from './pipeline-switch';
import { ReaderLimiter } from './reader-limiter';
import { StructuredAssessmentController } from './structured-assessment.controller';
import { ResultAcknowledgementsController } from './result-acknowledgements.controller';
import { ResultAcknowledgementsService } from './result-acknowledgements.service';
import { ResultRendersController } from './result-renders.controller';
import { ResultRendersService } from './result-renders.service';
import { FakeTextCaptureRunner } from './runner/fake-text-capture-runner';
import { TextCaptureRunner } from './runner/text-capture-runner';

const enabled = (env: Env) => env.LAB_REPORT_PIPELINE === 'enabled';

// loadEnv refuses the pipeline in production. The knowledge loader and the reader still take their mode from NODE_ENV, so their own production
// rules are a second line rather than switched off: in production the reader refuses and the loader refuses synthetic content (audit A1).
const modeOf = (env: Env) => (env.NODE_ENV === 'production' ? 'production' : 'non-production');

export const labKnowledgeFactory = async (env: Env): Promise<KnowledgeSet | undefined> => {
  if (!enabled(env)) return undefined;
  const set = await loadKnowledge({ directory: env.KNOWLEDGE_DIR!, mode: modeOf(env) });
  // An empty set loads, and every drug then reports no guideline: under the production rules that is refused, as the synthetic factory does (audit CLIN-14).
  if (set.isEmpty && modeOf(env) === 'production') throw new Error('KNOWLEDGE_DIR holds no guideline: production needs at least one.');
  return set;
};

/**
 * The synthetic knowledge for the structured assessment: loaded only while SYNTHETIC_ASSESSMENT is on, from its own directory and never from the
 * pipeline's. It is loaded under the non-production rules, so the check that makes that safe is made here: every file must say it is synthetic, and the set
 * must not be empty. A directory holding anything that claims to be real content stops the start.
 */
export const syntheticKnowledgeFactory = async (env: Env): Promise<KnowledgeSet | undefined> => {
  if (env.SYNTHETIC_ASSESSMENT !== 'enabled') return undefined;
  const set = await loadKnowledge({ directory: env.SYNTHETIC_KNOWLEDGE_DIR!, mode: 'non-production' });
  if (set.isEmpty || set.files.some((file) => !file.synthetic)) throw new Error('SYNTHETIC_KNOWLEDGE_DIR must hold synthetic knowledge only, and at least one guideline.');
  return set;
};

export const labReaderFactory = async (env: Env): Promise<ReportReader | undefined> => {
  if (!enabled(env)) return undefined;
  const logger = new Logger('ReportReader');
  // Constructed first: its production refusal is policy and comes before any check of what is installed.
  const reader = new SubprocessReportReader({ mode: modeOf(env), logger: { warn: (fields, message) => logger.warn({ ...fields, message }) } });
  assertReaderEnginePresent();
  const mismatches = await reader.verifyPinned();
  if (mismatches.length > 0) throw new Error(`The report reader is not the pinned build (differs in: ${mismatches.join(', ')}).`);
  return reader;
};

/**
 * The lab-report pipeline: the switch, its route guard, the startup check, and the capture, decision and evaluation routes. The routes are
 * always registered, so a switched-off pipeline answers 503 and not 404; what they need to work (the text runner, the knowledge, the
 * reader) is built only when it is switched on, and a fault in any of them stops the start rather than being skipped.
 */
@Global()
@Module({
  controllers: [
    ReportCaptureController,
    CapturesController,
    ReportEvaluationController,
    EvaluationsController,
    StructuredAssessmentController,
    EvaluationCorrectionsController,
    NotesController,
    DisputesController,
    ClinicianDecisionsController,
    ResultAcknowledgementsController,
    ResultRendersController,
    LedgerController,
    EvaluationRequestsController,
  ],
  providers: [
    PipelineSwitch,
    PipelineGateGuard,
    EvaluationReadGateGuard,
    SyntheticAssessmentGateGuard,
    PipelineStartupCheck,
    CapturesService,
    EvaluationsService,
    CorrectionsService,
    DisputesService,
    ClinicianDecisionsService,
    ResultAcknowledgementsService,
    ResultRendersService,
    { provide: ReaderLimiter, inject: [ENV], useFactory: (env: Env) => new ReaderLimiter(env.LAB_REPORT_MAX_CONCURRENT_READS) },
    {
      provide: TextCaptureRunner,
      inject: [ENV],
      useFactory: async (env: Env): Promise<TextCaptureRunner | undefined> => (enabled(env) ? FakeTextCaptureRunner.open(env.LAB_REPORT_FIXTURES_DIR!) : undefined),
    },
    { provide: LAB_KNOWLEDGE, inject: [ENV], useFactory: labKnowledgeFactory },
    { provide: LAB_READER, inject: [ENV], useFactory: labReaderFactory },
    { provide: SYNTHETIC_KNOWLEDGE, inject: [ENV], useFactory: syntheticKnowledgeFactory },
    EvaluationRequestsSwitch,
    EvaluationRequestsGateGuard,
    // Undefined unless EVALUATION_REQUESTS=enabled (H4); the database is absent with the in-memory store, which configuration refuses for the pipeline.
    {
      provide: EVALUATION_REQUESTS_SERVICE,
      inject: [ENV, { token: Database, optional: true }, LAB_KNOWLEDGE, TextCaptureRunner],
      useFactory: evaluationRequestsFactory,
    },
  ],
  exports: [PipelineSwitch, PipelineGateGuard],
})
export class LabReportsModule {}
