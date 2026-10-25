import { z } from 'zod';

export const TRACE_STEPS = ['admission', 'draft', 'sensors', 'verify', 'release', 'end'] as const;
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,63}$/);

/** One step of a run: its name, the run state, a fixed reason code if it held, how long it took, and the usage so far. No text (FR-009). */
export const traceStepSchema = z.strictObject({
  step: z.enum(TRACE_STEPS),
  state: z.enum(['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending', 'released', 'held', 'failed', 'cancelled', 'expired']),
  reasonCode: code.nullable(),
  durationMs: z.number().int().nonnegative().safe(),
  inputUnits: z.number().int().nonnegative().safe(),
  generatedUnits: z.number().int().nonnegative().safe(),
});
export type TraceStep = z.infer<typeof traceStepSchema>;
export const traceSchema = z.array(traceStepSchema).max(32);
