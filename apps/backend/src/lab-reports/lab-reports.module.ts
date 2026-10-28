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
import { EvaluationsService, LAB_KNOWLEDGE, LAB_READER } from './evaluations.service';
import { LedgerController } from '../ledger/ledger.controller';
import { PipelineGateGuard, PipelineStartupCheck, PipelineSwitch } from './pipeline-switch';
import { ReaderLimiter } from './reader-limiter';
import { FakeTextCaptureRunner } from './runner/fake-text-capture-runner';
import { TextCaptureRunner } from './runner/text-capture-runner';

const enabled = (env: Env) => env.LAB_REPORT_PIPELINE === 'enabled';

// loadEnv refuses the pipeline in production. The knowledge loader and the reader still take their mode from NODE_ENV, so their own production
// rules are a second line rather than switched off: in production the reader refuses and the loader refuses synthetic content (audit A1).
const modeOf = (env: Env) => (env.NODE_ENV === 'production' ? 'production' : 'non-production');

export const labKnowledgeFactory = async (env: Env): Promise<KnowledgeSet | undefined> =>
  enabled(env) ? loadKnowledge({ directory: env.KNOWLEDGE_DIR!, mode: modeOf(env) }) : undefined;

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
    EvaluationCorrectionsController,
    NotesController,
    DisputesController,
    ClinicianDecisionsController,
    LedgerController,
    EvaluationRequestsController,
  ],
  providers: [
    PipelineSwitch,
    PipelineGateGuard,
    PipelineStartupCheck,
    CapturesService,
    EvaluationsService,
    CorrectionsService,
    DisputesService,
    ClinicianDecisionsService,
    { provide: ReaderLimiter, inject: [ENV], useFactory: (env: Env) => new ReaderLimiter(env.LAB_REPORT_MAX_CONCURRENT_READS) },
    {
      provide: TextCaptureRunner,
      inject: [ENV],
      useFactory: async (env: Env): Promise<TextCaptureRunner | undefined> => (enabled(env) ? FakeTextCaptureRunner.open(env.LAB_REPORT_FIXTURES_DIR!) : undefined),
    },
    { provide: LAB_KNOWLEDGE, inject: [ENV], useFactory: labKnowledgeFactory },
    { provide: LAB_READER, inject: [ENV], useFactory: labReaderFactory },
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
