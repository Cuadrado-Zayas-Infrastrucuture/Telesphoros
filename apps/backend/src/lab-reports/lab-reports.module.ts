import { Logger, Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { loadKnowledge } from '../services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { ReportReader } from '../services/report-reader/report-reader';
import { SubprocessReportReader } from '../services/report-reader/subprocess-report-reader';
import { CapturesController, ReportCaptureController } from './captures.controller';
import { CapturesService } from './captures.service';
import { EvaluationCorrectionsController, NotesController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { EvaluationsController, ReportEvaluationController } from './evaluations.controller';
import { EvaluationsService, LAB_KNOWLEDGE, LAB_READER } from './evaluations.service';
import { PipelineGateGuard, PipelineStartupCheck, PipelineSwitch } from './pipeline-switch';
import { ReaderLimiter } from './reader-limiter';
import { FakeTextCaptureRunner } from './runner/fake-text-capture-runner';
import { TextCaptureRunner } from './runner/text-capture-runner';

const enabled = (env: Env) => env.LAB_REPORT_PIPELINE === 'enabled';

/**
 * The lab-report pipeline: the switch, its route guard, the startup check, and the capture, decision and evaluation routes. The routes are
 * always registered, so a switched-off pipeline answers 503 and not 404; what they need to work (the text runner, the knowledge, the
 * reader) is built only when it is switched on, and a fault in any of them stops the start rather than being skipped.
 */
@Global()
@Module({
  controllers: [ReportCaptureController, CapturesController, ReportEvaluationController, EvaluationsController, EvaluationCorrectionsController, NotesController],
  providers: [
    PipelineSwitch,
    PipelineGateGuard,
    PipelineStartupCheck,
    CapturesService,
    EvaluationsService,
    CorrectionsService,
    { provide: ReaderLimiter, inject: [ENV], useFactory: (env: Env) => new ReaderLimiter(env.LAB_REPORT_MAX_CONCURRENT_READS) },
    {
      provide: TextCaptureRunner,
      inject: [ENV],
      useFactory: async (env: Env): Promise<TextCaptureRunner | undefined> => (enabled(env) ? FakeTextCaptureRunner.open(env.LAB_REPORT_FIXTURES_DIR!) : undefined),
    },
    {
      provide: LAB_KNOWLEDGE,
      inject: [ENV],
      // The pipeline is refused in production, so the knowledge is always loaded under the non-production rules (synthetic content allowed).
      useFactory: async (env: Env): Promise<KnowledgeSet | undefined> => (enabled(env) ? loadKnowledge({ directory: env.KNOWLEDGE_DIR!, mode: 'non-production' }) : undefined),
    },
    {
      provide: LAB_READER,
      inject: [ENV],
      useFactory: async (env: Env): Promise<ReportReader | undefined> => {
        if (!enabled(env)) return undefined;
        const logger = new Logger('ReportReader');
        const reader = new SubprocessReportReader({ mode: 'non-production', logger: { warn: (fields, message) => logger.warn({ ...fields, message }) } });
        const mismatches = await reader.verifyPinned();
        if (mismatches.length > 0) throw new Error(`The report reader is not the pinned build (differs in: ${mismatches.join(', ')}).`);
        return reader;
      },
    },
  ],
  exports: [PipelineSwitch, PipelineGateGuard],
})
export class LabReportsModule {}
