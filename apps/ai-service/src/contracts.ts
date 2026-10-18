import { z } from 'zod';

export const wellFormed = (s: string): boolean => s.isWellFormed();
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
const text = z.string().refine(wellFormed);
const id = text.min(1).max(128);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const requestSchema = z.strictObject({
  schemaVersion: z.literal('agentic.request.v1'), taskKey: id, locale: z.enum(['en', 'es']),
  question: text.refine(s => Array.from(s).length <= 512 && utf8Length(s) <= 2048),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:/_-]{1,96}$/),
});
export const parseRequest = (input: unknown) => requestSchema.parse(input);
export type RequestInput = z.infer<typeof requestSchema>;
export const profileSchema = z.strictObject({
  version: z.literal('synthetic.profile.v1'), evidenceKind: z.literal('synthetic-control-flow'),
  taskKey: z.literal('business.sop-draft.v1'), locales: z.tuple([z.literal('en'), z.literal('es')]),
  roles: z.tuple([z.literal('retrieval'), z.literal('draft'), z.literal('verification')]),
  directorRequired: z.literal(true), maxDepth: z.literal(1), maxRepair: z.literal(1),
  activation: z.literal('disabled'), profileDigest: digestSchema,
  budget: z.strictObject({ elapsedMs: z.literal(120000), slots: z.literal(4), tokens: z.literal(28160), costUnits: z.literal(250000), tenantActive: z.literal(1), fleetActive: z.literal(2) }),
});
export type Profile = z.infer<typeof profileSchema>;
export const contextSchema = z.strictObject({ tenantId: id, requesterRef: id, authorityGeneration: z.number().int().positive(),
  purpose: z.literal('business-assistance'), sources: z.array(z.strictObject({ id, version: id, digest: digestSchema })).min(1).max(4) });
export type Context = z.infer<typeof contextSchema>;
export interface Authority { tenantId: string; requesterRef: string; generation: number; member: boolean; session: boolean; expiresAt: number; purpose: string; capabilities: string[]; sourceIds: string[] }
export const sourceSchema = z.strictObject({ id, tenantId: id, version: id, digest: digestSchema, body: text.refine(s => utf8Length(s) <= 16384) });
export type Source = z.infer<typeof sourceSchema>;
export const candidateSchema = z.strictObject({ text, digest: digestSchema, claims: z.array(z.strictObject({ id, text, sourceId: id, startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() })).min(1).max(8) });
export type Candidate = z.infer<typeof candidateSchema>;
export const verdictSchema = z.strictObject({ decision: z.enum(['accept', 'repair', 'hold']), candidateDigest: digestSchema, evidenceDigest: digestSchema,
  claimVerdicts: z.array(z.strictObject({ claimId: id, supported: z.boolean() })).max(8) });
export type Verdict = z.infer<typeof verdictSchema>;
export interface Observation { inputUnits: number; generatedUnits: number }
export interface ScriptedReply { artifact: unknown; observation: Observation | null }
export type State = 'admitted' | 'queued' | 'running' | 'reviewing' | 'repair-pending' | 'release-pending' | 'released' | 'held' | 'failed' | 'cancelled' | 'expired';
export interface Run { id: string; tenantId: string; requesterRef: string; state: State; sequence: number; fence: number; admittedAt: number; monoAt: number; deadlineAt: number; profileDigest: string }
export interface Counters { logicalSlots: number; projectedTokens: number; actualModelCalls: 0; actualModelTokens: 0; actualInferenceCharges: 0; usageState: 'known' | 'unknown' }
export type TerminalState = 'released' | 'held' | 'failed' | 'cancelled' | 'expired';
export const outcomeSchema = z.strictObject({ schemaVersion: z.literal('synthetic.business-outcome.v1'), evidenceKind: z.literal('synthetic-control-flow'),
  runId: text.min(1).max(256), tenantId: id.nullable(), requesterRef: id.nullable(), terminalState: z.enum(['released','held','failed','cancelled','expired']), fixtureProfileDigest: digestSchema,
  simulatedArtifact: z.strictObject({ text, digest: digestSchema }).nullable(), simulationReceiptRef: text.regex(/^simulation:/).nullable(), reasonCode: id,
  counters: z.strictObject({ logicalSlots: z.number().int().nonnegative().max(4), projectedTokens: z.number().int().nonnegative(), actualModelCalls: z.literal(0),actualModelTokens:z.literal(0),actualInferenceCharges:z.literal(0),usageState:z.enum(['known','unknown']) }),
}).refine(o => o.terminalState === 'released' ? o.simulatedArtifact !== null && o.simulationReceiptRef !== null && o.tenantId !== null && o.requesterRef !== null && o.reasonCode === 'SIMULATED_RELEASE' : o.simulatedArtifact === null && o.simulationReceiptRef === null);
export type Outcome = z.infer<typeof outcomeSchema>;
export interface BudgetPort {
  reserve(run: Run, profile: Profile): boolean;
  begin(runId: string, attemptId: string): boolean;
  observe(runId: string, role: 'draft' | 'director', attemptId: string, observation: Observation | null): boolean;
  complete(runId: string): void;
  counters(runId: string): Counters;
}
export interface StorePort {
  admit(key: string, tuple: string, context: Context, profileDigest: string, utc: number, mono: number): { kind: 'new' | 'existing' | 'conflict'; run: Run };
  get(id: string): Run;
  advance(expected: Run, state: State): Run | null;
  outcome(id: string): Outcome | null;
  commitSimulation(expected: Run, outcome: Outcome, guard: () => boolean, settle: () => void): boolean;
}
export interface Ports {
  authority: { current(context: Context): Authority };
  sources: { resolve(context: Context): unknown[] };
  actors: { draft(sources: readonly Source[], attemptId: string): Promise<ScriptedReply>; director(candidate: Candidate, evidenceDigest: string, attemptId: string): Promise<ScriptedReply> };
  store: StorePort; budgets: BudgetPort;
  clock: { utcNowMs(): number; monotonicNowMs(): number };
  boundary(name: string): void;
}
export const emptyCounters = (): Counters => ({ logicalSlots: 0, projectedTokens: 0, actualModelCalls: 0, actualModelTokens: 0, actualInferenceCharges: 0, usageState: 'known' });
