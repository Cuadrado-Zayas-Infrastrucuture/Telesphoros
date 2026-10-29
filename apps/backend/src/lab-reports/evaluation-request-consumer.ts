import { HttpStatus } from '@nestjs/common';
import { ERROR_CODE, evaluationRequest, fatal, retryable, type HandlerContext, type RegisteredJob } from '@telesphoros/jobs';
import { evaluationExecutionProfileSchema, type EvaluationExecutionProfile } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import type { Database } from '../db/database';
import { LedgerBusyError, LedgerCompromisedError } from '../ledger/ledger-types';
import { EvaluationRequestsRepository } from '../storage/postgres/evaluation-requests.repository';
import type { EvaluationsService } from './evaluations.service';

/** What the database says when the caller no longer holds the job (migration 0051): the lease ran out and the job may be someone else's now. */
const NOT_HELD = 'EJ001';

/**
 * H3: runs one admitted evaluation request (migration 0050) for the worker that holds its job. The request names the capture, the accepted decision and the
 * pinned execution profile; the evaluation is made by the same EvaluationsService as the synchronous route, acting for the person who asked, and is stored
 * in ONE transaction with the request's completion, which the database accepts only while this worker holds the job (a worker whose lease ran out stores
 * nothing). Delivery is at-least-once: a request that is already complete is reported done without reading again.
 */
export class EvaluationRequestConsumer {
  private readonly requests: EvaluationRequestsRepository;
  private readonly profile: Readonly<EvaluationExecutionProfile>;

  constructor(
    database: Database,
    private readonly evaluations: EvaluationsService,
    profile: EvaluationExecutionProfile,
  ) {
    this.requests = new EvaluationRequestsRepository(database);
    this.profile = Object.freeze(evaluationExecutionProfileSchema.parse(profile));
  }

  async handle({ job, workerId, signal }: Pick<HandlerContext, 'job' | 'workerId' | 'signal'>): Promise<void> {
    const { requestId } = evaluationRequest.payload.parse(job.payload);
    try {
      const request = await this.requests.forJob(job.tenantId, requestId, job.id, workerId);
      if (request.completed) return;
      // The request was admitted for one execution profile. A worker running another (a different engine, model manifest, knowledge set or
      // recordings) must not answer it: the result would not be the one the request pinned.
      if (!sameProfile(request.executionProfile, this.profile)) throw fatal('execution-profile-mismatch');
      // `roles` is not read on this path: EvaluationsService.create uses only the tenant and the person. Nothing here asks again whether that person is
      // still a member allowed to evaluate (the route checked when the request was queued); that check at run time is part of the worker-capability spec.
      const principal: Principal = { tenantId: job.tenantId, sub: request.requestedBy, roles: ['clinician'] };
      await this.evaluations.create(
        principal,
        request.reportId,
        { captureId: request.captureId, acceptanceId: request.acceptanceId },
        { signal, completion: { requestId, jobId: job.id, workerId } },
      );
    } catch (error) {
      throw jobError(error, signal);
    }
  }
}

/** The registration the job runner takes. */
export function evaluationRequestJob(consumer: EvaluationRequestConsumer): RegisteredJob {
  return { definition: evaluationRequest, handler: (context) => consumer.handle(context) };
}

function sameProfile(pinned: EvaluationExecutionProfile, running: EvaluationExecutionProfile): boolean {
  return (Object.keys(running) as (keyof EvaluationExecutionProfile)[]).every((key) => pinned[key] === running[key]) && Object.keys(pinned).length === Object.keys(running).length;
}

/** A short code and whether trying again can help. Never a message: a job's error is a code (packages/jobs/src/errors.ts). */
function jobError(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof Error && error.name === 'JobError') return error;
  if (signal.aborted) return retryable('handler-aborted');
  const code = (error as { code?: unknown } | null)?.code;
  if (code === NOT_HELD) return retryable('lease-lost');
  if (code === '42501') return fatal('requester-not-authorized');
  if (code === 'ER001') return fatal('evaluation-basis-changed');
  if (error instanceof LedgerBusyError) return retryable('ledger-busy');
  if (error instanceof LedgerCompromisedError) return retryable('ledger-stopped');
  if (error instanceof AppException) {
    const status = error.getStatus();
    if (status === HttpStatus.FORBIDDEN) return fatal('requester-not-authorized');
    if (status >= 500 && status !== HttpStatus.INTERNAL_SERVER_ERROR) return retryable('evaluation-unavailable');
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) return fatal('pipeline-misconfigured');
    // A refusal about the request itself (a newer decision, an unverified patient link, changed text): repeating it cannot help.
    const reason = error.details?.[0]?.reason;
    return fatal(typeof reason === 'string' && ERROR_CODE.test(reason) ? reason : 'evaluation-refused');
  }
  return error;
}
