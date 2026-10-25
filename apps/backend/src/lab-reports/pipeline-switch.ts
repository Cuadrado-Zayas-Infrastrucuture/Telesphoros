import { applyDecorators, type CanActivate, Inject, Injectable, Logger, type OnApplicationBootstrap, SetMetadata, UseGuards } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AppException } from '../common/app-exception';
import { ObjectStorage } from '../object-storage/object-storage';

/**
 * The lab-report pipeline's on/off switch (LAB_REPORT_PIPELINE). One place answers "is it on", so every route that touches the
 * pipeline asks the same thing. Configuration validation already refuses `enabled` in production and with the in-memory store.
 */
@Injectable()
export class PipelineSwitch {
  readonly enabled: boolean;
  readonly localStorageOnly: boolean;
  readonly downloadUrlTtlSeconds: number;

  constructor(@Inject(ENV) env: Env) {
    this.enabled = env.LAB_REPORT_PIPELINE === 'enabled';
    this.localStorageOnly = !!env.LOCAL_STORAGE_RUN_ID;
    this.downloadUrlTtlSeconds = env.DOWNLOAD_URL_TTL_SECONDS;
  }

  /** Throws 503 PIPELINE_DISABLED. Cheap and side-effect free: call it BEFORE touching storage, the reader or the ledger. */
  assertEnabled(): void {
    if (!this.enabled) throw AppException.pipelineDisabled();
  }
}

export const REQUIRES_PIPELINE = 'lab-reports:requires-pipeline';

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
