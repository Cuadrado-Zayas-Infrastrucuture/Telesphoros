import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
/** Trusted server profile. The manifest pins execution/backend/model settings; no provider is selected by a caller or queue payload. */
export const evaluationExecutionProfileSchema = z.strictObject({
  version: z.literal('evaluation-execution-profile/1'),
  codeArtifactSha256: digest,
  executionManifestSha256: digest,
  knowledgeSetId: digest,
  recordingsSha256: digest,
});
export type EvaluationExecutionProfile = z.infer<typeof evaluationExecutionProfileSchema>;

export const evaluationRequestCreateSchema = z.strictObject({
  reportId: z.string().uuid(),
  captureId: z.string().uuid(),
  acceptanceId: z.string().uuid(),
  /** A caller-scoped retry identity; separate from the durable request's id. */
  requestId: z.string().uuid(),
});
export type EvaluationRequestCreate = z.infer<typeof evaluationRequestCreateSchema>;

/** `POST /reports/:id/evaluation-requests` (H4): the report comes from the path; no profile, provider or model is accepted from a caller. */
export const evaluationRequestBodySchema = evaluationRequestCreateSchema.omit({ reportId: true });
export type EvaluationRequestBody = z.infer<typeof evaluationRequestBodySchema>;

/**
 * Operational states of a queued request. Only `completed` names an evaluation; none of them is a clinical result or a hold. `cancelled`: withdrawn before
 * a worker started it, by its requester (H4) or an operator (the jobs CLI).
 */
export const evaluationRequestStates = ['queued', 'running', 'retry', 'dead', 'completed', 'completion-missing', 'cancelled'] as const;

export const evaluationRequestDtoSchema = z.strictObject({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  captureId: z.string().uuid(),
  acceptanceId: z.string().uuid(),
  jobId: z.string().uuid(),
  requestedBy: z.string().min(1),
  createdAt: z.string().min(1),
  state: z.enum(evaluationRequestStates),
  evaluationId: z.string().uuid().nullable(),
});
export type EvaluationRequestDto = z.infer<typeof evaluationRequestDtoSchema>;
