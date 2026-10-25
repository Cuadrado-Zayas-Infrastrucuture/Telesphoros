import { z } from 'zod';
import type { Authority, Observation, Run, State } from './contracts';
import type { ExplainableResult, Explanation } from './evaluators/types';
import type { ModelPort } from './model-clients/port';

export const EXPLAIN_TASK = 'pgx.explain.v1';
/** The kernel's loop limits (kernel.ts, budgets.ts), restated for the explanation run. A test pins them to the synthetic profile's budget. */
export const EXPLAIN_LIMITS = { draftAttempts: 2, repairs: 1, slots: 4, deadlineMs: 120000, tokens: 28160 } as const;

/** Every way a run can end without releasing a model-written explanation. Each has a test (T014); the clinician then sees the engine text alone. */
export const FAILURE_REASONS = [
  'INVALID_INPUT',
  'TASK_UNDECLARED',
  'NOT_SYNTHETIC',
  'NO_BAA',
  'AUTHORITY_HELD',
  'IDEMPOTENCY_CONFLICT',
  'IN_PROGRESS',
  'IDEMPOTENT_REPLAY',
  'BUDGET_HELD',
  'NOT_ELIGIBLE',
  'INPUT_REFUSED',
  'USAGE_HELD',
  'MODEL_ERROR',
  'MODEL_REFUSED',
  'INVALID_STRUCTURE',
  'SENSOR_HOLD',
  'VERIFIER_HOLD',
  'DEADLINE',
  'CONTROL_HELD',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** What the caller hands over: the engine's outcome for one drug, and whether the data is synthetic. Nothing from an inbound document. */
export const explainRequestSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:/_-]{1,96}$/),
  dataMarker: z.enum(['synthetic', 'real']),
  engine: z.strictObject({ outcome: z.string().max(64), reasonCode: z.string().max(64).nullable(), strength: z.string().max(32).nullable(), explainable: z.unknown() }),
});
export type ExplainRequest = z.infer<typeof explainRequestSchema>;

export const explainContextSchema = z.strictObject({
  tenantId: z.string().min(1).max(128),
  requesterRef: z.string().min(1).max(128),
  authorityGeneration: z.number().int().positive(),
  purpose: z.literal('pharmacogenomic-explanation'),
});
export type ExplainContext = z.infer<typeof explainContextSchema>;
export const EXPLAIN_CAPABILITY = 'pgx.explain';

export interface ExplainStore {
  admit(key: string, tuple: string, context: ExplainContext, harnessVersion: string, utc: number, mono: number): { kind: 'new' | 'existing' | 'conflict'; run: Run };
  get(id: string): Run;
  advance(expected: Run, state: State): Run | null;
}
export interface ExplainBudgets {
  reserve(run: Run): boolean;
  begin(runId: string, attemptId: string): boolean;
  observe(runId: string, role: 'draft' | 'verify', attemptId: string, observation: Observation | null): boolean;
  complete(runId: string): void;
  counters(runId: string): { slots: number; tokens: number };
}
export interface ExplainPorts {
  authority: { current(context: ExplainContext): Authority };
  model: ModelPort;
  /** The route the model port reaches: whether a signed business associate agreement covers it, and whether the system holds synthetic data only. */
  provider: { baaCovered: boolean; syntheticOnly: boolean };
  store: ExplainStore;
  budgets: ExplainBudgets;
  clock: { utcNowMs(): number; monotonicNowMs(): number };
  boundary(name: string): void;
  harnessVersion: string;
}

export const EXPLANATION_LABEL = 'AI-generated explanation of the guideline text above. Check it against the guideline.';
export interface OutcomeBase {
  runId: string | null;
  engineText: string;
  guardsRun: string[];
  counters: { slots: number; tokens: number; modelCalls: number };
}
export type ExplainOutcome = OutcomeBase &
  ({ released: true; reasonCode: 'RELEASED'; label: typeof EXPLANATION_LABEL; explanation: Explanation } | { released: false; reasonCode: FailureReason; detail: string | null });

/** The engine's own text for a `shown` result: citation, locator and wording, always shown first (FR-006). */
export const engineTextOf = (r: ExplainableResult): string =>
  `Guideline ${r.guidelineId} version ${r.guidelineVersion}, ${[r.locator.table, r.locator.row, r.locator.column].filter((x) => x !== null).join(', ')}. Strength: ${r.strength}. ${r.recommendationText}${r.implication === null ? '' : ` ${r.implication}`}`;
