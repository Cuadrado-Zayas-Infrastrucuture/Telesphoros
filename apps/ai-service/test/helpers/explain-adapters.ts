import { CASES } from '../../evals/golden/cases';
import { RESULTS, type ResultKey } from '../../evals/golden/results';
import { SyntheticBudgets } from '../../src/budgets';
import { canTransition } from '../../src/kernel';
import { syntheticProfile } from '../../src/policy';
import { EXPLAIN_CAPABILITY, type ExplainBudgets, type ExplainContext, type ExplainPorts, type ExplainRequest, type ExplainStore } from '../../src/explain-contracts';
import type { Authority, Observation, Run, State } from '../../src/contracts';
import type { ModelPort, ModelReply, ModelRequest } from '../../src/model-clients/port';
import { scripted } from '../../src/model-clients/scripted';
import { repairTemplateDigest, templateDigest } from '../../src/prompts/explain-v1';
import { verifyTemplateDigest } from '../../src/prompts/verify-v1';

export class MemoryExplainStore implements ExplainStore {
  runs = new Map<string, Run>();
  keys = new Map<string, { tuple: string; id: string }>();
  next = 0;
  async admit(key: string, tuple: string, context: ExplainContext, harnessVersion: string, utc: number, mono: number) {
    const prior = this.keys.get(key);
    if (prior) return { kind: prior.tuple === tuple ? ('existing' as const) : ('conflict' as const), run: this.row(prior.id) };
    const run: Run = {
      id: `${context.tenantId}-x${++this.next}`,
      tenantId: context.tenantId,
      requesterRef: context.requesterRef,
      profileDigest: harnessVersion,
      state: 'admitted',
      sequence: 0,
      fence: 1,
      admittedAt: utc,
      monoAt: mono,
      deadlineAt: utc + 120000,
    };
    this.runs.set(run.id, run);
    this.keys.set(key, { tuple, id: run.id });
    return { kind: 'new' as const, run: { ...run } };
  }
  /** The synchronous read the other methods of the double use. */
  row(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new Error('NO_RUN');
    return { ...r };
  }
  async get(id: string): Promise<Run> {
    return this.row(id);
  }
  async advance(expected: Run, state: State): Promise<Run | null> {
    const r = this.row(expected.id);
    if (r.state !== expected.state || r.sequence !== expected.sequence || r.fence !== expected.fence || !canTransition(expected.state, state)) return null;
    const next = { ...expected, state, sequence: expected.sequence + 1 };
    this.runs.set(next.id, next);
    return { ...next };
  }
  cancel(id: string) {
    const r = this.row(id);
    this.runs.set(id, { ...r, state: 'cancelled', fence: r.fence + 1, sequence: r.sequence + 1 });
  }
}

/** The real in-memory budget class behind the explanation run's interface, so the cap tests exercise the real counting rules. */
export class MemoryExplainBudgets implements ExplainBudgets {
  inner = new SyntheticBudgets();
  async reserve(run: Run) {
    return this.inner.reserve(run, syntheticProfile());
  }
  async begin(runId: string, attemptId: string) {
    return this.inner.begin(runId, attemptId);
  }
  async observe(runId: string, role: 'draft' | 'verify', attemptId: string, observation: Observation | null) {
    return this.inner.observe(runId, role === 'draft' ? 'draft' : 'director', attemptId, observation);
  }
  async complete(runId: string) {
    this.inner.complete(runId);
  }
  async counters(runId: string) {
    const c = this.inner.counters(runId);
    return { slots: c.logicalSlots, tokens: c.projectedTokens };
  }
}

export const GOOD = CASES.find((c) => c.id === 'g01-avoid-quote-restate-gloss')!.candidate as { statements: unknown[] };
export const BAD_GLOSS = { statements: [{ kind: 'gloss', fields: ['implication'], text: 'Refer the patient to a specialist. MODELWORD' }] };
export const accept = (n: number) => ({ decision: 'accept', statements: Array.from({ length: n }, (_, index) => ({ index, supported: true })) });
export type Role = 'draft' | 'repair' | 'verify';
export const roleOf = (r: ModelRequest): Role =>
  r.templateDigest === verifyTemplateDigest() ? 'verify' : r.templateDigest === repairTemplateDigest() ? 'repair' : r.templateDigest === templateDigest() ? 'draft' : 'draft';

/** A model port from a bare `complete`, with the offline stand-in's identity. */
export const modelOf = (complete: (request: ModelRequest) => Promise<ModelReply>): ModelPort => ({ identity: scripted(() => 0).identity, complete });
export const TEST_KEY = new Uint8Array(32).fill(7);

export interface ScenarioOptions {
  replies?: Partial<Record<Role, unknown | (() => unknown)>>;
  model?: ModelPort;
  baaCovered?: boolean;
  syntheticOnly?: boolean;
  resultKey?: ResultKey;
}
export function explainScenario(options: ScenarioOptions = {}) {
  const store = new MemoryExplainStore(),
    budgets = new MemoryExplainBudgets();
  const calls = { draft: 0, repair: 0, verify: 0, model: 0 };
  const trace: string[] = [];
  const hooks: Record<string, () => void> = {};
  const replies = { draft: GOOD, repair: GOOD, verify: accept(GOOD.statements.length), ...options.replies };
  let utc = Date.UTC(2026, 9, 31, 23, 59, 0),
    mono = 0;
  const authority: Authority = {
    tenantId: 'tenant-a',
    requesterRef: 'staff-a',
    generation: 1,
    member: true,
    session: true,
    expiresAt: utc + 3600000,
    purpose: 'pharmacogenomic-explanation',
    capabilities: [EXPLAIN_CAPABILITY],
    sourceIds: [],
  };
  const model: ModelPort =
    options.model ??
    scripted((req) => {
      const role = roleOf(req);
      calls[role]++;
      calls.model++;
      const r = replies[role];
      return typeof r === 'function' ? (r as () => unknown)() : r;
    });
  const ports: ExplainPorts = {
    authority: { current: () => structuredClone(authority) },
    model,
    provider: { baaCovered: options.baaCovered ?? false, syntheticOnly: options.syntheticOnly ?? true },
    store,
    budgets,
    clock: { utcNowMs: () => utc, monotonicNowMs: () => mono },
    boundary: (name) => {
      trace.push(name);
      hooks[name]?.();
    },
    harnessVersion: 'sha256:' + 'b'.repeat(64),
    digestKey: TEST_KEY,
  };
  const context: ExplainContext = { tenantId: 'tenant-a', requesterRef: 'staff-a', authorityGeneration: 1, purpose: 'pharmacogenomic-explanation' };
  const request: ExplainRequest = {
    idempotencyKey: 'key-1',
    dataMarker: 'synthetic',
    engine: { outcome: 'shown', reasonCode: null, strength: 'Strong', explainable: RESULTS[options.resultKey ?? 'avoid'] },
  };
  return {
    store,
    budgets,
    calls,
    trace,
    hooks,
    authority,
    ports,
    context,
    request,
    tick: (ms: number) => {
      utc += ms;
      mono += ms;
    },
    revoke: () => {
      authority.generation++;
      authority.capabilities = [];
    },
  };
}
