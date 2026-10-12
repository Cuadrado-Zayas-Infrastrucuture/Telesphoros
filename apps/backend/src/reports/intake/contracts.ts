import { z } from 'zod';
import { reportUploadUrlRequestSchema } from '@telesphoros/shared-types';
export const attemptDeclarationSchema = reportUploadUrlRequestSchema.extend({ requestId: z.uuid(), revision: z.uuid() }).strict();
export type AttemptDeclaration = z.infer<typeof attemptDeclarationSchema>;
export const attemptParamsSchema = z.strictObject({ id: z.uuid(), attemptId: z.uuid() });
export type AttemptParams = z.infer<typeof attemptParamsSchema>;
export const revisionHeaderSchema = z.uuid();
