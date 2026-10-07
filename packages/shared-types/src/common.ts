import { z } from 'zod';

/** `:id` route parameter. */
export const idParamSchema = z.strictObject({ id: z.uuid() });
export type IdParam = z.infer<typeof idParamSchema>;

export const healthDtoSchema = z.strictObject({ status: z.literal('ok') });
export type HealthDto = z.infer<typeof healthDtoSchema>;

export const readinessDtoSchema = z.strictObject({
  status: z.literal('ready'),
  checks: z.record(z.string(), z.enum(['up'])),
});
export type ReadinessDto = z.infer<typeof readinessDtoSchema>;
