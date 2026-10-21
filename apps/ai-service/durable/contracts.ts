import { z } from 'zod';
import { candidateSchema, contextSchema, outcomeSchema, requestSchema, sourceSchema, verdictSchema, type Outcome, type RequestInput, type Source, type State } from '../src/contracts';

export const DURABLE_SCHEMA = 'synthetic.durable.v1' as const;
export const SYNTHETIC_JOB_TYPE = 'test.agentic-synthetic' as const;

const noNul = (value: string): boolean => !value.includes('\u0000') && value.isWellFormed();
const cleanPersisted = (value: unknown): boolean => typeof value === 'string' ? noNul(value) :
  Array.isArray(value) ? value.every(cleanPersisted) :
    value !== null && typeof value === 'object' ? Object.values(value).every(cleanPersisted) : true;
const bounded = (max: number) => z.string().min(1).max(max).refine(noNul);
const uuid = z.uuid();
const positiveDecimal = z.string().regex(/^[1-9][0-9]*$/);
const unsignedDecimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const state = z.enum(['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending', 'released', 'held', 'failed', 'cancelled', 'expired']);

export const refusalCodeSchema = z.enum([
  'INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'NOT_AUTHORIZED', 'SOURCE_UNAVAILABLE', 'CAPACITY_REFUSED',
  'BUDGET_REFUSED', 'DEADLINE_EXPIRED', 'STALE_CLAIM', 'STALE_SEQUENCE', 'INVALID_TRANSITION',
  'USAGE_UNKNOWN', 'INVALID_EVIDENCE', 'ABORTED', 'STORAGE_UNAVAILABLE',
]);
export type RefusalCode = z.infer<typeof refusalCodeSchema>;
export type Decision<T> = Readonly<{ kind: 'ok'; value: T } | { kind: 'refused'; code: RefusalCode }>;

export const stampSchema = z.strictObject({
  jobId: uuid, runId: uuid, workerId: bounded(128), queueAttempt: z.number().int().positive().safe(),
  claimId: uuid, fence: positiveDecimal,
});
export type Stamp = Readonly<z.infer<typeof stampSchema>>;

export const expectedSchema = z.strictObject({ sequence: unsignedDecimal, state });
export type Expected = Readonly<z.infer<typeof expectedSchema>>;

export const fixtureCallerSchema = z.strictObject({
  tenantId: bounded(128), requesterRef: bounded(128), membershipVersion: positiveDecimal,
  grantId: uuid, grantGeneration: positiveDecimal,
});
export type FixtureCaller = Readonly<z.infer<typeof fixtureCallerSchema>>;

export const admissionSchema = z.strictObject({ schemaVersion: z.literal(DURABLE_SCHEMA), kind: z.enum(['new', 'existing']),
  runId: uuid, jobId: uuid, state, sequence: unsignedDecimal, deadlineAt: z.iso.datetime({ offset: true }),
});
export type Admission = Readonly<z.infer<typeof admissionSchema>>;

export const runViewSchema = z.strictObject({ schemaVersion: z.literal(DURABLE_SCHEMA), runId: uuid,
  state, sequence: unsignedDecimal, deadlineAt: z.iso.datetime({ offset: true }),
  selectedAttempt: z.union([z.literal(1), z.literal(2)]).nullable(),
  outcomeCommitted: z.boolean(), dispatchUnknown: z.boolean(),
});
export type RunView = Readonly<z.infer<typeof runViewSchema>>;

export const invocationSchema = z.strictObject({ invocationId: uuid, role: z.enum(['draft', 'director']),
  ordinal: z.union([z.literal(1), z.literal(2)]), inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type Invocation = Readonly<z.infer<typeof invocationSchema>>;

export const observationSchema = z.strictObject({ inputUnits: z.number().int().nonnegative().safe(),
  generatedUnits: z.number().int().nonnegative().safe(),
});
export const scriptedObservationSchema = z.strictObject({
  invocationId: uuid, role: z.enum(['draft', 'director']), inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  observation: observationSchema.nullable(), artifact: z.union([candidateSchema, verdictSchema]).nullable(),
}).refine(cleanPersisted).refine(r => r.observation !== null || r.artifact === null)
  .refine(r => r.artifact === null || (r.role === 'draft' ? candidateSchema.safeParse(r.artifact).success : verdictSchema.safeParse(r.artifact).success))
  .refine(r => r.observation === null || (r.role === 'draft' ?
    r.observation.inputUnits <= 4096 && r.observation.generatedUnits <= 768 :
    r.observation.inputUnits <= 8192 && r.observation.generatedUnits <= 1024));
export type ScriptedObservation = Readonly<z.infer<typeof scriptedObservationSchema>>;

export const terminalProposalSchema = z.strictObject({ terminalState: z.enum(['released', 'held', 'failed', 'cancelled', 'expired']),
  reasonCode: bounded(128), candidate: candidateSchema.optional(), verdict: verdictSchema.optional(),
  evidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
}).refine(cleanPersisted).refine(p => p.terminalState === 'released' ?
  p.reasonCode === 'SIMULATED_RELEASE' && p.candidate !== undefined && p.verdict?.decision === 'accept' && p.evidenceDigest !== undefined :
  p.candidate === undefined && p.verdict === undefined && p.evidenceDigest === undefined);
export type TerminalProposal = Readonly<z.infer<typeof terminalProposalSchema>>;

export const durableRequestSchema = requestSchema.refine(cleanPersisted);
export const durableSourceSchema = sourceSchema.refine(cleanPersisted);
export const durableContextSchema = contextSchema.refine(cleanPersisted);

export interface DurableSyntheticStore {
  admit(input: RequestInput, caller: FixtureCaller): Promise<Decision<Admission>>;
  load(stamp: Stamp, expected: Expected): Promise<Decision<RunView>>;
  sources(stamp: Stamp, expected: Expected): Promise<Decision<readonly Source[]>>;
  advance(stamp: Stamp, expected: Expected, next: State): Promise<Decision<RunView>>;
  begin(stamp: Stamp, expected: Expected, invocation: Invocation): Promise<Decision<RunView>>;
  observe(stamp: Stamp, expected: Expected, receipt: ScriptedObservation): Promise<Decision<RunView>>;
  finish(stamp: Stamp, expected: Expected, proposal: TerminalProposal): Promise<Decision<Outcome>>;
  read(runId: string, caller: FixtureCaller): Promise<Decision<Outcome | null>>;
  cancel(runId: string, caller: FixtureCaller): Promise<Decision<Outcome>>;
}

export const decisionSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), value }),
  z.strictObject({ kind: z.literal('refused'), code: refusalCodeSchema }),
]);

export const outcomeDecisionSchema = decisionSchema(outcomeSchema);
