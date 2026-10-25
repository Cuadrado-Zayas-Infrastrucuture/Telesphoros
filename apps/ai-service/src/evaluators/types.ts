import { z } from 'zod';

/**
 * The only facts about an engine result that may reach a model (FR-001): gene and canonical phenotype, drug, strength,
 * guideline id and version, locator, the guideline's wording and its implication. Nothing else exists in this type, so
 * nothing else can be put in a prompt. The shapes are strict on purpose: a phenotype that is a sentence is refused here,
 * before any model sees it. `strength` excludes "No recommendation": that result never reaches a model (FR-002).
 */
export const explainableResultSchema = z.strictObject({
  drug: z.string().regex(/^[a-z]([a-z0-9 -]{0,58}[a-z0-9])?$/),
  strength: z.enum(['Strong', 'Moderate', 'Optional']),
  genes: z
    .array(
      z.strictObject({
        gene: z.string().regex(/^[A-Z][A-Za-z0-9-]{0,19}$/),
        phenotype: z
          .string()
          .max(60)
          .regex(/^[A-Za-z0-9][A-Za-z0-9 ()/+.-]*$/)
          .refine((s) => s.split(' ').length <= 6),
      }),
    )
    .min(1)
    .max(4),
  guidelineId: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,80}$/),
  guidelineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/),
  locator: z.strictObject({ table: z.string().max(80), row: z.string().max(80), column: z.string().max(80).nullable() }),
  recommendationText: z.string().min(1).max(2000),
  implication: z.string().max(2000).nullable(),
});
export type ExplainableResult = z.infer<typeof explainableResultSchema>;

export const FIELDS = ['gene', 'phenotype', 'drug', 'strength', 'recommendationText', 'implication'] as const;
export type Field = (typeof FIELDS)[number];

/** What a model returns (FR-003). Structure only; whether the words are acceptable is for the sensors. */
export const statementSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('quote'),
    field: z.enum(['recommendationText', 'implication']),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
    text: z.string().min(1).max(2000),
  }),
  z.strictObject({ kind: z.literal('restate'), fields: z.array(z.enum(FIELDS)).min(1).max(6), text: z.string().min(1).max(2000) }),
  z.strictObject({ kind: z.literal('gloss'), fields: z.array(z.enum(FIELDS)).min(1).max(6), text: z.string().min(1).max(2000) }),
]);
export const explanationSchema = z.strictObject({ statements: z.array(statementSchema).min(1).max(8) });
export type Statement = z.infer<typeof statementSchema>;
export type Explanation = z.infer<typeof explanationSchema>;

export const SENSORS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
export type SensorId = (typeof SENSORS)[number];
/** A reason a run is held. `statement` is the index of the statement, or null when the whole explanation is at fault. */
export interface Hold {
  sensor: SensorId;
  reason: string;
  statement: number | null;
}
export type Sensor = (explanation: Explanation, result: ExplainableResult) => Hold[];
