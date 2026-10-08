import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CapturesController, ReportCaptureController } from './captures.controller';
import { CapturesService } from './captures.service';
import { PipelineGateGuard, PipelineStartupCheck, PipelineSwitch } from './pipeline-switch';
import { FakeTextCaptureRunner } from './runner/fake-text-capture-runner';
import { TextCaptureRunner } from './runner/text-capture-runner';

/**
 * The lab-report pipeline: the switch, its route guard, the startup check, and (3.2b-1) the capture and decision routes. The routes are
 * always registered, so a switched-off pipeline answers 503 and not 404; what they need to work exists only when it is switched on.
 */
@Global()
@Module({
  controllers: [ReportCaptureController, CapturesController],
  providers: [
    PipelineSwitch,
    PipelineGateGuard,
    PipelineStartupCheck,
    CapturesService,
    {
      provide: TextCaptureRunner,
      inject: [ENV],
      // Only built when the pipeline is on. A damaged fixture directory stops the start (RunnerMisconfiguredError), it is not skipped.
      useFactory: async (env: Env): Promise<TextCaptureRunner | undefined> =>
        env.LAB_REPORT_PIPELINE === 'enabled' ? FakeTextCaptureRunner.open(env.LAB_REPORT_FIXTURES_DIR!) : undefined,
    },
  ],
  exports: [PipelineSwitch, PipelineGateGuard],
})
export class LabReportsModule {}
