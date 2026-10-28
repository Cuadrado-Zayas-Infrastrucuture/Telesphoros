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

export interface EvaluationRequestDto {
  id: string;
  reportId: string;
  captureId: string;
  acceptanceId: string;
  jobId: string;
  requestedBy: string;
  createdAt: string;
  /** `cancelled`: withdrawn before a worker started it, by its requester (H4) or an operator (the jobs CLI). */
  state: 'queued' | 'running' | 'retry' | 'dead' | 'completed' | 'completion-missing' | 'cancelled';
  evaluationId: string | null;
}
