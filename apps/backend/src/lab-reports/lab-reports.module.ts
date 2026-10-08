import { Global, Module } from '@nestjs/common';
import { PipelineGateGuard, PipelineStartupCheck, PipelineSwitch } from './pipeline-switch';

/** The lab-report pipeline's shared pieces: the switch, its route guard, and the startup check. (Endpoints arrive in slice 5B-3.2b.) */
@Global()
@Module({ providers: [PipelineSwitch, PipelineGateGuard, PipelineStartupCheck], exports: [PipelineSwitch, PipelineGateGuard] })
export class LabReportsModule {}
