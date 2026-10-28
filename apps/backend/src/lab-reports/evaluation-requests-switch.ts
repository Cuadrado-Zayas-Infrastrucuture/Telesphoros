import { applyDecorators, type CanActivate, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { evaluationExecutionProfileSchema } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import type { Database } from '../db/database';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import { EvaluationRequestsRepository } from '../storage/postgres/evaluation-requests.repository';
import { EvaluationRequestsService } from './evaluation-requests.service';
import { assertRunsProfile } from './evaluation-worker-config';
import { PipelineGateGuard, REQUIRES_PIPELINE } from './pipeline-switch';
import type { TextCaptureRunner } from './runner/text-capture-runner';

/** The admission service (H1), present only while queued evaluation requests are switched on. */
export const EVALUATION_REQUESTS_SERVICE = Symbol('EVALUATION_REQUESTS_SERVICE');

/**
 * Queued evaluation requests' on/off switch (EVALUATION_REQUESTS, H4). Configuration validation already refuses `enabled` in production and without the
 * pipeline, so this answers only "is it on here".
 */
@Injectable()
export class EvaluationRequestsSwitch {
  readonly enabled: boolean;

  constructor(@Inject(ENV) env: Env) {
    this.enabled = env.EVALUATION_REQUESTS === 'enabled';
  }

  /** Throws 503 EVALUATION_REQUESTS_DISABLED. Side-effect free: call it before anything is read or queued. */
  assertEnabled(): void {
    if (!this.enabled) throw AppException.evaluationRequestsDisabled();
  }
}

@Injectable()
export class EvaluationRequestsGateGuard implements CanActivate {
  constructor(private readonly requests: EvaluationRequestsSwitch) {}
  canActivate(): boolean {
    this.requests.assertEnabled();
    return true;
  }
}

/**
 * Marks a controller as part of the pipeline AND of queued requests: the pipeline's gate runs first, then this one, after authentication and roles. So the
 * order stays 401, 403, 503 (pipeline, then requests), 400.
 */
export const RequiresEvaluationRequests = () => applyDecorators(SetMetadata(REQUIRES_PIPELINE, true), UseGuards(PipelineGateGuard, EvaluationRequestsGateGuard));

/**
 * Builds the admission service only while the switch is on, with the configured profile, after checking that the profile names the knowledge set and the
 * recordings this process loaded: a request admitted under any other would be refused by the worker (H3) and by the database (migration 0051).
 */
export function evaluationRequestsFactory(
  env: Env,
  database: Database | undefined,
  knowledge: KnowledgeSet | undefined,
  runner: TextCaptureRunner | undefined,
): EvaluationRequestsService | undefined {
  if (env.EVALUATION_REQUESTS !== 'enabled') return undefined;
  if (!database || !knowledge || !runner) throw new Error('EVALUATION_REQUESTS needs the lab-report pipeline and the database.');
  const profile = evaluationExecutionProfileSchema.parse(JSON.parse(env.EVALUATION_EXECUTION_PROFILE!));
  assertRunsProfile(profile, { knowledgeSetId: knowledge.id, recordingsSha256: runner.manifestSha256 });
  return new EvaluationRequestsService(new EvaluationRequestsRepository(database), profile);
}
