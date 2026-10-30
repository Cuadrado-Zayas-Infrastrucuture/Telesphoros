import { HttpStatus } from '@nestjs/common';
import { ERROR_CODE, evaluationRequest, fatal, retryable, type HandlerContext, type RegisteredJob } from '@telesphoros/jobs';
import { evaluationExecutionProfileSchema, type EvaluationExecutionProfile } from '@telesphoros/shared-types';
import { runWithCapability, type RequestCapability } from '../auth/authority-context';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import type { Database } from '../db/database';
import { CapabilityIssueError } from '../issuer/capability-issuer.port';
import type { JobCapabilityClient } from '../issuer/job-capability-client';
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
 *
 * Given a job-capability client (spec 012 slice 3), every transaction of the job runs under a capability the issuer issued for it (plan D2), and the person
 * it acts for is the one the issuer names, not the one this worker read from the request. Without one, it runs as before (the guard keeps that worker away
 * from an API that uses an issuer: evaluation-worker-config.ts).
 */
export class EvaluationRequestConsumer {
  private readonly requests: EvaluationRequestsRepository;
  private readonly profile: Readonly<EvaluationExecutionProfile>;

  constructor(
    database: Database,
    private readonly evaluations: EvaluationsService,
    profile: EvaluationExecutionProfile,
    private readonly jobCapabilities?: JobCapabilityClient,
  ) {
    this.requests = new EvaluationRequestsRepository(database);
    this.profile = Object.freeze(evaluationExecutionProfileSchema.parse(profile));
  }

  async handle({ job, workerId, signal }: Pick<HandlerContext, 'job' | 'workerId' | 'signal'>): Promise<void> {
    const { requestId } = evaluationRequest.payload.parse(job.payload);
    try {
      if (!this.jobCapabilities) return await this.evaluate(job, requestId, workerId, signal);
      const client = this.jobCapabilities;
      // The person every capability of this job names. The first issuance fixes it; a later one naming anyone else, or another organization, ends the job.
      let actingFor: string | undefined;
      const source = async (): Promise<RequestCapability> => {
        const issued = await client.issue({ jobId: job.id, workerId });
        if (issued.tenantId !== job.tenantId || (actingFor !== undefined && issued.sub !== actingFor)) throw fatal('requester-not-authorized');
        actingFor = issued.sub;
        return { token: issued.token, expiresAt: issued.expiresAt, membershipVersion: issued.membershipVersion };
      };
      await runWithCapability(source, () => this.evaluate(job, requestId, workerId, signal, () => actingFor));
    } catch (error) {
      throw jobError(error, signal);
    }
  }

  /** `issuedFor` is set only under the issuer: the person the capabilities name, read once the first transaction has run. */
  private async evaluate(job: HandlerContext['job'], requestId: string, workerId: string, signal: AbortSignal, issuedFor?: () => string | undefined): Promise<void> {
    const request = await this.requests.forJob(job.tenantId, requestId, job.id, workerId);
    if (request.completed) return;
    // The request was admitted for one execution profile. A worker running another (a different engine, model manifest, knowledge set or
    // recordings) must not answer it: the result would not be the one the request pinned.
    if (!sameProfile(request.executionProfile, this.profile)) throw fatal('execution-profile-mismatch');
    // `roles` is not read on this path: EvaluationsService.create uses only the tenant and the person. The database asks again when the result is
    // stored (migration 0051: the requester must still be an active clinician or reviewer). Without an issuer that is the person this worker names; under
    // one it is the person the issuer proved, who must be the one who asked.
    const sub = issuedFor ? issuedFor() : request.requestedBy;
    if (sub === undefined || sub !== request.requestedBy) throw fatal('requester-not-authorized');
    const principal: Principal = { tenantId: job.tenantId, sub, roles: ['clinician'] };
    await this.evaluations.store(
      principal,
      request.reportId,
      { captureId: request.captureId, acceptanceId: request.acceptanceId },
      { signal, completion: { requestId, jobId: job.id, workerId } },
    );
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
  if (error instanceof CapabilityIssueError) return capabilityError(error);
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

/**
 * Why the issuer issued no capability (FR-005). Its refusals are about the job or the person and end the job; anything else says nothing about either
 * (an issuer that is down, a key that does not match while a deployment rolls) and is tried again. So is `rate-limited`: it says the person has been
 * issued many capabilities lately, not that they may not have this one, and once the limits are enforced (0028 `enforce_limits`) a requester with many
 * queued requests would otherwise lose them for good.
 */
function capabilityError(error: CapabilityIssueError): unknown {
  if (error.reason !== 'refused') return retryable(error.reason === 'unavailable' ? 'issuer-unavailable' : 'issuer-unauthenticated');
  if (error.detail === 'rate-limited') return retryable('issuer-rate-limited');
  if (error.detail === 'job-not-held') return fatal('job-not-held');
  if (error.detail === 'tenant-inactive') return fatal('tenant-inactive');
  return fatal('requester-not-authorized');
}
