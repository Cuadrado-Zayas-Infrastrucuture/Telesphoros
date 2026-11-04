import { applyDecorators, type CanActivate, Inject, Injectable, Logger, type OnApplicationBootstrap, SetMetadata, UseGuards } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AppException } from '../common/app-exception';
import { currentDataOrigin, type DataOrigin } from '../ledger/data-origin';
import { ObjectStorage } from '../object-storage/object-storage';

/**
 * The lab-report pipeline's on/off switch (LAB_REPORT_PIPELINE). One place answers "is it on", so every route that touches the
 * pipeline asks the same thing. Configuration validation already refuses `enabled` in production and with the in-memory store.
 */
@Injectable()
export class PipelineSwitch {
  readonly enabled: boolean;
  /** SYNTHETIC_ASSESSMENT: the synthetic structured assessment, which is not the pipeline. */
  readonly syntheticAssessment: boolean;
  readonly localStorageOnly: boolean;
  readonly downloadUrlTtlSeconds: number;
  private readonly originEnv: Pick<Env, 'NODE_ENV' | 'LAB_REPORT_PIPELINE'>;

  constructor(@Inject(ENV) env: Env) {
    this.originEnv = { NODE_ENV: env.NODE_ENV, LAB_REPORT_PIPELINE: env.LAB_REPORT_PIPELINE };
    this.enabled = env.LAB_REPORT_PIPELINE === 'enabled';
    this.syntheticAssessment = env.SYNTHETIC_ASSESSMENT === 'enabled';
    this.localStorageOnly = !!env.LOCAL_STORAGE_RUN_ID;
    this.downloadUrlTtlSeconds = env.DOWNLOAD_URL_TTL_SECONDS;
  }

  /** The origin of the data this process stores (spec 020 E1a): `synthetic` while the pipeline cannot run in production; throws DataOriginError otherwise. */
  dataOrigin(): DataOrigin {
    return currentDataOrigin(this.originEnv);
  }

  /** Throws 503 PIPELINE_DISABLED. Cheap and side-effect free: call it BEFORE touching storage, the reader or the ledger. */
  assertEnabled(): void {
    if (!this.enabled) throw AppException.pipelineDisabled();
  }

  /** Throws 503 PIPELINE_DISABLED unless the pipeline or the synthetic structured assessment is on. For the evaluation reads, which need neither the reader nor the knowledge. */
  assertEnabledOrSyntheticAssessment(): void {
    if (!this.enabled && !this.syntheticAssessment) throw AppException.pipelineDisabled();
  }

  /** Throws 503 unless the synthetic structured assessment is on. Cheap and side-effect free, like `assertEnabled`. */
  assertSyntheticAssessment(): void {
    if (!this.syntheticAssessment) throw AppException.unavailable('The synthetic structured assessment is switched off.');
  }
}

export const REQUIRES_PIPELINE = 'lab-reports:requires-pipeline';
/** Marks a controller that SYNTHETIC_ASSESSMENT unlocks. A test lists them, so the switch can never open a route without this mark being added on purpose. */
export const UNLOCKED_BY_SYNTHETIC_ASSESSMENT = 'lab-reports:unlocked-by-synthetic-assessment';

/**
 * Route guard for every route that belongs to the pipeline. Nest runs global guards first (authentication, then roles), then this one,
 * so the order is authentication 401, role 403, gate 503, validation 400: a caller who is not signed in, or lacks the role, learns
 * nothing about whether the pipeline is on.
 */
@Injectable()
export class PipelineGateGuard implements CanActivate {
  constructor(private readonly pipeline: PipelineSwitch) {}
  canActivate(): boolean {
    this.pipeline.assertEnabled();
    return true;
  }
}

/** Marks a controller or route as part of the pipeline (and applies the gate). A test lists routes by this mark. */
export const RequiresPipeline = () => applyDecorators(SetMetadata(REQUIRES_PIPELINE, true), UseGuards(PipelineGateGuard));

/** For the evaluation reads only: open with the pipeline OR the synthetic structured assessment. Still a pipeline route (the mark stays), and listed as unlocked. */
@Injectable()
export class EvaluationReadGateGuard implements CanActivate {
  constructor(private readonly pipeline: PipelineSwitch) {}
  canActivate(): boolean {
    this.pipeline.assertEnabledOrSyntheticAssessment();
    return true;
  }
}
export const RequiresPipelineOrSyntheticAssessment = () =>
  applyDecorators(SetMetadata(REQUIRES_PIPELINE, true), SetMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, true), UseGuards(EvaluationReadGateGuard));

/** Gate of the synthetic structured assessment's own routes: they need the switch, and never the pipeline. */
@Injectable()
export class SyntheticAssessmentGateGuard implements CanActivate {
  constructor(private readonly pipeline: PipelineSwitch) {}
  canActivate(): boolean {
    this.pipeline.assertSyntheticAssessment();
    return true;
  }
}
/** Only the mark, for a controller that keeps its own gate (the structured preview's) but is opened by the switch. */
export const UnlockedBySyntheticAssessment = () => SetMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, true);
export const RequiresSyntheticAssessment = () => applyDecorators(SetMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, true), UseGuards(SyntheticAssessmentGateGuard));

/**
 * With the pipeline on, the evidence rests on object VERSIONS: a bucket that does not keep them cannot pin a captured file, so the
 * app refuses to start rather than run without the guarantee.
 */
@Injectable()
export class PipelineStartupCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('LabReportPipeline');

  constructor(
    private readonly pipeline: PipelineSwitch,
    private readonly storage: ObjectStorage,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!(await this.storage.versioningEnabled())) {
      throw new Error('Report storage requires object storage that keeps versions (enable versioning on the reports bucket).');
    }
    if (this.pipeline.enabled) this.logger.warn('The lab-report pipeline is ENABLED: a synthetic, non-production integration. Never use real patient data.');
  }
}
