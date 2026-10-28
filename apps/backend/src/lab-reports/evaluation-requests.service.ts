import { z } from 'zod';
import { evaluationExecutionProfileSchema, evaluationRequestCreateSchema } from '@telesphoros/shared-types';
import type { EvaluationExecutionProfile, EvaluationRequestCreate, EvaluationRequestDto } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import type { EvaluationRequestsRepository } from '../storage/postgres/evaluation-requests.repository';

/** Internal/inactive foundation: deliberately absent from Nest modules, controllers and production consumers. */
export class EvaluationRequestsService {
  private readonly profile: Readonly<EvaluationExecutionProfile>;
  constructor(
    private readonly repository: EvaluationRequestsRepository,
    profile: EvaluationExecutionProfile,
  ) {
    this.profile = Object.freeze(evaluationExecutionProfileSchema.parse(profile));
  }

  admit(principal: Principal, input: EvaluationRequestCreate): Promise<{ request: EvaluationRequestDto; created: boolean }> {
    return this.repository.admit(principal, evaluationRequestCreateSchema.parse(input), this.profile);
  }

  /** H4: the requester withdraws a request no worker has started (409 once one has, 403 for anyone else). */
  cancel(principal: Principal, id: string): Promise<EvaluationRequestDto> {
    return this.repository.cancel(principal, z.string().uuid().parse(id));
  }

  async get(principal: Principal, id: string): Promise<EvaluationRequestDto> {
    const request = await this.repository.get(principal, z.string().uuid().parse(id));
    if (!request) throw AppException.notFound('Evaluation request not found.');
    return request;
  }
}
