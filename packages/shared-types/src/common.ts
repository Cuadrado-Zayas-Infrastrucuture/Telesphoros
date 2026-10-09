import { z } from 'zod';
import { roleSchema } from './roles';

/** `:id` route parameter. */
export const idParamSchema = z.strictObject({ id: z.uuid() });
export type IdParam = z.infer<typeof idParamSchema>;

export const healthDtoSchema = z.strictObject({ status: z.literal('ok') });
export type HealthDto = z.infer<typeof healthDtoSchema>;

export const readinessDtoSchema = z.strictObject({
  status: z.literal('ready'),
  /** `verifying`: the dependency is usable and a longer check of it is still running (the instance IS ready). `contained`: usable, but at least one tenant's record log is stopped (the others are not; the instance IS ready). */
  checks: z.record(z.string(), z.enum(['up', 'verifying', 'contained'])),
});
export type ReadinessDto = z.infer<typeof readinessDtoSchema>;

/** `GET /me`: what the signed-in caller may do. Roles only: no identifiers, no email. */
export const meDtoSchema = z.strictObject({ roles: z.array(roleSchema) });
export type MeDto = z.infer<typeof meDtoSchema>;
