import { Injectable, Optional } from '@nestjs/common';
import { RENDER_REFUSAL_REASONS, type ResultRenderBatch, type ResultRenderBatchResult } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { Database } from '../db/database';
import { PostgresResultRendersRepository } from '../storage/postgres/result-renders';
import { ResultRenderExposureMissingError, ResultRenderNotFoundError, ResultRenderNotReaderError } from '../storage/result-renders';

/**
 * Render capture (spec 019 D02b). Postgres only, like the results it names: without a database the route answers "misconfigured". Not a ledger record
 * (plan P3): the rows are append-only evidence of display, and nothing clinical depends on them (a missing render means unknown).
 */
@Injectable()
export class ResultRendersService {
  private readonly repository?: PostgresResultRendersRepository;

  constructor(@Optional() database?: Database) {
    this.repository = database ? new PostgresResultRendersRepository(database) : undefined;
  }

  async record(principal: Principal, batch: ResultRenderBatch): Promise<ResultRenderBatchResult> {
    if (!this.repository) throw AppException.pipelineMisconfigured();
    try {
      return await this.repository.record(principal.tenantId, principal.sub, batch);
    } catch (error) {
      throw toAppError(error);
    }
  }
}

function toAppError(error: unknown): unknown {
  if (error instanceof ResultRenderNotFoundError) return AppException.notFound('Result not found.');
  if (error instanceof ResultRenderExposureMissingError) {
    return AppException.conflictBecause(RENDER_REFUSAL_REASONS.exposureMissing, 'A duration was sent for an episode whose exposure is not stored.');
  }
  if (error instanceof ResultRenderNotReaderError) return AppException.forbidden();
  return error;
}
